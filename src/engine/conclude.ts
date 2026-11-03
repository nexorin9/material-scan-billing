/**
 * 五种绑定结论的归类器：把「耗材码 + 台次 + 院内主数据 + 台账现状」收敛成**唯一**一条结论。
 *
 *   BOUND            —— 绑上了本台次
 *   NOT_REGISTERED   —— 绑不上：耗材码不可用 / 主数据未命中 / 台次查不到
 *   CROSS_OP_DUP     —— 同一耗材已绑在**另一个**台次上（后到者拒，先到者保留）
 *   CLOSED           —— 台次已关台（不自动补录，走人工计费补录）
 *   CHARGE_REJECTED  —— 绑定成立但计费通道业务拒绝（转人工）
 *
 * 判定顺序（**逐层短路**，一条输入永远只落一种结论）：
 *   ① 台次查不到             → NOT_REGISTERED / OPERATION_NOT_FOUND（台次是绑定的锚点）
 *   ② 台次已关台             → CLOSED
 *   ③ 归属双因子核对不过     → NOT_REGISTERED / OPERATION_ATTRIBUTION_CONFLICT
 *                              （事件手术间 / 科室与排台对不上，绑错台就是错账）
 *   ④ 耗材码三层校验不过     → NOT_REGISTERED / 结构层·字典层·业务层各自的原因码
 *   ⑤ 数量换算不成立         → NOT_REGISTERED / QUANTITY_NOT_DIVISIBLE 等（包装数 → 计价单位数）
 *   ⑥ 同一耗材绑在别的台次   → CROSS_OP_DUP
 *   ⑦ 绑定成立但计费通道业务拒绝 → CHARGE_REJECTED
 *   ⑧ 其余                   → BOUND
 *
 * 计费拒绝排在最后：计费是绑定**之后**才发生的动作 —— 绑都没绑上的条目不可能有计费回执，
 * 若这类输入带了计费拒绝，以绑定层的问题为准（那才是护士长要处理的事）。
 *
 * 数量换算排在跨台次重复之前：换不出来的是**这条耗材这一笔的数量口径**（除不尽），
 * 跟归属冲突是两回事，先说清楚「这一笔算不出几个支」，护士长才知道该去查哪一头。
 *
 * **绝不猜绑**：台次缺失、主数据缺失、耗材停用、归属冲突 —— 只要存在歧义，结果一定落在
 * 异常结论上，绝不落到 BOUND。异常条目一律转人工（核查条目），**不自动补录、不自动冲正**。
 *
 * 语义来源（源产品主路径）：源产品按目标实体路由批量唯一消息并**逐条取回执**，
 * 「单条投递失败是普通结果而非中断」。本模块照此语义：一条判定失败只让**这一条**落异常结论，
 * 同批其余照常给结论。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { ConclusionCode } from '../domain/scan-event.js';
import { createCheckTask, type CheckTaskPayload } from '../check/task.js';
import { errorCodeForReason } from '../log/error-codes.js';
import { appendAudit } from '../ledger/audit.js';
import { type MaterialRow } from '../ledger/binding-repo.js';
import {
  resolveOperation,
  REASON_OPERATION_ATTRIBUTION_CONFLICT,
  REASON_OPERATION_CLOSED,
  REASON_OPERATION_NOT_FOUND,
  type AttributionVerdict,
  type OperationResolution,
  type ScannerContext,
} from './operation.js';
import { validateMaterialCode } from './validate-code.js';
import { convertQuantity, type QuantityConversion } from './units.js';

/** 跨台次重复的原因码 */
export const REASON_CROSS_OP_DUPLICATE = 'CROSS_OP_DUPLICATE_MATERIAL';

/** 先到者（同一耗材已绑在别的台次上）的台账上下文 */
export interface DuplicateOrigin {
  /** 先到者的台账行 id */
  binding_id: number;
  /** 先到者的台次 */
  operation_no: string;
  /** 先到者的手术间 */
  room_no: string;
  /** 先到者的科室 */
  dept_code: string;
}

export interface ConcludeInput {
  db: DatabaseSync;
  /** 本次扫码挂的台次 */
  operation_no: string;
  /** 事件里的手术间 */
  room_no: string;
  /** 扫码枪编号 */
  scanner_id?: string | null;
  /**
   * 事件自带的科室上下文（可空）。
   *
   * 有值时与排台的科室一起参与**归属双因子核对**；没值时取扫码枪位置登记簿里
   * 登记的科室（枪固定在哪间手术间，那间就属于某个科室 —— 与手术间相互独立的第二个因子）。
   */
  dept_code?: string | null;
  /** 扫码枪位置登记（可空；没登记则不参与科室因子的核对） */
  scanner?: ScannerContext | null;
  /** 归一后的耗材码 */
  material_code: string;
  /** 设备上报的原始码 */
  raw_code?: string | null;
  /** 数量 */
  quantity?: number | null;
  /** 批号 */
  batch_no?: string | null;
  /** 计费通道给出的业务拒绝（若有） */
  charge_rejection?: { reason_code: string; message?: string } | null;
}

export interface ConclusionResult {
  /** 唯一结论 */
  conclusion: ConclusionCode;
  /** 是否绑上（只有 BOUND 为 true） */
  bound: boolean;
  /** 原因码（BOUND 时为 null） */
  reason_code: string | null;
  /**
   * 统一错误码（ERR_*）：由 reason_code 经错误码表映射而来。
   * 与结构化日志、核查条目、计费回执行展示**同一个码**。
   */
  error_code: string | null;
  /** 中文说明 */
  message: string;
  /** 判定依据（逐条可读，供核查条目与日志归类） */
  basis: string[];
  /** 是否需要人工处置（异常结论一律为 true） */
  needs_manual: boolean;
  /** 命中的耗材主数据 */
  material: MaterialRow | null;
  /** 台次判定结果 */
  operation: OperationResolution | null;
  /** 跨台次重复时的先到者上下文 */
  duplicate_of: DuplicateOrigin | null;
  /** 升核查条目后的条目 id（未升级时为 null） */
  check_task_id: number | null;
  /**
   * 数量换算结果（包装数 → 计价单位数）。
   *
   * 换不出来时（除不尽 / 数量非正）结论落 NOT_REGISTERED 并转人工 —— **不四舍五入、
   * 不静默取整**。绑得上时这里给出计价数量与换算轨迹，随台账行一起落库。
   */
  quantity_conversion: QuantityConversion | null;
  /**
   * 台次归属双因子核对结论（事件手术间 / 科室 vs 排台手术间 / 科室）。
   *
   * 台次查不到时为 null（没有锚点，无从核对）。
   */
  attribution: AttributionVerdict | null;
}

/**
 * 查先到者：同一耗材码已绑在**另一个**台次上。
 * 只看成功绑定的行（conclusion = 'BOUND'）；先到者的记录一律保留，不改不删。
 */
export function findBindingOrigin(
  db: DatabaseSync,
  material_code: string,
  operation_no: string,
): DuplicateOrigin | null {
  const row = db
    .prepare(
      `SELECT id, operation_no, room_no, dept_code
         FROM material_binding
        WHERE material_code = ? AND operation_no <> ? AND conclusion = 'BOUND'
        ORDER BY id ASC LIMIT 1`,
    )
    .get(material_code, operation_no) as
    | { id: number; operation_no: string; room_no: string; dept_code: string }
    | undefined;
  if (!row) return null;
  return {
    binding_id: Number(row.id),
    operation_no: row.operation_no,
    room_no: row.room_no,
    dept_code: row.dept_code,
  };
}

function baseResult(conclusion: ConclusionCode, reason_code: string | null, message: string): ConclusionResult {
  return {
    conclusion,
    bound: conclusion === 'BOUND',
    reason_code,
    error_code: errorCodeForReason(reason_code),
    message,
    basis: [],
    needs_manual: conclusion !== 'BOUND',
    material: null,
    operation: null,
    duplicate_of: null,
    check_task_id: null,
    quantity_conversion: null,
    attribution: null,
  };
}

/**
 * 判定一条扫码：只读不写，产出唯一结论。
 */
export function classify(input: ConcludeInput): ConclusionResult {
  const { db } = input;

  // ① 台次：查不到 / 已关台
  const operation = resolveOperation(db, input.operation_no, {
    room_no: input.room_no,
    dept_code: input.dept_code ?? null,
    scanner: input.scanner ?? null,
  });
  if (operation.status === 'unknown') {
    const result = baseResult(
      'NOT_REGISTERED',
      REASON_OPERATION_NOT_FOUND,
      operation.message ?? `排台台次 ${input.operation_no} 不在手术排台主数据中`,
    );
    result.basis.push('排台主数据里查不到该台次，绑定无锚点，拒绝猜绑');
    result.operation = operation;
    return result;
  }
  if (operation.status === 'closed') {
    const result = baseResult(
      'CLOSED',
      REASON_OPERATION_CLOSED,
      `${operation.message ?? `台次 ${input.operation_no} 已关台`}；本轮不自动补录，请走计费补录（人工）`,
    );
    result.basis.push('台次已关台，不再接受新耗材，转人工补录');
    result.operation = operation;
    result.attribution = operation.attribution;
    return result;
  }

  // ③ 归属双因子核对：事件手术间 / 科室 与排台对不上 → 归属冲突，转人工。
  //   排在耗材码校验之前：锚点错了，先说锚点 —— 护士长要查的是「这台手术对不对」，
  //   而不是「这个耗材码在不在册」。
  const attribution = operation.attribution;
  if (attribution && !attribution.ok) {
    const factors = attribution.mismatches.length > 0 ? attribution.mismatches.join(' / ') : '扫码枪位置登记';
    const result = baseResult(
      'NOT_REGISTERED',
      REASON_OPERATION_ATTRIBUTION_CONFLICT,
      `台次归属冲突：${attribution.detail}；双因子不一致一律不猜绑，转人工核对`,
    );
    result.basis.push(`归属双因子核对未通过（${factors}）：${attribution.detail}`);
    result.operation = operation;
    result.attribution = attribution;
    return result;
  }

  // ④ 耗材码三层校验
  const validation = validateMaterialCode(db, input.material_code, { raw_code: input.raw_code ?? null });
  if (!validation.ok) {
    const layer = validation.failed_layer ?? 'structure';
    const layerLabel = layer === 'structure' ? '结构层' : layer === 'dictionary' ? '字典映射层' : '业务层';
    const result = baseResult(
      'NOT_REGISTERED',
      validation.reason_code,
      validation.message ?? '耗材码校验未通过',
    );
    result.basis.push(`${layerLabel}校验未通过：${validation.message ?? ''}`);
    result.operation = operation;
    result.material = validation.material;
    result.attribution = operation.attribution;
    return result;
  }

  // ⑤ 数量换算：包装数 → 计价单位数。
  //   扫码给的是包装数，计费要的是计价单位数；换不出来（除不尽 / 数量非正）就转人工，
  //   **不四舍五入、不静默取整** —— 换错一个数量就是一次错账。
  const material = validation.material;
  if (!material) {
    // 走到这里说明主数据命中但行取不出来 —— 与其猜，不如转人工
    const result = baseResult('NOT_REGISTERED', 'MATERIAL_NOT_REGISTERED', '耗材主数据行取不出来，无法核对单位口径');
    result.basis.push('耗材主数据行取不出来（字典映射层虽已命中），转人工核对');
    result.operation = operation;
    result.attribution = operation.attribution;
    return result;
  }
  const conversion = convertQuantity(
    input.quantity ?? 1,
    {
      unit_pack: material.unit_pack,
      unit_min: material.unit_min,
      charge_unit: material.charge_unit,
      ratio: material.ratio,
    },
    validation.code,
  );
  if (!conversion.ok) {
    const result = baseResult(
      'NOT_REGISTERED',
      conversion.reason_code,
      conversion.message ?? '数量按包装换算成计价单位失败',
    );
    result.basis.push(`数量换算未通过：${conversion.message ?? ''}`);
    result.operation = operation;
    result.material = validation.material;
    result.quantity_conversion = conversion;
    result.attribution = operation.attribution;
    return result;
  }

  // ⑥ 跨台次重复：同一耗材已绑在别的台次上
  const origin = findBindingOrigin(db, validation.code, input.operation_no);
  if (origin) {
    const result = baseResult(
      'CROSS_OP_DUP',
      REASON_CROSS_OP_DUPLICATE,
      `耗材 ${validation.code} 已绑定台次 ${origin.operation_no}（手术间 ${origin.room_no}），本台次 ${input.operation_no} 为后到者，拒绝重复绑定`,
    );
    result.basis.push(
      `同一耗材已绑在台次 ${origin.operation_no}（手术间 ${origin.room_no}），先到者记录保留，后到者转人工`,
    );
    result.operation = operation;
    result.material = validation.material;
    result.duplicate_of = origin;
    result.quantity_conversion = conversion;
    result.attribution = operation.attribution;
    return result;
  }

  // ⑦ 绑定成立，但计费通道给了业务拒绝
  if (input.charge_rejection) {
    const rejected = baseResult(
      'CHARGE_REJECTED',
      input.charge_rejection.reason_code,
      input.charge_rejection.message ?? `计费通道业务拒绝：${input.charge_rejection.reason_code}`,
    );
    rejected.basis.push(
      `绑定成立（耗材 ${validation.code} → 台次 ${input.operation_no}），但计费通道返回业务拒绝 ${input.charge_rejection.reason_code}`,
    );
    rejected.operation = operation;
    rejected.material = validation.material;
    rejected.quantity_conversion = conversion;
    rejected.attribution = operation.attribution;
    return rejected;
  }

  // ⑧ 绑上
  const result = baseResult('BOUND', null, `耗材 ${validation.code} 绑定台次 ${input.operation_no}`);
  result.basis.push(
    `耗材 ${validation.code} 在主数据中命中且启用，绑定台次 ${input.operation_no}（手术间 ${operation.room_no ?? input.room_no}）`,
  );
  result.operation = operation;
  result.material = validation.material;
  result.quantity_conversion = conversion;
  result.attribution = operation.attribution;
  return result;
}

/**
 * 判定 + 落「核查条目」。
 *
 * 异常结论（NOT_REGISTERED / CROSS_OP_DUP / CLOSED / CHARGE_REJECTED）一律升成带台次上下文的
 * 核查条目，交人工处置；BOUND 不写核查条目（台账行由结算层写）。
 */
export function concludeAndRecord(db: DatabaseSync, input: ConcludeInput): ConclusionResult {
  const result = classify(input);
  if (result.conclusion === 'BOUND') return result;

  const attribution = result.attribution;

  // 配置漂移单独记一行审计：登记簿说这把枪在 A 间、事件却说自己来自 B 间 ——
  // 这是**配置问题**（枪挪了间 / 登记过期 / 事件不是这台枪发的），要能回看。
  // 归属冲突本身已经由核查条目承载，这里补的是「为什么会漂移」的痕迹。
  if (attribution?.config_drift) {
    appendAudit(db, {
      event_type: 'scanner_config_drift',
      operation_no: input.operation_no,
      scanner_id: input.scanner_id ?? null,
      actor: 'binding_engine',
      detail: JSON.stringify({
        scanner_id: input.scanner_id ?? null,
        registered_room_no: input.scanner?.room_no ?? null,
        event_room_no: attribution.event_room_no,
        master_room_no: attribution.master_room_no,
        mismatches: attribution.mismatches,
        reason_code: result.reason_code,
        error_code: result.error_code,
      }),
    });
    result.basis.push(
      `扫码枪位置登记与事件不一致（登记 ${input.scanner?.room_no ?? '未登记'} / 事件 ${attribution.event_room_no ?? '未提供'}），已记审计`,
    );
  }

  const payload: CheckTaskPayload = {
    operation_no: input.operation_no,
    room_no: input.room_no,
    dept_code: result.operation?.dept_code ?? null,
    scanner_id: input.scanner_id ?? null,
    material_code: input.material_code.trim(),
    quantity: input.quantity ?? null,
    conclusion: result.conclusion,
    reason_code: result.reason_code ?? 'UNKNOWN',
    error_code: result.error_code,
    source_operation_no: result.duplicate_of?.operation_no ?? null,
    source_room_no: result.duplicate_of?.room_no ?? null,
    // 归属核对的两侧都留痕：事后能核对「当时到底对的是哪两个手术间 / 科室」
    event_room_no: attribution?.event_room_no ?? input.room_no,
    master_room_no: attribution?.master_room_no ?? result.operation?.room_no ?? null,
    event_dept_code: attribution?.event_dept_code ?? input.dept_code ?? null,
    master_dept_code: attribution?.master_dept_code ?? result.operation?.dept_code ?? null,
  };
  result.check_task_id = createCheckTask(db, payload);
  result.basis.push(`已升为核查条目 #${result.check_task_id}，待人工落定结论`);
  return result;
}
