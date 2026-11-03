/**
 * 计费请求分批：把一台次的耗材明细按**对端限批**切成若干批，逐批独立提交。
 *
 * 为什么要有这一层：
 *   HIS 计费端通常对单次请求的**条目数**有上限（一次提交 300 条会被拒，
 *   有的对端还会直接掐连接）。手术室一台手术下来的高值耗材条数不固定，
 *   复杂手术过百条很常见 —— 不切分就整台手术的计费一起丢。
 *
 *   三条硬约束：
 *     ① **分批不丢条** —— 提交 N 条就产出 N 条结论（回执条数恒等于提交条数）；
 *     ② **逐批独立结算** —— 某批整体失败（网络 / 5xx）只让该批进退避重投，
 *        其余批的结论照常落库，一条批的失败不拖累另一条批；
 *     ③ **条目与回执一一对齐** —— 每批带着自己的明细走，回执按条目原序回填，
 *        绝不靠「按耗材码反查」（同码多批时反查会串行）。
 *
 * 语义来源（源产品主路径）：源产品用 `BatchSendUniqueMessagesBody { messages: Vec<UniqueMessage> }`
 * 一次投递一批，回执是 `SendMessageResponse { receipts: Vec<MessageReceipt> }` ——
 * **投递几条就回几条回执**，回执与投递清单成对返回。本模块照此语义改写成
 * 耗材计费场景：分批只是把「一批」再切细，**回执条数守恒这条不变**。
 */

import { splitIntoBatches } from '../ledger/db.js';
import type { FieldLengthLimits } from '../api/contracts.js';
import type { ConfigurableIdempotencyKeyProfile } from '../domain/idempotency.js';
import { type HisChargingClient } from './client.js';
import {
  postPreparedMaterialUses,
  prepareMaterialUsesRequest,
  type MaterialUse,
  type MaterialUsesResponse,
} from './submit.js';
import { CHARGE_INTERNAL_ERROR_CODE, classifyFailure, type ChargeFailureClass } from './receipt.js';

/** 单次提交的条目数上限默认值（对端限批；可由 HIS_CHARGING_MAX_BATCH_SIZE 覆盖） */
export const CHARGE_BATCH_MAX_SIZE_DEFAULT = 100;

/**
 * 解析批次上限：非正整数 / 非法值一律退回默认值。
 *
 * 这里**不**报错停机：批次上限调错的后果是「多发几次请求」，
 * 不是「记错账」；但也不能放任 0 或负数把整台手术塞进一个请求里。
 */
export function resolveChargeBatchSize(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return CHARGE_BATCH_MAX_SIZE_DEFAULT;
  }
  return value;
}

/** 一条待提交的明细：出站字段 + 调用方自己的载荷（台账行等） */
export interface ChargeBatchItem<T = unknown> {
  /** 出站明细 */
  use: MaterialUse;
  /** 调用方载荷：随批原样带回，调用方据此把回执对齐回自己的条目 */
  payload: T;
}

/** 一批的提交结果 */
export interface ChargeBatchOutcome<T = unknown> {
  /** 第几批（从 1 起） */
  index: number;
  /** 本批条目数 */
  size: number;
  /** 本批状态：delivered = 拿到对端响应；failed = 整批没拿到结论 */
  status: 'delivered' | 'failed';
  /** 失败时的错误码（成功时为 null） */
  error_code: string | null;
  /** 失败定性（通道可达否 / 值不值得重投） */
  failure: ChargeFailureClass | null;
  /** 对端响应（失败时为 null） */
  response: MaterialUsesResponse | null;
  /** 本批条目（含失败批 —— 失败批的条目同样要留回执，不静默丢弃） */
  items: Array<ChargeBatchItem<T>>;
  /**
   * 本批的**请求级幂等键**（对端据此丢弃重复请求）。
   *
   * 成功与失败都有：失败批同样把请求发出去过，事后要查得到「发了什么键」。
   */
  request_idempotency_key: string | null;
  /** 本批用的键档位（v1 / v2） */
  key_profile: string | null;
}

export interface ChargeBatchOptions {
  /** 端点路径（来自配置，不硬编码） */
  path: string;
  /** 单次提交条目数上限（默认 100） */
  maxBatchSize?: number;
  /** 关键字段长度上限表（默认取契约表） */
  limits?: FieldLengthLimits;
  /** 本次请求使用的键档位（默认 v1；来自配置项 IDEMPOTENCY_KEY_PROFILE） */
  keyProfile?: ConfigurableIdempotencyKeyProfile;
}

/**
 * 逐批提交计费明细。
 *
 * @param client 出站客户端（凭据单一出口）
 * @param operation_no 台次号
 * @param dept_code 科室编码
 * @param items 待提交明细（带调用方载荷）
 * @param options 端点路径与批次上限
 * @returns 逐批结果（顺序与切分顺序一致）
 */
export async function submitChargeBatches<T>(
  client: HisChargingClient,
  operation_no: string,
  dept_code: string,
  items: readonly ChargeBatchItem<T>[],
  options: ChargeBatchOptions,
): Promise<Array<ChargeBatchOutcome<T>>> {
  const maxBatchSize = resolveChargeBatchSize(options.maxBatchSize);
  const batches = splitIntoBatches(items, maxBatchSize);
  const outcomes: Array<ChargeBatchOutcome<T>> = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index] ?? [];
    const batchIndex = index + 1;
    // 先把键算好：**失败批也要留下请求级键**（事后查得到这一批发了什么）
    const prepared = prepareMaterialUsesRequest(
      operation_no,
      dept_code,
      batch.map((item) => item.use),
      { keyProfile: options.keyProfile },
    );
    try {
      const response = await postPreparedMaterialUses(client, prepared, {
        path: options.path,
        limits: options.limits,
      });
      outcomes.push({
        index: batchIndex,
        size: batch.length,
        status: 'delivered',
        error_code: null,
        failure: null,
        response,
        items: batch,
        request_idempotency_key: prepared.request_key,
        key_profile: prepared.key_profile,
      });
    } catch (error) {
      // 整批失败只定性这一批：其余批照常提交（逐批独立结算）
      const failure = classifyFailure(error);
      outcomes.push({
        index: batchIndex,
        size: batch.length,
        status: 'failed',
        error_code: failure.error_code ?? CHARGE_INTERNAL_ERROR_CODE,
        failure,
        response: null,
        items: batch,
        request_idempotency_key: prepared.request_key,
        key_profile: prepared.key_profile,
      });
    }
  }

  return outcomes;
}
