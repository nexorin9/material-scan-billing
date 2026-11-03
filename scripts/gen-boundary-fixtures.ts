/**
 * 判定边界矩阵 fixture 生成器 —— 产出三份**可读**的 fixture 文件：
 *
 *   tests/boundary/boundary-operations.csv   排台台次（开台 / 已关台 / 先到者台次）
 *   tests/boundary/boundary-materials.csv    耗材主数据（启用 / 停用 / 缺系数 / 费用口径不合规）
 *   tests/boundary/boundary-cases.csv        判定矩阵用例（≥500 条，逐条带预期结论与原因码）
 *
 * 本轮把矩阵从 486 条扩到 **637 条**，并把维度扩到六个：
 *
 *   码制形态   internal / internal_dotted / internal_underscore / gtin_bare / udi /
 *              udi_batch / gs1_ai01 / udi_bad_check / gtin_bad_check / empty /
 *              too_long / illegal_charset / form_unrecognized（13 种）
 *   台次状态   open / closed / unknown（3 种）
 *   耗材归属   first（首次）/ duplicate_other_op（跨台次重复）/ batch_diff（批号差异）（3 种）
 *   主数据态   registered / unregistered / inactive / ratio_missing / fee_invalid（5 种）
 *   计费结果   none / business_rejected（2 种）
 *   数量       1 / 2 / 3 / 4 / 5 / 6 / 0.5（7 种，其中 0.5 触发「除不尽」）
 *
 * 覆盖的是**五种结论的完备性**：BOUND / NOT_REGISTERED / CROSS_OP_DUP / CLOSED /
 * CHARGE_REJECTED —— 每一类都至少有几十条用例，且每条异常结论都带**独立**的 reason_code
 * （14 个原因码全覆盖），供 `tests/boundary-matrix.test.ts` 逐条断言。
 *
 * 预期结论由**独立写出的期望表**推导（不调用产品代码），属性测试再拿产品结论与它逐条比对 ——
 * 这样断言才是「产品行为 vs 预期矩阵」，不是「产品行为 vs 产品行为」。
 *
 * 跑法：npm run fixtures:boundary
 * 产物是确定的（无随机数），重复执行逐字节一致。
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toGtin14 } from '../src/data/catalog.js';
import type { ConclusionCode } from '../src/domain/scan-event.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const boundaryDir = resolve(projectRoot, 'tests', 'boundary');

/* ── 维度取值 ── */

const CODE_FORMS = [
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
] as const;
type CodeForm = (typeof CODE_FORMS)[number];

const OPERATION_STATES = ['open', 'closed', 'unknown'] as const;
type OperationState = (typeof OPERATION_STATES)[number];

const OWNERSHIPS = ['first', 'duplicate_other_op', 'batch_diff'] as const;
type Ownership = (typeof OWNERSHIPS)[number];

const MATERIAL_STATES = [
  'registered',
  'unregistered',
  'inactive',
  'ratio_missing',
  'fee_invalid',
] as const;
type MaterialState = (typeof MATERIAL_STATES)[number];

const CHARGE_OUTCOMES = ['none', 'business_rejected'] as const;
type ChargeOutcome = (typeof CHARGE_OUTCOMES)[number];

/* ── 期望表（独立于产品代码写出） ── */

const REASON_OPERATION_NOT_FOUND = 'OPERATION_NOT_FOUND';
const REASON_OPERATION_CLOSED = 'OPERATION_CLOSED';
const REASON_CODE_EMPTY = 'CODE_EMPTY';
const REASON_CODE_TOO_LONG = 'CODE_TOO_LONG';
const REASON_CODE_ILLEGAL_CHARSET = 'CODE_ILLEGAL_CHARSET';
const REASON_CODE_FORM_UNRECOGNIZED = 'CODE_FORM_UNRECOGNIZED';
const REASON_CODE_GTIN_CHECK = 'CODE_GTIN_CHECK_DIGIT_INVALID';
const REASON_MATERIAL_NOT_REGISTERED = 'MATERIAL_NOT_REGISTERED';
const REASON_MATERIAL_INACTIVE = 'MATERIAL_INACTIVE';
const REASON_UNIT_RATIO_MISSING = 'UNIT_RATIO_MISSING';
const REASON_FEE_CATEGORY_NOT_CONSUMABLE = 'FEE_CATEGORY_NOT_CONSUMABLE';
const REASON_QUANTITY_NOT_DIVISIBLE = 'QUANTITY_NOT_DIVISIBLE';
const REASON_CROSS_OP_DUPLICATE = 'CROSS_OP_DUPLICATE_MATERIAL';
/** 对端计费通道给的业务拒绝码（本轮用价码不存在这一类） */
const REASON_CHARGE_BUSINESS_REJECTED = 'PRICE_CODE_NOT_FOUND';

/** 结构层 / 码制层失败的原因码（这一层不过就不查主数据） */
const STRUCTURE_REASON: Partial<Record<CodeForm, string>> = {
  empty: REASON_CODE_EMPTY,
  too_long: REASON_CODE_TOO_LONG,
  illegal_charset: REASON_CODE_ILLEGAL_CHARSET,
  form_unrecognized: REASON_CODE_FORM_UNRECOGNIZED,
  udi_bad_check: REASON_CODE_GTIN_CHECK,
  gtin_bad_check: REASON_CODE_GTIN_CHECK,
};

/**
 * 结构层能过形态识别的码制（其余七种是「码本身就坏 / 不成形」）。
 *
 * 这七种码制在主数据里**可能**查到行；坏码永远查不到 —— 生成器据此决定要不要建主数据行。
 */
const STRUCTURALLY_VALID_FORMS: readonly CodeForm[] = [
  'internal',
  'internal_dotted',
  'internal_underscore',
  'gtin_bare',
  'udi',
  'udi_batch',
  'gs1_ai01',
];

/**
 * 期望结论：按判定顺序逐层短路推导。
 *   ① 台次查不到 → NOT_REGISTERED / OPERATION_NOT_FOUND
 *   ② 台次已关台 → CLOSED / OPERATION_CLOSED
 *   ③ 结构层 / 码制层不过 → NOT_REGISTERED / 对应原因码
 *   ④ 字典层不过（主数据查不到） → NOT_REGISTERED / MATERIAL_NOT_REGISTERED
 *   ⑤ 业务层不过（停用 / 缺系数 / 费用口径不合规） → NOT_REGISTERED / 对应原因码
 *   ⑥ 数量换算不成立（除不尽） → NOT_REGISTERED / QUANTITY_NOT_DIVISIBLE
 *   ⑦ 已绑在**别的**台次 → CROSS_OP_DUP / CROSS_OP_DUPLICATE_MATERIAL
 *   ⑧ 绑定成立但计费通道业务拒绝 → CHARGE_REJECTED / 对端码
 *   ⑨ 其余 → BOUND
 *
 * 注：`batch_diff`（同一台次、同一耗材、批号不同）在**结论层**仍是 BOUND ——
 * 批号维度属于**幂等档位**（v1 判重复 / v2 各算一次），由结算层处理，
 * 不改变绑定结论本身（见 `judgeDuplicate`）。这一点由属性测试单独断言。
 */
export function expectedConclusion(input: {
  code_form: CodeForm;
  operation_state: OperationState;
  ownership: Ownership;
  material_state: MaterialState;
  charge_outcome: ChargeOutcome;
  quantity: number;
}): { conclusion: ConclusionCode; reason_code: string | null; needs_manual: boolean } {
  const manual = (conclusion: ConclusionCode, reason_code: string) => ({
    conclusion,
    reason_code,
    needs_manual: true,
  });

  if (input.operation_state === 'unknown') {
    return manual('NOT_REGISTERED', REASON_OPERATION_NOT_FOUND);
  }
  if (input.operation_state === 'closed') {
    return manual('CLOSED', REASON_OPERATION_CLOSED);
  }
  const structureReason = STRUCTURE_REASON[input.code_form];
  if (structureReason) {
    return manual('NOT_REGISTERED', structureReason);
  }
  if (input.material_state === 'unregistered') {
    return manual('NOT_REGISTERED', REASON_MATERIAL_NOT_REGISTERED);
  }
  if (input.material_state === 'inactive') {
    return manual('NOT_REGISTERED', REASON_MATERIAL_INACTIVE);
  }
  if (input.material_state === 'ratio_missing') {
    return manual('NOT_REGISTERED', REASON_UNIT_RATIO_MISSING);
  }
  if (input.material_state === 'fee_invalid') {
    return manual('NOT_REGISTERED', REASON_FEE_CATEGORY_NOT_CONSUMABLE);
  }
  // 数量换算：包装数 × 换算系数必须落成整数（registered 耗材的系数是 1）。
  const chargeQuantity = input.quantity * 1;
  if (Math.abs(chargeQuantity - Math.round(chargeQuantity)) > 1e-9) {
    return manual('NOT_REGISTERED', REASON_QUANTITY_NOT_DIVISIBLE);
  }
  if (input.ownership === 'duplicate_other_op') {
    return manual('CROSS_OP_DUP', REASON_CROSS_OP_DUPLICATE);
  }
  if (input.charge_outcome === 'business_rejected') {
    return manual('CHARGE_REJECTED', REASON_CHARGE_BUSINESS_REJECTED);
  }
  return { conclusion: 'BOUND', reason_code: null, needs_manual: false };
}

/* ── 场景模板 ── */

/**
 * 场景模板：每个码制都跑一遍这一组「维度组合」。
 *
 * 模板是**语义场景**而不是维度笛卡尔积 —— 笛卡尔积里绝大多数组合是「更早的一层就短路了」，
 * 真正能落到 BOUND / CROSS_OP_DUP / CHARGE_REJECTED 的组合很少。模板把有意义的组合
 * 逐条摆出来，保证五种结论各有几十条用例、每个维度的每个取值都被走到。
 */
interface ScenarioTemplate {
  id: string;
  operation_state: OperationState;
  material_state: MaterialState;
  ownership: Ownership;
  charge_outcome: ChargeOutcome;
  quantities: readonly number[];
}

const TEMPLATES: readonly ScenarioTemplate[] = [
  { id: 'T01', operation_state: 'open', material_state: 'registered', ownership: 'first', charge_outcome: 'none', quantities: [1, 2, 3] },
  { id: 'T02', operation_state: 'open', material_state: 'registered', ownership: 'duplicate_other_op', charge_outcome: 'none', quantities: [1, 2, 3] },
  { id: 'T03', operation_state: 'open', material_state: 'registered', ownership: 'batch_diff', charge_outcome: 'none', quantities: [1, 2, 3] },
  { id: 'T04', operation_state: 'open', material_state: 'registered', ownership: 'first', charge_outcome: 'business_rejected', quantities: [1, 2, 3] },
  { id: 'T05', operation_state: 'open', material_state: 'unregistered', ownership: 'first', charge_outcome: 'none', quantities: [1, 2, 3] },
  { id: 'T06', operation_state: 'open', material_state: 'inactive', ownership: 'first', charge_outcome: 'none', quantities: [1, 2, 3] },
  { id: 'T07', operation_state: 'open', material_state: 'ratio_missing', ownership: 'first', charge_outcome: 'none', quantities: [1, 2, 3] },
  { id: 'T08', operation_state: 'open', material_state: 'fee_invalid', ownership: 'first', charge_outcome: 'none', quantities: [1, 2, 3] },
  { id: 'T09', operation_state: 'closed', material_state: 'registered', ownership: 'first', charge_outcome: 'none', quantities: [1, 2, 3] },
  { id: 'T10', operation_state: 'closed', material_state: 'registered', ownership: 'duplicate_other_op', charge_outcome: 'none', quantities: [1, 2, 3] },
  { id: 'T11', operation_state: 'unknown', material_state: 'registered', ownership: 'first', charge_outcome: 'none', quantities: [1, 2, 3] },
  { id: 'T12', operation_state: 'unknown', material_state: 'registered', ownership: 'batch_diff', charge_outcome: 'none', quantities: [1, 2, 3] },
  { id: 'T13', operation_state: 'open', material_state: 'registered', ownership: 'first', charge_outcome: 'none', quantities: [0.5] },
  { id: 'T14', operation_state: 'open', material_state: 'registered', ownership: 'first', charge_outcome: 'business_rejected', quantities: [0.5] },
  { id: 'T15', operation_state: 'closed', material_state: 'inactive', ownership: 'first', charge_outcome: 'none', quantities: [1] },
  { id: 'T16', operation_state: 'unknown', material_state: 'unregistered', ownership: 'first', charge_outcome: 'none', quantities: [1] },
  { id: 'T17', operation_state: 'open', material_state: 'registered', ownership: 'duplicate_other_op', charge_outcome: 'business_rejected', quantities: [1, 2, 3] },
  { id: 'T18', operation_state: 'open', material_state: 'registered', ownership: 'batch_diff', charge_outcome: 'business_rejected', quantities: [1, 2, 3] },
  { id: 'T19', operation_state: 'open', material_state: 'registered', ownership: 'first', charge_outcome: 'none', quantities: [4, 5, 6] },
];

interface BoundaryCase {
  case_id: string;
  template_id: string;
  code_form: CodeForm;
  operation_state: OperationState;
  ownership: Ownership;
  material_state: MaterialState;
  charge_outcome: ChargeOutcome;
  quantity: number;
  /** 设备上报的原始码 */
  raw_code: string;
  /** 归一后的院内耗材主数据键 */
  material_code: string;
  operation_no: string;
  room_no: string;
  dept_code: string;
  batch_no: string;
  /** 先到者的台次（跨台次重复时是**另一个**台次；批号差异时是本台次） */
  pre_bind_operation_no: string;
  /** 先到者的原始码（同一把主数据键，批号段是它自己那批） */
  pre_bind_raw_code: string;
  /** 先到者的批号 */
  pre_bind_batch_no: string;
  expected_conclusion: ConclusionCode;
  expected_reason_code: string;
  expected_needs_manual: boolean;
}

interface OperationRow {
  operation_no: string;
  room_no: string;
  dept_code: string;
  status: 'open' | 'closed';
  closed_at: string;
}

interface MaterialRow {
  material_code: string;
  name: string;
  price_code: string;
  fee_category: string;
  medical_insurance_class: string;
  active: boolean;
  batch_no: string;
  unit_pack: string;
  unit_min: string;
  charge_unit: string;
  ratio: string;
}

/** 把 13 位基数补成带合法校验位的 GTIN-14 */
function gtin14(base13: string): string {
  return toGtin14(base13);
}

/** 把合法 GTIN 的校验位改坏（得到「条码本身有问题」的那一类码） */
function breakCheckDigit(gtin: string): string {
  const last = Number(gtin.slice(-1));
  return `${gtin.slice(0, -1)}${(last + 1) % 10}`;
}

/**
 * 按码制形态造出原始码与归一后的主数据键。
 *
 * 归一规则与 `src/ingest/codes.ts` 一致：UDI / GS1 AI(01) 取 (01) 里的 DI，
 * 院内码原样作主数据键。
 *
 * @param batch 批号（UDI 的 (10) 段用；批号差异场景里本条与先到者各带各的批号）
 */
function buildCode(
  code_form: CodeForm,
  n: number,
  batch: string,
): { raw_code: string; canonical: string } {
  const serial = String(n).padStart(4, '0');
  const base13 = `069${String(n).padStart(10, '0')}`;
  const gtin = gtin14(base13);
  const badGtin = breakCheckDigit(gtin);

  switch (code_form) {
    case 'internal':
      return { raw_code: `MAT-BC-${serial}`, canonical: `MAT-BC-${serial}` };
    case 'internal_dotted':
      return { raw_code: `MAT.BC.${serial}`, canonical: `MAT.BC.${serial}` };
    case 'internal_underscore':
      return { raw_code: `MAT_BC_${serial}`, canonical: `MAT_BC_${serial}` };
    case 'gtin_bare':
      return { raw_code: gtin, canonical: gtin };
    case 'udi':
      return { raw_code: `(01)${gtin}`, canonical: gtin };
    case 'udi_batch':
      return { raw_code: `(01)${gtin}(10)${batch}`, canonical: gtin };
    case 'gs1_ai01':
      return { raw_code: `01${gtin}`, canonical: gtin };
    case 'udi_bad_check':
      return { raw_code: `(01)${badGtin}`, canonical: badGtin };
    case 'gtin_bad_check':
      return { raw_code: badGtin, canonical: badGtin };
    case 'empty':
      return { raw_code: '', canonical: '' };
    case 'too_long':
      return { raw_code: `MAT-BC-${serial}${'X'.repeat(60)}`, canonical: `MAT-BC-${serial}${'X'.repeat(60)}` };
    case 'illegal_charset':
      return { raw_code: `MAT-BC-${serial}@@`, canonical: `MAT-BC-${serial}@@` };
    case 'form_unrecognized':
      return { raw_code: String(n).padStart(9, '0'), canonical: String(n).padStart(9, '0') };
    default:
      return { raw_code: '', canonical: '' };
  }
}

/** 这个码制形态在主数据里能不能有行（坏码永远查不到） */
function formAllowsMaterialRow(code_form: CodeForm): boolean {
  return STRUCTURALLY_VALID_FORMS.includes(code_form);
}

function main(): void {
  const operations = new Map<string, OperationRow>();
  const materials = new Map<string, MaterialRow>();
  const cases: BoundaryCase[] = [];

  let n = 0;
  for (const code_form of CODE_FORMS) {
    for (const template of TEMPLATES) {
      for (const quantity of template.quantities) {
        n += 1;
        const serial = String(n).padStart(4, '0');

        // 批号：先到者那笔与本条各带各的（批号差异场景下两者必须不同）
        const preBindBatchNo = `LOT-BC-${serial}`;
        const caseBatchNo = template.ownership === 'batch_diff' ? `${preBindBatchNo}-B` : preBindBatchNo;

        const { raw_code, canonical } = buildCode(code_form, n, caseBatchNo);
        // 先到者的原始码：同一把主数据键，但批号段是它自己那批
        const { raw_code: preBindRawCode } = buildCode(code_form, n, preBindBatchNo);

        const expected = expectedConclusion({
          code_form,
          operation_state: template.operation_state,
          ownership: template.ownership,
          material_state: template.material_state,
          charge_outcome: template.charge_outcome,
          quantity,
        });

        const operation_no = `OP-BC-${template.operation_state}-${serial}`;
        const room_no = `OR-BC-${serial}`;
        const dept_code = 'SURG-BC';

        const batchNo = preBindBatchNo;

        // 先到者的台次：
        //   duplicate_other_op → 另一个**开台**台次（先到者先绑上）；
        //   batch_diff          → 本台次（同码同台次、批号不同）；
        //   其余                → 无先到者。
        // 只有「先到者确实绑得上」的场景才预置（预期结论为 BOUND / CROSS_OP_DUP / CHARGE_REJECTED）。
        const bindable =
          expected.conclusion === 'BOUND' ||
          expected.conclusion === 'CROSS_OP_DUP' ||
          expected.conclusion === 'CHARGE_REJECTED';
        const preBindOperationNo =
          bindable && template.ownership === 'duplicate_other_op'
            ? `OP-BC-PREBIND-${serial}`
            : bindable && template.ownership === 'batch_diff'
              ? operation_no
              : '';

        // 台次主数据
        if (template.operation_state !== 'unknown') {
          operations.set(operation_no, {
            operation_no,
            room_no,
            dept_code,
            status: template.operation_state === 'closed' ? 'closed' : 'open',
            closed_at: template.operation_state === 'closed' ? '2026-01-20T10:00:00+08:00' : '',
          });
        }
        if (preBindOperationNo !== '' && preBindOperationNo !== operation_no) {
          operations.set(preBindOperationNo, {
            operation_no: preBindOperationNo,
            room_no: `OR-BC-PREBIND-${serial}`,
            dept_code,
            status: 'open',
            closed_at: '',
          });
        }

        // 耗材主数据：坏码不建行；未建档 / 停用 / 缺系数 / 费用口径不合规各有各的写法
        if (formAllowsMaterialRow(code_form) && template.material_state !== 'unregistered') {
          const feeCategory = template.material_state === 'fee_invalid' ? '西药' : '卫生材料';
          const insuranceClass = '甲类';
          const ratio = template.material_state === 'ratio_missing' ? '' : '1';
          materials.set(canonical, {
            material_code: canonical,
            name: `边界样例耗材 ${n}`,
            price_code: `PR-BC-${serial}`,
            fee_category: feeCategory,
            medical_insurance_class: insuranceClass,
            active: template.material_state !== 'inactive',
            batch_no: batchNo,
            // 单位口径：1 包 = 1 支（包装即计价）—— 边界矩阵只关心结论，不关心倍数
            unit_pack: '包',
            unit_min: '支',
            charge_unit: '支',
            ratio,
          });
        }

        cases.push({
          case_id: `BC-${String(n).padStart(3, '0')}`,
          template_id: template.id,
          code_form,
          operation_state: template.operation_state,
          ownership: template.ownership,
          material_state: template.material_state,
          charge_outcome: template.charge_outcome,
          quantity,
          raw_code,
          material_code: canonical,
          operation_no,
          room_no,
          dept_code,
          batch_no: caseBatchNo,
          pre_bind_operation_no: preBindOperationNo,
          pre_bind_raw_code: preBindRawCode,
          pre_bind_batch_no: preBindBatchNo,
          expected_conclusion: expected.conclusion,
          expected_reason_code: expected.reason_code ?? '',
          expected_needs_manual: expected.needs_manual,
        });
      }
    }
  }

  const operationsCsv = toCsv(
    ['operation_no', 'room_no', 'dept_code', 'status', 'closed_at'],
    [...operations.values()].map((row) => [
      row.operation_no,
      row.room_no,
      row.dept_code,
      row.status,
      row.closed_at,
    ]),
  );

  const materialsCsv = toCsv(
    [
      'material_code',
      'name',
      'price_code',
      'fee_category',
      'medical_insurance_class',
      'active',
      'batch_no',
      'unit_pack',
      'unit_min',
      'charge_unit',
      'ratio',
    ],
    [...materials.values()].map((row) => [
      row.material_code,
      row.name,
      row.price_code,
      row.fee_category,
      row.medical_insurance_class,
      row.active ? 'true' : 'false',
      row.batch_no,
      row.unit_pack,
      row.unit_min,
      row.charge_unit,
      row.ratio,
    ]),
  );

  const casesCsv = toCsv(
    [
      'case_id',
      'template_id',
      'code_form',
      'operation_state',
      'ownership',
      'material_state',
      'charge_outcome',
      'quantity',
      'raw_code',
      'material_code',
      'operation_no',
      'room_no',
      'dept_code',
      'batch_no',
      'pre_bind_operation_no',
      'pre_bind_raw_code',
      'pre_bind_batch_no',
      'expected_conclusion',
      'expected_reason_code',
      'expected_needs_manual',
    ],
    cases.map((row) => [
      row.case_id,
      row.template_id,
      row.code_form,
      row.operation_state,
      row.ownership,
      row.material_state,
      row.charge_outcome,
      row.quantity,
      row.raw_code,
      row.material_code,
      row.operation_no,
      row.room_no,
      row.dept_code,
      row.batch_no,
      row.pre_bind_operation_no,
      row.pre_bind_raw_code,
      row.pre_bind_batch_no,
      row.expected_conclusion,
      row.expected_reason_code,
      row.expected_needs_manual ? 'true' : 'false',
    ]),
  );

  writeFileSync(resolve(boundaryDir, 'boundary-operations.csv'), operationsCsv, 'utf8');
  writeFileSync(resolve(boundaryDir, 'boundary-materials.csv'), materialsCsv, 'utf8');
  writeFileSync(resolve(boundaryDir, 'boundary-cases.csv'), casesCsv, 'utf8');

  const byConclusion = new Map<string, number>();
  const byReason = new Map<string, number>();
  for (const row of cases) {
    byConclusion.set(row.expected_conclusion, (byConclusion.get(row.expected_conclusion) ?? 0) + 1);
    const reason = row.expected_reason_code || '(BOUND 无原因码)';
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }

  console.log(`边界矩阵用例 ${cases.length} 条 → tests/boundary/boundary-cases.csv`);
  console.log(`台次主数据 ${operations.size} 条 / 耗材主数据 ${materials.size} 条`);
  console.log(
    `预期结论分布：${[...byConclusion.entries()].sort().map(([k, v]) => `${k}=${v}`).join('  ')}`,
  );
  console.log(
    `预期原因码分布：${[...byReason.entries()].sort().map(([k, v]) => `${k}=${v}`).join('  ')}`,
  );
}

/** CSV 转义 */
function cell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header: string[], rows: Array<Array<string | number | boolean>>): string {
  return [header.join(','), ...rows.map((row) => row.map(cell).join(','))].join('\n') + '\n';
}

main();
