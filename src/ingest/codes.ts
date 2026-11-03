/**
 * 耗材码制深解析器：UDI / GS1 AI(01) / 院内码 → 院内耗材主数据键。
 *
 * 扫码枪扫出来的码可能是三种形态，**码段结构、校验位与主数据键都不一样**：
 *
 *   UDI       —— 带 GS1 应用标识符的码（GS1 128 / HIBC 写法）：
 *                 `(01)器械标识(10)批号(17)失效期(21)序列号`
 *                 其中 `(01)` 是器械标识 DI（14 位 GTIN），其余是生产标识 PI。
 *   GS1_AI01  —— 裸 `01` + 14 位 GTIN 的包装码（只有器械标识，没有生产标识）。
 *   INTERNAL  —— 院内自编码（不走 GS1 规则，**不做 GTIN 校验位判定**）。
 *
 * 本模块只回答「设备扫出来的这个码，对应主数据里的哪一个键」，
 * **不回答「这个耗材能不能用」**（能否绑定由判定引擎 `src/engine/` 决定）。
 *
 * 三条硬口径：
 *
 *   ① **GTIN 校验位必算**：14 位（以及 13 位）GTIN 的校验位按 GS1 mod-10 计算并比对，
 *      不符即判「码本身有问题」，给**独立错误码**（`CODE_GTIN_CHECK_DIGIT_INVALID`），
 *      **不与「耗材未建档」混同** —— 扫坏了条码和没建档是两回事，处置动作完全不同。
 *   ② **DI / PI 分离**：器械标识（DI）与生产标识（PI）分开取；PI 里的批号会进入
 *      v2 幂等键维度（同码不同批是两次真实消耗）。失效期只保留**类别**
 *      （长期有效 / 有失效期 / 已过期 / 未知），**不落具体日期**。
 *   ③ **解析轨迹随码走**：原始码、码制、码段清单、DI、批号、校验位核对结论
 *      一起落台账，事后能逐条复核「这个码当时是怎么解析的」。
 */

import type { CodeForm, CodeParseTrace } from '../domain/scan-event.js';

export type { CodeForm, CodeParseTrace };

/** GS1 应用标识符 (01) —— 器械标识 */
const AI_GTIN = '01';
/** GS1 应用标识符 (10) —— 批号 */
const AI_BATCH = '10';
/** GS1 应用标识符 (17) —— 失效期 */
const AI_EXPIRY = '17';
/** GS1 应用标识符 (21) —— 序列号 */
const AI_SERIAL = '21';
/** GTIN-14 长度 */
const GTIN14_LENGTH = 14;
/** GTIN-13 长度 */
const GTIN13_LENGTH = 13;
/** GS1 分隔符（FNC1 / ASCII 29）：变长段的分隔符 */
const GS_SEPARATOR = '\u001D';
/** 带括号的 GS1 应用标识符元素 */
const AI_ELEMENT_PATTERN = /\((\d{2,4})\)([^()]*)/g;

/** 码段（一个 GS1 应用标识符及其数据位） */
export interface CodeSegment {
  /** 应用标识符，如 01 / 10 / 17 / 21 */
  ai: string;
  /** 段的语义类别 */
  kind: 'device_identifier' | 'batch' | 'expiry' | 'serial' | 'other';
  /** 数据位长度 */
  length: number;
}

/** 失效期类别：**只给类别，不给具体日期** */
export type ExpiryCategory = 'long_term' | 'has_expiry' | 'expired' | 'unknown';

/** GTIN 校验位核对结果 */
export interface GtinCheck {
  /** GTIN 长度（13 或 14） */
  length: 13 | 14;
  /** 数据位（不含校验位） */
  payload: string;
  /** 按 GS1 mod-10 算出的期望校验位 */
  expected_check_digit: string;
  /** 码里实际的校验位 */
  actual_check_digit: string;
  /** 校验位是否相符 */
  valid: boolean;
}

/** 解析过程中的问题（逐条可追踪） */
export interface CodeParseIssue {
  reason_code: string;
  message: string;
}

/** 归一来源：主数据键是从码的哪一部分取出来的 */
export type CanonicalSource = 'DI' | 'AI01_PAYLOAD' | 'INTERNAL_RAW' | 'UNRESOLVED';

/** 解析结果 */
export interface ParsedCode {
  /** 码制 */
  code_form: CodeForm;
  /** 设备上报的原始码 */
  raw_code: string;
  /** 码段清单 */
  segments: CodeSegment[];
  /** 器械标识 DI（GS1 (01) 的 GTIN；院内码没有） */
  di: string | null;
  /** 生产标识 PI 里的批号 */
  batch_no: string | null;
  /** 序列号 */
  serial_no: string | null;
  /** 失效期类别（不落具体日期） */
  expiry_category: ExpiryCategory;
  /** GTIN 校验位核对结果（不是 GTIN 族时为 null） */
  gtin: GtinCheck | null;
  /** 归一来源 */
  canonical_source: CanonicalSource;
  /** 归一后的院内耗材主数据键 */
  canonical_code: string;
  /** 解析问题 */
  issues: CodeParseIssue[];
}

/** 归一结果（进主路径用） */
export interface CanonicalMaterial {
  /** 归一后的院内耗材主数据键 */
  material_code: string;
  /** 设备上报的原始码 */
  raw_code: string;
  /** 码制 */
  code_form: CodeForm;
  /** 批号（v2 幂等键维度） */
  batch_no: string | null;
  /** 解析轨迹（落台账，事后可核对） */
  trace: CodeParseTrace;
}

/* ── 原因码（与 `src/engine/validate-code.ts` 的结构层原因码同源） ── */

/** GTIN 校验位不符：条码本身有问题，不是未建档 */
export const REASON_CODE_GTIN_CHECK_DIGIT_INVALID = 'CODE_GTIN_CHECK_DIGIT_INVALID';
/** GS1 码制里取不到器械标识 DI */
export const REASON_CODE_DI_MISSING = 'CODE_DI_MISSING';
/** GS1 应用标识符串解析不出来 */
export const REASON_CODE_AI_PARSE_ERROR = 'CODE_AI_PARSE_ERROR';

/* ── 码制识别 ─────────────────────────────────────────────────────────── */

/**
 * 判断码制（形态识别，不做校验位判定）。
 *
 * 形态识别只看**写法**，不看内容对不对：
 *   带括号 / 带 GS1 分隔符 → UDI；裸 `01` + 14 位 → GS1_AI01；其余 → 院内码。
 */
export function detectCodeForm(code: string): CodeForm {
  const trimmed = (code ?? '').trim();
  if (!trimmed) return 'INTERNAL';

  // 带括号的 GS1 应用标识符写法
  if (trimmed.includes('(')) {
    if (trimmed.includes(`(${AI_GTIN})`)) return 'UDI';
    return 'UDI';
  }

  // 含 GS1 分隔符（带 FNC1 的扫描枪输出）：元素串带变长段，按 UDI 族处理
  if (trimmed.includes(GS_SEPARATOR)) return 'UDI';

  // 裸 `01` + 14 位 GTIN（后面可能还跟着未用分隔符隔开的变长段）
  if (/^01\d{14}/.test(trimmed)) return 'GS1_AI01';

  return 'INTERNAL';
}

/** 应用标识符 → 语义类别 */
function segmentKind(ai: string): CodeSegment['kind'] {
  if (ai === AI_GTIN) return 'device_identifier';
  if (ai === AI_BATCH) return 'batch';
  if (ai === AI_EXPIRY) return 'expiry';
  if (ai === AI_SERIAL) return 'serial';
  return 'other';
}

/**
 * 解析括号写法的 GS1 元素串：`(01)值(10)值…`。
 * 每个 AI 的值是「到下一个 `(` 之前的普通数据」。
 */
function parseParenthesizedElements(code: string): Map<string, string> {
  const elements = new Map<string, string>();
  const pattern = new RegExp(AI_ELEMENT_PATTERN.source, 'g');
  let match = pattern.exec(code);
  while (match !== null) {
    const ai = match[1];
    const value = (match[2] ?? '').trim();
    if (ai && !elements.has(ai)) elements.set(ai, value);
    match = pattern.exec(code);
  }
  return elements;
}

/**
 * 解析带 FNC1 分隔符的 GS1 元素串（扫描枪直接吐 GS1 128 元素串时的形态）。
 *
 * 只支持本产品关心的固定长度段（01 / 17）与变长段（10 / 21）：
 *   `01<14 位>` 之后依次是 `10<批号>␝` / `17<6 位>` / `21<序列号>␝`。
 * 变长段到下一个分隔符或串尾为止。
 */
function parseFnC1Elements(code: string): Map<string, string> {
  const elements = new Map<string, string>();
  const body = code.split(GS_SEPARATOR);

  /** 把「AI 前缀 + 值」的一段写进元素表（值到本段结尾为止） */
  const takeAiChunk = (chunk: string): void => {
    if (chunk.length < 2) return;
    const ai = chunk.slice(0, 2);
    const value = chunk.slice(2);
    if (!elements.has(ai)) elements.set(ai, value);
  };

  let first = true;
  for (const chunk of body) {
    if (chunk.length === 0) continue;
    if (first) {
      first = false;
      // 首个元素：01 + 14 位 GTIN；其后紧跟的变长段仍在本段里（无分隔符时按 AI 前缀继续拆）
      if (!chunk.startsWith(AI_GTIN) || chunk.length < AI_GTIN.length + GTIN14_LENGTH) continue;
      elements.set(AI_GTIN, chunk.slice(AI_GTIN.length, AI_GTIN.length + GTIN14_LENGTH));
      takeAiChunk(chunk.slice(AI_GTIN.length + GTIN14_LENGTH));
      continue;
    }
    takeAiChunk(chunk);
  }
  return elements;
}

/* ── GTIN 校验位 ──────────────────────────────────────────────────────── */

/**
 * 按 GS1 mod-10 算 GTIN 校验位。
 *
 * 权重自数据位最右端起 3,1,3,1…（GTIN-14 的 13 位数据位两端权重都是 3）。
 * 校验位 = (10 − 加权和 mod 10) mod 10。
 */
export function computeGtinCheckDigit(dataDigits: string): string {
  let sum = 0;
  let triple = true;
  for (let i = dataDigits.length - 1; i >= 0; i -= 1) {
    const digit = dataDigits.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) continue;
    sum += triple ? digit * 3 : digit;
    triple = !triple;
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * 核对一个 13 / 14 位数字码的 GTIN 校验位。
 * 不是 13 / 14 位纯数字时返回 null（不是 GTIN 候选）。
 */
export function checkGtin(code: string): GtinCheck | null {
  const trimmed = (code ?? '').trim();
  if (!/^\d{13,14}$/.test(trimmed)) return null;
  const length = trimmed.length as 13 | 14;
  const payload = trimmed.slice(0, length - 1);
  const actual = trimmed.slice(length - 1);
  const expected = computeGtinCheckDigit(payload);
  return {
    length,
    payload,
    expected_check_digit: expected,
    actual_check_digit: actual,
    valid: expected === actual,
  };
}

/* ── 失效期分类 ───────────────────────────────────────────────────────── */

/**
 * 把 (17) 的值归成**类别**（不返回具体日期）。
 *
 *   没有 (17) 段 → 长期有效
 *   有 (17) 且已过 → 已过期
 *   有 (17) 且未过 → 有失效期
 *   有 (17) 但读不出来 → 未知
 */
export function classifyExpiry(value: string | null, nowMs: number = Date.now()): ExpiryCategory {
  if (value === null) return 'long_term';
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'unknown';
  const matched = /^(\d{2})(\d{2})(\d{2})$/.exec(trimmed);
  if (!matched) return 'unknown';
  const year = 2000 + Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return 'unknown';
  const expiryMs = Date.UTC(year, month - 1, day, 23, 59, 59);
  return expiryMs < nowMs ? 'expired' : 'has_expiry';
}

/* ── 主解析 ───────────────────────────────────────────────────────────── */

/**
 * 解析一个设备上报的码。
 *
 * 返回值里**不含具体失效期日期**，只有类别；原始码原样保留（供事后核对）。
 */
export function parseCode(code: string, nowMs: number = Date.now()): ParsedCode {
  const raw_code = code ?? '';
  const trimmed = raw_code.trim();
  const code_form = detectCodeForm(trimmed);
  const issues: CodeParseIssue[] = [];

  if (trimmed.length === 0) {
    issues.push({ reason_code: 'CODE_EMPTY', message: '耗材码为空' });
    return {
      code_form: 'INTERNAL',
      raw_code,
      segments: [],
      di: null,
      batch_no: null,
      serial_no: null,
      expiry_category: 'unknown',
      gtin: null,
      canonical_source: 'UNRESOLVED',
      canonical_code: '',
      issues,
    };
  }

  // 院内码：不走 GS1 规则，原样作为主数据键
  if (code_form === 'INTERNAL') {
    return {
      code_form,
      raw_code,
      segments: [],
      di: null,
      batch_no: null,
      serial_no: null,
      expiry_category: 'long_term',
      gtin: null,
      canonical_source: 'INTERNAL_RAW',
      canonical_code: trimmed,
      issues,
    };
  }

  // GS1 族：拆应用标识符
  const elements = trimmed.includes('(')
    ? parseParenthesizedElements(trimmed)
    : parseFnC1Elements(trimmed);

  if (elements.size === 0) {
    issues.push({
      reason_code: REASON_CODE_AI_PARSE_ERROR,
      message: 'GS1 码制解析不出应用标识符元素',
    });
  }

  const diRaw = (elements.get(AI_GTIN) ?? '').trim();
  const batchRaw = (elements.get(AI_BATCH) ?? '').trim();
  const expiryRaw = elements.has(AI_EXPIRY) ? (elements.get(AI_EXPIRY) ?? '').trim() : null;
  const serialRaw = (elements.get(AI_SERIAL) ?? '').trim();

  // GS1_AI01：裸 `01` + 14 位，元素表里没有 (01) 键时按位置取
  const di =
    diRaw.length > 0
      ? diRaw
      : code_form === 'GS1_AI01' && trimmed.startsWith(AI_GTIN) && trimmed.length >= AI_GTIN.length + GTIN14_LENGTH
        ? trimmed.slice(AI_GTIN.length, AI_GTIN.length + GTIN14_LENGTH)
        : '';

  const segments: CodeSegment[] = [];
  for (const [ai, value] of elements) {
    segments.push({ ai, kind: segmentKind(ai), length: value.length });
  }
  if (code_form === 'GS1_AI01' && segments.length === 0) {
    segments.push({ ai: AI_GTIN, kind: 'device_identifier', length: GTIN14_LENGTH });
  }

  let gtin: GtinCheck | null = null;
  if (di.length > 0) {
    gtin = checkGtin(di);
    if (gtin && !gtin.valid) {
      issues.push({
        reason_code: REASON_CODE_GTIN_CHECK_DIGIT_INVALID,
        message:
          `GTIN-${gtin.length} 校验位不符：期望 ${gtin.expected_check_digit}，实际 ${gtin.actual_check_digit}；` +
          '条码本身有问题（可能扫坏或不是耗材码），不是「耗材未建档」',
      });
    }
  } else {
    issues.push({
      reason_code: REASON_CODE_DI_MISSING,
      message: 'GS1 码制里取不到器械标识（DI），无法定位主数据键',
    });
  }

  const canonicalCode =
    di.length === GTIN14_LENGTH || di.length === GTIN13_LENGTH ? di : trimmed;

  return {
    code_form,
    raw_code,
    segments,
    di: di.length > 0 ? di : null,
    batch_no: batchRaw.length > 0 ? batchRaw : null,
    serial_no: serialRaw.length > 0 ? serialRaw : null,
    expiry_category: classifyExpiry(expiryRaw, nowMs),
    gtin,
    canonical_source: di.length > 0 ? 'DI' : code_form === 'GS1_AI01' ? 'AI01_PAYLOAD' : 'UNRESOLVED',
    canonical_code: canonicalCode,
    issues,
  };
}

/* ── 归一与轨迹 ───────────────────────────────────────────────────────── */

/** 解析轨迹（可 JSON 序列化，落台账） */
export function buildParseTrace(parsed: ParsedCode): CodeParseTrace {
  return {
    code_form: parsed.code_form,
    canonical_source: parsed.canonical_source,
    di: parsed.di,
    batch_no: parsed.batch_no,
    expiry_category: parsed.expiry_category,
    serial_no: parsed.serial_no,
    gtin: parsed.gtin
      ? {
          length: parsed.gtin.length,
          expected_check_digit: parsed.gtin.expected_check_digit,
          actual_check_digit: parsed.gtin.actual_check_digit,
          valid: parsed.gtin.valid,
        }
      : null,
    segments: parsed.segments.map((segment) => ({
      ai: segment.ai,
      kind: segment.kind,
      length: segment.length,
    })),
    issues: parsed.issues.map((issue) => ({
      reason_code: issue.reason_code,
      message: issue.message,
    })),
  };
}

/**
 * 把解析结果归一到院内耗材主数据键。
 *
 * 归一时**保留原始码与解析轨迹** —— 归一只是「找键」，不改写设备上报的事实。
 */
export function toCanonicalMaterialCode(parsed: ParsedCode): CanonicalMaterial {
  return {
    material_code: parsed.canonical_code,
    raw_code: parsed.raw_code,
    code_form: parsed.code_form,
    batch_no: parsed.batch_no,
    trace: buildParseTrace(parsed),
  };
}

/** 一站式：原始码 → 归一结果 */
export function canonicalizeMaterialCode(code: string, nowMs: number = Date.now()): CanonicalMaterial {
  return toCanonicalMaterialCode(parseCode(code, nowMs));
}
