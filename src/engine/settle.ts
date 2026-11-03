/**
 * 批量结算层：一批扫码事件 → 逐条独立结算 → 逐条回执。
 *
 * 语义来源（源产品主路径）：源产品的批量投递体 `BatchSendUniqueMessagesBody { messages }`
 * 一次投一批，响应体 `SendMessageResponse { receipts }` —— **每条消息一份回执**；
 * 源在投递聚合处用 `join_all`（而非 `try_join_all`）聚合各目标的结果，注释明示
 * 「单条投递失败是普通结果而非中断」，不得丢弃已产生的回执。
 * 本层把这条语义改写成耗材场景：
 *
 *   - 一批扫码事件逐条走「幂等 claim → 绑定判定 → 台账落行 → 结论产出」；
 *   - **单条抛错只让这一条**落 rejected 并给 reason_code，同批其余照常给结论；
 *   - 批内重复的 (material_code, operation_no) 只结算一次，其余标「批内重复」；
 *   - 汇总元数据 {total, accepted, rejected, duplicate_in_batch, batches} 供企微批次摘要与 doctor 复用。
 *
 * 硬约束：
 *   ① 结论条数守恒：accepted + rejected === total，一条都不丢；
 *   ② 批内重复不产生第二行台账、不触发第二次计费；
 *   ③ 失败不静默改数据：单条异常只改这一条的结论，其余条目与台账不受影响；
 *   ④ 一批一个事务：台账行 + 审计行 + 核查行同批提交或同批回滚，不留半写。
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_IDEMPOTENCY_KEY_PROFILE,
  deriveIdempotencyKeyForProfile,
  type ConfigurableIdempotencyKeyProfile,
} from '../domain/idempotency.js';
import { DEFAULT_BATCH_COMMIT_SIZE, splitIntoBatches, withTransaction } from '../ledger/db.js';
import { bindOne, REASON_INTERNAL_ERROR, type BindingOutcome } from './binding.js';
import type { ScannerContext } from './operation.js';
import { EMPTY_SCANNER_REGISTRY, type ScannerRegistry } from '../config/scanner-registry.js';
import { defaultLogger, type Logger } from '../log/logger.js';

/** 批内重复原因码：同一批里同一 (耗材码, 台次) 重复出现 */
export const REASON_DUPLICATE_IN_BATCH = 'DUPLICATE_IN_BATCH';

/** 一条已归一的耗材条目（码制归一后仍保留原始码，供事后核对） */
export interface SettleItem {
  /** 归一后的院内耗材码 */
  material_code: string;
  /** 设备上报的原始码 */
  raw_code: string;
  /** 数量 */
  quantity: number;
  /** 批号：v2 档位的去重维度（同一耗材的不同生产批次是两次真实消耗） */
  batch_no?: string | null;
  /** 码制：UDI / GS1_AI01 / INTERNAL */
  code_form?: string | null;
  /** 码制解析轨迹（JSON 字符串；落台账供事后核对） */
  code_parse_trace?: string | null;
  /**
   * 业务使用时间（设备上报的扫码时间，归一后落库）。
   *
   * 月度对账按**业务月**切账期，用的就是它 —— 不是台账落账时间。
   */
  use_time?: string | null;
}

/** 一批结算输入：与一条扫码事件一一对应（台次 + 手术间 + 扫码枪 + 本批耗材条目） */
export interface SettleBatch {
  /** 台次号 */
  operation_no: string;
  /** 手术间 */
  room_no: string;
  /** 扫码枪编号 */
  scanner_id: string;
  /**
   * 事件自带的科室上下文（可空）—— 参与归属双因子核对。
   */
  dept_code?: string | null;
  /** 本批耗材条目（已归一） */
  items: readonly SettleItem[];
}

/** 单条结算的输入上下文 */
export interface SettleItemContext {
  db: DatabaseSync;
  operation_no: string;
  room_no: string;
  scanner_id: string;
  /** 事件自带的科室上下文（可空） */
  dept_code?: string | null;
  /** 扫码枪位置登记（可空） */
  scanner?: ScannerContext | null;
  material_code: string;
  raw_code: string;
  quantity: number;
  /** 批号（v2 档位的去重维度） */
  batch_no?: string | null;
  /** 码制：UDI / GS1_AI01 / INTERNAL */
  code_form?: string | null;
  /** 码制解析轨迹（JSON 字符串；落台账供事后核对） */
  code_parse_trace?: string | null;
  /** 业务使用时间（设备上报的扫码时间；月度对账按业务月切账期用） */
  use_time?: string | null;
  /** 幂等键档位（默认 v1） */
  key_profile?: ConfigurableIdempotencyKeyProfile;
  /**
   * 本次投递的标识（溯源用）。
   *
   * 台账行与审计行都带它：按一个 request_id 就能把「设备报了什么 → 落了哪几行账
   * → 怎么处置」串起来（事件日志、台账、审计链三边共用同一个标识）。
   */
  request_id?: string | null;
}

/** 单条结算函数：默认走绑定判定主路（`bindOne`） */
export type SettleProcessor = (ctx: SettleItemContext) => BindingOutcome;

export interface SettleOptions {
  /**
   * 逐条结算函数。默认 `bindOne`；留这个口子是为了能在测试里注入单条故障，
   * 证明「一条抛错不丢同批其余」在结算层真的成立（而不是碰巧没出错）。
   */
  processor?: SettleProcessor;
  /**
   * 结构化日志器（可选；不传则用默认日志器写 stdout）。
   *
   * 逐条结论在这里落一条日志：台次、耗材码、结论、统一错误码、耗时 ——
   * 出问题时信息科在日志里直接按错误码定位到那一条耗材。
   */
  logger?: Logger;
  /** 本批的投递标识（写进每条日志，便于按批回溯） */
  request_id?: string | null;
  /**
   * 单事务批量提交的最大条目数（默认 200）。
   *
   * 一批一个事务：台账行 + 审计行 + 核查行同批提交或同批回滚，不留半写。
   * 超过这个阈值就按批切分（每批各开一个事务）—— 一次几百条的大事务会把
   * SQLite 的写锁占很久，别的进程写不进来。
   */
  batchSize?: number;
  /**
   * 幂等键档位（默认 v1：同码同台次只算一次）。
   *
   * v2 档位把批号纳入去重维度：同一耗材同一台次的**不同批号各算一次**
   * （各产生一行台账、各触发一次计费）。
   */
  keyProfile?: ConfigurableIdempotencyKeyProfile;
  /**
   * 扫码枪位置登记簿（可空；不传 = 空登记簿）。
   *
   * 归属双因子核对要用它取「事件侧的科室上下文」与「配置漂移」判定。
   */
  scannerRegistry?: ScannerRegistry;
}

/** 批次统计（供企微批次摘要与 doctor 复用） */
export interface SettleStats {
  /** 本批条目总数（含批内重复条目） */
  total: number;
  /** 绑定成功条数 */
  accepted: number;
  /** 异常条数（含批内重复） */
  rejected: number;
  /** 批内重复被去重的条数 */
  duplicate_in_batch: number;
  /** 本次切成几批提交（每批一个事务；条目数超过阈值才会 > 1） */
  batches: number;
}

export interface SettleBatchResult {
  /** 绑定成功的条目 */
  accepted: BindingOutcome[];
  /** 异常条目（含批内重复与单条异常） */
  rejected: BindingOutcome[];
  /** 批次统计 */
  stats: SettleStats;
}

/** 默认逐条结算：绑定判定主路（幂等占位 → 判定 → 台账落行） */
const defaultProcessor: SettleProcessor = (ctx) => bindOne(ctx.db, ctx);

/**
 * 落一条逐条结论日志。
 *
 * 每条都带：台次、耗材码、结论、统一错误码、耗时、投递标识 ——
 * 出问题时信息科按错误码就能定位到**具体那一条耗材**，而不是在几百行日志里翻。
 */
function logOutcome(
  logger: Logger,
  request_id: string | null,
  batch: SettleBatch,
  item: SettleItem,
  outcome: BindingOutcome,
  startedAt: number,
): void {
  const context = {
    request_id,
    channel: 'binding',
    operation_no: batch.operation_no,
    material_code: item.material_code,
    conclusion: outcome.conclusion,
    error_code: outcome.error_code,
    duration_ms: Date.now() - startedAt,
    reason_code: outcome.reason_code,
    scanner_id: batch.scanner_id,
    room_no: batch.room_no,
  };
  if (outcome.bound) {
    logger.info('耗材已绑定本台次', context);
    return;
  }
  logger.warn('耗材未绑定，已转人工核查', context);
}

/**
 * 批量结算：把若干批耗材条目逐条独立结算。
 *
 * 逐条流程与单条完全一致；**任何一条抛错都只影响这一条**：
 * 捕获后该条落 rejected（reason_code = INTERNAL_ERROR），循环继续处理其余条目，
 * 最后汇总返回 —— 同批其余回执一条都不丢。
 *
 * 落库口径：**一批一个事务**（台账行 + 审计行 + 核查行同批提交或同批回滚）。
 * 条目数超过 `batchSize`（默认 200）就按批切分，逐批各开一个事务 ——
 * 一批失败不影响别的批，结论条数始终守恒。
 */
export function settleBatch(
  db: DatabaseSync,
  batches: readonly SettleBatch[],
  options: SettleOptions = {},
): SettleBatchResult {
  const processor: SettleProcessor = options.processor ?? defaultProcessor;
  const logger = options.logger ?? defaultLogger;
  const keyProfile = options.keyProfile ?? DEFAULT_IDEMPOTENCY_KEY_PROFILE;
  const registry: ScannerRegistry = options.scannerRegistry ?? EMPTY_SCANNER_REGISTRY;
  const accepted: BindingOutcome[] = [];
  const rejected: BindingOutcome[] = [];

  // 批内去重：同一 (耗材码, 台次) 在本次结算里只结算一次。
  // 去重键与台账幂等键同源（同一把尺子派生），保证「批内只算一次」与
  // 「跨批不重复计费」口径一致；v2 档位下批号参与去重，不同批号各算一次。
  const settled = new Set<string>();
  let duplicateInBatch = 0;

  // 摊平成待结算条目（保留批次上下文），再按批切分 —— 切的是「提交单元」，不是结论单元。
  const work: Array<{ batch: SettleBatch; item: SettleItem }> = [];
  for (const batch of batches) {
    for (const item of batch.items) work.push({ batch, item });
  }
  const total = work.length;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_COMMIT_SIZE;
  let committedBatches = 0;

  for (const chunk of splitIntoBatches(work, batchSize)) {
    // 结论先落在**批内**的临时数组里：这一批事务提交成功才并进总账。
    // 提交失败（磁盘满 / 表被锁）时台账不留半写的行，而这一批的条目
    // 逐条补一条 rejected 结论 —— 条数守恒，结论一条都不丢。
    const chunkAccepted: BindingOutcome[] = [];
    const chunkRejected: BindingOutcome[] = [];
    let chunkFailure: unknown = null;

    try {
      withTransaction(db, () => {
        for (const { batch, item } of chunk) {
          const startedAt = Date.now();

          const key = deriveIdempotencyKeyForProfile(
            {
              material_code: item.material_code,
              operation_no: batch.operation_no,
              batch_no: item.batch_no ?? null,
            },
            keyProfile,
          ).key;
          if (settled.has(key)) {
            duplicateInBatch += 1;
            chunkRejected.push({
              material_code: item.material_code,
              operation_no: batch.operation_no,
              bound: false,
              conclusion: 'NOT_REGISTERED',
              reason_code: REASON_DUPLICATE_IN_BATCH,
              error_code: 'ERR_DUPLICATE_IN_BATCH',
              charge_state: 'not_submitted',
              detail: `同一批里第 ${duplicateInBatch + 1} 次出现「耗材 ${item.material_code} + 台次 ${batch.operation_no}」，本次不重复结算`,
            });
            logOutcome(logger, options.request_id ?? null, batch, item, chunkRejected[chunkRejected.length - 1]!, startedAt);
            continue;
          }
          settled.add(key);

          let outcome: BindingOutcome;
          try {
            outcome = processor({
              db,
              operation_no: batch.operation_no,
              room_no: batch.room_no,
              scanner_id: batch.scanner_id,
              dept_code: batch.dept_code ?? null,
              scanner: registry.lookup(batch.scanner_id) ?? null,
              material_code: item.material_code,
              raw_code: item.raw_code,
              quantity: item.quantity,
              batch_no: item.batch_no ?? null,
              code_form: item.code_form ?? null,
              code_parse_trace: item.code_parse_trace ?? null,
              use_time: item.use_time ?? null,
              key_profile: keyProfile,
              request_id: options.request_id ?? null,
            });
          } catch (error) {
            // 单条异常隔离：这一条失败只是这一条的普通结果，不中断同批其余条目，
            // 也不改同批已落下的台账行（失败不静默改数据）。
            outcome = {
              material_code: item.material_code,
              operation_no: batch.operation_no,
              bound: false,
              conclusion: 'NOT_REGISTERED',
              reason_code: REASON_INTERNAL_ERROR,
              error_code: 'ERR_INTERNAL',
              charge_state: 'not_submitted',
              detail: error instanceof Error ? error.message : String(error),
            };
          }

          logOutcome(logger, options.request_id ?? null, batch, item, outcome, startedAt);
          if (outcome.bound) chunkAccepted.push(outcome);
          else chunkRejected.push(outcome);
        }
      });
      committedBatches += 1;
    } catch (error) {
      chunkFailure = error;
    }

    if (chunkFailure) {
      // 这一批提交失败：结论补成 rejected（条数守恒），台账不留下半写的行
      chunkAccepted.length = 0;
      chunkRejected.length = 0;
      for (const { batch, item } of chunk) {
        const outcome: BindingOutcome = {
          material_code: item.material_code,
          operation_no: batch.operation_no,
          bound: false,
          conclusion: 'NOT_REGISTERED',
          reason_code: REASON_INTERNAL_ERROR,
          error_code: 'ERR_INTERNAL',
          charge_state: 'not_submitted',
          detail: `本批提交失败，台账未落行：${chunkFailure instanceof Error ? chunkFailure.message : String(chunkFailure)}`,
        };
        chunkRejected.push(outcome);
        logOutcome(logger, options.request_id ?? null, batch, item, outcome, Date.now());
      }
    }

    accepted.push(...chunkAccepted);
    rejected.push(...chunkRejected);
  }

  return {
    accepted,
    rejected,
    stats: {
      total,
      accepted: accepted.length,
      rejected: rejected.length,
      duplicate_in_batch: duplicateInBatch,
      batches: committedBatches,
    },
  };
}

/**
 * 结算单个扫码事件（一个台次的一批耗材条目）。
 * HTTP 入站与目录投递两条路都走这里，语义完全一致。
 */
export function settleEvent(
  db: DatabaseSync,
  batch: SettleBatch,
  options: SettleOptions = {},
): SettleBatchResult {
  return settleBatch(db, [batch], options);
}
