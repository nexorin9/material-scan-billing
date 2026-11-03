/**
 * 扫码事件与耗材条目的领域类型 + 运行时字段校验。
 *
 * 纯类型与不变量，无 IO。入站请求体字段与 spec.md「最小数据格式与字段要求」逐字一致：
 *   {operation_no, room_no, scanner_id, scans:[{material_code, quantity, scan_time, batch_no}]}
 *
 * 字段规则的真源是**入站明细契约**（`src/api/contracts.ts` 的 `SCAN_ITEM_CONTRACT`）：
 * 扫码枪 HTTP 路与 RFID 目录投递路共用同一份契约 —— 谁都不另写一套字段规则。
 */

import {
  SCAN_ITEM_CONTRACT,
  renderViolations,
  validateAgainst,
  type ContractViolation,
} from '../api/contracts.js';

/** 码制：UDI / GS1 AI(01) 包装码 / 院内自编码 */
export type CodeForm = 'UDI' | 'GS1_AI01' | 'INTERNAL';

/**
 * 明细字段不合规的原因码（两路入站共用）。
 *
 * 「某一条扫码的字段没过契约」是同一个意思，不该两路各写一个码 ——
 * 现场按码查（`doctor` / 核查包）时只会看到一种说法。
 */
export const REASON_INVALID_SCAN_ITEM = 'INVALID_SCAN_ITEM';

export interface ScanItem {
  material_code: string;
  quantity: number;
  scan_time: string;
  batch_no?: string;
}

export interface ScanEvent {
  operation_no: string;
  room_no: string;
  scanner_id: string;
  scans: ScanItem[];
}

/**
 * 码制解析轨迹（由 `src/ingest/codes.ts` 产出，随台账落库）。
 *
 * 只记**可核对的解析事实**：码制、归一来源、DI / 批号 / 序列号、失效期**类别**
 * （不记具体日期）、GTIN 校验位核对结论、码段清单与解析问题。
 * 有了它，事后能逐条复核「这个码当时是怎么被解析成主数据键的」。
 */
export interface CodeParseTrace {
  /** 码制 */
  code_form: CodeForm;
  /** 归一来源：DI / AI01_PAYLOAD / INTERNAL_RAW / UNRESOLVED */
  canonical_source: string;
  /** 器械标识 DI */
  di: string | null;
  /** 批号 */
  batch_no: string | null;
  /** 失效期类别（long_term / has_expiry / expired / unknown，不含具体日期） */
  expiry_category: string;
  /** 序列号 */
  serial_no: string | null;
  /** GTIN 校验位核对结论 */
  gtin: {
    length: number;
    expected_check_digit: string;
    actual_check_digit: string;
    valid: boolean;
  } | null;
  /** 码段清单 */
  segments: { ai: string; kind: string; length: number }[];
  /** 解析问题 */
  issues: { reason_code: string; message: string }[];
}

/** 标准化后的耗材条目（码制归一后仍保留原始码，供事后核对） */
export interface NormalizedMaterial {
  /** 归一后的院内耗材码 */
  material_code: string;
  /** 设备上报的原始码 */
  raw_code: string;
  code_form: CodeForm;
  quantity: number;
  scan_time: string;
  batch_no: string | null;
  /** 码制解析轨迹（落台账，事后可核对） */
  parse_trace?: CodeParseTrace | null;
}

/** 五种绑定结论：同一条扫码只落一种结论 */
export type ConclusionCode = 'BOUND' | 'NOT_REGISTERED' | 'CROSS_OP_DUP' | 'CLOSED' | 'CHARGE_REJECTED';

export const CONCLUSION_CODES: readonly ConclusionCode[] = [
  'BOUND',
  'NOT_REGISTERED',
  'CROSS_OP_DUP',
  'CLOSED',
  'CHARGE_REJECTED',
];

export interface FieldIssue {
  /** 出问题的字段名（逐字段定位，不是一句「格式错误」） */
  field: string;
  /** 中文原因 */
  reason: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: FieldIssue[] };

/**
 * 按**入站明细契约**校验一条扫码的结果。
 *
 * 与老口径 `validateScanItem` 的差别：
 *   - 违规项是**结构化的**（字段名 + 期望 + 实际），能直接贴给设备厂商；
 *   - 一次给**全部**违规项，不是只报第一个；
 *   - 字段规则来自契约表（`SCAN_ITEM_CONTRACT`），与出站契约同一份命名口径。
 */
export interface ScanItemContractResult {
  /** 是否合规 */
  ok: boolean;
  /** 合规时归一好的领域条目 */
  value: ScanItem | null;
  /** 违规项清单 */
  violations: ContractViolation[];
}

/**
 * 按入站明细契约校验一条扫码。
 *
 * 合规时把字段**去空格**后归一成领域条目（契约只管形状与取值，
 * 归一后的码制解析在 `src/ingest/normalize.ts`）。
 */
export function validateScanItemContract(input: unknown): ScanItemContractResult {
  const violations = validateAgainst(SCAN_ITEM_CONTRACT, input);
  if (violations.length > 0) {
    return { ok: false, value: null, violations };
  }
  const record = input as Record<string, unknown>;
  const materialCode = String(record['material_code']).trim();
  const scanTime = String(record['scan_time']).trim();
  const rawBatch = record['batch_no'];
  const batchNo =
    rawBatch === undefined || rawBatch === null ? undefined : String(rawBatch).trim();
  return {
    ok: true,
    value: {
      material_code: materialCode,
      quantity: Number(record['quantity']),
      scan_time: scanTime,
      ...(batchNo !== undefined && batchNo.length > 0 ? { batch_no: batchNo } : {}),
    },
    violations: [],
  };
}

/** 把契约违规项渲染成一句中文说明（进回执 / 核查条目 / 日志 detail） */
export function describeContractViolations(violations: readonly ContractViolation[]): string {
  return renderViolations(violations);
}

export const MAX_CODE_LENGTH = 64;
export const MAX_ID_LENGTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** 校验单条耗材条目 */
export function validateScanItem(input: unknown, path = 'scans[]'): ValidationResult<ScanItem> {
  const issues: FieldIssue[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, issues: [{ field: path, reason: '不是对象' }] };
  }
  const material_code = requireString(input['material_code']);
  if (!material_code) {
    issues.push({ field: `${path}.material_code`, reason: '耗材码为空' });
  } else if (material_code.length > MAX_CODE_LENGTH) {
    issues.push({ field: `${path}.material_code`, reason: `耗材码超过 ${MAX_CODE_LENGTH} 字符` });
  }

  const quantity = input['quantity'];
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    issues.push({ field: `${path}.quantity`, reason: '数量不是数值' });
  } else if (!Number.isInteger(quantity) || quantity <= 0) {
    issues.push({ field: `${path}.quantity`, reason: '数量必须是正整数' });
  }

  const scan_time = requireString(input['scan_time']);
  if (!scan_time) {
    issues.push({ field: `${path}.scan_time`, reason: '扫描时间为空' });
  } else if (Number.isNaN(Date.parse(scan_time))) {
    issues.push({ field: `${path}.scan_time`, reason: '扫描时间无法解析' });
  }

  const rawBatch = input['batch_no'];
  let batch_no: string | undefined;
  if (rawBatch !== undefined && rawBatch !== null && rawBatch !== '') {
    const batch = requireString(rawBatch);
    if (!batch) {
      issues.push({ field: `${path}.batch_no`, reason: '批号不是有效字符串' });
    } else {
      batch_no = batch;
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      material_code: material_code as string,
      quantity: quantity as number,
      scan_time: scan_time as string,
      ...(batch_no !== undefined ? { batch_no } : {}),
    },
  };
}

/** 校验整批扫码事件 */
export function validateScanEvent(input: unknown): ValidationResult<ScanEvent> {
  const issues: FieldIssue[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, issues: [{ field: 'body', reason: '请求体不是对象' }] };
  }

  const operation_no = requireString(input['operation_no']);
  if (!operation_no) issues.push({ field: 'operation_no', reason: '台次号为空' });

  const room_no = requireString(input['room_no']);
  if (!room_no) issues.push({ field: 'room_no', reason: '手术间号为空' });

  const scanner_id = requireString(input['scanner_id']);
  if (!scanner_id) issues.push({ field: 'scanner_id', reason: '扫码枪编号为空' });

  const scans = input['scans'];
  const items: ScanItem[] = [];
  if (!Array.isArray(scans)) {
    issues.push({ field: 'scans', reason: 'scans 不是数组' });
  } else if (scans.length === 0) {
    issues.push({ field: 'scans', reason: 'scans 为空批次' });
  } else {
    scans.forEach((raw, index) => {
      const result = validateScanItem(raw, `scans[${index}]`);
      if (result.ok) items.push(result.value);
      else issues.push(...result.issues);
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      operation_no: operation_no as string,
      room_no: room_no as string,
      scanner_id: scanner_id as string,
      scans: items,
    },
  };
}
