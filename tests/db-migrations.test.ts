/**
 * test_db_migrations：台账存储层（迁移版本链 · 复合索引 · 事务边界 · 批量提交）。
 *
 * 覆盖：
 *   ① **迁移版本链** —— 空库开库即升到链尾版本；migrations 履历表逐版可查；
 *      已是最新则一个版本都不动（幂等重跑版本号不变）；
 *   ② **迁移失败回滚** —— 某一版迁移抛错时该版事务回滚、**版本号不前移**、
 *      履历表里不留失败那一版、台账行数不变；修好后重跑从失败那一版继续；
 *   ③ **复合索引与查询计划** —— 四个复合索引齐备，四类真实查询的
 *      EXPLAIN QUERY PLAN 全部命中索引（不是全表扫描）；
 *   ④ **事务边界** —— 台账行 + 审计行 + 回执行同事务提交；中途抛错三者一起回滚；
 *   ⑤ **WAL · busy_timeout · 批量切分** —— 日志模式与忙等超时可配；
 *      超过阈值的批量切成多批、每批一个事务，结论条数始终守恒。
 */

import { describe, it, after } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  openLedger,
  schemaVersion,
  splitIntoBatches,
  withTransaction,
  DEFAULT_BATCH_COMMIT_SIZE,
  LEDGER_SCHEMA_VERSION,
  type LedgerDb,
} from '../src/ledger/db.js';
import {
  applyMigrations,
  currentSchemaVersion,
  indexExists,
  migrationHistory,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  MigrationError,
  SchemaVersionError,
  type Migration,
} from '../src/ledger/migrations.js';
import { insertBinding, countBindings } from '../src/ledger/binding-repo.js';
import { appendAudit, countAuditRows } from '../src/ledger/audit.js';
import { recordReceipt, countReceipts, type ChargeReceipt } from '../src/charge/receipt.js';
import { deriveIdempotencyKey } from '../src/domain/idempotency.js';
import { settleEvent } from '../src/engine/settle.js';
import type { Logger } from '../src/log/logger.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

/** 造一条计费回执（字段与 charge_receipt 表逐字对齐） */
function makeReceipt(material_code: string, operation_no: string): ChargeReceipt {
  const now = new Date().toISOString();
  return {
    material_code,
    operation_no,
    idempotency_key: null,
    key_profile: 'v1',
    request_idempotency_key: null,
    peer_idempotency_status: 'NOT_ECHOED',
    attempt: 1,
    delivery_count: 1,
    accepted: true,
    kind: 'ACCEPTED',
    reason_code: null,
    error_code: null,
    channel_reachable: true,
    retryable: false,
    disposition: null,
    requested_at: now,
    responded_at: now,
    response_summary: '对端已接收',
  };
}

/** 静默日志器：批量用例里 450 条逐条日志不刷屏（结构化日志本身另有用例覆盖） */
const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
  level: 'info',
};

const workDirs: string[] = [];

after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

function tempLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'msb-migrate-'));
  workDirs.push(dir);
  return join(dir, 'ledger.db');
}

/** 一条必失败的迁移（用来证明「失败回滚且版本号不前移」） */
function failingMigration(version: number, name: string): Migration {
  return {
    version,
    name,
    description_zh: '测试用：必然失败的迁移',
    up(db) {
      db.exec('CREATE TABLE migration_probe (id INTEGER PRIMARY KEY)');
      // 这一句必然失败（表不存在）—— 用来验证该版本事务整体回滚
      db.exec('INSERT INTO no_such_table_for_migration_test (id) VALUES (1)');
    },
  };
}

describe('test_db_migrations · 迁移版本链', () => {
  it('① 空库开库即升到链尾版本，履历表逐版可查', () => {
    const ledger = openLedger(':memory:');
    try {
      assert.equal(schemaVersion(ledger.db), LATEST_SCHEMA_VERSION);
      assert.equal(LEDGER_SCHEMA_VERSION, LATEST_SCHEMA_VERSION);

      const history = migrationHistory(ledger.db);
      assert.equal(history.length, MIGRATIONS.length);
      // 版本号连续、从 1 开始
      assert.deepEqual(
        history.map((row) => row.version),
        MIGRATIONS.map((m) => m.version),
      );
      // 每行都有版本名与落库时刻
      for (const row of history) {
        assert.ok(row.name.length > 0, '履历行必须有版本名');
        assert.ok(row.applied_at.length > 0, '履历行必须有落库时刻');
      }
      // 链尾版本号与链定义一致
      assert.equal(history[history.length - 1]!.version, MIGRATIONS[MIGRATIONS.length - 1]!.version);
    } finally {
      ledger.close();
    }
  });

  it('② 幂等重跑：已是最新则一个版本都不动，版本号不变', () => {
    const ledger = openLedger(':memory:');
    try {
      const before = schemaVersion(ledger.db);
      const historyBefore = migrationHistory(ledger.db).length;

      const again = applyMigrations(ledger.db);
      assert.equal(again.applied.length, 0, '已是最新不该再执行任何版本');
      assert.equal(again.from, before);
      assert.equal(again.to, before);
      assert.equal(schemaVersion(ledger.db), before, '版本号不得变化');
      assert.equal(migrationHistory(ledger.db).length, historyBefore, '履历不得重复增长');

      // 第三次再跑，结果一致（真幂等）
      const third = applyMigrations(ledger.db);
      assert.equal(third.applied.length, 0);
      assert.equal(schemaVersion(ledger.db), before);
    } finally {
      ledger.close();
    }
  });

  it('③ 老库升级：版本号低的库逐版本升到链尾，历史行不丢', () => {
    const path = tempLedgerPath();
    const legacy = openLedger(path);
    // 造一个「上一版」的台账库：material_binding 没有 key_profile 列，版本号退回 1
    legacy.db.exec('DROP TABLE material_binding');
    legacy.db.exec(`CREATE TABLE material_binding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL,
      operation_no TEXT NOT NULL,
      room_no TEXT NOT NULL,
      dept_code TEXT NOT NULL,
      material_code TEXT NOT NULL,
      quantity REAL NOT NULL,
      price_code TEXT, fee_category TEXT, medical_insurance_class TEXT,
      conclusion TEXT NOT NULL, status TEXT NOT NULL, check_task_id INTEGER,
      raw_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    legacy.db.exec('PRAGMA user_version = 1');
    legacy.db
      .prepare(
        `INSERT INTO material_binding
           (idempotency_key, operation_no, room_no, dept_code, material_code, quantity,
            conclusion, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-key',
        'OP-SAMPLE-001',
        'OR-01',
        'SURG-01',
        'MAT-SAMPLE-01',
        1,
        'BOUND',
        'bound',
        new Date().toISOString(),
        new Date().toISOString(),
      );
    legacy.close();

    // 用当前版本重新打开 → 补列、建索引、升版本号，历史行仍在
    const upgraded = openLedger(path);
    try {
      assert.equal(countBindings(upgraded.db), 1, '升级不得丢历史行');
      assert.equal(schemaVersion(upgraded.db), LATEST_SCHEMA_VERSION);

      const cols = upgraded.db
        .prepare('PRAGMA table_info(material_binding)')
        .all() as unknown as Array<{ name: string }>;
      assert.ok(cols.some((c) => c.name === 'key_profile'), '缺 key_profile 列');

      const indexes = upgraded.db
        .prepare('PRAGMA index_list(material_binding)')
        .all() as unknown as Array<{ name: string }>;
      assert.ok(
        indexes.some((i) => i.name === 'ux_material_binding_code_op'),
        '升级后应建好唯一索引',
      );
      // 老版本应用的版本在履历里补记（来源标成 legacy_backfill）
      const history = migrationHistory(upgraded.db);
      assert.equal(history.length, MIGRATIONS.length);
      assert.equal(history[0]!.version, 1);
    } finally {
      upgraded.close();
    }
  });

  it('④ 迁移失败：该版事务回滚、版本号不前移、台账行数不变', () => {
    const ledger = openLedger(':memory:');
    try {
      const before = schemaVersion(ledger.db);
      const rowsBefore = countBindings(ledger.db);

      const bad = failingMigration(before + 1, 'always_fails');
      assert.throws(
        () => applyMigrations(ledger.db, { chain: [...MIGRATIONS, bad] }),
        (error: unknown) => {
          assert.ok(error instanceof MigrationError, '应抛 MigrationError');
          assert.equal(error.code, 'ERR_MIGRATION_FAILED');
          assert.equal(error.version, before + 1, '异常里要指名失败的版本号');
          assert.equal(error.migrationName, 'always_fails');
          assert.ok(error.reason.length > 0, '异常里要带失败原因');
          return true;
        },
      );

      // 版本号不前移
      assert.equal(schemaVersion(ledger.db), before, '迁移失败后版本号不得前移');
      // 台账行数不变
      assert.equal(countBindings(ledger.db), rowsBefore, '迁移失败不得改业务行');
      // 失败那一版的建表痕迹也回滚了
      const probe = ledger.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_probe'")
        .get() as { name?: string } | undefined;
      assert.equal(probe, undefined, '失败版本的 DDL 必须一并回滚');
      // 履历表里不留失败那一版
      const history = migrationHistory(ledger.db);
      assert.ok(
        !history.some((row) => row.version === before + 1),
        '履历表不得记录失败的版本',
      );
    } finally {
      ledger.close();
    }
  });

  it('⑤ 迁移失败后重试：从失败那一版继续，修好后升到链尾', () => {
    const ledger = openLedger(':memory:');
    try {
      const before = schemaVersion(ledger.db);
      const bad = failingMigration(before + 1, 'always_fails');
      assert.throws(() => applyMigrations(ledger.db, { chain: [...MIGRATIONS, bad] }));

      // 换成一条正常的版本（同一个版本号）→ 重跑从这一版继续
      const fixed: Migration = {
        version: before + 1,
        name: 'fixed_after_failure',
        description_zh: '测试用：修好之后的迁移',
        up(db) {
          db.exec('CREATE TABLE IF NOT EXISTS migration_probe (id INTEGER PRIMARY KEY)');
        },
      };
      const result = applyMigrations(ledger.db, { chain: [...MIGRATIONS, fixed] });
      assert.equal(result.from, before);
      assert.equal(result.to, before + 1);
      assert.equal(result.applied.length, 1);
      assert.equal(result.applied[0]!.version, before + 1);
      assert.equal(schemaVersion(ledger.db), before + 1);
    } finally {
      ledger.close();
    }
  });

  it('⑥ 库比程序新：拒绝启动（降级跑会写坏新表结构）', () => {
    const ledger = openLedger(':memory:');
    try {
      ledger.db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 3}`);
      assert.throws(
        () => applyMigrations(ledger.db),
        (error: unknown) => {
          assert.ok(error instanceof SchemaVersionError);
          assert.equal(error.code, 'ERR_SCHEMA_TOO_NEW');
          assert.equal(error.onDisk, LATEST_SCHEMA_VERSION + 3);
          assert.equal(error.supported, LATEST_SCHEMA_VERSION);
          return true;
        },
      );
    } finally {
      ledger.close();
    }
  });

  it('⑧ 迁移失败时守护进程非零退出，并打印失败版本号与原因', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msb-migrate-proc-'));
    workDirs.push(dir);
    const dbPath = join(dir, 'ledger.db');

    // 造一个「升级必然失败」的台账：scan_event 表结构与本程序不符，版本号停在 7
    const raw = new DatabaseSync(dbPath);
    raw.exec('CREATE TABLE scan_event (id INTEGER PRIMARY KEY, bogus TEXT)');
    raw.exec('PRAGMA user_version = 7');
    raw.close();

    const daemonEntry = resolve(projectRoot, 'dist', 'daemon.js');
    const env: Record<string, string | undefined> = {
      ...process.env,
      OR_SCANNER_BASE_URL: 'http://127.0.0.1:8099',
      OR_SCANNER_TOKEN: 'token',
      OR_SCANNER_SECRET: 'secret',
      HIS_CHARGING_BASE_URL: 'http://127.0.0.1:9100',
      HIS_CHARGING_TOKEN: 'token',
      WECOM_WEBHOOK_URL: 'http://127.0.0.1:9200/hook',
      WECOM_SECRET: 'secret',
      LEDGER_DB_PATH: dbPath,
      SCAN_INBOX_DIR: resolve(dir, 'scan-inbox'),
    };

    const result = await new Promise<{ code: number | null; stderr: string }>((done) => {
      const child = spawn(process.execPath, [daemonEntry], { env, cwd: projectRoot });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('close', (code) => done({ code, stderr }));
    });

    assert.notEqual(result.code, 0, '迁移失败必须非零退出');
    assert.match(result.stderr, /台账迁移失败：版本 \d+/, 'stderr 必须指名失败的版本号');
    assert.match(result.stderr, /版本号未前移/, 'stderr 必须说明版本号没前移');

    // 版本号停在失败前那一版（7），没有前移
    const after = new DatabaseSync(dbPath);
    const version = after.prepare('PRAGMA user_version').get() as { user_version?: number };
    assert.equal(Number(version.user_version), 7, '失败后版本号不得前移');
    after.close();
  });

  it('⑦ 每一版的 up 都幂等可重入：单独再跑一遍不报错、不改数据', () => {
    const ledger = openLedger(':memory:');
    try {
      const rowsBefore = countBindings(ledger.db);
      for (const migration of MIGRATIONS) {
        migration.up(ledger.db);
        migration.up(ledger.db);
      }
      assert.equal(countBindings(ledger.db), rowsBefore, '重放迁移不得改业务行');
      assert.equal(schemaVersion(ledger.db), LATEST_SCHEMA_VERSION);
      // 四个复合索引也在（v9 重放不报错）
      assert.ok(indexExists(ledger.db, 'ix_material_binding_op_code'));
      assert.ok(indexExists(ledger.db, 'ix_material_binding_code_created'));
      assert.ok(indexExists(ledger.db, 'ix_material_binding_status_created'));
      assert.ok(indexExists(ledger.db, 'ix_material_binding_op_created'));
    } finally {
      ledger.close();
    }
  });
});

describe('test_db_migrations · 复合索引与查询计划', () => {
  const queries: Array<{ sql: string; index: string }> = [
    {
      sql: "SELECT * FROM material_binding WHERE operation_no = 'OP-1' AND material_code = 'MAT-1'",
      index: 'ix_material_binding_op_code',
    },
    {
      sql: "SELECT * FROM material_binding WHERE material_code = 'MAT-1' ORDER BY created_at",
      index: 'ix_material_binding_code_created',
    },
    {
      sql: "SELECT * FROM material_binding WHERE status = 'bound' ORDER BY created_at",
      index: 'ix_material_binding_status_created',
    },
    {
      sql: "SELECT * FROM material_binding WHERE operation_no = 'OP-1' ORDER BY created_at",
      index: 'ix_material_binding_op_created',
    },
  ];

  it('① 四个复合索引齐备', () => {
    const ledger = openLedger(':memory:');
    try {
      for (const query of queries) {
        assert.ok(indexExists(ledger.db, query.index), `缺复合索引 ${query.index}`);
      }
    } finally {
      ledger.close();
    }
  });

  it('② 四类真实查询的 EXPLAIN QUERY PLAN 全部命中索引（不是全表扫描）', () => {
    const ledger = openLedger(':memory:');
    try {
      // 先塞一点数据，让计划器按真实分布选索引
      importMasterData(ledger.db, { operationsCsv, materialsCsv });
      for (const query of queries) {
        const plan = ledger.db
          .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
          .all() as unknown as Array<{ detail: string }>;
        const detail = plan.map((row) => row.detail).join(' | ');
        assert.match(detail, new RegExp(`USING INDEX ${query.index}`), `查询未命中索引：${detail}`);
        assert.ok(
          !/SCAN material_binding(?! USING)/.test(detail),
          `查询退化成全表扫描：${detail}`,
        );
      }
    } finally {
      ledger.close();
    }
  });
});

describe('test_db_migrations · 事务边界', () => {
  it('① 台账行 + 审计行 + 回执行同事务提交：三张表各增一行', () => {
    const ledger = openLedger(':memory:');
    try {
      withTransaction(ledger.db, () => {
        insertBinding(ledger.db, {
          idempotency_key: deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001'),
          operation_no: 'OP-SAMPLE-001',
          room_no: 'OR-01',
          dept_code: 'SURG-01',
          material_code: 'MAT-SAMPLE-01',
          quantity: 1,
          price_code: 'P-01',
          fee_category: '卫生材料',
          medical_insurance_class: '甲类',
          raw_code: null,
          conclusion: 'BOUND',
          status: 'bound',
        });
        appendAudit(ledger.db, {
          event_type: 'binding_recorded',
          operation_no: 'OP-SAMPLE-001',
          actor: 'binding_engine',
        });
        recordReceipt(ledger.db, makeReceipt('MAT-SAMPLE-01', 'OP-SAMPLE-001'));
      });

      assert.equal(countBindings(ledger.db), 1);
      assert.equal(countAuditRows(ledger.db), 1);
      assert.equal(countReceipts(ledger.db), 1);
    } finally {
      ledger.close();
    }
  });

  it('② 中途抛错：台账行 + 审计行 + 回执行三者全部回滚，行数均不变', () => {
    const ledger = openLedger(':memory:');
    try {
      const before = {
        bindings: countBindings(ledger.db),
        audits: countAuditRows(ledger.db),
        receipts: countReceipts(ledger.db),
      };

      assert.throws(() => {
        withTransaction(ledger.db, () => {
          insertBinding(ledger.db, {
            idempotency_key: deriveIdempotencyKey('MAT-SAMPLE-02', 'OP-SAMPLE-001'),
            operation_no: 'OP-SAMPLE-001',
            room_no: 'OR-01',
            dept_code: 'SURG-01',
            material_code: 'MAT-SAMPLE-02',
            quantity: 1,
            price_code: 'P-02',
            fee_category: '卫生材料',
            medical_insurance_class: '甲类',
            raw_code: null,
            conclusion: 'BOUND',
            status: 'bound',
          });
          appendAudit(ledger.db, {
            event_type: 'binding_recorded',
            operation_no: 'OP-SAMPLE-001',
            actor: 'binding_engine',
          });
          recordReceipt(ledger.db, makeReceipt('MAT-SAMPLE-02', 'OP-SAMPLE-001'));
          // 注入故障：模拟「写一半时出错」
          throw new Error('模拟事务中途失败');
        });
      }, /模拟事务中途失败/);

      assert.equal(countBindings(ledger.db), before.bindings, '台账行必须回滚');
      assert.equal(countAuditRows(ledger.db), before.audits, '审计行必须回滚');
      assert.equal(countReceipts(ledger.db), before.receipts, '回执行必须回滚');
      // 回滚后连接仍可用（没留在事务里）
      assert.equal(ledger.db.isTransaction, false);
      assert.equal(countBindings(ledger.db), 0);
    } finally {
      ledger.close();
    }
  });

  it('③ 事务可重入：外层已开事务时内层不再 BEGIN（最外层说了算）', () => {
    const ledger = openLedger(':memory:');
    try {
      withTransaction(ledger.db, () => {
        assert.equal(ledger.db.isTransaction, true);
        withTransaction(ledger.db, () => {
          assert.equal(ledger.db.isTransaction, true);
          insertBinding(ledger.db, {
            idempotency_key: deriveIdempotencyKey('MAT-SAMPLE-03', 'OP-SAMPLE-001'),
            operation_no: 'OP-SAMPLE-001',
            room_no: 'OR-01',
            dept_code: 'SURG-01',
            material_code: 'MAT-SAMPLE-03',
            quantity: 1,
            price_code: 'P-03',
            fee_category: '卫生材料',
            medical_insurance_class: '甲类',
            raw_code: null,
            conclusion: 'BOUND',
            status: 'bound',
          });
        });
      });
      assert.equal(countBindings(ledger.db), 1, '外层提交后行才落库');
    } finally {
      ledger.close();
    }
  });
});

describe('test_db_migrations · WAL · 忙等超时 · 批量切分', () => {
  it('① 默认开 WAL；忙等超时可配', () => {
    const path = tempLedgerPath();
    const ledger = openLedger(path);
    try {
      const mode = ledger.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
      assert.equal(String(mode.journal_mode).toLowerCase(), 'wal');

      const busy = ledger.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number };
      assert.equal(Number(busy.timeout), 5000);
    } finally {
      ledger.close();
    }

    const other = openLedger(tempLedgerPath(), { busyTimeoutMs: 1234 });
    try {
      const busy = other.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number };
      assert.equal(Number(busy.timeout), 1234, '忙等超时必须可配');
    } finally {
      other.close();
    }
  });

  it('② 批量切分：超过阈值就切批，条数守恒', () => {
    const items = Array.from({ length: 450 }, (_, index) => index);
    const batches = splitIntoBatches(items, DEFAULT_BATCH_COMMIT_SIZE);
    assert.equal(batches.length, 3, '450 条 / 200 条一批 = 3 批');
    assert.equal(batches[0]!.length, 200);
    assert.equal(batches[1]!.length, 200);
    assert.equal(batches[2]!.length, 50);
    assert.equal(batches.flat().length, 450, '切批不得丢条目');

    // 阈值 ≤ 0 时不切分
    assert.equal(splitIntoBatches(items, 0).length, 1);
    assert.equal(splitIntoBatches([], 200).length, 0);
  });

  it('③ 批量结算：一批一个事务，超过阈值切成多批，结论条数守恒', () => {
    const ledger = openLedger(':memory:');
    try {
      importMasterData(ledger.db, { operationsCsv, materialsCsv });

      // 6 条（不切批）
      const small = settleEvent(
        ledger.db,
        {
          operation_no: 'OP-SAMPLE-001',
          room_no: 'OR-01',
          scanner_id: 'SCAN-GUN-07',
          items: [
            { material_code: 'MAT-SAMPLE-01', raw_code: 'MAT-SAMPLE-01', quantity: 1 },
            { material_code: 'MAT-SAMPLE-02', raw_code: 'MAT-SAMPLE-02', quantity: 1 },
            { material_code: 'MAT-SAMPLE-03', raw_code: 'MAT-SAMPLE-03', quantity: 1 },
          ],
        },
        { batchSize: 200, logger: silentLogger },
      );
      assert.equal(small.stats.batches, 1, '6 条不该切批');
      assert.equal(small.stats.total, 3);
      assert.equal(small.stats.accepted + small.stats.rejected, small.stats.total);

      // 450 条（切 3 批）：同一台次同一耗材码会判批内重复，
      // 这里用不同台次号 + 不同耗材码组合来凑够条目数，验证切批与条数守恒。
      const items = Array.from({ length: 450 }, (_, index) => ({
        material_code: `MAT-BULK-${index}`,
        raw_code: `MAT-BULK-${index}`,
        quantity: 1,
      }));
      const bulk = settleEvent(
        ledger.db,
        {
          operation_no: 'OP-SAMPLE-002',
          room_no: 'OR-02',
          scanner_id: 'SCAN-GUN-07',
          items,
        },
        { batchSize: 200, logger: silentLogger },
      );
      assert.equal(bulk.stats.batches, 3, '450 条应切成 3 批提交');
      assert.equal(bulk.stats.total, 450);
      assert.equal(
        bulk.stats.accepted + bulk.stats.rejected,
        450,
        '结论条数必须守恒（一条都不丢）',
      );
      // 耗材码未建档 → 全部落 rejected（NOT_REGISTERED），但结论一条都不少
      assert.equal(bulk.stats.accepted, 0);
      assert.equal(bulk.stats.rejected, 450);
    } finally {
      ledger.close();
    }
  });

  it('④ 一批提交失败：台账不留半写的行，其余批照常提交', () => {
    const ledger = openLedger(':memory:');
    try {
      const items = Array.from({ length: 450 }, (_, index) => ({
        material_code: `MAT-BULK-${index}`,
        raw_code: `MAT-BULK-${index}`,
        quantity: 1,
      }));

      // 让**第 2 批**（第 201–400 条）提交失败：处理器里把事务回滚掉，
      // 外层 COMMIT 随之失败 —— 模拟「这一批写不进去」（磁盘满 / 表被锁）。
      let calls = 0;
      const result = settleEvent(
        ledger.db,
        {
          operation_no: 'OP-SAMPLE-002',
          room_no: 'OR-02',
          scanner_id: 'SCAN-GUN-07',
          items,
        },
        {
          batchSize: 200,
          logger: silentLogger,
          processor: (ctx) => {
            calls += 1;
            const inFailingBatch = calls > 200 && calls <= 400;
            if (inFailingBatch) {
              try {
                ctx.db.exec('ROLLBACK');
              } catch {
                // 事务已经没了（第一批失败后已被回滚），忽略
              }
              throw new Error('模拟本批提交失败');
            }
            insertBinding(ctx.db, {
              idempotency_key: deriveIdempotencyKey(ctx.material_code, ctx.operation_no),
              operation_no: ctx.operation_no,
              room_no: ctx.room_no,
              dept_code: 'SURG-02',
              material_code: ctx.material_code,
              quantity: ctx.quantity,
              price_code: 'P-BULK',
              fee_category: '卫生材料',
              medical_insurance_class: '甲类',
              raw_code: null,
              conclusion: 'BOUND',
              status: 'bound',
            });
            return {
              material_code: ctx.material_code,
              operation_no: ctx.operation_no,
              bound: true,
              raw_code: null,
              conclusion: 'BOUND',
              reason_code: null,
              error_code: null,
              charge_state: 'not_submitted',
            };
          },
        },
      );

      // 结论条数守恒：失败的那批逐条补 rejected，其余批照常给结论
      assert.equal(result.stats.total, 450);
      assert.equal(result.stats.accepted + result.stats.rejected, 450);
      assert.equal(result.stats.accepted, 250, '第 1 批 200 条 + 第 3 批 50 条');
      assert.equal(result.stats.rejected, 200, '失败那批 200 条补 rejected');
      // 台账只留成功批次的行：失败那批一行都不留（不留半写）
      assert.equal(countBindings(ledger.db), 250, '失败那批不得留下半写的台账行');
    } finally {
      ledger.close();
    }
  });
});

describe('test_db_migrations · 版本指针与履历的一致性', () => {
  it('① user_version 与 migrations 履历始终一致', () => {
    const ledger = openLedger(':memory:');
    try {
      const history = migrationHistory(ledger.db);
      const maxVersion = history[history.length - 1]!.version;
      assert.equal(currentSchemaVersion(ledger.db), maxVersion);
      assert.equal(schemaVersion(ledger.db), maxVersion);
    } finally {
      ledger.close();
    }
  });

  it('② 裸连接（不经 openLedger）也能补上履历表', () => {
    const db = new DatabaseSync(':memory:');
    try {
      // 裸连接先跑一次迁移链（模拟别的进程建好了库）
      applyMigrations(db);
      assert.equal(currentSchemaVersion(db), LATEST_SCHEMA_VERSION);
      const again = applyMigrations(db);
      assert.equal(again.applied.length, 0);
    } finally {
      db.close();
    }
  });
});

describe('test_db_migrations · 打开的台账库已带迁移结果', () => {
  it('① openLedger 返回本次迁移结果（from / to / applied）', () => {
    const path = tempLedgerPath();
    const first = openLedger(path);
    const firstResult = first.migrations;
    first.close();

    const second = openLedger(path);
    try {
      assert.equal(second.migrations.applied.length, 0, '已是最新不该再执行版本');
      assert.equal(second.migrations.from, LATEST_SCHEMA_VERSION);
      assert.equal(second.migrations.to, LATEST_SCHEMA_VERSION);
      assert.equal(second.migrations.history_rows, MIGRATIONS.length);
    } finally {
      second.close();
    }
  });
});

/** 台账连接类型在用例里直接用到的辅助别名 */
export type { LedgerDb };
