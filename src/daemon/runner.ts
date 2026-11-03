/**
 * 常驻守护进程的运行主路径：**入站事件 → 逐条绑定 → 计费回写 → 心跳 → 优雅停机**。
 *
 * 形态来源（源产品主路径）：源产品的每个服务都是「**常驻进程**」——
 * 起服务、挂路由、缺凭据就拒启动（`github_ref/macro/services/lexical-service/src/server.ts`、
 * `github_ref/macro/services/bots/anthropic-status-bot/src/server.ts`）。
 * 本模块把这条形态落到院内场景：**一个进程同时接两路事件源**（扫码枪 HTTP / RFID 目录投递），
 * 一路出站回写 HIS 计费，周期性写心跳，并且**收到 SIGTERM 时先把在途批次做完再退**。
 *
 * 每周期干五件事：
 *   ⓪ 主数据热更新：主数据文件变了就重导一次（**导入即生效、不重启本进程**）；
 *   ① 捡目录投递路的新批次 → 逐条结算 → 批次摘要**并进台次窗口** → 文件归档；
 *   ② 计费回写扫描（outbox）：把「已绑定但还没回写计费」的条目提交给 HIS；
 *   ③ 心跳：把自身状态写进台账 `meta` 表；
 *   ④ 崩溃续跑：租约到期的未确认占位重新入队（只在启动时做一次）；
 *   ⑤ 聚合消息扫描：窗口到期的台次发**一条**合并后的待核消息（不刷屏）。
 *
 * 硬约束：
 *   ① **缺凭据位拒绝启动**（启动自检，缺哪个指名变量名）；
 *   ② **停机不丢在途** —— 先停接新事件，再等在途批次结算完，最后关库退出码 0；
 *   ③ **状态只在台账里** —— 心跳、台账、核查条目、审计链都落在 SQLite，重启不丢；
 *   ④ **推送失败不阻塞台账** —— 企微推不动只是推送失败，台账照落。
 */

import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

import {
  readSettings,
  requireChannel,
  type EnvSnapshot,
} from '../config/env.js';
import { openLedger, schemaVersion, LEDGER_SCHEMA_VERSION, type LedgerDb } from '../ledger/db.js';
import { MigrationError } from '../ledger/migrations.js';
import { requeueExpired } from '../ledger/claim.js';
import { setMeta } from '../ledger/meta.js';
import { createIngestServer } from '../ingest/http-server.js';
import { cleanupExpiredNonces, countNonces } from '../ingest/replay-guard.js';
import { applyEventLogRetention } from '../ledger/event-log.js';
import { createRfidDirSource } from '../ingest/adapters/rfid-dir.js';
import { dispatchBatch } from '../ingest/adapters/dispatch.js';
import { readScannerRegistry, type ScannerRegistry } from '../config/scanner-registry.js';
import { createWeComClient } from '../check/notify.js';
import {
  createAggregatingSink,
  createBatchMessageAggregator,
  sendAggregatedMessage,
  type BatchMessageAggregator,
} from '../check/message-template.js';
import { sweepCheckTaskRouting } from '../check/route.js';
import { HisChargingClient } from '../charge/client.js';
import { loadCircuitSnapshot, saveCircuitSnapshot } from '../charge/circuit.js';
import { writeBackOperationCharges } from '../charge/writeback.js';
import { computeBackoffDelay } from '../charge/retry.js';
import { resolveOperation } from '../engine/operation.js';
import { createMasterDataWatcher } from '../ledger/master-data-watcher.js';
import type { SettleProcessor } from '../engine/settle.js';
import { defaultLogger, type Logger } from '../log/logger.js';
import {
  buildHeartbeat,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  writeHeartbeat,
  type HeartbeatChannels,
} from './heartbeat.js';
import {
  createInFlightTracker,
  installShutdownHandlers,
  waitForIdle,
  type InFlightTracker,
} from './shutdown.js';
import { runStartupChecks, formatStartupCheckResult, StartupCheckError } from './startup-check.js';

/** 守护进程的默认轮询周期（毫秒）：目录投递路多久扫一次 */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** 停机时等待在途批次的默认上限（毫秒） */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

/** 同一台次两次计费回写之间的最小间隔（毫秒）：通道不通时别把 HIS 打爆 */
export const DEFAULT_WRITEBACK_MIN_INTERVAL_MS = 5_000;

/** 主数据热更新的检查间隔（毫秒）：多久看一次主数据文件有没有变 */
export const DEFAULT_MASTER_DATA_RELOAD_INTERVAL_MS = 30_000;

/**
 * 核查任务路由扫描的间隔（毫秒）：多久扫一次待办（补分派 / 超时提醒 / 逐级升级）。
 *
 * 口径：提醒与升级都是**分钟级**的院务节奏，太密会刷屏，太疏会漏掉超时条目。
 */
export const DEFAULT_ROUTING_SWEEP_INTERVAL_MS = 60_000;

/** 守护进程的输入 */
export interface DaemonOptions {
  /** 环境变量快照（默认读进程环境） */
  env?: EnvSnapshot;
  /** 台账库路径（默认取 LEDGER_DB_PATH / data/ledger.db） */
  ledgerDbPath?: string;
  /** RFID 投递目录（默认取 SCAN_INBOX_DIR / scan-inbox） */
  scanInboxDir?: string;
  /** 入站 HTTP 监听端口（默认取 HTTP_PORT / 8099） */
  httpPort?: number;
  /** 入站 HTTP 监听地址（默认取 DAEMON_HTTP_HOST / 0.0.0.0） */
  httpHost?: string;
  /** 轮询周期（毫秒） */
  pollIntervalMs?: number;
  /** 心跳周期（毫秒） */
  heartbeatIntervalMs?: number;
  /** 核查任务路由扫描周期（毫秒）：补分派 / 超时提醒 / 逐级升级 */
  routingSweepIntervalMs?: number;
  /** 停机等待在途的上限（毫秒） */
  shutdownTimeoutMs?: number;
  /** 同一台次两次计费回写的最小间隔（毫秒） */
  writebackMinIntervalMs?: number;
  /**
   * 排台台次 CSV 路径（主数据热更新的观察对象；空串 = 不观察这一侧）。
   *
   * 配了之后：文件一变就自动重导一次，**判定立刻按新值走，不重启本进程**。
   */
  masterDataOperationsCsv?: string;
  /** 耗材主数据 CSV 路径（主数据热更新的观察对象；空串 = 不观察这一侧） */
  masterDataMaterialsCsv?: string;
  /** 主数据热更新的检查间隔（毫秒） */
  masterDataReloadIntervalMs?: number;
  /** 扫码枪位置登记簿（默认从 OR_SCANNER_REGISTRY 读；不传 = 空登记簿） */
  scannerRegistry?: ScannerRegistry;
  /** 结构化日志器 */
  logger?: Logger;
  /** 当前时间（毫秒），测试可注入 */
  now?: () => number;
  /** 已打开的台账（测试注入；不给则自己开） */
  ledger?: LedgerDb;
  /** 逐条结算处理器（测试可注入单条故障 / 慢处理） */
  settleProcessor?: SettleProcessor;
  /** 是否装 SIGTERM / SIGINT 处理器（默认装；测试里可关掉自己控制） */
  installSignalHandlers?: boolean;
}

/** 停机结论 */
export interface DaemonStopResult {
  /** 停机原因（SIGTERM / SIGINT / 调用方给的说明） */
  reason: string;
  /** 在途批次是否在超时前跑完 */
  drained: boolean;
  /** 停机时还剩几个在途 */
  remaining: number;
  /** 实际等了多久（毫秒） */
  waited_ms: number;
  /** 退出码：正常停机一律 0 */
  exit_code: number;
}

/** 守护进程句柄 */
export interface DaemonHandle {
  /** 台账连接 */
  db: DatabaseSync;
  /** 入站 HTTP 实际监听端口 */
  port: number;
  /** 当前在途批次数 */
  inFlight(): number;
  /** 停机完成后的结论（停机中时为 null） */
  readonly stopped: Promise<DaemonStopResult>;
  /** 主动停机（幂等：重复调用返回同一个结论） */
  stop(reason?: string): Promise<DaemonStopResult>;
}

/** 读一个正整数环境变量；不合法时用默认值 */
function readIntEnv(env: EnvSnapshot, name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim();
  if (raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 关 HTTP 服务：不再接新连接，等已连上的收尾，超时后强制断开 */
async function closeHttpServer(server: Server, timeoutMs: number): Promise<void> {
  await new Promise<void>((done) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      done();
    };
    server.close(() => finish());
    server.closeIdleConnections?.();
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * 起一个常驻守护进程。
 *
 * **不负责**启动自检与退出码（那是入口 `daemon.ts` 的事）——
 * 这里只管「跑起来」，方便测试直接拿到一个跑着的进程再停掉它。
 */
export async function runDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => Date.now());
  const settings = readSettings(env);
  // 扫码枪位置登记簿：归属双因子核对的科室上下文与配置漂移判定都靠它。
  // 没配 = 空登记簿（只剩手术间一个因子参与核对），不影响启动。
  const scannerRegistry = options.scannerRegistry ?? readScannerRegistry(env);

  const ledgerDbPath = options.ledgerDbPath ?? settings.ledgerDbPath;
  const scanInboxDir = options.scanInboxDir ?? settings.scanInboxDir;
  const httpPort = options.httpPort ?? settings.httpPort;
  const httpHost = options.httpHost ?? ((env['DAEMON_HTTP_HOST'] ?? '').trim() || '0.0.0.0');
  const pollIntervalMs = options.pollIntervalMs ?? readIntEnv(env, 'DAEMON_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS);
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? readIntEnv(env, 'DAEMON_HEARTBEAT_INTERVAL_MS', DEFAULT_HEARTBEAT_INTERVAL_MS);
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? readIntEnv(env, 'DAEMON_SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS);
  const writebackMinIntervalMs =
    options.writebackMinIntervalMs ?? readIntEnv(env, 'DAEMON_WRITEBACK_MIN_INTERVAL_MS', DEFAULT_WRITEBACK_MIN_INTERVAL_MS);
  const masterDataOperationsCsv = options.masterDataOperationsCsv ?? settings.masterDataOperationsCsv;
  const masterDataMaterialsCsv = options.masterDataMaterialsCsv ?? settings.masterDataMaterialsCsv;
  const masterDataReloadIntervalMs =
    options.masterDataReloadIntervalMs ??
    readIntEnv(env, 'MASTER_DATA_RELOAD_INTERVAL_MS', DEFAULT_MASTER_DATA_RELOAD_INTERVAL_MS);
  const routingSweepIntervalMs =
    options.routingSweepIntervalMs ??
    readIntEnv(env, 'CHECK_ROUTING_SWEEP_INTERVAL_MS', DEFAULT_ROUTING_SWEEP_INTERVAL_MS);

  // 凭据：缺位即拒（启动自检已经挡过一道，这里再取一次 —— 缺了就抛，不带着空凭据跑）
  const inboundConfig = requireChannel('inbound', env);
  const outboundConfig = requireChannel('outbound', env);
  const notifyChannel = requireChannel('notify', env);
  if (inboundConfig.channel !== 'inbound') throw new Error('入站凭据位不可用');
  if (outboundConfig.channel !== 'outbound') throw new Error('出站凭据位不可用');
  if (notifyChannel.channel !== 'notify') throw new Error('推送凭据位不可用');
  const inbound = inboundConfig;
  const outbound = outboundConfig;
  const notifyConfig = notifyChannel;

  const startedAtMs = now();
  // 开库即迁移：schema 升不到链尾版本就在这里炸（带版本号与原因），
  // 绝不带着半新半旧的表结构开跑。
  const ledger =
    options.ledger ?? openLedger(ledgerDbPath, { busyTimeoutMs: settings.ledgerBusyTimeoutMs });
  const db = ledger.db;

  // 台账版本必须是代码支持的版本：迁移没跑完就不该开跑
  const currentVersion = schemaVersion(db);
  if (currentVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `台账 schema 版本是 ${currentVersion}，本程序支持 ${LEDGER_SCHEMA_VERSION}；请先完成迁移`,
    );
  }

  // 崩溃续跑：上一轮留下的租约到期占位重新入队（启动时做一次）
  const requeued = requeueExpired(db, { nowMs: startedAtMs });
  if (requeued.length > 0) {
    logger.warn('发现租约到期的未确认占位，已重新入队续跑', {
      channel: 'runtime',
      error_code: null,
      duration_ms: null,
      requeued: requeued.length,
    });
  }

  const chargeClient = new HisChargingClient({
    baseUrl: outbound.baseUrl,
    token: outbound.token,
    timeoutMs: settings.chargeTimeoutMs,
    connectTimeoutMs: settings.chargeConnectTimeoutMs,
    maxResponseTimeoutMs: settings.chargeMaxResponseTimeoutMs,
    circuitFailureThreshold: settings.chargeCircuitFailureThreshold,
    circuitCooldownMs: settings.chargeCircuitCooldownMs,
    keepAliveMsecs: settings.chargeKeepAliveMs,
    maxSockets: settings.chargeMaxSockets,
    // 熔断状态落到台账 meta 表：doctor 随时查得到，进程重启也不丢
    onCircuitChange: (snapshot) => {
      try {
        saveCircuitSnapshot(db, snapshot);
      } catch {
        // 落盘失败不掩盖计费主路径
      }
    },
  });
  // 接着上一程的熔断状态：重启不该让一条坏掉的计费通道立刻又被敲一遍
  try {
    chargeClient.circuit.restore(loadCircuitSnapshot(db));
  } catch {
    // 台账里没有这一项就是没有，按 closed 起
  }
  const notifyClient = createWeComClient({
    webhookUrl: notifyConfig.webhookUrl,
    secret: notifyConfig.secret,
  });
  /**
   * 批次摘要的**按台次聚合节流**：同一台次的异常在窗口内合并成一条消息。
   *
   * 两路事件源（扫码枪 HTTP / RFID 目录投递）共用这一个聚合器 ——
   * 同一台次从哪条路扫来的异常都并进同一个窗口，群里只说一次。
   */
  const aggregator: BatchMessageAggregator = createBatchMessageAggregator({
    windowMs: settings.notifyAggregationWindowMs,
    nowMs: now,
  });
  /** 批次摘要出口：只并进窗口，不发消息（真正发出在窗口结束后的扫描里） */
  const notifySink = createAggregatingSink(aggregator);

  const channels: HeartbeatChannels = {
    inbound: true,
    outbound: true,
    notify: true,
  };

  const tracker: InFlightTracker = createInFlightTracker();

  /**
   * 主数据热更新观察器：文件一变就重导一次，**不重启本进程**。
   *
   * 没配主数据文件时它是关闭的（enabled=false），轮询直接跳过 ——
   * 「主数据天天在变」是常态，但没配观察对象时不该凭空造一个轮询负担。
   */
  const masterDataWatcher = createMasterDataWatcher({
    db,
    operationsCsv: masterDataOperationsCsv,
    materialsCsv: masterDataMaterialsCsv,
    source: 'daemon_watch',
    // 主数据 CSV 的编码策略（auto = UTF-8 与 GBK 里择优；老系统导出 GBK 时不会读成乱码）
    encoding: settings.masterDataEncoding,
    logger,
  });
  /** 上次检查主数据文件的时刻（毫秒） */
  let lastMasterDataCheckAt = startedAtMs;

  const rfid = createRfidDirSource({
    inboxDir: scanInboxDir,
    onError: (error) => {
      logger.warn('目录投递路出错', {
        channel: 'runtime',
        error_code: error.code,
        duration_ms: null,
        detail: error.message,
      });
    },
  });

  // 入站 HTTP 服务（扫码枪路）
  const server = createIngestServer({
    db,
    token: inbound.token,
    secret: inbound.secret,
    logger,
    batchSize: settings.ledgerBatchSize,
    keyProfile: settings.idempotencyKeyProfile,
    timestampToleranceSec: settings.scannerTimestampToleranceSec,
    nonceTtlSec: settings.scannerNonceTtlSec,
    scannerRegistry,
    notify: { client: notifyClient, sink: notifySink },
  });

  // HTTP 在途跟踪：请求进来到响应发完算在途（停机时要等它把台账写完）
  server.on('request', (_req, res) => {
    tracker.begin();
    res.on('close', () => tracker.end());
  });

  let stopping = false;
  let stopPromise: Promise<DaemonStopResult> | null = null;
  let resolveStopped: ((result: DaemonStopResult) => void) | null = null;
  /** 停机完成信号：入口 `main()` 等它 */
  const stoppedPromise = new Promise<DaemonStopResult>((resolve) => {
    resolveStopped = resolve;
  });
  let pollTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let routingTimer: NodeJS.Timeout | null = null;
  let nonceCleanupTimer: NodeJS.Timeout | null = null;
  let eventLogCleanupTimer: NodeJS.Timeout | null = null;

  /** 同一台次上次计费回写的时刻（毫秒）：通道不通时别把 HIS 打爆 */
  const lastWritebackAt = new Map<string, number>();
  /** 同一台次已经回写过的次数：退避间隔按次数放大 */
  const writebackAttempts = new Map<string, number>();

  /** 批次摘要推送（目录投递路；HTTP 路在服务内部推） */
  async function notifyBatch(
    batch: { operation_no: string; room_no: string; scanner_id: string; items: readonly { material_code: string; quantity: number }[] },
    result: ReturnType<typeof dispatchBatch>,
  ): Promise<void> {
    const operation = resolveOperation(db, batch.operation_no);
    // 走聚合出口：这一批的异常并进台次窗口，窗口结束才发一条消息
    await notifySink({
      operation_no: batch.operation_no,
      room_no: batch.room_no,
      dept_code: operation.dept_code,
      scanner_id: batch.scanner_id,
      total: result.stats.total,
      accepted: result.stats.accepted,
      rejected: result.stats.rejected,
      duplicate_in_batch: result.stats.duplicate_in_batch,
      exceptions: result.rejected.map((rejected) => ({
        material_code: rejected.material_code,
        reason_code: rejected.reason_code ?? 'UNKNOWN',
        conclusion: rejected.conclusion,
        quantity: batch.items.find((item) => item.material_code === rejected.material_code)?.quantity ?? null,
        operation_no: rejected.operation_no,
      })),
      items: batch.items.map((item) => ({
        material_code: item.material_code,
        quantity: item.quantity,
      })),
    });
  }

  /**
   * 发出**窗口已结束**的聚合消息。
   *
   * 发送失败不放行：消息按退避重新排队（`requeue`），**不丢信息**；
   * 台账与核查条目本来就落好了，推送只是通知。
   */
  async function flushAggregatedMessages(): Promise<void> {
    if (stopping) return;
    const due = aggregator.flushDue(now());
    for (const batch of due) {
      if (stopping) return;
      try {
        const outcome = await sendAggregatedMessage(db, notifyClient, batch);
        if (outcome.result === 'failed') {
          aggregator.requeue(batch);
          logger.warn('聚合消息推送失败，已按退避重新排队', {
            channel: 'notify',
            operation_no: batch.operation_no,
            error_code: outcome.error_code ?? 'ERR_NOTIFY_INTERNAL',
            duration_ms: null,
            exception_count: batch.exception_count,
          });
          continue;
        }
        logger.info('聚合消息已推送', {
          channel: 'notify',
          operation_no: batch.operation_no,
          error_code: null,
          duration_ms: null,
          sent: outcome.sent,
          exception_count: batch.exception_count,
          batch_count: batch.batch_count,
        });
      } catch (error) {
        aggregator.requeue(batch);
        logger.error('聚合消息推送异常，已按退避重新排队', {
          channel: 'notify',
          operation_no: batch.operation_no,
          error_code: 'ERR_NOTIFY_INTERNAL',
          duration_ms: null,
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** 计费回写扫描（outbox）：把「已绑定但还没回写计费」的条目提交给 HIS */
  async function sweepCharges(): Promise<void> {
    if (stopping) return;
    const rows = db
      .prepare(
        `SELECT DISTINCT operation_no FROM material_binding
          WHERE status = 'bound' ORDER BY operation_no ASC`,
      )
      .all() as unknown as Array<{ operation_no: string }>;

    for (const row of rows) {
      if (stopping) return;
      const operationNo = row.operation_no;
      const attempts = writebackAttempts.get(operationNo) ?? 0;
      const lastAt = lastWritebackAt.get(operationNo) ?? 0;
      if (attempts > 0 && now() - lastAt < computeBackoffDelay(writebackMinIntervalMs, attempts)) {
        continue; // 还在退避窗口里，这一轮不重投
      }

      tracker.begin();
      try {
        const result = await writeBackOperationCharges(db, operationNo, {
          client: chargeClient,
          path: settings.chargeMaterialUsesPath,
          maxBatchSize: settings.chargeMaxBatchSize,
          keyProfile: settings.idempotencyKeyProfile,
          logger,
        });
        writebackAttempts.set(operationNo, attempts + 1);
        lastWritebackAt.set(operationNo, now());
        if (result.calls > 0) {
          logger.info('计费回写完成', {
            channel: 'outbound',
            operation_no: operationNo,
            error_code: result.error_code,
            duration_ms: null,
            submitted: result.submitted,
            accepted: result.accepted,
            rejected: result.rejected,
            calls: result.calls,
            batches: result.batches,
          });
        }
      } catch (error) {
        writebackAttempts.set(operationNo, attempts + 1);
        lastWritebackAt.set(operationNo, now());
        logger.error('计费回写失败', {
          channel: 'outbound',
          operation_no: operationNo,
          error_code: 'ERR_INTERNAL',
          duration_ms: null,
          error_message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        tracker.end();
      }
    }
  }

  /** 一轮：捡目录投递路的新批次 + 计费回写扫描 */
  async function tick(): Promise<void> {
    if (stopping) return;

    // ⓪ 主数据热更新：文件变了就重导一次（导入即生效，不重启本进程）。
    //    判定引擎每次现读主数据，所以这里导完，下一次扫码立刻按新值判。
    if (masterDataWatcher.enabled && now() - lastMasterDataCheckAt >= masterDataReloadIntervalMs) {
      lastMasterDataCheckAt = now();
      try {
        const reload = masterDataWatcher.poll();
        if (reload && !reload.reloaded && reload.error) {
          logger.warn('主数据热更新未完成，主数据仍是上一版', {
            channel: 'runtime',
            error_code: reload.error_code,
            duration_ms: null,
            error_message: reload.error,
          });
        }
      } catch (error) {
        logger.error('主数据热更新异常，主数据仍是上一版', {
          channel: 'runtime',
          error_code: 'ERR_MASTER_DATA_IMPORT_FAILED',
          duration_ms: null,
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      const batches = await rfid.poll();
      for (const batch of batches) {
        if (stopping) break;
        tracker.begin();
        try {
          const result = dispatchBatch(db, batch, {
            logger,
            request_id: batch.request_id ?? null,
            batchSize: settings.ledgerBatchSize,
            keyProfile: settings.idempotencyKeyProfile,
            scannerRegistry,
            ...(options.settleProcessor ? { processor: options.settleProcessor } : {}),
          });
          logger.info('目录投递批次已处理', {
            channel: 'inbound',
            operation_no: batch.operation_no,
            request_id: batch.request_id ?? null,
            error_code: null,
            duration_ms: null,
            total: result.stats.total,
            accepted: result.stats.accepted,
            rejected: result.stats.rejected,
          });
          try {
            await notifyBatch(batch, result);
          } catch (error) {
            // 推送失败不阻塞台账（台账行与核查条目已经落库）
            logger.warn('批次摘要推送失败，台账不受影响', {
              channel: 'notify',
              operation_no: batch.operation_no,
              error_code: 'ERR_NOTIFY_FAILED',
              duration_ms: null,
              error_message: error instanceof Error ? error.message : String(error),
            });
          }
          await rfid.ack(batch);
        } catch (error) {
          logger.error('目录投递批次处理失败', {
            channel: 'inbound',
            operation_no: batch.operation_no,
            error_code: 'ERR_INTERNAL',
            duration_ms: null,
            error_message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          tracker.end();
        }
      }
    } catch (error) {
      logger.error('目录投递路轮询失败', {
        channel: 'runtime',
        error_code: 'ERR_INTERNAL',
        duration_ms: null,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }

    await sweepCharges();

    // ⓮ 聚合消息窗口到期 → 发一条按台次合并的待核消息
    await flushAggregatedMessages();
  }

  /**
   * 核查任务路由扫描：补分派 → 超时提醒 → 逐级升级。
   *
   * 独立于事件主路径的一条线：**没人管待办**这件事不能等下一次扫码才想起来。
   * 扫描失败只记日志，不影响扫码入站与计费回写。
   */
  async function sweepRouting(): Promise<void> {
    if (stopping) return;
    tracker.begin();
    try {
      const result = await sweepCheckTaskRouting(db, {
        client: notifyClient,
        nowMs: now(),
      });
      if (result.assigned > 0 || result.reminded > 0 || result.escalated > 0) {
        logger.info('核查任务路由扫描完成', {
          channel: 'runtime',
          error_code: null,
          duration_ms: null,
          assigned: result.assigned,
          overdue: result.overdue,
          reminded: result.reminded,
          remind_failed: result.remind_failed,
          escalated: result.escalated,
        });
      }
    } catch (error) {
      logger.error('核查任务路由扫描失败', {
        channel: 'runtime',
        error_code: 'ERR_INTERNAL',
        duration_ms: null,
        error_message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      tracker.end();
    }
  }

  /** 写一条心跳 */
  function writeHeartbeatNow(): void {
    try {
      const record = buildHeartbeat({
        db,
        startedAtMs,
        nowMs: now(),
        channels,
      });
      writeHeartbeat(db, record);
    } catch (error) {
      logger.error('心跳写入失败', {
        channel: 'runtime',
        error_code: 'ERR_INTERNAL',
        duration_ms: null,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 停机：先停接新事件，再等在途跑完，最后落盘关库 */
  function stop(reason: string): Promise<DaemonStopResult> {
    if (stopPromise) return stopPromise;
    stopping = true;

    stopPromise = (async (): Promise<DaemonStopResult> => {
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (routingTimer) clearInterval(routingTimer);
      if (nonceCleanupTimer) clearInterval(nonceCleanupTimer);
      if (eventLogCleanupTimer) clearInterval(eventLogCleanupTimer);
      pollTimer = null;
      heartbeatTimer = null;
      routingTimer = null;
      nonceCleanupTimer = null;
      eventLogCleanupTimer = null;

      // ① 停接新事件：HTTP 不再接新连接，目录路不再捡新文件
      await closeHttpServer(server, Math.min(shutdownTimeoutMs, 2_000));

      // ② 等在途批次结算完（带上限；超时不无限等，如实记录）
      const drain = await waitForIdle(tracker, shutdownTimeoutMs);

      // ②-1 窗口没到期的聚合消息：停机前先把已知的异常说一遍（尽力而为，不拖住停机）
      try {
        const pending = aggregator.flushAll(now());
        for (const batch of pending) {
          await sendAggregatedMessage(db, notifyClient, batch);
        }
      } catch (error) {
        logger.warn('停机前补发聚合消息失败，异常仍在核查清单里', {
          channel: 'notify',
          error_code: 'ERR_NOTIFY_INTERNAL',
          duration_ms: null,
          error_message: error instanceof Error ? error.message : String(error),
        });
      }

      // ③ 落盘：停机记录 + 最后一条心跳
      const stopRecord = {
        reason,
        drained: drain.drained,
        remaining: drain.remaining,
        waited_ms: drain.waited_ms,
        stopped_at: new Date(now()).toISOString(),
      };
      try {
        setMeta(db, 'daemon.stop', JSON.stringify(stopRecord));
        writeHeartbeatNow();
      } catch {
        // 落盘失败不掩盖停机结论
      }

      // ④ 关连接池（keep-alive 的空闲连接不留着）+ 关库
      try {
        chargeClient.destroy();
      } catch {
        // 连接池关闭失败不掩盖停机结论
      }
      if (!options.ledger) ledger.close();

      logger.info('守护进程已停机', {
        channel: 'runtime',
        error_code: null,
        duration_ms: drain.waited_ms,
        reason,
        drained: drain.drained,
        remaining: drain.remaining,
      });

      const result: DaemonStopResult = { reason, ...drain, exit_code: 0 };
      resolveStopped?.(result);
      return result;
    })();

    return stopPromise;
  }

  // 启动：监听端口 → 起轮询 → 起心跳 → 记录启动信息
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(httpPort, httpHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = address !== null && typeof address !== 'string' ? address.port : httpPort;

  setMeta(
    db,
    'daemon.start',
    JSON.stringify({
      pid: process.pid,
      port: actualPort,
      host: httpHost,
      version: buildHeartbeat({ db, startedAtMs, nowMs: now(), channels }).version,
      started_at: new Date(startedAtMs).toISOString(),
    }),
  );
  writeHeartbeatNow();

  pollTimer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  heartbeatTimer = setInterval(() => {
    writeHeartbeatNow();
  }, heartbeatIntervalMs);
  routingTimer = setInterval(() => {
    void sweepRouting();
  }, routingSweepIntervalMs);
  // nonce 过期记录清理：TTL 到了的记录回收掉，表不会无限长
  // （清理前后的条数在 doctor 里能看到）
  nonceCleanupTimer = setInterval(() => {
    try {
      const cleaned = cleanupExpiredNonces(db, now());
      if (cleaned > 0) {
        logger.info('入站重放防护：过期 nonce 记录已清理', {
          channel: 'runtime',
          error_code: null,
          duration_ms: null,
          cleaned,
          remaining: countNonces(db),
        });
      }
    } catch (error) {
      logger.error('过期 nonce 记录清理失败', {
        channel: 'runtime',
        error_code: 'ERR_INTERNAL',
        duration_ms: null,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }, settings.scannerNonceCleanupIntervalMs);

  // 事件日志保留策略：超保留期 / 超最大行数的旧事件清掉（清理留审计）。
  // 清的是**日志**不是账 —— 台账行、计费回执、核查任务、审计链一律不动。
  eventLogCleanupTimer = setInterval(() => {
    try {
      const result = applyEventLogRetention(db, {
        retentionDays: settings.eventLogRetentionDays,
        maxRows: settings.eventLogMaxRows,
        nowMs: now(),
      });
      if (result.removed_total > 0) {
        logger.info('事件日志保留策略已执行', {
          channel: 'runtime',
          error_code: null,
          duration_ms: null,
          removed_expired: result.removed_expired,
          removed_overflow: result.removed_overflow,
          remaining: result.remaining,
        });
      }
    } catch (error) {
      logger.error('事件日志保留策略执行失败', {
        channel: 'runtime',
        error_code: 'ERR_INTERNAL',
        duration_ms: null,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }, settings.eventLogCleanupIntervalMs);

  const handlers =
    options.installSignalHandlers === false
      ? null
      : installShutdownHandlers({
          onSignal: (signal) => {
            logger.info('收到停机信号，开始优雅停机', {
              channel: 'runtime',
              error_code: null,
              duration_ms: null,
              signal,
            });
            void stop(signal);
          },
        });

  return {
    db,
    port: actualPort,
    inFlight: () => tracker.count(),
    stopped: stoppedPromise,
    stop,
  };
}

/**
 * 守护进程入口：自检 → 起进程 → 等停机信号 → 退出码。
 *
 * 自检不通过**直接退出码 1**（缺位不带着空凭据跑），并把缺哪个变量名打在 stderr 上。
 */
export async function main(argv: readonly string[] = []): Promise<number> {
  const env = process.env;
  const settings = readSettings(env);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        '高值耗材扫码计费闭环系统 · 常驻守护进程',
        '',
        '用法：node dist/daemon.js',
        '',
        '环境变量：',
        '  OR_SCANNER_BASE_URL / OR_SCANNER_TOKEN / OR_SCANNER_SECRET   入站扫码网关',
        '  HIS_CHARGING_BASE_URL / HIS_CHARGING_TOKEN                    出站 HIS 计费',
        '  WECOM_WEBHOOK_URL / WECOM_SECRET                             企业微信推送',
        '  LEDGER_DB_PATH / SCAN_INBOX_DIR / HTTP_PORT                   运行参数',
        '  MASTER_DATA_OPERATIONS_CSV / MASTER_DATA_MATERIALS_CSV       主数据热更新观察对象（配了就自动热更新）',
        '  MASTER_DATA_RELOAD_INTERVAL_MS                               主数据热更新检查间隔',
        '  DAEMON_POLL_INTERVAL_MS / DAEMON_HEARTBEAT_INTERVAL_MS        轮询与心跳周期',
        '  CHECK_ROUTING_SWEEP_INTERVAL_MS                              核查待办路由扫描周期（提醒与升级）',
        '  NOTIFY_AGGREGATION_WINDOW_MS                                 企微批次摘要聚合窗口（毫秒，同台次异常合并成一条）',
        '  DAEMON_SHUTDOWN_TIMEOUT_MS                                   停机等待在途的上限',
      ].join('\n'),
    );
    return 0;
  }

  const check = runStartupChecks({
    env,
    ledgerDbPath: settings.ledgerDbPath,
    scanInboxDir: settings.scanInboxDir,
  });
  if (!check.ok) {
    console.error(formatStartupCheckResult(check));
    return 1;
  }

  let handle: DaemonHandle;
  try {
    handle = await runDaemon({ env });
  } catch (error) {
    if (error instanceof StartupCheckError) {
      console.error(formatStartupCheckResult(error.result));
      return 1;
    }
    // 台账迁移失败：指名版本号与原因，版本号停在失败前那一版（非零退出）
    if (error instanceof MigrationError) {
      console.error(
        `台账迁移失败：版本 ${error.version}（${error.migrationName}）—— ${error.reason}`,
      );
      console.error('该版本已回滚，台账版本号未前移；修好后重启即可继续升级。');
      return 1;
    }
    console.error(`守护进程启动失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(
    `高值耗材扫码计费闭环系统 已启动：http://${handle.port}/api/v1/scan-events（扫码事件入站）`,
  );

  const result = await handle.stopped;
  return result.exit_code;
}
