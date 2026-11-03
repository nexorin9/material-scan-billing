/**
 * test_reconcile：台账 ↔ 计费回执逐条对账（三类差异归因 + 差异台账 + 核查任务挂接）。
 *
 * 这个文件回答关台核对时最要紧的一句话：**哪些耗材没有生成计费**。
 *
 * 覆盖：
 *   ① 三类差异各 2 条：分类正确、归因正确（未提交 / 超时待重投 / 业务拒绝 /
 *      对端多出来一条 / 字段口径不一致）；
 *   ② 字段级差异定位到**具体字段名**并给出两侧取值；
 *   ③ 差异台账落库与自动闭环（差异消失后不再留「永远待处理」的僵尸行）；
 *   ④ 差异 ↔ 核查任务双向挂接（差异可直接生成核查任务）；
 *   ⑤ 导出字段白名单断言**不含患者标识字段**；
 *   ⑥ 人工处置（已处理）与重复处置被拒。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { bindOne } from '../src/engine/binding.js';
import {
  CHARGE_RECEIPT_KINDS,
  classifyReceipts,
  countReceipts,
  failureReceipt,
  recordReceipt,
} from '../src/charge/receipt.js';
import { classifyFailure, type ChargeFailureClass } from '../src/charge/receipt.js';
import {
  countCheckTasks,
  findCheckTask,
} from '../src/check/task.js';
import {
  countPendingDiffs,
  createCheckTaskFromDiff,
  deriveDiffKey,
  diffsToCsv,
  diffsToJson,
  findDiff,
  listDiffs,
  RECONCILE_ATTRIBUTIONS,
  RECONCILE_DIFF_TYPES,
  RECONCILE_EXPORT_FIELDS,
  reconcileLedgerVsReceipts,
  resolveDiff,
} from '../src/ledger/reconcile.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

/** 患者标识字段黑名单：导出里出现任何一个都算不合格 */
const PATIENT_IDENTIFIER_PATTERNS = [
  /patient/i,
  /患者/,
  /姓名/,
  /身份证/,
  /住院号/,
  /就诊号/,
  /病案号/,
];

let ledger: LedgerDb;

beforeEach(() => {
  ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
});

afterEach(() => {
  ledger.close();
});

/** 造一条已绑定（status = bound）的台账行 */
function bindMaterial(
  material_code: string,
  operation_no = 'OP-SAMPLE-001',
  quantity = 1,
): void {
  // 事件手术间取**台次自己的**手术间 —— 归属双因子核对会核对
  // 「事件说的手术间」与「排台说的手术间」，两者必须一致（不一致就判归属冲突）。
  const operation = ledger.db
    .prepare('SELECT room_no FROM operation WHERE operation_no = ?')
    .get(operation_no) as { room_no: string } | undefined;
  assert.ok(operation, `前置条件：台次 ${operation_no} 应在排台主数据里`);
  const outcome = bindOne(ledger.db, {
    db: ledger.db,
    operation_no,
    room_no: operation.room_no,
    scanner_id: 'SCAN-GUN-07',
    material_code,
    raw_code: material_code,
    quantity,
  });
  assert.equal(outcome.bound, true, `前置条件：${material_code} 应绑上台次`);
}

/** 造一条「对端接收」的回执行（带载荷快照） */
function acceptedReceipt(
  material_code: string,
  operation_no = 'OP-SAMPLE-001',
  overrides: {
    quantity?: number;
    price_code?: string;
    fee_category?: string;
    medical_insurance_class?: string;
  } = {},
): void {
  const use = {
    material_code,
    quantity: overrides.quantity ?? 1,
    price_code: overrides.price_code ?? 'PR-SAMPLE-01',
    use_time: '2026-01-15T09:12:00.000Z',
    fee_category: overrides.fee_category ?? '卫生材料',
    medical_insurance_class: overrides.medical_insurance_class ?? '甲类',
  };
  const receipts = classifyReceipts({
    response: { accepted: [{ material_code }], rejected: [] },
    submitted: [use],
    operation_no,
    attempt: 1,
    delivery_count: 1,
  });
  recordReceipt(ledger.db, receipts[0]!);
}

/** 造一条「业务拒绝」的回执行 */
function rejectedReceipt(material_code: string, operation_no = 'OP-SAMPLE-001'): void {
  const receipts = classifyReceipts({
    response: { accepted: [], rejected: [{ material_code, reason_code: 'PRICE_CODE_NOT_FOUND' }] },
    submitted: [
      {
        material_code,
        quantity: 1,
        price_code: 'PR-SAMPLE-01',
        use_time: '2026-01-15T09:12:00.000Z',
        fee_category: '卫生材料',
        medical_insurance_class: '甲类',
      },
    ],
    operation_no,
    attempt: 1,
    delivery_count: 1,
  });
  recordReceipt(ledger.db, receipts[0]!);
}

/** 造一条「通道不可达（超时）」的回执行 */
function timeoutReceipt(material_code: string, operation_no = 'OP-SAMPLE-001'): void {
  const failure: ChargeFailureClass = classifyFailure(
    Object.assign(new Error('timeout'), { kind: 'timeout', code: 'ERR_CHARGE_TIMEOUT' }),
  );
  const receipt = failureReceipt({
    material_code,
    operation_no,
    attempt: 1,
    delivery_count: 1,
    failure: { ...failure, kind: CHARGE_RECEIPT_KINDS.channel_unreachable },
    submitted_quantity: 1,
    submitted_price_code: 'PR-SAMPLE-01',
    submitted_fee_category: '卫生材料',
    submitted_medical_insurance_class: '甲类',
  });
  recordReceipt(ledger.db, receipt);
}

describe('test_reconcile · 三类差异分类与归因', () => {
  it('① 台账有、回执无：三条分别归因为未提交 / 超时待重投 / 业务拒绝', () => {
    // 从未提交计费
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    // 提交了但通道超时（可重投）
    bindMaterial('MAT-SAMPLE-02', 'OP-SAMPLE-001');
    timeoutReceipt('MAT-SAMPLE-02');
    // 提交了但对端业务拒绝（不可重投）
    bindMaterial('MAT-SAMPLE-03', 'OP-SAMPLE-001');
    rejectedReceipt('MAT-SAMPLE-03');

    const report = reconcileLedgerVsReceipts(ledger.db);
    const missing = report.diffs.filter(
      (row) => row.diff_type === RECONCILE_DIFF_TYPES.missing_receipt,
    );
    assert.equal(missing.length, 3, '三条台账条目都该被标成「台账有、回执无」');

    const byMaterial = new Map(missing.map((row) => [row.material_code, row]));
    assert.equal(
      byMaterial.get('MAT-SAMPLE-01')?.attribution,
      RECONCILE_ATTRIBUTIONS.not_submitted,
      '没有回执的条目应归因为「未提交」',
    );
    assert.equal(
      byMaterial.get('MAT-SAMPLE-02')?.attribution,
      RECONCILE_ATTRIBUTIONS.charge_timeout_pending_retry,
      '通道不可达的条目应归因为「计费超时待重投」',
    );
    assert.equal(
      byMaterial.get('MAT-SAMPLE-03')?.attribution,
      RECONCILE_ATTRIBUTIONS.charge_business_rejected,
      '对端业务拒绝的条目应归因为「计费业务拒绝」',
    );

    // 归因带统一错误码（与日志、核查条目同一个码）
    assert.equal(byMaterial.get('MAT-SAMPLE-01')?.error_code, 'ERR_RECONCILE_NOT_SUBMITTED');
    assert.equal(
      byMaterial.get('MAT-SAMPLE-03')?.error_code,
      'ERR_RECONCILE_MISSING_RECEIPT',
    );
    // 建议处置是给科室看的一句话，不是空话
    for (const row of missing) {
      assert.ok(row.suggested_action.length > 0, '每条差异都要有建议处置');
    }
    // 台次上下文齐全
    assert.equal(byMaterial.get('MAT-SAMPLE-01')?.operation_no, 'OP-SAMPLE-001');
    assert.equal(byMaterial.get('MAT-SAMPLE-01')?.room_no, 'OR-01');
    assert.equal(byMaterial.get('MAT-SAMPLE-01')?.dept_code, 'SURG-01');
  });

  it('② 回执有、台账无：计费侧出现两条台账里没有的条目', () => {
    // 这两条在计费侧有成功回执，但台账里没有对应条目
    acceptedReceipt('MAT-SAMPLE-04', 'OP-SAMPLE-002');
    acceptedReceipt('MAT-SAMPLE-05', 'OP-SAMPLE-002');

    const report = reconcileLedgerVsReceipts(ledger.db);
    const unknown = report.diffs.filter(
      (row) => row.diff_type === RECONCILE_DIFF_TYPES.unknown_receipt,
    );
    assert.equal(unknown.length, 2);
    for (const row of unknown) {
      assert.equal(row.attribution, RECONCILE_ATTRIBUTIONS.unexpected_charge);
      assert.equal(row.error_code, 'ERR_RECONCILE_UNEXPECTED_CHARGE');
      assert.equal(row.operation_no, 'OP-SAMPLE-002');
      assert.ok(row.suggested_action.includes('冲正'), '建议处置要说明人工冲正，系统不自动冲正');
    }
    assert.equal(report.by_type.UNKNOWN_RECEIPT, 2);
  });

  it('③ 两边都有但字段口径不一致：定位到具体字段名与两侧取值', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001', 1);
    // 台账数量 1 / 价码 PR-SAMPLE-01；计费侧实际收到的是数量 3、价码 PR-OTHER
    acceptedReceipt('MAT-SAMPLE-01', 'OP-SAMPLE-001', {
      quantity: 3,
      price_code: 'PR-OTHER',
    });

    const report = reconcileLedgerVsReceipts(ledger.db);
    const mismatches = report.diffs.filter(
      (row) => row.diff_type === RECONCILE_DIFF_TYPES.field_mismatch,
    );
    assert.equal(mismatches.length, 1);
    const diff = mismatches[0]!;
    assert.equal(diff.attribution, RECONCILE_ATTRIBUTIONS.field_mismatch);
    assert.equal(diff.error_code, 'ERR_RECONCILE_FIELD_MISMATCH');

    const fields = JSON.parse(diff.mismatched_fields ?? '[]') as Array<{
      field: string;
      ledger_value: unknown;
      receipt_value: unknown;
    }>;
    const names = fields.map((item) => item.field).sort();
    assert.deepEqual(names, ['price_code', 'quantity'], '只应报出真正不一致的两个字段');
    const quantity = fields.find((item) => item.field === 'quantity')!;
    assert.equal(quantity.ledger_value, 1);
    assert.equal(quantity.receipt_value, 3);
    const priceCode = fields.find((item) => item.field === 'price_code')!;
    assert.equal(priceCode.ledger_value, 'PR-SAMPLE-01');
    assert.equal(priceCode.receipt_value, 'PR-OTHER');
  });

  it('④ 字段一致时不报差异（对上了就是没有差异）', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001', 1);
    acceptedReceipt('MAT-SAMPLE-01', 'OP-SAMPLE-001', {
      quantity: 1,
      price_code: 'PR-SAMPLE-01',
      fee_category: '卫生材料',
      medical_insurance_class: '甲类',
    });

    const report = reconcileLedgerVsReceipts(ledger.db);
    assert.equal(report.diffs.length, 0);
    assert.equal(report.by_type.FIELD_MISMATCH, 0);
    assert.equal(report.by_type.MISSING_RECEIPT, 0);
  });
});

describe('test_reconcile · 差异台账落库与闭环', () => {
  it('① 差异落进差异台账；同一条差异反复对账只留一行', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    bindMaterial('MAT-SAMPLE-02', 'OP-SAMPLE-001');
    timeoutReceipt('MAT-SAMPLE-02');

    const first = reconcileLedgerVsReceipts(ledger.db);
    assert.equal(first.diffs.length, 2);
    assert.equal(first.new_diffs, 2);

    const second = reconcileLedgerVsReceipts(ledger.db);
    assert.equal(second.diffs.length, 2, '重复对账不新增差异行');
    assert.equal(second.new_diffs, 0, '重复对账没有新差异');
    assert.equal(countPendingDiffs(ledger.db), 2, '待处理差异仍是 2 条');

    // 差异键与时间戳无关：同一把键算出来一样
    const key = deriveDiffKey(RECONCILE_DIFF_TYPES.missing_receipt, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
    const stored = listDiffs(ledger.db).find((row) => row.material_code === 'MAT-SAMPLE-01');
    assert.equal(stored?.diff_key, key);
  });

  it('② 差异消失后自动闭环：不再留「永远待处理」的僵尸行', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    const first = reconcileLedgerVsReceipts(ledger.db);
    assert.equal(first.diffs.length, 1);
    assert.equal(first.pending_total, 1);

    // 补上成功回执：差异应当消失
    acceptedReceipt('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    const second = reconcileLedgerVsReceipts(ledger.db);
    assert.equal(second.diffs.length, 0);
    assert.equal(second.auto_resolved, 1);
    assert.equal(second.pending_total, 0);

    const row = listDiffs(ledger.db)[0]!;
    assert.equal(row.status, 'resolved');
    assert.equal(row.resolved_by, 'auto_reconcile');
  });

  it('③ 人工处置：标已处理；重复处置被拒', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    reconcileLedgerVsReceipts(ledger.db);
    const diff = listDiffs(ledger.db)[0]!;

    const resolved = resolveDiff(ledger.db, diff.id, '护士长张三');
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolved_by, '护士长张三');
    assert.ok(resolved.resolved_at);

    assert.throws(
      () => resolveDiff(ledger.db, diff.id, '护士长李四'),
      /已由/,
      '重复处置要被拒绝',
    );
  });
});

describe('test_reconcile · 与核查任务双向挂接', () => {
  it('① 差异可直接生成核查任务，两边互相可查', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    const before = countCheckTasks(ledger.db);
    reconcileLedgerVsReceipts(ledger.db);
    const diff = listDiffs(ledger.db)[0]!;

    const result = createCheckTaskFromDiff(ledger.db, diff.id, 'reconcile');
    assert.equal(result.reused, false);
    assert.equal(countCheckTasks(ledger.db), before + 1, '核查条目数 +1');

    // 双向挂接：差异 → 核查条目，核查条目 → 差异
    const updated = findDiff(ledger.db, diff.id)!;
    assert.equal(updated.check_task_id, result.task_id);
    const task = findCheckTask(ledger.db, result.task_id)!;
    assert.equal(task.reconcile_diff_id, diff.id);
    // 核查条目带台次上下文
    assert.equal(task.operation_no, 'OP-SAMPLE-001');
    assert.equal(task.room_no, 'OR-01');
    assert.equal(task.material_code, 'MAT-SAMPLE-01');
  });

  it('② 同一条差异重复转核查任务不刷重复待办', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    reconcileLedgerVsReceipts(ledger.db);
    const diff = listDiffs(ledger.db)[0]!;

    const first = createCheckTaskFromDiff(ledger.db, diff.id);
    const second = createCheckTaskFromDiff(ledger.db, diff.id);
    assert.equal(second.reused, true);
    assert.equal(second.task_id, first.task_id);
    assert.equal(countCheckTasks(ledger.db), 1);
  });

  it('③ 差异不存在的 id 转核查任务时报错（带错误码）', () => {
    assert.throws(() => createCheckTaskFromDiff(ledger.db, 9999), /不存在/);
  });
});

describe('test_reconcile · 导出与脱敏', () => {
  it('① 导出字段白名单不含任何患者标识字段', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    bindMaterial('MAT-SAMPLE-02', 'OP-SAMPLE-001');
    rejectedReceipt('MAT-SAMPLE-02');
    acceptedReceipt('MAT-SAMPLE-04', 'OP-SAMPLE-002');
    const report = reconcileLedgerVsReceipts(ledger.db);

    const csv = diffsToCsv(report.diffs);
    const header = csv.split('\n')[0]!;
    assert.equal(header, RECONCILE_EXPORT_FIELDS.join(','), 'CSV 表头与白名单逐字一致');

    for (const pattern of PATIENT_IDENTIFIER_PATTERNS) {
      assert.ok(!header.match(pattern), `导出字段里出现了患者标识：${pattern}`);
    }
    // 取值也不含患者标识
    for (const line of csv.split('\n').slice(1)) {
      for (const pattern of PATIENT_IDENTIFIER_PATTERNS) {
        assert.ok(!line.match(pattern), `导出行里出现了患者标识：${pattern}`);
      }
    }

    const json = diffsToJson(report.diffs);
    for (const pattern of PATIENT_IDENTIFIER_PATTERNS) {
      assert.ok(!json.match(pattern), `JSON 导出里出现了患者标识：${pattern}`);
    }
    const parsed = JSON.parse(json) as { rows: unknown[]; fields: string[] };
    assert.equal(parsed.rows.length, report.diffs.length);
    assert.deepEqual(parsed.fields, [...RECONCILE_EXPORT_FIELDS]);
  });

  it('② 导出带台次上下文与建议处置（科室能直接看懂这一行）', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    reconcileLedgerVsReceipts(ledger.db);
    const csv = diffsToCsv(listDiffs(ledger.db));
    assert.ok(csv.includes('OP-SAMPLE-001'));
    assert.ok(csv.includes('MAT-SAMPLE-01'));
    assert.ok(csv.includes('NOT_SUBMITTED'));
    assert.ok(csv.includes('MISSING_RECEIPT'));
  });
});

describe('test_reconcile · 只读盘点与回执行守恒', () => {
  it('① 只读盘点（dry run）不落差异台账', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    const report = reconcileLedgerVsReceipts(ledger.db, { persist: false });
    assert.equal(report.diffs.length, 1);
    assert.equal(countPendingDiffs(ledger.db), 0, 'dry run 不写差异台账');
    assert.equal(listDiffs(ledger.db).length, 0);
  });

  it('② 对账只读台账与回执：回执行条数与台账行数都不变', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    acceptedReceipt('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    const receiptsBefore = countReceipts(ledger.db);
    const bindingsBefore = (
      ledger.db.prepare('SELECT COUNT(*) AS n FROM material_binding').get() as { n: number }
    ).n;

    reconcileLedgerVsReceipts(ledger.db);

    assert.equal(countReceipts(ledger.db), receiptsBefore);
    assert.equal(
      (ledger.db.prepare('SELECT COUNT(*) AS n FROM material_binding').get() as { n: number }).n,
      bindingsBefore,
    );
  });

  it('③ 按台次对账：只出该台次的差异', () => {
    bindMaterial('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    bindMaterial('MAT-SAMPLE-02', 'OP-SAMPLE-002');
    const report = reconcileLedgerVsReceipts(ledger.db, { operation_no: 'OP-SAMPLE-001' });
    assert.equal(report.diffs.length, 1);
    assert.equal(report.diffs[0]?.operation_no, 'OP-SAMPLE-001');
    assert.equal(report.scope.operation_no, 'OP-SAMPLE-001');
  });
});
