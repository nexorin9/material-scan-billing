/**
 * 计费尝试史（逐条 attempt 的完整留痕与追溯）。
 *
 * 护士长问「这条耗材到底试了几次、每次错在哪」时，回执台账必须答得上来。
 * 本模块把**每一次投递尝试**摊平成一条可导出的记录：
 *
 *   时间（请求发出 / 回执到手）· 尝试序号 · 结果（对端收没收）·
 *   错误码与原因码 · 通道当时可达否 · 处置档位（可重投 / 不可重投 / 需人工）
 *
 * 语义来源（源产品主路径）：源产品的投递回执是
 * `MessageReceipt { user_id, delivery_count, active }` —— 回执带**投递次数**与
 * **通道当时是否可达**。源产品把「投了几次、当时通不通」直接放在回执里，
 * 本侧照此语义改写成耗材计费场景：一次尝试一行回执（`attempt` 连续），
 * 失败的那几次**同样留行**（不得只记成功），事后按条目 / 台次 / 时间窗都能回放。
 *
 * 硬约束：
 *   ① **每次尝试一行**：成功、业务拒绝、通道不可达三类都留痕；
 *   ② **序号连续**：同一条耗材的尝试序号从 1 起连续，不重号、不跳号；
 *   ③ **导出脱敏**：导出字段走白名单，**不含任何患者标识字段**
 *      （耗材码只绑手术台次，不落患者可识别明细）；
 *   ④ **历史行不伪造**：回填来的行带 `attempt_source = recovered` 与中文备注，
 *      一眼能看出「这个序号是补出来的，不是当时真记的」。
 */

import type { ChargeReceiptKind, ChargeReceiptRow } from './receipt.js';

/** 归类档位的中文说明（导出与终端输出共用） */
export const CHARGE_RECEIPT_KIND_LABELS: Readonly<Record<ChargeReceiptKind, string>> = {
  ACCEPTED: '对端已接收',
  BUSINESS_REJECTED: '对端业务拒绝（通道可达）',
  CHANNEL_UNREACHABLE: '通道当时不可达',
  CHANNEL_ERROR: '对端 5xx（通道可达）',
  PROTOCOL_ERROR: '回执结构不符',
  LOCAL_ERROR: '本侧校验未发出请求',
};

/** 处置档位的中文说明 */
export const ATTEMPT_DISPOSITION_LABELS: Readonly<Record<string, string>> = {
  RETRYABLE: '可重投',
  NOT_RETRYABLE: '不可重投',
  NEEDS_HUMAN: '需人工判读',
};

/**
 * 尝试史导出字段白名单。
 *
 * 只有台次上下文、尝试序号、结果、错误码、通道可达性与处置档位 ——
 * **没有任何患者标识字段**（无姓名 / 身份证 / 住院号 / 病案号 / patient 等）。
 */
export const ATTEMPT_HISTORY_EXPORT_FIELDS = [
  'receipt_id',
  'material_code',
  'operation_no',
  'attempt',
  'delivery_count',
  'result',
  'result_zh',
  'kind',
  'kind_zh',
  'reason_code',
  'error_code',
  'channel_reachable',
  'channel_reachable_zh',
  'retryable',
  'disposition',
  'disposition_zh',
  'requested_at',
  'responded_at',
  'duration_ms',
  'response_summary',
  'attempt_source',
  'history_note',
] as const;

export type AttemptHistoryExportField = (typeof ATTEMPT_HISTORY_EXPORT_FIELDS)[number];
export type AttemptHistoryExportRow = Record<AttemptHistoryExportField, string | number | null>;

/** CSV 字段转义（与差异台账导出口径一致） */
function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 两次时间戳之间的毫秒数；缺一端就留空（不猜） */
function durationMs(requested_at: string | null, responded_at: string | null): number | null {
  if (!requested_at || !responded_at) return null;
  const from = Date.parse(requested_at);
  const to = Date.parse(responded_at);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return to - from;
}

/** 回执行 → 导出行（字段白名单；中文说明就地生成） */
export function toAttemptExportRows(
  rows: readonly ChargeReceiptRow[],
): AttemptHistoryExportRow[] {
  return rows.map((row) => {
    const kind = (row.kind ?? null) as ChargeReceiptKind | null;
    return {
      receipt_id: row.id,
      material_code: row.material_code,
      operation_no: row.operation_no,
      attempt: row.attempt,
      delivery_count: row.delivery_count,
      result: row.accepted ? 'ACCEPTED' : 'REJECTED',
      result_zh: row.accepted ? '已计费' : '未计费',
      kind: kind ?? '',
      kind_zh: kind ? (CHARGE_RECEIPT_KIND_LABELS[kind] ?? kind) : '',
      reason_code: row.reason_code ?? '',
      error_code: row.error_code ?? '',
      channel_reachable:
        row.channel_reachable === null ? '' : row.channel_reachable ? '1' : '0',
      channel_reachable_zh:
        row.channel_reachable === null
          ? '未记录（历史行留空）'
          : row.channel_reachable
            ? '通道可达'
            : '通道不可达',
      retryable: row.retryable ? '1' : '0',
      disposition: row.disposition ?? '',
      disposition_zh: row.disposition ? (ATTEMPT_DISPOSITION_LABELS[row.disposition] ?? row.disposition) : '',
      requested_at: row.requested_at ?? '',
      responded_at: row.responded_at ?? '',
      duration_ms: durationMs(row.requested_at, row.responded_at),
      response_summary: row.response_summary ?? '',
      attempt_source: row.attempt_source ?? '',
      history_note: row.history_note ?? '',
    };
  });
}

/** 尝试史导出 CSV（表头 = 白名单顺序） */
export function attemptHistoryToCsv(rows: readonly ChargeReceiptRow[]): string {
  const exportRows = toAttemptExportRows(rows);
  const header = ATTEMPT_HISTORY_EXPORT_FIELDS.join(',');
  const lines = exportRows.map((row) =>
    ATTEMPT_HISTORY_EXPORT_FIELDS.map((field) => csvCell(row[field])).join(','),
  );
  return [header, ...lines].join('\n');
}

/** 尝试史导出 JSON（字段白名单 + 档位中文说明） */
export function attemptHistoryToJson(rows: readonly ChargeReceiptRow[]): string {
  return JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      fields: [...ATTEMPT_HISTORY_EXPORT_FIELDS],
      kind_labels: CHARGE_RECEIPT_KIND_LABELS,
      disposition_labels: ATTEMPT_DISPOSITION_LABELS,
      rows: toAttemptExportRows(rows),
    },
    null,
    2,
  );
}

/** 单条耗材的尝试史小结 */
export interface AttemptSummary {
  material_code: string;
  operation_no: string;
  /** 总尝试次数 */
  attempts: number;
  /** 每次尝试的结果（按序号） */
  outcomes: Array<'ACCEPTED' | 'REJECTED'>;
  /** 最终是否已计费 */
  charged: boolean;
  /** 出现过的错误码（去重，按出现顺序） */
  error_codes: string[];
  /** 出现过几次通道不可达 */
  unreachable_count: number;
  /** 结论一句话（中文） */
  conclusion_zh: string;
}

/**
 * 按条目汇总尝试史：试了几次、每次结果、最后有没有计上、错过哪几个码。
 *
 * 口径：**以最后一次尝试为准**。最后一次仍不是「已接收」→ 这条耗材还没计上费。
 */
export function summarizeAttemptHistory(
  rows: readonly ChargeReceiptRow[],
): AttemptSummary[] {
  const byItem = new Map<string, ChargeReceiptRow[]>();
  for (const row of rows) {
    const key = `${row.material_code} ${row.operation_no}`;
    const bucket = byItem.get(key);
    if (bucket) bucket.push(row);
    else byItem.set(key, [row]);
  }

  return [...byItem.values()].map((itemRows) => {
    const ordered = [...itemRows].sort((a, b) => a.attempt - b.attempt || a.id - b.id);
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    const errorCodes: string[] = [];
    let unreachable = 0;
    for (const row of ordered) {
      if (row.error_code && !errorCodes.includes(row.error_code)) errorCodes.push(row.error_code);
      // 只有「明确不可达」才计数；没记录（null）不算不可达
      if (row.channel_reachable === false) unreachable += 1;
    }
    const charged = last.accepted;
    return {
      material_code: first.material_code,
      operation_no: first.operation_no,
      attempts: ordered.length,
      outcomes: ordered.map((row) => (row.accepted ? 'ACCEPTED' : 'REJECTED')),
      charged,
      error_codes: errorCodes,
      unreachable_count: unreachable,
      conclusion_zh: charged
        ? `共投 ${ordered.length} 次，第 ${last.attempt} 次已计费`
        : `共投 ${ordered.length} 次仍未计费（最后一次：${CHARGE_RECEIPT_KIND_LABELS[last.kind ?? 'PROTOCOL_ERROR'] ?? '未计费'}）`,
    };
  });
}

/**
 * 终端可读版本：一条耗材一段，把每次尝试写清楚。
 *
 * 打印形态（关台核对时贴在台账边上那种）：
 *   MAT-SAMPLE-01 / OP-SAMPLE-001 —— 共投 3 次，第 3 次已计费
 *     #1  2026-01-15T09:12:00Z  对端业务拒绝（通道可达）  PRICE_CODE_NOT_FOUND / ERR_CHARGE_PRICE_CODE_NOT_FOUND
 *     #2  2026-01-15T09:12:03Z  通道当时不可达            ERR_CHARGE_TIMEOUT
 *     #3  2026-01-15T09:12:09Z  对端已接收                -
 */
export function renderAttemptTimeline(rows: readonly ChargeReceiptRow[]): string {
  const summaries = summarizeAttemptHistory(rows);
  const byItem = new Map<string, ChargeReceiptRow[]>();
  for (const row of rows) {
    const key = `${row.material_code} ${row.operation_no}`;
    const bucket = byItem.get(key);
    if (bucket) bucket.push(row);
    else byItem.set(key, [row]);
  }

  const lines: string[] = [];
  for (const summary of summaries) {
    lines.push(
      `${summary.material_code} / ${summary.operation_no} —— ${summary.conclusion_zh}`,
    );
    const itemRows = byItem.get(`${summary.material_code} ${summary.operation_no}`) ?? [];
    for (const row of [...itemRows].sort((a, b) => a.attempt - b.attempt || a.id - b.id)) {
      const kind = (row.kind ?? 'PROTOCOL_ERROR') as ChargeReceiptKind;
      const at = row.responded_at ?? row.requested_at ?? '-';
      const code = row.error_code ?? row.reason_code ?? '-';
      lines.push(`  #${row.attempt}  ${at}  ${CHARGE_RECEIPT_KIND_LABELS[kind] ?? kind}  ${code}`);
    }
  }
  return lines.join('\n');
}
