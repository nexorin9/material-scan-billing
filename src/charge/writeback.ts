/**
 * 计费回写层：台账里「已绑定」的耗材条目 → HIS 计费 → **逐条回执** → 台账状态推进。
 *
 * 这是「绑定成功」到「计费已生成」之间那一段的落点，也是 replay 子命令
 * 「触发计费次数」这个数字的来源。
 *
 * 语义来源（源产品主路径）：源产品按目标实体批量投递并**逐条取回执**，
 * 回执带投递次数与通道当时是否可达；单条投递失败是**普通结果**而非中断。
 * 本层照此语义改写成耗材计费场景：
 *
 *   - 一个台次的耗材明细**一次提交**（请求体字段逐字对齐 spec.md 最小数据格式）；
 *   - 响应拆成**逐条回执**（accepted / rejected + reason_code）落回执台账；
 *   - 逐条分流：对端接收 → 台账推进到 `charged`；对端拒收 → 转人工核查条目，
 *     台账推进到 `check_pending`（**不静默丢弃**）；
 *   - 通道不可达（超时 / 连接失败 / 5xx）→ 条目留在 `bound` 等重投，
 *     回执行留失败痕迹（重投调度见 `src/charge/retry.ts`）。
 *
 * 硬约束：
 *   ① **已回写计费的条目不重复投递** —— 状态停在 `charged`，本轮不做自动冲正；
 *   ② **逐条结论守恒** —— 提交几条就落几条回执，对端没给结论的那条按「协议不符」记，
 *      **不静默当成成功**；
 *   ③ **数量必须是正整数** —— 计价单位数量不是整数的条目**不提交、不取整**，
 *      原样留在台账里等人工核对。
 */

import type { DatabaseSync } from 'node:sqlite';

import { appendAudit } from '../ledger/audit.js';
import { recordSanitizeTrace, transitionBindingStatus } from '../ledger/binding-repo.js';
import { withTransaction } from '../ledger/db.js';
import { addMetaCounter, META_KEY_OUTBOUND_CALLS } from '../ledger/meta.js';
import { createCheckTask } from '../check/task.js';
import { errorCodeForReason } from '../log/error-codes.js';
import { RECEIPT_DISPOSITIONS } from './reason-codes.js';
import { defaultLogger, type Logger } from '../log/logger.js';
import type { FieldLengthLimits } from '../api/contracts.js';
import type { ConfigurableIdempotencyKeyProfile } from '../domain/idempotency.js';
import type { HisChargingClient } from './client.js';
import {
  CHARGE_RECEIPT_KINDS,
  classifyReceipts,
  failureReceipt,
  nextAttemptNumber,
  recordReceipts,
  registerUnknownReceiptReason,
  type ChargeFailureClass,
  type ChargeReceipt,
} from './receipt.js';
import {
  inspectMaterialUsesContractItems,
  inspectMaterialUsesRequest,
  type ContractItemIssue,
  type FieldIssue,
  type MaterialUse,
} from './submit.js';
import { submitChargeBatches } from './batch.js';
import { resolveChargeQuantity } from './quantity.js';
import {
  renderSanitizeTrace,
  sanitizeEnvelope,
  sanitizeMaterialUse,
  SANITIZE_ERROR_CODES,
} from './sanitize.js';

/** 台账里待回写计费的条目 */
export interface BoundRow {
  id: number;
  idempotency_key: string;
  key_profile: string;
  operation_no: string;
  room_no: string;
  dept_code: string;
  material_code: string;
  /** 原始数量（包装数，设备上报的那个数） */
  quantity: number;
  /** 计价数量（包装数换算成计价单位后的数）；老行（升级前写下的）可能为空 */
  charge_quantity: number | null;
  /** 换算轨迹（JSON 字符串）；老行为空 */
  quantity_trace: string | null;
  price_code: string | null;
  fee_category: string | null;
  medical_insurance_class: string | null;
  /** 业务使用时间（设备上报的扫码时间；月度对账按业务月切账期用） */
  use_time: string | null;
  created_at: string;
}

export interface ChargeWritebackOptions {
  /** 出站客户端（凭据单一出口：业务层拿不到令牌） */
  client: HisChargingClient;
  /** 端点路径（来自配置项，不硬编码） */
  path: string;
  /** 科室编码（台账里没有时用它兜底） */
  dept_code?: string | null;
  /** 使用时间（不给则取台账行的落账时间） */
  useTime?: string | null;
  /** 结构化日志器（可选；不传则用默认日志器写 stdout） */
  logger?: Logger;
  /** 单次提交条目数上限（默认 100；对端限批） */
  maxBatchSize?: number;
  /** 关键字段长度上限表（默认取契约表） */
  limits?: FieldLengthLimits;
  /**
   * 本次请求使用的键档位（默认 v1；来自配置项 IDEMPOTENCY_KEY_PROFILE）。
   *
   * 只影响**没有台账键**的条目；已绑上台账的行按行上的键透传，档位跟着那一行走。
   */
  keyProfile?: ConfigurableIdempotencyKeyProfile;
}

export interface ChargeWritebackResult {
  /** 台次号 */
  operation_no: string;
  /** 提交出去的条目数（一行台账一条明细，逐条回执按行对齐） */
  submitted: number;
  /** 对端接收的条目数 */
  accepted: number;
  /** 对端拒收的条目数 */
  rejected: number;
  /** 出站请求次数（= 出站实际打了几次） */
  calls: number;
  /** 切分出的批数（每批一次出站请求） */
  batches: number;
  /** 整批失败的批数（该批条目留在台账里等退避重投） */
  failed_batches: number;
  /** 本地拒掉的条目数（字段超长等，请求根本没发出去） */
  rejected_locally: number;
  /** 没提交的条目与原因（数量非正整数、字段缺失等） */
  skipped: Array<{ material_code: string; reason: string }>;
  /** 逐条回执 */
  receipts: ChargeReceipt[];
  /** 本次整体是否走通了（通道可达且没有本地错误） */
  channel_reachable: boolean;
  /** 整体错误码（通道不可达时给出） */
  error_code: string | null;
}

/** 取某台次里「已绑定但还没回写计费」的台账行 */
export function listBoundRows(db: DatabaseSync, operation_no: string): BoundRow[] {
  return db
    .prepare(
      `SELECT id, idempotency_key, key_profile, operation_no, room_no, dept_code, material_code,
              quantity, charge_quantity, quantity_trace,
              price_code, fee_category, medical_insurance_class, use_time, created_at
         FROM material_binding
        WHERE operation_no = ? AND status = 'bound'
        ORDER BY id ASC`,
    )
    .all(operation_no) as unknown as BoundRow[];
}

/** 取计价数量所需的台账行字段（回写与重投两处共用同一把尺子） */
export { resolveChargeQuantity, type ChargeQuantitySource } from './quantity.js';

/** 取台账行的计价数量（拿不到就退回原数量；只用于载荷快照，不用于提交判定） */
function chargeQuantityOf(row: BoundRow): number {
  const resolved = resolveChargeQuantity(row);
  return 'quantity' in resolved ? resolved.quantity : row.quantity;
}

/**
 * 台账行能否作为出站明细。
 *
 * 三种结局，各走各的路：
 *   - `{ use }`           —— 能发（数量是计价单位的正整数、主数据字段齐全）；
 *   - `{ skip }`          —— 数量换算不出来（包装 → 计价单位除不尽 / 缺系数）：
 *                            **跳过但不提交**，这一条留在台账里等人工核对；
 *   - `{ missingField }`  —— 主数据缺价码 / 费用类别 / 医保分类：
 *                            **本地拒收**（不填默认值），落回执 + 核查条目。
 */
function toMaterialUse(
  row: BoundRow,
  useTime: string,
): { use: MaterialUse } | { skip: string } | { missingField: string; reason: string } {
  const resolved = resolveChargeQuantity(row);
  if ('reason' in resolved) return { skip: resolved.reason };
  if (!row.price_code) {
    return { missingField: 'price_code', reason: '主数据缺价码，不提交' };
  }
  if (!row.fee_category) {
    return { missingField: 'fee_category', reason: '主数据缺费用类别，不提交' };
  }
  if (!row.medical_insurance_class) {
    return { missingField: 'medical_insurance_class', reason: '主数据缺医保分类，不提交' };
  }
  return {
    use: {
      material_code: row.material_code,
      quantity: resolved.quantity,
      price_code: row.price_code,
      use_time: useTime,
      fee_category: row.fee_category,
      medical_insurance_class: row.medical_insurance_class,
      // 行级幂等键：跟着台账行走 —— 重投时复用同一把，对端据此去重
      idempotency_key: row.idempotency_key,
      key_profile: row.key_profile,
    },
  };
}

/**
 * 台账行能否作为出站明细（数量必须是正整数，价码与费用口径不能缺） */

/**
 * 本地拒收一条明细：字段超长等**请求根本没发出去**的情形。
 *
 * 处置口径与「对端业务拒绝」一致 —— 落一行失败回执 + 生成核查任务 + 台账转人工：
 * 字段超长要人去改主数据（耗材码 / 价码）或改扫码枪配置（台次号），
 * **不截断后照发**（截断过的耗材码就是另一个耗材，计费会记错）。
 */
function rejectLocally(
  db: DatabaseSync,
  row: BoundRow,
  operation_no: string,
  issue: FieldIssue,
  attempt: number,
): { receipt: ChargeReceipt; check_task_id: number } {
  const failure: ChargeFailureClass = {
    kind: CHARGE_RECEIPT_KINDS.local_error,
    error_code: issue.error_code,
    reason_code: issue.error_code,
    channel_reachable: false,
    retryable: false,
    // 本侧字段问题：改了主数据才会变 → 不可重投，转人工
    disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
    message: issue.message,
  };
  const receipt = failureReceipt({
    material_code: row.material_code,
    operation_no,
    idempotency_key: row.idempotency_key,
    key_profile: row.key_profile,
    attempt,
    // 请求根本没发出去 → 累计投递次数不涨（与「投了但没回执」区分开）
    delivery_count: Math.max(0, attempt - 1),
    failure,
    requested_at: new Date().toISOString(),
    responded_at: new Date().toISOString(),
    submitted_quantity: chargeQuantityOf(row),
    submitted_price_code: row.price_code,
    submitted_fee_category: row.fee_category,
    submitted_medical_insurance_class: row.medical_insurance_class,
  });

  // 回执行 + 核查条目 + 台账状态 + 审计行：同事务提交，不留半写
  let checkTaskId = 0;
  withTransaction(db, () => {
    recordReceipts(db, [receipt]);
    checkTaskId = createCheckTask(db, {
      operation_no,
      room_no: row.room_no,
      dept_code: row.dept_code,
      material_code: row.material_code,
      quantity: chargeQuantityOf(row),
      conclusion: 'CHARGE_REJECTED',
      reason_code: issue.error_code,
      error_code: issue.error_code,
    });
    transitionBindingStatus(db, {
      binding_id: row.id,
      material_code: row.material_code,
      operation_no,
      idempotency_key: row.idempotency_key,
      to: 'check_pending',
      actor: 'charge_writeback',
      check_task_id: checkTaskId,
    });
    appendAudit(db, {
      event_type: 'charge_rejected_locally',
      binding_key: row.idempotency_key,
      operation_no,
      actor: 'charge_writeback',
      detail: JSON.stringify({
        material_code: row.material_code,
        field: issue.field,
        error_code: issue.error_code,
        message: issue.message,
        check_task_id: checkTaskId,
      }),
    });
  });
  return { receipt, check_task_id: checkTaskId };
}

/**
 * 把一个台次的已绑定条目回写到 HIS 计费，并按逐条回执推进台账状态。
 *
 * 主路径：**分批提交 + 逐批独立结算**。
 *   - 条目按对端限批（默认 100 条 / 批）切分，每批一次出站请求；
 *   - 某批整体失败（网络 / 5xx）只让**该批**进退避重投，其余批的结论照常落库；
 *   - 字段超长的条目**在本地就拒掉**（不截断后照发），同样有回执与核查条目，
 *     台账行数守恒 —— 提交几条就有几条结论。
 *
 * @param db 台账连接
 * @param operation_no 台次号
 * @param options 出站客户端与端点路径
 */
export async function writeBackOperationCharges(
  db: DatabaseSync,
  operation_no: string,
  options: ChargeWritebackOptions,
): Promise<ChargeWritebackResult> {
  const rows = listBoundRows(db, operation_no);
  const logger = options.logger ?? defaultLogger;
  const result: ChargeWritebackResult = {
    operation_no,
    submitted: 0,
    accepted: 0,
    rejected: 0,
    calls: 0,
    batches: 0,
    failed_batches: 0,
    rejected_locally: 0,
    skipped: [],
    receipts: [],
    channel_reachable: true,
    error_code: null,
  };

  if (rows.length === 0) {
    return result;
  }

  const deptCode = options.dept_code ?? rows[0]?.dept_code ?? '';
  /**
   * 逐条尝试序号：**按条目取，不按批次取**。
   *
   * 同台次里 A 条重投过两次、B 条第一次投 —— 两者的尝试序号不能共用一个。
   * 序号从回执台账现读（已投递次数 + 1），保证同一台次里序号连续不重号。
   */
  const attemptByMaterial = new Map<string, number>();
  for (const row of rows) {
    attemptByMaterial.set(row.material_code, nextAttemptNumber(db, row.material_code, operation_no));
  }
  // 一行台账 → 一条明细（**逐条回执按行对齐**：每行台账都有自己的回执）
  const candidates: Array<{ row: BoundRow; use: MaterialUse }> = [];

  // ── 出站载荷清洗 · 第一步：请求级字段（台次号 / 科室编码）────────────
  //   抬头缺字段 → **整批发不出去**（抬头定的是这批记到哪台手术）。
  //   本地拒收（回执 + 核查条目 + 台账转人工），一个请求都不发。
  const envelope = sanitizeEnvelope(operation_no, deptCode);
  if (envelope.issues.length > 0) {
    const issue = envelope.issues[0]!;
    for (const row of rows) {
      const { receipt } = rejectLocally(
        db,
        row,
        operation_no,
        {
          index: -1,
          material_code: row.material_code,
          field: issue.field,
          error_code: issue.error_code,
          message: issue.message,
        },
        attemptByMaterial.get(row.material_code) ?? 1,
      );
      result.receipts.push(receipt);
      result.rejected_locally += 1;
    }
    result.error_code = issue.error_code;
    result.channel_reachable = false;
    logger.warn('计费请求抬头字段缺失，已本地拒收，未发出请求', {
      channel: 'outbound',
      operation_no,
      error_code: issue.error_code,
      duration_ms: null,
      field: issue.field,
      rejected_locally: result.rejected_locally,
    });
    return result;
  }

  // ── 出站载荷清洗 · 第二步：逐条明细（归一 → 判空 → 留痕）────────────
  for (const row of rows) {
    // 使用时间：优先取台账行的**业务使用时间**（设备上报的扫码时间）——
// 计费侧记的「什么时候用的」应该是实际扫码时间，不是本程序落账的时间。
const useTime = options.useTime ?? row.use_time ?? row.created_at;
    const converted = toMaterialUse(row, useTime);
    if ('skip' in converted) {
      // 数量换算不出来：不提交、也不编造 —— 这一条留在台账里等人工核对
      result.skipped.push({ material_code: row.material_code, reason: converted.skip });
      continue;
    }
    if ('missingField' in converted) {
      // 主数据缺字段：**不填默认值**，本地拒收（回执 + 核查条目 + 台账转人工）
      const { receipt } = rejectLocally(
        db,
        row,
        operation_no,
        {
          index: -1,
          material_code: row.material_code,
          field: converted.missingField,
          error_code: SANITIZE_ERROR_CODES.fieldMissing,
          message: converted.reason,
        },
        attemptByMaterial.get(row.material_code) ?? 1,
      );
      result.receipts.push(receipt);
      result.rejected_locally += 1;
      result.error_code = result.error_code ?? SANITIZE_ERROR_CODES.fieldMissing;
      continue;
    }
    const sanitized = sanitizeMaterialUse(converted.use, candidates.length);
    // 归一前后对照落台账：被拒的条目也留痕 —— 人要靠这一列知道「该怎么改主数据」
    if (sanitized.trace.changed) {
      recordSanitizeTrace(db, row.id, renderSanitizeTrace(sanitized.trace));
    }
    if (sanitized.issues.length > 0) {
      const issue = sanitized.issues[0]!;
      const { receipt } = rejectLocally(
        db,
        row,
        operation_no,
        issue,
        attemptByMaterial.get(row.material_code) ?? 1,
      );
      result.receipts.push(receipt);
      result.rejected_locally += 1;
      result.error_code = result.error_code ?? issue.error_code;
      continue;
    }
    candidates.push({ row, use: sanitized.use as MaterialUse });
  }

  if (candidates.length === 0) {
    return result;
  }

  // ── 字段校验：请求级（台次号 / 科室编码）与明细级分开处置 ──────────────
  //   请求级超长 → 整个请求发不出去（抬头定的是这批记到哪台手术，不能截半截）；
  //   明细级超长 → 只拒那一条，同批其余照常提交。
  const inspection = inspectMaterialUsesRequest(
    { operation_no, dept_code: deptCode, uses: candidates.map((item) => item.use) },
    options.limits,
  );

  if (inspection.envelope_issues.length > 0) {
    // 抬头有问题：一个请求都发不出去，全部条目落本地拒收
    const issue = inspection.envelope_issues[0]!;
    for (const candidate of candidates) {
      const { receipt } = rejectLocally(
        db,
        candidate.row,
        operation_no,
        issue,
        attemptByMaterial.get(candidate.row.material_code) ?? 1,
      );
      result.receipts.push(receipt);
      result.rejected_locally += 1;
    }
    result.error_code = issue.error_code;
    result.channel_reachable = false;
    logger.warn('计费请求抬头字段超长，已本地拒收，未发出请求', {
      channel: 'outbound',
      operation_no,
      error_code: issue.error_code,
      duration_ms: null,
      field: issue.field,
      rejected_locally: result.rejected_locally,
    });
    return result;
  }

  const issueByIndex = new Map<number, FieldIssue>();
  for (const issue of inspection.item_issues) {
    if (!issueByIndex.has(issue.index)) issueByIndex.set(issue.index, issue);
  }

  const submittable: Array<{ row: BoundRow; use: MaterialUse }> = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const issue = issueByIndex.get(index);
    if (issue) {
      // 本地拒收：不进任何请求（**不截断后照发**），但照样有回执与核查条目
      const { receipt } = rejectLocally(
        db,
        candidate.row,
        operation_no,
        issue,
        attemptByMaterial.get(candidate.row.material_code) ?? 1,
      );
      result.receipts.push(receipt);
      result.rejected_locally += 1;
      continue;
    }
    submittable.push(candidate);
  }

  if (submittable.length === 0) {
    result.error_code = result.error_code ?? inspection.item_issues[0]?.error_code ?? null;
    return result;
  }

  // ── 契约层闸门：逐条判 —— 一条取值越界不拖垮同批其余 ──────────────────
  //   形状层管「形状」（必填 / 数量 / 超长）；契约层管「取值」（枚举 / 类型 / 长度）。
  //   逐条判：不合规的那条**本地拒收**（回执 + 核查条目 + 台账转人工），
  //   同批其余条目照常提交 —— 一次字段错误不该拖垮一台手术的计费。
  //
  //   注意这里为什么不再整份请求一起判：整份判会把那批里**字段全对**的耗材
  //   也一起判死，它们既没计上费、也没升核查条目，就停在 bound 等重投 ——
  //   那条路走不通（重投多少次还是不合规），最后只能人工逐条重投。
  const contractIssues = inspectMaterialUsesContractItems(
    operation_no,
    submittable.map((item) => item.use),
    { keyProfile: options.keyProfile },
  );
  const contractIssueByIndex = new Map<number, ContractItemIssue>();
  for (const issue of contractIssues) {
    if (!contractIssueByIndex.has(issue.index)) contractIssueByIndex.set(issue.index, issue);
  }

  const contractSubmittable: Array<{ row: BoundRow; use: MaterialUse }> = [];
  for (let index = 0; index < submittable.length; index += 1) {
    const candidate = submittable[index]!;
    const issue = contractIssueByIndex.get(index);
    if (!issue) {
      contractSubmittable.push(candidate);
      continue;
    }
    // 本地拒收：不进任何请求，但照样有回执与核查条目（台账行数守恒）
    const { receipt } = rejectLocally(
      db,
      candidate.row,
      operation_no,
      {
        index: -1,
        material_code: candidate.row.material_code,
        field: issue.path,
        error_code: issue.error_code,
        message: issue.message,
      },
      attemptByMaterial.get(candidate.row.material_code) ?? 1,
    );
    result.receipts.push(receipt);
    result.rejected_locally += 1;
    result.error_code = result.error_code ?? issue.error_code;
    logger.warn('计费明细不符合出站字段契约，已本地拒收，未发出请求', {
      channel: 'outbound',
      operation_no,
      material_code: candidate.row.material_code,
      error_code: issue.error_code,
      duration_ms: null,
      field: issue.path,
      rejected_locally: result.rejected_locally,
    });
  }

  if (contractSubmittable.length === 0) {
    return result;
  }

  // ── 分批提交：逐批独立结算 ────────────────────────────────────────────
  const outcomes = await submitChargeBatches(
    options.client,
    operation_no,
    deptCode,
    contractSubmittable.map((item) => ({ use: item.use, payload: item.row })),
    {
      path: options.path,
      maxBatchSize: options.maxBatchSize,
      limits: options.limits,
      keyProfile: options.keyProfile,
    },
  );

  result.batches = outcomes.length;
  result.calls = outcomes.length;
  result.submitted = contractSubmittable.length;

  for (const outcome of outcomes) {
    const batchRows = outcome.items.map((item) => item.payload);

    if (outcome.status === 'failed') {
      // 整批失败：逐条留失败回执，条目留在 bound 等退避重投（不静默改状态）
      const failure = outcome.failure!;
      result.failed_batches += 1;
      if (!failure.channel_reachable) result.channel_reachable = false;
      result.error_code = result.error_code ?? failure.error_code;
      const receipts = batchRows.map((row) =>
        failureReceipt({
          material_code: row.material_code,
          operation_no,
          idempotency_key: row.idempotency_key,
          key_profile: row.key_profile,
          request_idempotency_key: outcome.request_idempotency_key,
          // 逐条尝试序号（按条目取，不整批共用一个）
          attempt: attemptByMaterial.get(row.material_code) ?? 1,
          delivery_count: attemptByMaterial.get(row.material_code) ?? 1,
          failure,
          // 载荷快照：失败也要留「当时发出去的是什么」，否则事后查不出是口径问题还是通道问题
          submitted_quantity: chargeQuantityOf(row),
          submitted_price_code: row.price_code,
          submitted_fee_category: row.fee_category,
          submitted_medical_insurance_class: row.medical_insurance_class,
        }),
      );
      // 回执行 + 审计行同事务提交：中途抛错两者一起回滚，不留半写
      withTransaction(db, () => {
        recordReceipts(db, receipts);
        appendAudit(db, {
          event_type: 'charge_writeback_failed',
          binding_key: batchRows[0]?.idempotency_key ?? null,
          operation_no,
          actor: 'charge_writeback',
          detail: JSON.stringify({
            error_code: failure.error_code,
            reason_code: failure.reason_code,
            channel_reachable: failure.channel_reachable,
            retryable: failure.retryable,
            submitted: batchRows.length,
            batch_index: outcome.index,
            batches: outcomes.length,
          }),
        });
      });
      result.receipts.push(...receipts);
      logger.warn('计费回写失败，已进退避重投队列', {
        channel: 'outbound',
        operation_no,
        error_code: failure.error_code,
        duration_ms: null,
        channel_reachable: failure.channel_reachable,
        retryable: failure.retryable,
        submitted: batchRows.length,
        batch_index: outcome.index,
      });
      continue;
    }

    // 逐条回执：对端接收 → charged；对端拒收 → 核查条目 + check_pending
    const receipts = classifyReceipts({
      response: outcome.response!,
      submitted: outcome.items.map((item) => item.use),
      operation_no,
      attempt: 1,
      // 逐条尝试序号：同批里各条耗材的尝试次数可以不同
      attempt_by_material: attemptByMaterial,
      request_idempotency_key: outcome.request_idempotency_key,
      requested_at: options.useTime ?? new Date().toISOString(),
      responded_at: new Date().toISOString(),
    });

    // 台账行 + 回执行 + 审计行同事务提交：中途抛错三者一起回滚，不留半写
    withTransaction(db, () => {
      recordReceipts(db, receipts);

      receipts.forEach((receipt, index) => {
        const row = batchRows[index];
        if (!row) return;
        if (receipt.accepted) {
          result.accepted += 1;
          logger.info('计费已被对端接收', {
            channel: 'outbound',
            operation_no,
            material_code: receipt.material_code,
            conclusion: 'CHARGE_ACCEPTED',
            error_code: null,
            duration_ms: null,
            delivery_count: receipt.delivery_count,
            batch_index: outcome.index,
          });
          transitionBindingStatus(db, {
            binding_id: row.id,
            material_code: row.material_code,
            operation_no,
            idempotency_key: row.idempotency_key,
            to: 'charged',
            actor: 'charge_writeback',
          });
          appendAudit(db, {
            event_type: 'charge_delivered',
            binding_key: row.idempotency_key,
            operation_no,
            actor: 'charge_writeback',
            detail: JSON.stringify({
              material_code: row.material_code,
              attempt: receipt.attempt,
              delivery_count: receipt.delivery_count,
              kind: CHARGE_RECEIPT_KINDS.accepted,
              batch_index: outcome.index,
            }),
          });
          return;
        }

        result.rejected += 1;
        const reasonCode = receipt.reason_code ?? receipt.kind;
        // 统一错误码：与回执行、日志展示同一个码
        const errorCode = receipt.error_code ?? errorCodeForReason(reasonCode);
        // 处置档位（可重投 / 不可重投 / 需人工）：由判定表给出
        const disposition = receipt.disposition ?? RECEIPT_DISPOSITIONS.NOT_RETRYABLE;

        // 未知码：登记进错误码表待补项，原始码不许丢（审计链里也留一行）
        registerUnknownReceiptReason(db, {
          reason_code: reasonCode,
          material_code: row.material_code,
          operation_no,
          binding_key: row.idempotency_key,
          error_code: errorCode,
          disposition,
        });

        // 可重投的对端拒收（限流 / 服务繁忙 / 临时库存锁）：
        // **不生成核查条目** —— 条目留在 bound 等退避重投。
        // 回执行 retryable=1，重启后可从台账重建待重投条目（`listRetryCandidates`）。
        if (disposition === RECEIPT_DISPOSITIONS.RETRYABLE) {
          logger.warn('计费被对端临时拒收，已进退避重投队列', {
            channel: 'outbound',
            operation_no,
            material_code: row.material_code,
            conclusion: 'CHARGE_RETRY_SCHEDULED',
            error_code: errorCode,
            duration_ms: null,
            reason_code: reasonCode,
            disposition,
            delivery_count: receipt.delivery_count,
            batch_index: outcome.index,
          });
          appendAudit(db, {
            event_type: 'charge_retry_scheduled',
            binding_key: row.idempotency_key,
            operation_no,
            actor: 'charge_writeback',
            detail: JSON.stringify({
              material_code: row.material_code,
              attempt: receipt.attempt,
              delivery_count: receipt.delivery_count,
              kind: receipt.kind,
              error_code: errorCode,
              reason_code: reasonCode,
              disposition,
              batch_index: outcome.index,
            }),
          });
          return;
        }

        const checkTaskId = createCheckTask(db, {
          operation_no,
          room_no: row.room_no,
          dept_code: row.dept_code,
          material_code: row.material_code,
          quantity: chargeQuantityOf(row),
          conclusion: 'CHARGE_REJECTED',
          reason_code: reasonCode,
          error_code: errorCode,
        });
        logger.warn(
          disposition === RECEIPT_DISPOSITIONS.NEEDS_HUMAN
            ? '计费被对端拒收，需人工判断，已转核查'
            : '计费被对端拒绝，已转人工核查',
          {
            channel: 'outbound',
            operation_no,
            material_code: row.material_code,
            conclusion: 'CHARGE_REJECTED',
            error_code: errorCode,
            duration_ms: null,
            reason_code: reasonCode,
            disposition,
            delivery_count: receipt.delivery_count,
            batch_index: outcome.index,
          },
        );
        transitionBindingStatus(db, {
          binding_id: row.id,
          material_code: row.material_code,
          operation_no,
          idempotency_key: row.idempotency_key,
          to: 'check_pending',
          actor: 'charge_writeback',
          check_task_id: checkTaskId,
        });
        appendAudit(db, {
          event_type: 'charge_escalated',
          binding_key: row.idempotency_key,
          operation_no,
          actor: 'charge_writeback',
          detail: JSON.stringify({
            material_code: row.material_code,
            attempt: receipt.attempt,
            delivery_count: receipt.delivery_count,
            kind: receipt.kind,
            reason_code: reasonCode,
            error_code: errorCode,
            disposition,
            check_task_id: checkTaskId,
            batch_index: outcome.index,
          }),
        });
      });
    });

    result.receipts.push(...receipts);
  }

  // 出站请求计数：**每真的打出去一次对端，就 +1**（跨进程留得住）。
  // 重放要证明「重放不会产生第二笔计费」，靠的就是这个跨重放留得住的计数 ——
  // 回执行记的是「条目维度投了几次」，与「请求打了几次」不是一个数。
  if (result.calls > 0) {
    addMetaCounter(db, META_KEY_OUTBOUND_CALLS, result.calls);
  }

  return result;
}
