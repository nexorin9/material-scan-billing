/**
 * 计费重投层：指数退避重投调度 + 达上限转人工。
 *
 * 语义来源（源产品主路径）：源产品的投递回执带 `delivery_count`（投递次数）与 `active`
 * （通道当时是否可达）—— **投递了几次、当时通不通**，这两件事在回执里必须看得见；
 * 单条投递失败是普通结果而非中断。
 * 本模块照此语义改写成耗材计费场景：
 *
 *   - 一条耗材一次投递失败 → 追加一行回执（delivery_count 递增）；
 *   - 通道当时不可达（超时 / 连接失败 / 5xx）→ **指数退避**重投：间隔 = base × 2^n，
 *     间隔与次数上限可配；
 *   - 通道可达但对端业务拒绝（4xx / rejected[].reason_code）→ **不重投**，直接转人工核查；
 *   - 重投到次数上限仍失败 → 生成带台次上下文的**核查任务**并把台账状态转人工，
 *     **不静默丢弃**；
 *   - 已回写计费的条目**不自动冲正**：状态停在 charged，重投不会把它打回 rejected。
 *
 * 硬约束：
 *   ① 重投**复用同一把幂等键**（不因重试次数变化而改键）——对端据此可去重；
 *   ② 台账状态只沿状态机白名单推进，非法迁移被拒（不静默改数据）；
 *   ③ 重投队列在进程内，**回执台账是持久事实**：进程重启后可从台账重建待重投条目。
 */

import type { DatabaseSync } from 'node:sqlite';

import { appendAudit } from '../ledger/audit.js';
import { readBindingStatus, transitionBindingStatus } from '../ledger/binding-repo.js';
import { createCheckTask } from '../check/task.js';
import {
  CHARGE_RECEIPT_KINDS,
  classifyFailure,
  classifyReceipts,
  failureReceipt,
  lastAttempt,
  recordReceipts,
  registerUnknownReceiptReason,
  type ChargeFailureClass,
  type ChargeReceipt,
} from './receipt.js';
import { RECEIPT_DISPOSITIONS } from './reason-codes.js';
import type { MaterialUse, MaterialUsesResponse } from './submit.js';
import { resolveChargeQuantity } from './quantity.js';
import { sanitizeMaterialUse } from './sanitize.js';
import { deriveRequestIdempotencyKey } from '../domain/idempotency.js';

/** 重投默认参数（间隔与上限可配） */
export const RETRY_DEFAULTS = {
  /** 最多投递几次（含首次） */
  maxAttempts: 3,
  /** 退避基数（毫秒） */
  baseDelayMs: 1_000,
  /** 单次退避上限（毫秒） */
  maxDelayMs: 30_000,
} as const;

/**
 * 指数退避间隔：base × 2^(n-1)，封顶 maxDelay。
 *
 * n = 1 → base；n = 2 → 2×base；n = 3 → 4×base……
 */
export function computeBackoffDelay(
  baseDelayMs: number,
  attempt: number,
  maxDelayMs: number = RETRY_DEFAULTS.maxDelayMs,
): number {
  const base = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 0;
  const cap = Number.isFinite(maxDelayMs) && maxDelayMs > 0 ? maxDelayMs : Number.MAX_SAFE_INTEGER;
  const n = Math.max(1, Math.floor(attempt));
  const delay = base * Math.pow(2, n - 1);
  return Math.min(delay, cap);
}

/** 一条待投递的耗材计费条目 */
export interface ChargeItem {
  material_code: string;
  operation_no: string;
  /** 手术间 */
  room_no: string;
  /** 科室 */
  dept_code: string;
  /** 扫码枪 */
  scanner_id: string | null;
  quantity: number;
  price_code: string;
  use_time: string;
  fee_category: string;
  medical_insurance_class: string;
  /** 幂等键（重投复用同一把） */
  idempotency_key: string;
  /** 幂等键版本 */
  key_profile: string;
}

/**
 * 转成出站请求里的明细（字段逐字对齐规范）。
 *
 * 重投走的是**同一条清洗口径**（`src/charge/sanitize.ts`）：首投清洗过、重投再清洗一次，
 * 结果必须一致 —— 否则同一笔耗材两次发出的载荷不一样，对端会当成两笔。
 * 归一是幂等的：已经归一过的文本再归一一次没有变化。
 */
export function toMaterialUse(item: ChargeItem): MaterialUse {
  const sanitized = sanitizeMaterialUse({
    material_code: item.material_code,
    quantity: item.quantity,
    price_code: item.price_code,
    use_time: item.use_time,
    fee_category: item.fee_category,
    medical_insurance_class: item.medical_insurance_class,
    // 行级幂等键：**重投复用同一把**（不因重试次数变化而改键）
    idempotency_key: item.idempotency_key,
    key_profile: item.key_profile,
  });
  return sanitized.use as MaterialUse;
}

/**
 * 重投这一条时的**请求级幂等键**（单条请求）。
 *
 * 与首次提交走同一把尺子：请求级键由行级键集合派生，
 * 行级键在重投时不变 → 请求级键也不变 → 对端认得出「这是同一笔」。
 */
export function retryRequestIdempotencyKey(item: ChargeItem): string {
  return deriveRequestIdempotencyKey(item.operation_no, [item.idempotency_key]).key;
}

/**
 * 投递函数：由调用方接到真实出站客户端
 * （`submitMaterialUses(client, operation_no, dept_code, [use], { path })`）。
 */
export type ChargeSubmitFn = (item: ChargeItem) => Promise<MaterialUsesResponse>;

/** 待重投条目 */
export interface PendingCharge {
  item: ChargeItem;
  /** 已经投递过几次 */
  attempt: number;
  /** 下次投递的时间点（epoch 毫秒） */
  next_attempt_at: number;
  /** 最近一次的错误码 */
  last_error_code: string | null;
  /** 最近一次的原因码 */
  last_reason_code: string | null;
}

/** 一次投递尝试的结果 */
export interface ChargeAttemptResult {
  item: ChargeItem;
  /** 对端是否接收 */
  accepted: boolean;
  /** 本次结果落在哪一档 */
  status: 'delivered' | 'retry_scheduled' | 'escalated' | 'skipped_already_charged';
  /** 本次回执（跳过时为 null） */
  receipt: ChargeReceipt | null;
  /** 排定的下次投递时间（仅 retry_scheduled） */
  retry_at: number | null;
  /** 生成的核查条目 id（仅 escalated） */
  check_task_id: number | null;
}

export interface ChargeRetrySchedulerOptions {
  /** 投递函数（真实出站客户端） */
  submit: ChargeSubmitFn;
  /** 最多投递几次（含首次），默认 3 */
  maxAttempts?: number;
  /** 退避基数（毫秒），默认 1000 */
  baseDelayMs?: number;
  /** 单次退避上限（毫秒），默认 30000 */
  maxDelayMs?: number;
  /** 时钟（epoch 毫秒），可注入以便确定性测试 */
  now?: () => number;
  /** 等待函数，可注入以便测试不真等 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });

/**
 * 计费重投调度器。
 *
 * 一条耗材一次投递 → 一行回执 → 按定性分流：
 *   接收成功        → 台账状态推进到 charged
 *   可重投的失败    → 排下一次退避重投（delivery_count 递增）
 *   不可重投 / 达上限 → 生成核查任务 + 台账状态转 check_pending
 */
export class ChargeRetryScheduler {
  readonly #db: DatabaseSync;
  readonly #submit: ChargeSubmitFn;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pending = new Map<string, PendingCharge>();

  constructor(db: DatabaseSync, options: ChargeRetrySchedulerOptions) {
    this.#db = db;
    this.#submit = options.submit;
    const maxAttempts = options.maxAttempts ?? RETRY_DEFAULTS.maxAttempts;
    this.#maxAttempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : RETRY_DEFAULTS.maxAttempts;
    const base = options.baseDelayMs ?? RETRY_DEFAULTS.baseDelayMs;
    this.#baseDelayMs = Number.isFinite(base) && base >= 0 ? base : RETRY_DEFAULTS.baseDelayMs;
    const cap = options.maxDelayMs ?? RETRY_DEFAULTS.maxDelayMs;
    this.#maxDelayMs = Number.isFinite(cap) && cap > 0 ? cap : RETRY_DEFAULTS.maxDelayMs;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** 最多投递几次 */
  get maxAttempts(): number {
    return this.#maxAttempts;
  }

  /** 当前待重投条目 */
  pending(): PendingCharge[] {
    return [...this.#pending.values()];
  }

  /** 待重投条目数 */
  pendingCount(): number {
    return this.#pending.size;
  }

  /** 首次投递一条耗材计费条目 */
  async submit(item: ChargeItem): Promise<ChargeAttemptResult> {
    return this.#attempt(item, undefined);
  }

  /** 投递一批（逐条独立：一条失败不拖累同批其余） */
  async submitMany(items: readonly ChargeItem[]): Promise<ChargeAttemptResult[]> {
    const results: ChargeAttemptResult[] = [];
    for (const item of items) {
      results.push(await this.#attempt(item, undefined));
    }
    return results;
  }

  /** 处理到期的重投（next_attempt_at <= now） */
  async retryDue(now: number = this.#now()): Promise<ChargeAttemptResult[]> {
    const results: ChargeAttemptResult[] = [];
    for (const pending of [...this.#pending.values()]) {
      if (pending.next_attempt_at > now) continue;
      this.#pending.delete(pending.item.idempotency_key);
      results.push(await this.#attempt(pending.item, pending.attempt + 1));
    }
    return results;
  }

  /**
   * 把待重投条目跑到不再有待办（或达到轮数上限）。
   *
   * 每轮：处理到期的条目；还没到期就等到最近的那个时间点再处理一轮。
   */
  async drain(maxRounds = 10): Promise<ChargeAttemptResult[]> {
    const results: ChargeAttemptResult[] = [];
    for (let round = 0; round < maxRounds; round += 1) {
      const due = this.pending().filter((item) => item.next_attempt_at <= this.#now());
      if (due.length === 0) {
        if (this.pendingCount() === 0) break;
        const nextAt = Math.min(...this.pending().map((item) => item.next_attempt_at));
        const wait = Math.max(0, nextAt - this.#now());
        if (wait > 0) await this.#sleep(wait);
        continue;
      }
      results.push(...(await this.retryDue()));
    }
    return results;
  }

  /** 一次投递尝试的内部实现 */
  async #attempt(item: ChargeItem, attemptOverride?: number): Promise<ChargeAttemptResult> {
    // 已回写计费的条目不再重复投递：状态停在 charged，**不自动冲正**。
    const currentStatus = readBindingStatus(
      this.#db,
      item.material_code,
      item.operation_no,
      item.idempotency_key,
    );
    if (currentStatus === 'charged') {
      return {
        item,
        accepted: true,
        status: 'skipped_already_charged',
        receipt: null,
        retry_at: null,
        check_task_id: null,
      };
    }

    const last = lastAttempt(this.#db, item.material_code, item.operation_no);
    const attempt = attemptOverride ?? last + 1;
    const requestedAt = new Date(this.#now()).toISOString();

    let response: MaterialUsesResponse;
    const requestKey = retryRequestIdempotencyKey(item);
    try {
      response = await this.#submit(item);
    } catch (error) {
      const failure = classifyFailure(error);
      const receipt = failureReceipt({
        material_code: item.material_code,
        operation_no: item.operation_no,
        idempotency_key: item.idempotency_key,
        key_profile: item.key_profile,
        request_idempotency_key: requestKey,
        attempt,
        delivery_count: attempt,
        failure,
        requested_at: requestedAt,
        responded_at: new Date(this.#now()).toISOString(),
        // 载荷快照：重投失败也要留「这次发出去的是什么」，字段级比对才有对照物
        submitted_quantity: item.quantity,
        submitted_price_code: item.price_code,
        submitted_fee_category: item.fee_category,
        submitted_medical_insurance_class: item.medical_insurance_class,
      });
      recordReceipts(this.#db, [receipt]);
      return this.#afterFailure(item, receipt, attempt, failure);
    }

    const receipts = classifyReceipts({
      response,
      submitted: [toMaterialUse(item)],
      operation_no: item.operation_no,
      attempt,
      delivery_count: attempt,
      idempotency_key: item.idempotency_key,
      key_profile: item.key_profile,
      request_idempotency_key: requestKey,
      requested_at: requestedAt,
      responded_at: new Date(this.#now()).toISOString(),
    });
    recordReceipts(this.#db, receipts);
    const receipt = receipts[0]!;

    if (receipt.accepted) {
      this.#markCharged(item, receipt);
      return {
        item,
        accepted: true,
        status: 'delivered',
        receipt,
        retry_at: null,
        check_task_id: null,
      };
    }

    const failure: ChargeFailureClass = {
      kind: receipt.kind,
      error_code: receipt.error_code,
      reason_code: receipt.reason_code ?? receipt.kind,
      channel_reachable: receipt.channel_reachable,
      retryable: receipt.retryable,
      // 处置档位由判定表给出：可重投 → 进退避队列；不可重投 / 需人工 → 转核查
      disposition: receipt.disposition ?? RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
      message: receipt.response_summary ?? '计费未通过',
    };
    return this.#afterFailure(item, receipt, attempt, failure);
  }

  /**
   * 失败之后的分流：可重投且没到上限 → 排退避重投；否则 → 转人工核查。
   */
  #afterFailure(
    item: ChargeItem,
    receipt: ChargeReceipt,
    attempt: number,
    failure: ChargeFailureClass,
  ): ChargeAttemptResult {
    if (failure.retryable && attempt < this.#maxAttempts) {
      const delay = computeBackoffDelay(this.#baseDelayMs, attempt, this.#maxDelayMs);
      const nextAttemptAt = this.#now() + delay;
      this.#pending.set(item.idempotency_key, {
        item,
        attempt,
        next_attempt_at: nextAttemptAt,
        last_error_code: receipt.error_code,
        last_reason_code: receipt.reason_code,
      });
      appendAudit(this.#db, {
        event_type: 'charge_retry_scheduled',
        binding_key: item.idempotency_key,
        operation_no: item.operation_no,
        actor: 'charge_writeback',
        detail: JSON.stringify({
          material_code: item.material_code,
          attempt,
          delivery_count: receipt.delivery_count,
          error_code: receipt.error_code,
          reason_code: receipt.reason_code,
          disposition: failure.disposition,
          channel_reachable: receipt.channel_reachable,
          next_attempt_at: new Date(nextAttemptAt).toISOString(),
        }),
      });
      return {
        item,
        accepted: false,
        status: 'retry_scheduled',
        receipt,
        retry_at: nextAttemptAt,
        check_task_id: null,
      };
    }

    return this.#escalate(item, receipt, attempt, failure);
  }

  /**
   * 达上限 / 不可重投 / 需人工 → 生成核查任务并把台账状态转人工。
   *
   * **不静默丢弃**：条目留在台账里、状态转 check_pending，等护士长 / 收费员落定结论。
   *
   * 三档处置在这里落地：
   *   NOT_RETRYABLE —— 对端明确不收（价码缺失、医保分类对不上…）：立即转人工，
   *                    不做无谓重试；
   *   NEEDS_HUMAN   —— 对端要求人判断（医保规则冲突、疑似重复计费…）：同样转人工，
   *                    但在核查条目上**标注**这一档（人工处置口径不同）。
   */
  #escalate(
    item: ChargeItem,
    receipt: ChargeReceipt,
    attempt: number,
    failure: ChargeFailureClass,
  ): ChargeAttemptResult {
    this.#pending.delete(item.idempotency_key);

    const reasonCode = receipt.reason_code ?? failure.reason_code ?? 'CHARGE_FAILED';
    const disposition = failure.disposition ?? RECEIPT_DISPOSITIONS.NOT_RETRYABLE;
    // 未知码：登记待补项 + 审计链留痕（原始码不许丢）
    registerUnknownReceiptReason(this.#db, {
      reason_code: receipt.reason_code,
      material_code: item.material_code,
      operation_no: item.operation_no,
      binding_key: item.idempotency_key,
      error_code: receipt.error_code,
      disposition,
    });
    const checkTaskId = createCheckTask(this.#db, {
      operation_no: item.operation_no,
      room_no: item.room_no,
      dept_code: item.dept_code,
      scanner_id: item.scanner_id,
      material_code: item.material_code,
      quantity: item.quantity,
      conclusion: 'CHARGE_REJECTED',
      reason_code: reasonCode,
      // 统一错误码：与回执行、日志展示同一个码
      error_code: receipt.error_code ?? failure.error_code ?? undefined,
    });

    // 台账状态推进：bound → check_pending（白名单外迁移会被拒，不静默改数据）。
    // 已 charged 的条目不动 —— 本轮不做自动冲正。
    const currentStatus = readBindingStatus(
      this.#db,
      item.material_code,
      item.operation_no,
      item.idempotency_key,
    );
    if (currentStatus === 'bound') {
      transitionBindingStatus(this.#db, {
        material_code: item.material_code,
        operation_no: item.operation_no,
        idempotency_key: item.idempotency_key,
        to: 'check_pending',
        actor: 'charge_writeback',
        check_task_id: checkTaskId,
      });
    }
    // currentStatus === 'check_pending'：状态已经对了，**不再发起自环迁移** ——
    // 状态机的 check_pending → check_pending 自环只认人工角色（manual_confirm / revoke），
    // 程序发起会被判非法迁移。同一条再被拒一次时：核查条目复用已有那条（不刷重复待办），
    // 台账状态原地不动。

    appendAudit(this.#db, {
      event_type: 'charge_escalated',
      binding_key: item.idempotency_key,
      operation_no: item.operation_no,
      actor: 'charge_writeback',
      detail: JSON.stringify({
        material_code: item.material_code,
        attempt,
        delivery_count: receipt.delivery_count,
        kind: receipt.kind,
        error_code: receipt.error_code,
        reason_code: reasonCode,
        disposition,
        check_task_id: checkTaskId,
        exhausted: attempt >= this.#maxAttempts,
      }),
    });

    return {
      item,
      accepted: false,
      status: 'escalated',
      receipt,
      retry_at: null,
      check_task_id: checkTaskId,
    };
  }

  /** 计费成功：台账状态推进到 charged */
  #markCharged(item: ChargeItem, receipt: ChargeReceipt): void {
    const currentStatus = readBindingStatus(
      this.#db,
      item.material_code,
      item.operation_no,
      item.idempotency_key,
    );
    if (currentStatus === 'bound') {
      transitionBindingStatus(this.#db, {
        material_code: item.material_code,
        operation_no: item.operation_no,
        idempotency_key: item.idempotency_key,
        to: 'charged',
        actor: 'charge_writeback',
      });
    }
    appendAudit(this.#db, {
      event_type: 'charge_delivered',
      binding_key: item.idempotency_key,
      operation_no: item.operation_no,
      actor: 'charge_writeback',
      detail: JSON.stringify({
        material_code: item.material_code,
        attempt: receipt.attempt,
        delivery_count: receipt.delivery_count,
        kind: CHARGE_RECEIPT_KINDS.accepted,
      }),
    });
  }
}

/**
 * 从台账重建待重投条目（进程重启后续跑用）。
 *
 * 重投队列本身在内存里，回执台账才是持久事实 —— 重启后按「最后一条回执可重投
 * 且没到上限」重建待办，避免崩溃重启后这一笔永远没人再投。
 */
export function listRetryCandidates(
  db: DatabaseSync,
  maxAttempts: number = RETRY_DEFAULTS.maxAttempts,
): PendingCharge[] {
  const rows = db
    .prepare(
      `SELECT r.material_code, r.operation_no, r.idempotency_key, r.key_profile, r.attempt,
              r.error_code, r.reason_code, r.channel_reachable, r.retryable,
              b.room_no, b.dept_code, b.quantity, b.charge_quantity, b.quantity_trace,
              b.price_code, b.fee_category,
              b.medical_insurance_class, b.created_at
         FROM charge_receipt r
         JOIN material_binding b
           ON b.material_code = r.material_code AND b.operation_no = r.operation_no
        WHERE r.id = (SELECT MAX(id) FROM charge_receipt x
                       WHERE x.material_code = r.material_code AND x.operation_no = r.operation_no)
          AND r.retryable = 1
          AND r.accepted = 0
          AND r.attempt < ?
        ORDER BY r.id ASC`,
    )
    .all(maxAttempts) as unknown as Array<{
    material_code: string;
    operation_no: string;
    idempotency_key: string | null;
    key_profile: string | null;
    attempt: number;
    error_code: string | null;
    reason_code: string | null;
    room_no: string;
    dept_code: string;
    quantity: number;
    charge_quantity: number | null;
    quantity_trace: string | null;
    price_code: string | null;
    fee_category: string | null;
    medical_insurance_class: string | null;
    created_at: string;
  }>;

  return rows.map((row) => {
    const resolved = resolveChargeQuantity({
      quantity: row.quantity,
      charge_quantity: row.charge_quantity,
      quantity_trace: row.quantity_trace,
    });
    return {
      item: {
        material_code: row.material_code,
        operation_no: row.operation_no,
        room_no: row.room_no,
        dept_code: row.dept_code,
        scanner_id: null,
        // 重投的是**计价数量**（换算后的），不是原始包装数 —— 与首次提交同一把尺子
        quantity: 'quantity' in resolved ? resolved.quantity : row.quantity,
      price_code: row.price_code ?? '',
      use_time: row.created_at,
      fee_category: row.fee_category ?? '',
      medical_insurance_class: row.medical_insurance_class ?? '',
      idempotency_key: row.idempotency_key ?? '',
      key_profile: row.key_profile ?? 'v1',
      },
      attempt: row.attempt,
      next_attempt_at: 0,
      last_error_code: row.error_code,
      last_reason_code: row.reason_code,
    };
  });
}
