/**
 * 凭据位集中解析：入站（扫码网关）/ 出站（HIS 计费）/ 推送（企业微信）三路。
 *
 * 语义来源（源产品主路径）：源产品在服务入口用 `requiredVars` 逐项检查环境变量，
 * 缺失即打印变量名并 `process.exit(1)` —— 缺位 = 拒绝启动，绝不带着空凭据继续跑。
 * 本模块把这条语义改写成**三条独立的路**：缺某一路的凭据只让该路不可用，
 * 其余两路不受影响；但该路一旦被要求就必须 fail closed 并指名变量。
 *
 * 凭据一律来自环境变量，不落配置文件、不硬编码、日志里只报「齐否」不报明文。
 */

import { readFileSync } from 'node:fs';

import {
  CONFIGURABLE_IDEMPOTENCY_KEY_PROFILES,
  DEFAULT_IDEMPOTENCY_KEY_PROFILE,
  isConfigurableKeyProfile,
  type ConfigurableIdempotencyKeyProfile,
} from '../domain/idempotency.js';

export type Channel = 'inbound' | 'outbound' | 'notify';

export type EnvSnapshot = Record<string, string | undefined>;

export interface InboundConfig {
  channel: 'inbound';
  /** 扫码事件服务基址（本进程作为服务接收事件） */
  baseUrl: string;
  /** 设备侧调用入站接口时携带的 Bearer 令牌 */
  token: string;
  /** 入站请求体 HMAC-SHA256 签名密钥 */
  secret: string;
}

export interface OutboundConfig {
  channel: 'outbound';
  /** HIS 计费服务基址 */
  baseUrl: string;
  /** 出站 Bearer 令牌（只在出站客户端盖章，业务层拿不到明文） */
  token: string;
}

export interface NotifyConfig {
  channel: 'notify';
  /** 企业微信机器人 webhook */
  webhookUrl: string;
  /** 企微签名密钥 */
  secret: string;
}

export type ChannelConfig = InboundConfig | OutboundConfig | NotifyConfig;

/** 每一路的必填变量（缺任一 → 该路不可用） */
export const CHANNEL_REQUIREMENTS: Readonly<Record<Channel, readonly string[]>> = {
  inbound: ['OR_SCANNER_BASE_URL', 'OR_SCANNER_TOKEN', 'OR_SCANNER_SECRET'],
  outbound: ['HIS_CHARGING_BASE_URL', 'HIS_CHARGING_TOKEN'],
  notify: ['WECOM_WEBHOOK_URL', 'WECOM_SECRET'],
};

/** 供 doctor / 日志展示的路名（中文业务语汇，不是工程黑话） */
export const CHANNEL_LABELS: Readonly<Record<Channel, string>> = {
  inbound: '入站扫码网关',
  outbound: '出站 HIS 计费',
  notify: '企业微信推送',
};

export class MissingCredentialError extends Error {
  readonly code = 'ERR_MISSING_CREDENTIAL';

  constructor(
    readonly channel: Channel,
    readonly missingVars: readonly string[],
  ) {
    super(missingCredentialMessage(channel, missingVars));
    this.name = 'MissingCredentialError';
  }
}

/**
 * 配置项取值非法（**启动即报错**，不带着错配置继续跑）。
 *
 * 幂等键档位（IDEMPOTENCY_KEY_PROFILE）非法时必须在这里挡住：
 * 档位决定「同一耗材同一台次算几笔」，配错了就是重复计费或多计费，
 * 不能靠默认值兜底 —— 默认值只在**没配**的时候用。
 */
export class InvalidConfigError extends Error {
  readonly code = 'ERR_INVALID_CONFIG';

  constructor(
    readonly variable: string,
    readonly value: string,
    readonly allowed: readonly string[],
  ) {
    super(
      `Invalid value for environment variable ${variable}: ${value}（允许取值：${allowed.join(' / ')}）`,
    );
    this.name = 'InvalidConfigError';
  }
}

/**
 * 读幂等键档位（IDEMPOTENCY_KEY_PROFILE）。
 *
 * 没配 → 默认 v1；配了但不在 v1 / v2 里 → 抛 InvalidConfigError 并指名变量名。
 * legacy 档位不给选：程序不再新写历史格式的键，历史行由迁移认领。
 */
export function readIdempotencyKeyProfile(
  env: EnvSnapshot = process.env,
): ConfigurableIdempotencyKeyProfile {
  const raw = (env['IDEMPOTENCY_KEY_PROFILE'] ?? '').trim();
  if (!raw) return DEFAULT_IDEMPOTENCY_KEY_PROFILE;
  if (!isConfigurableKeyProfile(raw)) {
    throw new InvalidConfigError('IDEMPOTENCY_KEY_PROFILE', raw, CONFIGURABLE_IDEMPOTENCY_KEY_PROFILES);
  }
  return raw;
}

/** 缺凭据提示：逐个变量点名，与源产品「Missing required environment variable: X」同格式 */
export function missingCredentialMessage(channel: Channel, vars: readonly string[]): string {
  const lines = vars.map((v) => `Missing required environment variable: ${v}`);
  lines.push(`channel: ${channel} / ${CHANNEL_LABELS[channel]}`);
  return lines.join('\n');
}

function hasValue(v: string | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 解析 KEY=VALUE 形式的 .env 文本（注释、空行、引号包裹的值都处理） */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** 读 .env 文件；文件不存在时返回空表（不抛错，缺文件不等于缺凭据） */
export function loadEnvFile(path: string): Record<string, string> {
  try {
    return parseDotEnv(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 合并环境变量：进程环境优先于 .env 文件。
 * 真实部署走 systemd EnvironmentFile / 容器 env_file，本地开发才用 .env。
 */
export function resolveEnv(options: { envFile?: string; source?: EnvSnapshot } = {}): EnvSnapshot {
  const source = options.source ?? process.env;
  const merged: EnvSnapshot = { ...(options.envFile ? loadEnvFile(options.envFile) : {}) };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export interface ChannelStatus {
  channel: Channel;
  /** 凭据位是否齐 */
  ready: boolean;
  /** 缺哪些变量名（只报名字，不报值） */
  missing: string[];
}

/** 体检某一路的凭据位：只报齐否与变量名，绝不返回明文 */
export function channelStatus(channel: Channel, env: EnvSnapshot = process.env): ChannelStatus {
  const missing = CHANNEL_REQUIREMENTS[channel].filter((name) => !hasValue(env[name]));
  return { channel, ready: missing.length === 0, missing };
}

/** 三路体检一起做，供 doctor 逐路展示 */
export function allChannelStatus(env: EnvSnapshot = process.env): ChannelStatus[] {
  return (['inbound', 'outbound', 'notify'] as const).map((c) => channelStatus(c, env));
}

/** 取某一路凭据；缺位即抛错并指名变量（fail closed） */
export function requireChannel(channel: Channel, env: EnvSnapshot = process.env): ChannelConfig {
  const status = channelStatus(channel, env);
  if (!status.ready) throw new MissingCredentialError(channel, status.missing);
  const get = (name: string): string => (env[name] as string).trim();
  switch (channel) {
    case 'inbound':
      return {
        channel: 'inbound',
        baseUrl: get('OR_SCANNER_BASE_URL'),
        token: get('OR_SCANNER_TOKEN'),
        secret: get('OR_SCANNER_SECRET'),
      };
    case 'outbound':
      return {
        channel: 'outbound',
        baseUrl: get('HIS_CHARGING_BASE_URL'),
        token: get('HIS_CHARGING_TOKEN'),
      };
    case 'notify':
      return {
        channel: 'notify',
        webhookUrl: get('WECOM_WEBHOOK_URL'),
        secret: get('WECOM_SECRET'),
      };
  }
}

/**
 * 启动自检：任一路缺位即打印变量名并非零退出（源产品 requiredVars 语义）。
 * 只在进程真正退出时调用，单元测试用 requireChannel 断言异常。
 */
export function runStartupCheck(channels: readonly Channel[], env: EnvSnapshot = process.env): void {
  const broken: ChannelStatus[] = [];
  for (const channel of channels) {
    const status = channelStatus(channel, env);
    if (!status.ready) broken.push(status);
  }
  if (broken.length === 0) return;
  for (const status of broken) {
    for (const name of status.missing) {
      console.error(`Missing required environment variable: ${name}`);
    }
    console.error(`channel: ${status.channel} / ${CHANNEL_LABELS[status.channel]}`);
  }
  process.exit(1);
}

export interface Settings {
  /** 台账 SQLite 文件路径 */
  ledgerDbPath: string;
  /** RFID 网关目录投递箱 */
  scanInboxDir: string;
  /** 入站 HTTP 监听端口 */
  httpPort: number;
  /** 出站计费端点路径（基址在凭据位里，路径在这里；产品代码不硬编码） */
  chargeMaterialUsesPath: string;
  /** 出站计费请求超时（毫秒） */
  chargeTimeoutMs: number;
  /** 出站计费**连接**超时（毫秒）：TCP 建连 + TLS 握手的预算 */
  chargeConnectTimeoutMs: number;
  /** 出站计费响应超时**放大后的上限**（毫秒）：批次越大等得久，但封顶 */
  chargeMaxResponseTimeoutMs: number;
  /** 熔断阈值：连续多少次通道级失败后短路 */
  chargeCircuitFailureThreshold: number;
  /** 熔断冷却时长（毫秒）：短路后多久放一次探测 */
  chargeCircuitCooldownMs: number;
  /** 出站连接池保活时长（毫秒）：keep-alive 连接多久不用就回收 */
  chargeKeepAliveMs: number;
  /** 出站连接池最大并发连接数 */
  chargeMaxSockets: number;
  /** 单次计费请求的条目数上限（对端限批；超限按批切分，逐批独立结算） */
  chargeMaxBatchSize: number;
  /** 台账忙等超时（毫秒）：并发写撞上时等一会儿再报错 */
  ledgerBusyTimeoutMs: number;
  /** 单事务批量提交的条目上限：超过就按批切分（每批一个事务） */
  ledgerBatchSize: number;
  /**
   * 入站时间戳容差窗口（秒）：超过这个差就按「过期」拒（默认 300）。
   *
   * 这是重放防护的第一层：抓到的报文隔一会儿再放，签名已经过期。
   */
  scannerTimestampToleranceSec: number;
  /**
   * 入站 nonce 存活时长（秒）：默认 600。
   *
   * 同一个 nonce 在这个时长内第二次出现 = 按重放拒（401）。
   * 设备侧**重试必须换新 nonce** —— 换 nonce 换戳才进得来，
   * 但进来之后同码同台次仍被幂等键拦下，不会产生第二行台账。
   */
  scannerNonceTtlSec: number;
  /** nonce 过期记录的清理周期（毫秒）：多久扫一次 */
  scannerNonceCleanupIntervalMs: number;
  /** 幂等键档位：v1 = 同码同台次只算一次；v2 = 同码同台次按批号各算一次 */
  idempotencyKeyProfile: ConfigurableIdempotencyKeyProfile;
  /**
   * 排台台次 CSV 路径（主数据热更新的观察对象；空串 = 不观察这一侧）。
   *
   * 配了就**自动热更新**：文件一变就重导一次，判定立刻按新值走，**不重启守护进程**。
   */
  masterDataOperationsCsv: string;
  /**
   * 耗材主数据 CSV 路径（主数据热更新的观察对象；空串 = 不观察这一侧）。
   */
  masterDataMaterialsCsv: string;
  /** 主数据热更新的检查间隔（毫秒）：多久看一次文件有没有变 */
  masterDataReloadIntervalMs: number;
  /**
   * 主数据 CSV 的编码策略（auto = UTF-8 与 GBK 里择优；utf-8 / gbk = 锁死一种）。
   *
   * 老系统导出的耗材主数据常是 GBK，新系统是 UTF-8 —— 两边混在同一台机器上时，
   * 靠这一项决定怎么解；解不出来时**保留原始字节并报错**，不做替换字符糊弄。
   */
  masterDataEncoding: MasterDataEncoding;
  /**
   * 企业微信批次摘要的**聚合窗口**（毫秒）。
   *
   * 同一台次的异常在这个窗口内合并成一条消息（默认 30000，即 30 秒）：
   * 一台手术扫十几次耗材，群里只说一条，不刷屏。
   */
  notifyAggregationWindowMs: number;
  /**
   * 事件日志保留期（天）：比这更旧的事件行清掉（默认 30）。
   *
   * 事件日志是排查问题的一手材料，但常驻进程每天都在收 ——
   * 不设上限的话表会无限长，把同块磁盘上的业务数据挤掉。
   */
  eventLogRetentionDays: number;
  /** 事件日志最大行数（行）：超了就按最旧清到上限（默认 100000） */
  eventLogMaxRows: number;
  /** 事件日志清理周期（毫秒）：多久跑一次保留策略（默认 1 小时） */
  eventLogCleanupIntervalMs: number;
}

/** 出站端点路径默认值（可由 HIS_CHARGING_MATERIAL_USES_PATH 覆盖） */
export const DEFAULT_CHARGE_MATERIAL_USES_PATH = '/api/v1/material-uses';

/** 出站超时默认值（毫秒） */
export const DEFAULT_CHARGE_TIMEOUT_MS = 10_000;

/** 出站连接超时默认值（毫秒）：TCP 建连 + TLS 握手的预算 */
export const DEFAULT_CHARGE_CONNECT_TIMEOUT_MS = 5_000;

/** 出站响应超时放大后的上限默认值（毫秒） */
export const DEFAULT_CHARGE_MAX_RESPONSE_TIMEOUT_MS = 60_000;

/** 熔断阈值默认值（连续失败次数） */
export const DEFAULT_CHARGE_CIRCUIT_FAILURE_THRESHOLD = 5;

/** 熔断冷却默认值（毫秒） */
export const DEFAULT_CHARGE_CIRCUIT_COOLDOWN_MS = 30_000;

/** 出站连接池保活默认值（毫秒） */
export const DEFAULT_CHARGE_KEEP_ALIVE_MS = 30_000;

/** 出站连接池最大并发连接默认值 */
export const DEFAULT_CHARGE_MAX_SOCKETS = 16;

/** 单次计费请求条目数上限默认值（条）：对端限批，超限按批切分 */
export const DEFAULT_CHARGE_MAX_BATCH_SIZE = 100;

/** 台账忙等超时默认值（毫秒） */
export const DEFAULT_LEDGER_BUSY_TIMEOUT_MS = 5_000;

/** 单事务批量提交条目上限默认值（条） */
export const DEFAULT_LEDGER_BATCH_SIZE = 200;

/** 入站时间戳容差窗口默认值（秒） */
export const DEFAULT_SCANNER_TIMESTAMP_TOLERANCE_SEC = 300;

/** 入站 nonce 存活时长默认值（秒） */
export const DEFAULT_SCANNER_NONCE_TTL_SEC = 600;

/** 入站 nonce 过期记录清理周期默认值（毫秒） */
export const DEFAULT_SCANNER_NONCE_CLEANUP_INTERVAL_MS = 60_000;

/** 主数据热更新检查间隔默认值（毫秒） */
export const DEFAULT_MASTER_DATA_RELOAD_INTERVAL_MS = 30_000;

/** 企业微信批次摘要聚合窗口默认值（毫秒）：同一台次的异常合并成一条消息 */
export const DEFAULT_NOTIFY_AGGREGATION_WINDOW_MS = 30_000;

/** 事件日志保留期默认值（天）：比这更旧的事件行清掉 */
export const DEFAULT_EVENT_LOG_RETENTION_DAYS = 30;

/** 事件日志最大行数默认值（行）：超了就按最旧清到上限 */
export const DEFAULT_EVENT_LOG_MAX_ROWS = 100_000;

/** 事件日志清理周期默认值（毫秒）：多久跑一次保留策略 */
export const DEFAULT_EVENT_LOG_CLEANUP_INTERVAL_MS = 3_600_000;

/**
 * 主数据 CSV 的编码策略取值。
 *
 * `auto`（默认）= 按可读性择优：先试 UTF-8、再试 GBK，两个都能解时看哪个更像
 * 「院内的中文业务数据」（中文多、解错字符少的那个）；
 * `utf-8` / `gbk` = 只认这一种（老系统导出固定 GBK 时可以锁死，避免误判）。
 */
export const MASTER_DATA_ENCODING_STRATEGIES = ['auto', 'utf-8', 'gbk'] as const;

/** 主数据编码策略类型 */
export type MasterDataEncoding = (typeof MASTER_DATA_ENCODING_STRATEGIES)[number];

/** 主数据编码策略默认值 */
export const DEFAULT_MASTER_DATA_ENCODING: MasterDataEncoding = 'auto';

/**
 * 读主数据编码策略（MASTER_DATA_ENCODING）。
 *
 * 没配 → 默认 auto；配了但不在允许取值里 → 抛 InvalidConfigError 并指名变量名。
 * 配错的后果是「整份主数据解不出来」，不能在运行期才炸 —— 启动即报错。
 */
export function readMasterDataEncoding(env: EnvSnapshot = process.env): MasterDataEncoding {
  const raw = (env['MASTER_DATA_ENCODING'] ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_MASTER_DATA_ENCODING;
  if (!(MASTER_DATA_ENCODING_STRATEGIES as readonly string[]).includes(raw)) {
    throw new InvalidConfigError('MASTER_DATA_ENCODING', raw, MASTER_DATA_ENCODING_STRATEGIES);
  }
  return raw as MasterDataEncoding;
}

/** 非凭据位的运行参数（有默认值，不属于必填） */
export function readSettings(env: EnvSnapshot = process.env): Settings {
  const port = Number.parseInt((env.HTTP_PORT ?? '').trim(), 10);
  const timeout = Number.parseInt((env.HIS_CHARGING_TIMEOUT_MS ?? '').trim(), 10);
  const connectTimeout = Number.parseInt((env.HIS_CHARGING_CONNECT_TIMEOUT_MS ?? '').trim(), 10);
  const maxResponseTimeout = Number.parseInt(
    (env.HIS_CHARGING_MAX_RESPONSE_TIMEOUT_MS ?? '').trim(),
    10,
  );
  const circuitThreshold = Number.parseInt(
    (env.HIS_CHARGING_CIRCUIT_FAILURE_THRESHOLD ?? '').trim(),
    10,
  );
  const circuitCooldown = Number.parseInt(
    (env.HIS_CHARGING_CIRCUIT_COOLDOWN_MS ?? '').trim(),
    10,
  );
  const keepAlive = Number.parseInt((env.HIS_CHARGING_KEEP_ALIVE_MS ?? '').trim(), 10);
  const maxSockets = Number.parseInt((env.HIS_CHARGING_MAX_SOCKETS ?? '').trim(), 10);
  const maxBatchSize = Number.parseInt((env.HIS_CHARGING_MAX_BATCH_SIZE ?? '').trim(), 10);
  const busyTimeout = Number.parseInt((env.LEDGER_BUSY_TIMEOUT_MS ?? '').trim(), 10);
  const batchSize = Number.parseInt((env.LEDGER_BATCH_SIZE ?? '').trim(), 10);
  const toleranceSec = Number.parseInt((env.SCANNER_TIMESTAMP_TOLERANCE_SEC ?? '').trim(), 10);
  const nonceTtlSec = Number.parseInt((env.SCANNER_NONCE_TTL_SEC ?? '').trim(), 10);
  const nonceCleanup = Number.parseInt((env.SCANNER_NONCE_CLEANUP_INTERVAL_MS ?? '').trim(), 10);
  const reloadInterval = Number.parseInt((env.MASTER_DATA_RELOAD_INTERVAL_MS ?? '').trim(), 10);
  const notifyWindow = Number.parseInt((env.NOTIFY_AGGREGATION_WINDOW_MS ?? '').trim(), 10);
  const retentionDays = Number.parseInt((env.EVENT_LOG_RETENTION_DAYS ?? '').trim(), 10);
  const maxEventRows = Number.parseInt((env.EVENT_LOG_MAX_ROWS ?? '').trim(), 10);
  const eventCleanupInterval = Number.parseInt(
    (env.EVENT_LOG_CLEANUP_INTERVAL_MS ?? '').trim(),
    10,
  );
  return {
    ledgerDbPath: (env.LEDGER_DB_PATH ?? '').trim() || 'data/ledger.db',
    scanInboxDir: (env.SCAN_INBOX_DIR ?? '').trim() || 'scan-inbox',
    httpPort: Number.isFinite(port) && port > 0 ? port : 8099,
    chargeMaterialUsesPath:
      (env.HIS_CHARGING_MATERIAL_USES_PATH ?? '').trim() || DEFAULT_CHARGE_MATERIAL_USES_PATH,
    chargeTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CHARGE_TIMEOUT_MS,
    chargeConnectTimeoutMs:
      Number.isFinite(connectTimeout) && connectTimeout > 0
        ? connectTimeout
        : DEFAULT_CHARGE_CONNECT_TIMEOUT_MS,
    chargeMaxResponseTimeoutMs:
      Number.isFinite(maxResponseTimeout) && maxResponseTimeout > 0
        ? maxResponseTimeout
        : DEFAULT_CHARGE_MAX_RESPONSE_TIMEOUT_MS,
    chargeCircuitFailureThreshold:
      Number.isInteger(circuitThreshold) && circuitThreshold > 0
        ? circuitThreshold
        : DEFAULT_CHARGE_CIRCUIT_FAILURE_THRESHOLD,
    chargeCircuitCooldownMs:
      Number.isFinite(circuitCooldown) && circuitCooldown > 0
        ? circuitCooldown
        : DEFAULT_CHARGE_CIRCUIT_COOLDOWN_MS,
    chargeKeepAliveMs:
      Number.isFinite(keepAlive) && keepAlive > 0 ? keepAlive : DEFAULT_CHARGE_KEEP_ALIVE_MS,
    chargeMaxSockets:
      Number.isInteger(maxSockets) && maxSockets > 0 ? maxSockets : DEFAULT_CHARGE_MAX_SOCKETS,
    chargeMaxBatchSize:
      Number.isFinite(maxBatchSize) && maxBatchSize > 0 ? maxBatchSize : DEFAULT_CHARGE_MAX_BATCH_SIZE,
    ledgerBusyTimeoutMs:
      Number.isFinite(busyTimeout) && busyTimeout > 0 ? busyTimeout : DEFAULT_LEDGER_BUSY_TIMEOUT_MS,
    ledgerBatchSize:
      Number.isFinite(batchSize) && batchSize > 0 ? batchSize : DEFAULT_LEDGER_BATCH_SIZE,
    scannerTimestampToleranceSec:
      Number.isFinite(toleranceSec) && toleranceSec > 0
        ? toleranceSec
        : DEFAULT_SCANNER_TIMESTAMP_TOLERANCE_SEC,
    scannerNonceTtlSec:
      Number.isFinite(nonceTtlSec) && nonceTtlSec > 0 ? nonceTtlSec : DEFAULT_SCANNER_NONCE_TTL_SEC,
    scannerNonceCleanupIntervalMs:
      Number.isFinite(nonceCleanup) && nonceCleanup > 0
        ? nonceCleanup
        : DEFAULT_SCANNER_NONCE_CLEANUP_INTERVAL_MS,
    idempotencyKeyProfile: readIdempotencyKeyProfile(env),
    masterDataOperationsCsv: (env.MASTER_DATA_OPERATIONS_CSV ?? '').trim(),
    masterDataMaterialsCsv: (env.MASTER_DATA_MATERIALS_CSV ?? '').trim(),
    masterDataReloadIntervalMs:
      Number.isFinite(reloadInterval) && reloadInterval > 0
        ? reloadInterval
        : DEFAULT_MASTER_DATA_RELOAD_INTERVAL_MS,
    masterDataEncoding: readMasterDataEncoding(env),
    notifyAggregationWindowMs:
      Number.isFinite(notifyWindow) && notifyWindow > 0
        ? notifyWindow
        : DEFAULT_NOTIFY_AGGREGATION_WINDOW_MS,
    eventLogRetentionDays:
      Number.isFinite(retentionDays) && retentionDays > 0
        ? retentionDays
        : DEFAULT_EVENT_LOG_RETENTION_DAYS,
    eventLogMaxRows:
      Number.isInteger(maxEventRows) && maxEventRows > 0
        ? maxEventRows
        : DEFAULT_EVENT_LOG_MAX_ROWS,
    eventLogCleanupIntervalMs:
      Number.isFinite(eventCleanupInterval) && eventCleanupInterval > 0
        ? eventCleanupInterval
        : DEFAULT_EVENT_LOG_CLEANUP_INTERVAL_MS,
  };
}

/** 出站 HIS 计费的端点配置（凭据齐否由 requireChannel 保证 fail closed） */
export interface ChargeEndpointSettings {
  /** HIS 计费服务基址 */
  baseUrl: string;
  /** 出站 Bearer 令牌 */
  token: string;
  /** 端点路径 */
  materialUsesPath: string;
  /** 响应超时基数（毫秒）：批次越大按条目数放大 */
  timeoutMs: number;
  /** 连接超时（毫秒） */
  connectTimeoutMs: number;
  /** 响应超时放大后的上限（毫秒） */
  maxResponseTimeoutMs: number;
  /** 熔断阈值（连续失败次数） */
  circuitFailureThreshold: number;
  /** 熔断冷却时长（毫秒） */
  circuitCooldownMs: number;
  /** 连接池保活时长（毫秒） */
  keepAliveMs: number;
  /** 连接池最大并发连接数 */
  maxSockets: number;
}

/**
 * 读取出站计费端点配置。
 *
 * 缺 HIS_CHARGING_BASE_URL / HIS_CHARGING_TOKEN → 抛 MissingCredentialError 并指名变量名
 * （该路拒绝启动），其余两路不受影响。
 */
export function readChargeEndpoint(env: EnvSnapshot = process.env): ChargeEndpointSettings {
  const outbound = requireChannel('outbound', env);
  if (outbound.channel !== 'outbound') {
    throw new MissingCredentialError('outbound', [...CHANNEL_REQUIREMENTS.outbound]);
  }
  const settings = readSettings(env);
  return {
    baseUrl: outbound.baseUrl,
    token: outbound.token,
    materialUsesPath: settings.chargeMaterialUsesPath,
    timeoutMs: settings.chargeTimeoutMs,
    connectTimeoutMs: settings.chargeConnectTimeoutMs,
    maxResponseTimeoutMs: settings.chargeMaxResponseTimeoutMs,
    circuitFailureThreshold: settings.chargeCircuitFailureThreshold,
    circuitCooldownMs: settings.chargeCircuitCooldownMs,
    keepAliveMs: settings.chargeKeepAliveMs,
    maxSockets: settings.chargeMaxSockets,
  };
}

/** 日志与异常里一律用这个打码，不落明文 */
export function redactSecret(value: string | undefined): string {
  if (!hasValue(value)) return '未配置';
  return `已配置（${(value as string).trim().length} 字符）`;
}
