/**
 * 出站层：HIS 计费 HTTP 客户端（真实 socket · 连接复用 · 超时分级 · 熔断）。
 *
 * 语义来源（源产品主路径）：源产品把出站凭据集中在**一处盖章**，业务侧只拿得到
 * 投递端口、拿不到凭据字符串（`crates/connection_gateway_models` 的投递模型只暴露
 * 目标实体与消息，不暴露通道凭据）；投递结果按**逐目标回执**返回
 * （`MessageReceipt { user_id, delivery_count, active }` —— 回执带投递次数与通道
 * 是否当时可达），单条投递失败是普通结果而非中断。
 *
 * 本模块照此语义改写成耗材计费场景：
 *   - Bearer 令牌封在客户端私有字段（`#token`）里，**业务层与日志都拿不到明文**；
 *   - 端点基址与路径全部来自环境变量 / 配置，不在产品代码里硬编码；
 *   - 每次出站留一条脱敏的结构化日志，失败抛**带错误码**的异常，并区分
 *     「通道不可达」（超时 / 连接失败 / 熔断 → 可重投）与「通道可达但对端拒绝」
 *     （→ 不重投）；
 *   - 重投次数与可达性由上层回执台账承接（`src/charge/receipt.ts`）。
 *
 * 韧性三件事（Task 33）：
 *   ① **超时分级** —— 连接超时与响应超时分项配置；响应超时按**条目数**线性放大
 *      并设上限（一条耗材等 10 秒合理，一百条还等 10 秒就不合理）；
 *   ② **连接复用** —— 用 node:http 的 keep-alive Agent 复用连接，
 *      不再每条耗材都新建一次 TCP + TLS；
 *   ③ **连续失败熔断** —— 连续 N 次通道级失败后短路一段时间，期间请求
 *      **不外发**、直接判「通道不可达」；冷却到点放一次探测，探测成功即恢复。
 *
 * 硬约束：
 *   ① 凭据单一出口：令牌只在本层盖章，日志与异常信息里一律不出现明文；
 *   ② 生产客户端与测试替身走**同一条** HTTP 代码路径（真实 socket），
 *      替身只存在于 tests/ 内（真实 HTTP 服务，不 mock 请求）；
 *   ③ 默认启动路径永不指向 localhost —— 基址来自环境变量，缺位即 fail closed；
 *   ④ 熔断**不吞数据**：短路的条目照常进退避重投队列并留在台账里。
 */

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

import {
  ChargeCircuitBreaker,
  type CircuitSnapshot,
} from './circuit.js';
import {
  CHARGE_ERROR_CODES,
  ChargeError,
  type ChargeFailureKind,
} from './errors.js';

/* 错误码与异常类型从 errors.ts 拆出，这里原样再导出，业务层引用路径不变 */
export { CHARGE_ERROR_CODES, ChargeError } from './errors.js';
export type { ChargeFailureKind } from './errors.js';

/** 出站默认响应超时（毫秒，单条耗材口径） */
export const DEFAULT_CHARGE_TIMEOUT_MS = 10_000;

/** 出站默认连接超时（毫秒）：TCP 建连 + TLS 握手的预算 */
export const DEFAULT_CHARGE_CONNECT_TIMEOUT_MS = 5_000;

/** 响应超时按条目数放大后的上限（毫秒）：再大的批次也不无限等 */
export const DEFAULT_CHARGE_MAX_RESPONSE_TIMEOUT_MS = 60_000;

/** 连接池默认参数 */
export const DEFAULT_CHARGE_KEEP_ALIVE_MS = 30_000;
export const DEFAULT_CHARGE_MAX_SOCKETS = 16;

/**
 * 一条出站日志记录（结构化，字段与后续统一日志层一致）
 */
export interface ChargeLogRecord {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  channel: 'outbound';
  /** 事件名，如 charge_request_succeeded */
  event: string;
  /** 台次号（可从请求体取） */
  operation_no?: string;
  /** 涉及的耗材码 */
  material_codes?: string[];
  /** 对端状态码 */
  status?: number;
  /** 错误码 */
  error_code?: string;
  /** 耗时（毫秒） */
  duration_ms?: number;
  /** 端点（已脱敏：去掉 query） */
  endpoint?: string;
  /** 本次请求带的明细条数 */
  item_count?: number;
  /** 本次实际生效的响应超时（毫秒） */
  timeout_ms?: number;
  /** 熔断状态（closed / open / half_open） */
  circuit_state?: string;
}

export type ChargeLogger = (record: ChargeLogRecord) => void;

/** 默认日志出口：JSON 行写 stderr（正式版接统一结构化日志） */
export const defaultChargeLogger: ChargeLogger = (record) => {
  console.error(JSON.stringify(record));
};

/** 需要打码的请求头 */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-scan-signature',
  'x-api-key',
  'cookie',
]);

/** 保留认证方案、隐去凭据本身：`Bearer ***` */
function maskHeaderValue(value: string): string {
  const spaceAt = value.indexOf(' ');
  if (spaceAt > 0) return `${value.slice(0, spaceAt)} ***`;
  return '***';
}

/** 请求头打码：Authorization 一律打码（推送通道与企业微信同样适用） */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? maskHeaderValue(value) : value;
  }
  return out;
}

/** 端点打码：去掉 query（凭据不该出现在 URL 里，但日志更保守） */
export function redactEndpoint(url: string): string {
  const queryAt = url.indexOf('?');
  return queryAt >= 0 ? `${url.slice(0, queryAt)}?***` : url;
}

/** fetch 的最小结构（推送通道与公开数据拉取共用；出站计费走真实 socket） */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<HttpResponseLike>;

/* ------------------------------------------------------------------ 传输层 */

/** 传输层失败的阶段：连接阶段 / 响应阶段 / 网络错误 */
export type TransportPhase = 'connect_timeout' | 'response_timeout' | 'network';

/** 一次传输的结果 */
export type TransportOutcome =
  | { ok: true; status: number; statusText: string; body: string }
  | { ok: false; phase: TransportPhase; message: string };

/**
 * 真实 socket 的一次 POST（node:http / node:https + keep-alive Agent）。
 *
 * 连接阶段与响应阶段**分别计时**：
 *   - 连接阶段没建连 → connect_timeout（信息科会去看网络链路 / HIS 地址）；
 *   - 连接建好了但对端迟迟不给结论 → response_timeout（信息科会去看 HIS 负载）。
 */
function sendViaSocket(
  url: URL,
  headers: Record<string, string>,
  payload: string,
  options: {
    agent: HttpAgent | HttpsAgent;
    connectTimeoutMs: number;
    responseTimeoutMs: number;
  },
): Promise<TransportOutcome> {
  return new Promise<TransportOutcome>((resolve) => {
    const isHttps = url.protocol === 'https:';
    const request = isHttps
      ? httpsRequest(url, { method: 'POST', headers, agent: options.agent })
      : httpRequest(url, { method: 'POST', headers, agent: options.agent });

    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let responseTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = (): void => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (responseTimer) {
        clearTimeout(responseTimer);
        responseTimer = null;
      }
    };
    const settle = (outcome: TransportOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(outcome);
    };

    // ① 连接阶段预算
    connectTimer = setTimeout(() => {
      if (settled) return;
      request.destroy();
      settle({
        ok: false,
        phase: 'connect_timeout',
        message: `连接超时（${options.connectTimeoutMs} 毫秒内未与 HIS 计费侧建连）`,
      });
    }, options.connectTimeoutMs);
    (connectTimer as unknown as { unref?: () => void }).unref?.();

    request.on('socket', (socket) => {
      // 复用池里的空闲连接：已经是连上的，不需要再等
      if (!socket.connecting) {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        return;
      }
      socket.once('connect', () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      });
    });

    // ② 响应阶段预算（请求发出去之后开始算）
    request.on('finish', () => {
      if (responseTimer || settled) return;
      responseTimer = setTimeout(() => {
        if (settled) return;
        request.destroy();
        settle({
          ok: false,
          phase: 'response_timeout',
          message: `响应超时（${options.responseTimeoutMs} 毫秒内未拿到 HIS 计费结论）`,
        });
      }, options.responseTimeoutMs);
      (responseTimer as unknown as { unref?: () => void }).unref?.();
    });

    request.on('error', (error: Error) => {
      if (settled) return;
      settle({ ok: false, phase: 'network', message: error.message });
    });

    const chunks: Buffer[] = [];
    request.on('response', (response) => {
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        settle({
          ok: true,
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', (error: Error) => {
        settle({ ok: false, phase: 'network', message: error.message });
      });
    });

    request.end(payload);
  });
}

/* ------------------------------------------------------------------ 客户端 */

export interface ChargeClientOptions {
  /** HIS 计费服务基址（来自 HIS_CHARGING_BASE_URL） */
  baseUrl: string;
  /** 出站 Bearer 令牌（来自 HIS_CHARGING_TOKEN） */
  token: string;
  /**
   * 响应超时（毫秒，默认 10s）——历史别名。
   *
   * 与 `responseTimeoutMs` 等价：单条耗材的响应预算；批次越大按条目数放大
   * （见 `computeResponseTimeout`）。
   */
  timeoutMs?: number;
  /** 响应超时基数（毫秒，默认 10s） */
  responseTimeoutMs?: number;
  /** 连接超时（毫秒，默认 5s） */
  connectTimeoutMs?: number;
  /** 响应超时按条目数放大后的上限（毫秒，默认 60s） */
  maxResponseTimeoutMs?: number;
  /** 连接池保活时长（毫秒，默认 30s） */
  keepAliveMsecs?: number;
  /** 连接池最大并发连接数（默认 16） */
  maxSockets?: number;
  /** 自定义连接池（默认按协议新建 keep-alive Agent；测试可注入） */
  agent?: HttpAgent | HttpsAgent;
  /** 熔断器（不传则用默认阈值的内置实例） */
  circuit?: ChargeCircuitBreaker;
  /** 熔断连续失败阈值（默认 5） */
  circuitFailureThreshold?: number;
  /** 熔断冷却时长（毫秒，默认 30s） */
  circuitCooldownMs?: number;
  /** 熔断状态变化回调（守护进程据此把状态落到台账，doctor 才查得到） */
  onCircuitChange?: (snapshot: CircuitSnapshot) => void;
  /** 日志出口（默认 JSON 行写 stderr） */
  logger?: ChargeLogger;
}

/**
 * 响应超时预算：**基数 × 条目数**，并封顶。
 *
 * 一条耗材等 10 秒合理；一百条还等 10 秒不合理（对端在批量处理）。
 * 但也不能无限放大 —— 上限封住，别把守护进程吊在一个永远不回的请求上。
 */
export function computeResponseTimeout(
  baseMs: number,
  itemCount: number,
  capMs: number = DEFAULT_CHARGE_MAX_RESPONSE_TIMEOUT_MS,
): number {
  const base =
    Number.isFinite(baseMs) && baseMs > 0 ? baseMs : DEFAULT_CHARGE_TIMEOUT_MS;
  const cap = Number.isFinite(capMs) && capMs > 0 ? capMs : base;
  const n = Number.isFinite(itemCount) && itemCount >= 1 ? Math.floor(itemCount) : 1;
  return Math.min(base * n, Math.max(cap, base));
}

/** 从请求体里数出明细条数（批次越大，响应超时预算越大） */
export function deriveItemCount(body: unknown): number {
  if (!body || typeof body !== 'object') return 1;
  const uses = (body as { uses?: unknown }).uses;
  if (Array.isArray(uses)) return Math.max(1, uses.length);
  return 1;
}

/** 基址规整：去掉尾部斜杠；非 http(s) 一律判配置错 */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl ?? '').trim();
  if (trimmed.length === 0) {
    throw new ChargeError({
      kind: 'config',
      message: '出站计费基址为空：请检查环境变量 HIS_CHARGING_BASE_URL',
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ChargeError({
      kind: 'config',
      message: `出站计费基址不是合法 URL：${trimmed}`,
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ChargeError({
      kind: 'config',
      message: `出站计费基址协议不支持：${parsed.protocol}（只支持 http / https）`,
    });
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * HIS 计费出站客户端。
 *
 * 令牌封在 `#token` 私有字段里：实例上**没有任何**可枚举 / 可反射的属性暴露它，
 * 业务层拿到的只是「能发请求的端口」，拿不到凭据字符串本身。
 */
export class HisChargingClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #responseTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #maxResponseTimeoutMs: number;
  readonly #agent: HttpAgent | HttpsAgent;
  readonly #circuit: ChargeCircuitBreaker;
  readonly #logger: ChargeLogger;
  readonly #ownsAgent: boolean;

  constructor(options: ChargeClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#token = (options.token ?? '').trim();
    if (this.#token.length === 0) {
      throw new ChargeError({
        kind: 'config',
        message: '出站计费令牌为空：请检查环境变量 HIS_CHARGING_TOKEN',
      });
    }
    const responseBase = options.responseTimeoutMs ?? options.timeoutMs ?? DEFAULT_CHARGE_TIMEOUT_MS;
    this.#responseTimeoutMs =
      Number.isFinite(responseBase) && responseBase > 0
        ? responseBase
        : DEFAULT_CHARGE_TIMEOUT_MS;
    const connect = options.connectTimeoutMs ?? DEFAULT_CHARGE_CONNECT_TIMEOUT_MS;
    this.#connectTimeoutMs =
      Number.isFinite(connect) && connect > 0 ? connect : DEFAULT_CHARGE_CONNECT_TIMEOUT_MS;
    const cap = options.maxResponseTimeoutMs ?? DEFAULT_CHARGE_MAX_RESPONSE_TIMEOUT_MS;
    this.#maxResponseTimeoutMs =
      Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_CHARGE_MAX_RESPONSE_TIMEOUT_MS;
    this.#logger = options.logger ?? defaultChargeLogger;
    this.#ownsAgent = options.agent === undefined;
    this.#agent =
      options.agent ??
      this.#createAgent(new URL(this.#baseUrl), {
        keepAliveMsecs: options.keepAliveMsecs ?? DEFAULT_CHARGE_KEEP_ALIVE_MS,
        maxSockets: options.maxSockets ?? DEFAULT_CHARGE_MAX_SOCKETS,
      });
    this.#circuit =
      options.circuit ??
      new ChargeCircuitBreaker({
        failureThreshold: options.circuitFailureThreshold,
        cooldownMs: options.circuitCooldownMs,
        onChange: options.onCircuitChange,
      });
  }

  /** 按协议建一个 keep-alive 连接池 */
  #createAgent(
    url: URL,
    options: { keepAliveMsecs: number; maxSockets: number },
  ): HttpAgent | HttpsAgent {
    const agentOptions = {
      keepAlive: true,
      keepAliveMsecs: options.keepAliveMsecs,
      maxSockets: options.maxSockets,
      // 超时由本模块自己分阶段管（socket 层再设一个超时会把两段计时搅在一起）
      timeout: 0,
    };
    return url.protocol === 'https:' ? new HttpsAgent(agentOptions) : new HttpAgent(agentOptions);
  }

  /** 端点基址（不含凭据，可安全展示给 doctor） */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** 响应超时基数（毫秒） */
  get timeoutMs(): number {
    return this.#responseTimeoutMs;
  }

  /** 连接超时（毫秒） */
  get connectTimeoutMs(): number {
    return this.#connectTimeoutMs;
  }

  /** 熔断器（供 doctor 与测试查状态） */
  get circuit(): ChargeCircuitBreaker {
    return this.#circuit;
  }

  /** 现在是不是熔断着 */
  isCircuitOpen(): boolean {
    return this.#circuit.isOpen();
  }

  /** 下次自动探测时刻（epoch 毫秒） */
  circuitNextProbeAt(): number | null {
    return this.#circuit.nextProbeAt();
  }

  /** 熔断状态快照 */
  circuitSnapshot(): CircuitSnapshot {
    return this.#circuit.snapshot();
  }

  /** 关闭连接池（守护进程优雅停机时调用，避免留一堆空闲连接） */
  destroy(): void {
    if (this.#ownsAgent) this.#agent.destroy();
  }

  /** 拼完整 URL：基址 + 路径（路径来自配置，不硬编码） */
  #buildUrl(path: string): string {
    const clean = (path ?? '').trim();
    if (clean.length === 0) {
      throw new ChargeError({ kind: 'config', message: '出站端点路径为空' });
    }
    return `${this.#baseUrl}${clean.startsWith('/') ? '' : '/'}${clean}`;
  }

  /** 把令牌明文从任意文本里抹掉（日志与异常共用） */
  #redact(value: string): string {
    if (!value.includes(this.#token)) return value;
    return value.split(this.#token).join('***');
  }

  /**
   * 发一个 JSON POST：Bearer 在本层盖章，日志打码，超时与非 2xx 抛带错误码的异常。
   *
   * @param path 端点路径（来自配置）
   * @param body 请求体（会被 JSON 序列化）
   * @param options.itemCount 本次请求带的明细条数（不传则从请求体里数）
   */
  async postJson<T = unknown>(
    path: string,
    body: unknown,
    options: { itemCount?: number } = {},
  ): Promise<T> {
    const url = this.#buildUrl(path);
    const payload = JSON.stringify(body);
    const itemCount = options.itemCount ?? deriveItemCount(body);
    const responseTimeoutMs = computeResponseTimeout(
      this.#responseTimeoutMs,
      itemCount,
      this.#maxResponseTimeoutMs,
    );
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json',
      // 凭据单一出口：只有这一行拿得到令牌明文
      authorization: `Bearer ${this.#token}`,
      'content-length': String(Buffer.byteLength(payload, 'utf8')),
    };
    const operationNo =
      body && typeof body === 'object' && 'operation_no' in body
        ? String((body as { operation_no?: unknown }).operation_no ?? '')
        : '';

    const startedAt = Date.now();

    // 熔断闸门：打开时**不外发**，直接判通道不可达（条目照常进重投队列）
    try {
      this.#circuit.beforeRequest();
    } catch (error) {
      const circuitError = error instanceof ChargeError ? error : null;
      this.#log({
        level: 'warn',
        event: 'charge_circuit_open',
        operation_no: operationNo,
        error_code: circuitError?.code ?? CHARGE_ERROR_CODES.circuitOpen,
        duration_ms: Date.now() - startedAt,
        endpoint: redactEndpoint(url),
        item_count: itemCount,
        circuit_state: this.#circuit.state,
      });
      throw error;
    }

    const outcome = await sendViaSocket(new URL(url), headers, payload, {
      agent: this.#agent,
      connectTimeoutMs: this.#connectTimeoutMs,
      responseTimeoutMs,
    });

    if (!outcome.ok) {
      // 通道级失败：计入熔断连续失败计数
      this.#circuit.onFailure();
      const kind: ChargeFailureKind =
        outcome.phase === 'connect_timeout'
          ? 'connect_timeout'
          : outcome.phase === 'response_timeout'
            ? 'timeout'
            : 'network';
      const error = new ChargeError({
        kind,
        message:
          kind === 'connect_timeout'
            ? outcome.message
            : kind === 'timeout'
              ? outcome.message
              : 'HIS 计费通道连接失败',
        detail: this.#redact(outcome.message),
      });
      this.#log({
        level: 'error',
        event: 'charge_request_failed',
        operation_no: operationNo,
        error_code: error.code,
        duration_ms: Date.now() - startedAt,
        endpoint: redactEndpoint(url),
        item_count: itemCount,
        timeout_ms: responseTimeoutMs,
        circuit_state: this.#circuit.state,
      });
      throw error;
    }

    const { status, statusText, body: text } = outcome;
    const duration = Date.now() - startedAt;

    if (status >= 500) {
      // 对端 5xx：通道可达但对端在报错 —— 计入熔断计数
      this.#circuit.onFailure();
      const error = new ChargeError({
        kind: 'server_error',
        status,
        message: `HIS 计费返回 ${status} ${statusText}`.trim(),
        detail: this.#redact(text).slice(0, 500),
      });
      this.#log({
        level: 'error',
        event: 'charge_request_failed',
        operation_no: operationNo,
        status,
        error_code: error.code,
        duration_ms: duration,
        endpoint: redactEndpoint(url),
        item_count: itemCount,
        timeout_ms: responseTimeoutMs,
        circuit_state: this.#circuit.state,
      });
      throw error;
    }

    if (status < 200 || status >= 300) {
      // 4xx：对端明确不收 —— 通道是通的，**不算**熔断失败
      this.#circuit.onSuccess();
      const error = new ChargeError({
        kind: 'client_error',
        status,
        message: `HIS 计费返回 ${status} ${statusText}`.trim(),
        detail: this.#redact(text).slice(0, 500),
      });
      this.#log({
        level: 'error',
        event: 'charge_request_failed',
        operation_no: operationNo,
        status,
        error_code: error.code,
        duration_ms: duration,
        endpoint: redactEndpoint(url),
        item_count: itemCount,
        timeout_ms: responseTimeoutMs,
        circuit_state: this.#circuit.state,
      });
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 响应不是 JSON：没法确认对端到底记没记这一笔 —— 计入熔断计数并重投
      this.#circuit.onFailure();
      const error = new ChargeError({
        kind: 'response_invalid',
        status,
        message: 'HIS 计费响应不是合法 JSON',
        detail: this.#redact(text).slice(0, 500),
      });
      this.#log({
        level: 'error',
        event: 'charge_request_failed',
        operation_no: operationNo,
        status,
        error_code: error.code,
        duration_ms: duration,
        endpoint: redactEndpoint(url),
        item_count: itemCount,
        timeout_ms: responseTimeoutMs,
        circuit_state: this.#circuit.state,
      });
      throw error;
    }

    this.#circuit.onSuccess();
    this.#log({
      level: 'info',
      event: 'charge_request_succeeded',
      operation_no: operationNo,
      status,
      duration_ms: duration,
      endpoint: redactEndpoint(url),
      item_count: itemCount,
      timeout_ms: responseTimeoutMs,
      circuit_state: this.#circuit.state,
    });
    return parsed as T;
  }

  /** 写一条脱敏日志 */
  #log(record: Omit<ChargeLogRecord, 'timestamp' | 'channel'>): void {
    this.#logger({
      timestamp: new Date().toISOString(),
      channel: 'outbound',
      ...record,
    });
  }
}

/** 用配置装配一个出站客户端（凭据齐否由 env 层保证 fail closed） */
export function createChargeClient(
  options: Omit<ChargeClientOptions, 'baseUrl' | 'token'> & { baseUrl: string; token: string },
): HisChargingClient {
  return new HisChargingClient(options);
}
