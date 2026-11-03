/**
 * 关台核对清单：按台次聚合该台**全部**耗材条目，给出「能不能关台」的一行结论。
 *
 * 护士长在关台那一刻要的是**一份能签字的清单**：
 *   这一台扫了哪些耗材、哪些绑上了、哪些已经生成计费、哪些还挂在核查待办里。
 *
 * 与既有台账面的分工：
 *   - `ledger` 子命令查的是「台账里有什么」（条目视角）；
 *   - `pack` 导的是「**待核查**的条目」（异常视角）；
 *   - 本模块导的是「**这一台**的全部条目 + 关台结论」（台次视角）——
 *     护士长按台次签认的就是这一份。
 *
 * 四条硬约束：
 *   ① **一条不漏** —— 条目集合是「台账行 ∪ 独立核查条目」。
 *      被拒绝的耗材（耗材码未建档 / 台次已关台）**没有台账行**，只有核查条目；
 *      只查台账会漏掉它们 —— 而它们恰恰是要签字的那一部分。
 *   ② **只读不改** —— 本模块只**读**台账、回执与核查条目，一个字都不改；
 *      清单是盘点，不是纠正（纠正走核查任务的人工确认与撤回）。
 *   ③ **不落患者标识** —— 导出字段固定白名单，只有台次上下文与耗材码。
 *   ④ **结论可追** —— 每条待核查条目都带原因码、统一错误码与责任岗位，
 *      护士长照着清单就能直接找到人（路由口径见 docs/api/check-routing.md）。
 *
 * 关台判定口径（**不猜、不替人闭环**）：
 *   - 存在待处理核查条目 → 「待核查 N 条」（有人正在跟，条目清单逐条列出）；
 *   - 没有待核查条目、但有条目还没生成成功计费 → 「待计费 N 条」
 *     （没人跟的静默缺口 —— 最容易被漏掉的一类）；
 *   - 两者都没有 → 「可关台」。
 *   已由人工落定闭环（核查条目 closed / 台账状态 closed、confirmed）的条目
 *   **不再计入待计费** —— 人已经拍过板了，系统不重复催。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { ChargeState } from '../engine/binding.js';

/* ── 核查状态 ─────────────────────────────────────────────────────────── */

/** 条目的核查状态 */
export const CLOSING_CHECK_STATUS = {
  /** 不涉及核查（绑上后一切正常） */
  none: 'none',
  /** 待核查（核查条目 pending） */
  pending: 'pending',
  /** 人工已落定结论（核查条目 closed） */
  closed: 'closed',
} as const;

export type ClosingCheckStatus = (typeof CLOSING_CHECK_STATUS)[keyof typeof CLOSING_CHECK_STATUS];

/* ── 汇总结论标签 ─────────────────────────────────────────────────────── */

/** 全部条目已闭环 */
export const CLOSING_LABEL_CAN_CLOSE = '可关台';
/** 本台没有任何扫码条目 */
export const CLOSING_LABEL_NO_ITEMS = '无扫码记录';

/* ── 导出字段白名单 ───────────────────────────────────────────────────── */

/**
 * 关台核对清单导出字段白名单。
 *
 * 只有台次上下文、耗材码与耗材名、数量与计价口径、绑定结论、计费状态、
 * 核查状态与人工结论 —— **没有任何患者标识字段**
 * （耗材码只绑手术台次，不落患者可识别明细）。
 */
export const CLOSING_EXPORT_FIELDS = [
  'operation_no',
  'room_no',
  'master_room_no',
  'dept_code',
  'operation_status',
  'material_code',
  'material_name',
  'quantity',
  'charge_quantity',
  'price_code',
  'fee_category',
  'medical_insurance_class',
  'conclusion',
  'binding_status',
  'charge_state',
  'check_status',
  'manual_conclusion',
  'reason_code',
  'error_code',
  'assignee_role',
  'check_task_id',
  'confirmed_by',
  'confirmed_at',
  'created_at',
  'summary_label',
] as const;

export type ClosingExportField = (typeof CLOSING_EXPORT_FIELDS)[number];
export type ClosingExportRow = Record<ClosingExportField, string | number | null>;

/* ── 数据形状 ─────────────────────────────────────────────────────────── */

/** 清单里的一条耗材条目 */
export interface ClosingItem {
  /** 台次号 */
  operation_no: string;
  /** 手术间（事件侧：扫码发生地） */
  room_no: string;
  /** 排台侧手术间（归属双因子核对的另一侧） */
  master_room_no: string;
  /** 科室编码 */
  dept_code: string;
  /** 耗材码（归一后） */
  material_code: string;
  /** 耗材名（主数据） */
  material_name: string;
  /** 数量（原始包装数） */
  quantity: number;
  /** 计价数量（换算后；无换算记录时与数量相同） */
  charge_quantity: number | null;
  /** 计价口径（价码） */
  price_code: string | null;
  /** 费用类别 */
  fee_category: string | null;
  /** 医保分类 */
  medical_insurance_class: string | null;
  /** 绑定结论（BOUND / NOT_REGISTERED / CROSS_OP_DUP / CLOSED / CHARGE_REJECTED） */
  conclusion: string;
  /** 条目状态（台账状态机；独立核查条目为 rejected） */
  binding_status: string;
  /** 计费状态 */
  charge_state: ChargeState;
  /** 核查状态 */
  check_status: ClosingCheckStatus;
  /** 人工结论（护士长 / 耗材管理岗落定的） */
  manual_conclusion: string | null;
  /** 原因码 */
  reason_code: string | null;
  /** 统一错误码（与日志、核查条目同一个码） */
  error_code: string | null;
  /** 责任岗位 */
  assignee_role: string | null;
  /** 关联的核查条目 id */
  check_task_id: number | null;
  /** 人工确认人 */
  confirmed_by: string | null;
  /** 人工确认时间 */
  confirmed_at: string | null;
  /** 落账时间 */
  created_at: string;
  /** 该条目是否待核查（有待处理核查条目） */
  pending_check: boolean;
  /** 该条目是否待计费（还没生成成功计费，且没有人在跟这条） */
  pending_charge: boolean;
}

/** 清单里待核查条目的精简形状（终端版与 JSON 版都用它） */
export interface ClosingPendingItem {
  material_code: string;
  material_name: string;
  quantity: number;
  conclusion: string;
  reason_code: string | null;
  error_code: string | null;
  assignee_role: string | null;
  check_task_id: number | null;
}

/** 一个台次的关台结论 */
export interface ClosingOperation {
  operation_no: string;
  /** 手术间（排台侧；排台查不到时回落到条目上的手术间） */
  room_no: string;
  /** 科室（排台侧） */
  dept_code: string;
  /** 排台台次状态：open / closed / unknown（排台里查不到该台次） */
  operation_status: string;
  /** 本台耗材条目数 */
  item_count: number;
  /** 绑定成功条数 */
  bound_count: number;
  /** 已生成计费条数 */
  charged_count: number;
  /** 待核查条数 */
  pending_check_count: number;
  /** 待计费条数（没人跟的静默缺口） */
  pending_charge_count: number;
  /** 汇总结论标签 */
  summary_label: string;
  /** 能不能关台 */
  can_close: boolean;
  /** 待核查条目清单 */
  pending_items: ClosingPendingItem[];
  /** 待计费条目清单（已排除待核查条目，避免重复计数） */
  pending_charge_items: ClosingPendingItem[];
  /** 本台全部条目 */
  items: ClosingItem[];
}

/** 导出范围 */
export interface ClosingScope {
  /** 只看某个台次 */
  operation_no?: string | null;
  /** 台次列表（批量导出用） */
  operations?: readonly string[] | null;
  /** 落账时间起点（含，ISO 字符串） */
  from?: string | null;
  /** 落账时间终点（含，ISO 字符串） */
  to?: string | null;
  /** 最多返回多少个台次（默认 200） */
  limit?: number;
}

/** 关台核对清单报告 */
export interface ClosingChecklistReport {
  generated_at: string;
  /** 导出范围（回显，方便留档） */
  scope: {
    operation_no: string | null;
    operations: string[];
    from: string | null;
    to: string | null;
  };
  /** 逐台次结论 */
  operations: ClosingOperation[];
  /** 全部条目（导出用的扁平视图） */
  items: ClosingItem[];
  /** 合计 */
  totals: {
    operations: number;
    items: number;
    bound: number;
    charged: number;
    pending_check: number;
    pending_charge: number;
    can_close_operations: number;
  };
}

/* ── 错误 ─────────────────────────────────────────────────────────────── */

/** 关台核对清单层的错误（带错误码） */
export class ClosingReportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClosingReportError';
    this.code = code;
  }
}

/** 时间范围不合法 */
export const ERR_CLOSING_INVALID_RANGE = 'ERR_CLOSING_INVALID_RANGE';
/** 导出范围不合法 */
export const ERR_CLOSING_INVALID_SCOPE = 'ERR_CLOSING_INVALID_SCOPE';

/* ── 内部行形状 ───────────────────────────────────────────────────────── */

interface BindingJoinRow {
  operation_no: string;
  room_no: string;
  master_room_no: string | null;
  dept_code: string;
  material_code: string;
  material_name: string | null;
  quantity: number;
  charge_quantity: number | null;
  price_code: string | null;
  fee_category: string | null;
  medical_insurance_class: string | null;
  conclusion: string;
  status: string;
  check_task_id: number | null;
  created_at: string;
  task_id: number | null;
  task_status: string | null;
  task_reason_code: string | null;
  task_error_code: string | null;
  task_assignee_role: string | null;
  task_confirmed_by: string | null;
  task_confirmed_at: string | null;
  task_confirmed_conclusion: string | null;
}

interface StandaloneTaskRow {
  task_id: number;
  operation_no: string;
  room_no: string;
  dept_code: string | null;
  material_code: string;
  material_name: string | null;
  quantity: number | null;
  master_price_code: string | null;
  master_fee_category: string | null;
  master_insurance_class: string | null;
  conclusion: string;
  task_status: string;
  task_reason_code: string | null;
  task_error_code: string | null;
  task_assignee_role: string | null;
  task_confirmed_by: string | null;
  task_confirmed_at: string | null;
  task_confirmed_conclusion: string | null;
  created_at: string;
}

interface OperationMasterRow {
  operation_no: string;
  room_no: string;
  dept_code: string;
  status: string;
}

interface ReceiptSummaryRow {
  material_code: string;
  operation_no: string;
  attempts: number;
  accepted: number | null;
  retryable: number | null;
}

/* ── 范围归一 ─────────────────────────────────────────────────────────── */

/** 把范围里的台次号去重、去空、排序 */
function normalizeOperations(scope: ClosingScope): string[] {
  const raw: string[] = [];
  if (scope.operation_no && scope.operation_no.trim().length > 0) raw.push(scope.operation_no.trim());
  for (const item of scope.operations ?? []) {
    const value = String(item ?? '').trim();
    if (value.length > 0) raw.push(value);
  }
  return [...new Set(raw)].sort((a, b) => a.localeCompare(b));
}

/** 时间边界归一：转成可与 created_at 直接比较的 UTC ISO 字符串 */
function normalizeBound(value: string | null | undefined, label: string): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (text.length === 0) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new ClosingReportError(
      ERR_CLOSING_INVALID_RANGE,
      `时间范围 ${label} 不可解析：${text}（用 ISO 时间，如 2026-01-15T00:00:00.000Z 或 2026-01-15）`,
    );
  }
  return new Date(parsed).toISOString();
}

/** 条目过滤条件（台次 / 时间窗） */
interface ItemFilter {
  /** 条件片段（不含 WHERE） */
  where: string[];
  params: string[];
  /** 拼成 SQL 片段（空条件返回空串） */
  clause(prefix?: string): string;
}

/**
 * 构造条目过滤条件。
 *
 * 台次条件落在 `operation_no` 上，时间窗落在 `created_at` 上 ——
 * 台账行与核查条目都用同一套口径（核查条目按建单时间算）。
 */
function buildItemFilter(scope: ClosingScope): ItemFilter {
  const where: string[] = [];
  const params: string[] = [];
  const operations = normalizeOperations(scope);
  if (operations.length > 0) {
    where.push(`operation_no IN (${operations.map(() => '?').join(', ')})`);
    params.push(...operations);
  }
  const from = normalizeBound(scope.from, '起始时间');
  const to = normalizeBound(scope.to, '截止时间');
  if (from) {
    where.push('created_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('created_at <= ?');
    params.push(to);
  }
  return {
    where,
    params,
    clause: (prefix = '') =>
      where.length > 0 ? `WHERE ${where.map((item) => `${prefix}${item}`).join(' AND ')}` : '',
  };
}

/* ── 计费状态 ─────────────────────────────────────────────────────────── */

/** 按回执行推导计费状态（与 ledger 子命令同一口径） */
function deriveChargeState(row: ReceiptSummaryRow): ChargeState {
  if ((row.accepted ?? 0) > 0) return 'accepted';
  if ((row.retryable ?? 0) > 0) return 'pending_retry';
  if ((row.attempts ?? 0) > 0) return 'rejected';
  return 'not_submitted';
}

/** 取这些台次的回执汇总（按耗材码 + 台次归并） */
function loadChargeStates(db: DatabaseSync, operationNos: readonly string[]): Map<string, ChargeState> {
  const states = new Map<string, ChargeState>();
  if (operationNos.length === 0) return states;
  const placeholders = operationNos.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT material_code, operation_no,
              COUNT(*) AS attempts,
              SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN accepted = 0 AND retryable = 1 THEN 1 ELSE 0 END) AS retryable
         FROM charge_receipt
        WHERE operation_no IN (${placeholders})
        GROUP BY material_code, operation_no`,
    )
    .all(...operationNos) as unknown as ReceiptSummaryRow[];
  for (const row of rows) {
    states.set(`${row.material_code} ${row.operation_no}`, deriveChargeState(row));
  }
  return states;
}

/** 条目所属的台次上下文里取回执状态 */
function chargeStateOf(
  states: Map<string, ChargeState>,
  material_code: string,
  operation_no: string,
): ChargeState {
  return states.get(`${material_code} ${operation_no}`) ?? 'not_submitted';
}

/* ── 条目装载 ─────────────────────────────────────────────────────────── */

/** 台账行（绑上过的条目），带上它们挂着的核查条目 */
function loadBindingItems(db: DatabaseSync, filter: ItemFilter): BindingJoinRow[] {
  return db
    .prepare(
      `SELECT b.operation_no, b.room_no, b.master_room_no, b.dept_code, b.material_code,
              COALESCE(m.name, '') AS material_name,
              b.quantity, b.charge_quantity, b.price_code, b.fee_category,
              b.medical_insurance_class, b.conclusion, b.status, b.check_task_id, b.created_at,
              t.id AS task_id, t.status AS task_status, t.reason_code AS task_reason_code,
              t.error_code AS task_error_code, t.assignee_role AS task_assignee_role,
              t.confirmed_by AS task_confirmed_by, t.confirmed_at AS task_confirmed_at,
              t.confirmed_conclusion AS task_confirmed_conclusion
         FROM material_binding b
         LEFT JOIN material m ON m.material_code = b.material_code
         LEFT JOIN check_task t ON t.id = b.check_task_id
         ${filter.clause('b.')}
        ORDER BY b.id ASC`,
    )
    .all(...filter.params) as unknown as BindingJoinRow[];
}

/**
 * 独立核查条目（**没有台账行**的那些）。
 *
 * 被拒绝的耗材（耗材码未建档 / 台次已关台 / 归属冲突）压根不落台账，
 * 只留一条核查条目 —— 这一段是「关台清单一条不漏」的关键。
 */
function loadStandaloneTaskItems(db: DatabaseSync, filter: ItemFilter): StandaloneTaskRow[] {
  const clause = filter.clause('t.');
  return db
    .prepare(
      `SELECT t.id AS task_id, t.operation_no, t.room_no, t.dept_code, t.material_code,
              COALESCE(m.name, '') AS material_name, t.quantity,
              m.price_code AS master_price_code, m.fee_category AS master_fee_category,
              m.medical_insurance_class AS master_insurance_class,
              t.conclusion, t.status AS task_status, t.reason_code AS task_reason_code,
              t.error_code AS task_error_code, t.assignee_role AS task_assignee_role,
              t.confirmed_by AS task_confirmed_by, t.confirmed_at AS task_confirmed_at,
              t.confirmed_conclusion AS task_confirmed_conclusion, t.created_at
         FROM check_task t
         LEFT JOIN material m ON m.material_code = t.material_code
        WHERE NOT EXISTS (SELECT 1 FROM material_binding b WHERE b.check_task_id = t.id)
          ${clause.length > 0 ? `AND ${clause.slice('WHERE '.length)}` : ''}
        ORDER BY t.id ASC`,
    )
    .all(...filter.params) as unknown as StandaloneTaskRow[];
}

/** 排台主数据里的台次（给清单抬头用） */
function loadOperations(db: DatabaseSync, operationNos: readonly string[]): Map<string, OperationMasterRow> {
  const map = new Map<string, OperationMasterRow>();
  if (operationNos.length === 0) return map;
  const placeholders = operationNos.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT operation_no, room_no, dept_code, status
         FROM operation WHERE operation_no IN (${placeholders})`,
    )
    .all(...operationNos) as unknown as OperationMasterRow[];
  for (const row of rows) map.set(row.operation_no, row);
  return map;
}

/* ── 汇总标签 ─────────────────────────────────────────────────────────── */

/**
 * 台次的关台结论标签。
 *
 * 三档（优先级从上到下）：
 *   ① 有待核查条目 → 「待核查 N 条」（有人在跟）；
 *   ② 没待核查、但有条目还没生成成功计费 → 「待计费 N 条」（静默缺口）；
 *   ③ 都没有 → 「可关台」。
 */
export function closingSummaryLabel(pending_check: number, pending_charge: number): string {
  if (pending_check > 0 && pending_charge > 0) {
    return `待核查 ${pending_check} 条 · 待计费 ${pending_charge} 条`;
  }
  if (pending_check > 0) return `待核查 ${pending_check} 条`;
  if (pending_charge > 0) return `待计费 ${pending_charge} 条`;
  return CLOSING_LABEL_CAN_CLOSE;
}

/** 条目是否已被人工处置（处置过就不重复催） */
function isResolvedByHuman(item: ClosingItem): boolean {
  return (
    item.binding_status === 'closed' ||
    item.binding_status === 'confirmed' ||
    item.check_status === CLOSING_CHECK_STATUS.closed
  );
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */

/**
 * 生成关台核对清单。
 *
 * 只读：台账行 + 独立核查条目 + 回执 + 排台主数据，一个字都不改。
 */
export function buildClosingChecklist(
  db: DatabaseSync,
  scope: ClosingScope = {},
): ClosingChecklistReport {
  const filter = buildItemFilter(scope);
  const taskFilter = buildItemFilter(scope);

  const bindingRows = loadBindingItems(db, filter);
  const standaloneRows = loadStandaloneTaskItems(db, taskFilter);

  const operationNos = [
    ...new Set([...bindingRows.map((row) => row.operation_no), ...standaloneRows.map((row) => row.operation_no)]),
  ].sort((a, b) => a.localeCompare(b));
  const chargeStates = loadChargeStates(db, operationNos);

  const items: ClosingItem[] = [];

  // ① 台账行（绑上过的条目）
  for (const row of bindingRows) {
    const checkStatus: ClosingCheckStatus =
      row.task_status === 'pending'
        ? CLOSING_CHECK_STATUS.pending
        : row.task_status === 'closed'
          ? CLOSING_CHECK_STATUS.closed
          : CLOSING_CHECK_STATUS.none;
    const item: ClosingItem = {
      operation_no: row.operation_no,
      room_no: row.room_no,
      master_room_no: row.master_room_no ?? row.room_no,
      dept_code: row.dept_code,
      material_code: row.material_code,
      material_name: row.material_name ?? '',
      quantity: Number(row.quantity ?? 0),
      charge_quantity: row.charge_quantity == null ? null : Number(row.charge_quantity),
      price_code: row.price_code,
      fee_category: row.fee_category,
      medical_insurance_class: row.medical_insurance_class,
      conclusion: row.conclusion,
      binding_status: row.status,
      charge_state: chargeStateOf(chargeStates, row.material_code, row.operation_no),
      check_status: checkStatus,
      manual_conclusion: row.task_confirmed_conclusion,
      reason_code: row.task_reason_code,
      error_code: row.task_error_code,
      assignee_role: row.task_assignee_role,
      check_task_id: row.task_id,
      confirmed_by: row.task_confirmed_by,
      confirmed_at: row.task_confirmed_at,
      created_at: row.created_at,
      pending_check: false,
      pending_charge: false,
    };
    item.pending_check = checkStatus === CLOSING_CHECK_STATUS.pending;
    item.pending_charge =
      !item.pending_check && !isResolvedByHuman(item) && item.charge_state !== 'accepted';
    items.push(item);
  }

  // ② 独立核查条目（被拒绝的耗材没有台账行 —— 漏了就等于漏签字）
  for (const row of standaloneRows) {
    const checkStatus: ClosingCheckStatus =
      row.task_status === 'closed' ? CLOSING_CHECK_STATUS.closed : CLOSING_CHECK_STATUS.pending;
    const item: ClosingItem = {
      operation_no: row.operation_no,
      room_no: row.room_no,
      master_room_no: row.room_no,
      dept_code: row.dept_code ?? '',
      material_code: row.material_code,
      material_name: row.material_name ?? '',
      quantity: Number(row.quantity ?? 0),
      charge_quantity: null,
      price_code: row.master_price_code,
      fee_category: row.master_fee_category,
      medical_insurance_class: row.master_insurance_class,
      conclusion: row.conclusion,
      binding_status: 'rejected',
      charge_state: 'not_submitted',
      check_status: checkStatus,
      manual_conclusion: row.task_confirmed_conclusion,
      reason_code: row.task_reason_code,
      error_code: row.task_error_code,
      assignee_role: row.task_assignee_role,
      check_task_id: row.task_id,
      confirmed_by: row.task_confirmed_by,
      confirmed_at: row.task_confirmed_at,
      created_at: row.created_at,
      pending_check: false,
      pending_charge: false,
    };
    item.pending_check = checkStatus === CLOSING_CHECK_STATUS.pending;
    item.pending_charge =
      !item.pending_check && !isResolvedByHuman(item) && item.charge_state !== 'accepted';
    items.push(item);
  }

  // ③ 排台主数据（抬头的手术间 / 科室 / 台次状态）
  const explicitOperations = normalizeOperations(scope);
  const allOperationNos = [
    ...new Set([...operationNos, ...explicitOperations]),
  ].sort((a, b) => a.localeCompare(b));
  const operationMaster = loadOperations(db, allOperationNos);

  // ④ 按台次归并
  const grouped = new Map<string, ClosingItem[]>();
  for (const item of items) {
    const bucket = grouped.get(item.operation_no);
    if (bucket) bucket.push(item);
    else grouped.set(item.operation_no, [item]);
  }

  // 指定了台次列表但排台里查不到、又没有条目的台次 —— 不出现在清单里（没有可核对的条目）
  const operations: ClosingOperation[] = [];
  for (const operation_no of grouped.keys()) {
    const operationItems = grouped.get(operation_no) ?? [];
    const master = operationMaster.get(operation_no);
    const roomNo = master?.room_no ?? operationItems[0]?.room_no ?? '';
    const deptCode = master?.dept_code ?? operationItems[0]?.dept_code ?? '';

    const pendingItems = operationItems.filter((item) => item.pending_check);
    const pendingChargeItems = operationItems.filter((item) => item.pending_charge);
    const boundCount = operationItems.filter((item) => item.conclusion === 'BOUND').length;
    const chargedCount = operationItems.filter((item) => item.charge_state === 'accepted').length;
    const label = closingSummaryLabel(pendingItems.length, pendingChargeItems.length);

    operations.push({
      operation_no,
      room_no: roomNo,
      dept_code: deptCode,
      operation_status: master?.status ?? 'unknown',
      item_count: operationItems.length,
      bound_count: boundCount,
      charged_count: chargedCount,
      pending_check_count: pendingItems.length,
      pending_charge_count: pendingChargeItems.length,
      summary_label: label,
      can_close: pendingItems.length === 0 && pendingChargeItems.length === 0,
      pending_items: pendingItems.map(toPendingItem),
      pending_charge_items: pendingChargeItems.map(toPendingItem),
      items: operationItems,
    });
  }

  // ⑤ 指定了台次列表、但该台一条都没扫 —— 也要在清单里出现（否则「没扫」和「漏扫」分不清）
  for (const operation_no of explicitOperations) {
    if (grouped.has(operation_no)) continue;
    const master = operationMaster.get(operation_no);
    operations.push({
      operation_no,
      room_no: master?.room_no ?? '',
      dept_code: master?.dept_code ?? '',
      operation_status: master?.status ?? 'unknown',
      item_count: 0,
      bound_count: 0,
      charged_count: 0,
      pending_check_count: 0,
      pending_charge_count: 0,
      summary_label: CLOSING_LABEL_NO_ITEMS,
      can_close: true,
      pending_items: [],
      pending_charge_items: [],
      items: [],
    });
  }

  operations.sort((a, b) => a.operation_no.localeCompare(b.operation_no));

  const limit = Number.isInteger(scope.limit) && (scope.limit as number) > 0 ? (scope.limit as number) : 200;
  const limited = operations.slice(0, limit);
  const limitedNos = new Set(limited.map((operation) => operation.operation_no));
  const limitedItems = items.filter((item) => limitedNos.has(item.operation_no));

  return {
    generated_at: new Date().toISOString(),
    scope: {
      operation_no: scope.operation_no?.trim() || null,
      operations: explicitOperations,
      from: normalizeBound(scope.from, '起始时间'),
      to: normalizeBound(scope.to, '截止时间'),
    },
    operations: limited,
    items: limitedItems,
    totals: {
      operations: limited.length,
      items: limitedItems.length,
      bound: limitedItems.filter((item) => item.conclusion === 'BOUND').length,
      charged: limitedItems.filter((item) => item.charge_state === 'accepted').length,
      pending_check: limitedItems.filter((item) => item.pending_check).length,
      pending_charge: limitedItems.filter((item) => item.pending_charge).length,
      can_close_operations: limited.filter((operation) => operation.can_close).length,
    },
  };
}

/** 条目 → 待办条目（精简形状） */
function toPendingItem(item: ClosingItem): ClosingPendingItem {
  return {
    material_code: item.material_code,
    material_name: item.material_name,
    quantity: item.quantity,
    conclusion: item.conclusion,
    reason_code: item.reason_code,
    error_code: item.error_code,
    assignee_role: item.assignee_role,
    check_task_id: item.check_task_id,
  };
}

/* ── 导出 ─────────────────────────────────────────────────────────────── */

/** 条目 → 导出行（字段白名单顺序；带上该台次的汇总标签） */
function toExportRow(item: ClosingItem, operation: ClosingOperation | undefined): ClosingExportRow {
  return {
    operation_no: item.operation_no,
    room_no: item.room_no,
    master_room_no: item.master_room_no,
    dept_code: item.dept_code,
    operation_status: operation?.operation_status ?? '',
    material_code: item.material_code,
    material_name: item.material_name,
    quantity: item.quantity,
    charge_quantity: item.charge_quantity,
    price_code: item.price_code,
    fee_category: item.fee_category,
    medical_insurance_class: item.medical_insurance_class,
    conclusion: item.conclusion,
    binding_status: item.binding_status,
    charge_state: item.charge_state,
    check_status: item.check_status,
    manual_conclusion: item.manual_conclusion,
    reason_code: item.reason_code,
    error_code: item.error_code,
    assignee_role: item.assignee_role,
    check_task_id: item.check_task_id,
    confirmed_by: item.confirmed_by,
    confirmed_at: item.confirmed_at,
    created_at: item.created_at,
    summary_label: operation?.summary_label ?? '',
  };
}

/** 报告 → 导出行（扁平视图，字段白名单顺序） */
export function toClosingExportRows(report: ClosingChecklistReport): ClosingExportRow[] {
  const operations = new Map(report.operations.map((operation) => [operation.operation_no, operation]));
  return report.items.map((item) => toExportRow(item, operations.get(item.operation_no)));
}

/** CSV 字段转义 */
function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 关台核对清单 → CSV（表头 = 白名单顺序） */
export function closingChecklistToCsv(report: ClosingChecklistReport): string {
  const rows = toClosingExportRows(report);
  const header = CLOSING_EXPORT_FIELDS.join(',');
  const lines = rows.map((row) =>
    CLOSING_EXPORT_FIELDS.map((field) => csvCell(row[field])).join(','),
  );
  return [header, ...lines].join('\n');
}

/** 关台核对清单 → JSON（结构化：逐台次结论 + 逐条明细） */
export function closingChecklistToJson(report: ClosingChecklistReport): string {
  return JSON.stringify(
    {
      generated_at: report.generated_at,
      scope: report.scope,
      fields: [...CLOSING_EXPORT_FIELDS],
      totals: report.totals,
      operations: report.operations.map((operation) => ({
        operation_no: operation.operation_no,
        room_no: operation.room_no,
        dept_code: operation.dept_code,
        operation_status: operation.operation_status,
        item_count: operation.item_count,
        bound_count: operation.bound_count,
        charged_count: operation.charged_count,
        pending_check_count: operation.pending_check_count,
        pending_charge_count: operation.pending_charge_count,
        summary_label: operation.summary_label,
        can_close: operation.can_close,
        pending_items: operation.pending_items,
        pending_charge_items: operation.pending_charge_items,
        items: operation.items.map((item) => toExportRow(item, operation)),
      })),
    },
    null,
    2,
  );
}

/* ── 终端可读版本 ─────────────────────────────────────────────────────── */

/** 渲染一张对齐的文本表 */
function renderTable(headers: readonly string[], rows: readonly (string | number)[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => String(row[column] ?? '').length)),
  );
  const line = (cells: readonly (string | number)[]): string =>
    cells
      .map((cell, column) => String(cell ?? '').padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

/** 核查状态 → 中文 */
const CHECK_STATUS_LABELS: Readonly<Record<ClosingCheckStatus, string>> = {
  none: '不涉及核查',
  pending: '待核查',
  closed: '已落定',
};

/** 计费状态 → 中文 */
const CHARGE_STATE_LABELS: Readonly<Record<ChargeState, string>> = {
  not_submitted: '未提交',
  submitted: '已提交',
  accepted: '已计费',
  rejected: '计费被拒',
  pending_retry: '待重投',
};

/**
 * 关台核对清单的终端可读版本。
 *
 * 每个台次一段：抬头（台次 / 手术间 / 科室 / 排台状态）、一行汇总数字、
 * 一行关台结论，再列待核查条目与条目明细 —— 护士长照着这一屏逐台签认。
 */
export function renderClosingChecklist(report: ClosingChecklistReport): string {
  const lines: string[] = [];
  lines.push('== 关台核对清单 ==');
  lines.push(
    `  台次 ${report.totals.operations} 个 / 耗材条目 ${report.totals.items} 条 / ` +
      `已计费 ${report.totals.charged} 条 / 待核查 ${report.totals.pending_check} 条 / ` +
      `待计费 ${report.totals.pending_charge} 条 / 可关台 ${report.totals.can_close_operations} 个`,
  );

  for (const operation of report.operations) {
    lines.push('');
    lines.push(
      `-- 台次 ${operation.operation_no} ｜ 手术间 ${operation.room_no || '—'} ｜ 科室 ${operation.dept_code || '—'} ｜ 排台状态 ${operation.operation_status}`,
    );
    lines.push(
      `  耗材 ${operation.item_count} 条 ｜ 绑定成功 ${operation.bound_count} 条 ｜ 已计费 ${operation.charged_count} 条 ｜ ` +
        `待核查 ${operation.pending_check_count} 条 ｜ 待计费 ${operation.pending_charge_count} 条`,
    );
    lines.push(`  汇总：${operation.summary_label}`);

    if (operation.pending_items.length > 0) {
      lines.push('  待核查条目：');
      for (const item of operation.pending_items) {
        lines.push(
          `    - ${item.material_code}${item.material_name ? `（${item.material_name}）` : ''}　数量 ${item.quantity}　` +
            `结论 ${item.conclusion}　原因 ${item.reason_code ?? '—'}　错误码 ${item.error_code ?? '—'}　` +
            `责任岗位 ${item.assignee_role ?? '（尚未分派）'}`,
        );
      }
    }
    if (operation.pending_charge_items.length > 0) {
      lines.push('  待计费条目（没人跟的静默缺口）：');
      for (const item of operation.pending_charge_items) {
        lines.push(
          `    - ${item.material_code}${item.material_name ? `（${item.material_name}）` : ''}　数量 ${item.quantity}　结论 ${item.conclusion}`,
        );
      }
    }

    if (operation.items.length > 0) {
      lines.push('  条目明细：');
      lines.push(
        renderTable(
          ['耗材码', '数量', '结论', '计费状态', '核查状态', '人工结论'],
          operation.items.map((item) => [
            item.material_code,
            item.quantity,
            item.conclusion,
            CHARGE_STATE_LABELS[item.charge_state] ?? item.charge_state,
            CHECK_STATUS_LABELS[item.check_status] ?? item.check_status,
            item.manual_conclusion ?? '—',
          ]),
        ),
      );
    }
  }

  return lines.join('\n');
}
