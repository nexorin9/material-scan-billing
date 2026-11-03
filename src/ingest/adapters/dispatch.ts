/**
 * 两路来源共用的分发层：统一批次信封 → 逐条结算 → 逐条结论。
 *
 * 这一层是「共用解析层与幂等键」的落点：
 *   - 结算走 `src/engine/settle.ts` 的 `settleEvent`，幂等键由
 *     `src/domain/idempotency.ts` 的 `deriveIdempotencyKey` 派生 —— 两路完全同一把尺子；
 *   - 解析层拒掉的坏行（目录投递才有）并进 rejected，并写进审计链，
 *     **不静默丢弃**（坏行也要能回看：设备侧到底报了什么）。
 *
 * 结论条数守恒：`accepted + rejected === total`（含坏行），一条都不丢。
 */

import type { DatabaseSync } from 'node:sqlite';

import { appendAudit } from '../../ledger/audit.js';
import { appendEventLog } from '../../ledger/event-log.js';
import { settleEvent, type SettleOptions } from '../../engine/settle.js';
import type { BindingOutcome } from '../../engine/binding.js';
import { errorCodeForReason } from '../../log/error-codes.js';
import type { EventBatch, EventBatchReject, RouteConclusion } from './event-source.js';

/** 结算层结论 → 统一逐条视图 */
function toRouteConclusion(outcome: BindingOutcome): RouteConclusion {
  return {
    material_code: outcome.material_code,
    operation_no: outcome.operation_no,
    bound: outcome.bound,
    conclusion: outcome.conclusion,
    reason_code: outcome.reason_code ?? 'UNKNOWN',
    error_code: outcome.error_code,
    charge_state: outcome.charge_state,
    detail: outcome.detail ?? null,
  };
}

/** 分发结果 */
export interface DispatchResult {
  /** 绑定成功的条目 */
  accepted: BindingOutcome[];
  /** 结算层判定的异常条目（含批内重复） */
  rejected: BindingOutcome[];
  /** 解析层拒掉的坏行（目录投递路才有） */
  rejects: EventBatchReject[];
  /**
   * 统一逐条视图：绑定成功 + 结算层异常 + 解析层坏行。
   *
   * 「该行 rejected」在两路都是同一个意思：这一行没绑上，原因码各不相同。
   */
  outcomes: RouteConclusion[];
  /** 批次统计 */
  stats: {
    /** 结论总条数（accepted + rejected，含坏行） */
    total: number;
    accepted: number;
    rejected: number;
    duplicate_in_batch: number;
  };
}

/** 分发层的输入选项 */
export interface DispatchOptions extends SettleOptions {
  /**
   * 是否把这次事件写进事件日志（默认写）。
   *
   * replay 重放时置 false —— 重放不是一次新的设备投递，
   * 写进去会让事件日志每重放一次就长一截（越重放越多，没法核对）。
   */
  logEvent?: boolean;
}

/**
 * 结算一个批次。
 *
 * 逐条流程与单条完全一致：**任何一条抛错都只影响这一条**（结算层已隔离），
 * 同批其余回执一条都不丢；解析层的坏行单独成条，不影响其余条目入台账。
 */
export function dispatchBatch(
  db: DatabaseSync,
  batch: EventBatch,
  options: DispatchOptions = {},
): DispatchResult {
  // 坏行先记审计（结算之前）：设备侧报错了要能回看，即使这一批最后一条都没绑上
  for (const reject of batch.rejects) {
    appendAudit(db, {
      event_type: 'ingest_bad_line',
      operation_no: batch.operation_no,
      scanner_id: batch.scanner_id,
      actor: 'ingest',
      detail: JSON.stringify({
        source: batch.source,
        line_no: reject.line_no,
        reason_code: reject.reason_code,
        material_code: reject.material_code,
        detail: reject.detail,
      }),
    });
  }

  const settled = settleEvent(
    db,
    {
      operation_no: batch.operation_no,
      room_no: batch.room_no,
      scanner_id: batch.scanner_id,
      items: batch.items,
    },
    options,
  );

  // 事件日志落一行：原始报文 + 归一结果 + 结论分布。
  // 两路共用这一个落点 —— 事件从哪来不影响「发生了什么」的记录口径；
  // replay 子命令从这张表取事件重放（走的是同一套装配与结算逻辑）。
  if (options.logEvent !== false) {
    appendEventLog(db, {
      request_id: batch.request_id ?? null,
      source: batch.source,
      operation_no: batch.operation_no,
      room_no: batch.room_no,
      scanner_id: batch.scanner_id,
      raw_body: batch.raw_body ?? null,
      normalized_json: JSON.stringify({
        operation_no: batch.operation_no,
        room_no: batch.room_no,
        scanner_id: batch.scanner_id,
        items: batch.items.map((item) => ({
          material_code: item.material_code,
          raw_code: item.raw_code,
          quantity: item.quantity,
          batch_no: item.batch_no ?? null,
        })),
      }),
      signature_verified: batch.signature_verified === true,
      conclusion: `accepted=${settled.accepted.length};rejected=${settled.rejected.length}`,
      batch_id: batch.batch_id ?? null,
      // 耗材码关联：事件日志一行是「一批」，按码要能反查是哪几批
      material_codes: batch.items.map((item) => item.material_code),
      raw_codes: batch.items.map((item) => item.raw_code),
    });
  }

  return {
    accepted: settled.accepted,
    rejected: settled.rejected,
    rejects: [...batch.rejects],
    outcomes: [
      ...settled.accepted.map(toRouteConclusion),
      ...settled.rejected.map(toRouteConclusion),
      ...batch.rejects.map((reject) => ({
        material_code: reject.material_code,
        operation_no: batch.operation_no,
        bound: false,
        conclusion: 'NOT_REGISTERED' as const,
        reason_code: reject.reason_code,
        error_code: errorCodeForReason(reject.reason_code),
        charge_state: 'not_submitted',
        detail: reject.detail,
      })),
    ],
    stats: {
      total: settled.accepted.length + settled.rejected.length + batch.rejects.length,
      accepted: settled.accepted.length,
      rejected: settled.rejected.length + batch.rejects.length,
      duplicate_in_batch: settled.stats.duplicate_in_batch,
    },
  };
}
