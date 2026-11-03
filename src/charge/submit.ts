/**
 * 出站业务层：把一条台次的耗材使用明细组装成 HIS 计费请求并提交。
 *
 * 请求体字段与 spec.md「最小数据格式与字段要求」**逐字一致**，
 * 并按「对端也幂等」的口径补了两个键字段：
 *   {operation_no, dept_code, idempotency_key, key_profile,
 *    uses:[{material_code, quantity, price_code, use_time, fee_category,
 *           medical_insurance_class, idempotency_key, key_profile}]}
 * 响应体：{accepted:[{material_code, idempotency_key?}],
 *          rejected:[{material_code, reason_code, idempotency_key?}], idempotency_key?}
 *
 * 语义来源（源产品主路径）：源产品按目标实体批量投递并**逐条取回执**；
 * 源把「同一条消息」的唯一身份写在消息本体里（内容 + 目标实体 + 消息类型），
 * 收方据此认得「这条我见过了」。本层照此语义补上**键透传**：
 * 本侧派生的幂等键随请求发给对端，对端按同一把键去重 ——
 * 单侧幂等只挡得住「自己重复发」，挡不住「对端重试后补发」。
 *
 * 硬约束：
 *   ① 端点路径来自配置（不在产品代码里硬编码），基址与令牌只在客户端里；
 *   ② 请求体字段名逐字对齐规范 —— 改名会静默丢计费条目，故此处逐字段校验；
 *      校验分**两层闸门**：形状层（必填 / 数量 / 超长）+ 契约层
 *      （`src/api/contracts.ts` 的字段契约：类型 / 枚举 / 长度 / 全量违规清单）；
 *      响应回来后同样过契约闸门 —— 形状不符按「对端协议不符」进重投，不静默当成成功；
 *   ③ 响应结构不符按「对端协议不符」抛错，**不静默当成成功**；
 *   ④ 失败不静默改数据：这里只负责发与收，台账状态由上层推进；
 *   ⑤ **键与重试次数无关**：重投复用同一把键，对端据此认得这是同一笔。
 */

import {
  checkFieldLength,
  defaultFieldLengthLimits,
  MATERIAL_USE_CONTRACT,
  MATERIAL_USES_REQUEST_CONTRACT,
  MATERIAL_USES_RESPONSE_CONTRACT,
  renderViolations,
  validateAgainst,
  type ContractViolation,
  type FieldLengthLimits,
} from '../api/contracts.js';
import {
  DEFAULT_IDEMPOTENCY_KEY_PROFILE,
  deriveIdempotencyKeyForProfile,
  deriveRequestIdempotencyKey,
  type ConfigurableIdempotencyKeyProfile,
} from '../domain/idempotency.js';
import { CHARGE_ERROR_CODES, ChargeError, type HisChargingClient } from './client.js';

/** 一条耗材使用明细（出站字段，逐字对齐 spec.md） */
export interface MaterialUse {
  /** 院内耗材码 */
  material_code: string;
  /** 使用数量（正整数，计价单位口径由主数据换算后给出） */
  quantity: number;
  /** 价码（院内耗材主数据的价格编码） */
  price_code: string;
  /** 使用时间（ISO 8601） */
  use_time: string;
  /** 费用类别（如「卫生材料」） */
  fee_category: string;
  /** 医保分类（甲类 / 乙类 / 自费 / 其他） */
  medical_insurance_class: string;
  /**
   * **行级幂等键**：这一笔耗材消费的去重键。
   *
   * 与该条台账行绑定（台账 `material_binding.idempotency_key`）——
   * **不因重试次数变化而改键**，对端按这把键认得「这条我见过了」。
   * 缺省时由本层按档位现派生（此时退化成 v1 口径：批号未知不细分）。
   */
  idempotency_key?: string | null;
  /** 行级键档位（v1 / v2；历史台账行为 legacy，只读透传） */
  key_profile?: string | null;
}

/** 出站请求体 */
export interface MaterialUsesRequest {
  operation_no: string;
  dept_code: string;
  /** **请求级幂等键**：整批提交的去重键（对端据此丢弃重复请求） */
  idempotency_key: string;
  /** **请求级键档位**：对端按版本灰度（v1 / v2） */
  key_profile: string;
  uses: MaterialUse[];
}

/** 提交前的请求草稿（还没算键；供本地逐字段校验用） */
export interface MaterialUsesDraft {
  operation_no: string;
  dept_code: string;
  uses: readonly MaterialUse[];
}

/** 出站响应体：逐条结论 */
export interface MaterialUsesResponse {
  accepted: Array<{ material_code: string; idempotency_key?: string | null }>;
  rejected: Array<{ material_code: string; reason_code: string; idempotency_key?: string | null }>;
  /** 对端回显的**请求级**键（对端未启用幂等时为空） */
  idempotency_key?: string | null;
}

export interface SubmitMaterialUsesOptions {
  /** 端点路径（来自配置项 HIS_CHARGING_MATERIAL_USES_PATH，不在产品代码里硬编码） */
  path: string;
  /** 关键字段长度上限表（默认取 `src/api/contracts.ts` 的出站契约） */
  limits?: FieldLengthLimits;
  /**
   * 本次请求使用的键档位（默认 v1；来自配置项 IDEMPOTENCY_KEY_PROFILE）。
   *
   * 注意：**只影响没有台账键的条目**（现派生）。已经绑上台账的行按行上的键透传，
   * 档位跟着那一行走 —— 老账不会被新档位改写。
   */
  keyProfile?: ConfigurableIdempotencyKeyProfile;
}

/** 请求体字段名（逐字对齐规范，用于自检与文档比对） */
export const MATERIAL_USES_REQUEST_FIELDS = [
  'operation_no',
  'dept_code',
  'idempotency_key',
  'key_profile',
  'uses',
] as const;

/** 单条明细的字段名（逐字对齐规范） */
export const MATERIAL_USE_FIELDS = [
  'material_code',
  'quantity',
  'price_code',
  'use_time',
  'fee_category',
  'medical_insurance_class',
  'idempotency_key',
  'key_profile',
] as const;

function requireText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) {
    throw new ChargeError({
      kind: 'request_invalid',
      message: `计费请求字段 ${field} 为空`,
    });
  }
  return text;
}

/**
 * 一条字段校验问题（**不抛异常**，返回给调用方逐条处置）。
 *
 * 为什么要有「返回问题」这种形态：分批提交时，一条明细的字段超长只该拒**那一条**，
 * 同批其余条目照常发。抛异常会把整批都拖下水 —— 那就不是「分批独立结算」了。
 */
export interface FieldIssue {
  /** 明细下标（请求级字段为 -1） */
  index: number;
  /** 耗材码（请求级字段为空串） */
  material_code: string;
  /** 字段名 */
  field: string;
  /** 错误码（ERR_CHARGE_REQUEST_INVALID / ERR_CHARGE_FIELD_TOO_LONG） */
  error_code: string;
  /** 中文说明 */
  message: string;
}

/** 请求级字段（台次号 / 科室编码）的长度校验 */
export function inspectEnvelopeFields(
  request: MaterialUsesDraft,
  limits: FieldLengthLimits = defaultFieldLengthLimits(),
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const field of ['operation_no', 'dept_code'] as const) {
    const value = request[field];
    if (typeof value !== 'string' || value.trim().length === 0) continue; // 空值另有错误码
    const check = checkFieldLength(field, value, limits);
    if (!check.exceeded) continue;
    issues.push({
      index: -1,
      material_code: '',
      field,
      error_code: CHARGE_ERROR_CODES.fieldTooLong,
      message: `计费请求字段 ${field} 长度 ${check.actual} 超过上限 ${check.limit}`,
    });
  }
  return issues;
}

/** 幂等键的长度上限（sha256 十六进制 = 64 字符；超长即格式非法） */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 64;

/** 键档位的长度上限（v1 / v2 / legacy） */
export const KEY_PROFILE_MAX_LENGTH = 16;

/** 单条明细的逐字段校验（空值 / 数量 / 时间 + 长度上限） */
export function inspectMaterialUse(
  use: MaterialUse,
  index: number,
  limits: FieldLengthLimits = defaultFieldLengthLimits(),
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const materialCode = typeof use?.material_code === 'string' ? use.material_code : '';
  const push = (field: string, message: string, errorCode: string): void => {
    issues.push({ index, material_code: materialCode, field, error_code: errorCode, message });
  };

  for (const field of [
    'material_code',
    'price_code',
    'fee_category',
    'medical_insurance_class',
  ] as const) {
    const value = use?.[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      push(field, `计费请求字段 uses[${index}].${field} 为空`, CHARGE_ERROR_CODES.requestInvalid);
      continue;
    }
    const check = checkFieldLength(field, value, limits);
    if (check.exceeded) {
      // 超长即拒，**不截断后照发**：截断过的耗材码就是另一个耗材
      push(
        field,
        `计费请求字段 uses[${index}].${field} 长度 ${check.actual} 超过上限 ${check.limit}`,
        CHARGE_ERROR_CODES.fieldTooLong,
      );
    }
  }

  // 键字段：**不截断后照发**（截断过的键就是另一把键，对端会去重到别的账上）
  for (const field of ['idempotency_key', 'key_profile'] as const) {
    const value = use?.[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      push(field, `计费请求字段 uses[${index}].${field} 为空`, CHARGE_ERROR_CODES.requestInvalid);
      continue;
    }
    const cap = field === 'idempotency_key' ? IDEMPOTENCY_KEY_MAX_LENGTH : KEY_PROFILE_MAX_LENGTH;
    if (value.trim().length > cap) {
      push(
        field,
        `计费请求字段 uses[${index}].${field} 长度 ${value.trim().length} 超过上限 ${cap}`,
        CHARGE_ERROR_CODES.fieldTooLong,
      );
    }
  }

  if (!Number.isInteger(use?.quantity) || (use?.quantity ?? 0) <= 0) {
    push('quantity', `计费请求字段 uses[${index}].quantity 必须是正整数`, CHARGE_ERROR_CODES.requestInvalid);
  }
  if (Number.isNaN(Date.parse(use?.use_time ?? ''))) {
    push('use_time', `计费请求字段 uses[${index}].use_time 无法解析`, CHARGE_ERROR_CODES.requestInvalid);
  }

  return issues;
}

/** 整份请求的校验结果：请求级问题 + 逐条问题 + 合法明细（保持原顺序，带原下标） */
export interface MaterialUsesInspection {
  /** 请求级问题（台次号 / 科室编码） */
  envelope_issues: FieldIssue[];
  /** 逐条明细的问题 */
  item_issues: FieldIssue[];
  /** 合法明细（保持原顺序） */
  valid_uses: Array<{ use: MaterialUse; index: number }>;
}

/** 不抛异常的整份请求校验：把「哪些条目能发、哪些不能」一次性说清楚 */
export function inspectMaterialUsesRequest(
  request: MaterialUsesDraft,
  limits: FieldLengthLimits = defaultFieldLengthLimits(),
): MaterialUsesInspection {
  const envelope_issues = inspectEnvelopeFields(request, limits);
  const item_issues: FieldIssue[] = [];
  const valid_uses: Array<{ use: MaterialUse; index: number }> = [];

  const uses = Array.isArray(request.uses) ? request.uses : [];
  uses.forEach((use, index) => {
    const issues = inspectMaterialUse(use, index, limits);
    if (issues.length === 0) valid_uses.push({ use, index });
    else item_issues.push(...issues);
  });

  return { envelope_issues, item_issues, valid_uses };
}

/** 提交前的逐字段校验：不合规就不发请求（不截断、不填默认值糊过去） */
export function validateMaterialUsesRequest(
  request: MaterialUsesRequest,
  options: { limits?: FieldLengthLimits } = {},
): void {
  const limits = options.limits ?? defaultFieldLengthLimits();
  requireText(request.operation_no, 'operation_no');
  requireText(request.dept_code, 'dept_code');
  requireText(request.idempotency_key, 'idempotency_key');
  requireText(request.key_profile, 'key_profile');
  if (!Array.isArray(request.uses)) {
    throw new ChargeError({ kind: 'request_invalid', message: '计费请求字段 uses 不是数组' });
  }
  const envelopeIssues = inspectEnvelopeFields(request, limits);
  const firstEnvelope = envelopeIssues[0];
  if (firstEnvelope) {
    throw new ChargeError({
      kind: 'field_too_long',
      message: firstEnvelope.message,
      detail: `${firstEnvelope.field}: ${firstEnvelope.message}`,
    });
  }
  request.uses.forEach((use, index) => {
    const issues = inspectMaterialUse(use, index, limits);
    const first = issues[0];
    if (!first) return;
    const kind = first.error_code === CHARGE_ERROR_CODES.fieldTooLong ? 'field_too_long' : 'request_invalid';
    throw new ChargeError({
      kind,
      message: first.message,
      detail: `${first.field}: ${first.message}`,
    });
  });
}

/**
 * 出站请求的**字段契约**校验（第二层闸门）。
 *
 * 两层闸门，分工不同：
 *   ① **形状层**（`validateMaterialUsesRequest`）—— 必填缺失 / 数量非正整数 / 超长，
 *      抛第一个问题就停，错误码是 `ERR_CHARGE_REQUEST_INVALID` / `ERR_CHARGE_FIELD_TOO_LONG`；
 *   ② **契约层**（本函数）—— 字段名、类型、必填、枚举、长度上限逐条比对，
 *      一次给出**全部**违规项（字段名 + 期望 + 实际），错误码是独立的
 *      `ERR_CHARGE_CONTRACT_VIOLATION`。
 *
 * 契约层能抓住形状层抓不到的一类问题：**取值越界** —— 费用类别不在院内 14 类内、
 * 医保分类不是甲/乙/丙、键档位不是 v1/v2/legacy。这类问题字段名和类型都对，
 * 发过去对端多半照收，然后**记到错误的分区** —— 比直接拒收更坏。
 *
 * @param request 出站请求体
 * @returns 违规项清单（空数组 = 合规）
 */
export function validateMaterialUsesContract(request: unknown): ContractViolation[] {
  return validateAgainst(MATERIAL_USES_REQUEST_CONTRACT, request);
}

/** 契约层的一条问题（**不抛异常**，逐条处置用） */
export interface ContractItemIssue {
  /** 明细下标 */
  index: number;
  /** 耗材码 */
  material_code: string;
  /** 字段名（如 `fee_category`） */
  field: string;
  /** 字段路径（如 `uses[0].fee_category`） */
  path: string;
  /** 错误码（`ERR_CHARGE_CONTRACT_VIOLATION`） */
  error_code: string;
  /** 中文说明（带「字段名 + 期望 + 实际」逐项清单） */
  message: string;
}

/**
 * 契约层的**逐条**检查：哪些明细不符合出站字段契约。
 *
 * 为什么逐条判、而不是整份请求一起判：
 *   一条明细的取值越界（费用类别不在院内 14 类内、医保分类不是甲乙丙、
 *   键档位不认识）不该把同批其余条目一起拖下水 —— 同批其它耗材的字段全是对的。
 *   整份请求一起判会把它们也判成「不合规」，那些耗材就再也计不上费：
 *   一次字段错误拖垮一台手术的计费，与「单条失败不丢同批其余」的口径正好相反。
 *
 * 键字段按**实际发出的样子**校验：
 *   行级幂等键与键档位在这一步现派生（与 `prepareMaterialUsesRequest` 同一把尺子），
 *   否则「台账行还没绑键」会被误判成「缺必填字段」。
 *   台账行带来的键档位若是产品不认识的取值（如历史导入行），
 *   这里会判成枚举越界 —— 键的派生口径不明就发出去，对端没法正确去重。
 *
 * @param operation_no 台次号（参与键派生）
 * @param uses 待检查的明细
 * @param options.keyProfile 现派生键时用的档位（默认 v1）
 */
export function inspectMaterialUsesContractItems(
  operation_no: string,
  uses: readonly MaterialUse[],
  options: { keyProfile?: ConfigurableIdempotencyKeyProfile } = {},
): ContractItemIssue[] {
  const issues: ContractItemIssue[] = [];
  uses.forEach((use, index) => {
    // 按出站实际发出的样子补齐键字段，再逐字段比契约
    const prepared = prepareMaterialUsesRequest(operation_no, '', [use], {
      keyProfile: options.keyProfile,
    });
    const item = prepared.request.uses[0];
    if (!item) return;
    const violations = validateAgainst(MATERIAL_USE_CONTRACT, item);
    if (violations.length === 0) return;
    const first = violations[0]!;
    issues.push({
      index,
      material_code: item.material_code,
      field: first.field,
      path: first.path,
      error_code: CHARGE_ERROR_CODES.contractViolation,
      message: renderViolations(violations),
    });
  });
  return issues;
}

/**
 * 出站响应的**字段契约**校验：对端回执的形状不符就是「对端协议不符」。
 *
 * 契约层抓得到的三类问题：
 *   ① 顶层缺 `accepted` / `rejected`（或不是数组）；
 *   ② `rejected[]` 里缺 `reason_code` —— 没有原因码就无法定处置档位
 *      （可重投 / 不可重投 / 需人工），只能靠猜；
 *   ③ 元素类型不对（`material_code` 不是字符串）。
 */
export function validateMaterialUsesResponseContract(payload: unknown): ContractViolation[] {
  return validateAgainst(MATERIAL_USES_RESPONSE_CONTRACT, payload);
}

/** 响应结构校验：必须是 {accepted:[...], rejected:[...]}，否则按协议不符处理 */
export function validateMaterialUsesResponse(payload: unknown): MaterialUsesResponse {
  if (typeof payload !== 'object' || payload === null) {
    throw new ChargeError({
      kind: 'response_invalid',
      message: 'HIS 计费响应不是对象',
    });
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record['accepted']) || !Array.isArray(record['rejected'])) {
    throw new ChargeError({
      kind: 'response_invalid',
      message: 'HIS 计费响应缺少 accepted / rejected 数组',
    });
  }
  const requestKey = (record['idempotency_key'] ?? '').toString().trim();
  return {
    accepted: (
      record['accepted'] as Array<{ material_code: string; idempotency_key?: string | null }>
    ).map((item) => {
      const materialCode = String(item?.material_code ?? '');
      // 对端回显的键：**没回显就没有这个字段**（不是「键是空的」，是「对端没回显」）
      const echoed = (item?.idempotency_key ?? '').toString().trim();
      return echoed.length > 0
        ? { material_code: materialCode, idempotency_key: echoed }
        : { material_code: materialCode };
    }),
    rejected: (
      record['rejected'] as Array<{
        material_code: string;
        reason_code: string;
        idempotency_key?: string | null;
      }>
    ).map((item) => {
      const materialCode = String(item?.material_code ?? '');
      const reasonCode = String(item?.reason_code ?? 'UNKNOWN');
      const echoed = (item?.idempotency_key ?? '').toString().trim();
      return echoed.length > 0
        ? { material_code: materialCode, reason_code: reasonCode, idempotency_key: echoed }
        : { material_code: materialCode, reason_code: reasonCode };
    }),
    ...(requestKey.length > 0 ? { idempotency_key: requestKey } : {}),
  };
}

/** 键准备结果：请求体 + 本次用的两把键 */
export interface PreparedMaterialUses {
  /** 完整请求体（含请求级键与逐条行级键） */
  request: MaterialUsesRequest;
  /** 行级键（与 `request.uses` 逐条对齐） */
  line_keys: string[];
  /** 请求级键 */
  request_key: string;
  /** 请求级键档位 */
  key_profile: string;
}

/**
 * 组装出站请求体：**把键算好并填进去**。
 *
 * 两条口径：
 *   ① **行级键优先用台账行带来的那把**（`use.idempotency_key`）——
 *      它是这条耗材消费在台账里的身份，重投时复用同一把，对端据此去重；
 *   ② 没有台账键时才现派生（退化成 v1 口径：批号未知不细分，少算但不重复计费）。
 *
 * 请求级键由行级键集合派生（`deriveRequestIdempotencyKey`）：
 * 同一批条目重投时行级键不变 → 请求级键也不变。
 */
export function prepareMaterialUsesRequest(
  operation_no: string,
  dept_code: string,
  uses: readonly MaterialUse[],
  options: { keyProfile?: ConfigurableIdempotencyKeyProfile } = {},
): PreparedMaterialUses {
  const profile = options.keyProfile ?? DEFAULT_IDEMPOTENCY_KEY_PROFILE;
  const prepared: MaterialUse[] = uses.map((use) => {
    const boundKey = (use.idempotency_key ?? '').trim();
    const boundProfile = (use.key_profile ?? '').trim();
    if (boundKey.length > 0) {
      return { ...use, idempotency_key: boundKey, key_profile: boundProfile || profile };
    }
    const derived = deriveIdempotencyKeyForProfile(
      { material_code: use.material_code, operation_no },
      profile,
    );
    return { ...use, idempotency_key: derived.key, key_profile: derived.profile };
  });

  const lineKeys = prepared.map((use) => (use.idempotency_key ?? '').trim()).filter((key) => key.length > 0);
  const requestKey = deriveRequestIdempotencyKey(operation_no, lineKeys);

  return {
    request: {
      operation_no,
      dept_code,
      idempotency_key: requestKey.key,
      key_profile: profile,
      uses: prepared,
    },
    line_keys: lineKeys,
    request_key: requestKey.key,
    key_profile: profile,
  };
}

/**
 * 把**已准备好的**请求体发出去并解析响应（校验 + 出站 HTTP 都在这里）。
 *
 * 单独拆出来是因为分批提交需要「请求体在失败时也拿得到」：
 * 批次整体失败（超时 / 5xx）时回执仍要记下这一批的请求级键，
 * 否则事后查不出「这一批到底发了什么」。
 */
export async function postPreparedMaterialUses(
  client: HisChargingClient,
  prepared: PreparedMaterialUses,
  options: { path: string; limits?: FieldLengthLimits },
): Promise<MaterialUsesResponse> {
  // ① 形状层闸门：必填 / 数量 / 超长（口径与历史一致，错误码不变）
  validateMaterialUsesRequest(prepared.request, { limits: options.limits });
  // ② 契约层闸门：枚举越界等取值问题 —— 不合规则**不外发**，给独立错误码
  const requestViolations = validateMaterialUsesContract(prepared.request);
  if (requestViolations.length > 0) {
    throw new ChargeError({
      kind: 'contract_violation',
      message: `计费请求不符合出站字段契约（${requestViolations.length} 项）：${renderViolations(requestViolations)}`,
      detail: renderViolations(requestViolations),
    });
  }
  const payload = await client.postJson<unknown>(options.path, prepared.request);
  // ③ 响应契约闸门：对端回执形状不符 = 对端协议不符 —— 按可重投处理，不静默当成成功
  const responseViolations = validateMaterialUsesResponseContract(payload);
  if (responseViolations.length > 0) {
    throw new ChargeError({
      kind: 'response_invalid',
      message: `HIS 计费响应不符合回执契约（${responseViolations.length} 项）：${renderViolations(responseViolations)}`,
      detail: renderViolations(responseViolations),
    });
  }
  return validateMaterialUsesResponse(payload);
}

/**
 * 提交一台次的耗材使用明细到 HIS 计费。
 *
 * @param client 出站客户端（凭据单一出口：业务层拿不到令牌）
 * @param operation_no 台次号
 * @param dept_code 科室编码
 * @param uses 耗材使用明细
 * @param options.path 端点路径（来自配置）
 */
export async function submitMaterialUses(
  client: HisChargingClient,
  operation_no: string,
  dept_code: string,
  uses: readonly MaterialUse[],
  options: SubmitMaterialUsesOptions,
): Promise<MaterialUsesResponse> {
  const prepared = prepareMaterialUsesRequest(operation_no, dept_code, uses, {
    keyProfile: options.keyProfile,
  });
  return postPreparedMaterialUses(client, prepared, options);
}

/** 使用时间取当前时刻（ISO 8601）；调用方可显式传 use_time 覆盖 */
export function nowUseTime(now: Date = new Date()): string {
  return now.toISOString();
}
