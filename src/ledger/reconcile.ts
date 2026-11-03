/**
 * 对账引擎：耗材使用台账 ↔ 计费回执**逐条对齐**，把「哪些耗材没有生成计费」讲清楚。
 *
 * 关台后护士长与高值耗材管理岗最想知道的不是「扫了多少」，而是
 * 「**哪些耗材没有生成计费**」。本模块把这件事做成可核对的差异台账：
 *
 *   台账（material_binding） ── 按 (material_code, operation_no) ──┐
 *                                                                 ├─→ 三类差异 → 差异台账 → 核查任务
 *   计费回执（charge_receipt） ─────────────────────────────────┘
 *
 * 三类差异（互斥且穷尽）：
 *   ① **MISSING_RECEIPT** —— 台账有这条耗材，计费侧**没有成功回执**
 *      （可能从未提交 / 提交了但超时 / 被对端业务拒绝）。
 *      归因按该条目**最近一次回执**的 attempt 与 error_code 判定：
 *        - 一条回执都没有        → NOT_SUBMITTED（未提交）
 *        - 最近一次通道不可达    → CHARGE_TIMEOUT_PENDING_RETRY（计费超时待重投）
 *        - 最近一次业务拒绝      → CHARGE_BUSINESS_REJECTED（计费业务拒绝）
 *        - 回执结构不符 / 本侧错误 → MANUAL_REVIEW（需人工复核）
 *   ② **UNKNOWN_RECEIPT** —— 计费侧有成功回执，台账里**查不到这条耗材**
 *      （对端出现了台账没有的条目：台次记错、有人手工补录、主数据被换掉）。
 *   ③ **FIELD_MISMATCH** —— 两边都有，但**字段口径不一致**
 *      （数量 / 计价口径 / 费用类别 / 医保分类四项逐项比对）。
 *
 * 语义来源（源产品主路径）：源产品的投递回执是**逐目标**的一份
 * （`MessageReceipt { user_id, delivery_count, active }`），投递结果与被投递对象
 * 是**成对**返回的 —— 收件人清单与回执清单能一一对上，多的少的都能看出来。
 * 本模块照此语义改写成耗材计费场景：**台账清单 ↔ 回执清单**双向对齐，
 * 一边多出来的那条就是差异（多出来的一侧指向谁，一目了然）。
 *
 * 四条硬约束：
 *   ① **只绑台次，不落患者标识** —— 差异台账与导出都只有台次上下文；
 *   ② **归因可判定 + 需人工复核项分开** —— 能自动判的自动判，判不了的明说「需人工复核」，
 *      不硬凑一个结论；
 *   ③ **差异不静默改数据** —— 对账只**读**台账与回执；落差异台账是新增行，
 *      处置状态由人工改，绝不因为「对上了」就悄悄改台账或计费；
 *   ④ **同一条差异反复对账只留一行** —— 差异键与时间戳、重跑次数无关。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { createCheckTask } from '../check/task.js';
import { withTransaction } from './db.js';

/* ── 差异类型 ─────────────────────────────────────────────────────────── */

/** 三类差异（互斥且穷尽） */
export const RECONCILE_DIFF_TYPES = {
  /** 台账有这条耗材，计费侧没有成功回执 */
  missing_receipt: 'MISSING_RECEIPT',
  /** 计费侧有成功回执，台账里查不到这条耗材 */
  unknown_receipt: 'UNKNOWN_RECEIPT',
  /** 两边都有，但字段口径不一致 */
  field_mismatch: 'FIELD_MISMATCH',
} as const;

export type ReconcileDiffType = (typeof RECONCILE_DIFF_TYPES)[keyof typeof RECONCILE_DIFF_TYPES];

/** 差异类型的中文说明（给科室看） */
export const RECONCILE_DIFF_TYPE_LABELS: Readonly<Record<ReconcileDiffType, string>> = {
  MISSING_RECEIPT: '台账有、计费侧无成功回执',
  UNKNOWN_RECEIPT: '计费侧有、台账无对应条目',
  FIELD_MISMATCH: '两边都有但字段口径不一致',
};

/* ── 归因 ─────────────────────────────────────────────────────────────── */

/**
 * 差异归因码。
 *
 * 归因分两档：**可自动判定的**（NOT_SUBMITTED / CHARGE_TIMEOUT_PENDING_RETRY /
 * CHARGE_BUSINESS_REJECTED / UNEXPECTED_CHARGE / FIELD_MISMATCH）与
 * **需人工复核的**（MANUAL_REVIEW）—— 判不了的不硬凑结论。
 */
export const RECONCILE_ATTRIBUTIONS = {
  /** 压根没提交过计费 */
  not_submitted: 'NOT_SUBMITTED',
  /** 计费超时 / 通道不可达，等重投 */
  charge_timeout_pending_retry: 'CHARGE_TIMEOUT_PENDING_RETRY',
  /** 对端业务拒绝（价码 / 医保分类 / 数量不合口径） */
  charge_business_rejected: 'CHARGE_BUSINESS_REJECTED',
  /** 回执结构不符，需人工核对 */
  charge_protocol_error: 'CHARGE_PROTOCOL_ERROR',
  /** 对端出现台账没有的条目 */
  unexpected_charge: 'UNEXPECTED_CHARGE',
  /** 字段口径不一致 */
  field_mismatch: 'FIELD_MISMATCH',
  /** 判不了，需人工复核 */
  manual_review: 'MANUAL_REVIEW',
} as const;

export type ReconcileAttribution =
  (typeof RECONCILE_ATTRIBUTIONS)[keyof typeof RECONCILE_ATTRIBUTIONS];

/** 归因 → 中文说明 + 建议处置（科室按这张表就能知道下一步找谁） */
export const RECONCILE_ATTRIBUTION_GUIDE: Readonly<
  Record<ReconcileAttribution, { meaning_zh: string; suggested_action: string; error_code: string }>
> = {
  NOT_SUBMITTED: {
    meaning_zh: '台账有这笔耗材，但从未提交过计费',
    suggested_action: '核对台次是否已绑定成功；确认后由护士长重投计费或人工补录',
    error_code: 'ERR_RECONCILE_NOT_SUBMITTED',
  },
  CHARGE_TIMEOUT_PENDING_RETRY: {
    meaning_zh: '计费投递超时 / 通道不可达，正在退避重投',
    suggested_action: '看重投次数是否还在涨；持续超时找信息科核对 HIS 计费侧负载与网络',
    error_code: 'ERR_RECONCILE_MISSING_RECEIPT',
  },
  CHARGE_BUSINESS_REJECTED: {
    meaning_zh: 'HIS 计费侧业务拒绝（价码 / 医保分类 / 数量不合口径）',
    suggested_action: '核对耗材主数据的价码、费用类别、医保分类与数量；修正后人工重投',
    error_code: 'ERR_RECONCILE_MISSING_RECEIPT',
  },
  CHARGE_PROTOCOL_ERROR: {
    meaning_zh: '计费回执结构不符，对端结论不完整',
    suggested_action: '核对 HIS 计费接口版本与返回结构；条目重投一次即可',
    error_code: 'ERR_RECONCILE_MISSING_RECEIPT',
  },
  UNEXPECTED_CHARGE: {
    meaning_zh: '计费侧出现台账里没有的条目',
    suggested_action: '核对该台次号与耗材码是否记错；确属误记的由收费员在 HIS 侧冲正（系统不自动冲正）',
    error_code: 'ERR_RECONCILE_UNEXPECTED_CHARGE',
  },
  FIELD_MISMATCH: {
    meaning_zh: '台账口径与计费侧实际收到的载荷不一致',
    suggested_action: '按差异字段逐项核对：主数据是否在扫码之后被改过；口径不一致的由人工决定是否重投',
    error_code: 'ERR_RECONCILE_FIELD_MISMATCH',
  },
  MANUAL_REVIEW: {
    meaning_zh: '差异原因判不出来，需人工复核',
    suggested_action: '调出该条的回执与审计链逐次尝试看；必要时由信息科核对通道日志',
    error_code: 'ERR_RECONCILE_MANUAL_REVIEW',
  },
};

/* ── 字段级比对 ───────────────────────────────────────────────────────── */

/** 参与字段级比对的四个口径字段 */
export const RECONCILE_COMPARED_FIELDS = [
  'quantity',
  'price_code',
  'fee_category',
  'medical_insurance_class',
] as const;

export type ReconcileComparedField = (typeof RECONCILE_COMPARED_FIELDS)[number];

/** 字段名 → 中文说明 */
export const RECONCILE_FIELD_LABELS: Readonly<Record<ReconcileComparedField, string>> = {
  quantity: '数量',
  price_code: '计价口径（价码）',
  fee_category: '费用类别',
  medical_insurance_class: '医保分类',
};

/** 一处字段不一致（两侧取值都留档，便于人工核对） */
export interface FieldMismatch {
  /** 字段名（机器可比的稳定标识） */
  field: ReconcileComparedField;
  /** 字段中文说明 */
  label_zh: string;
  /** 台账侧取值 */
  ledger_value: string | number | null;
  /** 计费侧（实际发出的载荷）取值 */
  receipt_value: string | number | null;
}

/* ── 差异台账行 ───────────────────────────────────────────────────────── */

/** 差异台账的一行（落库后的形状） */
export interface ReconcileDiffRow {
  id: number;
  /** 差异键：sha256(差异类型|耗材码|台次) —— 与时间戳、重跑次数无关 */
  diff_key: string;
  diff_type: ReconcileDiffType;
  attribution: ReconcileAttribution;
  attribution_detail: string | null;
  operation_no: string;
  room_no: string | null;
  dept_code: string | null;
  material_code: string;
  quantity: number | null;
  ledger_quantity: number | null;
  receipt_quantity: number | null;
  ledger_price_code: string | null;
  receipt_price_code: string | null;
  ledger_fee_category: string | null;
  receipt_fee_category: string | null;
  ledger_insurance_class: string | null;
  receipt_insurance_class: string | null;
  /** 不一致字段的 JSON 数组（字段名 + 两侧取值） */
  mismatched_fields: string | null;
  suggested_action: string;
  error_code: string | null;
  /** pending（待处理）/ resolved（已处理） */
  status: 'pending' | 'resolved';
  binding_id: number | null;
  receipt_id: number | null;
  check_task_id: number | null;
  attempt: number | null;
  delivery_count: number | null;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

/* ── 导出字段白名单 ───────────────────────────────────────────────────── */

/**
 * 差异台账导出字段白名单。
 *
 * 只有台次上下文、差异类型与归因、两侧取值、建议处置与处置状态 ——
 * **没有任何患者标识字段**（耗材码只绑手术台次，不落患者可识别明细）。
 */
export const RECONCILE_EXPORT_FIELDS = [
  'diff_id',
  'diff_key',
  'diff_type',
  'diff_type_zh',
  'attribution',
  'attribution_zh',
  'operation_no',
  'room_no',
  'dept_code',
  'material_code',
  'quantity',
  'ledger_quantity',
  'receipt_quantity',
  'ledger_price_code',
  'receipt_price_code',
  'ledger_fee_category',
  'receipt_fee_category',
  'ledger_medical_insurance_class',
  'receipt_medical_insurance_class',
  'mismatched_fields',
  'suggested_action',
  'error_code',
  'status',
  'check_task_id',
  'attempt',
  'delivery_count',
  'detected_at',
  'resolved_at',
  'resolved_by',
] as const;

export type ReconcileExportField = (typeof RECONCILE_EXPORT_FIELDS)[number];
export type ReconcileExportRow = Record<ReconcileExportField, string | number | null>;

/* ── 内部行形状 ───────────────────────────────────────────────────────── */

interface LedgerItemRow {
  id: number;
  operation_no: string;
  room_no: string;
  dept_code: string;
  material_code: string;
  /** 原始数量（包装数） */
  quantity: number;
  /** 计价数量（换算后）；老行为空 */
  charge_quantity: number | null;
  price_code: string | null;
  fee_category: string | null;
  medical_insurance_class: string | null;
  status: string;
  conclusion: string;
}

interface ReceiptItemRow {
  id: number;
  material_code: string;
  operation_no: string;
  attempt: number;
  delivery_count: number;
  accepted: number;
  kind: string | null;
  reason_code: string | null;
  error_code: string | null;
  channel_reachable: number;
  retryable: number;
  responded_at: string | null;
  submitted_quantity: number | null;
  submitted_price_code: string | null;
  submitted_fee_category: string | null;
  submitted_medical_insurance_class: string | null;
}

/* ── 差异键 ───────────────────────────────────────────────────────────── */

/**
 * 差异键：sha256(差异类型|耗材码|台次)。
 *
 * 与时间戳、重跑次数、扫码枪编号都无关 —— 同一条差异反复对账只落一行。
 */
export function deriveDiffKey(
  diff_type: ReconcileDiffType,
  material_code: string,
  operation_no: string,
): string {
  return createHash('sha256')
    .update(`${diff_type}|${material_code}|${operation_no}`)
    .digest('hex');
}

/* ── 对账 ─────────────────────────────────────────────────────────────── */

/** 对账输入 */
export interface ReconcileOptions {
  /** 只对某个台次对账 */
  operation_no?: string | null;
  /** 只对某个耗材码对账 */
  material_code?: string | null;
  /** 台账扫描上限（默认 20000；关台核对按台次对账时足够） */
  limit?: number;
  /** 是否把差异落进差异台账（默认 true；只读盘点时传 false） */
  persist?: boolean;
}

/** 对账报告 */
export interface ReconcileReport {
  generated_at: string;
  /** 对账范围 */
  scope: { operation_no: string | null; material_code: string | null };
  /** 扫到的台账条目数 */
  ledger_items: number;
  /** 扫到的计费条目数（按耗材码 + 台次去重） */
  receipt_items: number;
  /** 三类差异各自条数 */
  by_type: Record<ReconcileDiffType, number>;
  /** 归因分布 */
  by_attribution: Record<string, number>;
  /** 逐条差异 */
  diffs: ReconcileDiffRow[];
  /** 本次新增的差异条数 */
  new_diffs: number;
  /** 本次自动闭环的差异条数（差异已消失） */
  auto_resolved: number;
  /** 差异台账里仍待处理的条数 */
  pending_total: number;
}

/** 通道不可达类的错误码（归因为「计费超时待重投」的判据） */
const UNREACHABLE_ERROR_CODES = new Set([
  'ERR_CHARGE_TIMEOUT',
  'ERR_CHARGE_NETWORK',
  'ERR_CHARGE_HTTP_5XX',
]);

/** 对齐用的键（耗材码 + 台次） */
function itemKey(material_code: string, operation_no: string): string {
  return `${material_code} ${operation_no}`;
}

/** 取台账行 */
function loadLedgerItems(db: DatabaseSync, options: ReconcileOptions): LedgerItemRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.operation_no) {
    where.push('operation_no = ?');
    params.push(options.operation_no);
  }
  if (options.material_code) {
    where.push('material_code = ?');
    params.push(options.material_code);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0
    ? (options.limit as number)
    : 20_000;
  return db
    .prepare(
      `SELECT id, operation_no, room_no, dept_code, material_code, quantity, charge_quantity, price_code,
              fee_category, medical_insurance_class, status, conclusion
         FROM material_binding ${clause}
        ORDER BY id ASC LIMIT ?`,
    )
    .all(...params, limit) as unknown as LedgerItemRow[];
}

/** 取计费回执行（逐次尝试，按 attempt 升序） */
function loadReceiptItems(db: DatabaseSync, options: ReconcileOptions): ReceiptItemRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.operation_no) {
    where.push('operation_no = ?');
    params.push(options.operation_no);
  }
  if (options.material_code) {
    where.push('material_code = ?');
    params.push(options.material_code);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT id, material_code, operation_no, attempt, delivery_count, accepted, kind,
              reason_code, error_code, channel_reachable, retryable, responded_at,
              submitted_quantity, submitted_price_code, submitted_fee_category,
              submitted_medical_insurance_class
         FROM charge_receipt ${clause}
        ORDER BY material_code ASC, operation_no ASC, attempt ASC, id ASC`,
    )
    .all(...params) as unknown as ReceiptItemRow[];
}

/**
 * 归因：台账有、计费侧没有成功回执时，按最近一次回执定性。
 *
 * 判据只用回执上**已经落库**的事实（attempt / error_code / kind / channel_reachable），
 * 判不出来就是 MANUAL_REVIEW —— 不硬凑结论。
 */
export function attributeMissingReceipt(receipts: readonly ReceiptItemRow[]): {
  attribution: ReconcileAttribution;
  detail: string;
  attempt: number;
  delivery_count: number;
  receipt_id: number | null;
} {
  if (receipts.length === 0) {
    return {
      attribution: RECONCILE_ATTRIBUTIONS.not_submitted,
      detail: '该条目没有任何计费回执：从未提交过计费',
      attempt: 0,
      delivery_count: 0,
      receipt_id: null,
    };
  }
  const last = receipts[receipts.length - 1]!;
  const detail = `最近一次尝试 #${last.attempt}：kind=${last.kind ?? '—'}，error_code=${last.error_code ?? '—'}，通道可达=${last.channel_reachable === 1 ? '是' : '否'}`;

  if (last.accepted === 1) {
    // 有成功回执却走到这里，说明调用方拿到的不是最新一次尝试 —— 按人工复核处理
    return {
      attribution: RECONCILE_ATTRIBUTIONS.manual_review,
      detail: `${detail}（已有成功回执，需人工复核）`,
      attempt: last.attempt,
      delivery_count: last.delivery_count,
      receipt_id: last.id,
    };
  }

  if (
    (last.error_code != null && UNREACHABLE_ERROR_CODES.has(last.error_code)) ||
    last.kind === 'CHANNEL_UNREACHABLE' ||
    last.kind === 'CHANNEL_ERROR'
  ) {
    return {
      attribution: RECONCILE_ATTRIBUTIONS.charge_timeout_pending_retry,
      detail,
      attempt: last.attempt,
      delivery_count: last.delivery_count,
      receipt_id: last.id,
    };
  }

  if (last.kind === 'BUSINESS_REJECTED' || last.error_code === 'ERR_CHARGE_BUSINESS_REJECTED') {
    return {
      attribution: RECONCILE_ATTRIBUTIONS.charge_business_rejected,
      detail,
      attempt: last.attempt,
      delivery_count: last.delivery_count,
      receipt_id: last.id,
    };
  }

  if (last.kind === 'PROTOCOL_ERROR' || last.error_code === 'ERR_MISSING_RECEIPT') {
    return {
      attribution: RECONCILE_ATTRIBUTIONS.charge_protocol_error,
      detail,
      attempt: last.attempt,
      delivery_count: last.delivery_count,
      receipt_id: last.id,
    };
  }

  return {
    attribution: RECONCILE_ATTRIBUTIONS.manual_review,
    detail,
    attempt: last.attempt,
    delivery_count: last.delivery_count,
    receipt_id: last.id,
  };
}

/**
 * 字段级比对：数量 / 计价口径 / 费用类别 / 医保分类。
 *
 * 对照物是**计费侧实际收到的载荷快照**（回执行上的 submitted_* 列）。
 * 没有快照（v12 之前写下的回执行）时不做判定 —— 判不了就说判不了，
 * 不拿「台账自己跟自己比」凑一个「一致」。
 */
export /** 台账行的计价数量（换算后的数）；老行（没有计价数量列）按 1:1 沿用原数量 */
function ledgerChargeQuantity(ledger: LedgerItemRow): number | null {
  if (ledger.charge_quantity != null) return ledger.charge_quantity;
  return ledger.quantity;
}

function compareFields(
  ledger: LedgerItemRow,
  receipt: ReceiptItemRow,
): FieldMismatch[] {
  const mismatches: FieldMismatch[] = [];

  const pairs: Array<{
    field: ReconcileComparedField;
    ledgerValue: string | number | null;
    receiptValue: string | number | null;
  }> = [
    {
      // 比的是**计价数量**（发出去的那个数），不是原始包装数 ——
      // 包装数与计价数本来就差一个换算系数，拿它们比会把每一笔都报成口径不一致。
      field: 'quantity',
      ledgerValue: ledgerChargeQuantity(ledger),
      receiptValue: receipt.submitted_quantity,
    },
    {
      field: 'price_code',
      ledgerValue: ledger.price_code,
      receiptValue: receipt.submitted_price_code,
    },
    {
      field: 'fee_category',
      ledgerValue: ledger.fee_category,
      receiptValue: receipt.submitted_fee_category,
    },
    {
      field: 'medical_insurance_class',
      ledgerValue: ledger.medical_insurance_class,
      receiptValue: receipt.submitted_medical_insurance_class,
    },
  ];

  for (const pair of pairs) {
    // 一侧没值：只在一侧有值时才算不一致（两侧都缺 = 同样缺，不算差异）
    if (pair.ledgerValue === pair.receiptValue) continue;
    if (pair.ledgerValue == null && pair.receiptValue == null) continue;
    if (
      pair.ledgerValue == null &&
      pair.receiptValue != null &&
      pair.field === 'quantity'
    ) {
      // 数量缺失本身就是口径问题（台账数量与发出去的数量对不上）
    }
    mismatches.push({
      field: pair.field,
      label_zh: RECONCILE_FIELD_LABELS[pair.field],
      ledger_value: pair.ledgerValue,
      receipt_value: pair.receiptValue,
    });
  }

  return mismatches;
}

/** 该回执行有没有载荷快照（没有快照就不做字段级判定） */
function hasPayloadSnapshot(receipt: ReceiptItemRow): boolean {
  return (
    receipt.submitted_quantity != null ||
    receipt.submitted_price_code != null ||
    receipt.submitted_fee_category != null ||
    receipt.submitted_medical_insurance_class != null
  );
}

/** 一条差异（落库前） */
interface PendingDiff {
  diff_key: string;
  diff_type: ReconcileDiffType;
  attribution: ReconcileAttribution;
  attribution_detail: string;
  operation_no: string;
  room_no: string | null;
  dept_code: string | null;
  material_code: string;
  quantity: number | null;
  ledger_quantity: number | null;
  receipt_quantity: number | null;
  ledger_price_code: string | null;
  receipt_price_code: string | null;
  ledger_fee_category: string | null;
  receipt_fee_category: string | null;
  ledger_insurance_class: string | null;
  receipt_insurance_class: string | null;
  mismatched_fields: string | null;
  suggested_action: string;
  error_code: string | null;
  binding_id: number | null;
  receipt_id: number | null;
  attempt: number | null;
  delivery_count: number | null;
}

/** 把一条差异落进差异台账（已存在则更新归因，不重复落行） */
function upsertDiff(db: DatabaseSync, diff: PendingDiff, now: string): number {
  const existing = db
    .prepare('SELECT id, status FROM reconcile_diff WHERE diff_key = ?')
    .get(diff.diff_key) as { id: number; status: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE reconcile_diff
          SET diff_type = ?, attribution = ?, attribution_detail = ?, operation_no = ?,
              room_no = ?, dept_code = ?, material_code = ?, quantity = ?,
              ledger_quantity = ?, receipt_quantity = ?,
              ledger_price_code = ?, receipt_price_code = ?,
              ledger_fee_category = ?, receipt_fee_category = ?,
              ledger_insurance_class = ?, receipt_insurance_class = ?,
              mismatched_fields = ?, suggested_action = ?, error_code = ?,
              binding_id = ?, receipt_id = ?, attempt = ?, delivery_count = ?,
              detected_at = ?
        WHERE id = ?`,
    ).run(
      diff.diff_type,
      diff.attribution,
      diff.attribution_detail,
      diff.operation_no,
      diff.room_no,
      diff.dept_code,
      diff.material_code,
      diff.quantity,
      diff.ledger_quantity,
      diff.receipt_quantity,
      diff.ledger_price_code,
      diff.receipt_price_code,
      diff.ledger_fee_category,
      diff.receipt_fee_category,
      diff.ledger_insurance_class,
      diff.receipt_insurance_class,
      diff.mismatched_fields,
      diff.suggested_action,
      diff.error_code,
      diff.binding_id,
      diff.receipt_id,
      diff.attempt,
      diff.delivery_count,
      now,
      existing.id,
    );
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO reconcile_diff
         (diff_key, diff_type, attribution, attribution_detail, operation_no, room_no, dept_code,
          material_code, quantity, ledger_quantity, receipt_quantity,
          ledger_price_code, receipt_price_code, ledger_fee_category, receipt_fee_category,
          ledger_insurance_class, receipt_insurance_class, mismatched_fields,
          suggested_action, error_code, status, binding_id, receipt_id, attempt, delivery_count,
          detected_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      diff.diff_key,
      diff.diff_type,
      diff.attribution,
      diff.attribution_detail,
      diff.operation_no,
      diff.room_no,
      diff.dept_code,
      diff.material_code,
      diff.quantity,
      diff.ledger_quantity,
      diff.receipt_quantity,
      diff.ledger_price_code,
      diff.receipt_price_code,
      diff.ledger_fee_category,
      diff.receipt_fee_category,
      diff.ledger_insurance_class,
      diff.receipt_insurance_class,
      diff.mismatched_fields,
      diff.suggested_action,
      diff.error_code,
      diff.binding_id,
      diff.receipt_id,
      diff.attempt,
      diff.delivery_count,
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

/**
 * 台账 ↔ 计费回执逐条对账。
 *
 * 全外连接的两侧：
 *   台账侧按 (material_code, operation_no)；
 *   回执侧按同一把键（同一耗材同一台次）。
 *
 * 对完只做两件事：**读**差异、**新增**差异台账行。台账与计费侧的数据一个字都不改
 * —— 对账是盘点，不是纠正。
 */
export function reconcileLedgerVsReceipts(
  db: DatabaseSync,
  options: ReconcileOptions = {},
): ReconcileReport {
  const now = new Date().toISOString();
  const persist = options.persist !== false;

  const ledgerItems = loadLedgerItems(db, options);
  const receiptItems = loadReceiptItems(db, options);

  // 回执按 (耗材码, 台次) 分组；同一把键下多次尝试按 attempt 升序
  const receiptsByKey = new Map<string, ReceiptItemRow[]>();
  for (const receipt of receiptItems) {
    const key = itemKey(receipt.material_code, receipt.operation_no);
    const bucket = receiptsByKey.get(key);
    if (bucket) bucket.push(receipt);
    else receiptsByKey.set(key, [receipt]);
  }

  const diffs: PendingDiff[] = [];
  /** 本轮产出的差异键（用来判断差异台账里哪些待处理行已经「对上了」） */
  const seenDiffKeys = new Set<string>();
  const ledgerKeys = new Set<string>();

  for (const item of ledgerItems) {
    const key = itemKey(item.material_code, item.operation_no);
    ledgerKeys.add(key);
    const receipts = receiptsByKey.get(key) ?? [];
    const accepted = receipts.filter((receipt) => receipt.accepted === 1);
    const latestAccepted = accepted.length > 0 ? accepted[accepted.length - 1]! : null;

    if (!latestAccepted) {
      // ① 台账有、回执无（无成功回执）
      const attributed = attributeMissingReceipt(receipts);
      const guide = RECONCILE_ATTRIBUTION_GUIDE[attributed.attribution];
      diffs.push({
        diff_key: deriveDiffKey(RECONCILE_DIFF_TYPES.missing_receipt, item.material_code, item.operation_no),
        diff_type: RECONCILE_DIFF_TYPES.missing_receipt,
        attribution: attributed.attribution,
        attribution_detail: attributed.detail,
        operation_no: item.operation_no,
        room_no: item.room_no,
        dept_code: item.dept_code,
        material_code: item.material_code,
        quantity: item.quantity,
        ledger_quantity: ledgerChargeQuantity(item),
        receipt_quantity: null,
        ledger_price_code: item.price_code,
        receipt_price_code: null,
        ledger_fee_category: item.fee_category,
        receipt_fee_category: null,
        ledger_insurance_class: item.medical_insurance_class,
        receipt_insurance_class: null,
        mismatched_fields: null,
        suggested_action: guide.suggested_action,
        error_code: guide.error_code,
        binding_id: item.id,
        receipt_id: attributed.receipt_id,
        attempt: attributed.attempt,
        delivery_count: attributed.delivery_count,
      });
      seenDiffKeys.add(
        deriveDiffKey(RECONCILE_DIFF_TYPES.missing_receipt, item.material_code, item.operation_no),
      );
      continue;
    }

    // ③ 两边都有：字段级比对（没有载荷快照就不判 —— 判不了不硬凑）
    if (hasPayloadSnapshot(latestAccepted)) {
      const mismatches = compareFields(item, latestAccepted);
      if (mismatches.length > 0) {
        const guide = RECONCILE_ATTRIBUTION_GUIDE[RECONCILE_ATTRIBUTIONS.field_mismatch];
        diffs.push({
          diff_key: deriveDiffKey(RECONCILE_DIFF_TYPES.field_mismatch, item.material_code, item.operation_no),
          diff_type: RECONCILE_DIFF_TYPES.field_mismatch,
          attribution: RECONCILE_ATTRIBUTIONS.field_mismatch,
          attribution_detail: `不一致字段：${mismatches.map((item2) => item2.label_zh).join('、')}`,
          operation_no: item.operation_no,
          room_no: item.room_no,
          dept_code: item.dept_code,
          material_code: item.material_code,
          quantity: item.quantity,
          ledger_quantity: ledgerChargeQuantity(item),
          receipt_quantity: latestAccepted.submitted_quantity,
          ledger_price_code: item.price_code,
          receipt_price_code: latestAccepted.submitted_price_code,
          ledger_fee_category: item.fee_category,
          receipt_fee_category: latestAccepted.submitted_fee_category,
          ledger_insurance_class: item.medical_insurance_class,
          receipt_insurance_class: latestAccepted.submitted_medical_insurance_class,
          mismatched_fields: JSON.stringify(mismatches),
          suggested_action: guide.suggested_action,
          error_code: guide.error_code,
          binding_id: item.id,
          receipt_id: latestAccepted.id,
          attempt: latestAccepted.attempt,
          delivery_count: latestAccepted.delivery_count,
        });
        seenDiffKeys.add(
          deriveDiffKey(RECONCILE_DIFF_TYPES.field_mismatch, item.material_code, item.operation_no),
        );
      }
    }
  }

  // ② 回执有、台账无：计费侧出现台账里没有的条目
  for (const [key, receipts] of receiptsByKey) {
    if (ledgerKeys.has(key)) continue;
    const accepted = receipts.filter((receipt) => receipt.accepted === 1);
    if (accepted.length === 0) continue;
    const latest = accepted[accepted.length - 1]!;
    const guide = RECONCILE_ATTRIBUTION_GUIDE[RECONCILE_ATTRIBUTIONS.unexpected_charge];
    diffs.push({
      diff_key: deriveDiffKey(RECONCILE_DIFF_TYPES.unknown_receipt, latest.material_code, latest.operation_no),
      diff_type: RECONCILE_DIFF_TYPES.unknown_receipt,
      attribution: RECONCILE_ATTRIBUTIONS.unexpected_charge,
      attribution_detail: `计费侧有成功回执（attempt=${latest.attempt}，投递次数=${latest.delivery_count}），台账里查不到这条耗材`,
      operation_no: latest.operation_no,
      room_no: null,
      dept_code: null,
      material_code: latest.material_code,
      quantity: latest.submitted_quantity,
      ledger_quantity: null,
      receipt_quantity: latest.submitted_quantity,
      ledger_price_code: null,
      receipt_price_code: latest.submitted_price_code,
      ledger_fee_category: null,
      receipt_fee_category: latest.submitted_fee_category,
      ledger_insurance_class: null,
      receipt_insurance_class: latest.submitted_medical_insurance_class,
      mismatched_fields: null,
      suggested_action: guide.suggested_action,
      error_code: guide.error_code,
      binding_id: null,
      receipt_id: latest.id,
      attempt: latest.attempt,
      delivery_count: latest.delivery_count,
    });
    seenDiffKeys.add(
      deriveDiffKey(RECONCILE_DIFF_TYPES.unknown_receipt, latest.material_code, latest.operation_no),
    );
  }

  const byType: Record<ReconcileDiffType, number> = {
    MISSING_RECEIPT: 0,
    UNKNOWN_RECEIPT: 0,
    FIELD_MISMATCH: 0,
  };
  const byAttribution: Record<string, number> = {};
  for (const diff of diffs) {
    byType[diff.diff_type] += 1;
    byAttribution[diff.attribution] = (byAttribution[diff.attribution] ?? 0) + 1;
  }

  let newDiffs = 0;
  let autoResolved = 0;

  if (persist) {
    withTransaction(db, () => {
      for (const diff of diffs) {
        const existed = db
          .prepare('SELECT id FROM reconcile_diff WHERE diff_key = ?')
          .get(diff.diff_key) as { id: number } | undefined;
        upsertDiff(db, diff, now);
        if (!existed) newDiffs += 1;
      }
      // 差异已消失的：自动闭环（标已处理），差异台账不留「永远待处理」的僵尸行
      const scopeWhere: string[] = [];
      const scopeParams: Array<string | number> = [];
      if (options.operation_no) {
        scopeWhere.push('operation_no = ?');
        scopeParams.push(options.operation_no);
      }
      if (options.material_code) {
        scopeWhere.push('material_code = ?');
        scopeParams.push(options.material_code);
      }
      const scopeClause = scopeWhere.length > 0 ? `AND ${scopeWhere.join(' AND ')}` : '';
      const stale = db
        .prepare(
          `SELECT id, diff_key FROM reconcile_diff
            WHERE status = 'pending' ${scopeClause}`,
        )
        .all(...scopeParams) as unknown as Array<{ id: number; diff_key: string }>;
      for (const row of stale) {
        if (seenDiffKeys.has(row.diff_key)) continue;
        db.prepare(
          `UPDATE reconcile_diff
              SET status = 'resolved', resolved_at = ?, resolved_by = 'auto_reconcile'
            WHERE id = ?`,
        ).run(now, row.id);
        autoResolved += 1;
      }
    });
  }

  // 本轮对出的差异：带上差异台账里的处置状态与核查条目挂接
  const rows = diffs.map((diff) => {
    const row = pendingDiffToRow(diff, now);
    if (!persist) return row;
    const stored = db
      .prepare('SELECT id, status, check_task_id, created_at FROM reconcile_diff WHERE diff_key = ?')
      .get(diff.diff_key) as
      | { id: number; status: 'pending' | 'resolved'; check_task_id: number | null; created_at: string }
      | undefined;
    if (!stored) return row;
    return {
      ...row,
      id: Number(stored.id),
      status: stored.status,
      check_task_id: stored.check_task_id,
      created_at: stored.created_at,
    };
  });

  const pendingRow = db
    .prepare(
      options.operation_no
        ? "SELECT COUNT(*) AS n FROM reconcile_diff WHERE status = 'pending' AND operation_no = ?"
        : "SELECT COUNT(*) AS n FROM reconcile_diff WHERE status = 'pending'",
    )
    .get(...(options.operation_no ? [options.operation_no] : [])) as { n: number };

  return {
    generated_at: now,
    scope: { operation_no: options.operation_no ?? null, material_code: options.material_code ?? null },
    ledger_items: ledgerItems.length,
    receipt_items: receiptsByKey.size,
    by_type: byType,
    by_attribution: byAttribution,
    diffs: rows,
    new_diffs: newDiffs,
    auto_resolved: autoResolved,
    pending_total: pendingRow.n,
  };
}

/** 落库前的差异 → 台账行形状（只读盘点用） */
function pendingDiffToRow(diff: PendingDiff, now: string): ReconcileDiffRow {
  return {
    id: 0,
    diff_key: diff.diff_key,
    diff_type: diff.diff_type,
    attribution: diff.attribution,
    attribution_detail: diff.attribution_detail,
    operation_no: diff.operation_no,
    room_no: diff.room_no,
    dept_code: diff.dept_code,
    material_code: diff.material_code,
    quantity: diff.quantity,
    ledger_quantity: diff.ledger_quantity,
    receipt_quantity: diff.receipt_quantity,
    ledger_price_code: diff.ledger_price_code,
    receipt_price_code: diff.receipt_price_code,
    ledger_fee_category: diff.ledger_fee_category,
    receipt_fee_category: diff.receipt_fee_category,
    ledger_insurance_class: diff.ledger_insurance_class,
    receipt_insurance_class: diff.receipt_insurance_class,
    mismatched_fields: diff.mismatched_fields,
    suggested_action: diff.suggested_action,
    error_code: diff.error_code,
    status: 'pending',
    binding_id: diff.binding_id,
    receipt_id: diff.receipt_id,
    check_task_id: null,
    attempt: diff.attempt,
    delivery_count: diff.delivery_count,
    detected_at: now,
    resolved_at: null,
    resolved_by: null,
    created_at: now,
  };
}

const DIFF_COLUMNS = `id, diff_key, diff_type, attribution, attribution_detail, operation_no, room_no,
       dept_code, material_code, quantity, ledger_quantity, receipt_quantity,
       ledger_price_code, receipt_price_code, ledger_fee_category, receipt_fee_category,
       ledger_insurance_class, receipt_insurance_class, mismatched_fields, suggested_action,
       error_code, status, binding_id, receipt_id, check_task_id, attempt, delivery_count,
       detected_at, resolved_at, resolved_by, created_at`;

/** 读差异台账（可按台次 / 耗材码 / 处置状态过滤） */
export function listDiffs(
  db: DatabaseSync,
  options: ReconcileOptions & { status?: string | null } = {},
): ReconcileDiffRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.operation_no) {
    where.push('operation_no = ?');
    params.push(options.operation_no);
  }
  if (options.material_code) {
    where.push('material_code = ?');
    params.push(options.material_code);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0
    ? (options.limit as number)
    : 5_000;
  const rows = db
    .prepare(
      `SELECT ${DIFF_COLUMNS} FROM reconcile_diff ${clause}
        ORDER BY detected_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit) as unknown as ReconcileDiffRow[];
  return rows.map((row) => ({
    ...row,
    quantity: row.quantity == null ? null : Number(row.quantity),
    ledger_quantity: row.ledger_quantity == null ? null : Number(row.ledger_quantity),
    receipt_quantity: row.receipt_quantity == null ? null : Number(row.receipt_quantity),
  }));
}

/** 按 id 取一条差异 */
export function findDiff(db: DatabaseSync, id: number): ReconcileDiffRow | undefined {
  const row = db
    .prepare(`SELECT ${DIFF_COLUMNS} FROM reconcile_diff WHERE id = ?`)
    .get(id) as unknown as ReconcileDiffRow | undefined;
  return row;
}

/** 待处理的差异条数 */
export function countPendingDiffs(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM reconcile_diff WHERE status = 'pending'")
    .get() as { n: number };
  return row.n;
}

/**
 * 差异 → 核查任务（护士长 / 耗材管理岗处置的入口）。
 *
 * 差异台账与核查任务**双向挂接**：差异行的 check_task_id 指向核查条目，
 * 核查条目的 reconcile_diff_id 指回差异行（人工确认后两边都能查到）。
 *
 * 幂等：同一条差异已经有核查条目就复用，不刷重复待办。
 */
export function createCheckTaskFromDiff(
  db: DatabaseSync,
  diff_id: number,
  operator = 'reconcile',
): { task_id: number; diff_id: number; reused: boolean } {
  const diff = findDiff(db, diff_id);
  if (!diff) {
    throw new ReconcileError('ERR_RECONCILE_DIFF_NOT_FOUND', `差异 #${diff_id} 不存在`);
  }

  const existing = db
    .prepare(
      "SELECT id FROM check_task WHERE reconcile_diff_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1",
    )
    .get(diff.id) as { id: number } | undefined;
  if (existing) {
    return { task_id: existing.id, diff_id: diff.id, reused: true };
  }

  const taskId = withTransaction(db, () => {
    const id = createCheckTask(db, {
      operation_no: diff.operation_no,
      room_no: diff.room_no ?? '',
      dept_code: diff.dept_code,
      material_code: diff.material_code,
      quantity: diff.quantity,
      conclusion: diff.diff_type,
      reason_code: diff.attribution,
      error_code: diff.error_code,
      binding_id: diff.binding_id,
      reconcile_diff_id: diff.id,
    });
    db.prepare('UPDATE reconcile_diff SET check_task_id = ? WHERE id = ?').run(id, diff.id);
    return id;
  });

  return { task_id: taskId, diff_id: diff.id, reused: false };
}

/**
 * 人工处置：把差异标为已处理。
 *
 * **只改差异台账** —— 不动台账、不动计费侧（已回写计费的条目不自动冲正）。
 */
export function resolveDiff(
  db: DatabaseSync,
  diff_id: number,
  operator: string,
  note?: string,
): ReconcileDiffRow {
  const diff = findDiff(db, diff_id);
  if (!diff) {
    throw new ReconcileError('ERR_RECONCILE_DIFF_NOT_FOUND', `差异 #${diff_id} 不存在`);
  }
  if (diff.status === 'resolved') {
    throw new ReconcileError(
      'ERR_RECONCILE_DIFF_ALREADY_RESOLVED',
      `差异 #${diff_id} 已由 ${diff.resolved_by ?? '未知'} 于 ${diff.resolved_at ?? '未知时间'} 处置，重复处置被拒`,
    );
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE reconcile_diff
        SET status = 'resolved', resolved_at = ?, resolved_by = ?
      WHERE id = ?`,
  ).run(now, operator, diff.id);
  return findDiff(db, diff_id)!;
}

/** 对账层的错误（带错误码） */
export class ReconcileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReconcileError';
    this.code = code;
  }
}

/* ── 导出 ─────────────────────────────────────────────────────────────── */

/** 差异台账 → 导出行（字段白名单；归因带中文说明） */
export function toExportRows(rows: readonly ReconcileDiffRow[]): ReconcileExportRow[] {
  return rows.map((row) => {
    const guide = RECONCILE_ATTRIBUTION_GUIDE[row.attribution];
    return {
      diff_id: row.id,
      diff_key: row.diff_key,
      diff_type: row.diff_type,
      diff_type_zh: RECONCILE_DIFF_TYPE_LABELS[row.diff_type] ?? row.diff_type,
      attribution: row.attribution,
      attribution_zh: guide?.meaning_zh ?? row.attribution,
      operation_no: row.operation_no,
      room_no: row.room_no ?? '',
      dept_code: row.dept_code ?? '',
      material_code: row.material_code,
      quantity: row.quantity,
      ledger_quantity: row.ledger_quantity,
      receipt_quantity: row.receipt_quantity,
      ledger_price_code: row.ledger_price_code ?? '',
      receipt_price_code: row.receipt_price_code ?? '',
      ledger_fee_category: row.ledger_fee_category ?? '',
      receipt_fee_category: row.receipt_fee_category ?? '',
      ledger_medical_insurance_class: row.ledger_insurance_class ?? '',
      receipt_medical_insurance_class: row.receipt_insurance_class ?? '',
      mismatched_fields: row.mismatched_fields ?? '',
      suggested_action: row.suggested_action,
      error_code: row.error_code ?? '',
      status: row.status,
      check_task_id: row.check_task_id,
      attempt: row.attempt,
      delivery_count: row.delivery_count,
      detected_at: row.detected_at,
      resolved_at: row.resolved_at ?? '',
      resolved_by: row.resolved_by ?? '',
    };
  });
}

/** CSV 字段转义 */
function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 差异台账导出 CSV（表头 = 白名单顺序） */
export function diffsToCsv(rows: readonly ReconcileDiffRow[]): string {
  const exportRows = toExportRows(rows);
  const header = RECONCILE_EXPORT_FIELDS.join(',');
  const lines = exportRows.map((row) =>
    RECONCILE_EXPORT_FIELDS.map((field) => csvCell(row[field])).join(','),
  );
  return [header, ...lines].join('\n');
}

/** 差异台账导出 JSON（字段白名单 + 归因说明） */
export function diffsToJson(rows: readonly ReconcileDiffRow[]): string {
  return JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      fields: [...RECONCILE_EXPORT_FIELDS],
      attribution_guide: Object.fromEntries(
        Object.entries(RECONCILE_ATTRIBUTION_GUIDE).map(([key, value]) => [
          key,
          { meaning_zh: value.meaning_zh, suggested_action: value.suggested_action, error_code: value.error_code },
        ]),
      ),
      rows: toExportRows(rows),
    },
    null,
    2,
  );
}
