/**
 * 常驻入站 HTTP 服务：接收扫码枪 / 网关投递的扫码事件，验签 → 归一 → 绑定 → 逐条回执。
 *
 * 语义来源（源产品主路径）：
 *   - 源产品在服务入口做 `requiredVars` 缺位即拒（`services/lexical-service/src/server.ts`），
 *     本模块把「缺位就拒」下沉到**逐请求**：密钥 / 令牌 / 签名任一不成立即 401 且不落库；
 *   - 源产品按**前缀路由**分发到各路处理（`GATEWAY_PREFIX`），本模块按 `/api/v1/*` 前缀分派；
 *   - 源产品入站 webhook 凭据必填、投递失败即抛（`services/bots/anthropic-status-bot/src/server.ts`），
 *     本模块把验签做成同一件事：验不过就不往下走。
 *
 * 端点：`POST /api/v1/scan-events`
 *   请求头：Authorization: Bearer <OR_SCANNER_TOKEN>
 *           X-Scan-Timestamp: <epoch seconds>
 *           X-Scan-Nonce: <本次投递唯一串（8–128 字符，重试必须换新）>
 *           X-Scan-Signature: v1=<hex hmac-sha256("{timestamp}.{nonce}.{raw_body}", OR_SCANNER_SECRET)>
 *   请求体：{operation_no, room_no, scanner_id, scans:[{material_code, quantity, scan_time, batch_no}]}
 *   响应体：{accepted:[{material_code, operation_no, bound, conclusion, charge_state}],
 *            rejected:[{material_code, reason_code}]}
 *
 * 硬约束：验签失败返回 401 且**台账无新增行**；同批一条被拒不丢其余回执。
 *
 * 入站**三层重放防护**：时间戳窗口（过期即拒）→ nonce 去重（同 nonce 再来即拒）
 * → 幂等键（同码同台次只算一次）。三层任一命中都返回 401，
 * 并在审计链留一行（原因码可查），**台账不落任何行**。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

import {
  checkSignature,
  ERR_BAD_AUTHORIZATION,
  ERR_INVALID_SIGNATURE,
  ERR_MISSING_SIGNATURE,
  ERR_STALE_TIMESTAMP,
  verifyBearerToken,
  type SignatureOptions,
} from './signature.js';
import {
  claimNonce,
  DEFAULT_NONCE_TTL_SEC,
  ERR_MISSING_NONCE,
  ERR_REPLAY_NONCE_REPLAY,
} from './replay-guard.js';
import { appendAudit } from '../ledger/audit.js';
import { parseHttpScanBody } from './adapters/scanner-http.js';
import { dispatchBatch } from './adapters/dispatch.js';
import { resolveOperation } from '../engine/operation.js';
import type { ConfigurableIdempotencyKeyProfile } from '../domain/idempotency.js';
import type { ScannerRegistry } from '../config/scanner-registry.js';
import type { BindingOutcome } from '../engine/binding.js';
import { defaultLogger, newRequestId, type Logger } from '../log/logger.js';
import {
  sendBatchSummary,
  type NotifyOptions,
  type NotifyOutcome,
  type WeComBotClient,
} from '../check/notify.js';
import type { BatchSummarySink } from '../check/message-template.js';

/** 入站接口前缀（源产品「前缀路由」语义） */
export const API_PREFIX = '/api/v1';

/** 扫码事件端点 */
export const SCAN_EVENTS_PATH = `${API_PREFIX}/scan-events`;

/** 单次请求体上限（字节）：防止异常设备把内存吃满 */
export const MAX_BODY_BYTES = 512 * 1024;

export interface IngestServerDeps {
  /** 台账连接 */
  db: DatabaseSync;
  /** 入站 Bearer 令牌（设备侧调用时携带） */
  token: string;
  /** 入站签名密钥（HMAC-SHA256 over "{timestamp}.{nonce}.{raw_body}"） */
  secret: string;
  /** 时间戳容差窗口（秒） */
  timestampToleranceSec?: number;
  /**
   * nonce 存活时长（秒），默认 600。
   *
   * 同一个 nonce 在这个时长内第二次出现 = 按重放拒绝（401）。
   */
  nonceTtlSec?: number;
  /** 当前时间（毫秒），测试可注入 */
  nowMs?: () => number;
  /** 逐条结论输出（可选；正式版接结构化日志） */
  onConclusion?: (outcome: BindingOutcome) => void;
  /**
   * 结构化日志器（可选；不传则用默认日志器写 stdout）。
   *
   * 每批扫码事件落一条入站日志（台次、条数、结论分布、耗时），
   * 每条被拒的请求落一条带**统一错误码**的日志 —— 排查时按码就能定位。
   */
  logger?: Logger;
  /**
   * 单事务批量提交的条目上限（默认 200）。
   *
   * 一批扫码事件一次落库时，超过这个数就按批切分：每批一个事务，
   * 台账行 + 审计行 + 核查行同批提交或同批回滚，不留半写。
   */
  batchSize?: number;
  /**
   * 幂等键档位（默认 v1：同码同台次只算一次）。
   *
   * v2 档位把批号纳入去重维度：同一耗材同一台次的不同批号各算一次。
   * 不传就用默认档位（测试与 CLI 直连时走这条）。
   */
  keyProfile?: ConfigurableIdempotencyKeyProfile;
  /**
   * 扫码枪位置登记簿（可选）。
   *
   * 归属双因子核对用它取「事件侧的科室上下文」与判定「配置漂移」；
   * 不传 = 空登记簿（只剩手术间一个因子参与核对）。
   */
  scannerRegistry?: ScannerRegistry;
  /**
   * 企业微信批次摘要推送（可选）。
   *
   * 不配这一路时主流程照常（扫码事件照收、台账照落）；配了就多一条「批次摘要」消息。
   * **推送失败不阻塞台账落库** —— 台账行与核查条目在本步之前已落库。
   */
  notify?: {
    client: WeComBotClient;
    options?: NotifyOptions;
    /**
     * 批次摘要**出口**（可选）。
     *
     * 不给 = 默认行为：这一批结算完立刻推一条摘要。
     * 给了 = 走它：按台次聚合节流模式下，出口只把异常并进窗口（`result = queued`），
     * 真正发出发生在窗口结束之后（见 `src/check/message-template.ts`）。
     */
    sink?: BatchSummarySink;
  };
  /** 推送结果回调（可选；正式版接结构化日志） */
  onNotify?: (outcome: NotifyOutcome) => void;
}

export interface IngestServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

interface ErrorBody {
  error: { code: string; message: string; issues?: Array<{ field: string; reason: string }> };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  sendJson(res, status, body);
}

/** 读完请求体；超过上限即拒绝 */
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('REQUEST_BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * 把一次**入站拒绝**写进审计链（只增不改）。
 *
 * 为什么拒绝也要留痕：手术室里的重放 / 抓包重投不会有人来报障，
 * 只看台账看不出「刚才有一批被挡下了」—— 审计链是唯一能回答
 * 「这一批为什么没进台账」的地方。写审计失败不反过来影响这次拒绝。
 */
function auditRejection(
  db: DatabaseSync,
  requestId: string,
  code: string,
  message: string,
  eventType: 'inbound_rejected' | 'inbound_replay_rejected',
): void {
  try {
    appendAudit(db, {
      event_type: eventType,
      binding_key: null,
      operation_no: null,
      scanner_id: null,
      actor: 'ingest',
      request_id: requestId,
      detail: `${code}｜${message}`,
    });
  } catch {
    // 审计写不进去也不能把这次拒绝变成放行：拒绝照旧返回 401
  }
}

/**
 * 处理扫码事件请求：验签 → 归一 → 绑定 → 逐条回执。
 *
 * 失败一律「拒这一批」而不落库；绑定阶段则「拒这一条」而不丢同批其余。
 */
async function handleScanEvents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IngestServerDeps,
): Promise<void> {
  const logger = deps.logger ?? defaultLogger;
  const startedAt = Date.now();
  const requestId = newRequestId();

  // ① Bearer 令牌：缺位 / 不匹配即拒
  if (!verifyBearerToken(headerValue(req, 'authorization'), deps.token)) {
    logger.warn('入站请求被拒：令牌缺失或不匹配', {
      request_id: requestId,
      channel: 'inbound',
      error_code: ERR_BAD_AUTHORIZATION,
      duration_ms: Date.now() - startedAt,
    });
    auditRejection(deps.db, requestId, ERR_BAD_AUTHORIZATION, '缺少或错误的 Authorization 令牌', 'inbound_rejected');
    sendError(res, 401, ERR_BAD_AUTHORIZATION, '缺少或错误的 Authorization 令牌');
    return;
  }

  // ② 签名：密钥为空 / 时间戳过期 / nonce 缺失 / 签名不匹配，一律 401 且不落台账
  const timestamp = headerValue(req, 'x-scan-timestamp');
  const nonce = headerValue(req, 'x-scan-nonce');
  const signatureHeader = headerValue(req, 'x-scan-signature');
  const rawBody = await readRawBody(req);
  const bodyText = rawBody.toString('utf8');

  const options: SignatureOptions = {
    nowMs: deps.nowMs ? deps.nowMs() : Date.now(),
    ...(deps.timestampToleranceSec !== undefined
      ? { toleranceSec: deps.timestampToleranceSec }
      : {}),
  };
  const check = checkSignature(timestamp, nonce, bodyText, deps.secret, signatureHeader, options);
  if (!check.ok) {
    logger.warn('入站请求被拒：签名校验未通过', {
      request_id: requestId,
      channel: 'inbound',
      error_code: check.code,
      duration_ms: Date.now() - startedAt,
    });
    auditRejection(deps.db, requestId, check.code, check.message, 'inbound_rejected');
    sendError(res, 401, check.code, check.message);
    return;
  }

  // ③ nonce 去重（重放防护第二层）：同一 nonce 在 TTL 内第二次出现 = 重放。
  //    放在验签之后：签名不过的请求连 nonce 都占不到，坏报文烧不掉正常投递的 nonce。
  const claim = claimNonce(deps.db, nonce as string, {
    ttlSec: deps.nonceTtlSec ?? DEFAULT_NONCE_TTL_SEC,
    nowMs: options.nowMs,
    source: 'scanner_http',
  });
  if (!claim.ok) {
    logger.warn('入站请求被拒：nonce 命中重放', {
      request_id: requestId,
      channel: 'inbound',
      error_code: claim.code,
      duration_ms: Date.now() - startedAt,
    });
    auditRejection(deps.db, requestId, claim.code, claim.message, 'inbound_replay_rejected');
    sendError(res, 401, claim.code, claim.message);
    return;
  }

  // ④ 字段校验 + 码制归一：走与 RFID 目录投递路**共用**的解析层（统一批次信封）
  const parsed = parseHttpScanBody(bodyText, { requestId });
  if (!parsed.ok) {
    logger.warn('入站请求被拒：字段校验未通过', {
      request_id: requestId,
      channel: 'inbound',
      error_code: parsed.code,
      duration_ms: Date.now() - startedAt,
    });
    auditRejection(deps.db, requestId, parsed.code, parsed.message, 'inbound_rejected');
    const body: ErrorBody = {
      error: { code: parsed.code, message: parsed.message, issues: parsed.issues },
    };
    sendJson(res, 400, body);
    return;
  }
  const batch = parsed.batch;

  // ⑤ 逐条绑定判定（共用分发层：一条失败不丢同批其余）
  const result = dispatchBatch(deps.db, batch, {
    logger,
    request_id: requestId,
    ...(deps.batchSize ? { batchSize: deps.batchSize } : {}),
    ...(deps.keyProfile ? { keyProfile: deps.keyProfile } : {}),
    ...(deps.scannerRegistry ? { scannerRegistry: deps.scannerRegistry } : {}),
  });

  for (const outcome of [...result.accepted, ...result.rejected]) {
    deps.onConclusion?.(outcome);
  }

  // ⑥ 批次摘要推送（可选路）：推送失败不阻塞台账落库 —— 台账行与核查条目已落
  if (deps.notify) {
    const quantityByCode = new Map<string, number>();
    for (const item of batch.items) {
      if (!quantityByCode.has(item.material_code)) quantityByCode.set(item.material_code, item.quantity);
    }
    const operation = resolveOperation(deps.db, batch.operation_no);
    const summary = {
      operation_no: batch.operation_no,
      room_no: batch.room_no,
      dept_code: operation.dept_code,
      scanner_id: batch.scanner_id,
      total: result.stats.total,
      accepted: result.stats.accepted,
      rejected: result.stats.rejected,
      duplicate_in_batch: result.stats.duplicate_in_batch,
      exceptions: [
        ...result.rejected.map((rejected) => ({
          material_code: rejected.material_code,
          reason_code: rejected.reason_code ?? 'UNKNOWN',
          conclusion: rejected.conclusion,
          quantity: quantityByCode.get(rejected.material_code) ?? null,
          operation_no: rejected.operation_no,
        })),
        // 解析层拒掉的坏条目也要进推送清单：设备侧字段没过契约，护士长得知道
        ...result.rejects.map((reject) => ({
          material_code: reject.material_code ?? '',
          reason_code: reject.reason_code,
          conclusion: 'NOT_REGISTERED' as const,
          quantity: null,
          operation_no: batch.operation_no,
        })),
      ],
      items: batch.items.map((item) => ({
        material_code: item.material_code,
        quantity: item.quantity,
      })),
    };
    // 给了出口就走出口（按台次聚合节流模式）；不给就是默认的立即推送
    const outcome = deps.notify.sink
      ? await deps.notify.sink(summary, deps.notify.options ?? {})
      : await sendBatchSummary(deps.db, deps.notify.client, summary, deps.notify.options ?? {});
    deps.onNotify?.(outcome);
  }

  sendJson(res, 200, {
    accepted: result.accepted.map((outcome) => ({
      material_code: outcome.material_code,
      operation_no: outcome.operation_no,
      bound: outcome.bound,
      conclusion: outcome.conclusion,
      charge_state: outcome.charge_state,
    })),
    // 逐条结论 = 结算层判定的异常 + **解析层拒掉的坏条目**（字段没过契约的那几条）
    rejected: [
      ...result.rejected.map((outcome) => ({
        material_code: outcome.material_code,
        reason_code: outcome.reason_code,
      })),
      ...result.rejects.map((reject) => ({
        material_code: reject.material_code ?? '',
        reason_code: reject.reason_code,
      })),
    ],
  });

  logger.info('扫码批次已处理', {
    request_id: requestId,
    channel: 'inbound',
    operation_no: batch.operation_no,
    duration_ms: Date.now() - startedAt,
    total: result.stats.total,
    accepted: result.stats.accepted,
    rejected: result.stats.rejected,
    duplicate_in_batch: result.stats.duplicate_in_batch,
  });
}

/** 建服务（不监听）；路由按 `/api/v1/*` 前缀分派 */
export function createIngestServer(deps: IngestServerDeps): Server {
  const logger = deps.logger ?? defaultLogger;
  return createServer((req, res) => {
    void (async () => {
      try {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (!path.startsWith(API_PREFIX)) {
          logger.warn('入站请求被拒：路径不在本服务提供的接口下', {
            channel: 'inbound',
            error_code: 'ERR_UNKNOWN_ROUTE',
            duration_ms: null,
          });
          sendError(res, 404, 'ERR_UNKNOWN_ROUTE', `未知路径 ${path}，本服务只提供 ${API_PREFIX}/* 下的接口`);
          return;
        }
        if (path === SCAN_EVENTS_PATH) {
          if (req.method !== 'POST') {
            logger.warn('入站请求被拒：方法不对', {
              channel: 'inbound',
              error_code: 'ERR_METHOD_NOT_ALLOWED',
              duration_ms: null,
            });
            sendError(res, 405, 'ERR_METHOD_NOT_ALLOWED', '扫码事件端点只接受 POST');
            return;
          }
          await handleScanEvents(req, res, deps);
          return;
        }
        if (path === `${API_PREFIX}/health`) {
          sendJson(res, 200, { status: 'ok', service: 'material-scan-billing', time: new Date().toISOString() });
          return;
        }
        logger.warn('入站请求被拒：未知路径', {
          channel: 'inbound',
          error_code: 'ERR_UNKNOWN_ROUTE',
          duration_ms: null,
        });
        sendError(res, 404, 'ERR_UNKNOWN_ROUTE', `未知路径 ${path}`);
      } catch (error) {
        if (error instanceof Error && error.message === 'REQUEST_BODY_TOO_LARGE') {
          logger.warn('入站请求被拒：请求体超过上限', {
            channel: 'inbound',
            error_code: 'ERR_REQUEST_BODY_TOO_LARGE',
            duration_ms: null,
          });
          sendError(res, 413, 'ERR_REQUEST_BODY_TOO_LARGE', '请求体超过上限');
          return;
        }
        logger.error('入站服务内部错误', {
          channel: 'inbound',
          error_code: 'ERR_INTERNAL',
          duration_ms: null,
          error_message: error instanceof Error ? error.message : String(error),
        });
        sendError(res, 500, 'ERR_INTERNAL', '服务内部错误');
      }
    })();
  });
}

/** 起服务并返回监听端口（端口 0 = 由系统分配，测试与演示脚本用） */
export function startIngestServer(deps: IngestServerDeps): Promise<IngestServerHandle> {
  const server = createIngestServer(deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('无法获取监听端口'));
        return;
      }
      resolve({
        server,
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

export {
  ERR_BAD_AUTHORIZATION,
  ERR_INVALID_SIGNATURE,
  ERR_MISSING_NONCE,
  ERR_MISSING_SIGNATURE,
  ERR_REPLAY_NONCE_REPLAY,
  ERR_STALE_TIMESTAMP,
};
