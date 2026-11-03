/**
 * 计费回执层：把 HIS 计费的响应拆成**逐条**回执并落进回执台账。
 *
 * 语义来源（源产品主路径）：源产品的投递回执是 `MessageReceipt { user_id, delivery_count, active }`
 * —— 每条消息一份回执，回执带**投递次数**与**通道当时是否可达**；源注释明示
 * 「单条投递失败是普通结果而非中断」，不得丢弃已产生的回执。
 * 本模块照此语义改写成耗材计费场景：
 *
 *   - 一条耗材一次投递 → 一行回执（accepted / rejected + reason_code）；
 *   - 回执行带 `delivery_count`（累计投递次数 = 重投了几次）与 `channel_reachable`；
 *   - **通道当时不可达**（超时 / 连接失败 / 5xx）与**通道可达但对端业务拒绝**分开定性：
 *     前者可重投，后者不可重投、直接转人工核查；
 *   - 对端没给结论（回执缺这条）按「协议不符」处理，**不静默当成成功**。
 *
 * 硬约束：
 *   ① 回执台账**只增不改**：每次尝试追加一行，不覆盖历史（attempt 序号连续）；
 *   ② 同一把幂等键的重投**复用同一把键**，回执行里带上键与键版本，便于事后反查；
 *   ③ 回执里不出现患者可识别字段（耗材码只绑台次）。
 */

import type { DatabaseSync } from 'node:sqlite';

import { appendAudit } from '../ledger/audit.js';
import { registerPendingErrorCode } from '../log/error-codes.js';
import { CHARGE_ERROR_CODES, ChargeError } from './client.js';
import {
  RECEIPT_DISPOSITIONS,
  REASON_EMPTY_RECEIPT,
  REASON_MISSING_RECEIPT,
  disposeReceiptReason,
  isKnownReceiptReason,
  type ReceiptDisposition,
} from './reason-codes.js';
import type { MaterialUse, MaterialUsesResponse } from './submit.js';

export { REASON_MISSING_RECEIPT } from './reason-codes.js';

/** 回执定性：一条耗材一次投递的结果归到哪一档 */
export const CHARGE_RECEIPT_KINDS = {
  /** 对端已接收 */
  accepted: 'ACCEPTED',
  /** 通道可达但对端业务拒绝（不可重投） */
  business_rejected: 'BUSINESS_REJECTED',
  /** 通道当时不可达（超时 / 连接失败） */
  channel_unreachable: 'CHANNEL_UNREACHABLE',
  /** 通道可达但对端 5xx */
  channel_error: 'CHANNEL_ERROR',
  /** 响应结构不符 / 对端没给这条的结论 */
  protocol_error: 'PROTOCOL_ERROR',
  /** 本侧配置或请求体问题（请求根本没发出去） */
  local_error: 'LOCAL_ERROR',
} as const;

export type ChargeReceiptKind = (typeof CHARGE_RECEIPT_KINDS)[keyof typeof CHARGE_RECEIPT_KINDS];

/**
 * 对端**回显幂等键**的三种情况。
 *
 * 本侧把幂等键透传给 HIS 计费侧（见 `src/charge/submit.ts`），对端据此去重；
 * 回执里必须写清「对端到底认没认这把键」——
 *   ECHOED     —— 对端把同一把键回显了回来（对端已启用幂等去重）；
 *   NOT_ECHOED —— 对端没回显（**对端未启用幂等**）：本侧仍保证单侧幂等，
 *                 但重复投递的去重责任落在对端之外，靠本侧台账与占位层兜底；
 *   MISMATCH   —— 对端回显了**另一把**键：两端口径不一致（对端可能回显的是
 *                 它自己的计费流水号），留痕由信息科与对端确认，不当成重复计费。
 */
export const PEER_IDEMPOTENCY_STATUS = {
  echoed: 'ECHOED',
  not_echoed: 'NOT_ECHOED',
  mismatch: 'MISMATCH',
} as const;

export type PeerIdempotencyStatus =
  (typeof PEER_IDEMPOTENCY_STATUS)[keyof typeof PEER_IDEMPOTENCY_STATUS];

/** 本侧内部异常（非 ChargeError）的兜底错误码 */
export const CHARGE_INTERNAL_ERROR_CODE = 'ERR_CHARGE_INTERNAL';

/**
 * 一次投递失败的定性：**通道当时可达否 / 值不值得重投**。
 *
 * 这是回执分流的总闸：可重投 → 进指数退避队列；不可重投 → 直接转人工核查条目。
 */
export interface ChargeFailureClass {
  /** 归到哪一档 */
  kind: ChargeReceiptKind;
  /** 本侧错误码（ERR_CHARGE_*）；对端业务拒绝时为 null */
  error_code: string | null;
  /** 归类原因码（落回执行，逐条可追踪） */
  reason_code: string;
  /** 通道当时是否可达 */
  channel_reachable: boolean;
  /** 值不值得重投 */
  retryable: boolean;
  /**
   * 处置档位（可重投 / 不可重投 / 需人工）。
   *
   * 通道层面的失败（超时 / 连接失败 / 5xx / 响应结构不符）一律可重投；
   * 本侧配置或请求体问题（请求根本没发出去）不可重投、也不需要人工判读对端口径。
   */
  disposition: ReceiptDisposition;
  /** 中文说明 */
  message: string;
}

/**
 * 把出站异常定性成「可达否 / 可重投否」。
 *
 * 关键区分：**响应超时 / 连接超时 / 连接失败 / 熔断打开 = 通道当时不可达**
 * （对端多半没收到，值得重投）；**对端 4xx / 业务拒绝 = 通道可达但对端不收**
 * （重投没有意义，直接转人工）。
 */
export function classifyFailure(error: unknown): ChargeFailureClass {
  if (error instanceof ChargeError) {
    switch (error.kind) {
      case 'timeout':
      case 'connect_timeout':
      // 熔断打开：请求根本没发出去 —— 通道当时不可达，条目照常进退避重投队列
      case 'circuit_open':
      case 'network':
        return {
          kind: CHARGE_RECEIPT_KINDS.channel_unreachable,
          error_code: error.code,
          reason_code: error.code,
          channel_reachable: false,
          retryable: true,
          disposition: RECEIPT_DISPOSITIONS.RETRYABLE,
          message: error.message,
        };
      case 'server_error':
        return {
          kind: CHARGE_RECEIPT_KINDS.channel_error,
          error_code: error.code,
          reason_code: error.code,
          channel_reachable: true,
          retryable: true,
          disposition: RECEIPT_DISPOSITIONS.RETRYABLE,
          message: error.message,
        };
      case 'response_invalid':
        // 响应结构不符 = **没法确认对端到底记没记这一笔**：
        // 按「通道不可达」定性（不是「成功」也不是「对端拒收」），
        // 进退避重投队列；重投复用同一把幂等键，对端据此去重，不会重复计费。
        return {
          kind: CHARGE_RECEIPT_KINDS.protocol_error,
          error_code: error.code,
          reason_code: error.code,
          channel_reachable: false,
          retryable: true,
          disposition: RECEIPT_DISPOSITIONS.RETRYABLE,
          message: error.message,
        };
      case 'client_error':
        return {
          kind: CHARGE_RECEIPT_KINDS.business_rejected,
          error_code: error.code,
          reason_code: error.code,
          channel_reachable: true,
          retryable: false,
          disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
          message: error.message,
        };
      case 'request_invalid':
      // 契约不符：字段取值越界（枚举 / 长度 / 类型）—— 重投多少次还是不合规，转人工
      case 'contract_violation':
      case 'config':
      default:
        return {
          kind: CHARGE_RECEIPT_KINDS.local_error,
          error_code: error.code,
          reason_code: error.code,
          channel_reachable: false,
          retryable: false,
          disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
          message: error.message,
        };
    }
  }
  return {
    kind: CHARGE_RECEIPT_KINDS.local_error,
    error_code: CHARGE_INTERNAL_ERROR_CODE,
    reason_code: CHARGE_INTERNAL_ERROR_CODE,
    channel_reachable: false,
    retryable: false,
    disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** 一条回执（= 一条耗材一次投递的结果） */
export interface ChargeReceipt {
  material_code: string;
  operation_no: string;
  /** 幂等键（重投复用同一把） */
  idempotency_key: string | null;
  /** 幂等键版本（v1 / v2） */
  key_profile: string | null;
  /** 带来这一行的**请求级**键（整批提交的去重键；事后按键反查整批用） */
  request_idempotency_key: string | null;
  /** 对端有没有回显这把键（ECHOED / NOT_ECHOED / MISMATCH） */
  peer_idempotency_status: PeerIdempotencyStatus;
  /** 本条回执是该条目的第几次尝试（连续序号） */
  attempt: number;
  /** 累计投递次数（= attempt；每次尝试写一行回执） */
  delivery_count: number;
  /** 对端是否接收 */
  accepted: boolean;
  /** 归类档位 */
  kind: ChargeReceiptKind;
  /** 原因码：对端给的业务码，或本侧错误码 */
  reason_code: string | null;
  /** 本侧错误码（ERR_CHARGE_*） */
  error_code: string | null;
  /** 通道当时是否可达 */
  channel_reachable: boolean;
  /** 值不值得重投 */
  retryable: boolean;
  /**
   * 处置档位（可重投 / 不可重投 / 需人工）。
   *
   * 落回执行是为了事后能一眼看出「这条当时是怎么处置的」：
   * 同样一条 rejected，可能是进过退避队列的临时拒收，也可能是直接转人工的价码缺失。
   * 对端已接收的条目没有失败处置，值为 null。
   */
  disposition: ReceiptDisposition | null;
  /** 请求发出时间 */
  requested_at: string;
  /** 回执到手时间 */
  responded_at: string;
  /** 对端回执摘要（脱敏，短句） */
  response_summary: string | null;
  /**
   * 本次**实际发出去**的载荷快照（数量）。
   *
   * 回执行只说「对端收没收」，不说「当时发出去的是什么」——
   * 补上快照后，台账 ↔ 计费的字段级比对才有对照物：
   * 台账现在写的数量 / 价码 / 费用口径，与计费侧实际收到的那一份是不是同一口径。
   * 快照按**每次尝试**记：重投过几次，每次发出去的载荷都留痕。
   */
  submitted_quantity?: number | null;
  /** 本次实际发出去的价码（计价口径） */
  submitted_price_code?: string | null;
  /** 本次实际发出去的费用类别 */
  submitted_fee_category?: string | null;
  /** 本次实际发出去的医保分类 */
  submitted_medical_insurance_class?: string | null;
  /**
   * 尝试序号来源（落库时写死 native；迁移回填的历史行写 recovered）。
   *
   * 用来回答「这条尝试序号是当时真记的，还是迁移按落账顺序补出来的」。
   */
  attempt_source?: string | null;
  /** 回填备注（中文）：补记了什么、为什么补不了 */
  history_note?: string | null;
}

/** 回执行（落库后的形状：布尔位已还原成布尔） */
export interface ChargeReceiptRow {
  id: number;
  material_code: string;
  operation_no: string;
  idempotency_key: string | null;
  key_profile: string | null;
  request_idempotency_key: string | null;
  peer_idempotency_status: PeerIdempotencyStatus | null;
  attempt: number;
  delivery_count: number;
  accepted: boolean;
  kind: ChargeReceiptKind | null;
  reason_code: string | null;
  error_code: string | null;
  /**
   * 通道当时是否可达。
   *
   * `null` = **没记录**（老库迁移回填不了的行留空）—— 与「不可达」是两回事：
   * 导出时如实留空并附备注，不拿 false 糊过去。
   */
  channel_reachable: boolean | null;
  retryable: boolean;
  /** 处置档位（历史行可能为空） */
  disposition: ReceiptDisposition | null;
  requested_at: string | null;
  responded_at: string | null;
  response_summary: string | null;
  submitted_quantity: number | null;
  submitted_price_code: string | null;
  submitted_fee_category: string | null;
  submitted_medical_insurance_class: string | null;
  /**
   * 尝试序号来源：native = 落库时原生记录；recovered = 迁移按落账顺序回填。
   */
  attempt_source: string | null;
  /** 回填备注（中文）；原生行为空 */
  history_note: string | null;
  created_at: string;
}

export interface ClassifyReceiptsInput {
  /** 对端响应 */
  response: MaterialUsesResponse;
  /** 本次提交出去的条目（逐条对齐，回执条数与提交条数守恒） */
  submitted: readonly MaterialUse[];
  /** 台次号 */
  operation_no: string;
  /** 本次是第几次尝试 */
  attempt: number;
  /**
   * 逐条尝试序号（耗材码 → 序号）。
   *
   * 同一批里各条耗材的尝试次数可以不同：A 条重投过两次、B 条第一次投，
   * 序号不能整批共用一个。给了这张表就按条取，没给就整批用 `attempt`。
   */
  attempt_by_material?: ReadonlyMap<string, number>;
  /** 累计投递次数（缺省 = attempt） */
  delivery_count?: number;
  idempotency_key?: string | null;
  key_profile?: string | null;
  /** 带来这批的请求级键（落回执，事后按键反查整批） */
  request_idempotency_key?: string | null;
  requested_at?: string;
  responded_at?: string;
}

/**
 * 对端回显状态判定：回显了同一把键 = 已启用幂等；没回显 = 未启用；
 * 回显了另一把 = 两端口径不一致。
 */
export function peerIdempotencyStatus(
  submittedKey: string | null | undefined,
  echoedKey: string | null | undefined,
): PeerIdempotencyStatus {
  const echoed = (echoedKey ?? '').trim();
  if (echoed.length === 0) return PEER_IDEMPOTENCY_STATUS.not_echoed;
  const submitted = (submittedKey ?? '').trim();
  if (submitted.length === 0) return PEER_IDEMPOTENCY_STATUS.not_echoed;
  return echoed === submitted ? PEER_IDEMPOTENCY_STATUS.echoed : PEER_IDEMPOTENCY_STATUS.mismatch;
}

/**
 * 把对端响应拆成**逐条**回执。
 *
 * 规则（逐层短路，一条提交对应一条回执，条数守恒）：
 *   ① 对端把这条列进 rejected → 业务拒绝（通道可达、不可重投）；
 *   ② 对端把这条列进 accepted → 接收成功；
 *   ③ 两边都没有 → 对端没给这条的结论：按「协议不符」处理（可重投），
 *      **不静默当成成功**。
 *
 * 每条回执都带**对端回显状态**（ECHOED / NOT_ECHOED / MISMATCH）：
 * 本侧把幂等键透传给了对端，回执里必须写清对端认没认这把键。
 */
export function classifyReceipts(input: ClassifyReceiptsInput): ChargeReceipt[] {
  const acceptedMap = new Map(
    input.response.accepted.map(
      (item) => [item.material_code, (item.idempotency_key ?? '').trim()] as const,
    ),
  );
  const rejectedMap = new Map(
    input.response.rejected.map(
      (item) =>
        [item.material_code, { reason_code: item.reason_code, echoed: (item.idempotency_key ?? '').trim() }] as const,
    ),
  );
  const now = new Date().toISOString();
  const requestedAt = input.requested_at ?? now;
  const respondedAt = input.responded_at ?? now;
  const attemptByMaterial = input.attempt_by_material;
  // 对端整份回执一条结论都没给（accepted 与 rejected 都空）——
  // 这不是「这一条没结论」，而是「对端什么都没说清楚」：按通道不可达处理。
  const responseIsEmpty = input.response.accepted.length === 0 && input.response.rejected.length === 0;

  return input.submitted.map((use) => {
    const lineKey = (use.idempotency_key ?? input.idempotency_key ?? '').trim();
    const rejected = rejectedMap.get(use.material_code);
    const echoed = rejected ? rejected.echoed : (acceptedMap.get(use.material_code) ?? '');
    const peerStatus = peerIdempotencyStatus(lineKey, echoed);
    // 逐条尝试序号：给了按条取，没给整批共用一个
    const attempt = attemptByMaterial?.get(use.material_code) ?? input.attempt;
    const deliveryCount = input.delivery_count ?? attempt;

    const base: ChargeReceipt = {
      material_code: use.material_code,
      operation_no: input.operation_no,
      idempotency_key: lineKey.length > 0 ? lineKey : (input.idempotency_key ?? null),
      key_profile: (use.key_profile ?? input.key_profile ?? null) as string | null,
      request_idempotency_key: input.request_idempotency_key ?? null,
      peer_idempotency_status: peerStatus,
      attempt,
      delivery_count: deliveryCount,
      accepted: false,
      kind: CHARGE_RECEIPT_KINDS.protocol_error,
      reason_code: null,
      error_code: null,
      channel_reachable: true,
      retryable: false,
      disposition: null,
      requested_at: requestedAt,
      responded_at: respondedAt,
      response_summary: null,
      // 载荷快照：本次实际发出去的那一份（字段级比对的对照物）
      submitted_quantity: use.quantity ?? null,
      submitted_price_code: use.price_code ?? null,
      submitted_fee_category: use.fee_category ?? null,
      submitted_medical_insurance_class: use.medical_insurance_class ?? null,
    };

    // ① 对端明确拒收：按判定表分流（可重投 / 不可重投 / 需人工）
    if (rejected) {
      const decision = disposeReceiptReason(rejected.reason_code);
      return {
        ...base,
        kind: CHARGE_RECEIPT_KINDS.business_rejected,
        reason_code: rejected.reason_code,
        // 统一错误码：与核查条目、日志展示同一个码（由判定表给出）
        error_code: decision.error_code,
        retryable: decision.retryable,
        disposition: decision.disposition,
        response_summary:
          peerStatus === PEER_IDEMPOTENCY_STATUS.mismatch
            ? `对端拒收：${rejected.reason_code}（${decision.meaning_zh}）；对端回显的键与本侧发出的键不一致`
            : `对端拒收：${rejected.reason_code}（${decision.meaning_zh}）`,
      };
    }

    // ② 对端接收
    if (acceptedMap.has(use.material_code)) {
      return {
        ...base,
        accepted: true,
        kind: CHARGE_RECEIPT_KINDS.accepted,
        channel_reachable: true,
        retryable: false,
        // 对端已接收，没有失败处置
        disposition: null,
        response_summary:
          peerStatus === PEER_IDEMPOTENCY_STATUS.mismatch
            ? '对端已接收；对端回显的键与本侧发出的键不一致'
            : '对端已接收',
      };
    }

    // ③ 对端没给这一条的结论：不静默当成成功，按协议不符进重投
    const missingDecision = disposeReceiptReason(
      responseIsEmpty ? REASON_EMPTY_RECEIPT : REASON_MISSING_RECEIPT,
    );
    return {
      ...base,
      kind: CHARGE_RECEIPT_KINDS.protocol_error,
      reason_code: missingDecision.code,
      error_code: missingDecision.error_code,
      // 整份回执为空 = 通道不可达（没法确认对端记没记）；只缺这一条 = 通道可达但漏了这条
      channel_reachable: !responseIsEmpty,
      retryable: true,
      disposition: missingDecision.disposition,
      response_summary: responseIsEmpty
        ? '对端回执为空（一条结论都没给），按通道不可达处理并进重投队列'
        : '对端回执未包含该耗材码',
    };
  });
}

/**
 * 给「投递本身失败」的条目造一条回执（请求发出去了但没拿到结论）。
 *
 * 失败定性由 `classifyFailure` 给出：通道不可达 vs 通道可达但业务拒绝。
 */
export function failureReceipt(
  input: {
    material_code: string;
    operation_no: string;
    idempotency_key?: string | null;
    key_profile?: string | null;
    /** 带来这批的请求级键 */
    request_idempotency_key?: string | null;
    attempt: number;
    delivery_count?: number;
    failure: ChargeFailureClass;
    requested_at?: string;
    responded_at?: string;
    /** 本次实际发出去的载荷快照（失败回执也要留：证明「发出去的是什么」） */
    submitted_quantity?: number | null;
    submitted_price_code?: string | null;
    submitted_fee_category?: string | null;
    submitted_medical_insurance_class?: string | null;
  },
): ChargeReceipt {
  const now = new Date().toISOString();
  return {
    material_code: input.material_code,
    operation_no: input.operation_no,
    idempotency_key: input.idempotency_key ?? null,
    key_profile: input.key_profile ?? null,
    request_idempotency_key: input.request_idempotency_key ?? null,
    // 没拿到响应 = 对端没回显任何键：按「对端未启用幂等」留痕
    peer_idempotency_status: PEER_IDEMPOTENCY_STATUS.not_echoed,
    attempt: input.attempt,
    delivery_count: input.delivery_count ?? input.attempt,
    accepted: false,
    kind: input.failure.kind,
    reason_code: input.failure.reason_code,
    error_code: input.failure.error_code,
    channel_reachable: input.failure.channel_reachable,
    retryable: input.failure.retryable,
    disposition: input.failure.disposition,
    requested_at: input.requested_at ?? now,
    responded_at: input.responded_at ?? now,
    response_summary: input.failure.message.slice(0, 300),
    submitted_quantity: input.submitted_quantity ?? null,
    submitted_price_code: input.submitted_price_code ?? null,
    submitted_fee_category: input.submitted_fee_category ?? null,
    submitted_medical_insurance_class: input.submitted_medical_insurance_class ?? null,
  };
}

/**
 * 未知回执码登记：**待补项 + 审计链留痕**。
 *
 * 对端给了本侧判定表里没有的码时，这条不能被当成「已处理」就算完：
 *   ① 原始码登记进错误码表待补项（`registerPendingErrorCode`）——
 *      否则同一个未知码会一次次冒出来，每次都得重新查；
 *   ② 审计链留一行（`charge_reason_code_unknown`）——
 *      事后能回放「对端当时到底说了什么」。
 * 处置档位由判定表给出：未知码落「需人工 + 不可重投」（fail safe）。
 *
 * @returns true = 这个码本侧没登记过（已登记待补项并留痕）
 */
export function registerUnknownReceiptReason(
  db: DatabaseSync,
  input: {
    reason_code: string | null | undefined;
    material_code: string;
    operation_no: string;
    binding_key?: string | null;
    error_code?: string | null;
    disposition?: ReceiptDisposition | null;
  },
): boolean {
  const code = (input.reason_code ?? '').trim();
  if (code.length === 0 || isKnownReceiptReason(code)) return false;
  registerPendingErrorCode(code, `${input.operation_no}/${input.material_code}`);
  appendAudit(db, {
    event_type: 'charge_reason_code_unknown',
    binding_key: input.binding_key ?? null,
    operation_no: input.operation_no,
    actor: 'charge_writeback',
    detail: JSON.stringify({
      material_code: input.material_code,
      reason_code: code,
      error_code: input.error_code ?? null,
      disposition: input.disposition ?? null,
    }),
  });
  return true;
}

/** 追加一行回执（只增不改）；返回新行 id */
export function recordReceipt(db: DatabaseSync, receipt: ChargeReceipt): number {
  const result = db
    .prepare(
      `INSERT INTO charge_receipt
         (material_code, operation_no, idempotency_key, key_profile,
          request_idempotency_key, peer_idempotency_status,
          attempt, delivery_count,
          accepted, kind, reason_code, error_code, channel_reachable, retryable, disposition,
          requested_at, responded_at, response_summary,
          submitted_quantity, submitted_price_code, submitted_fee_category,
          submitted_medical_insurance_class, attempt_source, history_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      receipt.material_code,
      receipt.operation_no,
      receipt.idempotency_key,
      receipt.key_profile,
      receipt.request_idempotency_key,
      receipt.peer_idempotency_status,
      receipt.attempt,
      receipt.delivery_count,
      receipt.accepted ? 1 : 0,
      receipt.kind,
      receipt.reason_code,
      receipt.error_code,
      receipt.channel_reachable ? 1 : 0,
      receipt.retryable ? 1 : 0,
      receipt.disposition ?? null,
      receipt.requested_at,
      receipt.responded_at,
      receipt.response_summary,
      receipt.submitted_quantity ?? null,
      receipt.submitted_price_code ?? null,
      receipt.submitted_fee_category ?? null,
      receipt.submitted_medical_insurance_class ?? null,
      // 落库时原生记录的尝试序号：标 native，与迁移回填的行（recovered）区分开
      receipt.attempt_source ?? 'native',
      receipt.history_note ?? null,
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

/** 追加多行回执（一次调用里的逐条结论）；返回新行 id 列表 */
export function recordReceipts(db: DatabaseSync, receipts: readonly ChargeReceipt[]): number[] {
  return receipts.map((receipt) => recordReceipt(db, receipt));
}

/** 取某条耗材的全部回执（按尝试序号升序） */
export function loadReceipts(
  db: DatabaseSync,
  material_code: string,
  operation_no: string,
): ChargeReceiptRow[] {
  const rows = db
    .prepare(
      `SELECT id, material_code, operation_no, idempotency_key, key_profile,
              request_idempotency_key, peer_idempotency_status,
              attempt, delivery_count,
              accepted, kind, reason_code, error_code, channel_reachable, retryable, disposition,
              requested_at, responded_at, response_summary,
              submitted_quantity, submitted_price_code, submitted_fee_category,
              submitted_medical_insurance_class, attempt_source, history_note, created_at
         FROM charge_receipt
        WHERE material_code = ? AND operation_no = ?
        ORDER BY attempt ASC, id ASC`,
    )
    .all(material_code, operation_no) as unknown as Array<
    Omit<ChargeReceiptRow, 'accepted' | 'channel_reachable' | 'retryable'> & {
      accepted: number;
      channel_reachable: number | null;
      retryable: number;
    }
  >;
  return rows.map((row) => ({
    ...row,
    accepted: row.accepted === 1,
    // 老行的通道可达性可能是 NULL（迁移回填不了就留空）：如实保留 null，不糊成 false
    channel_reachable: row.channel_reachable === null ? null : row.channel_reachable === 1,
    retryable: row.retryable === 1,
  }));
}

/**
 * 取整台次的尝试序列（关台核对时最常问的那句：「这一台每条耗材试了几次」）。
 *
 * 排序：先按台次内耗材码，再按尝试序号 —— 同一台次里每条耗材的尝试连成一段，
 * 导出 / 打印时一眼能看出「哪条耗材重试过」。
 */
export function listOperationAttempts(
  db: DatabaseSync,
  operation_no: string,
): ChargeReceiptRow[] {
  const rows = db
    .prepare(
      `SELECT id, material_code, operation_no, idempotency_key, key_profile,
              request_idempotency_key, peer_idempotency_status,
              attempt, delivery_count,
              accepted, kind, reason_code, error_code, channel_reachable, retryable, disposition,
              requested_at, responded_at, response_summary,
              submitted_quantity, submitted_price_code, submitted_fee_category,
              submitted_medical_insurance_class, attempt_source, history_note, created_at
         FROM charge_receipt
        WHERE operation_no = ?
        ORDER BY material_code ASC, attempt ASC, id ASC`,
    )
    .all(operation_no) as unknown as Array<
    Omit<ChargeReceiptRow, 'accepted' | 'channel_reachable' | 'retryable'> & {
      accepted: number;
      channel_reachable: number | null;
      retryable: number;
    }
  >;
  return rows.map((row) => ({
    ...row,
    accepted: row.accepted === 1,
    // 老行的通道可达性可能是 NULL（迁移回填不了就留空）：如实保留 null，不糊成 false
    channel_reachable: row.channel_reachable === null ? null : row.channel_reachable === 1,
    retryable: row.retryable === 1,
  }));
}

/**
 * 取时间窗内的尝试序列（按批次回放 / 事后复盘用）。
 *
 * 时间口径取**落账时间**（`created_at`）—— 请求时间与响应时间在历史行里可能缺失，
 * 拿落账时间做窗更稳；落在窗外的按 `responded_at` 补判一次，两头都不落才算窗外。
 *
 * @param from 起始时间（含），ISO 字符串
 * @param to   结束时间（含），ISO 字符串
 */
export function listAttemptsInWindow(
  db: DatabaseSync,
  from: string,
  to: string,
): ChargeReceiptRow[] {
  const rows = db
    .prepare(
      `SELECT id, material_code, operation_no, idempotency_key, key_profile,
              request_idempotency_key, peer_idempotency_status,
              attempt, delivery_count,
              accepted, kind, reason_code, error_code, channel_reachable, retryable, disposition,
              requested_at, responded_at, response_summary,
              submitted_quantity, submitted_price_code, submitted_fee_category,
              submitted_medical_insurance_class, attempt_source, history_note, created_at
         FROM charge_receipt
        WHERE created_at >= ? AND created_at <= ?
           OR (responded_at IS NOT NULL AND responded_at >= ? AND responded_at <= ?)
        ORDER BY created_at ASC, id ASC`,
    )
    .all(from, to, from, to) as unknown as Array<
    Omit<ChargeReceiptRow, 'accepted' | 'channel_reachable' | 'retryable'> & {
      accepted: number;
      channel_reachable: number | null;
      retryable: number;
    }
  >;
  return rows.map((row) => ({
    ...row,
    accepted: row.accepted === 1,
    // 老行的通道可达性可能是 NULL（迁移回填不了就留空）：如实保留 null，不糊成 false
    channel_reachable: row.channel_reachable === null ? null : row.channel_reachable === 1,
    retryable: row.retryable === 1,
  }));
}

/** 某条耗材已经投递过几次（没有回执时为 0） */
export function lastAttempt(db: DatabaseSync, material_code: string, operation_no: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(attempt), 0) AS n FROM charge_receipt WHERE material_code = ? AND operation_no = ?',
    )
    .get(material_code, operation_no) as { n: number };
  return row.n;
}

/**
 * 下一条尝试该用的序号 = 已投递次数 + 1。
 *
 * **按条目取、不按批次取**：同一台次里 A 条重投过两次、B 条第一次投，
 * 两者的序号不能混。序号从台账现读，重投沿用同一把幂等键、不改序号口径。
 */
export function nextAttemptNumber(
  db: DatabaseSync,
  material_code: string,
  operation_no: string,
): number {
  return lastAttempt(db, material_code, operation_no) + 1;
}

/** 回执台账总行数 */
export function countReceipts(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM charge_receipt').get() as { n: number };
  return row.n;
}
