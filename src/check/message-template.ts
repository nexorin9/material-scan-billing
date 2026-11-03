/**
 * 企微批次消息模板与去重节流：**按台次聚合 · 不刷屏**。
 *
 * 为什么要有这一层：一台手术扫十几次耗材，每扫一次就推一条消息，一台手术就是十几条 ——
 * 群里没人看，消息一多就等于没消息。本模块把「一批一条」改成「一台次一条」：
 *
 *   ① **消息按岗位关心的事组织** —— 台次、手术间、异常条数、异常清单、**建议处置**、
 *      **该谁处理**，而不是原始字段堆砌（护士长要的是「这条找谁、怎么处置」）；
 *   ② **按台次聚合** —— 同一台次的异常在**时间窗**（默认 30 秒，可配）内合并成一条消息，
 *      窗口结束才真正发出，期间新到的异常并入同一条；
 *   ③ **去重** —— 同一条异常（同一耗材码 + 同一结论）在一个窗口内只出现一次，
 *      重复扫码不重复推（重复扫码是幂等层的正常结果，不是异常）；
 *   ④ **正常批次不推** —— 没有异常就一条都不发（默认策略，可配）。
 *
 * 与源产品的对应（参考地基见 spec.md → `## 开源对照`）：
 *   源产品按**目标实体**路由批量唯一消息（`UniqueMessage{entity, message_type}`），
 *   同一实体同一类型只算一条；本模块把「目标实体」换成**手术台次**，
 *   把「逐条投递」换成「按台次聚合成一条」—— 唯一性维度从「实体 + 消息类型」
 *   换成「台次 + 耗材码 + 结论」，语义同源：同一件事在同一个窗口里只说一次。
 *
 * 三条硬约束：
 *   ① **节流不丢信息** —— 窗口内的异常一条不少地并进同一条消息，消息体带条目数便于核对；
 *   ② **推送失败不阻塞台账** —— 发送失败只记失败行与审计，条目仍在核查清单里；
 *   ③ **消息里只出现耗材码与台次** —— 不含患者可识别字段。
 *
 * 状态口径：聚合窗口是**传输层节流**，是进程内的短命缓冲；
 * 异常本身的权威副本在 `check_task`（待核查条目）里，重启不丢。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { appendAudit } from '../ledger/audit.js';
import {
  CONCLUSION_LABELS,
  NOTIFY_DELIVERY_STATUS,
  REASON_DUPLICATE_SCAN,
  REASON_LABELS,
  findNotifyDelivery,
  recordNotifyDelivery,
  type NotifyOptions,
  type NotifyOutcome,
  type NotifySummary,
  type WeComBotClient,
  type WeComMessage,
} from './notify.js';
import { resolveAssignee } from './route.js';

/* ── 默认参数 ── */

/** 聚合窗口默认值（毫秒）：同一台次的异常在这个窗口内合并成一条消息 */
export const DEFAULT_AGGREGATION_WINDOW_MS = 30_000;

/** 单条消息最多列出的异常条数默认值（超出折叠计数） */
export const DEFAULT_MAX_AGGREGATED_ITEMS = 20;

/** 发送失败后的重投退避基数（毫秒） */
export const DEFAULT_NOTIFY_RETRY_BASE_MS = 10_000;

/** 发送失败后的重投退避上限（毫秒） */
export const DEFAULT_NOTIFY_RETRY_MAX_MS = 300_000;

/* ── 聚合后的异常条目 ── */

/** 一条并入窗口的异常（已补上「该谁处理」与「建议处置」） */
export interface AggregatedException {
  /** 耗材码 */
  material_code: string;
  /** 绑定结论（五种之一） */
  conclusion: string;
  /** 原因码（原始码，便于与核查清单反查） */
  reason_code: string;
  /** 数量（未知为 null） */
  quantity: number | null;
  /** 台次号 */
  operation_no: string;
  /** 该谁处理（面向人：岗位 + 科室） */
  assignee_display: string;
  /** 建议处置（中文一句话） */
  suggested_action: string;
  /** 首次看到这条异常的时刻 */
  first_seen_at: string;
  /** 窗口内被折叠的重复次数（同一耗材码 + 同一结论又扫了几遍） */
  repeat_count: number;
}

/** 一个台次在一个窗口内的聚合结果 */
export interface AggregatedBatch {
  /** 台次号 */
  operation_no: string;
  /** 手术间 */
  room_no: string;
  /** 科室 */
  dept_code: string | null;
  /** 扫码枪编号 */
  scanner_id: string;
  /** 窗口起（ISO） */
  window_started_at: string;
  /** 窗口止（ISO） */
  window_ends_at: string;
  /** 窗口长度（毫秒） */
  window_ms: number;
  /** 窗口内合并了几批 */
  batch_count: number;
  /** 窗口内累计的耗材条数 */
  total: number;
  /** 窗口内累计的绑定成功条数 */
  accepted: number;
  /** 去重后的异常条数 */
  exception_count: number;
  /** 被去重折叠的重复条数 */
  duplicates_dropped: number;
  /** 异常明细 */
  exceptions: readonly AggregatedException[];
  /** 窗口键（同一窗口重发时键不变） */
  window_key: string;
}

/* ── 唯一键 ── */

/**
 * 异常唯一键：`台次 | 耗材码 | 结论`。
 *
 * 与源产品的「实体 + 消息类型」两段键同源：同一台次里同一耗材的同一类问题，
 * 在一个窗口里只说一次；换了结论（从「未建档」变成「计费被拒」）就是另一件事，要单独说。
 */
export function deriveExceptionKey(
  operation_no: string,
  material_code: string,
  conclusion: string,
): string {
  return `${operation_no}|${material_code}|${conclusion}`;
}

/** 窗口键：同一台次的同一窗口重发时键不变（幂等：不会推第二遍） */
export function deriveWindowKey(operation_no: string, window_started_at_ms: number): string {
  return createHash('sha256')
    .update(`${operation_no}|${window_started_at_ms}`, 'utf8')
    .digest('hex');
}

/* ── 合并（节流不丢信息） ── */

/** ISO 时刻转毫秒；解析不出来时按 0 兜底（不静默改数据，只影响时间窗展示） */
function toEpochMs(iso: string): number {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 把两批聚合结果**合并**成一批：异常取并集（按异常唯一键去重），计数相加，
 * 时间窗取最早起、最晚止。
 *
 * 为什么必须**合并**而不是覆盖：一条消息发送失败后会按退避重新排队（不丢信息），
 * 这期间同一台次可能又开了新窗口；两条消息在待发队列里相遇时，
 * **覆盖**会让先到那条的异常凭空消失 —— 消息体里少了几条，岗位照着核对就会漏。
 *
 * 合并后的窗口键取**最早**那批的起点：键不变 → 同一台次这条消息仍算「一条」，
 * 且先到那条的推送记录（失败）会被这一次成功覆盖成已送达，不留悬着的失败计数。
 */
export function mergeAggregatedBatches(
  first: AggregatedBatch,
  second: AggregatedBatch,
): AggregatedBatch {
  const operationNo = first.operation_no || second.operation_no;
  const byKey = new Map<string, AggregatedException>();
  for (const exception of [...first.exceptions, ...second.exceptions]) {
    const key = deriveExceptionKey(operationNo, exception.material_code, exception.conclusion);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, exception);
      continue;
    }
    byKey.set(key, {
      ...existing,
      repeat_count: existing.repeat_count + exception.repeat_count,
      quantity: existing.quantity ?? exception.quantity,
    });
  }
  const exceptions = [...byKey.values()];
  const startMs = Math.min(toEpochMs(first.window_started_at), toEpochMs(second.window_started_at));
  const endMs = Math.max(toEpochMs(first.window_ends_at), toEpochMs(second.window_ends_at));
  // 上下文取「较晚」那一批：手术间与科室不该在窗口内变
  const later =
    toEpochMs(first.window_started_at) >= toEpochMs(second.window_started_at) ? first : second;
  const earlier = later === first ? second : first;

  return {
    operation_no: operationNo,
    room_no: later.room_no || earlier.room_no,
    dept_code: later.dept_code ?? earlier.dept_code,
    scanner_id: later.scanner_id || earlier.scanner_id,
    window_started_at: new Date(startMs).toISOString(),
    window_ends_at: new Date(endMs).toISOString(),
    window_ms: Math.max(0, endMs - startMs),
    batch_count: first.batch_count + second.batch_count,
    total: first.total + second.total,
    accepted: first.accepted + second.accepted,
    exception_count: exceptions.length,
    duplicates_dropped: first.duplicates_dropped + second.duplicates_dropped,
    exceptions,
    window_key: deriveWindowKey(operationNo, startMs),
  };
}

/* ── 消息模板 ── */

/** 把 ISO 时刻格式化成 HH:mm:ss（本地时区，护士长看的就是墙上的钟） */
function formatClock(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 结论的中文说法 */
function conclusionLabel(conclusion: string): string {
  return CONCLUSION_LABELS[conclusion] ?? conclusion;
}

/** 原因码的中文说法 */
function reasonLabel(reason_code: string): string {
  return REASON_LABELS[reason_code] ?? '';
}

/**
 * 拼一条**按台次聚合**的待核消息（markdown）。
 *
 * 正文只用企业微信 markdown 官方支持的三种记法：**加粗**、引用块 `>`、行内代码。
 * 每条异常带「该谁处理」与「建议处置」—— 岗位看完就能动手，不用自己去查原因码。
 */
export function buildAggregatedMessage(
  batch: AggregatedBatch,
  options: NotifyOptions = {},
): WeComMessage {
  const maxItems = Math.max(0, options.maxExceptionItems ?? DEFAULT_MAX_AGGREGATED_ITEMS);
  const shown = batch.exceptions.slice(0, maxItems);
  const hidden = batch.exceptions.length - shown.length;
  const windowSeconds = Math.round(batch.window_ms / 1000);

  const lines: string[] = [];
  lines.push(`**高值耗材扫码待核（台次 \`${batch.operation_no}\`）**`);
  lines.push(
    `> 手术间 \`${batch.room_no}\`` +
      (batch.dept_code ? ` · 科室 \`${batch.dept_code}\`` : '') +
      ` · 时间窗 ${formatClock(batch.window_started_at)} ~ ${formatClock(batch.window_ends_at)}` +
      `（${windowSeconds} 秒内合并 ${batch.batch_count} 批）`,
  );
  lines.push(
    `> 本窗口共 ${batch.total} 条耗材：已绑定 ${batch.accepted} 条，待核 ${batch.exception_count} 条` +
      (batch.duplicates_dropped > 0 ? `（重复扫码折叠 ${batch.duplicates_dropped} 条）` : ''),
  );

  lines.push('');
  lines.push(`**待核明细（${batch.exception_count} 条）**`);
  if (shown.length === 0) {
    lines.push('> 无');
  } else {
    shown.forEach((exception, index) => {
      const label = reasonLabel(exception.reason_code) || conclusionLabel(exception.conclusion);
      const quantity =
        typeof exception.quantity === 'number' && Number.isFinite(exception.quantity)
          ? ` 数量 ${exception.quantity}`
          : '';
      lines.push(
        `> ${index + 1}. \`${exception.material_code}\` —— ${label}（\`${exception.reason_code}\`）${quantity}`,
      );
      lines.push(
        `> 该谁处理：${exception.assignee_display} ｜建议处置：${exception.suggested_action}`,
      );
    });
    if (hidden > 0) {
      lines.push(`> …… 另有 ${hidden} 条未列出，请到核查清单查看`);
    }
  }

  lines.push('');
  lines.push('> 处理入口：高值耗材扫码计费闭环系统 · 核查清单（落定结论后自动闭环）');

  return { msgtype: 'markdown', markdown: { content: lines.join('\n') } };
}

/* ── 聚合器 ── */

/** 窗口内的一条异常（带去重计数） */
interface WindowException extends AggregatedException {
  /** 去重键 */
  key: string;
}

/** 一个台次的开放窗口 */
interface WindowState {
  operation_no: string;
  room_no: string;
  dept_code: string | null;
  scanner_id: string;
  started_at_ms: number;
  ends_at_ms: number;
  total: number;
  accepted: number;
  batch_count: number;
  duplicates_dropped: number;
  exceptions: Map<string, WindowException>;
}

/** 待发送的一条窗口消息（发送失败可按退避重新排队） */
interface ReadyBatch {
  batch: AggregatedBatch;
  ready_at_ms: number;
  attempts: number;
}

/** 入队结论 */
export interface EnqueueOutcome {
  /** 台次号 */
  operation_no: string;
  /** 本次并入窗口的**新**异常条数 */
  buffered: number;
  /** 本次被去重折叠的条数 */
  duplicates: number;
  /** 是否是新开的窗口 */
  window_opened: boolean;
  /** 窗口结束时刻（ISO） */
  window_ends_at: string;
  /** 窗口键 */
  window_key: string;
  /** 跳过原因（没有异常时为 `no_exception`） */
  skipped: 'no_exception' | null;
}

/** 聚合器选项 */
export interface AggregatorOptions {
  /** 聚合窗口（毫秒，默认 30000） */
  windowMs?: number;
  /** 当前时间（毫秒），测试可注入 */
  nowMs?: () => number;
  /** 只推有异常的窗口（默认 true） */
  onlyAbnormal?: boolean;
  /** 把「重复扫码」排除在清单外（默认 true：那是幂等层的正常结果） */
  ignoreDuplicateScan?: boolean;
  /** 单条消息最多列出的异常条数（默认 20） */
  maxExceptionItems?: number;
}

/**
 * 按台次聚合异常消息的缓冲器。
 *
 * 生命周期：
 *   - `enqueue` 把一批扫码的异常并进**该台次的开放窗口**（没有窗口就开一个）；
 *   - 窗口到期（`now ≥ 窗口止`）后由 `flushDue` 取出，形成一条待发消息；
 *   - 发送失败可以 `requeue` 回去，按退避再试（**不丢信息**）。
 *
 * 窗口的权威副本不在这里：每条异常在 `check_task` 里都有一行待核查条目，
 * 这里只是「怎么把话说得少一点」的传输层缓冲。
 */
export class BatchMessageAggregator {
  readonly #windows = new Map<string, WindowState>();
  readonly #ready = new Map<string, ReadyBatch>();
  readonly #windowMs: number;
  readonly #onlyAbnormal: boolean;
  readonly #ignoreDuplicateScan: boolean;
  readonly #now: () => number;

  constructor(options: AggregatorOptions = {}) {
    const window = options.windowMs ?? DEFAULT_AGGREGATION_WINDOW_MS;
    this.#windowMs = Number.isFinite(window) && window > 0 ? window : DEFAULT_AGGREGATION_WINDOW_MS;
    this.#onlyAbnormal = options.onlyAbnormal !== false;
    this.#ignoreDuplicateScan = options.ignoreDuplicateScan !== false;
    this.#now = options.nowMs ?? (() => Date.now());
  }

  /** 聚合窗口长度（毫秒） */
  get windowMs(): number {
    return this.#windowMs;
  }

  /** 当前有多少个台次的窗口开着 */
  get openWindowCount(): number {
    return this.#windows.size;
  }

  /** 待发（已过窗口、还没发出去）的消息条数 */
  get readyCount(): number {
    return this.#ready.size;
  }

  /** 开着的窗口：台次号列表（运维体检用） */
  openOperations(): string[] {
    return [...this.#windows.keys()].sort();
  }

  /**
   * 把一批扫码的异常并进台次窗口。
   *
   * 无异常批次默认直接跳过（不开窗口、不推消息）；重复扫码默认不进清单。
   */
  enqueue(summary: NotifySummary, options: NotifyOptions = {}): EnqueueOutcome {
    const nowMs = this.#now();
    const operationNo = (summary.operation_no ?? '').trim();
    const ignoreDuplicateScan =
      options.ignoreDuplicateScan ?? this.#ignoreDuplicateScan;
    const onlyAbnormal = options.onlyAbnormal ?? this.#onlyAbnormal;

    const exceptions = summary.exceptions.filter((exception) => {
      if (!exception.reason_code) return false;
      if (ignoreDuplicateScan && exception.reason_code === REASON_DUPLICATE_SCAN) return false;
      return true;
    });

    if (exceptions.length === 0) {
      return {
        operation_no: operationNo,
        buffered: 0,
        duplicates: 0,
        window_opened: false,
        window_ends_at: new Date(nowMs).toISOString(),
        window_key: '',
        skipped: onlyAbnormal ? 'no_exception' : null,
      };
    }

    let window = this.#windows.get(operationNo);
    let windowOpened = false;
    if (!window) {
      window = {
        operation_no: operationNo,
        room_no: summary.room_no,
        dept_code: summary.dept_code ?? null,
        scanner_id: summary.scanner_id,
        started_at_ms: nowMs,
        ends_at_ms: nowMs + this.#windowMs,
        total: 0,
        accepted: 0,
        batch_count: 0,
        duplicates_dropped: 0,
        exceptions: new Map(),
      };
      this.#windows.set(operationNo, window);
      windowOpened = true;
    } else {
      // 窗口已经过期但还没被取走：新异常另起一个窗口，旧窗口留在待发队列里
      if (nowMs >= window.ends_at_ms) {
        const stale = this.#materialize(window);
        const pending = this.#ready.get(operationNo);
        if (pending) {
          // 待发队列里已有同一台次的重排队消息：**合并**（不丢信息），不覆盖
          pending.batch = mergeAggregatedBatches(pending.batch, stale);
        } else {
          this.#ready.set(operationNo, {
            batch: stale,
            ready_at_ms: window.ends_at_ms,
            attempts: 0,
          });
        }
        this.#windows.delete(operationNo);
        window = {
          operation_no: operationNo,
          room_no: summary.room_no,
          dept_code: summary.dept_code ?? null,
          scanner_id: summary.scanner_id,
          started_at_ms: nowMs,
          ends_at_ms: nowMs + this.#windowMs,
          total: 0,
          accepted: 0,
          batch_count: 0,
          duplicates_dropped: 0,
          exceptions: new Map(),
        };
        this.#windows.set(operationNo, window);
        windowOpened = true;
      } else {
        // 同一台次的上下文以最新一批为准（手术间 / 科室不该在窗口内变）
        window.room_no = summary.room_no || window.room_no;
        window.dept_code = summary.dept_code ?? window.dept_code;
        window.scanner_id = summary.scanner_id || window.scanner_id;
      }
    }

    let buffered = 0;
    let duplicates = 0;
    for (const exception of exceptions) {
      const conclusion = exception.conclusion ?? 'UNKNOWN';
      const key = deriveExceptionKey(operationNo, exception.material_code, conclusion);
      const existing = window.exceptions.get(key);
      if (existing) {
        existing.repeat_count += 1;
        duplicates += 1;
        window.duplicates_dropped += 1;
        continue;
      }
      const resolution = resolveAssignee({
        conclusion: exception.conclusion ?? null,
        reason_code: exception.reason_code,
        error_code: null,
        dept_code: summary.dept_code ?? null,
      });
      window.exceptions.set(key, {
        key,
        material_code: exception.material_code,
        conclusion,
        reason_code: exception.reason_code,
        quantity: exception.quantity ?? null,
        operation_no: exception.operation_no ?? operationNo,
        assignee_display: resolution.display,
        suggested_action: resolution.basis_zh,
        first_seen_at: new Date(nowMs).toISOString(),
        repeat_count: 0,
      });
      buffered += 1;
    }

    window.total += summary.total ?? exceptions.length;
    window.accepted += summary.accepted ?? 0;
    window.batch_count += 1;

    return {
      operation_no: operationNo,
      buffered,
      duplicates,
      window_opened: windowOpened,
      window_ends_at: new Date(window.ends_at_ms).toISOString(),
      window_key: deriveWindowKey(operationNo, window.started_at_ms),
      skipped: null,
    };
  }

  /**
   * 取出**窗口已结束**的聚合消息。
   *
   * 取出即从聚合器交出（调用方负责发）；发送失败可以 `requeue` 放回来。
   */
  flushDue(nowMs?: number): AggregatedBatch[] {
    const now = nowMs ?? this.#now();

    // ① 窗口到期的转成待发
    for (const [operationNo, window] of [...this.#windows.entries()]) {
      if (now < window.ends_at_ms) continue;
      this.#windows.delete(operationNo);
      const existing = this.#ready.get(operationNo);
      const batch = this.#materialize(window);
      if (existing) {
        // 同一台次既有到期窗口又有重排队的旧窗口：**合并**成一条
        // （不刷屏，也不丢信息 —— 先到那条的异常一条不少）
        existing.batch = mergeAggregatedBatches(existing.batch, batch);
        if (existing.ready_at_ms > now) continue;
      } else {
        this.#ready.set(operationNo, { batch, ready_at_ms: now, attempts: 0 });
      }
    }

    // ② 到点的待发消息交出去
    const out: AggregatedBatch[] = [];
    for (const [operationNo, ready] of [...this.#ready.entries()]) {
      if (ready.ready_at_ms > now) continue;
      this.#ready.delete(operationNo);
      out.push(ready.batch);
    }
    return out;
  }

  /**
   * 取出**所有**窗口的消息（不管窗口到没到期）。
   *
   * 停机时用：窗口没到期也不等了，先把已知的异常说一遍再走。
   * 同一台次的窗口消息与重排队的旧消息在这里**合并**成一条 ——
   * 停机是最后一次机会，异常一条都不能留在内存里。
   */
  flushAll(nowMs?: number): AggregatedBatch[] {
    const now = nowMs ?? this.#now();
    // ① 窗口并入待发队列（与重排队的旧消息合并，不丢信息）
    for (const [operationNo, window] of [...this.#windows.entries()]) {
      this.#windows.delete(operationNo);
      const batch = this.#materialize(window);
      const existing = this.#ready.get(operationNo);
      if (existing) {
        existing.batch = mergeAggregatedBatches(existing.batch, batch);
      } else {
        this.#ready.set(operationNo, { batch, ready_at_ms: now, attempts: 0 });
      }
    }
    // ② 全部交出去（停机时不看退避窗口：消息一条都不留在内存里）
    const out: AggregatedBatch[] = [];
    for (const [operationNo, ready] of [...this.#ready.entries()]) {
      this.#ready.delete(operationNo);
      out.push(ready.batch);
    }
    return out;
  }

  /**
   * 发送失败后把消息放回待发队列（按退避再试）。
   *
   * **不丢信息**：消息还在，只是晚一点发；退避次数越多等得越久。
   */
  requeue(batch: AggregatedBatch, delayMs?: number): void {
    const previous = this.#ready.get(batch.operation_no);
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay =
      delayMs ??
      Math.min(
        DEFAULT_NOTIFY_RETRY_BASE_MS * Math.pow(2, attempts - 1),
        DEFAULT_NOTIFY_RETRY_MAX_MS,
      );
    this.#ready.set(batch.operation_no, {
      batch,
      ready_at_ms: this.#now() + delay,
      attempts,
    });
  }

  /** 把窗口状态物化成一条待发消息 */
  #materialize(window: WindowState): AggregatedBatch {
    const exceptions = [...window.exceptions.values()].map((exception) => ({
      material_code: exception.material_code,
      conclusion: exception.conclusion,
      reason_code: exception.reason_code,
      quantity: exception.quantity,
      operation_no: exception.operation_no,
      assignee_display: exception.assignee_display,
      suggested_action: exception.suggested_action,
      first_seen_at: exception.first_seen_at,
      repeat_count: exception.repeat_count,
    }));
    return {
      operation_no: window.operation_no,
      room_no: window.room_no,
      dept_code: window.dept_code,
      scanner_id: window.scanner_id,
      window_started_at: new Date(window.started_at_ms).toISOString(),
      window_ends_at: new Date(window.ends_at_ms).toISOString(),
      window_ms: this.#windowMs,
      batch_count: window.batch_count,
      total: window.total,
      accepted: window.accepted,
      exception_count: exceptions.length,
      duplicates_dropped: window.duplicates_dropped,
      exceptions,
      window_key: deriveWindowKey(window.operation_no, window.started_at_ms),
    };
  }
}

/** 建一个聚合器（工厂函数，便于按配置装配） */
export function createBatchMessageAggregator(
  options: AggregatorOptions = {},
): BatchMessageAggregator {
  return new BatchMessageAggregator(options);
}

/* ── 发送 ── */

/** 发送结论 */
export interface AggregatedSendOutcome extends NotifyOutcome {
  /** 窗口键 */
  window_key: string;
  /** 本条消息里的异常条数 */
  exception_count: number;
}

/**
 * 发一条按台次聚合的待核消息。
 *
 * 顺序：**节流判断 → 推送 → 记账**。
 *   ① 同一窗口最多推一条（窗口键落 `notify_delivery`，重发不再推第二遍）；
 *   ② 推送失败被捕获：失败计数写进审计链（`notify_window_failed`），
 *      **不抛到主流程**，台账与核查条目一行都不受影响。
 */
export async function sendAggregatedMessage(
  db: DatabaseSync,
  client: WeComBotClient,
  batch: AggregatedBatch,
  options: NotifyOptions = {},
): Promise<AggregatedSendOutcome> {
  const windowKey = batch.window_key;
  const existing = findNotifyDelivery(db, windowKey);
  if (existing && existing.status !== NOTIFY_DELIVERY_STATUS.failed) {
    return {
      sent: false,
      result: 'skipped',
      skipped: existing.status === NOTIFY_DELIVERY_STATUS.skipped ? 'no_exception' : 'duplicate_batch',
      batch_key: windowKey,
      exception_count: batch.exception_count,
      window_key: windowKey,
    };
  }

  const message = buildAggregatedMessage(batch, options);
  try {
    await client.postMessage(message);
    db.exec('BEGIN');
    try {
      recordNotifyDelivery(db, {
        batch_key: windowKey,
        operation_no: batch.operation_no,
        status: NOTIFY_DELIVERY_STATUS.sent,
        detail: `已推送 ${batch.exception_count} 条待核异常（窗口 ${batch.window_started_at}）`,
      });
      appendAudit(db, {
        event_type: 'notify_window_sent',
        operation_no: batch.operation_no,
        actor: 'notify',
        detail: JSON.stringify({
          window_key: windowKey,
          window_started_at: batch.window_started_at,
          window_ends_at: batch.window_ends_at,
          batch_count: batch.batch_count,
          total: batch.total,
          accepted: batch.accepted,
          exception_count: batch.exception_count,
          duplicates_dropped: batch.duplicates_dropped,
        }),
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return {
      sent: true,
      result: 'sent',
      skipped: null,
      batch_key: windowKey,
      exception_count: batch.exception_count,
      window_key: windowKey,
    };
  } catch (error) {
    const notifyError =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown })
        : { code: 'ERR_NOTIFY_INTERNAL' };
    const code = typeof notifyError.code === 'string' ? notifyError.code : 'ERR_NOTIFY_INTERNAL';
    const message2 = error instanceof Error ? error.message : String(error);
    try {
      db.exec('BEGIN');
      try {
        recordNotifyDelivery(db, {
          batch_key: windowKey,
          operation_no: batch.operation_no,
          status: NOTIFY_DELIVERY_STATUS.failed,
          error_code: code,
          detail: message2,
        });
        appendAudit(db, {
          event_type: 'notify_window_failed',
          operation_no: batch.operation_no,
          actor: 'notify',
          detail: JSON.stringify({
            window_key: windowKey,
            error_code: code,
            message: message2,
            exception_count: batch.exception_count,
          }),
        });
        db.exec('COMMIT');
      } catch (inner) {
        db.exec('ROLLBACK');
        throw inner;
      }
    } catch {
      // 台账记账失败不掩盖推送失败结论
    }
    return {
      sent: false,
      result: 'failed',
      skipped: null,
      batch_key: windowKey,
      error_code: code,
      message: message2,
      exception_count: batch.exception_count,
      window_key: windowKey,
    };
  }
}

/* ── 批次摘要出口（给入站服务与守护进程共用） ── */

/**
 * 批次摘要出口：入站服务把「这一批的结论摘要」交给它，由它决定怎么发。
 *
 * 默认实现是**立即推送**；聚合模式下换成 `createAggregatingSink` ——
 * 只把异常并进窗口，真正发出发生在窗口结束之后。
 */
export type BatchSummarySink = (
  summary: NotifySummary,
  options?: NotifyOptions,
) => Promise<NotifyOutcome>;

/**
 * 建一个**聚合节流**的批次摘要出口。
 *
 * 返回的出口**不发消息**，只把异常并进窗口（结果为 `queued`）；
 * 窗口到期后由守护进程调 `sendAggregatedMessage` 发出。
 */
export function createAggregatingSink(
  aggregator: BatchMessageAggregator,
): BatchSummarySink {
  return async (summary: NotifySummary, options: NotifyOptions = {}): Promise<NotifyOutcome> => {
    const outcome = aggregator.enqueue(summary, options);
    return {
      sent: false,
      result: outcome.skipped === 'no_exception' ? 'skipped' : 'queued',
      skipped: outcome.skipped,
      batch_key: outcome.window_key,
      exception_count: outcome.buffered,
    };
  };
}
