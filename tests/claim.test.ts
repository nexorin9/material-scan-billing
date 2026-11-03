/**
 * test_claim：幂等占位层（claim / confirm / release 三段租约 + 崩溃续跑）。
 *
 * 覆盖：
 *   ① 同键重复投递 10 次 → material_binding 只 1 行（不重复计费）；
 *   ② 占位后崩溃 → 重启 requeue 接管续跑，台账仍只 1 行，claim_count 递增；
 *   ③ 崩溃发生在「已落台账、未确认」之后 → 续跑不写第二行（唯一索引兜底）；
 *   ④ 并发 20 次同键 → 只有 1 个拿到租约令牌，其余 busy 不重复处理；
 *   ⑤ confirm / release 校验 token，令牌不符一律拒绝；
 *   ⑥ release 的原因写进审计链；
 *   ⑦ 第二道去重防线：(material_code, operation_no) 唯一索引存在并生效。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openLedger, LEDGER_SCHEMA_VERSION, schemaVersion, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import {
  countBindings,
  findBindingByCodeAndOperation,
  findBindingByKey,
} from '../src/ledger/binding-repo.js';
import {
  claim,
  confirm,
  release,
  requeueExpired,
  getClaim,
  countClaims,
  countActiveClaims,
  ClaimError,
  ERR_CLAIM_TOKEN_MISMATCH,
  ERR_CLAIM_NOT_FOUND,
} from '../src/ledger/claim.js';
import { queryAuditByKey } from '../src/ledger/audit.js';
import { bindOne } from '../src/engine/binding.js';
import { deriveIdempotencyKey } from '../src/domain/idempotency.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const MATERIAL_CODE = 'MAT-SAMPLE-01';
const OPERATION_NO = 'OP-SAMPLE-001';
const KEY = deriveIdempotencyKey(MATERIAL_CODE, OPERATION_NO);

function bindCtx() {
  return {
    db: undefined as unknown as LedgerDb['db'],
    operation_no: OPERATION_NO,
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    material_code: MATERIAL_CODE,
    raw_code: MATERIAL_CODE,
    quantity: 1,
  };
}

let ledger: LedgerDb;

before(() => {
  ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
});

after(() => {
  ledger.close();
});

describe('test_claim · 幂等占位三段租约', () => {
  it('同键重复投递 10 次 → 台账只 1 行', () => {
    const ctx = { ...bindCtx(), db: ledger.db };
    const before = countBindings(ledger.db);

    const outcomes = [];
    for (let i = 0; i < 10; i += 1) {
      outcomes.push(bindOne(ledger.db, ctx));
    }

    assert.equal(countBindings(ledger.db) - before, 1, '同键投递 10 次只应新增 1 行台账');
    // 第 1 次绑上，其余 9 次都是重复扫码
    assert.equal(outcomes.filter((o) => o.bound).length, 1);
    assert.equal(outcomes.filter((o) => o.reason_code === 'DUPLICATE_SCAN').length, 9);
    // 台账行可按幂等键与（耗材码 + 台次）两条路查到
    assert.ok(findBindingByKey(ledger.db, KEY));
    assert.ok(findBindingByCodeAndOperation(ledger.db, MATERIAL_CODE, OPERATION_NO));
  });

  it('并发 20 次同键 → 只有 1 个拿到租约令牌，其余 busy', async () => {
    const key = deriveIdempotencyKey('MAT-SAMPLE-03', 'OP-SAMPLE-002');
    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        claim(ledger.db, key, {
          operation_no: 'OP-SAMPLE-002',
          material_code: 'MAT-SAMPLE-03',
          leaseMs: 60_000,
        }),
      ),
    );

    const claimed = results.filter((r) => r.status === 'claimed');
    const busy = results.filter((r) => r.status === 'busy');
    assert.equal(claimed.length, 1, '并发同键只应有一个拿到租约');
    assert.equal(busy.length, 19);
    assert.ok(claimed[0]?.token, '拿到租约的那一个必须带令牌');
    for (const b of busy) assert.equal(b.token, null, 'busy 的不发放令牌');

    // 只有一个占位行
    assert.equal(countClaims(ledger.db) >= 1, true);
    const row = getClaim(ledger.db, key);
    assert.equal(row?.state, 'claimed');
    assert.equal(row?.claim_count, 1);
  });

  it('租约未过期时他人抢不到；到期后由下一位接管（claim_count 递增）', () => {
    const key = deriveIdempotencyKey('MAT-SAMPLE-04', 'OP-SAMPLE-002');
    const t0 = 1_800_000_000_000;

    const first = claim(ledger.db, key, { leaseMs: 1_000, nowMs: t0 });
    assert.equal(first.status, 'claimed');
    assert.equal(first.tookOver, false);

    // 租约未过期 → busy，不重复处理
    const second = claim(ledger.db, key, { leaseMs: 1_000, nowMs: t0 + 500 });
    assert.equal(second.status, 'busy');
    assert.equal(second.claimCount, 1);

    // 租约已过期 → 接管，claim_count +1
    const third = claim(ledger.db, key, { leaseMs: 1_000, nowMs: t0 + 2_000 });
    assert.equal(third.status, 'claimed');
    assert.equal(third.tookOver, true);
    assert.equal(third.claimCount, 2);
    assert.notEqual(third.token, first.token, '接管必须换令牌');
  });

  it('confirm 校验 token：令牌不符一律拒绝', () => {
    const key = deriveIdempotencyKey('MAT-SAMPLE-05', 'OP-SAMPLE-002');
    const lease = claim(ledger.db, key, { leaseMs: 60_000 });
    assert.equal(lease.status, 'claimed');

    assert.throws(
      () => confirm(ledger.db, key, 'not-the-right-token'),
      (error: unknown) =>
        error instanceof ClaimError && error.code === ERR_CLAIM_TOKEN_MISMATCH,
    );

    // 正确令牌 → 确认成功；重复确认幂等
    const confirmed = confirm(ledger.db, key, lease.token as string);
    assert.equal(confirmed.alreadyConfirmed, false);
    const again = confirm(ledger.db, key, lease.token as string);
    assert.equal(again.alreadyConfirmed, true);
    assert.equal(getClaim(ledger.db, key)?.state, 'confirmed');

    // 不存在的键 → 明确报错
    assert.throws(
      () => confirm(ledger.db, 'key-that-never-existed', 'x'),
      (error: unknown) => error instanceof ClaimError && error.code === ERR_CLAIM_NOT_FOUND,
    );
  });

  it('release 释放占位并把原因写进审计链', () => {
    const key = deriveIdempotencyKey('MAT-SAMPLE-02', 'OP-SAMPLE-002');
    const lease = claim(ledger.db, key, { leaseMs: 60_000, operation_no: 'OP-SAMPLE-002' });
    assert.equal(lease.status, 'claimed');

    release(ledger.db, key, lease.token as string, 'MATERIAL_NOT_REGISTERED');

    const row = getClaim(ledger.db, key);
    assert.equal(row?.state, 'released');
    assert.equal(row?.release_reason, 'MATERIAL_NOT_REGISTERED');
    assert.ok(row?.released_at);

    const audits = queryAuditByKey(ledger.db, key);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.event_type, 'claim_released');
    assert.match(audits[0]?.detail ?? '', /MATERIAL_NOT_REGISTERED/);

    // 释放后可再次占位（接管），claim_count 递增
    const again = claim(ledger.db, key, { leaseMs: 60_000 });
    assert.equal(again.status, 'claimed');
    assert.equal(again.tookOver, true);
    assert.equal(again.claimCount, 2);
  });

  it('第二道去重防线：(material_code, operation_no) 唯一索引存在', () => {    const indexes = ledger.db
      .prepare('PRAGMA index_list(material_binding)')
      .all() as unknown as Array<{ name: string; unique: number }>;
    const ux = indexes.find((item) => item.name === 'ux_material_binding_code_op');
    assert.ok(ux, '缺少 (material_code, operation_no) 唯一索引');
    assert.equal(ux?.unique, 1);

    // 直接绕开幂等键写第二行 → 被唯一索引挡住
    const now = new Date().toISOString();
    const row = ledger.db
      .prepare(
        `SELECT idempotency_key, operation_no, room_no, dept_code, material_code, quantity,
                conclusion, status, created_at, updated_at
           FROM material_binding WHERE material_code = ? AND operation_no = ?`,
      )
      .get(MATERIAL_CODE, OPERATION_NO) as {
      operation_no: string;
      room_no: string;
      dept_code: string;
      material_code: string;
    };
    assert.throws(() => {
      ledger.db
        .prepare(
          `INSERT INTO material_binding
             (idempotency_key, operation_no, room_no, dept_code, material_code, quantity,
              conclusion, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'another-key-should-not-matter',
          row.operation_no,
          row.room_no,
          row.dept_code,
          row.material_code,
          1,
          'BOUND',
          'bound',
          now,
          now,
        );
    }, /UNIQUE constraint failed/);
  });

  it('既有 v1 台账库可原地升级：补列建索引且历史行不丢', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msb-legacy-'));
    try {
      const legacyPath = join(dir, 'legacy.db');
      // 造一个「上一版」的台账库：material_binding 没有 key_profile 列，user_version = 1
      const legacy = openLedger(legacyPath);
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
          'legacy-key', OPERATION_NO, 'OR-01', 'SURG-01', 'MAT-SAMPLE-01', 1,
          'BOUND', 'bound', new Date().toISOString(), new Date().toISOString(),
        );
      legacy.close();

      // 用当前版本重新打开 → 补列、建索引、升版本号，历史行仍在
      const upgraded = openLedger(legacyPath);
      assert.equal(countBindings(upgraded.db), 1, '升级不得丢历史行');
      const cols = upgraded.db.prepare('PRAGMA table_info(material_binding)').all() as unknown as Array<{ name: string }>;
      assert.ok(cols.some((c) => c.name === 'key_profile'), '缺 key_profile 列');
      const row = upgraded.db
        .prepare('SELECT key_profile FROM material_binding WHERE idempotency_key = ?')
        .get('legacy-key') as { key_profile: string };
      assert.equal(row.key_profile, 'v1', '历史行的键档位应补成 v1');
      const indexes = upgraded.db.prepare('PRAGMA index_list(material_binding)').all() as unknown as Array<{ name: string }>;
      assert.ok(indexes.some((i) => i.name === 'ux_material_binding_code_op'), '升级后应建好唯一索引');
      assert.equal(schemaVersion(upgraded.db), LEDGER_SCHEMA_VERSION);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('test_claim · 崩溃续跑（换进程重开台账库）', () => {
  const workDirs: string[] = [];

  after(() => {
    for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
  });

  /** 每个用例一个独立台账库文件（互不干扰，模拟各自的部署目录） */
  function freshLedgerPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'msb-claim-'));
    workDirs.push(dir);
    return join(dir, 'ledger.db');
  }

  it('占位后崩溃 → 重启 requeue 接管续跑，台账仍只 1 行，claim_count 递增', () => {
    const dbPath = freshLedgerPath();
    const key = deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001');

    // ── 进程 A：占位后「崩溃」（未落台账、未确认）
    // 占位时刻取 5 秒前、租约 1 秒 → 重启时租约已过期（模拟进程崩溃后停了 5 秒）
    const crashedAt = Date.now() - 5_000;
    const procA = openLedger(dbPath);
    importMasterData(procA.db, { operationsCsv, materialsCsv });
    const lease = claim(procA.db, key, {
      operation_no: OPERATION_NO,
      material_code: MATERIAL_CODE,
      leaseMs: 1_000,
      nowMs: crashedAt,
    });
    assert.equal(lease.status, 'claimed');
    assert.equal(countBindings(procA.db), 0);
    procA.close(); // 崩溃：未 confirm，占位留在库里

    // ── 进程 B：重启 → requeue 扫描到过期占位
    const procB = openLedger(dbPath);
    importMasterData(procB.db, { operationsCsv, materialsCsv });
    const requeued = requeueExpired(procB.db);
    const hit = requeued.find((item) => item.key === key);
    assert.ok(hit, '过期占位应被重新入队');
    assert.equal(hit?.operation_no, OPERATION_NO);
    assert.equal(getClaim(procB.db, key)?.state, 'released');

    // 续跑：接管占位 → 落台账 → 确认
    const outcome = bindOne(procB.db, { ...bindCtx(), db: procB.db });
    assert.equal(outcome.bound, true);
    assert.equal(countBindings(procB.db), 1, '续跑后仍只 1 行台账');

    const row = getClaim(procB.db, key);
    assert.equal(row?.state, 'confirmed');
    assert.equal(row?.claim_count, 2, '接管后 claim_count 应递增');
    assert.equal(countActiveClaims(procB.db), 0);
    procB.close();
  });

  it('崩溃发生在「已落台账、未确认」之后 → 续跑不写第二行', () => {
    const dbPath = freshLedgerPath();
    const key = deriveIdempotencyKey('MAT-SAMPLE-02', 'OP-SAMPLE-001');

    // ── 进程 A：占位 → 落台账 → 崩溃（未 confirm）
    const crashedAt = Date.now() - 5_000;
    const procA = openLedger(dbPath);
    importMasterData(procA.db, { operationsCsv, materialsCsv });
    const lease = claim(procA.db, key, {
      operation_no: OPERATION_NO,
      material_code: 'MAT-SAMPLE-02',
      leaseMs: 1_000,
      nowMs: crashedAt,
    });
    assert.equal(lease.status, 'claimed');
    procA.db
      .prepare(
        `INSERT INTO material_binding
           (idempotency_key, operation_no, room_no, dept_code, material_code, quantity,
            conclusion, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, OPERATION_NO, 'OR-01', 'SURG-01', 'MAT-SAMPLE-02', 1, 'BOUND', 'bound', new Date().toISOString(), new Date().toISOString());
    assert.equal(countBindings(procA.db), 1);
    procA.close();

    // ── 进程 B：重启 → requeue → 续跑被唯一索引挡住，不写第二行
    const procB = openLedger(dbPath);
    importMasterData(procB.db, { operationsCsv, materialsCsv });
    const requeued = requeueExpired(procB.db);
    assert.ok(requeued.find((item) => item.key === key));

    const outcome = bindOne(procB.db, {
      ...bindCtx(),
      material_code: 'MAT-SAMPLE-02',
      db: procB.db,
    });
    assert.equal(outcome.bound, false);
    assert.equal(outcome.reason_code, 'DUPLICATE_SCAN');
    assert.equal(countBindings(procB.db), 1, '续跑不得写第二行台账');
    procB.close();
  });
});
