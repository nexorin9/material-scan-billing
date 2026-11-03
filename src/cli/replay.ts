/**
 * replay：区间重放、幂等不变式验证与差异比对。
 *
 * 出故障后信息科要能回答一句话：**「那段时间的扫码，原样再跑一遍会不会多出一笔计费？」**
 * 本模块把这件事做成**可验证的不变式工具**：
 *
 *   ① **四种区间选择** —— 时间窗（--from / --to）、台次（--operation）、
 *      批次号（--batch）、来源（--source）；区间口径写在 `ReplayInterval` 里，
 *      一次能圈定「某段时间 / 某台手术 / 设备侧某一批」的事件；
 *   ② **前后快照比对** —— 重放前后各取一份快照（台账行数 / 计费调用次数 /
 *      回执行数 / 待核查数 / 五种结论分布 / 条目状态分布 / 重投次数分布），
 *      输出**差异表**（`ReplayDiff`）：哪一项变了、变了多少，一行一项；
 *   ③ **幂等不变式断言** —— 同一区间连续重放两次，**第二次**台账行数增量 = 0、
 *      计费调用增量 = 0；不成立就**明说不成立**（不糊弄成「已通过」）；
 *   ④ **走生产同一条路径** —— 同一套装配（`dispatchBatch`）、同一把幂等键、
 *      同一个结算层、同一个出站计费客户端。**不另开旁路实现**：
 *      旁路重放证明不了生产的幂等，只证明得了旁路的幂等。
 *
 * 语义来源（源产品主路径）：源产品的规范化缓存层把「按键取回记录」
 * （`readRecordsByKeys`）与「按字段落位」（`upsertByField`）做成两件事 ——
 * 键相同就命中同一条记录，落位是幂等的 upsert 而不是追加；
 * 源产品的逻辑连接还有一条硬纪律：**一侧关闭 ≠ 另一侧断开**
 * （`crates/agent_runtime_protocol/src/domain/connection.rs`），
 * 「真的断了」与「这一侧先收摊」要分得清 —— 本模块的区间重放同理：
 * 「重放了但没产生第二笔」与「根本没重放起来」不是一回事，差异表要把两者分开。
 */

import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { countEventLogMatching, listEventLog, type EventLogRow } from '../ledger/event-log.js';
import { countBindings } from '../ledger/binding-repo.js';
import { getMetaCounter, META_KEY_OUTBOUND_CALLS } from '../ledger/meta.js';
import { dispatchBatch } from '../ingest/adapters/dispatch.js';
import type { EventBatch } from '../ingest/adapters/event-source.js';
import { writeBackOperationCharges } from '../charge/writeback.js';
import type { HisChargingClient } from '../charge/client.js';
import type { ConfigurableIdempotencyKeyProfile } from '../domain/idempotency.js';
import { collectRunSummary } from '../log/summary.js';

/* ------------------------------------------------------------------ 基础件 */

/** replay 的输入 */
export interface ReplayOptions {
  /** 最多重放多少条事件（默认 50） */
  limit?: number;
  /** 只重放某个台次的事件 */
  operation_no?: string | null;
  /** 只重放某个来源的事件 */
  source?: string | null;
  /** 只重放某个批次号的事件 */
  batch_id?: string | null;
  /** 时间窗起点（含，ISO 时间） */
  from?: string | null;
  /** 时间窗终点（含，ISO 时间） */
  to?: string | null;
  /** 从事件日志文件重放（每行一个批次信封；给了就不读事件日志表） */
  eventsFile?: string | null;
  /** 是否顺带回写计费（需要出站凭据位） */
  charge?: boolean;
  /** 出站客户端（凭据单一出口：业务层拿不到令牌） */
  chargeClient?: HisChargingClient | null;
  /** 出站端点路径 */
  chargePath?: string;
  /** 单次计费请求的条目数上限（对端限批；默认 100） */
  chargeMaxBatchSize?: number;
  /** 本次出站使用的幂等键档位（默认 v1；来自配置项 IDEMPOTENCY_KEY_PROFILE） */
  chargeKeyProfile?: ConfigurableIdempotencyKeyProfile;
}

/** 一批事件重放的结果 */
export interface ReplayBatchResult {
  request_id: string;
  source: string;
  operation_no: string;
  /** 本批条目数 */
  total: number;
  /** 逐条结论：绑定成功 */
  accepted: number;
  /** 逐条结论：异常 */
  rejected: number;
  /** 本批带来的新台账行数（幂等命中时为 0） */
  new_rows: number;
  /** 逐条原因码分布（同键重放时全是 DUPLICATE_SCAN —— 这正是要证明的） */
  reason_codes: Array<{ reason_code: string; count: number }>;
}

/** replay 输出 */
export interface ReplayReport {
  generated_at: string;
  /** 重放了几条事件 */
  events_replayed: number;
  /** 重放带来的新增台账行数（**同键重放应为 0**） */
  new_ledger_rows: number;
  /** 触发计费次数（出站请求实际打了几次） */
  charge_calls: number;
  /** 提交出去的计费条目数 */
  charge_submitted: number;
  /** 对端接收的条目数 */
  charge_accepted: number;
  /** 对端拒收的条目数 */
  charge_rejected: number;
  /** 没回写计费的原因（没配出站凭据 / 没有待回写条目） */
  charge_skipped_reason: string | null;
  /** 逐批结果 */
  batches: ReplayBatchResult[];
}

/* -------------------------------------------------------------- 区间与选择 */

/**
 * 重放区间。
 *
 * 四种口径可组合（同时给 = 取交集）：
 *   - **时间窗** `from` / `to`（按事件**收到时刻**筛，含端点）
 *   - **台次** `operation_no`
 *   - **批次号** `batch_id`（设备侧那一批的号）
 *   - **来源** `source`（扫码枪 HTTP / RFID 目录投递）
 */
export interface ReplayInterval {
  from?: string | null;
  to?: string | null;
  operation_no?: string | null;
  batch_id?: string | null;
  source?: string | null;
  /** 最多取多少条（防止一次重放太多；不是区间口径） */
  limit?: number;
}

/** 区间选中结果 */
export interface ReplaySelection {
  /** 命中的事件行（按落库顺序 —— 先放最早那批） */
  rows: EventLogRow[];
  /** 区间内一共命中多少条（不受 limit 影响） */
  matched: number;
  /** 实际取出来多少条 */
  taken: number;
}

/**
 * 按区间选事件。
 *
 * 时间窗按 `received_at` 筛（**收到时刻**，不是落账时刻）——
 * 运维问的是「那段时间设备报了什么」，不是「那段时间账上有什么」。
 */
export function selectReplayEvents(db: DatabaseSync, interval: ReplayInterval = {}): ReplaySelection {
  const query = {
    operation_no: interval.operation_no ?? null,
    source: interval.source ?? null,
    batch_id: interval.batch_id ?? null,
    from: interval.from ?? null,
    to: interval.to ?? null,
  };
  const matched = countEventLogMatching(db, query);
  const limit = Number.isInteger(interval.limit) && (interval.limit as number) > 0 ? (interval.limit as number) : 50;
  const rows = listEventLog(db, { ...query, limit });
  return { rows, matched, taken: rows.length };
}

/* ------------------------------------------------------------------ 快照 */

/**
 * 重放前后的**状态快照**。
 *
 * 数字全部现读台账（SQL 聚合），**没有内存计数器** —— 快照要能和
 * `summary` 子命令对得上，也要能被另一次进程读出来复现。
 */
export interface ReplaySnapshot {
  /** 耗材使用台账行数 */
  ledger_rows: number;
  /** 出站计费请求次数（累计；跨进程留得住的那个计数） */
  outbound_charge_calls: number;
  /** 计费回执行数（每条耗材每次尝试一行） */
  charge_receipts: number;
  /** 待核查条目数 */
  check_pending: number;
  /** 五种绑定结论分布 */
  by_conclusion: Array<{ conclusion: string; count: number }>;
  /** 条目状态分布 */
  by_status: Array<{ status: string; count: number }>;
  /** 重投次数分布（投递 N 次的条目数） */
  retry_distribution: Array<{ delivery_count: number; count: number }>;
}

/** 取一份状态快照 */
export function captureReplaySnapshot(db: DatabaseSync): ReplaySnapshot {
  const summary = collectRunSummary(db);
  const receiptRow = db.prepare('SELECT COUNT(*) AS n FROM charge_receipt').get() as { n: number };
  return {
    ledger_rows: summary.ledger_rows,
    outbound_charge_calls: getMetaCounter(db, META_KEY_OUTBOUND_CALLS),
    charge_receipts: receiptRow.n,
    check_pending: summary.check.pending,
    by_conclusion: summary.by_conclusion,
    by_status: summary.by_status,
    retry_distribution: summary.charge.retry_distribution,
  };
}

/* ---------------------------------------------------------------- 差异表 */

/** 差异表的一行（标量维度） */
export interface ReplayDiffRow {
  /** 维度键（如 `ledger_rows`） */
  dimension: string;
  /** 中文说法（现场可读） */
  label_zh: string;
  /** 重放前 */
  before: number;
  /** 重放后 */
  after: number;
  /** 增量（after - before） */
  delta: number;
  /** 是否变了 */
  changed: boolean;
}

/** 差异表的一行（分布维度） */
export interface ReplayDistributionRow {
  /** 分布维度（`conclusion` / `status` / `retry`） */
  dimension: string;
  /** 分布项的键 */
  key: string;
  /** 中文说法 */
  label_zh: string;
  before: number;
  after: number;
  delta: number;
}

/** 幂等不变式的验证结论 */
export interface ReplayInvariant {
  /** 第二次重放了几条事件 */
  replayed_events: number;
  /** 第二次重放的台账行数增量（必须为 0） */
  ledger_delta: number;
  /** 第二次重放的出站计费请求增量（必须为 0） */
  outbound_call_delta: number;
  /** 第二次重放的回执行增量（必须为 0） */
  receipt_delta: number;
  /** 不变式是否成立 */
  held: boolean;
  /** 一句话结论（中文；成立与不成立都写清楚） */
  conclusion_zh: string;
}

/** 重放差异报告 */
export interface ReplayDiff {
  generated_at: string;
  /** 本次用的区间 */
  interval: ReplayInterval;
  /** 区间的一句话标签（用于落盘文件名与终端标题） */
  interval_label: string;
  /** 区间内一共命中多少条事件 */
  matched_events: number;
  /** 实际重放了几条 */
  replayed_events: number;
  /** 重放前快照 */
  before: ReplaySnapshot;
  /** 重放后快照 */
  after: ReplaySnapshot;
  /** 标量维度差异（台账行数 / 计费调用次数 / 回执行数 / 待核查数） */
  rows: ReplayDiffRow[];
  /** 分布维度差异（五种结论 / 条目状态 / 重投次数） */
  distributions: ReplayDistributionRow[];
  /** 幂等不变式验证结论（没做验证时为 null） */
  invariant: ReplayInvariant | null;
  /** 逐批结果 */
  batches: ReplayBatchResult[];
}

/** 四个标量维度的中文说法 */
const SCALAR_DIMENSION_LABELS: Record<string, string> = {
  ledger_rows: '耗材使用台账行数',
  outbound_charge_calls: '计费调用次数（出站请求）',
  charge_receipts: '计费回执行数',
  check_pending: '待核查条目数',
};

/** 结论码的中文说法 */
const CONCLUSION_LABELS: Record<string, string> = {
  BOUND: '已绑上台次',
  NOT_REGISTERED: '绑不上（耗材码 / 台次 / 主数据不通过）',
  CROSS_OP_DUP: '跨台次重复',
  CLOSED: '台次已关台',
  CHARGE_REJECTED: '计费被对端拒收',
};

/** 条目状态的中文说法 */
const STATUS_LABELS: Record<string, string> = {
  scanned: '已扫码',
  parsed: '已归一',
  bound: '已绑台次（待回写计费）',
  rejected: '已拒收',
  charged: '已回写计费',
  confirmed: '已人工确认',
  check_pending: '待核查',
  closed: '已闭环',
};

/**
 * 比两份快照，出差异表。
 *
 * **标量维度**逐项对比（台账行数 / 计费调用次数 / 回执行数 / 待核查数）；
 * **分布维度**按项逐个对比（结论 / 状态 / 重投次数）——
 * 分布变了但总数没变，是最容易被漏掉的一类变化（比如一条从「待核查」挪到「已闭环」）。
 */
export function diffReplaySnapshots(before: ReplaySnapshot, after: ReplaySnapshot): {
  rows: ReplayDiffRow[];
  distributions: ReplayDistributionRow[];
} {
  const scalarKeys: Array<keyof ReplaySnapshot> = [
    'ledger_rows',
    'outbound_charge_calls',
    'charge_receipts',
    'check_pending',
  ];
  const rows: ReplayDiffRow[] = scalarKeys.map((key) => {
    const beforeValue = Number(before[key]);
    const afterValue = Number(after[key]);
    return {
      dimension: key,
      label_zh: SCALAR_DIMENSION_LABELS[key] ?? key,
      before: beforeValue,
      after: afterValue,
      delta: afterValue - beforeValue,
      changed: afterValue !== beforeValue,
    };
  });

  const distributions: ReplayDistributionRow[] = [];

  const conclusionKeys = new Set<string>([
    ...before.by_conclusion.map((row) => row.conclusion),
    ...after.by_conclusion.map((row) => row.conclusion),
  ]);
  for (const key of [...conclusionKeys].sort()) {
    const beforeValue = before.by_conclusion.find((row) => row.conclusion === key)?.count ?? 0;
    const afterValue = after.by_conclusion.find((row) => row.conclusion === key)?.count ?? 0;
    distributions.push({
      dimension: 'conclusion',
      key,
      label_zh: CONCLUSION_LABELS[key] ?? key,
      before: beforeValue,
      after: afterValue,
      delta: afterValue - beforeValue,
    });
  }

  const statusKeys = new Set<string>([
    ...before.by_status.map((row) => row.status),
    ...after.by_status.map((row) => row.status),
  ]);
  for (const key of [...statusKeys].sort()) {
    const beforeValue = before.by_status.find((row) => row.status === key)?.count ?? 0;
    const afterValue = after.by_status.find((row) => row.status === key)?.count ?? 0;
    distributions.push({
      dimension: 'status',
      key,
      label_zh: STATUS_LABELS[key] ?? key,
      before: beforeValue,
      after: afterValue,
      delta: afterValue - beforeValue,
    });
  }

  const retryKeys = new Set<number>([
    ...before.retry_distribution.map((row) => row.delivery_count),
    ...after.retry_distribution.map((row) => row.delivery_count),
  ]);
  for (const key of [...retryKeys].sort((a, b) => a - b)) {
    const beforeValue = before.retry_distribution.find((row) => row.delivery_count === key)?.count ?? 0;
    const afterValue = after.retry_distribution.find((row) => row.delivery_count === key)?.count ?? 0;
    distributions.push({
      dimension: 'retry',
      key: String(key),
      label_zh: `投递 ${key} 次的条目`,
      before: beforeValue,
      after: afterValue,
      delta: afterValue - beforeValue,
    });
  }

  return { rows, distributions };
}

/* ------------------------------------------------------------- 区间标签 */

/**
 * 区间的 slug（用于落盘文件名）。
 *
 * 落盘名要能一眼看出重的是哪一段：`op-OP-SAMPLE-001` / `batch-B001` /
 * `time-20260115T0900-20260115T1000` / `all`。
 */
export function replayIntervalSlug(interval: ReplayInterval = {}): string {
  const parts: string[] = [];
  if (interval.from || interval.to) {
    const from = (interval.from ?? '').replace(/[^0-9A-Za-z]+/g, '').slice(0, 15);
    const to = (interval.to ?? '').replace(/[^0-9A-Za-z]+/g, '').slice(0, 15);
    parts.push(`time-${from || 'start'}-${to || 'end'}`);
  }
  if (interval.operation_no) parts.push(`op-${interval.operation_no}`);
  if (interval.batch_id) parts.push(`batch-${interval.batch_id}`);
  if (interval.source) parts.push(`src-${interval.source}`);
  return parts.length > 0 ? parts.join('_') : 'all';
}

/** 区间的一句话标签（中文） */
export function replayIntervalLabel(interval: ReplayInterval = {}): string {
  const parts: string[] = [];
  if (interval.from || interval.to) {
    parts.push(`时间窗 ${interval.from ?? '不限'} ~ ${interval.to ?? '不限'}`);
  }
  if (interval.operation_no) parts.push(`台次 ${interval.operation_no}`);
  if (interval.batch_id) parts.push(`批次 ${interval.batch_id}`);
  if (interval.source) parts.push(`来源 ${interval.source}`);
  return parts.length > 0 ? parts.join('　') : '全部事件';
}

/* --------------------------------------------------------------- 重放执行 */

/** 从事件日志的归一结果还原成统一批次信封 */
function batchFromEvent(row: {
  request_id: string;
  source: string;
  operation_no: string | null;
  room_no: string | null;
  scanner_id: string | null;
  normalized_json: string | null;
  batch_id?: string | null;
}): EventBatch | null {
  if (!row.normalized_json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.normalized_json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as {
    operation_no?: unknown;
    room_no?: unknown;
    scanner_id?: unknown;
    items?: unknown;
  };
  const items = Array.isArray(record.items) ? record.items : [];
  const normalizedItems = items
    .map((item) => {
      const entry = item as {
        material_code?: unknown;
        raw_code?: unknown;
        quantity?: unknown;
        batch_no?: unknown;
      };
      const materialCode = typeof entry.material_code === 'string' ? entry.material_code : '';
      if (materialCode.length === 0) return null;
      return {
        material_code: materialCode,
        raw_code: typeof entry.raw_code === 'string' ? entry.raw_code : materialCode,
        quantity: typeof entry.quantity === 'number' ? entry.quantity : 1,
        batch_no: typeof entry.batch_no === 'string' ? entry.batch_no : null,
      };
    })
    .filter(
      (item): item is {
        material_code: string;
        raw_code: string;
        quantity: number;
        batch_no: string | null;
      } => item !== null,
    );

  return {
    source: (row.source === 'rfid_dir' ? 'rfid_dir' : 'scanner_http') as EventBatch['source'],
    operation_no: String(record.operation_no ?? row.operation_no ?? ''),
    room_no: String(record.room_no ?? row.room_no ?? ''),
    scanner_id: String(record.scanner_id ?? row.scanner_id ?? ''),
    items: normalizedItems,
    rejects: [],
    handle: `replay:${row.request_id}`,
    digest: row.request_id,
    request_id: row.request_id,
    batch_id: row.batch_id ?? null,
    raw_body: null,
    signature_verified: false,
  };
}

/**
 * 从事件日志文件读批次（每行一个批次信封）。
 *
 * 与事件日志表里的 `normalized_json` 同一形状，便于运维把导出的事件日志
 * 交给别的机器重放。坏行跳过并计数 —— 一行坏数据不该让整次重放失败。
 */
export function loadBatchesFromFile(filePath: string): { batches: EventBatch[]; skipped: number } {
  const content = readFileSync(filePath, 'utf8');
  const batches: EventBatch[] = [];
  let skipped = 0;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      skipped += 1;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const envelope = {
      request_id: String(record['request_id'] ?? `file:${batches.length + 1}`),
      source: String(record['source'] ?? 'scanner_http'),
      operation_no: String(record['operation_no'] ?? ''),
      room_no: String(record['room_no'] ?? ''),
      scanner_id: String(record['scanner_id'] ?? ''),
      batch_id: record['batch_id'] === undefined ? null : String(record['batch_id']),
      normalized_json: JSON.stringify(record),
    };
    const batch = batchFromEvent(envelope);
    if (!batch) {
      skipped += 1;
      continue;
    }
    batches.push(batch);
  }
  return { batches, skipped };
}

/**
 * 重放一批事件（**生产同一条路径**）。
 *
 * 逐条流程与生产完全一致：同一套装配（`dispatchBatch`）、同一把幂等键、
 * 同一个结算层、同一个出站计费客户端。**不另开旁路实现** ——
 * 旁路重放证明不了生产的幂等。
 *
 * 重放**不再写事件日志**（否则每重放一次日志就长一截，越重放越多没法核对）。
 */
export async function replayEventRows(
  db: DatabaseSync,
  events: readonly EventLogRow[],
  options: ReplayOptions = {},
): Promise<ReplayReport> {
  const report: ReplayReport = {
    generated_at: new Date().toISOString(),
    events_replayed: 0,
    new_ledger_rows: 0,
    charge_calls: 0,
    charge_submitted: 0,
    charge_accepted: 0,
    charge_rejected: 0,
    charge_skipped_reason: null,
    batches: [],
  };

  const touchedOperations = new Set<string>();

  for (const event of events) {
    const batch = batchFromEvent(event);
    if (!batch) continue;
    const before = countBindings(db);
    const result = dispatchBatch(db, batch, { logEvent: false });
    const after = countBindings(db);
    report.events_replayed += 1;
    report.new_ledger_rows += after - before;
    touchedOperations.add(batch.operation_no);
    const reasonCounts = new Map<string, number>();
    for (const outcome of [...result.accepted, ...result.rejected]) {
      const code = outcome.reason_code ?? outcome.conclusion;
      reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
    }
    report.batches.push({
      request_id: event.request_id,
      source: event.source,
      operation_no: batch.operation_no,
      total: result.stats.total,
      accepted: result.stats.accepted,
      rejected: result.stats.rejected,
      new_rows: after - before,
      reason_codes: [...reasonCounts.entries()]
        .map(([reason_code, count]) => ({ reason_code, count }))
        .sort((a, b) => b.count - a.count),
    });
  }

  // 计费回写：只有「还有绑上但没回写计费的条目」才需要打对端
  if (options.charge) {
    if (!options.chargeClient || !options.chargePath) {
      report.charge_skipped_reason =
        '未配置出站计费通道（缺 HIS_CHARGING_BASE_URL / HIS_CHARGING_TOKEN），本次重放只走到绑定判定';
    } else {
      for (const operation_no of touchedOperations) {
        const writeback = await writeBackOperationCharges(db, operation_no, {
          client: options.chargeClient,
          path: options.chargePath,
          maxBatchSize: options.chargeMaxBatchSize,
          keyProfile: options.chargeKeyProfile,
        });
        report.charge_calls += writeback.calls;
        report.charge_submitted += writeback.submitted;
        report.charge_accepted += writeback.accepted;
        report.charge_rejected += writeback.rejected;
      }
      if (report.charge_calls === 0) {
        report.charge_skipped_reason = '本次重放涉及的台次没有待回写计费的条目（已计费的不重复投递）';
      }
    }
  } else {
    report.charge_skipped_reason = '未指定 --charge，本次重放只走到绑定判定';
  }

  return report;
}

/**
 * replay：从事件日志重放事件，输出「新增台账行数 / 触发计费次数」。
 *
 * 走的是**生产同一条路径**：同一套装配（`dispatchBatch`）、同一把幂等键、同一个结算层。
 * 因此同键重放不会产生第二行台账，也不会产生第二次计费 —— 这正是要证明的事。
 */
export async function runReplay(db: DatabaseSync, options: ReplayOptions = {}): Promise<ReplayReport> {
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : 50;

  let events: EventLogRow[];

  if (options.eventsFile) {
    const loaded = loadBatchesFromFile(options.eventsFile);
    events = loaded.batches
      .filter((batch) => !options.operation_no || batch.operation_no === options.operation_no)
      .filter((batch) => !options.source || batch.source === options.source)
      .slice(0, limit)
      .map((batch, index) => ({
        id: index + 1,
        request_id: batch.request_id ?? `file:${index + 1}`,
        received_at: '',
        source: batch.source,
        operation_no: batch.operation_no,
        room_no: batch.room_no,
        scanner_id: batch.scanner_id,
        raw_body: null,
        normalized_json: JSON.stringify({
          operation_no: batch.operation_no,
          room_no: batch.room_no,
          scanner_id: batch.scanner_id,
          items: batch.items,
        }),
        signature_verified: false,
        idempotency_key: null,
        conclusion: null,
        batch_id: batch.batch_id ?? null,
        created_at: '',
      }));
  } else {
    events = listEventLog(db, {
      limit,
      operation_no: options.operation_no ?? null,
      source: options.source ?? null,
      batch_id: options.batch_id ?? null,
      from: options.from ?? null,
      to: options.to ?? null,
    });
  }

  return replayEventRows(db, events, options);
}

/* ------------------------------------------------- 深化：差异表 + 不变式 */

/** runReplayWithDiff 的输入 */
export interface ReplayWithDiffOptions extends ReplayOptions {
  /**
   * 是否连做**第二遍**重放以验证幂等不变式。
   *
   * 默认开 —— 「重放不会产生第二笔计费」这句话，**验过**才算数。
   */
  verify?: boolean;
  /** 差异表落盘路径（不给则用默认 `logs/replay-<区间>-diff.json`） */
  diffOut?: string | null;
}

/**
 * 重放 + 前后差异表 + 幂等不变式验证。
 *
 * 流程：
 *   ① 按区间选事件；
 *   ② 取重放前快照；
 *   ③ 重放第一遍（生产同一条路径）→ 取重放后快照 → 出差异表；
 *   ④ （默认）**再重放一遍同一区间** → 与上一步的快照比 →
 *      台账行数增量与计费调用增量**都必须是 0**。
 *
 * 第 ④ 步不成立时**照实说「不成立」**，并把两次增量摆在报告里 ——
 * 一个会说「不成立」的重放工具，比一个永远说「已通过」的有用。
 */
export async function runReplayWithDiff(
  db: DatabaseSync,
  options: ReplayWithDiffOptions = {},
): Promise<ReplayDiff> {
  const interval: ReplayInterval = {
    from: options.from ?? null,
    to: options.to ?? null,
    operation_no: options.operation_no ?? null,
    batch_id: options.batch_id ?? null,
    source: options.source ?? null,
    limit: options.limit,
  };

  const selection = selectReplayEvents(db, interval);
  const before = captureReplaySnapshot(db);
  const report = await replayEventRows(db, selection.rows, options);
  const after = captureReplaySnapshot(db);
  const { rows, distributions } = diffReplaySnapshots(before, after);

  let invariant: ReplayInvariant | null = null;
  if (options.verify !== false) {
    const second = await replayEventRows(db, selection.rows, options);
    const afterSecond = captureReplaySnapshot(db);
    const ledgerDelta = afterSecond.ledger_rows - after.ledger_rows;
    const outboundCallDelta = afterSecond.outbound_charge_calls - after.outbound_charge_calls;
    const receiptDelta = afterSecond.charge_receipts - after.charge_receipts;
    const held = ledgerDelta === 0 && outboundCallDelta === 0 && receiptDelta === 0;
    invariant = {
      replayed_events: second.events_replayed,
      ledger_delta: ledgerDelta,
      outbound_call_delta: outboundCallDelta,
      receipt_delta: receiptDelta,
      held,
      conclusion_zh: held
        ? `同一区间连续重放两次：第二次台账行数增量 ${ledgerDelta}、计费调用增量 ${outboundCallDelta}、回执行增量 ${receiptDelta} —— 不变式成立（重放没有产生第二笔计费）`
        : `同一区间连续重放两次：第二次台账行数增量 ${ledgerDelta}、计费调用增量 ${outboundCallDelta}、回执行增量 ${receiptDelta} —— 不变式**不成立**，需要排查幂等层`,
    };
  }

  return {
    generated_at: new Date().toISOString(),
    interval,
    interval_label: replayIntervalLabel(interval),
    matched_events: selection.matched,
    replayed_events: report.events_replayed,
    before,
    after,
    rows,
    distributions,
    invariant,
    batches: report.batches,
  };
}

/* ------------------------------------------------------------------ 落盘 */

/** 差异表的默认落盘路径（相对当前工作目录；`logs/` 不入库） */
export function defaultReplayDiffPath(interval: ReplayInterval = {}): string {
  return resolve(process.cwd(), 'logs', `replay-${replayIntervalSlug(interval)}-diff.json`);
}

/** 把差异表落盘（自动建目录）；返回实际写入的路径 */
export function writeReplayDiff(diff: ReplayDiff, filePath?: string | null): string {
  const target = resolve(filePath && filePath.length > 0 ? filePath : defaultReplayDiffPath(diff.interval));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
  return target;
}

/** 差异表的终端渲染（人话；差异为 0 的维度也列出来，便于核对） */
export function renderReplayDiffText(diff: ReplayDiff): string {
  const lines: string[] = [];
  lines.push(`== 重放差异表（${diff.interval_label}） ==`);
  lines.push(`  区间命中 ${diff.matched_events} 条事件，实际重放 ${diff.replayed_events} 条`);
  lines.push('');

  // 中文按「显示宽度」算列宽（一个汉字占两格），否则表格会歪
  const displayWidth = (text: string): number =>
    [...text].reduce((width, char) => width + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const padDisplay = (text: string, width: number): string => {
    const pad = Math.max(0, width - displayWidth(text));
    return `${text}${' '.repeat(pad)}`;
  };
  const labelWidth = Math.max(
    displayWidth('对比维度'),
    ...diff.rows.map((row) => displayWidth(row.label_zh)),
  );

  lines.push(
    `  ${padDisplay('对比维度', labelWidth)}  ${'重放前'.padStart(8)}  ${'重放后'.padStart(8)}  ${'增量'.padStart(8)}`,
  );
  for (const row of diff.rows) {
    lines.push(
      `  ${padDisplay(row.label_zh, labelWidth)}  ${String(row.before).padStart(8)}  ${String(row.after).padStart(8)}  ${String(row.delta).padStart(8)}`,
    );
  }

  const changed = diff.distributions.filter((row) => row.delta !== 0);
  if (changed.length > 0) {
    lines.push('');
    lines.push('  分布变化：');
    for (const row of changed) {
      lines.push(
        `    ${row.dimension.padEnd(11)} ${row.label_zh.padEnd(30)} ${String(row.before).padStart(6)} → ${String(row.after).padStart(6)}（${row.delta > 0 ? '+' : ''}${row.delta}）`,
      );
    }
  } else {
    lines.push('');
    lines.push('  分布变化：无（五种结论 / 条目状态 / 重投次数分布都没动）');
  }

  if (diff.invariant) {
    lines.push('');
    lines.push('== 幂等不变式 ==');
    lines.push(`  ${diff.invariant.conclusion_zh}`);
  }

  return lines.join('\n');
}
