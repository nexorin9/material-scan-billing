/**
 * 月度对账聚合：把「这个月、这个科室」的高值耗材使用与计费结果，对成一张可核对的表。
 *
 * 关台核对解决的是**一台手术**（见 `src/check/closing-report.ts`）；
 * 高值耗材管理岗要的是**一个月**：
 *
 *   - 本月这个科室用了多少条高值耗材？数量多少？
 *   - 其中多少条**计费成功**？多少条被对端拒收？
 *   - 多少条还挂在**待核查**（没人落定结论）？
 *   - 台账 ↔ 计费回执之间有多少条**差异**？差异明细在哪？
 *
 * 本模块把这四问做成**一个聚合 + 一张明细**：
 *
 *   material_binding（台账）── 按 (科室 × 业务月) ──┐
 *   charge_receipt（计费回执）── 最新一次尝试 ────┼──→ 月度分组汇总
 *   check_task（待核查）─────────────────────────┤
 *   差异台账（台账 ↔ 回执 对账结果）────────────┘
 *                                                  └──→ 逐条明细（可下钻到台次 / 耗材码）
 *
 * 三条硬约束：
 *   ① **月份按业务时间切，不按落账时间切** ——
 *      业务月取台账行的 `use_time`（设备上报的扫码时间，归一后落库）；
 *      老行没有 `use_time` 时退回 `created_at`（落账时间）。
 *      月份一律按 **Asia/Shanghai** 计算（国内医院的账期就是本地日历月），
 *      不按 UTC 切 —— 否则月末 31 号深夜的那笔会被算进下个月。
 *   ② **每个数字都能回溯到台账与回执** ——
 *      明细行带台次号、耗材码、数量、结论、原因码、最新一次回执的 attempt，
 *      抽样回查时逐条比对台账与回执，对不上就是包错了。
 *   ③ **只读，不改业务状态** ——
 *      聚合只读台账 / 回执 / 核查条目；对账差异由 `src/ledger/reconcile.ts`
 *      单独落差异台账，本模块**不替人落定结论、不自动关核查条目**。
 *
 * 语义来源（源产品主路径）：源产品把「一条批次消息按目标实体拆成逐目标投递」
 * 与「逐目标回执」成对产出 —— 收件人清单与回执清单能一一对上。
 * 本模块照此语义改写成月度账：台账清单与回执清单按（耗材 × 台次）对齐，
 * 对齐后按（科室 × 月份）归拢，多出来的一侧就是差异。
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  reconcileLedgerVsReceipts,
  type ReconcileDiffRow,
  type ReconcileDiffType,
} from './reconcile.js';

/* ── 账期时区 ─────────────────────────────────────────────────────────── */

/**
 * 账期时区（默认东八区）。
 *
 * 国内医院的月度账按**本地日历月**切；按 UTC 切会把月末深夜的那笔算进下个月。
 */
export const MONTH_TIMEZONE = 'Asia/Shanghai';

/**
 * 账期时区的固定偏移（毫秒）。
 *
 * 中国自 1991 年起不再实行夏令时，东八区是**固定偏移** —— 用固定偏移算月份，
 * 与 ICU 料版本无关，跨机器跑出来的账期永远一致。
 */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 账期月份的 SQL 表达式（与 `monthOf` 逐字同口径）。
 *
 * 聚合在 SQL 侧按月份圈定行（避免把整本台账拉进内存），JS 侧再按同一口径
 * 取月份 —— 两边必须一致，所以这里把表达式固化成常量。
 */
export const MONTH_SQL_EXPR = `strftime('%Y-%m', datetime(COALESCE(use_time, created_at), '+8 hours'))`;

/**
 * 取一个时间戳落在哪个业务月（`YYYY-MM`，东八区）。
 *
 * 解析不出来的返回 null —— **不硬凑一个月份**（猜出来的月份会让对账错账）。
 */
export function monthOf(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + CN_OFFSET_MS).toISOString().slice(0, 7);
}

/** 月份串是否合法（`YYYY-MM`） */
export function isMonthKey(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/* ── 汇总行 ───────────────────────────────────────────────────────────── */

/** 月度分组汇总的一行（科室 × 月份） */
export interface MonthlyGroupRow {
  /** 科室编码 */
  dept_code: string;
  /** 业务月（YYYY-MM，Asia/Shanghai） */
  month: string;
  /** 本期使用条数（台账行数） */
  usage_count: number;
  /** 本期使用数量合计（计价数量优先，取不到退回原始数量） */
  quantity: number;
  /** 计费成功条数 */
  charge_success: number;
  /** 计费被拒条数（对端业务拒收） */
  charge_rejected: number;
  /** 计费待重投条数（通道不可达，等退避重投） */
  charge_pending_retry: number;
  /** 尚未提交计费条数 */
  charge_not_submitted: number;
  /** 待核查条数（核查条目仍 pending） */
  pending_check: number;
  /** 差异条数（台账 ↔ 回执 对账出的差异） */
  diff_count: number;
  /** 涉及台次数 */
  operations: number;
  /** 涉及耗材码数 */
  materials: number;
}

/* ── 明细行 ───────────────────────────────────────────────────────────── */

/** 计费状态（台账行当前处于计费链路的哪一步） */
export const MONTHLY_CHARGE_STATE = {
  /** 对端已收下并计费 */
  accepted: 'accepted',
  /** 对端业务拒收（不重投，转人工） */
  rejected: 'rejected',
  /** 通道不可达，等退避重投 */
  pending_retry: 'pending_retry',
  /** 还没提交过计费 */
  not_submitted: 'not_submitted',
} as const;

export type MonthlyChargeState = (typeof MONTHLY_CHARGE_STATE)[keyof typeof MONTHLY_CHARGE_STATE];

/** 月度对账明细的一行（台账行粒度） */
export interface MonthlyDetailRow {
  /** 台次号 */
  operation_no: string;
  /** 手术间 */
  room_no: string;
  /** 科室编码 */
  dept_code: string;
  /** 业务月（YYYY-MM） */
  month: string;
  /** 耗材码 */
  material_code: string;
  /** 原始数量（包装数） */
  quantity: number;
  /** 计价数量（换算后；老行取不到时退回原始数量） */
  charge_quantity: number | null;
  /** 绑定结论（五种之一） */
  conclusion: string;
  /** 结论原因码 */
  reason_code: string | null;
  /** 业务使用时间（设备上报的扫码时间） */
  use_time: string | null;
  /** 台账落账时间 */
  created_at: string;
  /** 计费状态 */
  charge_state: MonthlyChargeState;
  /** 最新一次回执的尝试序号（没有回执为 0） */
  receipt_attempt: number;
  /** 累计投递次数 */
  delivery_count: number;
  /** 对端拒收原因码 */
  receipt_reason_code: string | null;
  /** 统一错误码 */
  error_code: string | null;
  /** 关联的核查条目 id（没有为 null） */
  check_task_id: number | null;
  /** 核查条目状态（pending / closed） */
  check_status: string | null;
  /** 差异类型（该行有差异时给出） */
  diff_type: string | null;
  /** 差异归因 */
  diff_attribution: string | null;
}

/**
 * 「计费侧有、台账无」的差异行（对账出来的第三条差异）。
 *
 * 这类条目**没有台账行**，所以进不了以台账行为粒度的明细表 ——
 * 单列一张，账期按回执时间归属、科室按排台主数据归属。
 */
export interface MonthlyUnmatchedRow {
  operation_no: string;
  dept_code: string;
  month: string;
  material_code: string;
  quantity: number | null;
  reason_code: string | null;
  error_code: string | null;
  attempt: number | null;
  delivery_count: number | null;
}

/* ── 汇总 / 明细导出字段白名单 ────────────────────────────────────────── */

/** 汇总表导出字段（顺序即 CSV 列序） */
export const MONTHLY_GROUP_FIELDS = [
  'dept_code',
  'month',
  'usage_count',
  'quantity',
  'charge_success',
  'charge_rejected',
  'charge_pending_retry',
  'charge_not_submitted',
  'pending_check',
  'diff_count',
  'operations',
  'materials',
] as const;

/** 明细表导出字段（顺序即 CSV 列序） */
export const MONTHLY_DETAIL_FIELDS = [
  'operation_no',
  'room_no',
  'dept_code',
  'month',
  'material_code',
  'quantity',
  'charge_quantity',
  'conclusion',
  'reason_code',
  'use_time',
  'charge_state',
  'receipt_attempt',
  'delivery_count',
  'receipt_reason_code',
  'error_code',
  'check_task_id',
  'check_status',
  'diff_type',
  'diff_attribution',
] as const;

export type MonthlyGroupField = (typeof MONTHLY_GROUP_FIELDS)[number];
export type MonthlyDetailField = (typeof MONTHLY_DETAIL_FIELDS)[number];

/* ── 内部行形状 ───────────────────────────────────────────────────────── */

interface LedgerRow {
  id: number;
  operation_no: string;
  room_no: string;
  dept_code: string;
  material_code: string;
  quantity: number;
  charge_quantity: number | null;
  conclusion: string;
  use_time: string | null;
  created_at: string;
}

interface ReceiptRow {
  id: number;
  material_code: string;
  operation_no: string;
  attempt: number;
  accepted: number;
  kind: string | null;
  reason_code: string | null;
  error_code: string | null;
  channel_reachable: number | null;
  retryable: number | null;
  delivery_count: number | null;
  /** 回执时间（对端应答或本侧落库时间）—— 「计费侧有、台账无」那条差异靠它定账期 */
  responded_at: string | null;
  created_at: string;
}

interface CheckTaskRow {
  id: number;
  operation_no: string;
  material_code: string;
  status: string;
  reason_code: string | null;
  error_code: string | null;
}

/** 台账 ↔ 回执的对齐键（耗材码 + 台次） */
function itemKey(material_code: string, operation_no: string): string {
  return `${material_code} ${operation_no}`;
}

/* ── 聚合选项与报告 ───────────────────────────────────────────────────── */

export interface MonthlyReconcileOptions {
  /** 账期起（含，YYYY-MM）；缺省 = 不限 */
  from_month?: string | null;
  /** 账期止（含，YYYY-MM）；缺省 = 不限 */
  to_month?: string | null;
  /** 明细条数上限（默认 20000） */
  limit?: number;
  /** 是否落差异台账（默认 true；对账差异按 `src/ledger/reconcile.ts` 的口径落账） */
  persist_diffs?: boolean;
}

export interface MonthlyTotals {
  /** 台账条目数（本期） */
  usage_count: number;
  quantity: number;
  charge_success: number;
  charge_rejected: number;
  charge_pending_retry: number;
  charge_not_submitted: number;
  pending_check: number;
  diff_count: number;
  operations: number;
  materials: number;
  /** 覆盖的月份数 */
  months: number;
  /** 覆盖的科室数 */
  depts: number;
  /** 其中「计费侧有、台账无」的条数（无台账行，单列在 unmatched 里） */
  diff_unmatched: number;
}

/** 月度对账报告 */
export interface MonthlyReconcileReport {
  generated_at: string;
  /** 对账范围 */
  scope: {
    from_month: string | null;
    to_month: string | null;
    month_timezone: string;
    /** 账期内但时间解析不出月份的台账条目数（解析不出就不硬凑月份） */
    month_unresolved: number;
    /** 本轮扫过的台账条目数 */
    ledger_rows_scanned: number;
    /** 台账里符合账期的总条数（可能大于扫过的条数：触到上限时为真） */
    ledger_rows_total: number;
    /** 是否触到明细条数上限（触到就说明账期内的条目没扫全） */
    truncated: boolean;
  };
  /** 合计 */
  totals: MonthlyTotals;
  /** 分组汇总（科室 × 月份） */
  groups: MonthlyGroupRow[];
  /** 逐条明细 */
  details: MonthlyDetailRow[];
  /** 「计费侧有、台账无」的差异（没有台账行，进不了明细表） */
  unmatched: MonthlyUnmatchedRow[];
  /** 下钻索引：台次号 → 明细条数 */
  by_operation: Record<string, number>;
  /** 下钻索引：耗材码 → 明细条数 */
  by_material: Record<string, number>;
  /** 下钻索引：台次号 → 该台次涉及的所有明细（台次维度下钻用） */
  operation_detail_index: Record<string, string[]>;
  /** 下钻索引：耗材码 → 该码涉及的所有明细（耗材维度下钻用） */
  material_detail_index: Record<string, string[]>;
}

/* ── 聚合 ─────────────────────────────────────────────────────────────── */

/**
 * 按「科室 × 业务月」聚合月度对账。
 *
 * 只读台账 / 回执 / 核查条目；差异条数来自 `src/ledger/reconcile.ts` 的对账结果
 * （台账 ↔ 回执 逐条对齐），本模块不自己另写一套差异判定。
 */
export function aggregateMonthly(
  db: DatabaseSync,
  options: MonthlyReconcileOptions = {},
): MonthlyReconcileReport {
  const limit =
    Number.isInteger(options.limit) && (options.limit as number) > 0
      ? (options.limit as number)
      : 20_000;

  // ① 台账行（本期口径：业务月落在账期内的行）
  //    月份在 SQL 侧按东八区算（与 monthOf 同一口径），账期直接圈行 —— 不把整本台账拉进内存
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.from_month) {
    where.push(`${MONTH_SQL_EXPR} >= ?`);
    params.push(options.from_month);
  }
  if (options.to_month) {
    where.push(`${MONTH_SQL_EXPR} <= ?`);
    params.push(options.to_month);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const ledgerRows = db
    .prepare(
      `SELECT id, operation_no, room_no, dept_code, material_code, quantity, charge_quantity,
              conclusion, use_time, created_at,
              ${MONTH_SQL_EXPR} AS month
         FROM material_binding
        ${clause}
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as Array<LedgerRow & { month: string | null }>;

  const inRange: Array<LedgerRow & { month: string }> = [];
  let monthUnresolved = 0;
  for (const row of ledgerRows) {
    if (!row.month) {
      monthUnresolved += 1;
      continue;
    }
    inRange.push(row as LedgerRow & { month: string });
  }

  // 账期内的总条数（用来判断有没有触到上限而没扫全）
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM material_binding ${clause}`)
    .get(...params) as unknown as { n: number };

  // ② 计费回执：按（耗材码 + 台次）取**最新一次尝试**
  const receiptRows = db
    .prepare(
      `SELECT id, material_code, operation_no, attempt, accepted, kind, reason_code, error_code,
              channel_reachable, retryable, delivery_count, responded_at, created_at
         FROM charge_receipt
        ORDER BY material_code ASC, operation_no ASC, attempt ASC, id ASC`,
    )
    .all() as unknown as ReceiptRow[];

  // 台次 → 科室（「计费侧有、台账无」那条差异靠它归到科室）
  const operationDept = new Map<string, string>();
  for (const row of db
    .prepare('SELECT operation_no, dept_code FROM operation')
    .all() as unknown as Array<{ operation_no: string; dept_code: string }>) {
    operationDept.set(row.operation_no, row.dept_code);
  }

  const latestReceipt = new Map<string, ReceiptRow>();
  for (const receipt of receiptRows) {
    const key = itemKey(receipt.material_code, receipt.operation_no);
    const previous = latestReceipt.get(key);
    if (!previous || receipt.attempt >= previous.attempt) latestReceipt.set(key, receipt);
  }

  // ③ 核查条目（按台次 + 耗材码）
  const checkRows = db
    .prepare(
      `SELECT id, operation_no, material_code, status, reason_code, error_code
         FROM check_task
        ORDER BY id ASC`,
    )
    .all() as unknown as CheckTaskRow[];

  const checkByKey = new Map<string, CheckTaskRow>();
  for (const task of checkRows) {
    const key = itemKey(task.material_code, task.operation_no);
    const previous = checkByKey.get(key);
    // 一个台次同一耗材码只应有一条核查条目；有重复时取最新一条
    if (!previous || task.id > previous.id) checkByKey.set(key, task);
  }

  // ④ 差异（台账 ↔ 计费回执）——复用对账引擎，口径与差异台账一致
  const diffReport = reconcileLedgerVsReceipts(db, {
    persist: options.persist_diffs !== false,
  });
  const diffByKey = new Map<string, ReconcileDiffRow>();
  for (const diff of diffReport.diffs) {
    diffByKey.set(itemKey(diff.material_code, diff.operation_no), diff);
  }

  // ⑤ 逐条明细
  const details: MonthlyDetailRow[] = [];
  const unmatched: MonthlyUnmatchedRow[] = [];
  const seenDiffKeys = new Set<string>();
  const groupMap = new Map<string, MonthlyGroupRow>();
  const byOperation = new Map<string, number>();
  const byMaterial = new Map<string, number>();
  const operationDetailIndex = new Map<string, string[]>();
  const materialDetailIndex = new Map<string, string[]>();
  const monthSet = new Set<string>();
  const deptSet = new Set<string>();
  const operationSet = new Set<string>();
  const materialSet = new Set<string>();

  for (const row of inRange) {
    const month = row.month;
    const key = itemKey(row.material_code, row.operation_no);
    const receipt = latestReceipt.get(key) ?? null;
    const check = checkByKey.get(key) ?? null;
    const diff = diffByKey.get(key) ?? null;

    const chargeState = chargeStateOf(receipt, row.conclusion);
    const detail: MonthlyDetailRow = {
      operation_no: row.operation_no,
      room_no: row.room_no,
      dept_code: row.dept_code,
      month,
      material_code: row.material_code,
      quantity: row.quantity,
      charge_quantity: row.charge_quantity,
      conclusion: row.conclusion,
      // 原因码跟着核查条目走（台账行上只有结论，异常原因码在核查条目上）
      reason_code: check?.reason_code ?? null,
      use_time: row.use_time,
      created_at: row.created_at,
      charge_state: chargeState,
      receipt_attempt: receipt?.attempt ?? 0,
      delivery_count: receipt?.delivery_count ?? 0,
      receipt_reason_code: receipt?.reason_code ?? null,
      error_code: receipt?.error_code ?? check?.error_code ?? null,
      check_task_id: check?.id ?? null,
      check_status: check?.status ?? null,
      diff_type: diff?.diff_type ?? null,
      diff_attribution: diff?.attribution ?? null,
    };
    details.push(detail);

    // 分组汇总
    const groupKey = `${row.dept_code}|${month}`;
    let group = groupMap.get(groupKey);
    if (!group) {
      group = {
        dept_code: row.dept_code,
        month,
        usage_count: 0,
        quantity: 0,
        charge_success: 0,
        charge_rejected: 0,
        charge_pending_retry: 0,
        charge_not_submitted: 0,
        pending_check: 0,
        diff_count: 0,
        operations: 0,
        materials: 0,
      };
      groupMap.set(groupKey, group);
    }
    group.usage_count += 1;
    group.quantity += row.charge_quantity ?? row.quantity;
    if (chargeState === MONTHLY_CHARGE_STATE.accepted) group.charge_success += 1;
    else if (chargeState === MONTHLY_CHARGE_STATE.rejected) group.charge_rejected += 1;
    else if (chargeState === MONTHLY_CHARGE_STATE.pending_retry) group.charge_pending_retry += 1;
    else group.charge_not_submitted += 1;
    if (check && check.status === 'pending') group.pending_check += 1;
    if (diff) {
      group.diff_count += 1;
      seenDiffKeys.add(key);
    }

    // 下钻索引
    const detailId = `${row.operation_no}::${row.material_code}`;
    byOperation.set(row.operation_no, (byOperation.get(row.operation_no) ?? 0) + 1);
    byMaterial.set(row.material_code, (byMaterial.get(row.material_code) ?? 0) + 1);
    const opList = operationDetailIndex.get(row.operation_no) ?? [];
    opList.push(detailId);
    operationDetailIndex.set(row.operation_no, opList);
    const matList = materialDetailIndex.get(row.material_code) ?? [];
    matList.push(detailId);
    materialDetailIndex.set(row.material_code, matList);

    monthSet.add(month);
    deptSet.add(row.dept_code);
    operationSet.add(row.operation_no);
    materialSet.add(row.material_code);
  }

  // ⑥ 「计费侧有、台账无」的差异：没有台账行 → 进不了明细表，单列一张
  //    账期按回执时间归属、科室按排台主数据归属；归不出来的（如台次已不在排台表里）
  //    就单列在 unmatched 里并标出，不硬凑月份与科室
  const receiptById = new Map<number, ReceiptRow>();
  for (const receipt of receiptRows) receiptById.set(receipt.id, receipt);
  for (const diff of diffReport.diffs) {
    const key = itemKey(diff.material_code, diff.operation_no);
    if (seenDiffKeys.has(key)) continue;
    if (diff.diff_type !== 'UNKNOWN_RECEIPT') continue; // 其余差异都挂在台账行上，落在别的账期
    const receipt = diff.receipt_id !== null ? receiptById.get(diff.receipt_id) : undefined;
    const stamp = receipt?.responded_at ?? receipt?.created_at ?? null;
    const month = monthOf(stamp);
    const dept = diff.dept_code ?? operationDept.get(diff.operation_no) ?? '';
    if (month === null) continue;
    if (options.from_month && month < options.from_month) continue;
    if (options.to_month && month > options.to_month) continue;
    unmatched.push({
      operation_no: diff.operation_no,
      dept_code: dept,
      month,
      material_code: diff.material_code,
      quantity: diff.quantity,
      reason_code: diff.attribution,
      error_code: diff.error_code,
      attempt: diff.attempt,
      delivery_count: diff.delivery_count,
    });
    const groupKey = `${dept}|${month}`;
    let group = groupMap.get(groupKey);
    if (!group) {
      group = {
        dept_code: dept,
        month,
        usage_count: 0,
        quantity: 0,
        charge_success: 0,
        charge_rejected: 0,
        charge_pending_retry: 0,
        charge_not_submitted: 0,
        pending_check: 0,
        diff_count: 0,
        operations: 0,
        materials: 0,
      };
      groupMap.set(groupKey, group);
    }
    group.diff_count += 1;
  }

  const groups = [...groupMap.values()].sort(
    (a, b) => a.month.localeCompare(b.month) || a.dept_code.localeCompare(b.dept_code),
  );

  // 分组里的「涉及台次数 / 涉及耗材数」按明细回算
  const groupOps = new Map<string, Set<string>>();
  const groupMats = new Map<string, Set<string>>();
  for (const detail of details) {
    const groupKey = `${detail.dept_code}|${detail.month}`;
    const ops = groupOps.get(groupKey) ?? new Set<string>();
    ops.add(detail.operation_no);
    groupOps.set(groupKey, ops);
    const mats = groupMats.get(groupKey) ?? new Set<string>();
    mats.add(detail.material_code);
    groupMats.set(groupKey, mats);
  }
  for (const group of groups) {
    const groupKey = `${group.dept_code}|${group.month}`;
    group.operations = groupOps.get(groupKey)?.size ?? 0;
    group.materials = groupMats.get(groupKey)?.size ?? 0;
  }

  const totals: MonthlyTotals = {
    usage_count: details.length,
    quantity: groups.reduce((sum, group) => sum + group.quantity, 0),
    charge_success: groups.reduce((sum, group) => sum + group.charge_success, 0),
    charge_rejected: groups.reduce((sum, group) => sum + group.charge_rejected, 0),
    charge_pending_retry: groups.reduce((sum, group) => sum + group.charge_pending_retry, 0),
    charge_not_submitted: groups.reduce((sum, group) => sum + group.charge_not_submitted, 0),
    pending_check: groups.reduce((sum, group) => sum + group.pending_check, 0),
    diff_count: groups.reduce((sum, group) => sum + group.diff_count, 0),
    operations: operationSet.size,
    materials: materialSet.size,
    months: monthSet.size,
    depts: deptSet.size,
    diff_unmatched: unmatched.length,
  };

  return {
    generated_at: new Date().toISOString(),
    scope: {
      from_month: options.from_month ?? null,
      to_month: options.to_month ?? null,
      month_timezone: MONTH_TIMEZONE,
      month_unresolved: monthUnresolved,
      ledger_rows_scanned: ledgerRows.length,
      ledger_rows_total: totalRow.n,
      truncated: totalRow.n > ledgerRows.length,
    },
    totals,
    groups,
    details,
    unmatched,
    by_operation: Object.fromEntries(byOperation),
    by_material: Object.fromEntries(byMaterial),
    operation_detail_index: Object.fromEntries(operationDetailIndex),
    material_detail_index: Object.fromEntries(materialDetailIndex),
  };
}

/**
 * 计费状态判据（只认回执上已经落库的事实）。
 *
 * 判不出来就是「尚未提交」，不硬凑结论。
 */
interface ChargeStateFacts {
  accepted: number;
  kind: string | null;
  channel_reachable: number | null;
  retryable: number | null;
}

/**
 * 台账行的计费状态。
 *
 * 判据只用**回执上已经落库的事实**（accepted / kind / channel_reachable），
 * 判不出来就是「尚未提交」，不硬凑结论。
 */
function chargeStateOf(receipt: ChargeStateFacts | null, conclusion: string): MonthlyChargeState {
  if (!receipt) return MONTHLY_CHARGE_STATE.not_submitted;
  if (receipt.accepted === 1) return MONTHLY_CHARGE_STATE.accepted;
  if (receipt.kind === 'BUSINESS_REJECTED') return MONTHLY_CHARGE_STATE.rejected;
  if (receipt.channel_reachable === 0 || receipt.retryable === 1) {
    return MONTHLY_CHARGE_STATE.pending_retry;
  }
  // 绑都没绑上的条目（异常结论）压根没走到计费这一步
  if (conclusion !== 'BOUND') return MONTHLY_CHARGE_STATE.not_submitted;
  return MONTHLY_CHARGE_STATE.not_submitted;
}

/* ── 导出 ─────────────────────────────────────────────────────────────── */

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return [header.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n') + '\n';
}

/** 汇总表 CSV */
export function monthlyGroupToCsv(groups: readonly MonthlyGroupRow[]): string {
  return toCsv(
    MONTHLY_GROUP_FIELDS,
    groups.map((group) => MONTHLY_GROUP_FIELDS.map((field) => group[field])),
  );
}

/** 明细表 CSV */
export function monthlyDetailToCsv(details: readonly MonthlyDetailRow[]): string {
  return toCsv(
    MONTHLY_DETAIL_FIELDS,
    details.map((detail) => MONTHLY_DETAIL_FIELDS.map((field) => detail[field])),
  );
}

/** 对账包 JSON（汇总 + 明细 + 下钻索引 + 口径元信息） */
export function monthlyPackToJson(report: MonthlyReconcileReport): string {
  const pack = {
    schema: 'material-scan-billing/monthly-reconcile-pack',
    schema_version: 1,
    generated_at: report.generated_at,
    scope: report.scope,
    totals: report.totals,
    groups: report.groups.map((group) =>
      Object.fromEntries(MONTHLY_GROUP_FIELDS.map((field) => [field, group[field]])),
    ),
    details: report.details.map((detail) =>
      Object.fromEntries(MONTHLY_DETAIL_FIELDS.map((field) => [field, detail[field]])),
    ),
    unmatched: report.unmatched,
    index: {
      by_operation: report.by_operation,
      by_material: report.by_material,
      operation_detail_index: report.operation_detail_index,
      material_detail_index: report.material_detail_index,
    },
  };
  return `${JSON.stringify(pack, null, 2)}\n`;
}

/* ── 抽样回查 ─────────────────────────────────────────────────────────── */

/** 一条抽样回查的结果 */
export interface MonthlySampleRow {
  /** 明细标识（台次::耗材码） */
  detail_id: string;
  operation_no: string;
  material_code: string;
  /** 包里的结论 */
  pack_conclusion: string;
  /** 台账里的结论 */
  ledger_conclusion: string;
  /** 包里的数量 */
  pack_quantity: number;
  /** 台账里的数量 */
  ledger_quantity: number;
  /** 包里的计费状态 */
  pack_charge_state: MonthlyChargeState;
  /** 回执推出的计费状态 */
  receipt_charge_state: MonthlyChargeState;
  /** 台账里的台次号（回查一致性用） */
  ledger_operation_no: string;
  /** 是否一致 */
  matched: boolean;
  /** 不一致的原因（一致时为空） */
  mismatch_reason: string | null;
}

/** 抽样回查的汇总 */
export interface MonthlySampleResult {
  /** 抽了多少条 */
  sampled: number;
  /** 逐条回查结果 */
  rows: MonthlySampleRow[];
  /** 一致的条数 */
  matched: number;
  /** 不一致的条数 */
  mismatched: number;
  /** 是否全部一致 */
  all_matched: boolean;
}

/**
 * 抽样回查：从对账包里随机抽 N 条明细，逐条回台账与回执核对。
 *
 * 抽样的目的是证明「包里的每个数字都能回溯到台账与回执」——
 * 抽到一条对不上，就是包错了（不是台账错了）。
 */
export function verifyMonthlySample(
  db: DatabaseSync,
  report: MonthlyReconcileReport,
  count = 20,
  seed = 20260101,
): MonthlySampleResult {
  const rng = mulberry32(seed);
  const pool = [...report.details];
  const sampled: MonthlyDetailRow[] = [];
  const wanted = Math.min(count, pool.length);
  for (let i = 0; i < wanted; i += 1) {
    const index = Math.floor(rng() * pool.length) % Math.max(pool.length, 1);
    const picked = pool.splice(index, 1)[0];
    if (picked) sampled.push(picked);
  }

  const rows: MonthlySampleRow[] = [];
  for (const detail of sampled) {
    const ledger = db
      .prepare(
        `SELECT operation_no, material_code, quantity, conclusion FROM material_binding
          WHERE operation_no = ? AND material_code = ? LIMIT 1`,
      )
      .get(detail.operation_no, detail.material_code) as
      | { operation_no: string; material_code: string; quantity: number; conclusion: string }
      | undefined;

    const receipt = db
      .prepare(
        `SELECT accepted, kind, channel_reachable, retryable FROM charge_receipt
          WHERE operation_no = ? AND material_code = ?
          ORDER BY attempt DESC, id DESC LIMIT 1`,
      )
      .get(detail.operation_no, detail.material_code) as
      | { accepted: number; kind: string | null; channel_reachable: number | null; retryable: number | null }
      | undefined;

    const receiptState = receipt
      ? chargeStateOf(
          {
            accepted: receipt.accepted,
            kind: receipt.kind,
            channel_reachable: receipt.channel_reachable,
            retryable: receipt.retryable,
          },
          detail.conclusion,
        )
      : MONTHLY_CHARGE_STATE.not_submitted;

    const reasons: string[] = [];
    if (!ledger) {
      reasons.push('台账里查不到这条明细');
    } else {
      if (ledger.conclusion !== detail.conclusion) {
        reasons.push(`结论不一致（包 ${detail.conclusion} / 台账 ${ledger.conclusion}）`);
      }
      if (ledger.quantity !== detail.quantity) {
        reasons.push(`数量不一致（包 ${detail.quantity} / 台账 ${ledger.quantity}）`);
      }
      if (ledger.operation_no !== detail.operation_no) {
        reasons.push('台次号不一致');
      }
    }
    if (receiptState !== detail.charge_state) {
      reasons.push(`计费状态不一致（包 ${detail.charge_state} / 回执 ${receiptState}）`);
    }

    rows.push({
      detail_id: `${detail.operation_no}::${detail.material_code}`,
      operation_no: detail.operation_no,
      material_code: detail.material_code,
      pack_conclusion: detail.conclusion,
      ledger_conclusion: ledger?.conclusion ?? '(查不到)',
      pack_quantity: detail.quantity,
      ledger_quantity: ledger?.quantity ?? -1,
      pack_charge_state: detail.charge_state,
      receipt_charge_state: receiptState,
      ledger_operation_no: ledger?.operation_no ?? '(查不到)',
      matched: reasons.length === 0,
      mismatch_reason: reasons.length > 0 ? reasons.join('；') : null,
    });
  }

  const matched = rows.filter((row) => row.matched).length;
  return {
    sampled: rows.length,
    rows,
    matched,
    mismatched: rows.length - matched,
    all_matched: rows.length > 0 && matched === rows.length,
  };
}

/** mulberry32：32 位种子伪随机数发生器（同一 seed 必得同一序列） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 差异类型 → 中文说明（供对账包与文档对照） */
export const MONTHLY_DIFF_TYPE_LABELS: Readonly<Record<ReconcileDiffType, string>> = {
  MISSING_RECEIPT: '台账有、计费侧无成功回执',
  UNKNOWN_RECEIPT: '计费侧有成功回执、台账查不到',
  FIELD_MISMATCH: '两边都有但字段口径不一致',
};
