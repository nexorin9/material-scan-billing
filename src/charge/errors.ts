/**
 * 出站失败分档：错误码表 + 异常类型。
 *
 * 为什么从 `client.ts` 拆出来：
 *   熔断器（`src/charge/circuit.ts`）也要抛**同一种**带错误码的异常 ——
 *   熔断打开时对业务层来说就是「通道不可达」，必须和超时、网络失败落在同一套
 *   错误码表里，回执、核查条目、日志展示的才是同一个码。
 *   拆成独立模块是为了避免 `client.ts ↔ circuit.ts` 的循环依赖。
 *
 * 语义来源（源产品主路径）：源产品把投递结果按**逐目标回执**返回，回执里带
 * `delivery_count`（投递次数）与 `active`（通道当时是否可达）—— **投了几次、
 * 当时通不通**这两件事在回执里必须看得见；单条投递失败是普通结果而非中断。
 * 本模块把「通道当时通不通」落成 `channelReachable`，把「值不值得再投」落成
 * `retryable`，两者共同决定这条耗材是进退避重投队列还是直接转人工核查。
 */

/** 出站错误码表（与 `docs/api/his-charging.md` 的错误码小节一致） */
export const CHARGE_ERROR_CODES = {
  /** 端点配置缺失或非法（未发出请求） */
  config: 'ERR_CHARGE_CONFIG',
  /** 请求体字段不合法（未发出请求） */
  requestInvalid: 'ERR_CHARGE_REQUEST_INVALID',
  /**
   * **字段契约不符**（未发出请求）。
   *
   * 与 `requestInvalid` 的分工：前者是「必填缺失 / 数量非正整数」这类**形状**问题，
   * 这一码是「字段名对、类型对，但取值越界」——枚举越界（如费用类别不在院内 14 类内）、
   * 长度超限、时间戳解析不了。两者都不外发、都不重投（重投一百次还是不合规）。
   */
  contractViolation: 'ERR_CHARGE_CONTRACT_VIOLATION',
  /**
   * **响应超时**（连接已建立，对端迟迟不给结论）。
   *
   * 历史码名沿用 `ERR_CHARGE_TIMEOUT`；连接阶段超时另用 `ERR_CHARGE_CONNECT_TIMEOUT`，
   * 两个阶段各有各的码 —— 信息科排障时「连不上」与「连上了但不回」是两回事。
   */
  timeout: 'ERR_CHARGE_TIMEOUT',
  /** **连接超时**（TCP 连接没建起来；通道不可达，可重投） */
  connectTimeout: 'ERR_CHARGE_CONNECT_TIMEOUT',
  /** **熔断打开**：连续失败达阈值，期间请求直接短路，不外发（可重投） */
  circuitOpen: 'ERR_CHARGE_CIRCUIT_OPEN',
  /** 连接失败 / DNS 失败（通道不可达，可重投） */
  network: 'ERR_CHARGE_NETWORK',
  /** 对端 5xx（通道可达，可重投） */
  serverError: 'ERR_CHARGE_HTTP_5XX',
  /** 对端 4xx（通道可达，不可重投） */
  clientError: 'ERR_CHARGE_HTTP_4XX',
  /** 响应体不是预期结构（可重投，不静默当成成功） */
  responseInvalid: 'ERR_CHARGE_RESPONSE_INVALID',
  /** 关键字段超出长度上限（未发出请求；**不截断后照发**） */
  fieldTooLong: 'ERR_CHARGE_FIELD_TOO_LONG',
} as const;

/** 出站失败分档 */
export type ChargeFailureKind =
  | 'config'
  | 'request_invalid'
  /** 字段契约不符（枚举越界 / 长度超限 / 时间戳不可解析） */
  | 'contract_violation'
  | 'field_too_long'
  /** 响应超时 */
  | 'timeout'
  /** 连接超时 */
  | 'connect_timeout'
  /** 熔断打开（未外发） */
  | 'circuit_open'
  | 'network'
  | 'server_error'
  | 'client_error'
  | 'response_invalid';

const KIND_CODES: Readonly<Record<ChargeFailureKind, string>> = {
  config: CHARGE_ERROR_CODES.config,
  request_invalid: CHARGE_ERROR_CODES.requestInvalid,
  contract_violation: CHARGE_ERROR_CODES.contractViolation,
  field_too_long: CHARGE_ERROR_CODES.fieldTooLong,
  timeout: CHARGE_ERROR_CODES.timeout,
  connect_timeout: CHARGE_ERROR_CODES.connectTimeout,
  circuit_open: CHARGE_ERROR_CODES.circuitOpen,
  network: CHARGE_ERROR_CODES.network,
  server_error: CHARGE_ERROR_CODES.serverError,
  client_error: CHARGE_ERROR_CODES.clientError,
  response_invalid: CHARGE_ERROR_CODES.responseInvalid,
};

/** 各失败档的默认处置：通道当时可达否 / 是否值得重投 */
const KIND_DEFAULTS: Readonly<
  Record<ChargeFailureKind, { channelReachable: boolean; retryable: boolean }>
> = {
  config: { channelReachable: false, retryable: false },
  request_invalid: { channelReachable: false, retryable: false },
  // 契约不符：重投多少次还是不合规 —— 不重投，转人工核查
  contract_violation: { channelReachable: false, retryable: false },
  field_too_long: { channelReachable: false, retryable: false },
  // 响应超时：连上了但对端没给结论 —— 通道当时不可达，值得重投
  timeout: { channelReachable: false, retryable: true },
  // 连接超时：连接都没建起来 —— 通道当时不可达，值得重投
  connect_timeout: { channelReachable: false, retryable: true },
  // 熔断打开：请求根本没发出去，通道当时不可达，值得重投（退避队列里等着）
  circuit_open: { channelReachable: false, retryable: true },
  network: { channelReachable: false, retryable: true },
  server_error: { channelReachable: true, retryable: true },
  client_error: { channelReachable: true, retryable: false },
  response_invalid: { channelReachable: true, retryable: true },
};

export interface ChargeErrorInit {
  kind: ChargeFailureKind;
  message: string;
  /** 对端状态码（若已收到响应） */
  status?: number | null;
  /** 通道当时是否可达（决定要不要进重投队列） */
  channelReachable?: boolean;
  /** 是否值得重投 */
  retryable?: boolean;
  /** 补充明细（已脱敏） */
  detail?: string | null;
}

/** 出站失败异常：带错误码、可达性与重投标记，供回执台账归类 */
export class ChargeError extends Error {
  readonly code: string;
  readonly kind: ChargeFailureKind;
  readonly status: number | null;
  readonly channelReachable: boolean;
  readonly retryable: boolean;
  readonly detail: string | null;

  constructor(init: ChargeErrorInit) {
    super(init.message);
    this.name = 'ChargeError';
    this.code = KIND_CODES[init.kind];
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.channelReachable = init.channelReachable ?? KIND_DEFAULTS[init.kind].channelReachable;
    this.retryable = init.retryable ?? KIND_DEFAULTS[init.kind].retryable;
    this.detail = init.detail ?? null;
  }
}
