/**
 * 出站熔断器：连续失败达阈值 → 短路（不再外发）→ 冷却后单次探测 → 恢复。
 *
 * 为什么手术室需要这个：
 *   HIS 计费侧在忙时会很慢甚至挂掉。守护进程是**常驻**的，如果每次扫码都
 *   傻等 10 秒再超时，一台手术十几条耗材就会把整个批次拖住 —— 手术室在等
 *   计费结果，计费侧挂着的时候更不该由本侧去反复敲门。
 *   熔断打开后：请求**直接短路**、不外发，条目照常进退避重投队列
 *   （**不静默丢弃**），等冷却到点自动放一次探测；探测成功即恢复。
 *
 * 语义来源（源产品主路径）：源产品的连接是**有生命周期的**——每条逻辑连接
 * 绑定一次执行，连接断了就是断了（`ConnectionError::Closed`），不会在坏连接上
 * 反复重试；投递失败是**普通结果**而不是中断。本模块照此语义改写成出站通道：
 *   - 通道不健康时**不再敲门**（熔断打开），避免把手术室拖在超时里；
 *   - 但熔断**不吞数据**：短路的条目仍然有回执、仍然进重投队列、仍然在台账里。
 *
 * 状态可查：熔断状态落在台账 `meta` 表（心跳表），doctor 随时能查
 * 「现在是不是熔断着、下次什么时候探测」—— 进程重启也不丢。
 */

import type { DatabaseSync } from 'node:sqlite';

import { getMetaText, setMeta } from '../ledger/meta.js';
import { CHARGE_ERROR_CODES, ChargeError } from './errors.js';

/** 熔断状态 */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** 熔断状态的中文说法（给信息科看的） */
export const CIRCUIT_STATE_LABELS: Readonly<Record<CircuitState, string>> = {
  closed: '正常',
  open: '已熔断（暂不外发）',
  half_open: '半开探测中',
};

/** 熔断状态在台账 `meta` 表里的键 */
export const CIRCUIT_META_KEY = 'charge_circuit';

/** 熔断默认参数 */
export const CIRCUIT_DEFAULTS = {
  /** 连续失败多少次后打开熔断 */
  failureThreshold: 5,
  /** 打开后冷却多久再放一次探测（毫秒） */
  cooldownMs: 30_000,
} as const;

/** 熔断状态快照（落盘与展示都用这一份） */
export interface CircuitSnapshot {
  /** 当前状态 */
  state: CircuitState;
  /** 连续失败次数 */
  consecutive_failures: number;
  /** 阈值（连续失败多少次打开） */
  threshold: number;
  /** 冷却时长（毫秒） */
  cooldown_ms: number;
  /** 打开时刻（ISO 8601） */
  opened_at: string | null;
  /** 下次自动探测时刻（ISO 8601） */
  next_probe_at: string | null;
  /** 快照写入时刻（ISO 8601） */
  updated_at: string;
}

export interface ChargeCircuitOptions {
  /** 连续失败多少次后打开熔断（默认 5） */
  failureThreshold?: number;
  /** 打开后冷却多久再放一次探测（毫秒，默认 30s） */
  cooldownMs?: number;
  /** 时钟（epoch 毫秒），可注入以便确定性测试 */
  now?: () => number;
  /** 状态变化回调（守护进程据此把状态落到台账，doctor 才查得到） */
  onChange?: (snapshot: CircuitSnapshot) => void;
}

/**
 * 出站熔断器。
 *
 * 三档状态：
 *   closed    —— 正常放行；连续失败计数涨到阈值就跳 open
 *   open      —— 短路：请求不外发，直接判「通道不可达」；冷却到点转 half_open
 *   half_open —— 只放行**一次**探测：成功回 closed，失败回 open（冷却重新计时）
 */
export class ChargeCircuitBreaker {
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #onChange: ((snapshot: CircuitSnapshot) => void) | undefined;
  #state: CircuitState = 'closed';
  #consecutiveFailures = 0;
  #openedAt: number | null = null;
  #nextProbeAt: number | null = null;
  /** 半开档是否已有一笔探测在途（有则后续请求继续短路） */
  #probeInFlight = false;

  constructor(options: ChargeCircuitOptions = {}) {
    const threshold = options.failureThreshold ?? CIRCUIT_DEFAULTS.failureThreshold;
    this.#threshold =
      Number.isInteger(threshold) && threshold > 0 ? threshold : CIRCUIT_DEFAULTS.failureThreshold;
    const cooldown = options.cooldownMs ?? CIRCUIT_DEFAULTS.cooldownMs;
    this.#cooldownMs =
      Number.isFinite(cooldown) && cooldown > 0 ? cooldown : CIRCUIT_DEFAULTS.cooldownMs;
    this.#now = options.now ?? (() => Date.now());
    this.#onChange = options.onChange;
  }

  /** 当前状态 */
  get state(): CircuitState {
    return this.#state;
  }

  /** 阈值 */
  get failureThreshold(): number {
    return this.#threshold;
  }

  /** 冷却时长（毫秒） */
  get cooldownMs(): number {
    return this.#cooldownMs;
  }

  /** 连续失败次数 */
  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  /** 现在是不是熔断着（open 档；half_open 也算 —— 探测没通过前不再外发） */
  isOpen(): boolean {
    return this.#state !== 'closed';
  }

  /** 下次自动探测时刻（epoch 毫秒；不在熔断档时为 null） */
  nextProbeAt(): number | null {
    return this.#nextProbeAt;
  }

  /** 状态快照 */
  snapshot(): CircuitSnapshot {
    return {
      state: this.#state,
      consecutive_failures: this.#consecutiveFailures,
      threshold: this.#threshold,
      cooldown_ms: this.#cooldownMs,
      opened_at: this.#openedAt === null ? null : new Date(this.#openedAt).toISOString(),
      next_probe_at: this.#nextProbeAt === null ? null : new Date(this.#nextProbeAt).toISOString(),
      updated_at: new Date(this.#now()).toISOString(),
    };
  }

  /**
   * 请求前置闸门：熔断打开且还没到探测时刻 → 直接短路，**不外发**。
   *
   * 抛的是 `ChargeError`（kind = circuit_open）：业务层拿到的仍是
   * 「通道不可达、可重投」这一档，与超时同口径 —— 条目照常进退避重投队列。
   */
  beforeRequest(): void {
    if (this.#state === 'closed') return;
    if (this.#state === 'open') {
      const due = this.#nextProbeAt !== null && this.#now() >= this.#nextProbeAt;
      if (!due) throw this.#shortCircuitError();
      // 冷却到点：转半开，放行**这一次**探测
      this.#state = 'half_open';
      this.#probeInFlight = true;
      this.#emit();
      return;
    }
    // half_open：一笔探测还没回来 —— 继续短路，不给并发再开一道门
    if (this.#probeInFlight) throw this.#shortCircuitError();
    this.#probeInFlight = true;
  }

  /** 一次成功的请求（对端给了结论）：通道健康，失败计数清零 */
  onSuccess(): void {
    this.#probeInFlight = false;
    if (this.#state === 'half_open') {
      // 半开探测成功 → 完全恢复
      this.#state = 'closed';
      this.#consecutiveFailures = 0;
      this.#openedAt = null;
      this.#nextProbeAt = null;
    } else if (this.#state === 'closed') {
      this.#consecutiveFailures = 0;
    }
    this.#emit();
  }

  /** 一次通道层面的失败（超时 / 连接失败 / 5xx / 响应结构不符） */
  onFailure(): void {
    this.#probeInFlight = false;
    this.#consecutiveFailures += 1;
    if (this.#state === 'half_open') {
      // 探测失败：回到熔断档，冷却重新计时
      this.#trip();
      return;
    }
    if (this.#state === 'closed' && this.#consecutiveFailures >= this.#threshold) {
      this.#trip();
    }
  }

  /**
   * 从台账里恢复熔断状态（守护进程重启后接着上一程的状态）。
   *
   * 恢复的是「还在不在熔断」与「冷却到什么时候」—— 重启不该让一条坏掉的
   * 计费通道立刻又被敲一遍。
   */
  restore(snapshot: Partial<CircuitSnapshot> | null | undefined): void {
    if (!snapshot) return;
    const state = snapshot.state;
    if (state !== 'closed' && state !== 'open' && state !== 'half_open') return;
    this.#state = state;
    this.#consecutiveFailures =
      Number.isInteger(snapshot.consecutive_failures) && (snapshot.consecutive_failures ?? 0) >= 0
        ? (snapshot.consecutive_failures as number)
        : 0;
    this.#openedAt = parseEpoch(snapshot.opened_at);
    this.#nextProbeAt = parseEpoch(snapshot.next_probe_at);
    // 半开档在重启后没有探测在途：交由下一次请求重新放行一次探测
    this.#probeInFlight = false;
  }

  /** 打开熔断：记打开时刻与下次探测时刻 */
  #trip(): void {
    const now = this.#now();
    this.#state = 'open';
    this.#openedAt = now;
    this.#nextProbeAt = now + this.#cooldownMs;
    this.#emit();
  }

  /** 短路时抛的异常（通道不可达、可重投） */
  #shortCircuitError(): ChargeError {
    const nextProbeAt = this.#nextProbeAt;
    const detail =
      `state=${this.#state} consecutive_failures=${this.#consecutiveFailures} ` +
      `threshold=${this.#threshold} ` +
      `next_probe_at=${nextProbeAt === null ? '—' : new Date(nextProbeAt).toISOString()}`;
    return new ChargeError({
      kind: 'circuit_open',
      message:
        `HIS 计费通道已熔断（连续失败 ${this.#consecutiveFailures} 次 / 阈值 ${this.#threshold}），` +
        `本次请求未发出` +
        (nextProbeAt === null ? '' : `；预计 ${new Date(nextProbeAt).toISOString()} 后自动探测`),
      detail,
    });
  }

  /** 状态变化通知（落盘回调） */
  #emit(): void {
    this.#onChange?.(this.snapshot());
  }
}

/** 把 ISO 时刻解析回 epoch 毫秒（解不出来返回 null） */
function parseEpoch(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 把熔断快照落到台账 `meta` 表（心跳表，不污染只增不改的审计链） */
export function saveCircuitSnapshot(db: DatabaseSync, snapshot: CircuitSnapshot): void {
  setMeta(db, CIRCUIT_META_KEY, JSON.stringify(snapshot));
}

/** 从台账 `meta` 表读回熔断快照（没有则 null） */
export function loadCircuitSnapshot(db: DatabaseSync): CircuitSnapshot | null {
  const raw = getMetaText(db, CIRCUIT_META_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CircuitSnapshot>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      state: parsed.state ?? 'closed',
      consecutive_failures: parsed.consecutive_failures ?? 0,
      threshold: parsed.threshold ?? CIRCUIT_DEFAULTS.failureThreshold,
      cooldown_ms: parsed.cooldown_ms ?? CIRCUIT_DEFAULTS.cooldownMs,
      opened_at: parsed.opened_at ?? null,
      next_probe_at: parsed.next_probe_at ?? null,
      updated_at: parsed.updated_at ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** 短路时对外的错误码（供文档与测试对齐） */
export const CIRCUIT_OPEN_ERROR_CODE = CHARGE_ERROR_CODES.circuitOpen;
