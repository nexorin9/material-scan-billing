/**
 * test_operation_binding —— 台次归属与科室一致性**双因子交叉核对**。
 *
 * 覆盖：
 *   ① 手术间不一致 → 归属冲突，绝不落 BOUND，转核查条目；
 *   ② 科室不一致 → 归属冲突，绝不落 BOUND；
 *   ③ 双因子同时不一致 → 归属冲突，两个因子都在判定依据里；
 *   ④ 双因子一致 → BOUND；
 *   ⑤ 台账同时保留**事件手术间**与**排台手术间**两个字段（台账行 + 核查条目两侧都留痕）；
 *   ⑥ 扫码枪位置登记与事件不一致（配置漂移）→ 记审计 + 按冲突处理；
 *   ⑦ 扫码枪位置登记簿的解析口径（写错的登记只跳过那一条，不带崩整本簿子）。
 *
 * 为什么值得单独测：绑错台就是错账 —— 耗材计到了别的手术上，事后没人说得清。
 * 「绝不猜绑」在这里的具体含义就是：**任一因子对不上就拒绝，并留痕**。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import {
  checkAttribution,
  resolveOperation,
  REASON_OPERATION_ATTRIBUTION_CONFLICT,
} from '../src/engine/operation.js';
import { classify, concludeAndRecord } from '../src/engine/conclude.js';
import { bindOne } from '../src/engine/binding.js';
import { countCheckTasks, findCheckTask } from '../src/check/task.js';
import { parseScannerRegistry, readScannerRegistry, ScannerRegistry } from '../src/config/scanner-registry.js';
import { errorCodeForReason } from '../src/log/error-codes.js';

/* ── 主数据（归属核对专用，与其他测试的 fixture 相互独立） ── */

const OP_A = 'OP-ATTR-001';
const OP_B = 'OP-ATTR-002';

const OPERATIONS: Array<[string, string, string, string]> = [
  [OP_A, 'OR-10', 'SURG-A', 'open'],
  [OP_B, 'OR-20', 'SURG-B', 'open'],
];

const MATERIALS: Array<[string, string, string, string, string]> = [
  ['MAT-ATTR-01', '归属核对样例耗材甲', 'PR-ATTR-01', '卫生材料', '甲类'],
  ['MAT-ATTR-02', '归属核对样例耗材乙', 'PR-ATTR-02', '卫生材料', '甲类'],
];

let ledger: LedgerDb;

before(() => {
  ledger = openLedger(':memory:');

  const insertOp = ledger.db.prepare(
    `INSERT INTO operation (operation_no, room_no, dept_code, status, closed_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, '2026-01-15T08:00:00Z')`,
  );
  for (const [no, room, dept, status] of OPERATIONS) insertOp.run(no, room, dept, status);

  const insertMat = ledger.db.prepare(
    `INSERT INTO material (material_code, name, price_code, fee_category, medical_insurance_class, active, batch_no,
                            unit_pack, unit_min, charge_unit, ratio, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 'LOT-ATTR', '包', '支', '支', 1, '2026-01-15T08:00:00Z')`,
  );
  for (const [code, name, price, fee, cls] of MATERIALS) insertMat.run(code, name, price, fee, cls);
});

after(() => {
  ledger.close();
});

/** 扫码枪位置登记（登记簿里的一行） */
function scannerOf(scanner_id: string, room_no: string | null, dept_code: string | null) {
  return { scanner_id, room_no, dept_code };
}

function judge(options: {
  operation_no?: string;
  room_no: string;
  dept_code?: string | null;
  scanner?: { scanner_id: string; room_no: string | null; dept_code: string | null } | null;
  material_code?: string;
}) {
  return classify({
    db: ledger.db,
    operation_no: options.operation_no ?? OP_A,
    room_no: options.room_no,
    scanner_id: options.scanner?.scanner_id ?? 'SCAN-GUN-ATTR',
    dept_code: options.dept_code ?? null,
    scanner: options.scanner ?? null,
    material_code: options.material_code ?? 'MAT-ATTR-01',
    raw_code: options.material_code ?? 'MAT-ATTR-01',
    quantity: 1,
  });
}

describe('test_operation_binding · 因子 A：手术间不一致', () => {
  it('事件手术间与排台手术间不一致 → 归属冲突，绝不落 BOUND', () => {
    const result = judge({ room_no: 'OR-99' });
    assert.equal(result.conclusion, 'NOT_REGISTERED');
    assert.equal(result.bound, false);
    assert.equal(result.reason_code, REASON_OPERATION_ATTRIBUTION_CONFLICT);
    assert.equal(result.error_code, 'ERR_OPERATION_CONFLICT');
    assert.equal(result.needs_manual, true);
    assert.deepEqual(result.attribution?.mismatches, ['room_no']);
    assert.equal(result.attribution?.event_room_no, 'OR-99');
    assert.equal(result.attribution?.master_room_no, 'OR-10');
    assert.ok(result.basis.some((line) => line.includes('OR-99') && line.includes('OR-10')));
  });

  it('冲突条目转核查条目，且两侧手术间都留在核查条目上', () => {
    const beforeTasks = countCheckTasks(ledger.db);
    const result = concludeAndRecord(ledger.db, {
      db: ledger.db,
      operation_no: OP_A,
      room_no: 'OR-99',
      scanner_id: 'SCAN-GUN-ATTR',
      material_code: 'MAT-ATTR-01',
      quantity: 1,
    });
    assert.equal(result.conclusion, 'NOT_REGISTERED');
    assert.equal(result.reason_code, REASON_OPERATION_ATTRIBUTION_CONFLICT);
    assert.ok(result.check_task_id, '归属冲突必须转人工核查');
    assert.equal(countCheckTasks(ledger.db), beforeTasks + 1);

    const task = findCheckTask(ledger.db, result.check_task_id as number);
    assert.equal(task?.event_room_no, 'OR-99', '核查条目要留事件侧的手术间');
    assert.equal(task?.master_room_no, 'OR-10', '核查条目要留排台侧的手术间');
    assert.equal(task?.room_no, 'OR-99');
    assert.equal(task?.reason_code, REASON_OPERATION_ATTRIBUTION_CONFLICT);
    assert.equal(task?.error_code, 'ERR_OPERATION_CONFLICT');
  });
});

describe('test_operation_binding · 因子 B：科室不一致', () => {
  it('扫码枪登记的科室与排台科室不一致 → 归属冲突，绝不落 BOUND', () => {
    const result = judge({
      room_no: 'OR-10',
      scanner: scannerOf('SCAN-GUN-ATTR', 'OR-10', 'SURG-B'),
    });
    assert.equal(result.conclusion, 'NOT_REGISTERED');
    assert.equal(result.reason_code, REASON_OPERATION_ATTRIBUTION_CONFLICT);
    assert.equal(result.bound, false);
    assert.deepEqual(result.attribution?.mismatches, ['dept_code']);
    assert.equal(result.attribution?.event_dept_code, 'SURG-B');
    assert.equal(result.attribution?.master_dept_code, 'SURG-A');
  });

  it('事件自带的科室上下文与排台科室不一致 → 同样判冲突', () => {
    const result = judge({ room_no: 'OR-10', dept_code: 'SURG-Z' });
    assert.equal(result.conclusion, 'NOT_REGISTERED');
    assert.equal(result.reason_code, REASON_OPERATION_ATTRIBUTION_CONFLICT);
    assert.deepEqual(result.attribution?.mismatches, ['dept_code']);
    assert.equal(result.attribution?.event_dept_code, 'SURG-Z');
  });
});

describe('test_operation_binding · 双因子同时不一致', () => {
  it('手术间与科室都对不上 → 归属冲突，两个因子都进判定依据', () => {
    // 扫码枪登记在 OR-99（与事件一致 → 不算配置漂移），但排台说这是 OR-10 / SURG-A
    const result = judge({
      room_no: 'OR-99',
      scanner: scannerOf('SCAN-GUN-ATTR', 'OR-99', 'SURG-B'),
    });
    assert.equal(result.conclusion, 'NOT_REGISTERED');
    assert.equal(result.reason_code, REASON_OPERATION_ATTRIBUTION_CONFLICT);
    assert.equal(result.bound, false);
    assert.deepEqual(result.attribution?.mismatches, ['room_no', 'dept_code']);
    assert.equal(result.attribution?.config_drift, false);
    assert.ok(result.basis.some((line) => line.includes('room_no / dept_code')));
  });
});

describe('test_operation_binding · 双因子一致', () => {
  it('手术间与科室都对得上 → BOUND', () => {
    const result = judge({
      room_no: 'OR-10',
      scanner: scannerOf('SCAN-GUN-ATTR', 'OR-10', 'SURG-A'),
    });
    assert.equal(result.conclusion, 'BOUND');
    assert.equal(result.bound, true);
    assert.equal(result.reason_code, null);
    assert.equal(result.attribution?.ok, true);
    assert.deepEqual(result.attribution?.mismatches, []);
  });

  it('没登记扫码枪时：事件手术间与排台一致即可绑上（不硬凑科室因子）', () => {
    const result = judge({ room_no: 'OR-10' });
    assert.equal(result.conclusion, 'BOUND');
    assert.equal(result.attribution?.ok, true);
    assert.equal(result.attribution?.event_dept_code, null);
  });
});

describe('test_operation_binding · 台账同时保留两个 room_no', () => {
  it('绑上的台账行同时留事件手术间与排台手术间', () => {
    const outcome = bindOne(ledger.db, {
      db: ledger.db,
      operation_no: OP_A,
      room_no: 'OR-10',
      scanner_id: 'SCAN-GUN-ATTR',
      scanner: scannerOf('SCAN-GUN-ATTR', 'OR-10', 'SURG-A'),
      material_code: 'MAT-ATTR-02',
      raw_code: 'MAT-ATTR-02',
      quantity: 1,
    });
    assert.equal(outcome.bound, true);

    const row = ledger.db
      .prepare(
        `SELECT room_no, event_room_no, master_room_no, dept_code, event_dept_code
           FROM material_binding WHERE material_code = 'MAT-ATTR-02'`,
      )
      .get() as {
      room_no: string;
      event_room_no: string;
      master_room_no: string;
      dept_code: string;
      event_dept_code: string | null;
    };
    assert.equal(row.event_room_no, 'OR-10', '台账要留事件侧的手术间');
    assert.equal(row.master_room_no, 'OR-10', '台账要留排台侧的手术间');
    assert.equal(row.room_no, 'OR-10');
    assert.equal(row.dept_code, 'SURG-A');
    assert.equal(row.event_dept_code, 'SURG-A');
  });

  it('冲突条目不写耗材使用台账（不落半写的行）', () => {
    const before = countBindings(ledger.db);
    const result = concludeAndRecord(ledger.db, {
      db: ledger.db,
      operation_no: OP_A,
      room_no: 'OR-77',
      scanner_id: 'SCAN-GUN-ATTR',
      material_code: 'MAT-ATTR-01',
      quantity: 1,
    });
    assert.equal(result.conclusion, 'NOT_REGISTERED');
    assert.equal(countBindings(ledger.db), before, '归属冲突不得写台账行');
  });
});

describe('test_operation_binding · 扫码枪位置登记与事件不一致（配置漂移）', () => {
  it('登记在 OR-10、事件来自 OR-20 → 记审计 + 按冲突处理', () => {
    const auditBefore = ledger.db
      .prepare("SELECT COUNT(*) AS n FROM audit_chain WHERE event_type = 'scanner_config_drift'")
      .get() as { n: number };

    const result = concludeAndRecord(ledger.db, {
      db: ledger.db,
      operation_no: OP_A,
      room_no: 'OR-20',
      scanner_id: 'SCAN-GUN-DRIFT',
      scanner: scannerOf('SCAN-GUN-DRIFT', 'OR-10', 'SURG-A'),
      material_code: 'MAT-ATTR-01',
      quantity: 1,
    });

    assert.equal(result.conclusion, 'NOT_REGISTERED');
    assert.equal(result.reason_code, REASON_OPERATION_ATTRIBUTION_CONFLICT);
    assert.equal(result.bound, false);
    assert.equal(result.attribution?.config_drift, true);
    assert.ok(result.basis.some((line) => line.includes('记审计')));

    const auditAfter = ledger.db
      .prepare("SELECT COUNT(*) AS n FROM audit_chain WHERE event_type = 'scanner_config_drift'")
      .get() as { n: number };
    assert.equal(auditAfter.n, auditBefore.n + 1, '配置漂移必须留一行审计');

    const drift = ledger.db
      .prepare("SELECT * FROM audit_chain WHERE event_type = 'scanner_config_drift' ORDER BY id DESC LIMIT 1")
      .get() as { operation_no: string; scanner_id: string; detail: string };
    assert.equal(drift.operation_no, OP_A);
    assert.equal(drift.scanner_id, 'SCAN-GUN-DRIFT');
    const detail = JSON.parse(drift.detail) as { registered_room_no: string; event_room_no: string };
    assert.equal(detail.registered_room_no, 'OR-10');
    assert.equal(detail.event_room_no, 'OR-20');
  });
});

describe('test_operation_binding · 登记簿解析口径', () => {
  it('解析「扫码枪编号=手术间,科室」，多条用分号分隔', () => {
    const { registry, issues } = parseScannerRegistry(
      'SCAN-GUN-07=OR-01,SURG-01;SCAN-GUN-08=OR-02;SCAN-GUN-09=OR-03,SURG-03',
    );
    assert.equal(issues.length, 0);
    assert.equal(registry.size, 3);
    assert.deepEqual(registry.lookup('SCAN-GUN-07'), {
      scanner_id: 'SCAN-GUN-07',
      room_no: 'OR-01',
      dept_code: 'SURG-01',
    });
    assert.equal(registry.lookup('SCAN-GUN-08')?.dept_code, null);
    assert.equal(registry.lookup('SCAN-GUN-09')?.dept_code, 'SURG-03');
    assert.equal(registry.lookup('NOT-REGISTERED'), undefined);
  });

  it('写错的那一条被跳过并记问题，其余登记照常生效（不带崩整本簿子）', () => {
    const { registry, issues } = parseScannerRegistry('SCAN-GUN-07=OR-01;坏登记;SCAN-GUN-08=OR-02');
    assert.equal(issues.length, 1);
    assert.equal(registry.size, 2);
    assert.equal(registry.lookup('SCAN-GUN-08')?.room_no, 'OR-02');
  });

  it('没配 OR_SCANNER_REGISTRY → 空登记簿（不报错，不影响启动）', () => {
    const registry = readScannerRegistry({});
    assert.equal(registry.size, 0);
    assert.equal(registry.lookup('SCAN-GUN-07'), undefined);
  });

  it('登记簿经结算层传入后，双因子核对真的用上了登记的科室', () => {
    const registry = new ScannerRegistry([
      { scanner_id: 'SCAN-GUN-ATTR', room_no: 'OR-10', dept_code: 'SURG-B' },
    ]);
    const resolution = resolveOperation(ledger.db, OP_A, {
      room_no: 'OR-10',
      scanner: registry.lookup('SCAN-GUN-ATTR') ?? null,
    });
    assert.equal(resolution.status, 'open');
    assert.equal(resolution.attribution?.ok, false);
    assert.deepEqual(resolution.attribution?.mismatches, ['dept_code']);
  });
});

describe('test_operation_binding · 双因子核对是纯函数', () => {
  it('缺任一侧时该因子不参与判断（不硬凑）', () => {
    const noMaster = checkAttribution({ room_no: null, dept_code: null }, { room_no: 'OR-10' });
    assert.equal(noMaster.ok, true, '排台侧没登记时不判冲突');
    assert.deepEqual(noMaster.mismatches, []);

    const noEvent = checkAttribution({ room_no: 'OR-10', dept_code: 'SURG-A' }, {});
    assert.equal(noEvent.ok, true);
  });

  it('两侧一致 → ok；任一侧不一致 → 不 ok', () => {
    assert.equal(
      checkAttribution({ room_no: 'OR-10', dept_code: 'SURG-A' }, { room_no: 'OR-10', dept_code: 'SURG-A' }).ok,
      true,
    );
    assert.equal(
      checkAttribution({ room_no: 'OR-10', dept_code: 'SURG-A' }, { room_no: 'OR-11', dept_code: 'SURG-A' }).ok,
      false,
    );
    assert.equal(
      checkAttribution({ room_no: 'OR-10', dept_code: 'SURG-A' }, { room_no: 'OR-10', dept_code: 'SURG-B' }).ok,
      false,
    );
  });
});

describe('test_operation_binding · 原因码与统一错误码同码', () => {
  it('归属冲突原因码映射到 ERR_OPERATION_CONFLICT', () => {
    assert.equal(errorCodeForReason(REASON_OPERATION_ATTRIBUTION_CONFLICT), 'ERR_OPERATION_CONFLICT');
  });
});
