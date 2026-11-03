/**
 * test_boundary_matrix：五种绑定结论的**完备性属性测试**（≥500 条 fixture 逐条断言）。
 *
 * fixture 由 `scripts/gen-boundary-fixtures.ts` 确定性生成（三份可读 CSV）：
 *   tests/boundary/boundary-operations.csv   排台台次（开台 / 已关台 / 先到者台次）
 *   tests/boundary/boundary-materials.csv    耗材主数据（启用 / 停用 / 缺系数 / 费用口径不合规）
 *   tests/boundary/boundary-cases.csv        判定矩阵用例（637 条，逐条带预期结论）
 *
 * 本轮把矩阵从 486 条扩到 **637 条**，维度扩到六个：
 *   码制（13 种）× 台次状态（3 种）× 归属（3 种）× 主数据状态（5 种）×
 *   计费结果（2 种）× 数量（7 种）
 *
 * 每条用例的预期结论写在 fixture 里（**独立于产品代码**的期望表），
 * 本测试拿产品判定结果与它逐条比对 —— 断言的是「产品行为 vs 预期矩阵」，
 * 而不是「产品行为 vs 产品行为」。测试文件里另有一份**独立重写**的期望表，
 * 用于校验 fixture 本身没被写坏（fixture 的预期列必须与独立表逐字一致）。
 *
 * 覆盖：
 *   ① 用例数 ≥ 500，耗材码全局唯一（用例之间互不污染），六个维度的每个取值都被走到；
 *   ② 逐条断言「唯一结论 + 原因码 + 是否需人工」与预期矩阵逐字一致；
 *   ③ **绝不猜绑**：凡输入含歧义（台次缺失 / 主数据缺失 / 耗材停用 / 跨台次重复 /
 *      口径不合规 / 数量换不出来 / 计费被拒）的用例，结论一律不是 BOUND；
 *   ④ 异常结论一律升成带台次上下文的核查条目，且**原因码 / 错误码三处同码**
 *      （判定结果 / 核查条目 / 错误码表）；
 *   ⑤ 批号差异分支：结论层仍 BOUND，批号维度在**幂等层**判重复（v1 档位）；
 *   ⑥ **结论唯一性**：随机 2000 次抽样，同一输入恒得同一结论，无冲突。
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData, parseCsv } from '../src/ledger/import-master-data.js';
import { bindOne } from '../src/engine/binding.js';
import { classify, concludeAndRecord } from '../src/engine/conclude.js';
import { ERROR_CODES, errorCodeForReason } from '../src/log/error-codes.js';
import { mulberry32, randomInt } from '../src/data/prng.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const boundaryDir = resolve(projectRoot, 'tests', 'boundary');

interface BoundaryCaseRow {
  case_id: string;
  template_id: string;
  code_form: string;
  operation_state: string;
  ownership: string;
  material_state: string;
  charge_outcome: string;
  quantity: string;
  raw_code: string;
  material_code: string;
  operation_no: string;
  room_no: string;
  dept_code: string;
  batch_no: string;
  pre_bind_operation_no: string;
  pre_bind_raw_code: string;
  pre_bind_batch_no: string;
  expected_conclusion: string;
  expected_reason_code: string;
  expected_needs_manual: string;
}

const MIN_CASES = 500;
/** 结论唯一性抽样次数 */
const UNIQUENESS_SAMPLES = 2000;
/** 随机抽样种子（固定 → 可重跑） */
const SAMPLE_SEED = 20260101;

/* ── 独立重写的期望表（校验 fixture 本身没被写坏） ── */

const STRUCTURE_REASON: Record<string, string> = {
  empty: 'CODE_EMPTY',
  too_long: 'CODE_TOO_LONG',
  illegal_charset: 'CODE_ILLEGAL_CHARSET',
  form_unrecognized: 'CODE_FORM_UNRECOGNIZED',
  udi_bad_check: 'CODE_GTIN_CHECK_DIGIT_INVALID',
  gtin_bad_check: 'CODE_GTIN_CHECK_DIGIT_INVALID',
};

/** 按维度独立推导期望结论（与生成器里的表分开写一遍） */
function independentExpectation(row: BoundaryCaseRow): {
  conclusion: string;
  reason_code: string;
  needs_manual: boolean;
} {
  const manual = (conclusion: string, reason_code: string) => ({
    conclusion,
    reason_code,
    needs_manual: true,
  });

  if (row.operation_state === 'unknown') return manual('NOT_REGISTERED', 'OPERATION_NOT_FOUND');
  if (row.operation_state === 'closed') return manual('CLOSED', 'OPERATION_CLOSED');
  const structure = STRUCTURE_REASON[row.code_form];
  if (structure) return manual('NOT_REGISTERED', structure);
  if (row.material_state === 'unregistered') return manual('NOT_REGISTERED', 'MATERIAL_NOT_REGISTERED');
  if (row.material_state === 'inactive') return manual('NOT_REGISTERED', 'MATERIAL_INACTIVE');
  if (row.material_state === 'ratio_missing') return manual('NOT_REGISTERED', 'UNIT_RATIO_MISSING');
  if (row.material_state === 'fee_invalid') return manual('NOT_REGISTERED', 'FEE_CATEGORY_NOT_CONSUMABLE');
  const quantity = Number(row.quantity);
  if (Math.abs(quantity - Math.round(quantity)) > 1e-9) {
    return manual('NOT_REGISTERED', 'QUANTITY_NOT_DIVISIBLE');
  }
  if (row.ownership === 'duplicate_other_op') {
    return manual('CROSS_OP_DUP', 'CROSS_OP_DUPLICATE_MATERIAL');
  }
  if (row.charge_outcome === 'business_rejected') {
    return manual('CHARGE_REJECTED', 'PRICE_CODE_NOT_FOUND');
  }
  return { conclusion: 'BOUND', reason_code: '', needs_manual: false };
}

/** 这个用例的输入是否含歧义（含歧义 → 结论必须不是 BOUND） */
function isAmbiguous(row: BoundaryCaseRow): boolean {
  if (row.operation_state !== 'open') return true;
  if (STRUCTURE_REASON[row.code_form]) return true;
  if (row.material_state !== 'registered') return true;
  if (row.ownership === 'duplicate_other_op') return true;
  if (row.charge_outcome === 'business_rejected') return true;
  const quantity = Number(row.quantity);
  if (Math.abs(quantity - Math.round(quantity)) > 1e-9) return true;
  return false;
}

let ledger: LedgerDb;
let cases: BoundaryCaseRow[];

/** 按用例行组装判定输入（与产品主路径同形：归一后的码 + 原始码） */
function judgeInput(row: BoundaryCaseRow): {
  db: LedgerDb['db'];
  operation_no: string;
  room_no: string;
  scanner_id: string;
  material_code: string;
  raw_code: string;
  quantity: number;
  batch_no: string;
  charge_rejection: { reason_code: string; message?: string } | null;
} {
  return {
    db: ledger.db,
    operation_no: row.operation_no,
    room_no: row.room_no,
    scanner_id: 'SCAN-BC',
    material_code: row.material_code,
    raw_code: row.raw_code,
    quantity: Number(row.quantity),
    batch_no: row.batch_no,
    charge_rejection:
      row.charge_outcome === 'business_rejected'
        ? { reason_code: 'PRICE_CODE_NOT_FOUND', message: '价码不存在（边界矩阵模拟的计费业务拒绝）' }
        : null,
  };
}

before(() => {
  const parsed = parseCsv(readFileSync(resolve(boundaryDir, 'boundary-cases.csv'), 'utf8'));
  cases = parsed.rows as unknown as BoundaryCaseRow[];
  ledger = openLedger(':memory:');
  importMasterData(ledger.db, {
    operationsCsv: readFileSync(resolve(boundaryDir, 'boundary-operations.csv'), 'utf8'),
    materialsCsv: readFileSync(resolve(boundaryDir, 'boundary-materials.csv'), 'utf8'),
  });

  // 先到者预置：跨台次重复 / 批号差异两类用例要先把「先到的那笔」真的绑上，
  // 后到者才判得出重复（走产品的真实绑定路径，不是手写台账行）。
  for (const row of cases) {
    const preBindOperation = row.pre_bind_operation_no ?? '';
    if (!preBindOperation) continue;
    // 先到者的事件手术间取**先到者台次自己的**手术间（从排台主数据现读，不拼字符串）——
    // 归属双因子核对要核「事件说的手术间」与「排台说的手术间」，两者必须一致。
    const preBindRoom = (
      ledger.db
        .prepare('SELECT room_no FROM operation WHERE operation_no = ?')
        .get(preBindOperation) as { room_no: string } | undefined
    )?.room_no ?? row.room_no;
    const bound = bindOne(ledger.db, {
      db: ledger.db,
      operation_no: preBindOperation,
      room_no: preBindRoom,
      scanner_id: 'SCAN-BC-PREBIND',
      material_code: row.material_code,
      raw_code: row.pre_bind_raw_code,
      quantity: Number(row.quantity),
      batch_no: row.pre_bind_batch_no,
    });
    assert.equal(
      bound.conclusion,
      'BOUND',
      `${row.case_id}：先到者应绑上（${preBindOperation} / ${row.material_code}），实际 ${bound.conclusion}/${bound.reason_code}`,
    );
  }
});

describe('判定边界矩阵（≥500 条 fixture 逐条断言）', () => {
  it('fixture 规模与维度覆盖：≥500 条、耗材码全局唯一、六个维度的每个取值都被走到', () => {
    assert.ok(
      cases.length >= MIN_CASES,
      `边界用例只有 ${cases.length} 条，应 ≥ ${MIN_CASES} 条`,
    );
    const codes = cases.map((row) => row.material_code).filter((code) => code !== '');
    const unique = new Set(codes);
    assert.equal(unique.size, codes.length, '用例的耗材码必须全局唯一，否则跨台次重复会互相污染');
    const ids = new Set(cases.map((row) => row.case_id));
    assert.equal(ids.size, cases.length, '用例编号必须唯一');

    // 六个维度的每个取值都必须在矩阵里出现
    const dimensions: Array<[string, Set<string>]> = [
      ['码制', new Set(cases.map((row) => row.code_form))],
      ['台次状态', new Set(cases.map((row) => row.operation_state))],
      ['归属', new Set(cases.map((row) => row.ownership))],
      ['主数据状态', new Set(cases.map((row) => row.material_state))],
      ['计费结果', new Set(cases.map((row) => row.charge_outcome))],
      ['数量', new Set(cases.map((row) => row.quantity))],
    ];
    const expectedValues: Record<string, string[]> = {
      码制: [
        'internal',
        'internal_dotted',
        'internal_underscore',
        'gtin_bare',
        'udi',
        'udi_batch',
        'gs1_ai01',
        'udi_bad_check',
        'gtin_bad_check',
        'empty',
        'too_long',
        'illegal_charset',
        'form_unrecognized',
      ],
      台次状态: ['open', 'closed', 'unknown'],
      归属: ['first', 'duplicate_other_op', 'batch_diff'],
      主数据状态: ['registered', 'unregistered', 'inactive', 'ratio_missing', 'fee_invalid'],
      计费结果: ['none', 'business_rejected'],
      数量: ['1', '2', '3', '4', '5', '6', '0.5'],
    };
    for (const [name, seen] of dimensions) {
      for (const value of expectedValues[name] ?? []) {
        assert.ok(seen.has(value), `维度「${name}」的取值 ${value} 在矩阵里没出现`);
      }
    }

    // 五种结论都要有足够多的用例（每种至少 20 条）
    const byConclusion = new Map<string, number>();
    for (const row of cases) {
      byConclusion.set(row.expected_conclusion, (byConclusion.get(row.expected_conclusion) ?? 0) + 1);
    }
    for (const conclusion of [
      'BOUND',
      'NOT_REGISTERED',
      'CROSS_OP_DUP',
      'CLOSED',
      'CHARGE_REJECTED',
    ]) {
      const count = byConclusion.get(conclusion) ?? 0;
      assert.ok(count >= 20, `结论 ${conclusion} 只有 ${count} 条用例，应 ≥ 20 条`);
    }
  });

  it('fixture 自身的预期列与独立期望表逐字一致（fixture 没被写坏）', () => {
    for (const row of cases) {
      const expected = independentExpectation(row);
      assert.equal(
        row.expected_conclusion,
        expected.conclusion,
        `${row.case_id}：fixture 的预期结论应为 ${expected.conclusion}`,
      );
      assert.equal(
        row.expected_reason_code ?? '',
        expected.reason_code,
        `${row.case_id}：fixture 的预期原因码应为 ${expected.reason_code || '(空)'}`,
      );
      assert.equal(
        row.expected_needs_manual,
        expected.needs_manual ? 'true' : 'false',
        `${row.case_id}：fixture 的「是否需人工」应为 ${expected.needs_manual}`,
      );
    }
  });

  it('逐条断言：唯一结论 + 原因码 + 是否需人工与预期矩阵逐字一致', () => {
    const seenConclusions = new Set<string>();
    const seenReasons = new Set<string>();

    for (const row of cases) {
      const judged = concludeAndRecord(ledger.db, judgeInput(row));

      assert.equal(
        judged.conclusion,
        row.expected_conclusion,
        `${row.case_id}（${row.template_id} ${row.code_form} × ${row.operation_state} × ${row.ownership} × ${row.material_state} × ${row.charge_outcome} × 数量${row.quantity}）：结论应为 ${row.expected_conclusion}，实际 ${judged.conclusion}`,
      );
      assert.equal(
        judged.reason_code ?? '',
        row.expected_reason_code ?? '',
        `${row.case_id}：原因码应为 ${row.expected_reason_code || '(空)'}，实际 ${judged.reason_code ?? '(空)'}`,
      );
      assert.equal(
        judged.needs_manual,
        row.expected_needs_manual === 'true',
        `${row.case_id}：是否需人工应为 ${row.expected_needs_manual}`,
      );
      assert.equal(
        judged.bound,
        row.expected_conclusion === 'BOUND',
        `${row.case_id}：bound 标志与结论必须一致`,
      );

      seenConclusions.add(judged.conclusion);
      if (judged.reason_code) seenReasons.add(judged.reason_code);

      // 异常结论一律升核查条目（带台次上下文），BOUND 不升
      if (judged.conclusion === 'BOUND') {
        assert.equal(judged.check_task_id, null, `${row.case_id}：绑上不应升核查条目`);
      } else {
        assert.ok(judged.check_task_id !== null, `${row.case_id}：异常结论应升核查条目`);
      }
    }

    for (const conclusion of [
      'BOUND',
      'NOT_REGISTERED',
      'CROSS_OP_DUP',
      'CLOSED',
      'CHARGE_REJECTED',
    ]) {
      assert.ok(seenConclusions.has(conclusion), `矩阵未覆盖结论 ${conclusion}`);
    }
    for (const reason of [
      'OPERATION_NOT_FOUND',
      'OPERATION_CLOSED',
      'CODE_EMPTY',
      'CODE_TOO_LONG',
      'CODE_ILLEGAL_CHARSET',
      'CODE_FORM_UNRECOGNIZED',
      'CODE_GTIN_CHECK_DIGIT_INVALID',
      'MATERIAL_NOT_REGISTERED',
      'MATERIAL_INACTIVE',
      'UNIT_RATIO_MISSING',
      'FEE_CATEGORY_NOT_CONSUMABLE',
      'QUANTITY_NOT_DIVISIBLE',
      'CROSS_OP_DUPLICATE_MATERIAL',
      'PRICE_CODE_NOT_FOUND',
    ]) {
      assert.ok(seenReasons.has(reason), `矩阵未覆盖原因码 ${reason}`);
    }
  });

  it('异常结论必带可追踪的原因码与统一错误码（判定 / 核查条目 / 错误码表三处同码）', () => {
    const knownErrorCodes = new Set(ERROR_CODES.map((entry) => entry.code));

    for (const row of cases) {
      const judged = concludeAndRecord(ledger.db, judgeInput(row));
      if (judged.conclusion === 'BOUND') {
        assert.equal(judged.reason_code, null, `${row.case_id}：绑上不应带原因码`);
        assert.equal(judged.error_code, null, `${row.case_id}：绑上不应带错误码`);
        continue;
      }

      assert.ok(
        (judged.reason_code ?? '').length > 0,
        `${row.case_id}：异常结论必须带原因码`,
      );
      assert.ok(
        (judged.error_code ?? '').length > 0,
        `${row.case_id}：异常结论必须带统一错误码`,
      );
      assert.ok(
        knownErrorCodes.has(judged.error_code as string),
        `${row.case_id}：错误码 ${judged.error_code} 未登记在错误码表里`,
      );
      assert.equal(
        judged.error_code,
        errorCodeForReason(judged.reason_code),
        `${row.case_id}：判定结果的错误码必须与原因码映射一致`,
      );
      // 判定依据要能定位到触发该结论的具体判据
      assert.ok(
        judged.basis.length > 0,
        `${row.case_id}：异常结论必须给出判定依据（basis）`,
      );
      assert.ok(
        judged.basis.some((line) => line.trim().length > 0),
        `${row.case_id}：判定依据不能是空串`,
      );
      assert.ok(
        judged.message.trim().length > 0,
        `${row.case_id}：异常结论必须给出中文说明`,
      );

      // 核查条目上的码与判定结果一致（同一个问题三处同码）
      const task = ledger.db
        .prepare(
          `SELECT conclusion, reason_code, error_code, operation_no, room_no, dept_code, material_code, quantity
             FROM check_task WHERE id = ?`,
        )
        .get(judged.check_task_id as number) as
        | {
            conclusion: string;
            reason_code: string;
            error_code: string | null;
            operation_no: string;
            room_no: string;
            dept_code: string | null;
            material_code: string;
            quantity: number | null;
          }
        | undefined;
      assert.ok(task, `${row.case_id}：核查条目查不到`);
      assert.equal(task.conclusion, judged.conclusion, `${row.case_id}：核查条目结论不一致`);
      assert.equal(task.reason_code, judged.reason_code, `${row.case_id}：核查条目原因码不一致`);
      assert.equal(task.error_code, judged.error_code, `${row.case_id}：核查条目错误码不一致`);
      assert.equal(task.operation_no, row.operation_no, `${row.case_id}：核查条目须带台次上下文`);
      assert.equal(task.room_no, row.room_no, `${row.case_id}：核查条目须带手术间上下文`);
      if (row.operation_state !== 'unknown') {
        // 台次查得到时，核查条目必须带上科室（台次查不到就没有科室可带）
        assert.ok((task.dept_code ?? '').length > 0, `${row.case_id}：核查条目须带科室上下文`);
      }
    }
  });

  it('绝不猜绑：凡输入含歧义的用例，结论一律不是 BOUND', () => {
    let ambiguousCount = 0;
    for (const row of cases) {
      if (!isAmbiguous(row)) continue;
      ambiguousCount += 1;
      assert.notEqual(
        row.expected_conclusion,
        'BOUND',
        `${row.case_id}：含歧义的用例不应期望 BOUND`,
      );
      const judged = concludeAndRecord(ledger.db, judgeInput(row));
      assert.notEqual(
        judged.conclusion,
        'BOUND',
        `${row.case_id}：含歧义的输入被判成了 BOUND（绝不猜绑被破坏）`,
      );
      assert.equal(
        judged.needs_manual,
        true,
        `${row.case_id}：含歧义的条目必须转人工`,
      );
    }
    assert.ok(ambiguousCount >= 100, `含歧义的用例只有 ${ambiguousCount} 条，覆盖不足`);
  });

  it('批号差异分支：结论层仍 BOUND，批号维度在幂等层判重复（v1 档位）', () => {
    const batchDiffCases = cases.filter(
      (row) => row.ownership === 'batch_diff' && row.expected_conclusion === 'BOUND',
    );
    assert.ok(batchDiffCases.length >= 20, `批号差异用例只有 ${batchDiffCases.length} 条`);

    for (const row of batchDiffCases) {
      const before = ledger.db
        .prepare('SELECT COUNT(*) AS n FROM material_binding WHERE material_code = ? AND operation_no = ?')
        .get(row.material_code, row.operation_no) as { n: number };

      const outcome = bindOne(ledger.db, {
        db: ledger.db,
        operation_no: row.operation_no,
        room_no: row.room_no,
        scanner_id: 'SCAN-BC-BATCH',
        material_code: row.material_code,
        raw_code: row.raw_code,
        quantity: Number(row.quantity),
        batch_no: row.batch_no,
      });

      assert.equal(
        outcome.reason_code,
        'DUPLICATE_SCAN_BATCH_MISMATCH',
        `${row.case_id}：同码同台次但批号不同，v1 档位应判批号差异重复`,
      );
      assert.equal(outcome.bound, false, `${row.case_id}：重复的那条不应再绑上`);
      assert.equal(
        outcome.error_code,
        'ERR_DUPLICATE_BATCH_MISMATCH',
        `${row.case_id}：批号差异应给独立错误码`,
      );

      const after = ledger.db
        .prepare('SELECT COUNT(*) AS n FROM material_binding WHERE material_code = ? AND operation_no = ?')
        .get(row.material_code, row.operation_no) as { n: number };
      assert.equal(after.n, before.n, `${row.case_id}：重复的那条不应产生第二行台账`);
    }
  });

  it('结论唯一性：随机 2000 次抽样，同一输入恒得同一结论（无冲突）', () => {
    const rng = mulberry32(SAMPLE_SEED);
    /** 维度组合 → 抽样中见到的结论集合（同一组合必须只有一个结论） */
    const seenByTuple = new Map<string, Set<string>>();
    const seenByCase = new Map<string, Set<string>>();

    for (let i = 0; i < UNIQUENESS_SAMPLES; i += 1) {
      const row = cases[randomInt(rng, 0, cases.length)] as BoundaryCaseRow;
      const input = judgeInput(row);

      // 同一输入判两次（两次之间不写任何数据）→ 结论必须完全一致
      const first = classify(input);
      const second = classify(input);

      assert.equal(
        first.conclusion,
        second.conclusion,
        `${row.case_id}：同一输入两次判定结论不一致（${first.conclusion} vs ${second.conclusion}）`,
      );
      assert.equal(
        first.reason_code ?? '',
        second.reason_code ?? '',
        `${row.case_id}：同一输入两次判定原因码不一致`,
      );
      assert.equal(
        first.conclusion,
        row.expected_conclusion,
        `${row.case_id}：抽样判定结论应为 ${row.expected_conclusion}，实际 ${first.conclusion}`,
      );
      assert.equal(
        first.reason_code ?? '',
        row.expected_reason_code ?? '',
        `${row.case_id}：抽样判定原因码应为 ${row.expected_reason_code || '(空)'}`,
      );

      const tuple = [
        row.code_form,
        row.operation_state,
        row.ownership,
        row.material_state,
        row.charge_outcome,
        row.quantity,
      ].join('|');
      const tupleConclusions = seenByTuple.get(tuple) ?? new Set<string>();
      tupleConclusions.add(first.conclusion);
      seenByTuple.set(tuple, tupleConclusions);
      assert.equal(
        tupleConclusions.size,
        1,
        `维度组合 ${tuple} 判出了多个结论（${[...tupleConclusions].join(' / ')}）—— 结论不唯一`,
      );

      const caseConclusions = seenByCase.get(row.case_id) ?? new Set<string>();
      caseConclusions.add(first.conclusion);
      seenByCase.set(row.case_id, caseConclusions);
      assert.equal(
        caseConclusions.size,
        1,
        `用例 ${row.case_id} 判出了多个结论（${[...caseConclusions].join(' / ')}）—— 结论不唯一`,
      );
    }

    assert.equal(
      seenByCase.size > 0,
      true,
      '随机抽样必须覆盖到用例',
    );
    // 抽样覆盖面：2000 次抽样应当覆盖到矩阵里绝大多数用例（固定种子 → 数值可复现）
    assert.ok(
      seenByCase.size >= 500,
      `2000 次抽样只覆盖到 ${seenByCase.size} 条用例，抽样面太窄`,
    );
  });
});
