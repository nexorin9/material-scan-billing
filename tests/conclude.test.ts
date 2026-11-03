/**
 * test_conclude：绑定判定引擎 —— 三层校验、台次状态判定与五种结论归类。
 *
 * 覆盖：
 *   ① 三层校验各自的独立 reason_code（结构 / 字典映射 / 业务）；
 *   ② 台次三态（开台 / 已关台 / 排台查不到）；
 *   ③ **≥200 条 fixture 属性测试**：码制形态 × 台次状态 × 耗材主数据状态 × 数量，
 *      逐条断言「唯一结论 + 与预期矩阵一致」；
 *   ④ 五种结论各自命中；
 *   ⑤ CROSS_OP_DUP：后到者拒、先到者记录保留、升核查条目并保留原始台次与手术间；
 *   ⑥ CLOSED：不自动补录，转人工；
 *   ⑦ 「绝不猜绑」负例：任何歧义都不落 BOUND；
 *   ⑧ 结论不随数量 / 扫码枪变化；重复投递不刷重复待办。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { deriveIdempotencyKey } from '../src/domain/idempotency.js';
import { CONCLUSION_CODES, type ConclusionCode } from '../src/domain/scan-event.js';
import {
  classify,
  concludeAndRecord,
  findBindingOrigin,
  REASON_CROSS_OP_DUPLICATE,
} from '../src/engine/conclude.js';
import { resolveOperation } from '../src/engine/operation.js';
import { validateMaterialCode } from '../src/engine/validate-code.js';
import { countCheckTasks, findCheckTask } from '../src/check/task.js';

/* ── 主数据（判定引擎专用，与其他测试的 fixture 相互独立） ── */

const OPEN_OP = 'OP-PROP-001';
const CLOSED_OP = 'OP-PROP-003';
const UNKNOWN_OP = 'OP-PROP-NOT-EXIST';
const ORIGIN_OP = 'OP-PROP-900';

const OPERATIONS: Array<[string, string, string, string, string]> = [
  [OPEN_OP, 'OR-01', 'SURG-01', 'open', ''],
  [CLOSED_OP, 'OR-03', 'SURG-02', 'closed', '2026-01-15T09:30:00+08:00'],
  [ORIGIN_OP, 'OR-90', 'SURG-09', 'open', ''],
];

const MATERIALS: Array<[string, string, string, string, string, number]> = [
  ['MAT-PROP-01', '样例高值耗材甲', 'PR-PROP-01', '卫生材料', '甲类', 1],
  ['MAT-PROP-02', '样例高值耗材乙', 'PR-PROP-02', '卫生材料', '甲类', 1],
  ['MAT-PROP-03', '已停用耗材', 'PR-PROP-03', '卫生材料', '甲类', 0],
  ['MAT-PROP-04', '缺费用类别耗材', 'PR-PROP-04', '', '甲类', 1],
  ['MAT-PROP-05', '缺医保分类耗材', 'PR-PROP-05', '卫生材料', '', 1],
  ['MAT-PROP-06', '本台次已绑耗材', 'PR-PROP-06', '卫生材料', '甲类', 1],
  ['06912345678902', 'GTIN-14 形态耗材', 'PR-PROP-GTIN', '卫生材料', '甲类', 1],
  // MAT-PROP-MISSING 故意不建档 —— 用来测「耗材码未建档」
];

type MaterialState =
  | 'registered'
  | 'registered_gtin'
  | 'prebound_other_op'
  | 'prebound_same_op'
  | 'inactive'
  | 'no_fee_category'
  | 'no_insurance_class'
  | 'unregistered';

type OperationState = 'open' | 'closed' | 'unknown';
type CodeVariant =
  | 'canonical'
  | 'empty'
  | 'too_long'
  | 'illegal_charset'
  | 'form_unrecognized'
  | 'dictionary_miss';

interface Fixture {
  material_state: MaterialState;
  operation_state: OperationState;
  code_variant: CodeVariant;
  quantity: number;
  /** 计费通道是否已给出业务拒绝（计费发生在绑定之后） */
  charge_rejected: boolean;
  /** 实际拿去判定的耗材码 */
  code: string;
  /** 实际拿去判定的台次 */
  operation_no: string;
  room_no: string;
}

const MATERIAL_STATE_CODE: Record<MaterialState, string> = {
  registered: 'MAT-PROP-01',
  registered_gtin: '06912345678902',
  prebound_other_op: 'MAT-PROP-02',
  prebound_same_op: 'MAT-PROP-06',
  inactive: 'MAT-PROP-03',
  no_fee_category: 'MAT-PROP-04',
  no_insurance_class: 'MAT-PROP-05',
  unregistered: 'MAT-PROP-MISSING',
};

const OPERATION_STATE_NO: Record<OperationState, string> = {
  open: OPEN_OP,
  closed: CLOSED_OP,
  unknown: UNKNOWN_OP,
};

const OPERATION_STATE_ROOM: Record<OperationState, string> = {
  open: 'OR-01',
  closed: 'OR-03',
  unknown: 'OR-77',
};

function codeFor(variant: CodeVariant, base: string): string {
  switch (variant) {
    case 'canonical':
      return base;
    case 'empty':
      return '';
    case 'too_long':
      return `${base}${'X'.repeat(60)}`;
    case 'illegal_charset':
      return 'MAT PROP#01';
    case 'form_unrecognized':
      return '1234567890123';
    case 'dictionary_miss':
      return 'MAT-PROP-NOT-IN-MASTER';
    default:
      return base;
  }
}

const MATERIAL_STATES: MaterialState[] = [
  'registered',
  'registered_gtin',
  'prebound_other_op',
  'prebound_same_op',
  'inactive',
  'no_fee_category',
  'no_insurance_class',
  'unregistered',
];
const OPERATION_STATES: OperationState[] = ['open', 'closed', 'unknown'];
const CODE_VARIANTS: CodeVariant[] = [
  'canonical',
  'empty',
  'too_long',
  'illegal_charset',
  'form_unrecognized',
  'dictionary_miss',
];
const QUANTITIES = [1, 2, 5];
/** 计费通道业务拒绝的原因码（固定一个，便于逐条断言） */
const CHARGE_REASON = 'PRICE_CODE_NOT_FOUND';

/** 全部 fixture（8 × 3 × 6 × 3 × 2 = 864 条，≥ 200） */
const FIXTURES: Fixture[] = [];
for (const material_state of MATERIAL_STATES) {
  for (const operation_state of OPERATION_STATES) {
    for (const code_variant of CODE_VARIANTS) {
      for (const quantity of QUANTITIES) {
        for (const charge_rejected of [false, true]) {
          FIXTURES.push({
            material_state,
            operation_state,
            code_variant,
            quantity,
            charge_rejected,
            code: codeFor(code_variant, MATERIAL_STATE_CODE[material_state]),
            operation_no: OPERATION_STATE_NO[operation_state],
            room_no: OPERATION_STATE_ROOM[operation_state],
          });
        }
      }
    }
  }
}

/**
 * 预期矩阵 —— **独立于实现**按 spec.md 的判定顺序写出来，用于交叉核对：
 *   台次 → 耗材码结构层 → 字典映射层 → 业务层 → 跨台次重复 → 计费拒绝 → 绑上
 */
function expectedOutcome(f: Fixture): { conclusion: ConclusionCode; reason_code: string | null } {
  if (f.operation_state === 'unknown') {
    return { conclusion: 'NOT_REGISTERED', reason_code: 'OPERATION_NOT_FOUND' };
  }
  if (f.operation_state === 'closed') {
    return { conclusion: 'CLOSED', reason_code: 'OPERATION_CLOSED' };
  }
  if (f.code_variant === 'empty') {
    return { conclusion: 'NOT_REGISTERED', reason_code: 'CODE_EMPTY' };
  }
  if (f.code_variant === 'too_long') {
    return { conclusion: 'NOT_REGISTERED', reason_code: 'CODE_TOO_LONG' };
  }
  if (f.code_variant === 'illegal_charset') {
    return { conclusion: 'NOT_REGISTERED', reason_code: 'CODE_ILLEGAL_CHARSET' };
  }
  if (f.code_variant === 'form_unrecognized') {
    return { conclusion: 'NOT_REGISTERED', reason_code: 'CODE_FORM_UNRECOGNIZED' };
  }
  if (f.code_variant === 'dictionary_miss' || f.material_state === 'unregistered') {
    return { conclusion: 'NOT_REGISTERED', reason_code: 'MATERIAL_NOT_REGISTERED' };
  }
  if (f.material_state === 'inactive') {
    return { conclusion: 'NOT_REGISTERED', reason_code: 'MATERIAL_INACTIVE' };
  }
  if (f.material_state === 'no_fee_category') {
    return { conclusion: 'NOT_REGISTERED', reason_code: 'FEE_CATEGORY_MISSING' };
  }
  if (f.material_state === 'no_insurance_class') {
    return { conclusion: 'NOT_REGISTERED', reason_code: 'INSURANCE_CLASS_MISSING' };
  }
  if (f.material_state === 'prebound_other_op') {
    return { conclusion: 'CROSS_OP_DUP', reason_code: 'CROSS_OP_DUPLICATE_MATERIAL' };
  }
  // 计费拒绝只可能发生在绑定成立之后
  if (f.charge_rejected) {
    return { conclusion: 'CHARGE_REJECTED', reason_code: CHARGE_REASON };
  }
  return { conclusion: 'BOUND', reason_code: null };
}

/**
 * 这条输入能不能自动闭环（不能 → 绝不能落 BOUND）。
 * 同台次重复由幂等层处理，判定层不算歧义。
 */
function isAmbiguous(f: Fixture): boolean {
  if (f.operation_state !== 'open') return true;
  if (f.code_variant !== 'canonical') return true;
  if (f.charge_rejected) return true;
  return !(
    f.material_state === 'registered' ||
    f.material_state === 'registered_gtin' ||
    f.material_state === 'prebound_same_op'
  );
}

let ledger: LedgerDb;

before(() => {
  ledger = openLedger(':memory:');

  const insertOp = ledger.db.prepare(
    `INSERT INTO operation (operation_no, room_no, dept_code, status, closed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const [no, room, dept, status, closedAt] of OPERATIONS) {
    insertOp.run(no, room, dept, status, closedAt || null, '2026-01-15T08:00:00Z');
  }

  const insertMat = ledger.db.prepare(
    `INSERT INTO material (material_code, name, price_code, fee_category, medical_insurance_class, active, batch_no,
                            unit_pack, unit_min, charge_unit, ratio, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [code, name, price, fee, cls, active] of MATERIALS) {
    // 单位口径：1 包 = 1 支，包装即计价（判定引擎用例只关心结论，不关心倍数）
    insertMat.run(code, name, price, fee, cls, active, 'LOT-PROP', '包', '支', '支', 1, '2026-01-15T08:00:00Z');
  }

  // 先到者：MAT-PROP-02 已绑在 OP-PROP-900；MAT-PROP-06 已绑在本台次 OP-PROP-001
  const insertBinding = ledger.db.prepare(
    `INSERT INTO material_binding
       (idempotency_key, operation_no, room_no, dept_code, material_code, quantity,
        price_code, fee_category, medical_insurance_class, conclusion, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BOUND', 'bound', ?, ?)`,
  );
  const now = '2026-01-15T08:30:00Z';
  insertBinding.run(
    deriveIdempotencyKey('MAT-PROP-02', ORIGIN_OP),
    ORIGIN_OP,
    'OR-90',
    'SURG-09',
    'MAT-PROP-02',
    1,
    'PR-PROP-02',
    '卫生材料',
    '甲类',
    now,
    now,
  );
  insertBinding.run(
    deriveIdempotencyKey('MAT-PROP-06', OPEN_OP),
    OPEN_OP,
    'OR-01',
    'SURG-01',
    'MAT-PROP-06',
    1,
    'PR-PROP-06',
    '卫生材料',
    '甲类',
    now,
    now,
  );
});

after(() => {
  ledger.close();
});

function judge(f: Fixture) {
  return classify({
    db: ledger.db,
    operation_no: f.operation_no,
    room_no: f.room_no,
    scanner_id: 'SCAN-GUN-PROPS',
    material_code: f.code,
    raw_code: f.code,
    quantity: f.quantity,
    charge_rejection: f.charge_rejected ? { reason_code: CHARGE_REASON } : null,
  });
}

describe('test_conclude · 三层校验（结构 → 字典映射 → 业务）', () => {
  it('结构层：空 / 超长 / 非法字符集 / 形态不可识别各给独立原因码', () => {
    const empty = validateMaterialCode(ledger.db, '');
    assert.equal(empty.ok, false);
    assert.equal(empty.failed_layer, 'structure');
    assert.equal(empty.reason_code, 'CODE_EMPTY');

    const tooLong = validateMaterialCode(ledger.db, `MAT-PROP-01${'X'.repeat(60)}`);
    assert.equal(tooLong.failed_layer, 'structure');
    assert.equal(tooLong.reason_code, 'CODE_TOO_LONG');

    const charset = validateMaterialCode(ledger.db, 'MAT PROP#01');
    assert.equal(charset.failed_layer, 'structure');
    assert.equal(charset.reason_code, 'CODE_ILLEGAL_CHARSET');

    const form = validateMaterialCode(ledger.db, '1234567890123');
    assert.equal(form.failed_layer, 'structure');
    assert.equal(form.reason_code, 'CODE_FORM_UNRECOGNIZED');
  });

  it('字典映射层：主数据查不到给 MATERIAL_NOT_REGISTERED，且不带业务层原因码', () => {
    const miss = validateMaterialCode(ledger.db, 'MAT-PROP-NOT-IN-MASTER');
    assert.equal(miss.ok, false);
    assert.equal(miss.failed_layer, 'dictionary');
    assert.equal(miss.reason_code, 'MATERIAL_NOT_REGISTERED');
    assert.equal(miss.material, null);
  });

  it('业务层：停用 / 缺费用类别 / 缺医保分类三例各给独立原因码', () => {
    const inactive = validateMaterialCode(ledger.db, 'MAT-PROP-03');
    assert.equal(inactive.failed_layer, 'business');
    assert.equal(inactive.reason_code, 'MATERIAL_INACTIVE');

    const noFee = validateMaterialCode(ledger.db, 'MAT-PROP-04');
    assert.equal(noFee.failed_layer, 'business');
    assert.equal(noFee.reason_code, 'FEE_CATEGORY_MISSING');

    const noClass = validateMaterialCode(ledger.db, 'MAT-PROP-05');
    assert.equal(noClass.failed_layer, 'business');
    assert.equal(noClass.reason_code, 'INSURANCE_CLASS_MISSING');
  });

  it('三层全过：命中主数据并给出码制形态', () => {
    const ok = validateMaterialCode(ledger.db, '06912345678902', { raw_code: '(01)06912345678902(10)LOT-A1' });
    assert.equal(ok.ok, true);
    assert.equal(ok.canonical_form, 'GTIN14');
    assert.equal(ok.raw_code_form, 'UDI');
    assert.equal(ok.material?.material_code, '06912345678902');
  });
});

describe('test_conclude · 台次状态判定', () => {
  it('开台 / 已关台 / 排台查不到三态各自可辨', () => {
    const open = resolveOperation(ledger.db, OPEN_OP);
    assert.equal(open.status, 'open');
    assert.equal(open.found, true);
    assert.equal(open.dept_code, 'SURG-01');
    assert.equal(open.reason_code, null);

    const closed = resolveOperation(ledger.db, CLOSED_OP);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.reason_code, 'OPERATION_CLOSED');
    assert.equal(closed.closed_at, '2026-01-15T09:30:00+08:00');

    const unknown = resolveOperation(ledger.db, UNKNOWN_OP);
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.found, false);
    assert.equal(unknown.reason_code, 'OPERATION_NOT_FOUND');
  });
});

describe('test_conclude · ≥200 条 fixture 属性测试（结论唯一且与矩阵一致）', () => {
  it(`fixture 数量 ≥ 200（实际 ${FIXTURES.length} 条）`, () => {
    assert.ok(FIXTURES.length >= 200, `属性测试样本不足：${FIXTURES.length}`);
  });

  it('逐条断言：唯一结论 + 与预期矩阵一致 + 依据非空', () => {
    const hits: Record<string, number> = {};
    for (const f of FIXTURES) {
      const result = judge(f);
      const expected = expectedOutcome(f);

      assert.ok(
        CONCLUSION_CODES.includes(result.conclusion),
        `结论不在五种之内：${result.conclusion}`,
      );
      assert.equal(result.conclusion, expected.conclusion, `结论与矩阵不一致：${JSON.stringify(f)}`);
      assert.equal(result.reason_code, expected.reason_code, `原因码与矩阵不一致：${JSON.stringify(f)}`);
      assert.equal(result.bound, result.conclusion === 'BOUND');
      assert.equal(result.needs_manual, result.conclusion !== 'BOUND');
      assert.ok(result.basis.length > 0, `判定依据为空：${JSON.stringify(f)}`);
      if (result.conclusion !== 'BOUND') {
        assert.ok(result.message.length > 0, '异常结论必须给出中文说明');
      }

      hits[result.conclusion] = (hits[result.conclusion] ?? 0) + 1;
    }

    for (const code of CONCLUSION_CODES) {
      assert.ok((hits[code] ?? 0) >= 2, `结论 ${code} 命中不足 2 次（实际 ${hits[code] ?? 0}）`);
    }
  });

  it('「绝不猜绑」：任何歧义都不落 BOUND', () => {
    for (const f of FIXTURES) {
      const result = judge(f);
      if (isAmbiguous(f)) {
        assert.notEqual(result.conclusion, 'BOUND', `歧义输入被判成 BOUND：${JSON.stringify(f)}`);
        assert.equal(result.needs_manual, true);
      }
    }
  });

  it('结论不随数量与扫码枪变化', () => {
    for (const f of FIXTURES) {
      const a = classify({
        db: ledger.db,
        operation_no: f.operation_no,
        room_no: f.room_no,
        scanner_id: 'SCAN-GUN-A',
        material_code: f.code,
        quantity: f.quantity,
        charge_rejection: f.charge_rejected ? { reason_code: CHARGE_REASON } : null,
      });
      const b = classify({
        db: ledger.db,
        operation_no: f.operation_no,
        room_no: f.room_no,
        scanner_id: 'SCAN-GUN-B',
        material_code: f.code,
        quantity: f.quantity + 7,
        charge_rejection: f.charge_rejected ? { reason_code: CHARGE_REASON } : null,
      });
      assert.equal(a.conclusion, b.conclusion, `结论随数量/扫码枪漂移：${JSON.stringify(f)}`);
      assert.equal(a.reason_code, b.reason_code);
    }
  });
});

describe('test_conclude · 五种结论各自命中', () => {
  it('BOUND：耗材命中且台次开台', () => {
    const result = judge({
      material_state: 'registered',
      operation_state: 'open',
      code_variant: 'canonical',
      charge_rejected: false,
      quantity: 1,
      code: 'MAT-PROP-01',
      operation_no: OPEN_OP,
      room_no: 'OR-01',
    });
    assert.equal(result.conclusion, 'BOUND');
    assert.equal(result.bound, true);
    assert.equal(result.reason_code, null);
    assert.equal(result.needs_manual, false);
  });

  it('NOT_REGISTERED：耗材码未建档', () => {
    const result = judge({
      material_state: 'unregistered',
      operation_state: 'open',
      code_variant: 'canonical',
      charge_rejected: false,
      quantity: 1,
      code: 'MAT-PROP-MISSING',
      operation_no: OPEN_OP,
      room_no: 'OR-01',
    });
    assert.equal(result.conclusion, 'NOT_REGISTERED');
    assert.equal(result.reason_code, 'MATERIAL_NOT_REGISTERED');
    assert.equal(result.needs_manual, true);
  });

  it('CROSS_OP_DUP：同一耗材已绑在另一个台次', () => {
    const result = judge({
      material_state: 'prebound_other_op',
      operation_state: 'open',
      code_variant: 'canonical',
      charge_rejected: false,
      quantity: 1,
      code: 'MAT-PROP-02',
      operation_no: OPEN_OP,
      room_no: 'OR-01',
    });
    assert.equal(result.conclusion, 'CROSS_OP_DUP');
    assert.equal(result.reason_code, REASON_CROSS_OP_DUPLICATE);
    assert.equal(result.duplicate_of?.operation_no, ORIGIN_OP);
    assert.equal(result.duplicate_of?.room_no, 'OR-90');
  });

  it('CLOSED：台次已关台', () => {
    const result = judge({
      material_state: 'registered',
      operation_state: 'closed',
      code_variant: 'canonical',
      charge_rejected: false,
      quantity: 1,
      code: 'MAT-PROP-01',
      operation_no: CLOSED_OP,
      room_no: 'OR-03',
    });
    assert.equal(result.conclusion, 'CLOSED');
    assert.equal(result.reason_code, 'OPERATION_CLOSED');
    assert.equal(result.needs_manual, true);
  });

  it('CHARGE_REJECTED：计费通道业务拒绝', () => {
    const result = classify({
      db: ledger.db,
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-PROPS',
      material_code: 'MAT-PROP-01',
      quantity: 1,
      charge_rejection: { reason_code: 'PRICE_CODE_NOT_FOUND' },
    });
    assert.equal(result.conclusion, 'CHARGE_REJECTED');
    assert.equal(result.reason_code, 'PRICE_CODE_NOT_FOUND');
    assert.equal(result.needs_manual, true);
    assert.equal(result.bound, false);
  });
});

describe('test_conclude · CROSS_OP_DUP：拒后到者、保先到者、升核查条目', () => {
  it('后到者落异常结论并升核查条目，条目带台次上下文与原始归属', () => {
    const before = countBindings(ledger.db);
    const result = concludeAndRecord(ledger.db, {
      db: ledger.db,
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      material_code: 'MAT-PROP-02',
      quantity: 2,
    });

    assert.equal(result.conclusion, 'CROSS_OP_DUP');
    assert.equal(result.reason_code, REASON_CROSS_OP_DUPLICATE);
    assert.ok(result.check_task_id, '后到者必须升成核查条目');

    const task = findCheckTask(ledger.db, result.check_task_id as number);
    assert.ok(task);
    assert.equal(task?.operation_no, OPEN_OP);
    assert.equal(task?.room_no, 'OR-01');
    assert.equal(task?.dept_code, 'SURG-01');
    assert.equal(task?.scanner_id, 'SCAN-GUN-07');
    assert.equal(task?.material_code, 'MAT-PROP-02');
    assert.equal(task?.quantity, 2);
    assert.equal(task?.conclusion, 'CROSS_OP_DUP');
    assert.equal(task?.reason_code, REASON_CROSS_OP_DUPLICATE);
    assert.equal(task?.status, 'pending');
    // 原始归属（先到者的台次与手术间）保留在核查条目里，供事后核对
    assert.equal(task?.source_operation_no, ORIGIN_OP);
    assert.equal(task?.source_room_no, 'OR-90');

    // 先到者的台账行原样保留，后到者不写台账行
    assert.equal(countBindings(ledger.db), before, '后到者不得写耗材使用台账');
    const origin = findBindingOrigin(ledger.db, 'MAT-PROP-02', OPEN_OP);
    assert.equal(origin?.operation_no, ORIGIN_OP);
    const kept = ledger.db
      .prepare('SELECT operation_no, room_no, conclusion FROM material_binding WHERE material_code = ? AND operation_no = ?')
      .get('MAT-PROP-02', ORIGIN_OP) as { operation_no: string; room_no: string; conclusion: string };
    assert.equal(kept.operation_no, ORIGIN_OP);
    assert.equal(kept.room_no, 'OR-90');
    assert.equal(kept.conclusion, 'BOUND');
  });

  it('重复投递同一条异常：不刷重复待办', () => {
    const before = countCheckTasks(ledger.db);
    const again = concludeAndRecord(ledger.db, {
      db: ledger.db,
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      material_code: 'MAT-PROP-02',
      quantity: 2,
    });
    assert.equal(again.conclusion, 'CROSS_OP_DUP');
    assert.equal(countCheckTasks(ledger.db), before, '同一异常不应重复建待办');
  });
});

describe('test_conclude · CLOSED：不自动补录，转人工', () => {
  it('台次已关台 → 异常结论 + 核查条目，不写台账、不产生计费', () => {
    const before = countBindings(ledger.db);
    const beforeTasks = countCheckTasks(ledger.db);

    const result = concludeAndRecord(ledger.db, {
      db: ledger.db,
      operation_no: CLOSED_OP,
      room_no: 'OR-03',
      scanner_id: 'SCAN-GUN-07',
      material_code: 'MAT-PROP-01',
      quantity: 1,
    });

    assert.equal(result.conclusion, 'CLOSED');
    assert.equal(result.reason_code, 'OPERATION_CLOSED');
    assert.ok(result.check_task_id, '关台条目必须转人工核查');
    assert.equal(countCheckTasks(ledger.db), beforeTasks + 1);
    assert.equal(countBindings(ledger.db), before, '关台台次不得写耗材使用台账');
    assert.match(result.message, /补录/);
  });
});

describe('test_conclude · 绝不猜绑（负例）', () => {
  it('台次缺失 / 台次已关台 / 跨台次重复 / 主数据缺失 / 耗材停用 五例都不判 BOUND', () => {
    const cases = [
      { name: '台次缺失', op: UNKNOWN_OP, code: 'MAT-PROP-01' },
      { name: '台次已关台', op: CLOSED_OP, code: 'MAT-PROP-01' },
      { name: '跨台次重复', op: OPEN_OP, code: 'MAT-PROP-02' },
      { name: '主数据缺失', op: OPEN_OP, code: 'MAT-PROP-MISSING' },
      { name: '耗材停用', op: OPEN_OP, code: 'MAT-PROP-03' },
    ];
    for (const c of cases) {
      const result = classify({
        db: ledger.db,
        operation_no: c.op,
        room_no: 'OR-01',
        scanner_id: 'SCAN-GUN-07',
        material_code: c.code,
        quantity: 1,
      });
      assert.notEqual(result.conclusion, 'BOUND', `${c.name} 被判成 BOUND`);
      assert.equal(result.needs_manual, true, `${c.name} 未标记需人工`);
      assert.ok(result.reason_code, `${c.name} 缺原因码`);
    }
  });
});
