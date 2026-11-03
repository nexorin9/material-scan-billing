/**
 * 事件日志：**只增不改**的入站事件落盘层。
 *
 * 手术室里的扫码事件一旦出了问题，信息科要能看到「设备到底报了什么」——
 * 原始报文不落盘就没法复盘，重放也没有数据源。本层把每条入站事件落一行：
 *
 *   request_id          —— 本次投递的标识（两路各自生成，同一次投递内不变）
 *   received_at         —— 收到时刻
 *   source              —— 来源（扫码枪 HTTP / RFID 目录投递）
 *   raw_body            —— 原始报文，按原文保存
 *   normalized_json     —— 归一后的批次信封（台次 + 手术间 + 扫码枪 + 条目）
 *   signature_verified  —— 签名是否验过（目录投递无签名，恒为 0）
 *   conclusion          —— 本批结论分布（accepted / rejected 条数）
 *
 * 硬约束：
 *   ① **不落患者可识别明细** —— 原始报文里只有耗材码、台次号、手术间、扫码枪；
 *   ② **只增不改** —— 与审计链同口径：事件日志是「发生过什么」的事实，不允许改写；
 *   ③ **重放走生产同一条路径** —— 归一结果直接喂回 `dispatchBatch`，
 *      不另写一套解析逻辑（码制归一、幂等键、结算层全部复用）。
 */

import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import type { EventSourceId } from '../ingest/adapters/event-source.js';
import { appendAudit } from './audit.js';

/** 事件来源（两路；目录投递无签名） */
export type ScanEventSource = EventSourceId | string;

/** 写事件日志的输入 */
export interface EventLogInput {
  /** 本次投递的标识（不给则由本层生成） */
  request_id?: string | null;
  /** 来源路 */
  source: ScanEventSource;
  /** 台次号 */
  operation_no?: string | null;
  /** 手术间 */
  room_no?: string | null;
  /** 扫码枪 / 网关编号 */
  scanner_id?: string | null;
  /** 原始报文（按原文保存） */
  raw_body?: string | null;
  /** 归一后的批次信封（JSON 字符串） */
  normalized_json?: string | null;
  /** 签名是否验过 */
  signature_verified?: boolean;
  /** 关联的幂等键（单条事件才有；批次级事件留空） */
  idempotency_key?: string | null;
  /** 本批结论分布 */
  conclusion?: string | null;
  /**
   * 批次号（重放按批次选区间用）。
   *
   * - 扫码枪 HTTP 路 = 本次投递标识（一个 POST 就是一批）；
   * - RFID 目录投递路 = 设备侧给的批次文件名。
   *
   * 历史行留空 = 落库时还没有批次号这一说（不猜）。
   */
  batch_id?: string | null;
  /** 收到时刻（不给则取当前时间） */
  received_at?: string;
  /**
   * 本批涉及的耗材码（归一后的院内码）。
   *
   * 落进 `scan_event_material` 关联表 —— 事件日志一行是**一批**，
   * 「这个码都出过什么事」要能反查到具体是哪几批。
   */
  material_codes?: readonly string[];
  /**
   * 设备侧上报的原始码（与归一码不同时一并入关联表）。
   *
   * 排障时信息科手里往往只有设备上印的那串码，用原始码也要能查到事件。
   */
  raw_codes?: readonly string[];
}

/** 事件日志行 */
export interface EventLogRow {
  id: number;
  request_id: string;
  received_at: string;
  source: string;
  operation_no: string | null;
  room_no: string | null;
  scanner_id: string | null;
  raw_body: string | null;
  normalized_json: string | null;
  signature_verified: boolean;
  idempotency_key: string | null;
  conclusion: string | null;
  /** 批次号（历史行为 null） */
  batch_id: string | null;
  created_at: string;
}

const EVENT_COLUMNS = `id, request_id, received_at, source, operation_no, room_no, scanner_id,
       raw_body, normalized_json, signature_verified, idempotency_key, conclusion, batch_id, created_at`;

/** 生成一个投递标识（node:crypto 的 randomUUID） */
export function newRequestId(): string {
  return randomUUID();
}

/** 追加一行事件日志；返回新行 id */
export function appendEventLog(db: DatabaseSync, input: EventLogInput): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO scan_event
         (request_id, received_at, source, operation_no, room_no, scanner_id,
          raw_body, normalized_json, signature_verified, idempotency_key, conclusion,
          batch_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.request_id ?? newRequestId(),
      input.received_at ?? now,
      input.source,
      input.operation_no ?? null,
      input.room_no ?? null,
      input.scanner_id ?? null,
      input.raw_body ?? null,
      input.normalized_json ?? null,
      input.signature_verified ? 1 : 0,
      input.idempotency_key ?? null,
      input.conclusion ?? null,
      input.batch_id ?? null,
      now,
    );
  const eventId = Number(result.lastInsertRowid);
  linkEventMaterials(db, eventId, input);
  return eventId;
}

/**
 * 把本批的耗材码挂到事件行上（`scan_event_material` 关联表）。
 *
 * 同一批里同一个码只留一行；原始码与归一码相同就只留归一码那一条。
 * 关联表只存耗材码与事件行 id —— **不落患者可识别明细**（与事件日志同口径）。
 */
function linkEventMaterials(db: DatabaseSync, eventId: number, input: EventLogInput): void {
  const canonical = (input.material_codes ?? []).map((code) => code.trim()).filter(Boolean);
  const raw = (input.raw_codes ?? []).map((code) => code.trim()).filter(Boolean);
  const rows: Array<[number, string, string]> = [];
  const seen = new Set<string>();
  for (const code of canonical) {
    if (seen.has(`canonical|${code}`)) continue;
    seen.add(`canonical|${code}`);
    rows.push([eventId, code, 'canonical']);
  }
  for (const code of raw) {
    // 原始码与归一码相同时不重复挂（查「这个码」不该看到同一条两遍）
    if (canonical.includes(code)) continue;
    if (seen.has(`raw|${code}`)) continue;
    seen.add(`raw|${code}`);
    rows.push([eventId, code, 'raw']);
  }
  if (rows.length === 0) return;
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO scan_event_material (event_id, material_code, code_kind) VALUES (?, ?, ?)',
  );
  for (const row of rows) stmt.run(row[0], row[1], row[2]);
}

/** 事件日志查询条件 */
export interface EventLogQuery {
  /** 最多取多少条 */
  limit?: number;
  /** 按台次过滤 */
  operation_no?: string | null;
  /** 按来源过滤 */
  source?: string | null;
  /** 按批次号过滤 */
  batch_id?: string | null;
  /** 时间窗起点（含，ISO 时间） */
  from?: string | null;
  /** 时间窗终点（含，ISO 时间） */
  to?: string | null;
}

/**
 * 把查询条件拼成 WHERE 子句与参数。
 *
 * 时间窗按**收到时刻**筛（`received_at`），不是按落账时刻 —— 运维要的是
 * 「那段时间设备报了什么」，而不是「那段时间账上有什么」。
 */
function buildEventLogFilter(query: EventLogQuery): {
  clause: string;
  params: Array<string | null>;
} {
  const where: string[] = [];
  const params: Array<string | null> = [];
  if (query.operation_no) {
    where.push('operation_no = ?');
    params.push(query.operation_no);
  }
  if (query.source) {
    where.push('source = ?');
    params.push(query.source);
  }
  if (query.batch_id) {
    where.push('batch_id = ?');
    params.push(query.batch_id);
  }
  if (query.from) {
    where.push('received_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    where.push('received_at <= ?');
    params.push(query.to);
  }
  return {
    clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

/**
 * 取事件日志（按接收时间升序 —— 重放时先放最早那批）。
 *
 * 只增不改的行按 id 升序与按接收时间升序等价；这里显式按 id 排序，
 * 保证同毫秒到达的多条事件也有稳定顺序。
 */
export function listEventLog(db: DatabaseSync, query: EventLogQuery = {}): EventLogRow[] {
  const limit = Number.isInteger(query.limit) && (query.limit as number) > 0 ? (query.limit as number) : 50;
  const { clause, params } = buildEventLogFilter(query);
  const rows = db
    .prepare(
      `SELECT ${EVENT_COLUMNS}
         FROM scan_event
        ${clause}
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as Array<
    Omit<EventLogRow, 'signature_verified'> & { signature_verified: number }
  >;
  return rows.map((row) => ({ ...row, signature_verified: row.signature_verified === 1 }));
}

/**
 * 命中区间的事件条数（不受 limit 影响）。
 *
 * 重放要报「这个区间一共多少批」，不能只报取出来的那几条 ——
 * limit 只是防止一次重放太多，不是区间的口径。
 */
export function countEventLogMatching(db: DatabaseSync, query: EventLogQuery = {}): number {
  const { clause, params } = buildEventLogFilter(query);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM scan_event ${clause}`).get(...params) as {
    n: number;
  };
  return row.n;
}

/** 事件日志总行数 */
export function countEventLog(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM scan_event').get() as { n: number };
  return row.n;
}

/** 末次收到事件的时间（没有事件时为 null） */
export function lastEventAt(db: DatabaseSync): string | null {
  const row = db
    .prepare('SELECT received_at FROM scan_event ORDER BY id DESC LIMIT 1')
    .get() as { received_at: string } | undefined;
  return row?.received_at ?? null;
}

/* ── 溯源查询 ───────────────────────────────────────────────────────────── */

/**
 * 按投递标识查事件行（一次投递 = 一行事件）。
 *
 * 这是「这一批到底发生了什么」的入口：request_id 同时出现在
 * 事件日志、台账行与审计行三边，按它查就能把三边串起来。
 */
export function listEventsByRequestId(db: DatabaseSync, request_id: string): EventLogRow[] {
  const rows = db
    .prepare(
      `SELECT ${EVENT_COLUMNS}
         FROM scan_event
        WHERE request_id = ?
        ORDER BY id ASC`,
    )
    .all(request_id) as unknown as Array<
    Omit<EventLogRow, 'signature_verified'> & { signature_verified: number }
  >;
  return rows.map((row) => ({ ...row, signature_verified: row.signature_verified === 1 }));
}

/**
 * 按耗材码查该码的**全部事件序列**（按收到时刻升序）。
 *
 * 查的是关联表 `scan_event_material`：设备上印的那串原始码（UDI / GS1）
 * 与归一后的院内码都能查到 —— 排障时信息科手里通常只有其中一种。
 */
export function listEventsByMaterialCode(
  db: DatabaseSync,
  material_code: string,
  options: { limit?: number } = {},
): EventLogRow[] {
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : 100;
  const rows = db
    .prepare(
      `SELECT ${EVENT_COLUMNS.split(',').map((c) => `e.${c.trim()}`).join(', ')}
         FROM scan_event e
         JOIN scan_event_material m ON m.event_id = e.id
        WHERE m.material_code = ?
        ORDER BY e.received_at ASC, e.id ASC
        LIMIT ?`,
    )
    .all(material_code, limit) as unknown as Array<
    Omit<EventLogRow, 'signature_verified'> & { signature_verified: number }
  >;
  return rows.map((row) => ({ ...row, signature_verified: row.signature_verified === 1 }));
}

/** 台账行（回查视图；只取溯源要用的字段） */
export interface TraceBindingRow {
  id: number;
  idempotency_key: string;
  operation_no: string;
  room_no: string;
  dept_code: string;
  material_code: string;
  quantity: number;
  conclusion: string;
  status: string;
  request_id: string | null;
  created_at: string;
}

/** 审计行（回查视图；只取溯源要用的字段） */
export interface TraceAuditRow {
  id: number;
  event_type: string;
  binding_key: string | null;
  operation_no: string | null;
  actor: string | null;
  detail: string | null;
  request_id: string | null;
  created_at: string;
}

/** 三向回查结果：事件 → 台账条目 → 审计链 */
export interface RequestTrace {
  /** 本次投递的标识 */
  request_id: string;
  /** 事件日志行（设备侧到底报了什么） */
  events: EventLogRow[];
  /** 这一批带进来的台账条目 */
  bindings: TraceBindingRow[];
  /** 这一批的审计行（处置轨迹） */
  audit: TraceAuditRow[];
}

/**
 * 三向回查：由 request_id 串起事件日志、台账条目与审计链。
 *
 * 排障时问的三个问题在这里一次问完：
 *   「设备报了什么」→ events（原始报文逐字保留）
 *   「这一批落了哪些账」→ bindings
 *   「后来怎么处置的」→ audit（按时间序）
 */
export function traceRequest(db: DatabaseSync, request_id: string): RequestTrace {
  const bindings = db
    .prepare(
      `SELECT id, idempotency_key, operation_no, room_no, dept_code, material_code,
              quantity, conclusion, status, request_id, created_at
         FROM material_binding
        WHERE request_id = ?
        ORDER BY id ASC`,
    )
    .all(request_id) as unknown as TraceBindingRow[];
  const audit = db
    .prepare(
      `SELECT id, event_type, binding_key, operation_no, actor, detail, request_id, created_at
         FROM audit_chain
        WHERE request_id = ?
        ORDER BY id ASC`,
    )
    .all(request_id) as unknown as TraceAuditRow[];
  return {
    request_id,
    events: listEventsByRequestId(db, request_id),
    bindings,
    audit,
  };
}

/* ── 保留策略 ───────────────────────────────────────────────────────────── */

/** 事件日志保留期默认值（天） */
export const DEFAULT_EVENT_LOG_RETENTION_DAYS = 30;

/** 事件日志最大行数默认值（行） */
export const DEFAULT_EVENT_LOG_MAX_ROWS = 100_000;

/** 保留策略参数 */
export interface EventLogRetentionOptions {
  /** 保留期（天）：比这更旧的行清掉；<= 0 表示不按时间清 */
  retentionDays?: number;
  /** 最大行数：超了就按最旧清到上限；<= 0 表示不按体量清 */
  maxRows?: number;
  /** 当前时间（毫秒）；测试可注入 */
  nowMs?: number;
}

/** 清理结果 */
export interface EventLogRetentionResult {
  /** 因超保留期清掉的行数 */
  removed_expired: number;
  /** 因超最大行数清掉的行数 */
  removed_overflow: number;
  /** 合计清掉的行数 */
  removed_total: number;
  /** 清理后剩余行数 */
  remaining: number;
  /** 保留期截止时刻（ISO）；null = 未启用时间策略 */
  cutoff_at: string | null;
  /** 本次策略用的最大行数（null = 未启用体量策略） */
  max_rows: number | null;
  /** 保留期天数（null = 未启用时间策略） */
  retention_days: number | null;
}

/**
 * 事件日志保留策略：**双阈值**（保留期 + 最大行数），超了就清最旧的。
 *
 * 为什么要清：常驻进程每天都在收事件，不清的话表会无限长 —— 手术室一天几百批，
 * 一年下来几十万行；台账库是同一块磁盘，不能让排查用的日志把业务数据挤掉。
 *
 * 口径：
 *   ① **清理的是日志，不是账** —— 台账行、计费回执、核查任务、审计链一律不动；
 *   ② **清理留痕** —— 真的清掉行就在审计链追加一行 `event_log_pruned`
 *      （清了多少行、按什么阈值清的），内审与飞检问「日志怎么少了」时有据可查；
 *   ③ **先按时间再按体量** —— 时间过期的先清，剩下的还超上限再按最旧清；
 *   ④ 关联行（事件 ↔ 耗材码）跟着一起清，不留悬空引用。
 */
export function applyEventLogRetention(
  db: DatabaseSync,
  options: EventLogRetentionOptions = {},
): EventLogRetentionResult {
  const retentionDays =
    options.retentionDays === undefined
      ? DEFAULT_EVENT_LOG_RETENTION_DAYS
      : options.retentionDays;
  const maxRows = options.maxRows === undefined ? DEFAULT_EVENT_LOG_MAX_ROWS : options.maxRows;
  const nowMs = options.nowMs ?? Date.now();

  let removedExpired = 0;
  let removedOverflow = 0;
  const cutoffAt =
    Number.isFinite(retentionDays) && retentionDays > 0
      ? new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

  if (cutoffAt !== null) {
    const expired = db
      .prepare('SELECT id FROM scan_event WHERE received_at < ? ORDER BY id ASC')
      .all(cutoffAt) as unknown as Array<{ id: number }>;
    removedExpired = deleteEventRows(db, expired.map((row) => row.id));
  }

  if (Number.isFinite(maxRows) && maxRows > 0) {
    const total = countEventLog(db);
    if (total > maxRows) {
      const overflow = db
        .prepare('SELECT id FROM scan_event ORDER BY id ASC LIMIT ?')
        .all(total - maxRows) as unknown as Array<{ id: number }>;
      removedOverflow = deleteEventRows(db, overflow.map((row) => row.id));
    }
  }

  const removedTotal = removedExpired + removedOverflow;
  const remaining = countEventLog(db);

  if (removedTotal > 0) {
    appendAudit(db, {
      event_type: 'event_log_pruned',
      binding_key: null,
      operation_no: null,
      scanner_id: null,
      actor: 'event_log_retention',
      detail: JSON.stringify({
        removed_expired: removedExpired,
        removed_overflow: removedOverflow,
        removed_total: removedTotal,
        remaining,
        cutoff_at: cutoffAt,
        max_rows: Number.isFinite(maxRows) && maxRows > 0 ? maxRows : null,
        retention_days: cutoffAt !== null ? retentionDays : null,
      }),
    });
  }

  return {
    removed_expired: removedExpired,
    removed_overflow: removedOverflow,
    removed_total: removedTotal,
    remaining,
    cutoff_at: cutoffAt,
    max_rows: Number.isFinite(maxRows) && maxRows > 0 ? maxRows : null,
    retention_days: cutoffAt !== null ? retentionDays : null,
  };
}

/** 删掉指定的事件行（连同耗材码关联行）；返回实际删掉的行数 */
function deleteEventRows(db: DatabaseSync, ids: readonly number[]): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM scan_event WHERE id = ?');
  const linkStmt = db.prepare('DELETE FROM scan_event_material WHERE event_id = ?');
  let deleted = 0;
  for (const id of ids) {
    linkStmt.run(id);
    const result = stmt.run(id);
    deleted += Number(result.changes);
  }
  return deleted;
}
