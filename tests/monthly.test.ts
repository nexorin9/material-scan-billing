/**
 * test_monthly：月度对账聚合（科室 × 业务月）与高值耗材月度对账包。
 *
 * 这个文件回答高值耗材管理岗每月要问的四句话：
 *   「这个月这个科室用了多少条？其中多少条计费成功了？多少条被拒了？还挂着多少条待核查？」
 *   以及第五条：「台账 ↔ 计费回执之间有多少条差异？明细在哪？」
 *
 * 覆盖：
 *   ① 账期月份按**业务使用时间**切、按**东八区**算（月末深夜那笔不进下个月）；
 *   ② 跨月分组：3 个月 × 2 科室 → 6 个分组，分组合计与明细逐项相等；
 *   ③ 四档计费状态（成功 / 被拒 / 待重投 / 未提交）归类正确；
 *   ④ 待核查条数取核查条目里仍 pending 的；
 *   ⑤ 对账包 CSV 表头逐字对齐字段白名单，JSON 含汇总 + 明细 + 下钻索引；
 *   ⑥ 导出**不含患者标识字段**；
 *   ⑦ 抽样回查：逐条回台账与回执核对；对不上时能查出来（不静默放过）；
 *   ⑧ 迁移 v26：台账行补业务使用时间列 + 索引，老库升级不丢历史行。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { insertBinding } from '../src/ledger/binding-repo.js';
import {
  CHARGE_RECEIPT_KINDS,
  classifyFailure,
  classifyReceipts,
  failureReceipt,
  recordReceipt,
} from '../src/charge/receipt.js';
import { createCheckTask } from '../src/check/task.js';
import {
  aggregateMonthly,
  isMonthKey,
  monthOf,
  monthlyDetailToCsv,
  monthlyGroupToCsv,
  monthlyPackToJson,
  MONTHLY_CHARGE_STATE,
  MONTHLY_DETAIL_FIELDS,
  MONTHLY_GROUP_FIELDS,
  verifyMonthlySample,
} from '../src/ledger/monthly.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

/** 患者标识字段黑名单：导出里出现任何一个都算不合格 */
const PATIENT_IDENTIFIER_PATTERNS = [
  /patient/i,
  /patient_name/i,
  /姓名/,
  /身份证/,
  /住院号/,
  /门诊号/,
  /就诊号/,
  /病案号/,
];

describe('月度对账 · 月份口径', () => {
  it('月份按东八区算：UTC 月末深夜那笔算进下个月', () => {
    // 2026-01-31T16:30Z = 2026-02-01 00:30（东八区）→ 业务月是 2 月
    assert.equal(monthOf('2026-01-31T16:30:00.000Z'), '2026-02');
    // 2026-01-31T15:59Z = 2026-01-31 23:59（东八区）→ 业务月是 1 月
    assert.equal(monthOf('2026-01-31T15:59:00.000Z'), '2026-01');
    // 东八区跨年边界
    assert.equal(monthOf('2025-12-31T16:00:00.000Z'), '2026-01');
  });

  it('解析不出来的时间戳返回 null（不硬凑月份）', () => {
    assert.equal(monthOf('不是时间'), null);
    assert.equal(monthOf(''), null);
    assert.equal(monthOf(null), null);
    assert.equal(monthOf(undefined), null);
  });

  it('月份串格式校验', () => {
    assert.equal(isMonthKey('2026-01'), true);
    assert.equal(isMonthKey('2026-13'), false);
    assert.equal(isMonthKey('202601'), false);
    assert.equal(isMonthKey('2026-1'), false);
  });
});

describe('月度对账 · 聚合', () => {
  let ledger: LedgerDb;

  beforeEach(() => {
    ledger = openLedger(':memory:');
    importMasterData(ledger.db, { operationsCsv, materialsCsv });
  });

  afterEach(() => {
    ledger.close();
  });

  /** 造一条台账行（业务使用时间可控） */
  function insertRow(options: {
    material_code: string;
    operation_no: string;
    use_time: string | null;
    quantity?: number;
    dept_code?: string;
  }): number {
    return insertBinding(ledger.db, {
      idempotency_key: `key-${options.operation_no}-${options.material_code}-${options.use_time ?? 'na'}`,
      operation_no: options.operation_no,
      room_no: 'OR-01',
      dept_code: options.dept_code ?? 'SURG-CTS',
      material_code: options.material_code,
      quantity: options.quantity ?? 1,
      price_code: 'PR-SAMPLE-01',
      fee_category: '卫生材料',
      medical_insurance_class: '甲类',
      conclusion: 'BOUND',
      status: 'bound',
      raw_code: options.material_code,
      use_time: options.use_time,
    });
  }

  it('按（科室 × 业务月）分组：3 个月 × 2 科室 → 6 个分组，合计与明细相等', () => {
    // 2026-01（东八区）/ 2026-02 / 2026-03 各一条，跨两个科室
    insertRow({ material_code: 'MAT-M1', operation_no: 'OP-SAMPLE-001', use_time: '2026-01-10T02:00:00.000Z' });
    insertRow({ material_code: 'MAT-M2', operation_no: 'OP-SAMPLE-001', use_time: '2026-02-10T02:00:00.000Z' });
    insertRow({ material_code: 'MAT-M3', operation_no: 'OP-SAMPLE-001', use_time: '2026-03-10T02:00:00.000Z' });
    insertRow({
      material_code: 'MAT-M4',
      operation_no: 'OP-SAMPLE-001',
      use_time: '2026-01-11T02:00:00.000Z',
      dept_code: 'SURG-CVS',
    });
    insertRow({
      material_code: 'MAT-M5',
      operation_no: 'OP-SAMPLE-001',
      use_time: '2026-02-11T02:00:00.000Z',
      dept_code: 'SURG-CVS',
    });
    insertRow({
      material_code: 'MAT-M6',
      operation_no: 'OP-SAMPLE-001',
      use_time: '2026-03-11T02:00:00.000Z',
      dept_code: 'SURG-CVS',
    });

    const report = aggregateMonthly(ledger.db);
    assert.equal(report.groups.length, 6, '3 个月 × 2 科室 = 6 个分组');
    assert.equal(report.totals.months, 3);
    assert.equal(report.totals.depts, 2);
    assert.equal(report.totals.usage_count, 6);
    assert.equal(report.details.length, 6);
    assert.equal(
      report.groups.reduce((sum, group) => sum + group.usage_count, 0),
      report.details.length,
      '分组合计 = 明细条数',
    );
    // 分组按（月份, 科室）排序
    assert.deepEqual(
      report.groups.map((group) => `${group.month}|${group.dept_code}`),
      [
        '2026-01|SURG-CTS',
        '2026-01|SURG-CVS',
        '2026-02|SURG-CTS',
        '2026-02|SURG-CVS',
        '2026-03|SURG-CTS',
        '2026-03|SURG-CVS',
      ],
    );
  });

  it('账期圈定：from/to 之外的月份不进包', () => {
    insertRow({ material_code: 'MAT-M1', operation_no: 'OP-SAMPLE-001', use_time: '2026-01-10T02:00:00.000Z' });
    insertRow({ material_code: 'MAT-M2', operation_no: 'OP-SAMPLE-001', use_time: '2026-02-10T02:00:00.000Z' });
    insertRow({ material_code: 'MAT-M3', operation_no: 'OP-SAMPLE-001', use_time: '2026-03-10T02:00:00.000Z' });

    const report = aggregateMonthly(ledger.db, { from_month: '2026-02', to_month: '2026-03' });
    assert.equal(report.totals.usage_count, 2);
    assert.deepEqual(
      report.groups.map((group) => group.month).sort(),
      ['2026-02', '2026-03'],
    );
    assert.equal(report.scope.from_month, '2026-02');
    assert.equal(report.scope.to_month, '2026-03');
  });

  it('业务使用时间缺失时退回落账时间（老行不丢）', () => {
    insertRow({ material_code: 'MAT-M1', operation_no: 'OP-SAMPLE-001', use_time: null });
    const report = aggregateMonthly(ledger.db);
    assert.equal(report.totals.usage_count, 1);
    assert.equal(report.details[0]?.month, monthOf(report.details[0]?.created_at ?? null));
  });

  it('四档计费状态归类正确（成功 / 被拒 / 待重投 / 未提交）', () => {
    insertRow({ material_code: 'MAT-M1', operation_no: 'OP-SAMPLE-001', use_time: '2026-01-10T02:00:00.000Z' });
    insertRow({ material_code: 'MAT-M2', operation_no: 'OP-SAMPLE-001', use_time: '2026-01-10T02:00:00.000Z' });
    insertRow({ material_code: 'MAT-M3', operation_no: 'OP-SAMPLE-001', use_time: '2026-01-10T02:00:00.000Z' });
    insertRow({ material_code: 'MAT-M4', operation_no: 'OP-SAMPLE-001', use_time: '2026-01-10T02:00:00.000Z' });

    // ① 对端接收
    const accepted = classifyReceipts({
      response: { accepted: [{ material_code: 'MAT-M1' }], rejected: [] },
      submitted: [
        {
          material_code: 'MAT-M1',
          quantity: 1,
          price_code: 'PR-SAMPLE-01',
          use_time: '2026-01-10T02:00:00.000Z',
          fee_category: '卫生材料',
          medical_insurance_class: '甲类',
        },
      ],
      operation_no: 'OP-SAMPLE-001',
      attempt: 1,
      delivery_count: 1,
    });
    recordReceipt(ledger.db, accepted[0]!);

    // ② 业务拒收
    const rejected = classifyReceipts({
      response: { accepted: [], rejected: [{ material_code: 'MAT-M2', reason_code: 'PRICE_CODE_NOT_FOUND' }] },
      submitted: [
        {
          material_code: 'MAT-M2',
          quantity: 1,
          price_code: 'PR-SAMPLE-01',
          use_time: '2026-01-10T02:00:00.000Z',
          fee_category: '卫生材料',
          medical_insurance_class: '甲类',
        },
      ],
      operation_no: 'OP-SAMPLE-001',
      attempt: 1,
      delivery_count: 1,
    });
    recordReceipt(ledger.db, rejected[0]!);

    // ③ 通道不可达（超时）
    const failure = classifyFailure(
      Object.assign(new Error('timeout'), { kind: 'timeout', code: 'ERR_CHARGE_TIMEOUT' }),
    );
    const timeout = failureReceipt({
      material_code: 'MAT-M3',
      operation_no: 'OP-SAMPLE-001',
      attempt: 1,
      delivery_count: 1,
      failure: { ...failure, kind: CHARGE_RECEIPT_KINDS.channel_unreachable },
      submitted_quantity: 1,
      submitted_price_code: 'PR-SAMPLE-01',
      submitted_fee_category: '卫生材料',
      submitted_medical_insurance_class: '甲类',
    });
    recordReceipt(ledger.db, timeout);

    // ④ MAT-M4 没有任何回执 → 未提交

    const report = aggregateMonthly(ledger.db);
    const byCode = new Map(report.details.map((detail) => [detail.material_code, detail]));
    assert.equal(byCode.get('MAT-M1')?.charge_state, MONTHLY_CHARGE_STATE.accepted);
    assert.equal(byCode.get('MAT-M2')?.charge_state, MONTHLY_CHARGE_STATE.rejected);
    assert.equal(byCode.get('MAT-M3')?.charge_state, MONTHLY_CHARGE_STATE.pending_retry);
    assert.equal(byCode.get('MAT-M4')?.charge_state, MONTHLY_CHARGE_STATE.not_submitted);

    const group = report.groups[0]!;
    assert.equal(group.charge_success, 1);
    assert.equal(group.charge_rejected, 1);
    assert.equal(group.charge_pending_retry, 1);
    assert.equal(group.charge_not_submitted, 1);
  });

  it('待核查条数只算仍 pending 的核查条目', () => {
    const id = insertRow({
      material_code: 'MAT-M1',
      operation_no: 'OP-SAMPLE-001',
      use_time: '2026-01-10T02:00:00.000Z',
    });
    createCheckTask(ledger.db, {
      binding_id: id,
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      dept_code: 'SURG-CTS',
      scanner_id: 'SCAN-GUN-07',
      material_code: 'MAT-M1',
      quantity: 1,
      conclusion: 'NOT_REGISTERED',
      reason_code: 'MATERIAL_NOT_REGISTERED',
    });

    const report = aggregateMonthly(ledger.db);
    assert.equal(report.totals.pending_check, 1);
    assert.equal(report.details[0]?.check_status, 'pending');
    assert.equal(report.details[0]?.reason_code, 'MATERIAL_NOT_REGISTERED');
  });
});

describe('月度对账 · 对账包', () => {
  let ledger: LedgerDb;

  beforeEach(() => {
    ledger = openLedger(':memory:');
    importMasterData(ledger.db, { operationsCsv, materialsCsv });
    insertBinding(ledger.db, {
      idempotency_key: 'pack-key-1',
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      dept_code: 'SURG-CTS',
      material_code: 'MAT-PACK-01',
      quantity: 2,
      price_code: 'PR-SAMPLE-01',
      fee_category: '卫生材料',
      medical_insurance_class: '甲类',
      conclusion: 'BOUND',
      status: 'bound',
      raw_code: 'MAT-PACK-01',
      use_time: '2026-01-10T02:00:00.000Z',
    });
  });

  afterEach(() => {
    ledger.close();
  });

  it('汇总表与明细表 CSV 表头逐字对齐字段白名单', () => {
    const report = aggregateMonthly(ledger.db);
    const summaryHeader = monthlyGroupToCsv(report.groups).split('\n')[0];
    const detailHeader = monthlyDetailToCsv(report.details).split('\n')[0];
    assert.equal(summaryHeader, MONTHLY_GROUP_FIELDS.join(','));
    assert.equal(detailHeader, MONTHLY_DETAIL_FIELDS.join(','));
  });

  it('对账包 JSON 含汇总 + 明细 + 下钻索引（台次 / 耗材码）', () => {
    const report = aggregateMonthly(ledger.db);
    const pack = JSON.parse(monthlyPackToJson(report)) as {
      groups: Array<Record<string, unknown>>;
      details: Array<Record<string, unknown>>;
      index: {
        by_operation: Record<string, number>;
        by_material: Record<string, number>;
        operation_detail_index: Record<string, string[]>;
        material_detail_index: Record<string, string[]>;
      };
    };
    assert.equal(pack.groups.length, 1);
    assert.equal(pack.details.length, 1);
    assert.equal(pack.index.by_operation['OP-SAMPLE-001'], 1);
    assert.equal(pack.index.by_material['MAT-PACK-01'], 1);
    assert.deepEqual(pack.index.operation_detail_index['OP-SAMPLE-001'], ['OP-SAMPLE-001::MAT-PACK-01']);
    assert.deepEqual(pack.index.material_detail_index['MAT-PACK-01'], ['OP-SAMPLE-001::MAT-PACK-01']);
  });

  it('导出不含患者标识字段', () => {
    const report = aggregateMonthly(ledger.db);
    const payloads = [monthlyGroupToCsv(report.groups), monthlyDetailToCsv(report.details), monthlyPackToJson(report)];
    for (const payload of payloads) {
      for (const pattern of PATIENT_IDENTIFIER_PATTERNS) {
        assert.equal(pattern.test(payload), false, `导出里不应出现 ${pattern}`);
      }
    }
  });

  it('抽样回查：逐条回台账与回执核对，全部一致', () => {
    const report = aggregateMonthly(ledger.db);
    const sample = verifyMonthlySample(ledger.db, report, 20, 20260101);
    assert.equal(sample.sampled, 1, '明细只有 1 条，抽样上限按实际条数');
    assert.equal(sample.mismatched, 0);
    assert.equal(sample.all_matched, true);
    assert.equal(sample.rows[0]?.pack_conclusion, 'BOUND');
    assert.equal(sample.rows[0]?.ledger_conclusion, 'BOUND');
  });

  it('抽样回查能查出对不上的明细（不静默放过）', () => {
    const report = aggregateMonthly(ledger.db);
    // 绕过护栏直接改台账结论 —— 回查必须发现
    ledger.db
      .prepare("UPDATE material_binding SET conclusion = 'CLOSED' WHERE material_code = 'MAT-PACK-01'")
      .run();
    const sample = verifyMonthlySample(ledger.db, report, 20, 20260101);
    assert.equal(sample.mismatched, 1);
    assert.equal(sample.all_matched, false);
    assert.match(sample.rows[0]?.mismatch_reason ?? '', /结论不一致/);
  });
});

describe('月度对账 · 迁移 v26', () => {
  it('台账行补业务使用时间列 + 索引，老库升级不丢历史行', () => {
    const ledger = openLedger(':memory:');
    const columns = ledger.db
      .prepare("SELECT name FROM pragma_table_info('material_binding')")
      .all() as unknown as Array<{ name: string }>;
    assert.ok(
      columns.some((column) => column.name === 'use_time'),
      'material_binding 应有 use_time 列',
    );
    const indexes = ledger.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='material_binding'")
      .all() as unknown as Array<{ name: string }>;
    assert.ok(
      indexes.some((index) => index.name === 'ix_material_binding_dept_use_time'),
      '应有（科室 × 业务时间）索引',
    );

    importMasterData(ledger.db, { operationsCsv, materialsCsv });
    const before = ledger.db.prepare('SELECT COUNT(*) AS n FROM material_binding').get() as { n: number };
    const after = ledger.db.prepare('SELECT COUNT(*) AS n FROM material_binding').get() as { n: number };
    assert.equal(after.n, before.n, '升级不丢历史行');
    ledger.close();
  });
});
