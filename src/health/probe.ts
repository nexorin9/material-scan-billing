/**
 * 通道可达性**主动探测**：信息科排查故障时的第一个问题永远是「到底哪一路不通」。
 *
 * 现状（Task 12 的 doctor）能回答的是「**过去**发生过什么」：凭据位齐否、末次收到
 * 事件是什么时候、末次计费回写是什么时候、熔断在不在。这些数字全部从台账读，
 * 有一个前提 —— **这一路最近有业务流过**。手术室连着两小时没有扫码时，
 * 「末次成功时间」只能说明「停着」，说明不了「通不通」。
 *
 * 本模块补上「**此刻**通不通」：
 *   ① 出站 HIS 计费 —— 发一个**空批次**健康检查请求（`uses` 为空数组），
 *      读对端状态码。空批次不产生任何计费明细：探测完对端的计费台账里
 *      仍然一条耗材都没有 —— 这一点由测试逐条断言。
 *   ② 入站扫码 —— 监听端口在不在监听、验签密钥配没配、目录投递箱读不读得到 /
 *      写不写得进。
 *   ③ 企业微信推送 —— webhook 地址格式对不对、域名与端口通不通。
 *      **不发业务消息**：只做 DNS 解析与 TCP 连接，绝不往群里发测试消息。
 *
 * 三条硬约束：
 *   ① **凭据明文一律不出现** —— 探测结论只报齐否、变量名与错误码；
 *   ② **探测不改变业务状态** —— 不写台账、不写审计链、不产生计费明细；
 *   ③ **探测不打乱守护进程的状态** —— 探测用**独立的**出站客户端实例
 *      （自己的熔断器），doctor 的探测失败不会把在跑的守护进程熔断掉；
 *      守护进程自己的熔断档位由台账 meta 里的快照呈现，两件事互不干扰。
 *
 * 语义来源（源产品主路径）：源产品的连接是有生命周期的 —— 一条逻辑连接绑定
 * 一次执行，连接断了就是断了（`ConnectionError::Closed`），不会在坏连接上
 * 反复重试。本模块把这条语义落到体检面：**一次探测给一个结论**（通 / 不通 /
 * 被拒），不通就把错误码带出来，不在同一次体检里反复敲门。
 */

import { lookup } from 'node:dns/promises';
import { accessSync, constants as fsConstants } from 'node:fs';
import { connect } from 'node:net';

import {
  channelStatus,
  CHANNEL_LABELS,
  type Channel,
  type EnvSnapshot,
  type Settings,
} from '../config/env.js';
import { ChargeError, HisChargingClient } from '../charge/client.js';
import { describeErrorCode } from '../log/error-codes.js';

/** 探测结论档位 */
export type ProbeOutcome =
  /** 探测通过 */
  | 'ok'
  /** 通道不通：连不上 / 超时 / 对端 5xx */
  | 'unreachable'
  /** 通道是通的，但对端把这次探测拒了（4xx / 响应结构不符） */
  | 'rejected'
  /** 凭据不齐，未探测 */
  | 'skipped';

/** 一个检查项的结论（入站一路有三项：密钥 / 端口 / 目录） */
export interface ChannelProbeCheck {
  /** 检查项名（中文，给信息科看的） */
  name: string;
  /** 这一项过没过 */
  ok: boolean;
  /** 不过时的错误码（与统一错误码表同源） */
  error_code: string | null;
  /** 一句人话 */
  detail: string;
}

/** 一路通道的主动探测结论 */
export interface ChannelProbeResult {
  /** 通道标识 */
  channel: Channel;
  /** 中文业务标签 */
  label: string;
  /** 探测是否打通 */
  reachable: boolean;
  /** 结论档位 */
  outcome: ProbeOutcome;
  /** 对端状态码（没拿到响应时为 null） */
  status: number | null;
  /** 错误码（与统一错误码表同源） */
  error_code: string | null;
  /** 错误码的中文含义 */
  error_code_zh: string;
  /** 探测耗时（毫秒） */
  duration_ms: number;
  /** 探测时刻 */
  checked_at: string;
  /** 一句人话结论 */
  detail: string;
  /** 逐项检查结论 */
  checks: ChannelProbeCheck[];
}

/** 探测默认超时（毫秒）：比业务超时短 —— 体检不该把手术室拖住 */
export const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

/** 探测用出站客户端的熔断阈值：探测失败一次就断，不反复敲门 */
const PROBE_CIRCUIT_FAILURE_THRESHOLD = 1;

/** 探测用出站客户端的熔断冷却（毫秒） */
const PROBE_CIRCUIT_COOLDOWN_MS = 1_000;

/** 空批次健康检查的请求体：uses 为空数组 → 对端不应产生任何计费明细 */
export interface EmptyProbeBody {
  operation_no: string;
  dept_code: string;
  uses: never[];
}

/** 造一个空批次体检请求体（**不产生任何计费条目**） */
export function buildEmptyProbeBody(): EmptyProbeBody {
  return { operation_no: '', dept_code: '', uses: [] };
}

/** 探测入参 */
export interface ProbeOptions {
  /** 环境变量快照（凭据位从这儿读） */
  env: EnvSnapshot;
  /** 运行参数（端口、端点路径、超时） */
  settings: Settings;
  /** 探测超时（毫秒） */
  timeoutMs?: number;
}

/* ------------------------------------------------------------------ 结果组装 */

interface ResultInit {
  channel: Channel;
  outcome: ProbeOutcome;
  reachable: boolean;
  status?: number | null;
  errorCode?: string | null;
  detail: string;
  checks: ChannelProbeCheck[];
  startedAt: number;
  nowMs: number;
}

/** 组装一条探测结论（错误码的中文含义从统一错误码表取，查不到就不给含义） */
function buildResult(init: ResultInit): ChannelProbeResult {
  const errorCode = init.errorCode ?? null;
  return {
    channel: init.channel,
    label: CHANNEL_LABELS[init.channel],
    reachable: init.reachable,
    outcome: init.outcome,
    status: init.status ?? null,
    error_code: errorCode,
    error_code_zh: errorCode ? describeErrorCode(errorCode).meaning_zh : '',
    duration_ms: Math.max(0, init.nowMs - init.startedAt),
    checked_at: new Date(init.nowMs).toISOString(),
    detail: init.detail,
    checks: init.checks,
  };
}

/** 凭据不齐 → 本路不探测（**不是**「探测失败」，是「没资格探测」） */
function skippedResult(
  channel: Channel,
  missing: readonly string[],
  startedAt: number,
  nowMs: number,
): ChannelProbeResult {
  const detail = `凭据位不齐（缺 ${missing.join('、')}），本路未探测`;
  return buildResult({
    channel,
    outcome: 'skipped',
    reachable: false,
    errorCode: 'ERR_MISSING_CREDENTIAL',
    detail,
    checks: [
      {
        name: '凭据位齐否',
        ok: false,
        error_code: 'ERR_MISSING_CREDENTIAL',
        detail: `缺 ${missing.join('、')}`,
      },
    ],
    startedAt,
    nowMs,
  });
}

/* ------------------------------------------------------------------ 出站探测 */

/**
 * 出站 HIS 计费通道的主动探测：发一个**空批次**健康检查请求。
 *
 * 空批次的两个性质（测试逐条断言）：
 *   ① 请求体 `uses` 是空数组 → 对端**不产生任何计费明细**；
 *   ② 走的是**生产同一条** HTTP 代码路径（同一个 `HisChargingClient`、
 *      同一个 Bearer 盖章点、同一个超时与熔断口径）—— 探测通不通，
 *      真实计费就通不通。
 */
export async function probeOutboundCharge(options: ProbeOptions): Promise<ChannelProbeResult> {
  const startedAt = Date.now();
  const status = channelStatus('outbound', options.env);
  if (!status.ready) return skippedResult('outbound', status.missing, startedAt, Date.now());

  const baseUrl = (options.env['HIS_CHARGING_BASE_URL'] ?? '').trim();
  const token = (options.env['HIS_CHARGING_TOKEN'] ?? '').trim();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  // 独立客户端实例：doctor 是只读体检，探测失败不该把守护进程在跑的熔断打乱
  const client = new HisChargingClient({
    baseUrl,
    token,
    responseTimeoutMs: timeoutMs,
    connectTimeoutMs: Math.min(timeoutMs, options.settings.chargeConnectTimeoutMs),
    maxResponseTimeoutMs: timeoutMs,
    circuitFailureThreshold: PROBE_CIRCUIT_FAILURE_THRESHOLD,
    circuitCooldownMs: PROBE_CIRCUIT_COOLDOWN_MS,
    // 探测结论由本函数承载，不再往 stderr 写业务日志（体检不是业务流量）
    logger: () => {},
  });

  try {
    await client.postJson(options.settings.chargeMaterialUsesPath, buildEmptyProbeBody(), {
      itemCount: 0,
    });
    return buildResult({
      channel: 'outbound',
      outcome: 'ok',
      reachable: true,
      status: 200,
      detail: '空批次健康检查通过，对端可达且不产生计费明细',
      checks: [
        {
          name: '空批次健康检查',
          ok: true,
          error_code: null,
          detail: `POST ${options.settings.chargeMaterialUsesPath}（uses 为空数组）返回 2xx`,
        },
      ],
      startedAt,
      nowMs: Date.now(),
    });
  } catch (error) {
    if (!(error instanceof ChargeError)) {
      return buildResult({
        channel: 'outbound',
        outcome: 'unreachable',
        reachable: false,
        errorCode: 'ERR_INTERNAL',
        detail: `健康检查异常：${error instanceof Error ? error.message : String(error)}`,
        checks: [
          {
            name: '空批次健康检查',
            ok: false,
            error_code: 'ERR_INTERNAL',
            detail: '探测过程抛出未分类异常',
          },
        ],
        startedAt,
        nowMs: Date.now(),
      });
    }
    // 5xx = 通道不通（对端在报错）；4xx = 通道是通的但拒了这次探测
    const rejected = error.kind === 'client_error' || error.kind === 'response_invalid';
    return buildResult({
      channel: 'outbound',
      outcome: rejected ? 'rejected' : 'unreachable',
      reachable: error.kind === 'client_error' || error.kind === 'response_invalid',
      status: error.status,
      errorCode: error.code,
      detail: rejected
        ? `通道能连上，但对端拒了这次空批次健康检查：${error.message}`
        : `HIS 计费侧不可达：${error.message}`,
      checks: [
        {
          name: '空批次健康检查',
          ok: false,
          error_code: error.code,
          detail: error.message,
        },
      ],
      startedAt,
      nowMs: Date.now(),
    });
  } finally {
    client.destroy();
  }
}

/* ------------------------------------------------------------------ 入站探测 */

/** 探测入站监听端口时连哪个地址：绑了具体地址就连那个地址，否则连回环 */
function inboundProbeHost(env: EnvSnapshot): string {
  const configured = (env['DAEMON_HTTP_HOST'] ?? '').trim();
  if (configured.length === 0) return '127.0.0.1';
  if (configured === '0.0.0.0' || configured === '::' || configured === '[::]') return '127.0.0.1';
  return configured;
}

/** TCP 连一下：连得上就说明端口在监听 */
function canConnect(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host, port });
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, detail });
    };
    const timer = setTimeout(
      () => finish(false, `连接 ${host}:${port} 超时（${timeoutMs} 毫秒内没建连）`),
      timeoutMs,
    );
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      finish(true, `${host}:${port} 有进程在监听`);
    });
    socket.once('error', (error: Error) => {
      clearTimeout(timer);
      finish(false, `连不上 ${host}:${port}：${error.message}`);
    });
  });
}

/**
 * 入站扫码通道的主动探测：三个检查项各给一个结论。
 *
 *   ① 验签密钥配没配（**只报齐否**，不报值）；
 *   ② 监听端口在不在监听（TCP 连一下就知道）；
 *   ③ 目录投递箱读不读得到 / 写不写得进（RFID 网关那一路）。
 *
 * 与出站 / 推送两路不同：入站这三项检查**都是本机上的**，不依赖凭据位，
 * 所以即便凭据不齐也照样探 —— 「缺哪个变量名」本身就是一项要报出来的结论。
 */
export async function probeInboundListener(options: ProbeOptions): Promise<ChannelProbeResult> {
  const startedAt = Date.now();
  const status = channelStatus('inbound', options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const checks: ChannelProbeCheck[] = [];

  // ⓿ 凭据位齐否（只报变量名，不报值）
  checks.push({
    name: '凭据位齐否',
    ok: status.ready,
    error_code: status.ready ? null : 'ERR_MISSING_CREDENTIAL',
    detail: status.ready ? '齐备' : `缺 ${status.missing.join('、')}`,
  });

  // ① 验签密钥：只报齐否
  const secretReady = (options.env['OR_SCANNER_SECRET'] ?? '').trim().length > 0;
  checks.push({
    name: '验签密钥已配置',
    ok: secretReady,
    error_code: secretReady ? null : 'ERR_MISSING_SIGNATURE',
    detail: secretReady ? '已配置' : '未配置（扫码枪带签名来的会被判 401）',
  });

  // ② 监听端口
  const host = inboundProbeHost(options.env);
  const port = options.settings.httpPort;
  const portProbe = await canConnect(host, port, timeoutMs);
  checks.push({
    name: '监听端口在监听',
    ok: portProbe.ok,
    error_code: portProbe.ok ? null : 'ERR_INBOUND_PORT_NOT_LISTENING',
    detail: portProbe.detail,
  });

  // ③ 目录投递箱可读可写
  const inboxDir = options.settings.scanInboxDir;
  let dirOk = false;
  let dirDetail = `${inboxDir} 可读可写`;
  try {
    accessSync(inboxDir, fsConstants.R_OK | fsConstants.W_OK);
    dirOk = true;
  } catch (error) {
    dirOk = false;
    dirDetail = `目录投递箱不可读或不可写：${inboxDir}（${error instanceof Error ? error.message : String(error)}）`;
  }
  checks.push({
    name: '目录投递箱可读可写',
    ok: dirOk,
    error_code: dirOk ? null : 'ERR_SCAN_INBOX_NOT_WRITABLE',
    detail: dirDetail,
  });

  const failed = checks.filter((check) => !check.ok);
  const firstFailure = failed[0];
  return buildResult({
    channel: 'inbound',
    outcome: failed.length === 0 ? 'ok' : 'unreachable',
    reachable: portProbe.ok,
    errorCode: firstFailure?.error_code ?? null,
    detail:
      failed.length === 0
        ? '验签密钥已配、监听端口在监听、目录投递箱可读可写'
        : `入站有 ${failed.length} 项不通过：${failed.map((check) => check.name).join('、')}`,
    checks,
    startedAt,
    nowMs: Date.now(),
  });
}

/* ------------------------------------------------------------------ 推送探测 */

/** webhook 地址是否可用：必须是 https（回环地址放宽到 http），且带 key 参数 */
export function inspectWebhookUrl(
  raw: string | undefined,
): { ok: boolean; url: URL | null; host: string | null; port: number; loopback: boolean; reason: string } {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      url: null,
      host: null,
      port: 443,
      loopback: false,
      reason: '未配置（WECOM_WEBHOOK_URL 为空）',
    };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      url: null,
      host: null,
      port: 443,
      loopback: false,
      reason: '地址不是合法 URL',
    };
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return {
      ok: false,
      url,
      host: url.hostname,
      port: url.port ? Number(url.port) : 443,
      loopback,
      reason: `协议不支持（${url.protocol}，只接受 https；回环地址放宽到 http）`,
    };
  }
  if ((url.searchParams.get('key') ?? '').trim().length === 0) {
    return {
      ok: false,
      url,
      host: url.hostname,
      port: url.port ? Number(url.port) : 443,
      loopback,
      reason: '地址里没有 key 参数（企业微信机器人地址形如 .../send?key=...）',
    };
  }
  return {
    ok: true,
    url,
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443,
    loopback,
    reason: '地址格式正确',
  };
}

/**
 * 企业微信推送通道的主动探测：**只校验格式与连通性，不发真实业务消息**。
 *
 * 连通性检查走 DNS 解析 + TCP 连接 —— 连上就断开，**一个字节的业务消息都不发**，
 * 手术室的群里不会多出一条「测试」。测试用例会断言对端 HTTP 服务收到的请求数为 0。
 */
export async function probeNotifyEndpoint(options: ProbeOptions): Promise<ChannelProbeResult> {
  const startedAt = Date.now();
  const status = channelStatus('notify', options.env);
  if (!status.ready) return skippedResult('notify', status.missing, startedAt, Date.now());

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const inspected = inspectWebhookUrl(options.env['WECOM_WEBHOOK_URL']);
  const checks: ChannelProbeCheck[] = [
    {
      name: 'webhook 地址格式',
      ok: inspected.ok,
      error_code: inspected.ok ? null : 'ERR_NOTIFY_CONFIG',
      detail: inspected.reason,
    },
  ];

  if (!inspected.ok) {
    return buildResult({
      channel: 'notify',
      outcome: 'unreachable',
      reachable: false,
      errorCode: 'ERR_NOTIFY_CONFIG',
      detail: `企业微信推送地址不可用：${inspected.reason}`,
      checks,
      startedAt,
      nowMs: Date.now(),
    });
  }

  // 域名解析
  const host = inspected.host as string;
  let resolved: boolean;
  let resolveDetail: string;
  try {
    await lookup(host);
    resolved = true;
    resolveDetail = `${host} 解析正常`;
  } catch (error) {
    resolved = false;
    resolveDetail = `${host} 解析失败：${error instanceof Error ? error.message : String(error)}`;
  }
  checks.push({
    name: '域名解析',
    ok: resolved,
    error_code: resolved ? null : 'ERR_NOTIFY_NETWORK',
    detail: resolveDetail,
  });

  // 端口连通（只握手，不发业务消息）
  let connected = false;
  let connectDetail = `${host}:${inspected.port} 连得上`;
  if (resolved) {
    const probe = await canConnect(host, inspected.port, timeoutMs);
    connected = probe.ok;
    connectDetail = probe.detail;
  }
  checks.push({
    name: '端口连通',
    ok: connected,
    error_code: connected ? null : 'ERR_NOTIFY_NETWORK',
    detail: connectDetail,
  });

  const ok = resolved && connected;
  return buildResult({
    channel: 'notify',
    outcome: ok ? 'ok' : 'unreachable',
    reachable: ok,
    errorCode: ok ? null : 'ERR_NOTIFY_NETWORK',
    detail: ok
      ? 'webhook 地址格式正确、域名与端口都通（未发送任何业务消息）'
      : `企业微信推送不可达：${resolved ? connectDetail : resolveDetail}`,
    checks,
    startedAt,
    nowMs: Date.now(),
  });
}

/* ------------------------------------------------------------------ 汇总 */

/**
 * 三路一起探测。
 *
 * 逐路隔离：任何一路探测抛错都只让**那一路**变成「探测失败」，
 * 其余两路的结论照常给 —— 体检单不能因为一路挂了就没有结论。
 */
export async function probeAllChannels(options: ProbeOptions): Promise<ChannelProbeResult[]> {
  const safe = async (
    channel: Channel,
    probe: () => Promise<ChannelProbeResult>,
  ): Promise<ChannelProbeResult> => {
    try {
      return await probe();
    } catch (error) {
      const nowMs = Date.now();
      return buildResult({
        channel,
        outcome: 'unreachable',
        reachable: false,
        errorCode: 'ERR_INTERNAL',
        detail: `探测过程抛出未分类异常：${error instanceof Error ? error.message : String(error)}`,
        checks: [
          {
            name: '探测',
            ok: false,
            error_code: 'ERR_INTERNAL',
            detail: '探测过程抛出未分类异常',
          },
        ],
        startedAt: nowMs,
        nowMs,
      });
    }
  };

  return await Promise.all([
    safe('inbound', () => probeInboundListener(options)),
    safe('outbound', () => probeOutboundCharge(options)),
    safe('notify', () => probeNotifyEndpoint(options)),
  ]);
}
