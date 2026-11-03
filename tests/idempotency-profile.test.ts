/**
 * test_idempotency_profile：幂等键版本化 + 批号维度（Task 21）。
 *
 * 覆盖：
 *   ① 键档位（profile）派生口径：v1 = 耗材码 + 台次；v2 = 耗材码 + 台次 + 批号；
 *      档位写在参与哈希的原文最前面（键自带版本号，迁移期新旧键并存）；
 *   ② 键与时间戳 / 重试次数 / 扫码枪编号无关（任何档位都成立）；
 *   ③ 配置项 IDEMPOTENCY_KEY_PROFILE：未配 → v1；配成 v2 → v2；配成别的 → 启动即报错；
 *   ④ v1 档位：同码同台次判重（台账仍 1 行）；同码**不同批**也判重，但原因码标出批号差异；
 *   ⑤ v2 档位：同码同台次**不同批号各算一次**（各落一行台账、各触发一次计费）；
 *      同批号重投仍判重（不重复计费）；
 *   ⑥ 迁移期：历史格式（legacy）的台账行不会被当成新事件 —— 旧行与新行互相挡住；
 *      v1 / v2 两版键可在同一台账里并存。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIGURABLE_IDEMPOTENCY_KEY_PROFILES,
  DEFAULT_IDEMPOTENCY_KEY_PROFILE,
  deriveIdempotencyKey,
  deriveIdempotencyKeyForProfile,
  deriveLegacyIdempotencyKey,
  keyPayloadForProfile,
  type IdempotencyKeyParts,
} from '../src/domain/idempotency.js';
import { InvalidConfigError, readIdempotencyKeyProfile } from '../src/config/env.js';
import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { bindOne, REASON_DUPLICATE_BATCH_MISMATCH, REASON_DUPLICATE_SCAN } from '../src/engine/binding.js';
import { settleEvent } from '../src/engine/settle.js';
import { writeBackOperationCharges } from '../src/charge/writeback.js';
import { HisChargingClient } from '../src/charge/client.js';
import { startFakeHisServer } from './support/fake-his-server.js';
import { runStartupChecks } from '../src/daemon/startup-check.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const MATERIAL_CODE = 'MAT-SAMPLE-01';
const OPERATION_NO = 'OP-SAMPLE-001';

/** 本文件不刷屏：结构化日志在 tests/logging.test.ts 里单独验证 */
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
  level: 'error' as const,
};

/** 每个用例一份干净的内存台账（主数据已导入） */
function freshLedger(): LedgerDb {
  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  return ledger;
}

interface BindArgs {
  material_code?: string;
  operation_no?: string;
  batch_no?: string | null;
  key_profile?: 'v1' | 'v2';
}

function bind(ledger: LedgerDb, args: BindArgs = {}) {
  return bindOne(ledger.db, {
    db: ledger.db,
    operation_no: args.operation_no ?? OPERATION_NO,
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    material_code: args.material_code ?? MATERIAL_CODE,
    raw_code: args.material_code ?? MATERIAL_CODE,
    quantity: 1,
    batch_no: args.batch_no ?? null,
    key_profile: args.key_profile ?? 'v1',
  });
}

describe('test_idempotency_profile · 幂等键版本化与批号维度', () => {
  /* ── ① 键档位派生口径 ─────────────────────────────────────────────── */

  it('① v1 档位：键 = sha256("v1|耗材码|台次")，v2 档位：键 = sha256("v2|耗材码|台次|批号")', () => {
    const v1Expected = createHash('sha256')
      .update('v1|MAT-SAMPLE-01|OP-SAMPLE-001', 'utf8')
      .digest('hex');
    const v2Expected = createHash('sha256')
      .update('v2|MAT-SAMPLE-01|OP-SAMPLE-001|LOT-SAMPLE-A', 'utf8')
      .digest('hex');

    assert.equal(
      deriveIdempotencyKeyForProfile(
        { material_code: MATERIAL_CODE, operation_no: OPERATION_NO },
        'v1',
      ).key,
      v1Expected,
    );
    assert.equal(
      deriveIdempotencyKeyForProfile(
        { material_code: MATERIAL_CODE, operation_no: OPERATION_NO, batch_no: 'LOT-SAMPLE-A' },
        'v2',
      ).key,
      v2Expected,
    );
    // 档位写在原文最前面 → 键自带版本号
    assert.equal(keyPayloadForProfile({ material_code: MATERIAL_CODE, operation_no: OPERATION_NO }, 'v1'), 'v1|MAT-SAMPLE-01|OP-SAMPLE-001');
    assert.equal(
      keyPayloadForProfile({ material_code: MATERIAL_CODE, operation_no: OPERATION_NO, batch_no: 'LOT-SAMPLE-A' }, 'v2'),
      'v2|MAT-SAMPLE-01|OP-SAMPLE-001|LOT-SAMPLE-A',
    );
  });

  it('① 键自带档位：v1 / v2 / legacy 三档的键互不相同（迁移期可并存）', () => {
    const legacy = deriveLegacyIdempotencyKey(MATERIAL_CODE, OPERATION_NO);
    const v1 = deriveIdempotencyKey(MATERIAL_CODE, OPERATION_NO);
    const v2 = deriveIdempotencyKeyForProfile(
      { material_code: MATERIAL_CODE, operation_no: OPERATION_NO, batch_no: 'LOT-SAMPLE-A' },
      'v2',
    ).key;
    assert.notEqual(legacy, v1);
    assert.notEqual(v1, v2);
    assert.notEqual(legacy, v2);
    assert.equal(new Set([legacy, v1, v2]).size, 3, '三档键必须彼此不同');
  });

  it('① v2 档位缺批号 → 降级成 v1（批号未知不细分，避免重复计费）', () => {
    const derived = deriveIdempotencyKeyForProfile(
      { material_code: MATERIAL_CODE, operation_no: OPERATION_NO, batch_no: null },
      'v2',
    );
    assert.equal(derived.profile, 'v1', '缺批号时实际生效的档位是 v1');
    assert.equal(derived.batch_missing, true);
    assert.equal(derived.batch_scoped, false);
    assert.equal(derived.key, deriveIdempotencyKey(MATERIAL_CODE, OPERATION_NO));
  });

  /* ── ② 键与时间戳 / 重试次数 / 扫码枪编号无关 ─────────────────────── */

  it('② 键与时间戳、重试次数、扫码枪编号无关（两档都成立）', () => {
    for (const profile of ['v1', 'v2'] as const) {
      const first: IdempotencyKeyParts & Record<string, unknown> = {
        material_code: MATERIAL_CODE,
        operation_no: OPERATION_NO,
        batch_no: 'LOT-SAMPLE-A',
        scan_time: '2026-01-15T09:00:00+08:00',
        attempt: 1,
        scanner_id: 'SCAN-GUN-01',
      };
      // 重投一次：时间戳变了、重试次数变了、扫码枪也换了
      const retry = {
        ...first,
        scan_time: '2026-01-15T09:05:31+08:00',
        attempt: 3,
        scanner_id: 'SCAN-GUN-09',
      } as IdempotencyKeyParts;

      assert.equal(
        deriveIdempotencyKeyForProfile(first, profile).key,
        deriveIdempotencyKeyForProfile(retry, profile).key,
        `${profile} 档位的键不随时间戳 / 重试次数 / 扫码枪编号变化`,
      );
    }
  });

  /* ── ③ 配置项 IDEMPOTENCY_KEY_PROFILE ─────────────────────────────── */

  it('③ 配置项：未配 → 默认 v1；配成 v2 → v2', () => {
    assert.equal(DEFAULT_IDEMPOTENCY_KEY_PROFILE, 'v1');
    assert.equal(readIdempotencyKeyProfile({}), 'v1');
    assert.equal(readIdempotencyKeyProfile({ IDEMPOTENCY_KEY_PROFILE: '' }), 'v1');
    assert.equal(readIdempotencyKeyProfile({ IDEMPOTENCY_KEY_PROFILE: 'v2' }), 'v2');
    assert.deepEqual([...CONFIGURABLE_IDEMPOTENCY_KEY_PROFILES], ['v1', 'v2']);
  });

  it('③ 配置项取值非法 → 启动即报错并指名变量名', () => {
    for (const bad of ['v3', 'legacy', 'V1', 'batch']) {
      assert.throws(
        () => readIdempotencyKeyProfile({ IDEMPOTENCY_KEY_PROFILE: bad }),
        (error: unknown) => {
          assert.ok(error instanceof InvalidConfigError);
          assert.equal(error.code, 'ERR_INVALID_CONFIG');
          assert.equal(error.variable, 'IDEMPOTENCY_KEY_PROFILE');
          assert.match(error.message, /IDEMPOTENCY_KEY_PROFILE/);
          return true;
        },
        `取值 ${bad} 必须被拒`,
      );
    }
  });

  it('③ 配置项非法 → 启动自检不通过（缺变量名进 missing_vars）', () => {
    // 自检会在临时目录里探路（不改项目目录里的 scan-inbox —— 别的用例依赖它不存在）
    const workDir = mkdtempSync(join(tmpdir(), 'msb-profile-check-'));
    const result = runStartupChecks({
      env: {
        OR_SCANNER_BASE_URL: 'https://scanner.example.internal',
        OR_SCANNER_TOKEN: 'token-local',
        OR_SCANNER_SECRET: 'secret-local',
        HIS_CHARGING_BASE_URL: 'https://his.example.internal',
        HIS_CHARGING_TOKEN: 'token-local',
        WECOM_WEBHOOK_URL: 'https://wecom.example.internal/hook',
        WECOM_SECRET: 'secret-local',
        IDEMPOTENCY_KEY_PROFILE: 'v9',
      },
      ledgerDbPath: join(workDir, 'ledger.db'),
      scanInboxDir: join(workDir, 'scan-inbox'),
    });
    const item = result.items.find((entry) => entry.name === '幂等键档位');
    assert.ok(item, '自检应包含幂等键档位这一项');
    assert.equal(item.ok, false);
    assert.deepEqual(item.missing_vars, ['IDEMPOTENCY_KEY_PROFILE']);
    assert.equal(result.ok, false);
  });

  /* ── ④ v1 档位：同码同台次判重；同码不同批也给批号差异原因码 ───────── */

  it('④ v1：同码同台次重复扫码 → 判重复，台账仍 1 行（不重复计费）', () => {
    const ledger = freshLedger();
    try {
      const first = bind(ledger, { batch_no: 'LOT-SAMPLE-A', key_profile: 'v1' });
      assert.equal(first.bound, true);

      const second = bind(ledger, { batch_no: 'LOT-SAMPLE-A', key_profile: 'v1' });
      assert.equal(second.bound, false);
      assert.equal(second.reason_code, REASON_DUPLICATE_SCAN);
      assert.equal(second.error_code, 'ERR_DUPLICATE_SCAN');
      assert.equal(countBindings(ledger.db), 1, '重复扫码不得产生第二行台账');
    } finally {
      ledger.close();
    }
  });

  it('④ v1：同码同台次但批号不同 → 仍判重复，原因码标出批号差异', () => {
    const ledger = freshLedger();
    try {
      const first = bind(ledger, { batch_no: 'LOT-SAMPLE-A', key_profile: 'v1' });
      assert.equal(first.bound, true);

      const second = bind(ledger, { batch_no: 'LOT-SAMPLE-B', key_profile: 'v1' });
      assert.equal(second.bound, false);
      assert.equal(second.reason_code, REASON_DUPLICATE_BATCH_MISMATCH);
      assert.equal(second.error_code, 'ERR_DUPLICATE_BATCH_MISMATCH');
      assert.match(second.detail ?? '', /LOT-SAMPLE-A/);
      assert.match(second.detail ?? '', /LOT-SAMPLE-B/);
      assert.equal(countBindings(ledger.db), 1, 'v1 档位下同码同台次只留一行');
    } finally {
      ledger.close();
    }
  });

  /* ── ⑤ v2 档位：同码不同批各算一次 ────────────────────────────────── */

  it('⑤ v2：同码同台次、不同批号 → 各绑一次，各落一行台账', () => {
    const ledger = freshLedger();
    try {
      const first = bind(ledger, { batch_no: 'LOT-SAMPLE-A', key_profile: 'v2' });
      const second = bind(ledger, { batch_no: 'LOT-SAMPLE-B', key_profile: 'v2' });
      assert.equal(first.bound, true);
      assert.equal(second.bound, true);
      assert.equal(countBindings(ledger.db), 2, '不同批号是两笔真实消耗，各占一行');

      const rows = ledger.db
        .prepare(
          'SELECT idempotency_key, key_profile, batch_no FROM material_binding ORDER BY id ASC',
        )
        .all() as unknown as Array<{ idempotency_key: string; key_profile: string; batch_no: string }>;
      assert.deepEqual(rows.map((row) => row.key_profile), ['v2', 'v2']);
      assert.deepEqual(rows.map((row) => row.batch_no), ['LOT-SAMPLE-A', 'LOT-SAMPLE-B']);
      assert.notEqual(rows[0]?.idempotency_key, rows[1]?.idempotency_key, '两行的幂等键必须不同');
    } finally {
      ledger.close();
    }
  });

  it('⑤ v2：同码同台次同批号重投 → 判重复，台账仍 1 行', () => {
    const ledger = freshLedger();
    try {
      assert.equal(bind(ledger, { batch_no: 'LOT-SAMPLE-A', key_profile: 'v2' }).bound, true);
      const again = bind(ledger, { batch_no: 'LOT-SAMPLE-A', key_profile: 'v2' });
      assert.equal(again.bound, false);
      assert.equal(again.reason_code, REASON_DUPLICATE_SCAN);
      assert.equal(countBindings(ledger.db), 1);
    } finally {
      ledger.close();
    }
  });

  it('⑤ v2：同码不同批各触发一次计费（对端收到 2 条明细、零重复）', async () => {
    const ledger = freshLedger();
    const peer = await startFakeHisServer();
    try {
      const settled = settleEvent(
        ledger.db,
        {
          operation_no: OPERATION_NO,
          room_no: 'OR-01',
          scanner_id: 'SCAN-GUN-07',
          items: [
            {
              material_code: MATERIAL_CODE,
              raw_code: MATERIAL_CODE,
              quantity: 1,
              batch_no: 'LOT-SAMPLE-A',
            },
            {
              material_code: MATERIAL_CODE,
              raw_code: MATERIAL_CODE,
              quantity: 1,
              batch_no: 'LOT-SAMPLE-B',
            },
          ],
        },
        { keyProfile: 'v2' },
      );
      assert.equal(settled.accepted.length, 2, 'v2 档位下两笔都应绑上');
      assert.equal(settled.rejected.length, 0);
      assert.equal(countBindings(ledger.db), 2);

      const client = new HisChargingClient({
        baseUrl: peer.baseUrl,
        token: 'his-charging-token-local',
        // 出站客户端的日志器是「一行一条」的函数式收集器（不是结构化日志器）
        logger: () => {},
      });
      const writeback = await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client,
        path: '/api/v1/material-uses',
        dept_code: 'SURG-01',
        logger: silentLogger,
      });
      assert.equal(writeback.calls, 1, '一次关台回写提交 1 次请求');
      assert.equal(writeback.submitted, 2, '两笔台账条目都提交给 HIS');
      assert.equal(writeback.accepted, 2, '两笔都拿到回执（逐条回执按行对齐）');
      assert.equal(peer.entries.length, 2, '对端收到 2 条明细行（一行台账一条明细）');
      // HIS 计费接口没有批号字段：同款两个批次在报文里是两行同码明细，
      // 对端按项目合并成数量 2 是对端的事；批号维度落在台账行与核查包里。
      assert.equal(peer.requests[0]?.uses.length, 2);
      assert.equal(
        peer.requests[0]?.uses.reduce((sum, use) => sum + use.quantity, 0),
        2,
        '对端收到的计量总数是 2（两笔真实消耗）',
      );

      // 两行台账各自推进到 charged（各拿各的回执，不串行）
      const statuses = ledger.db
        .prepare('SELECT status FROM material_binding ORDER BY id ASC')
        .all() as unknown as Array<{ status: string }>;
      assert.deepEqual(statuses.map((row) => row.status), ['charged', 'charged']);
    } finally {
      await peer.close();
      ledger.close();
    }
  });

  it('⑤ v2：批号缺失 → 按 v1 口径（与已有行判重复，不重复计费）', () => {
    const ledger = freshLedger();
    try {
      assert.equal(bind(ledger, { batch_no: 'LOT-SAMPLE-A', key_profile: 'v1' }).bound, true);
      const noBatch = bind(ledger, { batch_no: null, key_profile: 'v2' });
      assert.equal(noBatch.bound, false);
      assert.equal(noBatch.reason_code, REASON_DUPLICATE_SCAN);
      assert.equal(countBindings(ledger.db), 1);
    } finally {
      ledger.close();
    }
  });

  /* ── ⑥ 迁移期：历史行不被误判为新事件；两版键并存 ────────────────── */

  it('⑥ 历史格式（legacy）的台账行不会被当成新事件 —— 旧行与新行互相挡住', () => {
    const ledger = freshLedger();
    try {
      // 造一行「升级前写下」的历史行：键是 legacy 格式，档位标 legacy
      const legacyKey = deriveLegacyIdempotencyKey(MATERIAL_CODE, OPERATION_NO);
      ledger.db
        .prepare(
          `INSERT INTO material_binding
             (idempotency_key, operation_no, room_no, dept_code, material_code, quantity,
              price_code, fee_category, medical_insurance_class, conclusion, status,
              raw_code, key_profile, batch_no, created_at, updated_at)
           VALUES (?, ?, 'OR-01', 'SURG-01', ?, 1, 'PR-SAMPLE-01', '卫生材料', '甲类',
                   'BOUND', 'bound', ?, 'legacy', NULL, '2026-01-15T09:00:00.000Z', '2026-01-15T09:00:00.000Z')`,
        )
        .run(legacyKey, OPERATION_NO, MATERIAL_CODE, MATERIAL_CODE);

      // 新程序按 v1 档位重投同一条 → 必须判重复，不得产生第二行台账（不重复计费）
      const outcome = bind(ledger, { batch_no: 'LOT-SAMPLE-A', key_profile: 'v1' });
      assert.equal(outcome.bound, false);
      assert.equal(outcome.reason_code, REASON_DUPLICATE_SCAN);
      assert.equal(countBindings(ledger.db), 1, '历史行与新行互相挡住，台账仍 1 行');
    } finally {
      ledger.close();
    }
  });

  it('⑥ 迁移期 v1 / v2 两版键可在同一台账里并存（不同档位各记各的）', () => {
    const ledger = freshLedger();
    try {
      // v1 行（另一条耗材）
      assert.equal(bind(ledger, { material_code: 'MAT-SAMPLE-02', batch_no: 'LOT-SAMPLE-B', key_profile: 'v1' }).bound, true);
      // v2 行（同一台次、另一条耗材、不同批号）
      assert.equal(bind(ledger, { material_code: 'MAT-SAMPLE-03', batch_no: 'LOT-SAMPLE-C', key_profile: 'v2' }).bound, true);

      const rows = ledger.db
        .prepare('SELECT key_profile, batch_no FROM material_binding ORDER BY id ASC')
        .all() as unknown as Array<{ key_profile: string; batch_no: string }>;
      assert.deepEqual(rows.map((row) => row.key_profile), ['v1', 'v2']);
      assert.deepEqual(rows.map((row) => row.batch_no), ['LOT-SAMPLE-B', 'LOT-SAMPLE-C']);
      assert.equal(countBindings(ledger.db), 2);
    } finally {
      ledger.close();
    }
  });

  it('⑥ 迁移链：v11 认领历史行（老行标 legacy）+ 唯一防线按档位分口径', async () => {
    const ledger = freshLedger();
    try {
      // 把库拨回「升级前」：版本指针停在 v10、履历里没有 v11
      ledger.db.exec('DELETE FROM migrations WHERE version = 11');
      ledger.db.exec('PRAGMA user_version = 10');

      // 升级前写下的行：键是 legacy 格式（sha256(码|台次)），档位标着 v1
      const legacyKey = deriveLegacyIdempotencyKey(MATERIAL_CODE, OPERATION_NO);
      ledger.db
        .prepare(
          `INSERT INTO material_binding
             (idempotency_key, operation_no, room_no, dept_code, material_code, quantity,
              price_code, fee_category, medical_insurance_class, conclusion, status,
              raw_code, key_profile, batch_no, created_at, updated_at)
           VALUES (?, ?, 'OR-01', 'SURG-01', ?, 1, 'PR-SAMPLE-01', '卫生材料', '甲类',
                   'BOUND', 'bound', ?, 'v1', NULL, '2026-01-15T09:00:00.000Z', '2026-01-15T09:00:00.000Z')`,
        )
        .run(legacyKey, OPERATION_NO, MATERIAL_CODE, MATERIAL_CODE);

      const before = ledger.db
        .prepare('SELECT key_profile FROM material_binding WHERE idempotency_key = ?')
        .get(legacyKey) as { key_profile: string };
      assert.equal(before.key_profile, 'v1', '升级前该行仍标着 v1');

      const { applyMigrations } = await import('../src/ledger/migrations.js');
      const result = applyMigrations(ledger.db);
      // 从 v10 往上走：v11 必在其中（其后可能还有别的版本，按版本号升序续跑）
      const v11Index = result.applied.findIndex((row) => row.version === 11);
      assert.ok(v11Index >= 0, 'v11 必须在本次应用的版本里');
      assert.equal(result.applied[v11Index]?.name, 'binding_key_versioning');
      assert.deepEqual(
        result.applied.map((row) => row.version),
        [...result.applied.map((row) => row.version)].sort((a, b) => a - b),
        '版本按升序应用',
      );
      assert.equal(result.applied[0]?.version, 11, 'v11 是从 v10 往上的第一版');

      const after = ledger.db
        .prepare('SELECT key_profile FROM material_binding WHERE idempotency_key = ?')
        .get(legacyKey) as { key_profile: string };
      assert.equal(after.key_profile, 'legacy', '历史键的行应被认领成 legacy 档位');
      assert.equal(countBindings(ledger.db), 1, '认领不改业务行');

      // 唯一防线：v1 与 legacy 互相挡住，v2 按（码 + 台次 + 批号）另算
      const indexes = ledger.db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'material_binding'")
        .all() as unknown as Array<{ name: string; sql: string }>;
      const codeOp = indexes.find((index) => index.name === 'ux_material_binding_code_op');
      assert.ok(codeOp, '同码同台次唯一防线必须存在');
      assert.match(codeOp.sql, /legacy/);
      assert.match(codeOp.sql, /v1/);
      const batchIndex = indexes.find((index) => index.name === 'ux_material_binding_code_op_batch');
      assert.ok(batchIndex, 'v2 档位的（码 + 台次 + 批号）唯一防线必须存在');
      assert.match(batchIndex.sql, /batch_no/);
      assert.match(batchIndex.sql, /v2/);
    } finally {
      ledger.close();
    }
  });
});
