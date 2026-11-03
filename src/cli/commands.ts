/**
 * 运维 CLI 的子命令实现（doctor / replay / ledger / pack / summary / reconcile）。
 *
 * 常驻进程没人盯着终端，出问题时信息科要能在一条命令里看到：
 *   哪一路不通、末次收到事件是什么时候、哪些耗材还没闭环、这一批到底绑上没有、
 *   哪些耗材**没有生成计费**。
 *
 * 子命令的分工：
 *   doctor    —— 各路凭据位齐否、末次事件 / 末次计费回写、推送失败计数（**只报齐否，不报明文**）
 *   replay    —— 从事件日志重放事件，输出「新增台账行数 / 触发计费次数」（证明同键不重复计费）
 *   ledger    —— 耗材使用台账查询与导出
 *   pack      —— 核查包导出（含台次上下文、结论、reason_code、回执与人工结论；**无患者标识字段**）
 *   summary   —— 批次与台次统计（结论分布、计费成功率、待核查条目数）
 *   reconcile —— 台账 ↔ 计费回执逐条对账，输出「哪些耗材没有生成计费」的差异台账
 *
 * 硬约束：
 *   ① **凭据明文一律不出现在任何输出里** —— 只报「齐否 + 缺哪个变量名」；
 *   ② **核查包与台账导出不含患者标识字段** —— 耗材码只绑台次，不落患者可识别明细；
 *   ③ **只读子命令不改业务状态** —— replay 是唯一会动台账的子命令，且走生产同一条路径
 *      （同一套装配、同一套幂等键、同一套结算逻辑），不另开旁路。
 *      reconcile 只**新增**差异台账行，不改台账与计费侧数据。
 */

import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';

import {
  allChannelStatus,
  CHANNEL_LABELS,
  readSettings,
  type Channel,
  type EnvSnapshot,
} from '../config/env.js';
import {
  appendAudit,
  auditSummary,
  countAuditByType,
  lastAuditAt,
  verifyAuditIntegrity,
  verifyChain,
  type ChainBreak,
} from '../ledger/audit.js';
import {
  countExpiredNonces,
  countNonces,
  lastNonceExpiry,
} from '../ingest/replay-guard.js';
import {
  countEventLog,
  lastEventAt,
  listEventLog,
  listEventsByMaterialCode,
  listEventsByRequestId,
  traceRequest,
  type EventLogRow,
  type RequestTrace,
} from '../ledger/event-log.js';
import { collectRunSummary, type RunSummary } from '../log/summary.js';
import { readHeartbeat, formatHeartbeat, type HeartbeatRecord } from '../daemon/heartbeat.js';
import { describeErrorCode } from '../log/error-codes.js';
import { countBindings } from '../ledger/binding-repo.js';
import { masterDataGapSummary } from '../ledger/master-data-gaps.js';
import { listMasterDataImports, masterDataState } from '../ledger/master-data-version.js';
import {
  listDiffs,
  reconcileLedgerVsReceipts,
  type ReconcileDiffRow,
  type ReconcileReport,
} from '../ledger/reconcile.js';
import { dispatchBatch } from '../ingest/adapters/dispatch.js';
import type { EventBatch } from '../ingest/adapters/event-source.js';
import { writeBackOperationCharges } from '../charge/writeback.js';
import type { HisChargingClient } from '../charge/client.js';
import {
  CIRCUIT_DEFAULTS,
  CIRCUIT_STATE_LABELS,
  loadCircuitSnapshot,
  type CircuitState,
} from '../charge/circuit.js';
import type { ConfigurableIdempotencyKeyProfile } from '../domain/idempotency.js';
import {
  listAttemptsInWindow,
  listOperationAttempts,
  loadReceipts,
  type ChargeReceiptRow,
} from '../charge/receipt.js';
import { summarizeAttemptHistory, type AttemptSummary } from '../charge/attempt-history.js';
import { runChannelHealth, type ChannelHealthRow } from '../health/channel-health.js';
import { probeAllChannels, type ChannelProbeResult } from '../health/probe.js';

/* ------------------------------------------------------------------ doctor */

/** 一路通道的体检结论 */
export interface ChannelReport {
  channel: Channel;
  /** 中文业务标签 */
  label: string;
  /** 凭据位是否齐 */
  ready: boolean;
  /** 缺哪些变量名（**只报名字，不报值**） */
  missing: string[];
  /** 端点（去掉凭据与 query，只留协议 + 主机 + 路径） */
  endpoint: string | null;
}

/** 一路事件来源的体检结论 */
export interface SourceReport {
  source: string;
  /** 中文业务标签 */
  label: string;
  /** 这一路现在能不能收（扫码枪路看凭据位；目录路看投递目录可读） */
  ready: boolean;
  /** 不可用时的原因（人话，不含路径之外的敏感信息） */
  note: string;
  /** 这一路收到过多少条事件 */
  events: number;
  /** 这一路末次收到事件的时间 */
  last_event_at: string | null;
}

/** 出站计费通道的熔断状态（连续失败达阈值后短路，不外发） */
export interface CircuitReport {
  /** 当前档位：closed 正常 / open 已熔断 / half_open 半开探测中 / unknown 尚未记录 */
  state: CircuitState | 'unknown';
  /** 中文档位说法 */
  label: string;
  /** 现在是不是短路着（不外发） */
  is_open: boolean;
  /** 连续失败次数 */
  consecutive_failures: number;
  /** 阈值（连续失败多少次会短路） */
  threshold: number;
  /** 熔断打开时刻 */
  opened_at: string | null;
  /** 下次自动探测时刻 */
  next_probe_at: string | null;
  /** 一句人话说明（信息科看这一行就够） */
  note: string;
}

/** doctor 输出 */
export interface DoctorReport {
  generated_at: string;
  /** 台账文件路径 */
  ledger_db_path: string;
  /** 三路通道体检 */
  channels: ChannelReport[];
  /** 两路事件来源体检（扫码枪 HTTP / RFID 目录投递） */
  sources: SourceReport[];
  /**
   * 各路近况：**最近一次成功 / 最近一次失败 / 最近一个错误码**。
   *
   * 通道体检那一栏回答「凭据位齐否」，这一栏回答「这一路最近是在正常干活，
   * 还是在出问题」。三样一起给，光看「末次成功时间」会把三个月前成功过一次的
   * 死路当成活的。
   */
  channel_health: ChannelHealthRow[];
  /**
   * 主动探测结论（**只在 `doctor --probe` 时有内容**，默认空数组）。
   *
   * 默认不探测：`doctor` 平时是**只读**体检，不连接任何外部系统。
   * 加 `--probe` 才会真的敲一次 HIS 计费侧（空批次，不产生计费明细）、
   * 连一下监听端口、解析一次 webhook 域名。
   */
  probes: ChannelProbeResult[];
  /** 末次收到扫码事件的时间 */
  last_event_at: string | null;
  /** 末次计费回写的时间 */
  last_charge_at: string | null;
  /** 企微推送失败次数 */
  notify_failures: number;
  /**
   * 入站重放防护的现状（三层的第一、二层）。
   *
   * 这一栏回答「有没有人在抓包重投」—— 手术室里的重放不会有人来报障，
   * 只看台账看不出「刚才有一批被挡下了」，这里能一眼看到被挡了几次。
   */
  replay_guard: {
    /** 当前存着的 nonce 条数（含已过期但还没清理的） */
    nonce_rows: number;
    /** 已过期但还没清理的条数（清理周期会收掉） */
    nonce_expired_rows: number;
    /** 累计被挡下的重放次数 */
    replay_rejections: number;
    /** 累计入站拒绝次数（含签名不符 / 过期 / 缺 nonce） */
    inbound_rejections: number;
    /** 时间戳容差窗口（秒） */
    timestamp_tolerance_sec: number;
    /** nonce 存活时长（秒） */
    nonce_ttl_sec: number;
    /** 最近一次 nonce 的过期时刻 */
    last_nonce_expires_at: string | null;
  };
  /**
   * 出站计费通道的熔断状态。
   *
   * 守护进程连着敲 HIS 计费侧一直失败时会自动短路（期间不外发，条目留在
   * 重投队列里）。这一栏让信息科**不用翻日志**就知道「现在是不是熔断着、
   * 下次什么时候自动探测」，以及「哪些耗材正卡在待重投上」。
   */
  outbound_circuit: CircuitReport;
  /** 各类计数 */
  counters: {
    ledger_rows: number;
    charge_receipts: number;
    check_total: number;
    check_pending: number;
    audit_rows: number;
    events: number;
  };
  /** 审计链完整性体检结论 */
  audit_integrity: { intact: boolean; rows: number; issues: string[] };
  /**
   * 审计链**哈希链**校验结论（逐行重算 + 接续比对）。
   *
   * 与 audit_integrity 互补：那一栏查「行号连续 / 时间不倒序 / 事件类型非空」，
   * 这一栏查「内容有没有被改过」—— 断点行号当场指出。
   */
  chain_integrity: {
    intact: boolean;
    rows: number;
    checked_at: string;
    first_break: ChainBreak | null;
    issues: string[];
  };
  /**
   * 最近一条心跳（守护进程写的自身状态）。
   *
   * 没有心跳 = 守护进程没在跑（或刚起还没写第一条）。这一栏让信息科一眼看出
   * 「现在到底有没有人在处理扫码」，不用去翻日志。
   */
  heartbeat: HeartbeatRecord | null;
  /**
   * 周期运行摘要（与 summary 子命令共用同一份实现）。
   * 数字全部从台账与审计链读 —— 进程重启后照样对得上。
   */
  run_summary: RunSummary;
  /**
   * 当前待核查条目按**统一错误码**分组。
   *
   * 这一栏直接回答信息科的两个问题：「现在卡着的是哪几类问题」与
   * 「每类该找谁处置」——处置口径见 docs/api/errors.md。
   */
  pending_by_error_code: Array<{
    error_code: string;
    meaning_zh: string;
    count: number;
    needs_manual: boolean;
  }>;
  /**
   * 当前待核查条目按**责任岗位**分组。
   *
   * 这一栏回答的是「**现在该找谁**」：责任岗位由异常类型定（路由表见
   * `docs/api/check-routing.md`），台次科室决定落到哪个科室的岗位。
   * 科室交办时不用再逐条翻台账找人 —— 这一栏就是分派清单。
   */
  pending_by_assignee: Array<{
    /** 责任岗位（基础岗位名） */
    assignee_role: string;
    /** 该岗位待处理条数 */
    count: number;
    /** 其中已经提醒过（催过一次）的条数 */
    reminded: number;
    /** 其中已经升级过的条数 */
    escalated: number;
    /** 涉及的科室（去重后排序） */
    depts: string[];
  }>;
  /**
   * 耗材主数据**待补录清单**（单位口径缺项 / 不自洽）。
   *
   * 与上一栏是两件事：
   *   - `pending_by_error_code` 是**某一台手术的某一条耗材**卡住了（核查任务）；
   *   - 这一栏是**某一条耗材主数据**本身缺登记（包装单位 / 最小单位 / 计价单位 /
   *     换算系数）—— 补好了，那一类扫码会自己好起来，不用逐台手术去人工核。
   *
   * 列在这里是因为「耗材管理岗」不看核查任务台账，他们看的是主数据这张表。
   */
  master_data_gaps: {
    /** 待补录条数 */
    pending: number;
    /** 已补录销项条数 */
    resolved: number;
    /** 待补录条目明细 */
    items: Array<{
      material_code: string;
      gap_type: string;
      detail: string | null;
      detected_at: string;
    }>;
  };
  /**
   * **主数据当前状态**：版本号、最近导入时间、导入前后行数与最近几次导入履历。
   *
   * 主数据天天在变（新耗材建档、耗材停用、临时加台、提前关台），而判定是
   * **导入即生效、不重启**的 —— 所以「现在用的是哪一版主数据」必须能一眼查到，
   * 否则出现「价码不对」时没人说得清是哪一版判的。
   */
  master_data: {
    /** 当前主数据版本号 */
    version: number;
    /** 最近一次导入时间 */
    last_import_at: string | null;
    /** 最近一次导入来源（cli / daemon_watch / demo） */
    last_import_source: string | null;
    /** 当前台次镜像行数 */
    operations_rows: number;
    /** 当前耗材主数据镜像行数 */
    materials_rows: number;
    /** 最近几次导入履历（新的在前） */
    imports: Array<{
      version: number;
      imported_at: string;
      source: string;
      operations: { rows: number; before: number; after: number; inserted: number; updated: number; skipped: number };
      materials: { rows: number; before: number; after: number; inserted: number; updated: number; skipped: number };
      /** 逐条跳过原因 */
      skips: Array<{ table: string; line: number; key: string; reason: string }>;
    }>;
  };
}

/** 端点脱敏：去掉凭据与 query，只留协议 + 主机 + 路径 */
export function safeEndpoint(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (raw.length === 0) return null;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '已配置（地址格式无法解析）';
  }
}

/** 各路的端点环境变量 */
const CHANNEL_ENDPOINTS: Readonly<Record<Channel, string>> = {
  inbound: 'OR_SCANNER_BASE_URL',
  outbound: 'HIS_CHARGING_BASE_URL',
  notify: 'WECOM_WEBHOOK_URL',
};

/** doctor 的输入 */
export interface DoctorOptions {
  /** 台账文件路径（展示用） */
  ledger_db_path?: string | null;
}

/**
 * doctor：常驻进程的体检单。
 *
 * 只回答「哪一路不通、末次收到东西是什么时候、还有多少条目没闭环」，
 * **不显示任何凭据明文**。
 */
export function runDoctor(
  db: DatabaseSync,
  env: EnvSnapshot = process.env,
  options: DoctorOptions = {},
): DoctorReport {
  const channels: ChannelReport[] = allChannelStatus(env).map((status) => ({
    channel: status.channel,
    label: CHANNEL_LABELS[status.channel],
    ready: status.ready,
    missing: [...status.missing],
    endpoint: safeEndpoint(env[CHANNEL_ENDPOINTS[status.channel]]),
  }));

  const lastCharge = db
    .prepare('SELECT responded_at, created_at FROM charge_receipt ORDER BY id DESC LIMIT 1')
    .get() as { responded_at: string | null; created_at: string } | undefined;

  const notifyFailures = db
    .prepare("SELECT COUNT(*) AS n FROM notify_delivery WHERE status = 'failed'")
    .get() as { n: number };

  const checkCounts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM check_task`,
    )
    .get() as { total: number; pending: number | null };

  const receipts = db.prepare('SELECT COUNT(*) AS n FROM charge_receipt').get() as { n: number };
  const auditRows = db.prepare('SELECT COUNT(*) AS n FROM audit_chain').get() as { n: number };

  // 两路事件来源各体检一次：扫码枪路看入站凭据位，目录路看投递目录可读不可读。
  const inboxDir = readSettings(env).scanInboxDir;
  const inboundReady = channels.find((channel) => channel.channel === 'inbound')?.ready === true;
  const sourceRows = db
    .prepare(
      `SELECT source, COUNT(*) AS events, MAX(received_at) AS last_event_at
         FROM scan_event GROUP BY source ORDER BY source ASC`,
    )
    .all() as unknown as Array<{ source: string; events: number; last_event_at: string | null }>;

  const sourceStats = (source: string): { events: number; last_event_at: string | null } => {
    const row = sourceRows.find((item) => item.source === source);
    return { events: row?.events ?? 0, last_event_at: row?.last_event_at ?? null };
  };

  const rfidReady = directoryReadable(inboxDir);
  const sources: SourceReport[] = [
    {
      source: 'scanner_http',
      label: '扫码枪 HTTP 接入',
      ready: inboundReady,
      note: inboundReady ? '凭据位齐备' : '入站凭据位不齐（见通道体检）',
      ...sourceStats('scanner_http'),
    },
    {
      source: 'rfid_dir',
      label: 'RFID 网关目录投递',
      ready: rfidReady,
      note: rfidReady ? `投递目录可读：${inboxDir}` : `投递目录不可读：${inboxDir}`,
      ...sourceStats('rfid_dir'),
    },
  ];

  // 待核查条目按统一错误码分组：卡着的是哪几类问题，一眼看清
  const pendingByCode = db
    .prepare(
      `SELECT COALESCE(error_code, 'ERR_UNKNOWN') AS error_code, COUNT(*) AS count
         FROM check_task WHERE status = 'pending'
        GROUP BY error_code ORDER BY count DESC, error_code ASC`,
    )
    .all() as unknown as Array<{ error_code: string; count: number }>;

  // 待核查条目按责任岗位分组：现在该找谁 —— 科室交办时不用逐条翻台账
  const pendingByAssignee = (
    db
      .prepare(
        `SELECT COALESCE(assignee_role, '（尚未分派）') AS assignee_role,
                COUNT(*) AS count,
                SUM(CASE WHEN reminded_at IS NOT NULL THEN 1 ELSE 0 END) AS reminded,
                SUM(CASE WHEN escalated_at IS NOT NULL THEN 1 ELSE 0 END) AS escalated,
                GROUP_CONCAT(DISTINCT dept_code) AS depts
           FROM check_task WHERE status = 'pending'
          GROUP BY assignee_role ORDER BY count DESC, assignee_role ASC`,
      )
      .all() as unknown as Array<{
      assignee_role: string;
      count: number;
      reminded: number | null;
      escalated: number | null;
      depts: string | null;
    }>
  ).map((row) => ({
    assignee_role: row.assignee_role,
    count: row.count,
    reminded: row.reminded ?? 0,
    escalated: row.escalated ?? 0,
    depts: (row.depts ?? '')
      .split(',')
      .map((dept) => dept.trim())
      .filter((dept) => dept.length > 0)
      .sort(),
  }));

  // 出站熔断状态：守护进程把状态落在台账 meta 表里，doctor 直接读
  const circuit = loadCircuitSnapshot(db);
  const outbound_circuit: CircuitReport = circuit
    ? {
        state: circuit.state,
        label: CIRCUIT_STATE_LABELS[circuit.state],
        is_open: circuit.state !== 'closed',
        consecutive_failures: circuit.consecutive_failures,
        threshold: circuit.threshold,
        opened_at: circuit.opened_at,
        next_probe_at: circuit.next_probe_at,
        note:
          circuit.state === 'closed'
            ? `通道正常（连续失败 ${circuit.consecutive_failures} 次 / 阈值 ${circuit.threshold}）`
            : `已短路，不再向 HIS 计费侧发请求；条目留在重投队列里，${
                circuit.next_probe_at ? `${circuit.next_probe_at} 自动探测` : '通道恢复后自动探测'
              }`,
      }
    : {
        state: 'unknown',
        label: '尚未记录',
        is_open: false,
        consecutive_failures: 0,
        threshold: CIRCUIT_DEFAULTS.failureThreshold,
        opened_at: null,
        next_probe_at: null,
        note: '守护进程还没上报过熔断状态（未跑过出站计费或台账里没有这一项）',
      };

  return {
    generated_at: new Date().toISOString(),
    ledger_db_path: options.ledger_db_path ?? '（台账库）',
    channels,
    sources,
    channel_health: runChannelHealth(db, env),
    probes: [],
    last_event_at: lastEventAt(db),
    last_charge_at: lastCharge?.responded_at ?? lastCharge?.created_at ?? null,
    notify_failures: notifyFailures.n,
    replay_guard: (() => {
      const settings = readSettings(env);
      return {
        nonce_rows: countNonces(db),
        nonce_expired_rows: countExpiredNonces(db),
        replay_rejections: countAuditByType(db, 'inbound_replay_rejected'),
        inbound_rejections: countAuditByType(db, 'inbound_rejected'),
        timestamp_tolerance_sec: settings.scannerTimestampToleranceSec,
        nonce_ttl_sec: settings.scannerNonceTtlSec,
        last_nonce_expires_at: lastNonceExpiry(db),
      };
    })(),
    outbound_circuit,
    counters: {
      ledger_rows: countBindings(db),
      charge_receipts: receipts.n,
      check_total: checkCounts.total ?? 0,
      check_pending: checkCounts.pending ?? 0,
      audit_rows: auditRows.n,
      events: countEventLog(db),
    },
    audit_integrity: (() => {
      const integrity = verifyAuditIntegrity(db);
      return { intact: integrity.intact, rows: integrity.rows, issues: integrity.issues };
    })(),
    chain_integrity: (() => {
      const chain = verifyChain(db);
      return {
        intact: chain.intact,
        rows: chain.rows,
        checked_at: chain.checked_at,
        first_break: chain.first_break,
        issues: chain.issues,
      };
    })(),
    heartbeat: readHeartbeat(db),
    run_summary: collectRunSummary(db),
    pending_by_error_code: pendingByCode.map((row) => {
      const entry = describeErrorCode(row.error_code);
      return {
        error_code: row.error_code,
        meaning_zh: entry.meaning_zh,
        count: row.count,
        needs_manual: entry.needs_manual,
      };
    }),
    pending_by_assignee: pendingByAssignee,
    master_data_gaps: (() => {
      const summary = masterDataGapSummary(db);
      return {
        pending: summary.pending,
        resolved: summary.resolved,
        items: summary.items.map((gap) => ({
          material_code: gap.material_code,
          gap_type: gap.gap_type,
          detail: gap.detail,
          detected_at: gap.detected_at,
        })),
      };
    })(),
    master_data: (() => {
      const state = masterDataState(db);
      return {
        version: state.version,
        last_import_at: state.last_import_at,
        last_import_source: state.last_import_source,
        operations_rows: state.operations_rows,
        materials_rows: state.materials_rows,
        imports: listMasterDataImports(db, 5).map((record) => ({
          version: record.version,
          imported_at: record.imported_at,
          source: record.source,
          operations: {
            rows: record.operation_rows,
            before: record.operations_before,
            after: record.operations_after,
            inserted: record.operation_inserted,
            updated: record.operation_updated,
            skipped: record.operation_skipped,
          },
          materials: {
            rows: record.material_rows,
            before: record.materials_before,
            after: record.materials_after,
            inserted: record.material_inserted,
            updated: record.material_updated,
            skipped: record.material_skipped,
          },
          skips: record.skips.map((skip) => ({
            table: skip.table,
            line: skip.line,
            key: skip.key,
            reason: skip.reason,
          })),
        })),
      };
    })(),
  };
}

/** 投递目录现在可读吗（目录路就绪与否只看这一条） */
export function directoryReadable(dirPath: string): boolean {
  try {
    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 审计链校验结论的一行中文摘要。
 *
 * 完整的时候说「覆盖多少行、什么时候校验的」；
 * 断链的时候直接给断点行号 —— 信息科照着这一行就能去查那一行。
 */
export function formatChainConclusion(chain: {
  intact: boolean;
  rows: number;
  checked_at: string;
  first_break: { row_no: number; row_id: number; message: string } | null;
  issues: string[];
}): string {
  if (chain.intact) {
    return `审计链校验：完整（覆盖 ${chain.rows} 行，校验时间 ${chain.checked_at}）`;
  }
  const first = chain.first_break;
  const where = first
    ? `断点在第 ${first.row_no} 行（id=${first.row_id}）：${first.message}`
    : `发现 ${chain.issues.length} 处问题`;
  return `审计链校验：发现 ${chain.issues.length} 处问题 —— ${where}`;
}

/* ------------------------------------------------------------ doctor 主动探测 */

/** doctor 主动探测的输入 */
export interface DoctorProbeOptions extends DoctorOptions {
  /** 要不要真的探测（默认 false —— doctor 平时是只读体检） */
  probe?: boolean;
  /** 探测超时（毫秒） */
  probeTimeoutMs?: number;
}

/**
 * doctor 的完整结论：本地体检 + （可选）主动探测。
 *
 * 分成两档是刻意的：
 *   - **默认**（`probe` 不为 true）：只读本地台账与配置，**不连接任何外部系统**；
 *   - **--probe**：加一次主动探测 —— 出站发空批次健康检查（不产生计费明细）、
 *     入站连一下监听端口与投递目录、推送侧解析域名并连端口（不发业务消息）。
 */
export async function runDoctorWithProbes(
  db: DatabaseSync,
  env: EnvSnapshot = process.env,
  options: DoctorProbeOptions = {},
): Promise<DoctorReport> {
  const report = runDoctor(db, env, options);
  if (options.probe !== true) return report;
  const probes = await probeAllChannels({
    env,
    settings: readSettings(env),
    timeoutMs: options.probeTimeoutMs,
  });
  return { ...report, probes };
}

/** 探测结论档位的中文说法 */
const PROBE_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  ok: '探测通过',
  unreachable: '通道不通',
  rejected: '对端拒收',
  skipped: '未探测',
};

/**
 * doctor 的人类可读输出（终端看的那一份）。
 *
 * 分段顺序与信息科排障的顺序一致：
 *   ① 通道体检（凭据位齐否）→ ② 各路近况（最近成功 / 失败 / 错误码）
 *   → ③ 主动探测（加了 --probe 才有）→ ④ 事件来源 → ⑤ 运行状态
 *   → ⑥ 熔断 → ⑦ 主数据 → ⑧ 待核查分派
 */
export function renderDoctorText(report: DoctorReport): string {
  const lines: string[] = [];

  lines.push('== 通道体检 ==');
  for (const channel of report.channels) {
    const status = channel.ready ? '齐备' : `缺 ${channel.missing.join('、')}`;
    lines.push(
      `  ${channel.label.padEnd(16)} ${status.padEnd(24)} 端点=${channel.endpoint ?? '未配置'}`,
    );
  }

  lines.push('');
  lines.push('== 各路近况 ==');
  for (const health of report.channel_health) {
    const code = health.last_error_code
      ? `${health.last_error_code} ${health.last_error_code_zh}`.trim()
      : '—';
    lines.push(
      `  ${health.label.padEnd(16)} 最近成功=${health.last_success_at ?? '（还没有）'}` +
        `　最近失败=${health.last_failure_at ?? '（还没有）'}　错误码=${code}`,
    );
    lines.push(`    ${health.note}`);
  }

  if (report.probes.length > 0) {
    lines.push('');
    lines.push('== 主动探测 ==');
    for (const probe of report.probes) {
      const label = PROBE_OUTCOME_LABELS[probe.outcome] ?? probe.outcome;
      lines.push(
        `  ${probe.label.padEnd(16)} ${label.padEnd(8)} 状态码=${probe.status ?? '—'}` +
          `　错误码=${probe.error_code ?? '—'}　耗时=${probe.duration_ms}ms　${probe.checked_at}`,
      );
      lines.push(`    ${probe.detail}`);
      for (const check of probe.checks) {
        lines.push(`    - ${check.name}：${check.ok ? '通过' : '不通过'}　${check.detail}`);
      }
    }
  }

  lines.push('');
  lines.push('== 事件来源 ==');
  for (const source of report.sources) {
    lines.push(
      `  ${source.label.padEnd(16)} ${(source.ready ? '可用' : '不可用').padEnd(8)} 收到 ${String(source.events).padStart(4)} 条  末次=${source.last_event_at ?? '—'}  ${source.note}`,
    );
  }

  lines.push('');
  lines.push('== 运行状态 ==');
  lines.push(`  末次收到扫码事件：${report.last_event_at ?? '（还没有收到过）'}`);
  lines.push(`  末次计费回写：    ${report.last_charge_at ?? '（还没有回写过）'}`);
  lines.push(`  企微推送失败次数：${report.notify_failures}`);
  lines.push(
    `  台账行数=${report.counters.ledger_rows} 回执行=${report.counters.charge_receipts} 待核查=${report.counters.check_pending} 审计行=${report.counters.audit_rows} 事件=${report.counters.events}`,
  );
  lines.push(
    `  入站拒绝=${report.replay_guard.inbound_rejections} 次（其中重放挡下 ${report.replay_guard.replay_rejections} 次）` +
      `　nonce 记录=${report.replay_guard.nonce_rows} 条（已过期待清理 ${report.replay_guard.nonce_expired_rows} 条）`,
  );
  lines.push(
    `  时间戳窗口=${report.replay_guard.timestamp_tolerance_sec}s　nonce 有效期=${report.replay_guard.nonce_ttl_sec}s` +
      `　最近一次 nonce 过期=${report.replay_guard.last_nonce_expires_at ?? '—'}`,
  );
  lines.push(
    `  审计链完整性：${report.audit_integrity.intact ? '通过' : '发现 ' + report.audit_integrity.issues.length + ' 处问题'}`,
  );
  for (const issue of report.audit_integrity.issues) lines.push(`    - ${issue}`);
  lines.push(`  ${formatChainConclusion(report.chain_integrity)}`);

  lines.push('');
  lines.push('== 守护进程心跳 ==');
  lines.push(`  ${formatHeartbeat(report.heartbeat)}`);

  lines.push('');
  lines.push('== 出站计费通道熔断状态 ==');
  lines.push(
    `  状态：${report.outbound_circuit.label}　连续失败 ${report.outbound_circuit.consecutive_failures} 次 / 阈值 ${report.outbound_circuit.threshold}`,
  );
  lines.push(`  ${report.outbound_circuit.note}`);
  lines.push(
    `  熔断打开：${report.outbound_circuit.opened_at ?? '—'}　下次自动探测：${report.outbound_circuit.next_probe_at ?? '—'}`,
  );

  lines.push('');
  lines.push('== 主数据 ==');
  lines.push(
    `  当前第 ${report.master_data.version} 版　最近导入 ${report.master_data.last_import_at ?? '（还没有导入过）'}` +
      `${report.master_data.last_import_source ? `（${report.master_data.last_import_source}）` : ''}`,
  );
  lines.push(
    `  镜像行数：排台台次 ${report.master_data.operations_rows}　耗材主数据 ${report.master_data.materials_rows}`,
  );
  for (const record of report.master_data.imports) {
    lines.push(
      `  第 ${record.version} 版 ${record.imported_at}（${record.source}）：` +
        `排台 ${record.operations.before}→${record.operations.after}（新增 ${record.operations.inserted} / 更新 ${record.operations.updated} / 跳过 ${record.operations.skipped}）　` +
        `耗材 ${record.materials.before}→${record.materials.after}（新增 ${record.materials.inserted} / 更新 ${record.materials.updated} / 跳过 ${record.materials.skipped}）`,
    );
    for (const skip of record.skips.slice(0, 10)) {
      lines.push(
        `    跳过 ${skip.table === 'operation' ? '排台' : '耗材'} 第 ${skip.line} 行　${skip.key || '（无主键）'}　${skip.reason}`,
      );
    }
  }

  if (report.pending_by_error_code.length > 0) {
    lines.push('');
    lines.push('== 待核查条目按错误码 ==');
    for (const row of report.pending_by_error_code) {
      lines.push(`  ${row.error_code.padEnd(32)} ${String(row.count).padStart(4)} 条  ${row.meaning_zh}`);
    }
    lines.push('  处置口径见 docs/api/errors.md');
  }

  if (report.pending_by_assignee.length > 0) {
    lines.push('');
    lines.push('== 待核查条目按责任岗位 ==');
    for (const row of report.pending_by_assignee) {
      const deptText = row.depts.length > 0 ? `  科室 ${row.depts.join('、')}` : '';
      lines.push(
        `  ${row.assignee_role.padEnd(12)} ${String(row.count).padStart(4)} 条` +
          `  已催 ${row.reminded}　已升级 ${row.escalated}${deptText}`,
      );
    }
    lines.push('  路由口径见 docs/api/check-routing.md');
  }

  if (report.master_data_gaps.pending > 0) {
    lines.push('');
    lines.push('== 耗材主数据待补录（单位口径 / 费用口径） ==');
    lines.push(
      `  待补录 ${report.master_data_gaps.pending} 条，已销项 ${report.master_data_gaps.resolved} 条`,
    );
    for (const gap of report.master_data_gaps.items) {
      lines.push(`  ${gap.material_code.padEnd(24)} ${gap.gap_type.padEnd(28)} ${gap.detail ?? ''}`);
    }
    lines.push('  补录主数据后重新导入即自动销项；口径见 docs/api/units.md 与 docs/api/fee-category.md');
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ replay */

/**
 * replay 的实现搬到 `src/cli/replay.ts`（区间选择 / 快照 / 差异表 / 不变式验证）。
 *
 * 这里原样再导出，**引用路径不变** —— 既有调用方（CLI 入口、单测）不用改。
 */
export {
  runReplay,
  loadBatchesFromFile,
  replayEventRows,
  selectReplayEvents,
  captureReplaySnapshot,
  diffReplaySnapshots,
  runReplayWithDiff,
  replayIntervalSlug,
  replayIntervalLabel,
  defaultReplayDiffPath,
  writeReplayDiff,
  renderReplayDiffText,
  type ReplayOptions,
  type ReplayBatchResult,
  type ReplayReport,
  type ReplayInterval,
  type ReplaySelection,
  type ReplaySnapshot,
  type ReplayDiff,
  type ReplayDiffRow,
  type ReplayDistributionRow,
  type ReplayInvariant,
  type ReplayWithDiffOptions,
} from './replay.js';

/* ------------------------------------------------------------------ ledger */

/** 台账查询条件 */
export interface LedgerQueryOptions {
  /** 按台次过滤 */
  operation_no?: string | null;
  /** 按条目状态过滤（bound / charged / check_pending / closed ...） */
  status?: string | null;
  /** 按耗材码过滤 */
  material_code?: string | null;
  /** 最多取多少行 */
  limit?: number;
}

/** 台账行视图 */
export interface LedgerRowView {
  operation_no: string;
  room_no: string;
  dept_code: string;
  material_code: string;
  quantity: number;
  price_code: string | null;
  fee_category: string | null;
  medical_insurance_class: string | null;
  conclusion: string;
  status: string;
  check_task_id: number | null;
  charge_state: string;
  created_at: string;
}

/** 台账查询结果 */
export interface LedgerQueryResult {
  rows: LedgerRowView[];
  /** 命中的总行数（不受 limit 影响） */
  total: number;
  limit: number;
}

/** 该条目的计费状态（按回执台账推导） */
function chargeStateOf(
  db: DatabaseSync,
  material_code: string,
  operation_no: string,
): string {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS attempts,
              SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN accepted = 0 AND retryable = 1 THEN 1 ELSE 0 END) AS retryable
         FROM charge_receipt
        WHERE material_code = ? AND operation_no = ?`,
    )
    .get(material_code, operation_no) as { attempts: number; accepted: number | null; retryable: number | null };
  if ((row.accepted ?? 0) > 0) return 'accepted';
  if ((row.retryable ?? 0) > 0) return 'pending_retry';
  if ((row.attempts ?? 0) > 0) return 'rejected';
  return 'not_submitted';
}

/** ledger：耗材使用台账查询 */
export function runLedgerQuery(db: DatabaseSync, options: LedgerQueryOptions = {}): LedgerQueryResult {
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : 100;
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.operation_no) {
    where.push('operation_no = ?');
    params.push(options.operation_no);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.material_code) {
    where.push('material_code = ?');
    params.push(options.material_code);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM material_binding ${clause}`).get(...params) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT operation_no, room_no, dept_code, material_code, quantity, price_code, fee_category,
              medical_insurance_class, conclusion, status, check_task_id, created_at
         FROM material_binding ${clause}
        ORDER BY id ASC LIMIT ?`,
    )
    .all(...params, limit) as unknown as Array<Omit<LedgerRowView, 'charge_state'>>;

  return {
    rows: rows.map((row) => ({
      ...row,
      charge_state: chargeStateOf(db, row.material_code, row.operation_no),
    })),
    total,
    limit,
  };
}

/* -------------------------------------------------------------------- pack */

/**
 * 核查包导出字段白名单。
 *
 * 只有台次上下文、绑定结论、原因码、计费回执与人工结论 —— **没有任何患者标识字段**
 * （耗材码只绑手术台次，不落患者可识别明细）。
 */
export const PACK_EXPORT_FIELDS = [
  'check_task_id',
  'operation_no',
  'room_no',
  'dept_code',
  'scanner_id',
  'material_code',
  'quantity',
  'conclusion',
  'reason_code',
  'check_status',
  'assignee_role',
  'detected_at',
  'binding_status',
  'charge_state',
  'receipt_attempt',
  'receipt_delivery_count',
  'receipt_kind',
  'receipt_reason_code',
  'receipt_error_code',
  'receipt_channel_reachable',
  'receipt_responded_at',
  'confirmed_by',
  'confirmed_conclusion',
  'confirmed_at',
  'revoked_at',
  'revoked_by',
  'source_operation_no',
  'source_room_no',
  'master_room_no',
  'event_dept_code',
] as const;

/** 核查包行 */
export type PackRow = Record<(typeof PACK_EXPORT_FIELDS)[number], string | number | null>;

/** pack 的输入 */
export interface PackOptions {
  /** 只导出某个台次的核查条目 */
  operation_no?: string | null;
  /** 只导出某种核查状态（pending / closed） */
  status?: string | null;
  /** 最多导出多少条 */
  limit?: number;
}

/** 核查包 */
export interface PackExport {
  generated_at: string;
  /** 导出字段（白名单） */
  fields: Array<(typeof PACK_EXPORT_FIELDS)[number]>;
  rows: PackRow[];
  /** 命中的总条数 */
  total: number;
  /**
   * 审计链校验结论（随核查包一起交出去）。
   *
   * 内审 / 飞检要的不只是「这几条耗材待核查」，还要「这份台账没被人动过」——
   * 所以核查包附上哈希链校验结论：链是否完整、覆盖多少行、什么时候校验的，
   * 断点的话直接给出断点行号。
   */
  audit_chain: {
    intact: boolean;
    rows: number;
    checked_at: string;
    first_break: ChainBreak | null;
    issues: string[];
  };
}

/** pack：导出核查包（台次上下文 + 结论 + reason_code + 回执 + 人工结论） */
export function runPack(db: DatabaseSync, options: PackOptions = {}): PackExport {
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : 500;
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.operation_no) {
    where.push('t.operation_no = ?');
    params.push(options.operation_no);
  }
  if (options.status) {
    where.push('t.status = ?');
    params.push(options.status);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM check_task t ${clause}`).get(...params) as { n: number }
  ).n;

  const tasks = db
    .prepare(
      `SELECT t.id, t.operation_no, t.room_no, t.dept_code, t.scanner_id, t.material_code, t.quantity,
              t.conclusion, t.reason_code, t.status, t.assignee_role, t.detected_at,
              t.confirmed_by, t.confirmed_conclusion, t.confirmed_at, t.revoked_at, t.revoked_by,
              t.source_operation_no, t.source_room_no,
              t.master_room_no, t.event_dept_code,
              b.status AS binding_status
         FROM check_task t
         LEFT JOIN material_binding b ON b.id = t.binding_id
         ${clause}
        ORDER BY t.detected_at ASC, t.id ASC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as Array<{
      id: number;
      operation_no: string;
      room_no: string;
      dept_code: string | null;
      scanner_id: string | null;
      material_code: string;
      quantity: number | null;
      conclusion: string;
      reason_code: string;
      status: string;
      assignee_role: string | null;
      detected_at: string;
      confirmed_by: string | null;
      confirmed_conclusion: string | null;
      confirmed_at: string | null;
      revoked_at: string | null;
      revoked_by: string | null;
      source_operation_no: string | null;
      source_room_no: string | null;
      master_room_no: string | null;
      event_dept_code: string | null;
      binding_status: string | null;
    }>;

  const rows: PackRow[] = tasks.map((task) => {
    const receipt = db
      .prepare(
        `SELECT attempt, delivery_count, kind, reason_code, error_code, channel_reachable, responded_at
           FROM charge_receipt
          WHERE material_code = ? AND operation_no = ?
          ORDER BY attempt DESC, id DESC LIMIT 1`,
      )
      .get(task.material_code, task.operation_no) as
      | {
          attempt: number;
          delivery_count: number;
          kind: string | null;
          reason_code: string | null;
          error_code: string | null;
          channel_reachable: number | null;
          responded_at: string | null;
        }
      | undefined;

    const chargeState = receipt
      ? receipt.channel_reachable === 1 && receipt.kind === 'ACCEPTED'
        ? 'accepted'
        : receipt.kind === 'CHANNEL_UNREACHABLE' || receipt.kind === 'CHANNEL_ERROR'
          ? 'pending_retry'
          : 'rejected'
      : 'not_submitted';

    return {
      check_task_id: task.id,
      operation_no: task.operation_no,
      room_no: task.room_no,
      dept_code: task.dept_code ?? '',
      scanner_id: task.scanner_id ?? '',
      material_code: task.material_code,
      quantity: task.quantity ?? 0,
      conclusion: task.conclusion,
      reason_code: task.reason_code,
      check_status: task.status,
      assignee_role: task.assignee_role ?? '',
      detected_at: task.detected_at,
      binding_status: task.binding_status ?? '',
      charge_state: chargeState,
      receipt_attempt: receipt?.attempt ?? 0,
      receipt_delivery_count: receipt?.delivery_count ?? 0,
      receipt_kind: receipt?.kind ?? '',
      receipt_reason_code: receipt?.reason_code ?? '',
      receipt_error_code: receipt?.error_code ?? '',
      receipt_channel_reachable: receipt?.channel_reachable ?? null,
      receipt_responded_at: receipt?.responded_at ?? '',
      confirmed_by: task.confirmed_by ?? '',
      confirmed_conclusion: task.confirmed_conclusion ?? '',
      confirmed_at: task.confirmed_at ?? '',
      revoked_at: task.revoked_at ?? '',
      revoked_by: task.revoked_by ?? '',
      source_operation_no: task.source_operation_no ?? '',
      source_room_no: task.source_room_no ?? '',
      // 归属双因子核对的两侧：room_no 是事件侧，master_room_no 是排台侧
      master_room_no: task.master_room_no ?? '',
      event_dept_code: task.event_dept_code ?? '',
    };
  });

  const chain = verifyChain(db);

  return {
    generated_at: new Date().toISOString(),
    fields: [...PACK_EXPORT_FIELDS],
    rows,
    total,
    audit_chain: {
      intact: chain.intact,
      rows: chain.rows,
      checked_at: chain.checked_at,
      first_break: chain.first_break,
      issues: chain.issues,
    },
  };
}

/** CSV 字段转义 */
function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/* ------------------------------------------------------------- reconcile */

/**
 * reconcile：对账差异台账（台账 ↔ 计费回执逐条对齐）。
 *
 * 护士长与高值耗材管理岗最想知道的不是「扫了多少」，而是
 * 「**哪些耗材没有生成计费**」—— 这个子命令把那句话变成一张可导出的差异清单。
 */
export function runReconcile(
  db: DatabaseSync,
  options: {
    operation_no?: string | null;
    material_code?: string | null;
    limit?: number;
    status?: string | null;
    /** 只读盘点：不把差异落进差异台账 */
    dry_run?: boolean;
  } = {},
): ReconcileReport {
  const report = reconcileLedgerVsReceipts(db, {
    operation_no: options.operation_no ?? null,
    material_code: options.material_code ?? null,
    limit: options.limit,
    persist: options.dry_run !== true,
  });
  if (options.status) {
    report.diffs = listDiffs(db, {
      operation_no: options.operation_no ?? null,
      material_code: options.material_code ?? null,
      status: options.status,
    });
  }
  return report;
}

/** 差异行 → 表格行 */
export function reconcileRowToCells(row: ReconcileDiffRow): (string | number)[] {
  return [
    row.operation_no,
    row.material_code,
    row.diff_type,
    row.attribution,
    row.mismatched_fields ? row.mismatched_fields.slice(0, 60) : '',
    row.status,
    row.check_task_id ?? '',
  ].map((value) => (value === null ? '' : value));
}

/** 把核查包转成 CSV 文本（字段顺序 = 白名单顺序） */
export function packToCsv(pack: PackExport): string {
  const header = pack.fields.join(',');
  const lines = pack.rows.map((row) => pack.fields.map((field) => csvCell(row[field])).join(','));
  return [header, ...lines].join('\n');
}

/* ----------------------------------------------------------------- summary */

/** summary 输出 */
export interface SummaryReport {
  generated_at: string;
  /** 台账行数 */
  ledger_rows: number;
  /** 按条目状态分布 */
  by_status: Array<{ status: string; count: number }>;
  /** 按绑定结论分布（BOUND 来自台账，异常来自核查条目） */
  by_conclusion: Array<{ conclusion: string; count: number }>;
  /** 计费回执统计 */
  charge: {
    attempts: number;
    accepted: number;
    rejected: number;
    unreachable: number;
    /** 计费成功率（accepted ÷ attempts） */
    success_rate: number;
    /** 重投总次数（超出首次投递的部分） */
    total_retries: number;
    /** 重投次数分布（投递了几次） */
    retry_distribution: Array<{ delivery_count: number; count: number }>;
  };
  /** 各路收到事件数 */
  events_by_source: Array<{ source: string; events: number; last_event_at: string | null }>;
  /** 核查条目 */
  check: { total: number; pending: number; closed: number };
  /** 企微推送 */
  notify: { sent: number; failed: number; skipped: number };
  /** 事件日志 */
  events: number;
  /** 审计链 */
  audit_rows: number;
  /** 按台次汇总 */
  by_operation: Array<{ operation_no: string; rows: number; pending: number }>;
  /** 审计链完整性 */
  audit_integrity: { intact: boolean; issues: string[] };
}

/**
 * summary：批次与台次统计（数字全部从台账与审计链读，不靠内存计数）。
 *
 * 与 doctor **共用同一份摘要实现**（`src/log/summary.ts`）—— 不会出现
 * 「doctor 说 3 条待核查、summary 说 5 条」这种自相矛盾。
 */
export function runSummary(db: DatabaseSync, options: { operation_no?: string | null } = {}): SummaryReport {
  const operationFilter = options.operation_no ?? null;
  const run = collectRunSummary(db, { operation_no: operationFilter });

  const operationRows = db
    .prepare(
      `SELECT b.operation_no,
              COUNT(DISTINCT b.id) AS rows,
              COUNT(DISTINCT CASE WHEN t.status = 'pending' THEN t.id END) AS pending
         FROM material_binding b
         LEFT JOIN check_task t ON t.operation_no = b.operation_no
        ${operationFilter ? 'WHERE b.operation_no = ?' : ''}
        GROUP BY b.operation_no
        ORDER BY b.operation_no ASC
        LIMIT 200`,
    )
    .all(...(operationFilter ? [operationFilter] : [])) as unknown as Array<{
    operation_no: string;
    rows: number;
    pending: number;
  }>;

  const integrity = verifyAuditIntegrity(db);

  return {
    generated_at: run.generated_at,
    ledger_rows: run.ledger_rows,
    by_status: run.by_status,
    by_conclusion: run.by_conclusion,
    charge: {
      attempts: run.charge.attempts,
      accepted: run.charge.accepted,
      rejected: run.charge.rejected,
      unreachable: run.charge.unreachable,
      success_rate: run.charge.success_rate,
      total_retries: run.charge.total_retries,
      retry_distribution: run.charge.retry_distribution,
    },
    events_by_source: run.by_source,
    check: {
      total: run.check.total,
      pending: run.check.pending,
      closed: run.check.closed,
    },
    notify: {
      sent: run.notify.sent,
      failed: run.notify.failed,
      skipped: run.notify.skipped,
    },
    events: run.events,
    audit_rows: run.audit_rows,
    by_operation: operationRows,
    audit_integrity: { intact: integrity.intact, issues: integrity.issues },
  };
}

/* ------------------------------------------------------------------ 事件日志溯源 */

/** 事件回查条件 */
export interface EventTraceOptions {
  /** 按投递标识回查（一次扫码投递 = 一个标识） */
  request_id?: string | null;
  /** 按耗材码回查（原始码与院内码都能查） */
  material_code?: string | null;
  /** 按台次回查 */
  operation_no?: string | null;
  /** 按来源过滤 */
  source?: string | null;
  /** 最多回查多少条 */
  limit?: number;
}

/** 事件日志回查结果 */
export interface EventTraceReport {
  /** 回查方式（request / material / operation / source / all） */
  mode: string;
  /** 命中的事件行 */
  events: EventLogRow[];
  /** 三向回查（仅按投递标识时给出：事件 → 台账条目 → 审计链） */
  trace: RequestTrace | null;
  /** 事件日志总行数（对照：这次只回查了一部分） */
  total_events: number;
}

/**
 * events：事件日志溯源。
 *
 * 排障时信息科问的三个问题在这里一次问完：
 *   「设备到底报了什么」→ 事件行（原始报文逐字保留）
 *   「这一批落了哪些账」→ 台账条目
 *   「后来怎么处置的」→ 审计链
 * 三者靠同一个投递标识（request_id）串起来；
 * 手上只有耗材码时，也能反查这个码出现在哪几批事件里。
 */
export function runEventTrace(db: DatabaseSync, options: EventTraceOptions = {}): EventTraceReport {
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : 50;
  const requestId = (options.request_id ?? '').trim();
  const materialCode = (options.material_code ?? '').trim();
  const operationNo = (options.operation_no ?? '').trim();
  const source = (options.source ?? '').trim();

  let events: EventLogRow[];
  let mode: string;
  if (requestId.length > 0) {
    mode = 'request';
    events = listEventsByRequestId(db, requestId);
  } else if (materialCode.length > 0) {
    mode = 'material';
    events = listEventsByMaterialCode(db, materialCode, { limit });
  } else if (operationNo.length > 0 || source.length > 0) {
    mode = operationNo.length > 0 ? 'operation' : 'source';
    events = listEventLog(db, {
      limit,
      operation_no: operationNo.length > 0 ? operationNo : null,
      source: source.length > 0 ? source : null,
    });
  } else {
    mode = 'all';
    events = listEventLog(db, { limit });
  }

  return {
    mode,
    events,
    trace: requestId.length > 0 ? traceRequest(db, requestId) : null,
    total_events: countEventLog(db),
  };
}

/** events 的文本输出 */
export function renderEventTraceText(report: EventTraceReport): string {
  const lines: string[] = [];
  lines.push(`== 事件日志溯源（回查方式：${report.mode}）==`);
  lines.push(`  命中 ${report.events.length} 条 / 事件日志共 ${report.total_events} 条`);
  if (report.events.length === 0) {
    lines.push('  （没有命中任何事件）');
    return lines.join('\n');
  }
  for (const event of report.events) {
    lines.push(
      `  ${event.received_at}　${event.source}　台次 ${event.operation_no ?? '—'}　` +
        `手术间 ${event.room_no ?? '—'}　扫码枪 ${event.scanner_id ?? '—'}`,
    );
    lines.push(`    投递标识 ${event.request_id}　结论 ${event.conclusion ?? '—'}　签名 ${event.signature_verified ? '已验' : '无'}`);
    if (event.raw_body) {
      const preview = event.raw_body.length > 200 ? `${event.raw_body.slice(0, 200)}…` : event.raw_body;
      lines.push(`    原始报文 ${preview}`);
    }
  }

  const trace = report.trace;
  if (trace) {
    lines.push('== 三向回查（事件 → 台账条目 → 审计链）==');
    lines.push(`  台账条目 ${trace.bindings.length} 条`);
    for (const binding of trace.bindings) {
      lines.push(
        `    ${binding.material_code}　台次 ${binding.operation_no}　数量 ${binding.quantity}　` +
          `结论 ${binding.conclusion}　状态 ${binding.status}`,
      );
    }
    lines.push(`  审计链 ${trace.audit.length} 行`);
    for (const row of trace.audit) {
      lines.push(`    ${row.created_at}　${row.event_type}　${row.actor ?? '—'}　${row.detail ?? ''}`);
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ 附：审计链查询 */

/** 审计链分布（doctor / summary 之外的独立查询面） */
export { auditSummary, lastAuditAt };

/** 追加一条审计记录（供 CLI 的运维动作留痕；只增不改） */
export { appendAudit };


/* ------------------------------------------------------------------ 计费尝试史 */

/** 尝试史查询条件 */
export interface AttemptQueryOptions {
  /** 按台次过滤 */
  operation_no?: string | null;
  /** 按耗材码过滤 */
  material_code?: string | null;
  /** 时间窗起点（含，ISO 字符串） */
  from?: string | null;
  /** 时间窗终点（含，ISO 字符串） */
  to?: string | null;
  /** 最多取多少行 */
  limit?: number;
}

/** 尝试史查询结果 */
export interface AttemptQueryResult {
  /** 逐次尝试的明细行 */
  rows: ChargeReceiptRow[];
  /** 按条目汇总（试了几次、最后有没有计上） */
  summaries: AttemptSummary[];
  /** 命中的尝试总条数（未截断前） */
  total: number;
  /** 本次最多取多少行 */
  limit: number;
}

/**
 * 计费尝试史查询：**每一次投递尝试**一行。
 *
 * 三种口径：
 *   - 指定台次 → 取该台次全部尝试（按耗材码 → 尝试序号排）；
 *   - 指定耗材码 → 取该条耗材的全部尝试；
 *   - 指定时间窗 → 取窗口内的尝试。
 *
 * 口径可叠加（台次 + 耗材码 + 时间窗），叠加时按最窄的那一层取。
 * 只读子命令：不改任何业务状态。
 */
export function runAttemptQuery(
  db: DatabaseSync,
  options: AttemptQueryOptions = {},
): AttemptQueryResult {
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : 500;

  let rows: ChargeReceiptRow[];
  if (options.operation_no && options.material_code) {
    rows = loadReceipts(db, options.material_code, options.operation_no);
  } else if (options.material_code) {
    rows = loadReceipts(db, options.material_code, options.operation_no ?? '');
  } else if (options.operation_no) {
    rows = listOperationAttempts(db, options.operation_no);
  } else if (options.from && options.to) {
    rows = listAttemptsInWindow(db, options.from, options.to);
  } else {
    // 没给台次 / 耗材码 / 时间窗：给一个宽口径窗口（从最早到最晚）
    rows = listAttemptsInWindow(db, '0000-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z');
  }

  // 时间窗与台次 / 耗材码叠加时，按窗再过一道
  if (options.from && options.to && (options.operation_no || options.material_code)) {
    const from = Date.parse(options.from);
    const to = Date.parse(options.to);
    rows = rows.filter((row) => {
      const at = Date.parse(row.created_at);
      return Number.isFinite(at) && at >= from && at <= to;
    });
  }

  const total = rows.length;
  const limited = rows.slice(0, limit);
  return {
    rows: limited,
    summaries: summarizeAttemptHistory(limited),
    total,
    limit,
  };
}
