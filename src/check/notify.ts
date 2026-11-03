/**
 * 企业微信机器人批次摘要推送：把一批扫码的结论推到**既有**企业微信群，不新造消息中心。
 *
 * 语义来源（源产品主路径）：源产品的状态机器人是一个**独立的推送服务**——
 * 入口用 `requiredVars` 逐项检查凭据（`BOT_TOKEN` / `CHANNEL_ID` / `WEBHOOK_SECRET`），
 * 缺任一项即打印变量名并 `process.exit(1)`；凭据只交给一个「投递到既有通道」的端口
 * （`createChannelPoster`），投递失败即抛。本模块照此语义改写成耗材场景：
 *
 *   - 凭据只在本模块读（`WECOM_WEBHOOK_URL` / `WECOM_SECRET`），**凭据单一出口**：
 *     业务层拿得到「能发消息的客户端」，拿不到密钥字符串，日志里一律不出现明文；
 *   - 沿用**企业微信群机器人**的真实协议：`POST {webhook}`，URL 上带 `key`，
 *     开启加签时再拼 `timestamp` 与 `sign`（`sign = sha1("{timestamp}{secret}{key}")`），
 *     请求体 `{msgtype:"markdown", markdown:{content}}`，响应 `{errcode, errmsg}`；
 *   - 推送失败**不阻塞台账落库**：失败被捕获、计数写进审计链，由 `doctor` 暴露，
 *     台账与核查条目一行都不受影响。
 *
 * 硬约束：
 *   ① 凭据单一出口：webhook 的 `key` 与加签密钥都不进日志、不进异常信息；
 *   ② **同一批次最多推一条**：批次键落 `notify_delivery` 表，重复投递不再推第二遍；
 *   ③ **无异常批次默认不推**（可配置）：不打扰手术室；
 *   ④ 推送失败**不抛到主流程**：失败计数进审计链（`notify_batch_failed`），
 *      台账行数、核查条目数都不变；
 *   ⑤ 消息里只出现耗材码、台次与结论，**不含患者可识别字段**。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { redactEndpoint, type FetchLike, type HttpResponseLike } from '../charge/client.js';
import { appendAudit } from '../ledger/audit.js';

/* ── 错误码表（与 docs/api/wecom-notify.md 一致） ── */

export const NOTIFY_ERROR_CODES = {
  /** 配置缺失或非法（请求根本没发出去） */
  config: 'ERR_NOTIFY_CONFIG',
  /** 请求超时（通道不可达，可重投） */
  timeout: 'ERR_NOTIFY_TIMEOUT',
  /** 连接失败 / DNS 失败（通道不可达，可重投） */
  network: 'ERR_NOTIFY_NETWORK',
  /** 对端 5xx（通道可达，可重投） */
  serverError: 'ERR_NOTIFY_HTTP_5XX',
  /** 对端 4xx（通道可达，不可重投） */
  clientError: 'ERR_NOTIFY_HTTP_4XX',
  /** 响应体不是预期结构（可重投，不静默当成成功） */
  responseInvalid: 'ERR_NOTIFY_RESPONSE_INVALID',
  /** 对端返回了业务错误码（errcode ≠ 0） */
  bizError: 'ERR_NOTIFY_BIZ_ERROR',
  /** 本侧内部异常 */
  internal: 'ERR_NOTIFY_INTERNAL',
} as const;

export type NotifyFailureKind =
  | 'config'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'client_error'
  | 'response_invalid'
  | 'biz_error'
  | 'internal';

const KIND_CODES: Readonly<Record<NotifyFailureKind, string>> = {
  config: NOTIFY_ERROR_CODES.config,
  timeout: NOTIFY_ERROR_CODES.timeout,
  network: NOTIFY_ERROR_CODES.network,
  server_error: NOTIFY_ERROR_CODES.serverError,
  client_error: NOTIFY_ERROR_CODES.clientError,
  response_invalid: NOTIFY_ERROR_CODES.responseInvalid,
  biz_error: NOTIFY_ERROR_CODES.bizError,
  internal: NOTIFY_ERROR_CODES.internal,
};

/** 各失败档的默认处置：通道当时可达否 / 值不值得重投 */
const KIND_DEFAULTS: Readonly<
  Record<NotifyFailureKind, { channelReachable: boolean; retryable: boolean }>
> = {
  config: { channelReachable: false, retryable: false },
  timeout: { channelReachable: false, retryable: true },
  network: { channelReachable: false, retryable: true },
  server_error: { channelReachable: true, retryable: true },
  client_error: { channelReachable: true, retryable: false },
  response_invalid: { channelReachable: true, retryable: true },
  biz_error: { channelReachable: true, retryable: false },
  internal: { channelReachable: false, retryable: true },
};

/** 推送失败异常：带错误码、可达性与重投标记，供审计链与 doctor 归类 */
export class NotifyError extends Error {
  readonly code: string;
  readonly kind: NotifyFailureKind;
  readonly status: number | null;
  readonly channelReachable: boolean;
  readonly retryable: boolean;
  readonly detail: string | null;

  constructor(init: {
    kind: NotifyFailureKind;
    message: string;
    status?: number | null;
    channelReachable?: boolean;
    retryable?: boolean;
    detail?: string | null;
  }) {
    super(init.message);
    this.name = 'NotifyError';
    this.code = KIND_CODES[init.kind];
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.channelReachable = init.channelReachable ?? KIND_DEFAULTS[init.kind].channelReachable;
    this.retryable = init.retryable ?? KIND_DEFAULTS[init.kind].retryable;
    this.detail = init.detail ?? null;
  }
}

/* ── 结论与原因码的中文说明（护士长看得懂，原始码同时保留便于反查） ── */

export const CONCLUSION_LABELS: Readonly<Record<string, string>> = {
  BOUND: '已绑本台次',
  NOT_REGISTERED: '耗材码未建档',
  CROSS_OP_DUP: '与另一台次重复',
  CLOSED: '台次已关台',
  CHARGE_REJECTED: '计费被拒',
};

export const REASON_LABELS: Readonly<Record<string, string>> = {
  MATERIAL_NOT_REGISTERED: '耗材码不在院内耗材主数据中',
  OPERATION_NOT_FOUND: '手术台次不存在',
  OPERATION_CLOSED: '手术台次已关台',
  CROSS_OP_DUPLICATE_MATERIAL: '同一耗材已记在另一台次',
  DUPLICATE_SCAN: '同一台次同一耗材已记过',
  DUPLICATE_IN_BATCH: '同一批里重复出现',
  CLAIM_BUSY: '同一条正在处理中',
  INTERNAL_ERROR: '处理异常',
  CODE_EMPTY: '耗材码为空',
  CODE_TOO_LONG: '耗材码超长',
  CODE_ILLEGAL_CHARSET: '耗材码含非法字符',
  CODE_FORM_UNRECOGNIZED: '耗材码形态无法识别',
  MATERIAL_INACTIVE: '耗材已停用',
  FEE_CATEGORY_MISSING: '未登记费用类别',
  INSURANCE_CLASS_MISSING: '未登记医保分类',
  MISSING_RECEIPT: '对端未回执',
};

/** 重复扫码是幂等层的**正常结果**（台账里本来就有这一笔），默认不进推送清单 */
export const REASON_DUPLICATE_SCAN = 'DUPLICATE_SCAN';

/* ── 批次摘要 ── */

/** 一条异常明细（护士长 / 耗材管理岗要照着核的那几条） */
export interface NotifyException {
  /** 耗材码 */
  material_code: string;
  /** 原因码（原始码，便于与核查清单反查） */
  reason_code: string;
  /** 绑定结论（五种之一） */
  conclusion?: string | null;
  /** 数量 */
  quantity?: number | null;
  /** 台次号（默认取批次号） */
  operation_no?: string | null;
}

/** 一批扫码的摘要（推送内容与节流依据） */
export interface NotifySummary {
  /** 台次号 */
  operation_no: string;
  /** 手术间 */
  room_no: string;
  /** 科室 */
  dept_code?: string | null;
  /** 扫码枪编号 */
  scanner_id: string;
  /** 本批条目总数 */
  total: number;
  /** 绑定成功条数 */
  accepted: number;
  /** 异常条数（原始口径，含重复扫码） */
  rejected: number;
  /** 批内重复去重条数 */
  duplicate_in_batch?: number;
  /** 异常条目明细 */
  exceptions: readonly NotifyException[];
  /** 本批全部条目（派生批次键用；不给则只用异常条目） */
  items?: ReadonlyArray<{ material_code: string; quantity: number }>;
  /** 显式批次键（不给则按内容派生） */
  batch_key?: string | null;
  /** 批次发生时间 */
  occurred_at?: string | null;
}

export interface NotifyOptions {
  /** 只推有异常的批次（默认 true：不打扰手术室） */
  onlyAbnormal?: boolean;
  /** 单条消息最多列出的异常条数（默认 20，超出折叠计数） */
  maxExceptionItems?: number;
  /** 把「重复扫码」排除在清单外（默认 true：那是幂等层的正常结果） */
  ignoreDuplicateScan?: boolean;
  /** 允许把推送失败过的批次再推一次（默认 false：同一批次最多推一条） */
  retryFailed?: boolean;
}

/** 推送结果 */
export interface NotifyOutcome {
  /** 是否真的发出去了 */
  sent: boolean;
  /**
   * 结果档位。
   *
   * `queued` = 已进聚合窗口、**还没发出去**（按台次聚合节流模式，见 `src/check/message-template.ts`）；
   * 其余三档与立即推送模式一致。
   */
  result: 'sent' | 'queued' | 'failed' | 'skipped';
  /** 跳过原因（未跳过时为 null） */
  skipped: 'no_exception' | 'duplicate_batch' | null;
  /** 批次键（节流依据） */
  batch_key: string;
  /** 失败时的错误码 */
  error_code?: string | null;
  /** 失败信息（已脱敏） */
  message?: string | null;
  /** 推送出去的异常条数 */
  exception_count: number;
}

/* ── 签名与消息体 ── */

/**
 * 企业微信群机器人加签：`sign = sha1("{timestamp}{secret}{key}")`。
 *
 * timestamp 取 unix 秒；key 取 webhook 地址上的 `key` 查询参数（机器人凭据）。
 */
export function signWeComRequest(timestamp: string, secret: string, key: string): string {
  return createHash('sha1').update(`${timestamp}${secret}${key}`, 'utf8').digest('hex');
}

/** 企微机器人消息体（markdown） */
export interface WeComMessage {
  msgtype: 'markdown';
  markdown: { content: string };
}

/** 一条异常的中文说明（结论 + 原因码 + 原始码） */
function describeException(exception: NotifyException): string {
  const conclusionLabel = exception.conclusion
    ? (CONCLUSION_LABELS[exception.conclusion] ?? exception.conclusion)
    : '';
  const reasonLabel = REASON_LABELS[exception.reason_code] ?? '';
  const text = reasonLabel || conclusionLabel || '需人工核对';
  const quantity =
    typeof exception.quantity === 'number' && Number.isFinite(exception.quantity)
      ? ` 数量 ${exception.quantity}`
      : '';
  return `${exception.material_code}${quantity} —— ${text}（${exception.reason_code}）`;
}

/**
 * 拼批次摘要消息（markdown）。
 *
 * 只用企业微信 markdown 官方支持的三种记法：**加粗**、引用块 `>`、行内代码。
 */
export function buildBatchSummaryMessage(
  summary: NotifySummary,
  options: NotifyOptions = {},
): WeComMessage {
  const maxItems = options.maxExceptionItems ?? 20;
  const shown = summary.exceptions.slice(0, Math.max(0, maxItems));
  const hidden = summary.exceptions.length - shown.length;

  const lines: string[] = [];
  lines.push('**高值耗材扫码批次异常**');
  lines.push(
    `> 台次 \`${summary.operation_no}\` · 手术间 \`${summary.room_no}\`` +
      (summary.dept_code ? ` · 科室 \`${summary.dept_code}\`` : '') +
      (summary.scanner_id ? ` · 扫码枪 \`${summary.scanner_id}\`` : ''),
  );
  lines.push(
    `> 本批共 ${summary.total} 条：已绑定 ${summary.accepted} 条，异常 ${summary.rejected} 条` +
      (summary.duplicate_in_batch ? `，批内重复 ${summary.duplicate_in_batch} 条` : ''),
  );

  lines.push('');
  lines.push('**异常明细**');
  if (shown.length === 0) {
    lines.push('> 无');
  } else {
    shown.forEach((exception, index) => {
      lines.push(`> ${index + 1}. ${describeException(exception)}`);
    });
    if (hidden > 0) {
      lines.push(`> …… 另有 ${hidden} 条未列出，请到核查清单查看`);
    }
  }

  lines.push('');
  lines.push('> 处理入口：高值耗材扫码计费闭环系统 · 核查清单（护士长 / 高值耗材管理岗）');

  return { msgtype: 'markdown', markdown: { content: lines.join('\n') } };
}

/**
 * 派生批次键：同一批次重投时键不变（幂等），不同批次键必不同。
 *
 * 键 = sha256(台次 | 手术间 | 扫码枪 | 本批条目集合（码×数量，排序后）)。
 * 条目集合取**本批全部条目**而非只有异常条目：重投时结论会变（BOUND → DUPLICATE_SCAN），
 * 但条目集合不变 —— 批次身份才不会随结论漂移。
 */
export function deriveBatchKey(summary: NotifySummary): string {
  const source =
    summary.items && summary.items.length > 0
      ? summary.items
      : summary.exceptions.map((exception) => ({
          material_code: exception.material_code,
          quantity: exception.quantity ?? 1,
        }));
  const normalized = source
    .map((item) => `${item.material_code}×${item.quantity}`)
    .sort()
    .join(',');
  return createHash('sha256')
    .update(
      `${summary.operation_no}|${summary.room_no}|${summary.scanner_id}|${normalized}`,
      'utf8',
    )
    .digest('hex');
}

/* ── 核查任务提醒与升级通知 ── */

/**
 * 核查任务提醒的消息载荷。
 *
 * 提醒是给**具体岗位**看的：得说清是哪台手术、哪条耗材、为什么找你、已经超时多久。
 */
export interface CheckTaskReminderInput {
  /** 核查条目 id */
  task_id: number;
  /** 台次号 */
  operation_no: string;
  /** 手术间 */
  room_no: string;
  /** 科室 */
  dept_code?: string | null;
  /** 耗材码 */
  material_code: string;
  /** 数量 */
  quantity?: number | null;
  /** 绑定结论 */
  conclusion: string;
  /** 原因码 */
  reason_code: string;
  /** 统一错误码 */
  error_code?: string | null;
  /** 责任岗位（面向人：手术室护士长（SURG-01）） */
  assignee_display: string;
  /** 已超时多久（毫秒） */
  overdue_ms: number;
  /** 当前处置档位 */
  timeout_level: number;
}

/** 升级通知的消息载荷 */
export interface EscalationNoticeInput {
  task_id: number;
  operation_no: string;
  room_no: string;
  dept_code?: string | null;
  material_code: string;
  quantity?: number | null;
  conclusion: string;
  reason_code: string;
  /** 原责任岗位 */
  from_role: string;
  /** 新责任岗位 */
  to_role: string;
  /** 升级后的处置档位 */
  timeout_level: number;
}

/** 把毫秒说成人话：2 小时 5 分钟 */
export function formatDurationZh(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分钟`);
  if (parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.join(' ');
}

/** 一条耗材的中文说明（数量 + 结论 + 原因码） */
function describeTaskItem(input: {
  material_code: string;
  quantity?: number | null;
  conclusion: string;
  reason_code: string;
}): string {
  const quantity =
    typeof input.quantity === 'number' && Number.isFinite(input.quantity)
      ? ` 数量 ${input.quantity}`
      : '';
  const reasonLabel = REASON_LABELS[input.reason_code] ?? '';
  const conclusionLabel = CONCLUSION_LABELS[input.conclusion] ?? '';
  const text = reasonLabel || conclusionLabel || '需人工核对';
  return `${input.material_code}${quantity} —— ${text}（${input.reason_code}）`;
}

/**
 * 核查任务超时提醒（markdown）。
 *
 * 面向**责任岗位**：一句话说清「哪台手术、哪条耗材、为什么找你、已经超时多久」。
 */
export function buildCheckTaskReminderMessage(
  input: CheckTaskReminderInput,
): WeComMessage {
  const lines: string[] = [];
  lines.push('**高值耗材核查待办超时**');
  lines.push(
    `> 台次 \`${input.operation_no}\` · 手术间 \`${input.room_no}\`` +
      (input.dept_code ? ` · 科室 \`${input.dept_code}\`` : ''),
  );
  lines.push(`> 待办 #${input.task_id}　${describeTaskItem(input)}`);

  lines.push('');
  lines.push('**该谁处理**');
  lines.push(`> ${input.assignee_display}　已超时 ${formatDurationZh(input.overdue_ms)}`);
  if (input.timeout_level > 0) {
    lines.push(`> 当前处置档位：第 ${input.timeout_level + 1} 档（已升级过）`);
  }

  lines.push('');
  lines.push('> 处理入口：高值耗材扫码计费闭环系统 · 核查清单（落定结论后自动闭环）');
  return { msgtype: 'markdown', markdown: { content: lines.join('\n') } };
}

/**
 * 核查任务升级通知（markdown）：催上一级岗位督办。
 *
 * 写明**原责任岗位 → 新责任岗位**，让科室知道这条是从谁手上升级上来的。
 */
export function buildEscalationNoticeMessage(input: EscalationNoticeInput): WeComMessage {
  const lines: string[] = [];
  lines.push('**核查待办已升级**');
  lines.push(
    `> 台次 \`${input.operation_no}\` · 手术间 \`${input.room_no}\`` +
      (input.dept_code ? ` · 科室 \`${input.dept_code}\`` : ''),
  );
  lines.push(`> 待办 #${input.task_id}　${describeTaskItem(input)}`);

  lines.push('');
  lines.push('**责任岗位变更**');
  lines.push(`> ${input.from_role} → ${input.to_role}（第 ${input.timeout_level + 1} 档）`);
  lines.push('> 上一级岗位未在时限内处理，请督办；条目仍为待核查，未自动闭环');

  lines.push('');
  lines.push('> 处理入口：高值耗材扫码计费闭环系统 · 核查清单');
  return { msgtype: 'markdown', markdown: { content: lines.join('\n') } };
}

/* ── 客户端 ── */

/** 一条推送日志（结构化，字段与统一日志层一致） */
export interface NotifyLogRecord {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  channel: 'notify';
  event: string;
  operation_no?: string;
  batch_key?: string;
  error_code?: string;
  status?: number;
  duration_ms?: number;
  /** 端点（已脱敏：去掉 query，webhook 的 key 不进日志） */
  endpoint?: string;
}

export type NotifyLogger = (record: NotifyLogRecord) => void;

/** 默认日志出口：JSON 行写 stderr */
export const defaultNotifyLogger: NotifyLogger = (record) => {
  console.error(JSON.stringify(record));
};

export interface WeComClientOptions {
  /** 企业微信机器人 webhook（含 key 查询参数） */
  webhookUrl: string;
  /** 加签密钥（来自 WECOM_SECRET） */
  secret: string;
  /** 请求超时（毫秒，默认 5s） */
  timeoutMs?: number;
  /** fetch 实现（默认原生 fetch；替身只在 tests/ 内注入） */
  fetchImpl?: FetchLike;
  /** 日志出口 */
  logger?: NotifyLogger;
  /** 当前时间（毫秒），测试可注入 */
  nowMs?: () => number;
}

/** 企微机器人响应体 */
export interface WeComResponse {
  errcode?: number;
  errmsg?: string;
}

/**
 * 企业微信机器人客户端。
 *
 * 凭据封在 `#webhookUrl` / `#secret` 私有字段里：实例上没有任何可枚举属性暴露它们，
 * 业务层拿到的只是「能发消息的端口」。webhook 上的 `key` 同样属于凭据，
 * 日志里的端点一律去掉 query。
 */
export class WeComBotClient {
  readonly #webhookUrl: string;
  readonly #secret: string;
  readonly #key: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #logger: NotifyLogger;
  readonly #nowMs: () => number;

  constructor(options: WeComClientOptions) {
    const trimmedUrl = (options.webhookUrl ?? '').trim();
    if (trimmedUrl.length === 0) {
      throw new NotifyError({
        kind: 'config',
        message: '企业微信 webhook 地址为空：请检查环境变量 WECOM_WEBHOOK_URL',
      });
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      throw new NotifyError({
        kind: 'config',
        message: '企业微信 webhook 地址不是合法 URL',
      });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new NotifyError({
        kind: 'config',
        message: `企业微信 webhook 协议不支持：${parsed.protocol}（只支持 http / https）`,
      });
    }
    const key = parsed.searchParams.get('key');
    if (!key || key.trim().length === 0) {
      throw new NotifyError({
        kind: 'config',
        message: '企业微信 webhook 地址缺少 key 查询参数',
      });
    }
    const secret = (options.secret ?? '').trim();
    if (secret.length === 0) {
      throw new NotifyError({
        kind: 'config',
        message: '企业微信加签密钥为空：请检查环境变量 WECOM_SECRET',
      });
    }

    this.#webhookUrl = trimmedUrl;
    this.#secret = secret;
    this.#key = key.trim();
    const timeout = options.timeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;
    this.#timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_NOTIFY_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#logger = options.logger ?? defaultNotifyLogger;
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  /** 端点（去掉 query，不含凭据，可安全展示给 doctor） */
  get endpoint(): string {
    return redactEndpoint(this.#webhookUrl);
  }

  /** 请求超时（毫秒） */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /** 把密钥明文从任意文本里抹掉（日志与异常共用） */
  #redact(value: string): string {
    if (!value.includes(this.#secret)) return value;
    return value.split(this.#secret).join('***');
  }

  /** 拼带签的 webhook 地址（timestamp + sign 附在 query 上） */
  #signedUrl(timestamp: string): string {
    const url = new URL(this.#webhookUrl);
    url.searchParams.set('timestamp', timestamp);
    url.searchParams.set('sign', signWeComRequest(timestamp, this.#secret, this.#key));
    return url.toString();
  }

  /**
   * 发一条消息；非 2xx、响应不是 JSON、errcode ≠ 0、超时、连接失败分别抛对应错误码。
   */
  async postMessage(message: WeComMessage): Promise<WeComResponse> {
    const timestamp = String(Math.floor(this.#nowMs() / 1000));
    const url = this.#signedUrl(timestamp);
    const payload = JSON.stringify(message);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    const startedAt = Date.now();
    try {
      const response: HttpResponseLike = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          accept: 'application/json',
        },
        body: payload,
        signal: controller.signal,
      });
      const text = await response.text();
      const duration = Date.now() - startedAt;

      if (!response.ok) {
        const kind: NotifyFailureKind = response.status >= 500 ? 'server_error' : 'client_error';
        const error = new NotifyError({
          kind,
          status: response.status,
          message: `企业微信返回 ${response.status} ${response.statusText}`.trim(),
          detail: this.#redact(text).slice(0, 300),
        });
        this.#log({
          level: 'error',
          event: 'notify_request_failed',
          error_code: error.code,
          status: response.status,
          duration_ms: duration,
          endpoint: this.endpoint,
        });
        throw error;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        const error = new NotifyError({
          kind: 'response_invalid',
          status: response.status,
          message: '企业微信响应不是合法 JSON',
          detail: this.#redact(text).slice(0, 300),
        });
        this.#log({
          level: 'error',
          event: 'notify_request_failed',
          error_code: error.code,
          status: response.status,
          duration_ms: duration,
          endpoint: this.endpoint,
        });
        throw error;
      }

      const body = (parsed ?? {}) as WeComResponse;
      if (typeof body.errcode === 'number' && body.errcode !== 0) {
        const error = new NotifyError({
          kind: 'biz_error',
          status: response.status,
          message: `企业微信返回错误码 ${body.errcode}${body.errmsg ? `（${body.errmsg}）` : ''}`,
          detail: this.#redact(text).slice(0, 300),
        });
        this.#log({
          level: 'error',
          event: 'notify_request_failed',
          error_code: error.code,
          status: response.status,
          duration_ms: duration,
          endpoint: this.endpoint,
        });
        throw error;
      }

      this.#log({
        level: 'info',
        event: 'notify_request_succeeded',
        status: response.status,
        duration_ms: duration,
        endpoint: this.endpoint,
      });
      return body;
    } catch (error) {
      if (error instanceof NotifyError) throw error;
      if (timedOut) {
        const timeoutError = new NotifyError({
          kind: 'timeout',
          message: `企业微信推送请求超时（${this.#timeoutMs} 毫秒）`,
          detail: this.#redact(error instanceof Error ? error.message : String(error)),
        });
        this.#log({
          level: 'error',
          event: 'notify_request_failed',
          error_code: timeoutError.code,
          duration_ms: Date.now() - startedAt,
          endpoint: this.endpoint,
        });
        throw timeoutError;
      }
      const networkError = new NotifyError({
        kind: 'network',
        message: '企业微信推送通道连接失败',
        detail: this.#redact(error instanceof Error ? error.message : String(error)),
      });
      this.#log({
        level: 'error',
        event: 'notify_request_failed',
        error_code: networkError.code,
        duration_ms: Date.now() - startedAt,
        endpoint: this.endpoint,
      });
      throw networkError;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 写一条脱敏日志 */
  #log(record: Omit<NotifyLogRecord, 'timestamp' | 'channel'>): void {
    this.#logger({ timestamp: new Date().toISOString(), channel: 'notify', ...record });
  }
}

/** 推送默认超时（毫秒） */
export const DEFAULT_NOTIFY_TIMEOUT_MS = 5_000;

/* ── 推送台账（notify_delivery） ── */

/** 推送台账行的状态 */
export const NOTIFY_DELIVERY_STATUS = {
  /** 已推送 */
  sent: 'sent',
  /** 推送失败 */
  failed: 'failed',
  /** 未推送（本批无异常） */
  skipped: 'skipped',
} as const;

export type NotifyDeliveryStatus =
  (typeof NOTIFY_DELIVERY_STATUS)[keyof typeof NOTIFY_DELIVERY_STATUS];

export interface NotifyDeliveryRow {
  batch_key: string;
  operation_no: string | null;
  status: NotifyDeliveryStatus;
  error_code: string | null;
  detail: string | null;
  created_at: string;
}

/** 按批次键查推送记录 */
export function findNotifyDelivery(
  db: DatabaseSync,
  batch_key: string,
): NotifyDeliveryRow | undefined {
  return db
    .prepare(
      `SELECT batch_key, operation_no, status, error_code, detail, created_at
         FROM notify_delivery WHERE batch_key = ?`,
    )
    .get(batch_key) as unknown as NotifyDeliveryRow | undefined;
}

/** 写一行推送记录 */
export function recordNotifyDelivery(
  db: DatabaseSync,
  row: {
    batch_key: string;
    operation_no?: string | null;
    status: NotifyDeliveryStatus;
    error_code?: string | null;
    detail?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO notify_delivery (batch_key, operation_no, status, error_code, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(batch_key) DO UPDATE SET
       status = excluded.status,
       error_code = excluded.error_code,
       detail = excluded.detail,
       created_at = excluded.created_at`,
  ).run(
    row.batch_key,
    row.operation_no ?? null,
    row.status,
    row.error_code ?? null,
    row.detail ?? null,
    new Date().toISOString(),
  );
}

/** 推送失败计数（doctor 展示用） */
export function countNotifyFailures(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM notify_delivery WHERE status = 'failed'")
    .get() as { n: number };
  return row.n;
}

/** 推送失败清单（供后续人工补推 / 排障） */
export function listFailedDeliveries(db: DatabaseSync, limit = 50): NotifyDeliveryRow[] {
  return db
    .prepare(
      `SELECT batch_key, operation_no, status, error_code, detail, created_at
         FROM notify_delivery WHERE status = 'failed'
        ORDER BY created_at ASC LIMIT ?`,
    )
    .all(limit) as unknown as NotifyDeliveryRow[];
}

/* ── 批次摘要推送 ── */

/**
 * 事务包装：推送台账行 + 审计行同事务提交或同事务回滚。
 * 已经在事务里（外层已开）就复用外层事务，不重复 BEGIN。
 */
function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始异常：失败不静默改数据
    }
    throw error;
  }
}

/** 把任意异常归一成 NotifyError */
function toNotifyError(error: unknown): NotifyError {
  if (error instanceof NotifyError) return error;
  return new NotifyError({
    kind: 'internal',
    message: '企业微信推送内部异常',
    detail: error instanceof Error ? error.message : String(error),
  });
}

/**
 * 推一条批次摘要。
 *
 * 顺序：**节流判断 → 推送 → 记账**。
 *   ① 无异常批次默认不推（`onlyAbnormal`，默认 true）；
 *   ② 同一批次最多推一条（批次键已存在 → 跳过）；
 *   ③ 推送失败被捕获：失败计数写进审计链（`notify_batch_failed`），
 *      **不抛到主流程**，台账落库与核查条目一行都不受影响。
 *
 * 本函数**永不抛异常**：推送是通知，不是业务状态推进的主路。
 */
export async function sendBatchSummary(
  db: DatabaseSync,
  client: WeComBotClient,
  summary: NotifySummary,
  options: NotifyOptions = {},
): Promise<NotifyOutcome> {
  const batchKey =
    (summary.batch_key ?? '').trim() || deriveBatchKey(summary);
  const onlyAbnormal = options.onlyAbnormal !== false;
  const ignoreDuplicateScan = options.ignoreDuplicateScan !== false;

  const exceptions = (
    ignoreDuplicateScan
      ? summary.exceptions.filter((exception) => exception.reason_code !== REASON_DUPLICATE_SCAN)
      : summary.exceptions
  ).filter((exception) => Boolean(exception.reason_code));

  // ① 同一批次最多推一条：批次键已存在就不再推第二遍
  //    （失败过的批次可由运维显式放行重推，见 retryFailed）
  const existing = findNotifyDelivery(db, batchKey);
  const canRetryFailed =
    options.retryFailed === true && existing?.status === NOTIFY_DELIVERY_STATUS.failed;
  if (existing && !canRetryFailed) {
    return {
      sent: false,
      result: 'skipped',
      skipped:
        existing.status === NOTIFY_DELIVERY_STATUS.skipped ? 'no_exception' : 'duplicate_batch',
      batch_key: batchKey,
      exception_count: exceptions.length,
    };
  }

  // ② 无异常批次不推：避免打扰手术室
  if (onlyAbnormal && exceptions.length === 0) {
    withTransaction(db, () => {
      recordNotifyDelivery(db, {
        batch_key: batchKey,
        operation_no: summary.operation_no,
        status: NOTIFY_DELIVERY_STATUS.skipped,
        detail: '本批无异常，按默认策略未推送',
      });
    });
    return {
      sent: false,
      result: 'skipped',
      skipped: 'no_exception',
      batch_key: batchKey,
      exception_count: 0,
    };
  }

  // ③ 推送；失败不阻塞台账落库
  const message = buildBatchSummaryMessage({ ...summary, exceptions }, options);
  try {
    await client.postMessage(message);
    withTransaction(db, () => {
      recordNotifyDelivery(db, {
        batch_key: batchKey,
        operation_no: summary.operation_no,
        status: NOTIFY_DELIVERY_STATUS.sent,
        detail: `已推送 ${exceptions.length} 条异常`,
      });
      appendAudit(db, {
        event_type: 'notify_batch_sent',
        operation_no: summary.operation_no,
        actor: 'notify',
        detail: JSON.stringify({
          batch_key: batchKey,
          total: summary.total,
          accepted: summary.accepted,
          rejected: summary.rejected,
          exception_count: exceptions.length,
        }),
      });
    });
    return {
      sent: true,
      result: 'sent',
      skipped: null,
      batch_key: batchKey,
      exception_count: exceptions.length,
    };
  } catch (error) {
    const notifyError = toNotifyError(error);
    withTransaction(db, () => {
      recordNotifyDelivery(db, {
        batch_key: batchKey,
        operation_no: summary.operation_no,
        status: NOTIFY_DELIVERY_STATUS.failed,
        error_code: notifyError.code,
        detail: notifyError.message,
      });
      appendAudit(db, {
        event_type: 'notify_batch_failed',
        operation_no: summary.operation_no,
        actor: 'notify',
        detail: JSON.stringify({
          batch_key: batchKey,
          error_code: notifyError.code,
          message: notifyError.message,
          status: notifyError.status,
          channel_reachable: notifyError.channelReachable,
          retryable: notifyError.retryable,
          total: summary.total,
          accepted: summary.accepted,
          rejected: summary.rejected,
          exception_count: exceptions.length,
        }),
      });
    });
    return {
      sent: false,
      result: 'failed',
      skipped: null,
      batch_key: batchKey,
      error_code: notifyError.code,
      message: notifyError.message,
      exception_count: exceptions.length,
    };
  }
}

/**
 * 用配置装配一个企微客户端（凭据齐否由 env 层保证 fail closed）。
 *
 * 凭据只在 notify 层读取：`WECOM_WEBHOOK_URL` / `WECOM_SECRET`。
 */
export function createWeComClient(options: {
  webhookUrl: string;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  logger?: NotifyLogger;
  nowMs?: () => number;
}): WeComBotClient {
  return new WeComBotClient(options);
}
