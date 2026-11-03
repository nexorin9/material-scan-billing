/**
 * test_closing_report：关台核对清单导出（按台次聚合未闭环条目）。
 *
 * 护士长在关台那一刻要的是**一份能签字的清单**：
 *   这一台扫了哪些耗材、哪些绑上了、哪些已经生成计费、哪些还挂在核查待办里。
 *
 * 覆盖：
 *   ① 含 2 条待核查的台次 → 标注「待核查 2 条」并逐条列出这 2 条；
 *   ② 全闭环台次 → 标注「可关台」；
 *   ③ 绑定成功但没生成计费的条目 → 标注「待计费 N 条」（没人跟的静默缺口）；
 *   ④ **一条不漏** —— 被拒绝的耗材（没有台账行）也在清单里；
 *   ⑤ CSV / JSON 两种导出：表头逐字等于白名单，内容不含患者标识字段；
 *   ⑥ 批量导出：按日期范围 / 按台次列表；
 *   ⑦ 终端可读版本：每台次一段，含耗材条数、待核查数与待核查条目清单；
 *   ⑧ 只读不改：导出前后台账 / 核查 / 回执行数一条不少一条不多。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { bindOne } from '../src/engine/binding.js';
import { classifyReceipts, recordReceipt } from '../src/charge/receipt.js';
import {
  buildClosingChecklist,
  closingChecklistToCsv,
  closingChecklistToJson,
  closingSummaryLabel,
  CLOSING_EXPORT_FIELDS,
  CLOSING_LABEL_CAN_CLOSE,
  CLOSING_LABEL_NO_ITEMS,
  ClosingReportError,
  ERR_CLOSING_INVALID_RANGE,
  renderClosingChecklist,
  type ClosingOperation,
} from '../src/check/closing-report.js';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

/**
 * 排台台次（测试自带的 4 个台次）。
 *
 * fixture 里的 3 个台次不够用：关台核对至少要「全闭环」「待核查」「待计费」
 * 「一条没扫」四种台次各一个，所以这里在 fixture 基础上补一个开台 OP-SAMPLE-004。
 */
const operationsCsv = [
  'operation_no,room_no,dept_code,status,closed_at',
  'OP-SAMPLE-001,OR-01,SURG-01,open,',
  'OP-SAMPLE-002,OR-02,SURG-01,open,',
  'OP-SAMPLE-003,OR-03,SURG-02,closed,2026-01-15T09:30:00+08:00',
  'OP-SAMPLE-004,OR-04,SURG-03,open,',
  '',
].join('\n');

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

/** 绑一条耗材到台次（扫一次） */
function bindMaterial(
  db: DatabaseSync,
  material_code: string,
  operation_no: string,
  quantity = 1,
): void {
  const operation = db
    .prepare('SELECT room_no FROM operation WHERE operation_no = ?')
    .get(operation_no) as { room_no: string } | undefined;
  assert.ok(operation, `前置条件：台次 ${operation_no} 应在排台主数据里`);
  const outcome = bindOne(db, {
    db,
    operation_no,
    room_no: operation.room_no,
    scanner_id: 'SCAN-GUN-07',
    material_code,
    raw_code: material_code,
    quantity,
  });
  // 未建档的耗材本来就绑不上（这正是被测场景），其余必须绑上
  if (material_code.startsWith('MAT-SAMPLE')) {
    assert.equal(outcome.bound, true, `前置条件：${material_code} 应绑上台次 ${operation_no}`);
  }
}

/** 造一条「对端接收」的回执行（这条耗材已生成计费） */
function acceptCharge(db: DatabaseSync, material_code: string, operation_no: string): void {
  const receipts = classifyReceipts({
    response: { accepted: [{ material_code }], rejected: [] },
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
  recordReceipt(db, receipts[0]!);
}

/** 造一个场景：四个台次各一种状态 */
function seedClosingScenario(): void {
  const db = ledger.db;
  // OP-SAMPLE-001：一条已计费 + 两条被拒绝（未建档）→ 待核查 2 条
  bindMaterial(db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
  acceptCharge(db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
  bindMaterial(db, 'MAT-UNKNOWN-01', 'OP-SAMPLE-001');
  bindMaterial(db, 'MAT-UNKNOWN-02', 'OP-SAMPLE-001');

  // OP-SAMPLE-002：三条全部绑上并已计费 → 可关台
  // （同一耗材码不跨台次重复使用 —— 跨台次扫码会被判 CROSS_OP_DUP，
  //   所以每个台次用各自的耗材码）
  bindMaterial(db, 'MAT-SAMPLE-02', 'OP-SAMPLE-002');
  bindMaterial(db, 'MAT-SAMPLE-03', 'OP-SAMPLE-002');
  bindMaterial(db, 'MAT-SAMPLE-04', 'OP-SAMPLE-002');
  acceptCharge(db, 'MAT-SAMPLE-02', 'OP-SAMPLE-002');
  acceptCharge(db, 'MAT-SAMPLE-03', 'OP-SAMPLE-002');
  acceptCharge(db, 'MAT-SAMPLE-04', 'OP-SAMPLE-002');

  // OP-SAMPLE-003：一条都没扫（台次已关台）→ 无扫码记录

  // OP-SAMPLE-004：绑上了但没生成计费 → 待计费 1 条
  bindMaterial(db, 'MAT-SAMPLE-05', 'OP-SAMPLE-004');
}

/** 取某个台次的关台结论 */
function closingOf(operation_no: string): ClosingOperation {
  const report = buildClosingChecklist(ledger.db, { operation_no });
  const operation = report.operations.find((item) => item.operation_no === operation_no);
  assert.ok(operation, `清单里应出现台次 ${operation_no}`);
  return operation;
}

describe('关台核对清单', () => {
  it('关台汇总：含 2 条待核查的台次标注「待核查 2 条」，且清单列出这 2 条', () => {
    seedClosingScenario();

    const operation = closingOf('OP-SAMPLE-001');

    assert.equal(operation.summary_label, '待核查 2 条');
    assert.equal(operation.pending_check_count, 2);
    assert.equal(operation.can_close, false);
    assert.equal(operation.pending_items.length, 2);
    assert.deepEqual(
      operation.pending_items.map((item) => item.material_code).sort(),
      ['MAT-UNKNOWN-01', 'MAT-UNKNOWN-02'],
    );
    // 待核查条目带台次上下文与原因码，护士长照着就能找到人
    for (const item of operation.pending_items) {
      assert.equal(item.conclusion, 'NOT_REGISTERED');
      assert.equal(item.reason_code, 'MATERIAL_NOT_REGISTERED');
      assert.ok(item.error_code && item.error_code.length > 0, '待核查条目应带统一错误码');
      assert.ok(item.assignee_role && item.assignee_role.length > 0, '待核查条目应带责任岗位');
      assert.ok(item.check_task_id !== null, '待核查条目应挂到核查条目上');
    }
    // 本台 3 条耗材（1 条绑上 + 2 条被拒绝）一条都不少
    assert.equal(operation.item_count, 3);
    assert.equal(operation.bound_count, 1);
    assert.equal(operation.charged_count, 1);
  });

  it('关台汇总：全闭环台次标注「可关台」', () => {
    seedClosingScenario();

    const operation = closingOf('OP-SAMPLE-002');

    assert.equal(operation.summary_label, CLOSING_LABEL_CAN_CLOSE);
    assert.equal(operation.can_close, true);
    assert.equal(operation.item_count, 3);
    assert.equal(operation.bound_count, 3);
    assert.equal(operation.charged_count, 3);
    assert.equal(operation.pending_check_count, 0);
    assert.equal(operation.pending_charge_count, 0);
    assert.equal(operation.pending_items.length, 0);
  });

  it('关台汇总：绑定成功但没生成计费的条目标「待计费 N 条」（没人跟的静默缺口）', () => {
    seedClosingScenario();

    const operation = closingOf('OP-SAMPLE-004');

    assert.equal(operation.summary_label, '待计费 1 条');
    assert.equal(operation.pending_charge_count, 1);
    assert.equal(operation.pending_check_count, 0);
    assert.equal(operation.can_close, false);
    assert.equal(operation.pending_charge_items[0]?.material_code, 'MAT-SAMPLE-05');
  });

  it('一条不漏：被拒绝的耗材（没有台账行）也在清单里并计入待核查', () => {
    seedClosingScenario();

    const report = buildClosingChecklist(ledger.db, { operation_no: 'OP-SAMPLE-001' });

    const codes = report.items.map((item) => item.material_code).sort();
    assert.deepEqual(codes, ['MAT-SAMPLE-01', 'MAT-UNKNOWN-01', 'MAT-UNKNOWN-02']);
    // 被拒绝的两条没有台账行，条目状态记 rejected
    for (const item of report.items.filter((row) => row.material_code.startsWith('MAT-UNKNOWN'))) {
      assert.equal(item.binding_status, 'rejected');
      assert.equal(item.check_status, 'pending');
      assert.equal(item.charge_state, 'not_submitted');
    }
    // 台账里确实只有 1 行 —— 清单比台账多出的两条正是被拒绝的耗材
    const ledgerRows = (
      ledger.db
        .prepare('SELECT COUNT(*) AS n FROM material_binding WHERE operation_no = ?')
        .get('OP-SAMPLE-001') as { n: number }
    ).n;
    assert.equal(ledgerRows, 1);
    assert.equal(report.items.length, 3);
  });

  it('导出 CSV：表头逐字等于白名单，且内容不含患者标识字段', () => {
    seedClosingScenario();

    const report = buildClosingChecklist(ledger.db, {});
    const csv = closingChecklistToCsv(report);
    const lines = csv.split('\n');

    assert.equal(lines[0], CLOSING_EXPORT_FIELDS.join(','));
    // 每一行都有条目，且列数与表头一致
    assert.equal(lines.length - 1, report.items.length);
    for (const line of lines.slice(1)) {
      assert.equal(line.split(',').length, CLOSING_EXPORT_FIELDS.length);
    }
    // 汇总标签也进导出（护士长按这一列筛「还有待办的台次」）
    assert.ok(csv.includes('待核查 2 条'));
    assert.ok(csv.includes('可关台'));

    // 无患者标识字段
    for (const pattern of PATIENT_IDENTIFIER_PATTERNS) {
      assert.ok(!pattern.test(csv), `导出里出现了患者标识字段：${pattern}`);
    }
  });

  it('导出 JSON：逐台次结论 + 逐条明细结构完整', () => {
    seedClosingScenario();

    const report = buildClosingChecklist(ledger.db, {});
    const parsed = JSON.parse(closingChecklistToJson(report)) as {
      fields: string[];
      totals: Record<string, number>;
      operations: Array<{
        operation_no: string;
        summary_label: string;
        can_close: boolean;
        pending_items: unknown[];
        items: unknown[];
      }>;
    };

    assert.deepEqual(parsed.fields, [...CLOSING_EXPORT_FIELDS]);
    assert.equal(parsed.totals['operations'], report.operations.length);
    assert.equal(parsed.totals['pending_check'], 2);

    const pending = parsed.operations.find((item) => item.operation_no === 'OP-SAMPLE-001');
    assert.ok(pending);
    assert.equal(pending.summary_label, '待核查 2 条');
    assert.equal(pending.can_close, false);
    assert.equal(pending.pending_items.length, 2);
    assert.equal(pending.items.length, 3);

    const closed = parsed.operations.find((item) => item.operation_no === 'OP-SAMPLE-002');
    assert.ok(closed);
    assert.equal(closed.summary_label, CLOSING_LABEL_CAN_CLOSE);
    assert.equal(closed.can_close, true);
  });

  it('批量导出：按日期范围与按台次列表各自命中预期台次数', () => {
    seedClosingScenario();

    // ① 日期范围覆盖全部
    const all = buildClosingChecklist(ledger.db, { from: '2000-01-01', to: '2100-01-01' });
    assert.equal(all.operations.length, 3, '有耗材条目的台次共 3 个');
    assert.equal(all.scope.from, '2000-01-01T00:00:00.000Z');
    assert.equal(all.scope.to, '2100-01-01T00:00:00.000Z');

    // ② 日期范围落在未来 → 一条都没有
    const none = buildClosingChecklist(ledger.db, { from: '2100-01-01', to: '2100-12-31' });
    assert.equal(none.operations.length, 0);
    assert.equal(none.items.length, 0);

    // ③ 台次列表 → 只导指定的台次
    const picked = buildClosingChecklist(ledger.db, {
      operations: ['OP-SAMPLE-002', 'OP-SAMPLE-004'],
    });
    assert.deepEqual(
      picked.operations.map((item) => item.operation_no),
      ['OP-SAMPLE-002', 'OP-SAMPLE-004'],
    );

    // ④ 指定了台次但一条都没扫 → 也要出现在清单里（区分「没扫」和「漏扫」）
    const empty = buildClosingChecklist(ledger.db, { operations: ['OP-SAMPLE-003'] });
    assert.equal(empty.operations.length, 1);
    assert.equal(empty.operations[0]?.summary_label, CLOSING_LABEL_NO_ITEMS);
    assert.equal(empty.operations[0]?.item_count, 0);
  });

  it('时间范围不合法时报错并指名是哪个参数', () => {
    assert.throws(
      () => buildClosingChecklist(ledger.db, { from: '不是时间' }),
      (error: unknown) => {
        assert.ok(error instanceof ClosingReportError);
        assert.equal(error.code, ERR_CLOSING_INVALID_RANGE);
        assert.ok(error.message.includes('起始时间'));
        return true;
      },
    );
  });

  it('终端可读版本：每台次一段，含耗材条数、待核查数与待核查条目清单', () => {
    seedClosingScenario();

    const report = buildClosingChecklist(ledger.db, {});
    const text = renderClosingChecklist(report);

    assert.ok(text.includes('== 关台核对清单 =='));
    assert.ok(text.includes('-- 台次 OP-SAMPLE-001'));
    assert.ok(text.includes('手术间 OR-01'));
    assert.ok(text.includes('耗材 3 条'));
    assert.ok(text.includes('汇总：待核查 2 条'));
    // 待核查条目逐条列出（耗材码 + 原因码 + 责任岗位）
    assert.ok(text.includes('MAT-UNKNOWN-01'));
    assert.ok(text.includes('MAT-UNKNOWN-02'));
    assert.ok(text.includes('MATERIAL_NOT_REGISTERED'));
    assert.ok(text.includes('高值耗材管理岗'));
    // 全闭环台次也有一段
    assert.ok(text.includes('-- 台次 OP-SAMPLE-002'));
    assert.ok(text.includes('汇总：可关台'));
  });

  it('汇总标签口径：三档判定互斥（待核查 > 待计费 > 可关台）', () => {
    assert.equal(closingSummaryLabel(0, 0), CLOSING_LABEL_CAN_CLOSE);
    assert.equal(closingSummaryLabel(2, 0), '待核查 2 条');
    assert.equal(closingSummaryLabel(0, 1), '待计费 1 条');
    assert.equal(closingSummaryLabel(2, 1), '待核查 2 条 · 待计费 1 条');
  });

  it('只读不改：导出前后台账 / 核查 / 回执行数一条不少一条不多', () => {
    seedClosingScenario();

    const snapshot = (): Record<string, number> => {
      const rows = ledger.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM material_binding) AS bindings,
             (SELECT COUNT(*) FROM check_task)       AS checks,
             (SELECT COUNT(*) FROM charge_receipt)  AS receipts,
             (SELECT COUNT(*) FROM audit_chain)      AS audits`,
        )
        .get() as Record<string, number>;
      return rows;
    };

    const before = snapshot();
    buildClosingChecklist(ledger.db, {});
    closingChecklistToCsv(buildClosingChecklist(ledger.db, {}));
    closingChecklistToJson(buildClosingChecklist(ledger.db, {}));
    renderClosingChecklist(buildClosingChecklist(ledger.db, {}));
    const after = snapshot();

    assert.deepEqual(after, before, '关台核对清单是只读的，不该改动任何业务状态');
  });

  it('命令行入口：closing 子命令可跑，输出含关台结论与待核查条目', async () => {
    seedClosingScenario();

    const workDir = mkdtempSync(resolve(tmpdir(), 'closing-report-'));
    const dbPath = resolve(workDir, 'ledger.db');
    try {
      // 用文件库跑一次 CLI（内存库没法给子进程用）
      const fileLedger = openLedger(dbPath);
      importMasterData(fileLedger.db, { operationsCsv, materialsCsv });
      bindMaterial(fileLedger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      acceptCharge(fileLedger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      bindMaterial(fileLedger.db, 'MAT-UNKNOWN-01', 'OP-SAMPLE-001');
      fileLedger.close();

      const result = await execFileAsync(
        process.execPath,
        [
          resolve(projectRoot, 'dist', 'cli.js'),
          'closing',
          '--db',
          dbPath,
          '--operation',
          'OP-SAMPLE-001',
        ],
        { cwd: projectRoot },
      );
      assert.ok(result.stdout.includes('关台核对清单'), 'CLI 输出应含「关台核对清单」');
      assert.ok(result.stdout.includes('OP-SAMPLE-001'));
      assert.ok(result.stdout.includes('待核查 1 条'));
      assert.ok(result.stdout.includes('MAT-UNKNOWN-01'));

      const csv = await execFileAsync(
        process.execPath,
        [
          resolve(projectRoot, 'dist', 'cli.js'),
          'closing',
          '--db',
          dbPath,
          '--operation',
          'OP-SAMPLE-001',
          '--format',
          'csv',
        ],
        { cwd: projectRoot },
      );
      assert.ok(csv.stdout.startsWith(CLOSING_EXPORT_FIELDS.join(',')), 'CSV 表头应逐字等于白名单');
      assert.ok(csv.stdout.includes('MAT-UNKNOWN-01'));
      for (const pattern of PATIENT_IDENTIFIER_PATTERNS) {
        assert.ok(!pattern.test(csv.stdout), `CLI 导出里出现了患者标识字段：${pattern}`);
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
