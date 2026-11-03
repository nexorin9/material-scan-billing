/**
 * 出站载荷清洗层：编码归一 + 字符归一 + 必填校验 + 长度前置判定。
 *
 * 为什么要有这一层：
 *   院内导出与设备上报的脏数据是常态 —— 老系统导出的 CSV 是 GBK、耗材名里带着
 *   「髋」「嗪」这类生僻字、从 Excel 粘过来的耗材码是全角、价码多了一列空格、
 *   偶尔还有空值。这些东西直接进计费载荷，后果分两种：
 *     ① 轻的：对端拒收（整台手术的计费一起丢，一条坏数据拖垮一整台）；
 *     ② 重的：**记错账** —— 截断过的耗材码就是另一个耗材；拿替换字符（U+FFFD）
 *        把乱码拼成「看起来像文本」再发出去，对端根本查不到这个价码。
 *
 * 三条硬约束：
 *   ① **编码解不出就拒，不糊弄** —— UTF-8 与 GBK 都解不出时**保留原始字节**并给
 *      独立错误码；绝不用替换字符把乱码拼成文本；
 *   ② **归一前后对照落台账** —— 全角转半角、去零宽字符、折叠空白都留痕，
 *      事后能回答「这一笔发出去之前被改过哪里、改的是什么」；
 *   ③ **缺字段就拒，不填默认值** —— 台次号 / 科室编码 / 耗材码 / 价码任一为空，
 *      拒**那一条**（请求级字段为空则整批发不出去），不拿默认值糊过去。
 *
 * 与长度上限表同源：长度判定在归一**之后**做（归一会改变长度 ——
 * 全角转半角长度不变，去零宽字符会变短），上限表复用 `src/api/contracts.ts`
 * 的同一张表，不另立一套口径。
 *
 * 与源产品的对应：源产品在网关入口对进来的报文做**协议级归一**（按目标实体路由、
 * 逐条取回执），本层把同一语义落到耗材计费载荷上 —— 先归一再判空、最后才发，
 * 保证发出去的一定是干净的、字段齐全的、长度合规的明细。
 */

/** 清洗层的错误码（与统一错误码表同源） */
import { TextDecoder } from 'node:util';

export const SANITIZE_ERROR_CODES = {
  /** 载荷编码不可解码：UTF-8 与 GBK 都失败（保留原始字节，不做替换字符糊弄） */
  encodingUndecodable: 'ERR_CHARGE_ENCODING_UNDECODABLE',
  /** 出站必填字段为空（台次号 / 科室编码 / 耗材码 / 价码 / 数量） */
  fieldMissing: 'ERR_CHARGE_FIELD_MISSING',
  /** 身份性字段写法不规范：归一后会变成**另一个**码 / 价码，不静默改写 */
  codeNotCanonical: 'ERR_CHARGE_CODE_NOT_CANONICAL',
} as const;

/** 支持的源编码 */
export type DecodeEncoding = 'utf-8' | 'gbk';

/** 默认的解码尝试顺序：先 UTF-8（JSON / 接口的标准编码），再 GBK（老系统导出） */
export const DEFAULT_DECODE_ENCODINGS: readonly DecodeEncoding[] = ['utf-8', 'gbk'];

/** 编码策略（可配）：auto = 按可读性择优；utf-8 / gbk = 只认这一种 */
export type EncodingStrategy = 'auto' | DecodeEncoding;

/* ── 编码解码 ────────────────────────────────────────────────────────────── */

/** 解码结果（失败时**保留原始字节**） */
export interface DecodedPayload {
  /** 解码后的文本（失败时为 null） */
  text: string | null;
  /** 实际采用的编码（失败时为 null） */
  encoding: DecodeEncoding | null;
  /** 是否解码成功 */
  ok: boolean;
  /** 失败时的错误码（成功时为 null） */
  error_code: string | null;
  /** 失败时的中文说明（成功时为 null） */
  message: string | null;
  /** 原始字节（失败时原样返回，便于人工核对；成功时也是原样返回） */
  raw: Uint8Array;
  /** 试过的编码顺序 */
  attempted: DecodeEncoding[];
}

const decoderCache = new Map<DecodeEncoding, TextDecoder>();

function fatalDecoder(encoding: DecodeEncoding): TextDecoder {
  const cached = decoderCache.get(encoding);
  if (cached) return cached;
  // fatal = true：解不出的字节序列直接抛错，**不替换、不丢**
  const decoder = new TextDecoder(encoding, { fatal: true });
  decoderCache.set(encoding, decoder);
  return decoder;
}

/** CJK 统一表意文字 / 扩展 A / 兼容表意 / CJK 标点 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x3000 && cp <= 0x303f)
  );
}

/**
 * 「解错了」的典型字符区：希腊 / 西里尔 / 希伯来 / 阿拉伯 / 私用区。
 *
 * 院内耗材主数据与计费报文里几乎不会出现这些字符 —— 它们是「把 GBK 当 UTF-8」
 * 或「把 UTF-8 当 GBK」解错之后的产物。出现得多 = 这份字节不是按这个编码写的。
 */
function isMojibakeProneCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0370 && cp <= 0x03ff) ||
    (cp >= 0x0400 && cp <= 0x04ff) ||
    (cp >= 0x0590 && cp <= 0x05ff) ||
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0700 && cp <= 0x074f) ||
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    cp === 0xfffd
  );
}

/**
 * 候选文本的可读性评分（越高越像「院内的中文业务数据」）。
 *
 * 口径（三条，可解释、可复核）：
 *   ① 中文字符越多越像正文本（每个 +2）；
 *   ② 「解错了」的字符区越少越像正文本（每个 −4）；
 *   ③ 其余非 ASCII 字符轻微扣分（每个 −1）。
 *
 * 纯 ASCII 数据两种编码结果一样（评分都是 0），不影响选择。
 */
export function scoreDecodedText(text: string): number {
  let cjk = 0;
  let mojibake = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) {
      cjk += 1;
      continue;
    }
    if (isMojibakeProneCodePoint(cp)) {
      mojibake += 1;
      continue;
    }
    if (cp < 0x80) continue; // ASCII 正常字符
    other += 1;
  }
  if (cjk === 0 && mojibake === 0) return 0;
  return cjk * 2 - mojibake * 4 - other;
}

export interface DecodeOptions {
  /** 编码策略（默认 auto：按可读性择优） */
  strategy?: EncodingStrategy;
}

/**
 * 按可配策略解码一段字节：先试 UTF-8，再试 GBK，都不行就**保留原始字节**报错。
 *
 * 为什么不能简单「UTF-8 解不出来就当 GBK」：
 *   GBK 的字节流**有可能**恰好是合法的 UTF-8（例如「中文」两字在 GBK 里是
 *   D6 D0 CE C4，UTF-8 严格解码不报错，但解出来是希腊字母与希伯来字母）。
 *   这种「解得出来但解错了」最危险 —— 乱码被当成真数据一路流到计费侧。
 *   所以本实现对两个候选**都做评分**：中文多、解错字符少的那个才被选中；
 *   分数打平时以 UTF-8 为准（它是接口与 JSON 的标准编码）。
 *
 * @param bytes 原始字节
 * @param options 编码策略
 */
export function decodeWithFallback(
  bytes: Uint8Array | ArrayBuffer,
  options: DecodeOptions = {},
): DecodedPayload {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const strategy = options.strategy ?? 'auto';
  const attempted: DecodeEncoding[] =
    strategy === 'auto' ? [...DEFAULT_DECODE_ENCODINGS] : [strategy];

  const candidates: Array<{ encoding: DecodeEncoding; text: string; score: number }> = [];
  for (const encoding of attempted) {
    try {
      const text = fatalDecoder(encoding).decode(raw);
      candidates.push({ encoding, text, score: scoreDecodedText(text) });
    } catch {
      // 这一种编码解不动 —— 试下一种；都不行就在下面统一报错
    }
  }

  if (candidates.length === 0) {
    return {
      text: null,
      encoding: null,
      ok: false,
      error_code: SANITIZE_ERROR_CODES.encodingUndecodable,
      message: `字节流既不是合法的 UTF-8 也不是合法的 GBK（已保留原始字节，共 ${raw.length} 字节）`,
      raw,
      attempted,
    };
  }

  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      text: only.text,
      encoding: only.encoding,
      ok: true,
      error_code: null,
      message: null,
      raw,
      attempted,
    };
  }

  // 两个候选都能解：按评分择优；打平时以先试的 UTF-8 为准
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const best = sorted[0]!;
  const runnerUp = sorted[1]!;
  const winner = best.score > runnerUp.score ? best : candidates[0]!;

  return {
    text: winner.text,
    encoding: winner.encoding,
    ok: true,
    error_code: null,
    message: null,
    raw,
    attempted,
  };
}

/** 解码失败时抛的异常（带错误码 + 原始字节） */
export class PayloadDecodeError extends Error {
  readonly code = SANITIZE_ERROR_CODES.encodingUndecodable;
  readonly raw: Uint8Array;
  readonly attempted: readonly DecodeEncoding[];

  constructor(result: DecodedPayload) {
    super(result.message ?? '载荷编码不可解码');
    this.name = 'PayloadDecodeError';
    this.raw = result.raw;
    this.attempted = result.attempted;
  }
}

/* ── 字符归一 ────────────────────────────────────────────────────────────── */

/** 归一动作的类型 */
export type NormalizationKind =
  | 'fullwidth_to_halfwidth'
  | 'strip_invisible'
  | 'collapse_whitespace';

/** 一项归一动作（留痕用） */
export interface NormalizationAction {
  kind: NormalizationKind;
  /** 中文说明（给科室与信息科看） */
  detail_zh: string;
  /** 发生次数 */
  count: number;
}

/** 归一结果（含归一前后对照） */
export interface TextNormalization {
  /** 归一后的文本 */
  text: string;
  /** 归一前的文本 */
  before: string;
  /** 是否发生了变化 */
  changed: boolean;
  /** 逐项动作留痕 */
  actions: NormalizationAction[];
}

/** 不可见字符：控制字符（制表 / 换行除外）、零宽字符、BOM、软连字符 */
function isInvisibleCodePoint(cp: number): boolean {
  if (cp === 0x09) return false; // 制表符当空白处理，不当不可见字符
  if (cp >= 0x00 && cp <= 0x1f) return true; // C0 控制字符
  if (cp === 0x7f) return true; // DEL
  if (cp >= 0x80 && cp <= 0x9f) return true; // C1 控制字符
  if (cp >= 0x200b && cp <= 0x200f) return true; // 零宽空格 ~ 从右至左标记
  if (cp === 0x2060) return true; // 单词连接符
  if (cp === 0x2028 || cp === 0x2029) return true; // 行 / 段分隔符
  if (cp === 0xfeff) return true; // BOM / 零宽不换行空格
  if (cp === 0x00ad) return true; // 软连字符
  return false;
}

/**
 * 字符归一：全角转半角 + 去不可见字符 + 折叠连续空白。
 *
 * 三步各自留痕（`actions`），归一前后对照（`before` / `text`）一并带出 ——
 * 台账里存的就是这份对照，事后能回答「这一笔发出去之前被改过哪里」。
 *
 * **不做**的事：不改大小写、不动中文用字、不删合法标点 ——
 * 归一只解决「同一样东西的两种写法」，不替人改内容。
 */
export function normalizeText(value: string): TextNormalization {
  const before = value;
  let text = '';
  let fullwidth = 0;
  let stripped = 0;

  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisibleCodePoint(cp)) {
      stripped += 1;
      continue;
    }
    if (cp === 0x3000) {
      // 表意文字空格（全角空格）→ 半角空格
      fullwidth += 1;
      text += ' ';
      continue;
    }
    if (cp >= 0xff01 && cp <= 0xff5e) {
      // 全角 ASCII 区（！～）→ 半角
      fullwidth += 1;
      text += String.fromCharCode(cp - 0xfee0);
      continue;
    }
    if (cp === 0x00a0) {
      // 不换行空格 → 半角空格
      text += ' ';
      continue;
    }
    text += ch;
  }

  const collapsed = text.replace(/[ \t]+/g, ' ').trim();
  const whitespaceChanges = collapsed.length !== text.length ? 1 : 0;

  const actions: NormalizationAction[] = [];
  if (fullwidth > 0) {
    actions.push({
      kind: 'fullwidth_to_halfwidth',
      detail_zh: `全角字符转半角 ${fullwidth} 处`,
      count: fullwidth,
    });
  }
  if (stripped > 0) {
    actions.push({
      kind: 'strip_invisible',
      detail_zh: `去不可见 / 零宽字符 ${stripped} 处`,
      count: stripped,
    });
  }
  if (whitespaceChanges > 0) {
    actions.push({
      kind: 'collapse_whitespace',
      detail_zh: '折叠连续空白并去首尾空白',
      count: whitespaceChanges,
    });
  }

  return { text: collapsed, before, changed: collapsed !== before, actions };
}

/* ── 出站字段清洗 ────────────────────────────────────────────────────────── */

/** 可清洗的出站明细字段（与出站规范逐字一致） */
export interface SanitizableUse {
  material_code: string;
  quantity: number;
  price_code: string;
  use_time: string;
  fee_category: string;
  medical_insurance_class: string;
  idempotency_key?: string | null;
  key_profile?: string | null;
}

/** 一条清洗问题（**不抛异常**，交给上层逐条处置） */
export interface SanitizeIssue {
  /** 明细下标（请求级字段为 -1） */
  index: number;
  /** 耗材码（请求级字段为空串） */
  material_code: string;
  /** 字段名 */
  field: string;
  /** 错误码 */
  error_code: string;
  /** 中文说明 */
  message: string;
}

/** 单个字段的归一前后对照 */
export interface SanitizeFieldTrace {
  field: string;
  /** 原值 */
  before: string;
  /** 实际采用的值（身份性字段 = 原值；描述性字段 = 归一后的值） */
  after: string;
  /** 归一后的值（身份性字段被拒时，这里告诉人「规范写法应该是什么」） */
  normalized: string;
  changed: boolean;
  /** 归一动作的类型清单 */
  actions: NormalizationKind[];
}

/** 一条明细的归一前后对照（落台账用） */
export interface SanitizeTrace {
  /** 逐字段对照 */
  fields: SanitizeFieldTrace[];
  /** 整体是否发生变化 */
  changed: boolean;
}

/** 清洗一条明细的结果 */
export interface SanitizedUse {
  /** 清洗后的明细（字段名不变） */
  use: SanitizableUse;
  /** 清洗中发现的问题（必填缺失等） */
  issues: SanitizeIssue[];
  /** 归一前后对照 */
  trace: SanitizeTrace;
}

/** 明细级必填字段（缺任一即拒该条；**不填默认值**） */
export const REQUIRED_USE_FIELDS = [
  'material_code',
  'price_code',
  'fee_category',
  'medical_insurance_class',
] as const;

/** 请求级必填字段（缺任一即整批发不出去；**不填默认值**） */
export const REQUIRED_ENVELOPE_FIELDS = ['operation_no', 'dept_code'] as const;

/**
 * 参与归一的明细字段。
 *
 * **幂等键不参与归一** —— 键是去重的身份，改一个字节就是另一把键，
 * 对端会把同一笔认成两笔（或者认不认得）。键必须逐字原样透传。
 */
const NORMALIZED_USE_FIELDS = [
  'material_code',
  'price_code',
  'fee_category',
  'medical_insurance_class',
] as const;

/**
 * **身份性字段**：归一后如果变了，就等于「变成了另一个码 / 另一个价码」。
 *
 * 这类字段不改写、不照发 —— 本地拒收并转人工（改主数据）。
 * 理由与「截断后照发」同源：截断的耗材码是另一个耗材，
 * 归一后的价码是另一个价目 —— 照发出去就是**记错账**，
 * 而且事后对账时台账与计费侧对不上，还说不清是哪一步改的。
 *
 * 描述性字段（费用类别 / 医保分类）不受此限：它们是口径标签，
 * 里面的零宽字符与全角括号属于同义写法，归一后语义不变。
 */
export const IDENTITY_USE_FIELDS = ['material_code', 'price_code'] as const;

/**
 * 清洗一条出站明细：归一 → 判空 → 留痕。
 *
 * 顺序是刻意的：**先归一再判空** —— 全是零宽字符的耗材码归一后就是空串，
 * 那是「空值」；反过来先判空会把「看起来有值、其实是空壳」的字段放过去。
 *
 * @param use 出站明细
 * @param index 明细下标（写进问题清单，便于指认是哪一条）
 */
export function sanitizeMaterialUse(use: SanitizableUse, index = 0): SanitizedUse {
  const issues: SanitizeIssue[] = [];
  const fields: SanitizeFieldTrace[] = [];
  const sanitized: Record<string, unknown> = { ...use };

  const materialCode = typeof use?.material_code === 'string' ? use.material_code : '';
  for (const field of NORMALIZED_USE_FIELDS) {
    const raw = typeof use?.[field] === 'string' ? (use[field] as string) : '';
    const normalized = normalizeText(raw);
    const isIdentity = (IDENTITY_USE_FIELDS as readonly string[]).includes(field);
    if (isIdentity) {
      // 身份性字段：只在**归一不会改写它**时照原值发；改了就是另一个码 → 拒
      sanitized[field] = raw;
      if (normalized.changed) {
        issues.push({
          index,
          material_code: materialCode,
          field,
          error_code: SANITIZE_ERROR_CODES.codeNotCanonical,
          message: `出站计费字段 uses[${index}].${field} 含非规范写法（归一后会变成「${normalized.text}」，是另一个码），不静默改写`,
        });
      }
    } else {
      sanitized[field] = normalized.text;
    }
    fields.push({
      field,
      before: normalized.before,
      after: isIdentity ? raw : normalized.text,
      normalized: normalized.text,
      changed: normalized.changed,
      actions: normalized.actions.map((action) => action.kind),
    });
  }

  for (const field of REQUIRED_USE_FIELDS) {
    const value = sanitized[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      issues.push({
        index,
        material_code: materialCode,
        field,
        error_code: SANITIZE_ERROR_CODES.fieldMissing,
        message: `出站计费字段 uses[${index}].${field} 为空`,
      });
    }
  }

  // 数量为「空」（非数值 / NaN）同样按必填缺失拒掉；非正整数留给载荷校验那一档
  const quantity = use?.quantity;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    issues.push({
      index,
      material_code: materialCode,
      field: 'quantity',
      error_code: SANITIZE_ERROR_CODES.fieldMissing,
      message: `出站计费字段 uses[${index}].quantity 为空`,
    });
  }

  return {
    use: sanitized as unknown as SanitizableUse,
    issues,
    trace: { fields, changed: fields.some((field) => field.changed) },
  };
}

/** 清洗请求级字段（台次号 / 科室编码）的结果 */
export interface SanitizedEnvelope {
  operation_no: string;
  dept_code: string;
  issues: SanitizeIssue[];
  trace: SanitizeTrace;
}

/**
 * 清洗请求级字段：归一 + 判空。
 *
 * 请求级字段为空 → **整批发不出去**（抬头定的是这批记到哪台手术，
 * 没有「缺抬头也能发」的说法），由上层整批本地拒收。
 */
export function sanitizeEnvelope(operation_no: string, dept_code: string): SanitizedEnvelope {
  const issues: SanitizeIssue[] = [];
  const fields: SanitizeFieldTrace[] = [];
  const values: Record<string, string> = {};

  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    const source = field === 'operation_no' ? operation_no : dept_code;
    const normalized = normalizeText(typeof source === 'string' ? source : '');
    // 台次号 / 科室编码同样是**身份性字段**：归一会把它变成另一个台次 / 另一个科室，
    // 照发就是把这笔计费记到别的地方去 —— 不静默改写，本地拒收转人工。
    values[field] = normalized.text;
    fields.push({
      field,
      before: normalized.before,
      after: normalized.text,
      normalized: normalized.text,
      changed: normalized.changed,
      actions: normalized.actions.map((action) => action.kind),
    });
    if (normalized.text.trim().length === 0) {
      issues.push({
        index: -1,
        material_code: '',
        field,
        error_code: SANITIZE_ERROR_CODES.fieldMissing,
        message: `出站计费请求字段 ${field} 为空`,
      });
      continue;
    }
    if (normalized.changed) {
      issues.push({
        index: -1,
        material_code: '',
        field,
        error_code: SANITIZE_ERROR_CODES.codeNotCanonical,
        message: `出站计费请求字段 ${field} 含非规范写法（归一后会变成「${normalized.text}」，是另一个台次 / 科室），不静默改写`,
      });
    }
  }

  return {
    operation_no: values['operation_no'] ?? '',
    dept_code: values['dept_code'] ?? '',
    issues,
    trace: { fields, changed: fields.some((field) => field.changed) },
  };
}

/** 把归一前后对照渲染成 JSON（落台账 / 落审计链用） */
export function renderSanitizeTrace(trace: SanitizeTrace): string {
  return JSON.stringify({
    changed: trace.changed,
    fields: trace.fields.map((field) => ({
      field: field.field,
      before: field.before,
      after: field.after,
      normalized: field.normalized,
      changed: field.changed,
      actions: field.actions,
    })),
  });
}
