/**
 * 耗材码三层校验：结构 → 字典映射 → 业务。
 *
 * 口径来源（spec.md「领域资产对照」）：编码校验方法沿用 `domain/dictionaries/医保编码规则_ICD与药品.md` §5 的
 * **三层校验**（结构 → 字典映射 → 业务）。三层逐层短路，每层给出**独立** reason_code：
 *   结构层不过 → 不查主数据；字典层不过 → 不做业务判定。
 *
 * **耗材码的编码结构不在 domain 资产内**，因此结构层只做可判定的四件事，**不虚构编码位数**：
 *   ① 非空  ② 字符集（只允许字母 / 数字 / `.` `_` `-`）  ③ 长度上限  ④ 形态识别
 * 形态识别只分两类：14 位纯数字 = GS1 DI（GTIN-14）；其余按院内自编码形态判定。
 *
 * 业务层只判「这条耗材现在能不能用」（启用状态 + 费用类别 + 医保分类口径齐不齐），
 * **不做任何医学判断、不改主数据**。
 */

import type { DatabaseSync } from 'node:sqlite';

import { MAX_CODE_LENGTH, type CodeForm } from '../domain/scan-event.js';
import {
  checkGtin,
  parseCode,
  REASON_CODE_DI_MISSING,
  REASON_CODE_GTIN_CHECK_DIGIT_INVALID,
  type ParsedCode,
} from '../ingest/codes.js';
import { findMaterial, type MaterialRow } from '../ledger/binding-repo.js';
import { checkFeeCategoryPolicy, REASON_FEE_CATEGORY_NOT_ALLOWED } from './fee-category.js';
import {
  evaluateUnitMapping,
  REASON_UNIT_MAPPING_INCONSISTENT,
  REASON_UNIT_RATIO_MISSING,
  REASON_UNIT_RATIO_INVALID,
  REASON_UNIT_UNIT_MISSING,
} from './units.js';

/** 校验层 */
export type ValidationLayer = 'structure' | 'dictionary' | 'business';

export const LAYER_LABELS: Record<ValidationLayer, string> = {
  structure: '结构层',
  dictionary: '字典映射层',
  business: '业务层',
};

/* ── 结构层原因码 ── */
export const REASON_CODE_EMPTY = 'CODE_EMPTY';
export const REASON_CODE_TOO_LONG = 'CODE_TOO_LONG';
export const REASON_CODE_ILLEGAL_CHARSET = 'CODE_ILLEGAL_CHARSET';
export const REASON_CODE_FORM_UNRECOGNIZED = 'CODE_FORM_UNRECOGNIZED';
/** GTIN 校验位不符（条码本身有问题，**独立于「耗材未建档」**） */
export const REASON_CODE_GTIN_CHECK = REASON_CODE_GTIN_CHECK_DIGIT_INVALID;
/** GS1 码制里取不到器械标识 DI */
export const REASON_CODE_DI_MISSING_CODE = REASON_CODE_DI_MISSING;

/* ── 字典映射层原因码 ── */
export const REASON_MATERIAL_NOT_REGISTERED = 'MATERIAL_NOT_REGISTERED';

/* ── 业务层原因码 ── */
export const REASON_MATERIAL_INACTIVE = 'MATERIAL_INACTIVE';
export const REASON_FEE_CATEGORY_MISSING = 'FEE_CATEGORY_MISSING';
export const REASON_INSURANCE_CLASS_MISSING = 'INSURANCE_CLASS_MISSING';
/** 费用 / 医保口径类原因码（业务层：费用类别允许集、医保分类取值、组合矩阵、耗材适用类） */
export {
  REASON_FEE_CATEGORY_NOT_ALLOWED,
  REASON_FEE_CATEGORY_NOT_CONSUMABLE,
  REASON_FEE_CATEGORY_INSURANCE_MISMATCH,
  REASON_INSURANCE_CLASS_INVALID,
} from './fee-category.js';
/** 单位口径类原因码（业务层：包装 / 最小 / 计价单位与换算系数齐不齐、对不对得上） */
export {
  REASON_UNIT_MAPPING_INCONSISTENT,
  REASON_UNIT_RATIO_MISSING,
  REASON_UNIT_RATIO_INVALID,
  REASON_UNIT_UNIT_MISSING,
};

/** 耗材码允许的字符集：字母、数字与 `.` `_` `-`（分隔符） */
export const ALLOWED_CODE_CHARSET = /^[A-Za-z0-9._-]+$/;
/** GTIN-14（GS1 应用标识符 01 的数据位） */
export const GTIN14_PATTERN = /^\d{14}$/;
/** 院内自编码形态：首字符为字母或数字，其后可含分隔符 */
export const INTERNAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 归一后耗材码的形态 */
export type CanonicalForm = 'GTIN14' | 'INTERNAL';

export interface LayerIssue {
  /** 出问题的层 */
  layer: ValidationLayer;
  /** 该层独立的原因码 */
  reason_code: string;
  /** 中文说明 */
  message: string;
}

export interface CodeValidation {
  /** 三层是否全部通过 */
  ok: boolean;
  /** 参与校验的耗材码（去空白） */
  code: string;
  /** 归一后码的形态 */
  canonical_form: CanonicalForm | null;
  /** 设备原始码的码制（UDI / GS1_AI01 / INTERNAL），未提供原始码时为 null */
  raw_code_form: CodeForm | null;
  /** 第一个未通过的层（全部通过时为 null） */
  failed_layer: ValidationLayer | null;
  /** 第一个未通过层的原因码 */
  reason_code: string | null;
  /** 第一个未通过层的中文说明 */
  message: string | null;
  /** 逐层问题清单 */
  issues: LayerIssue[];
  /** 字典映射层命中的耗材主数据（未命中时为 null） */
  material: MaterialRow | null;
}

export interface StructureResult {
  ok: boolean;
  canonical_form: CanonicalForm | null;
  issues: LayerIssue[];
}

/**
 * 结构层：非空 → 长度上限 → 字符集 → 形态识别。
 * 只回答「这个码长得像不像一个可查的耗材码」，不查主数据。
 */
export function validateCodeStructure(code: unknown): StructureResult {
  const issues: LayerIssue[] = [];
  const raw = typeof code === 'string' ? code : '';
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    issues.push({
      layer: 'structure',
      reason_code: REASON_CODE_EMPTY,
      message: '耗材码为空',
    });
    return { ok: false, canonical_form: null, issues };
  }

  if (trimmed.length > MAX_CODE_LENGTH) {
    issues.push({
      layer: 'structure',
      reason_code: REASON_CODE_TOO_LONG,
      message: `耗材码长度 ${trimmed.length} 超过上限 ${MAX_CODE_LENGTH}`,
    });
    return { ok: false, canonical_form: null, issues };
  }

  if (!ALLOWED_CODE_CHARSET.test(trimmed)) {
    issues.push({
      layer: 'structure',
      reason_code: REASON_CODE_ILLEGAL_CHARSET,
      message: '耗材码含非法字符（只允许字母、数字与 . _ -）',
    });
    return { ok: false, canonical_form: null, issues };
  }

  // 形态识别：14 位纯数字 = GS1 DI；其余按院内码判定
  if (GTIN14_PATTERN.test(trimmed)) {
    return { ok: true, canonical_form: 'GTIN14', issues };
  }
  if (/^\d+$/.test(trimmed)) {
    issues.push({
      layer: 'structure',
      reason_code: REASON_CODE_FORM_UNRECOGNIZED,
      message: `纯数字耗材码长度为 ${trimmed.length}，不是 14 位 GTIN，无法识别形态`,
    });
    return { ok: false, canonical_form: null, issues };
  }
  if (!INTERNAL_CODE_PATTERN.test(trimmed)) {
    issues.push({
      layer: 'structure',
      reason_code: REASON_CODE_FORM_UNRECOGNIZED,
      message: '院内耗材码形态非法（首字符必须是字母或数字）',
    });
    return { ok: false, canonical_form: null, issues };
  }

  return { ok: true, canonical_form: 'INTERNAL', issues };
}

/**
 * 码制层问题（结构层的一个子集）：码制判定 + GTIN 校验位。
 *
 * 只对 **GS1 族**（UDI / GS1 AI(01)）生效：
 *   ① GS1 码里取不到器械标识（DI）→ 定位不到主数据键，判结构层问题；
 *   ② DI 的 GTIN 校验位不符 → **条码本身有问题**（可能扫坏、可能根本不是耗材码），
 *      给**独立原因码**，**不与「耗材未建档」混同** ——
 *      「码坏了」要重扫 / 换标签，「没建档」要补档案，处置动作完全不同。
 *
 * 院内码（INTERNAL）不走 GS1 规则，**不做校验位判定** ——
 * 院内自编码的末位不一定是 GS1 校验位，拿 GS1 的尺子量院内码会误伤。
 */
function codeFormIssues(parsed: ParsedCode | undefined): LayerIssue[] {
  if (!parsed) return [];
  if (parsed.code_form === 'INTERNAL') return [];

  const issues: LayerIssue[] = [];
  if (!parsed.di) {
    issues.push({
      layer: 'structure',
      reason_code: REASON_CODE_DI_MISSING,
      message: `GS1 码制里取不到器械标识（DI）：${parsed.raw_code}`,
    });
    return issues;
  }
  if (parsed.gtin && !parsed.gtin.valid) {
    issues.push({
      layer: 'structure',
      reason_code: REASON_CODE_GTIN_CHECK_DIGIT_INVALID,
      message:
        `GTIN-${parsed.gtin.length} 校验位不符（期望 ${parsed.gtin.expected_check_digit}，实际 ${parsed.gtin.actual_check_digit}）：` +
        '条码本身有问题（可能扫坏或不是耗材码），不是「耗材未建档」',
    });
  }
  return issues;
}

/**
 * 耗材码三层校验。
 *
 * @param db        台账连接（字典映射层查院内耗材主数据）
 * @param code      归一后的耗材码
 * @param options.raw_code 设备上报的原始码（用于记录码制与码制层校验）
 * @param options.parsed   已解析好的码（调用方已解析过就不重复解析）
 */
export function validateMaterialCode(
  db: DatabaseSync,
  code: string,
  options: { raw_code?: string | null; parsed?: ParsedCode | null } = {},
): CodeValidation {
  const raw = typeof code === 'string' ? code : '';
  const trimmed = raw.trim();
  const rawCode = options.raw_code ?? null;
  const parsed =
    options.parsed ?? (rawCode && rawCode.trim().length > 0 ? parseCode(rawCode) : undefined);
  const raw_code_form = parsed ? parsed.code_form : null;

  // 归一结果接入字典映射层：主数据键以**归一后的规范码**为准
  const lookupCode =
    parsed && parsed.canonical_code.length > 0 ? parsed.canonical_code : trimmed;

  // ── 结构层（形态）+ 码制层（码制判定与校验位）
  const structure = validateCodeStructure(trimmed);
  const codeIssues = codeFormIssues(parsed);
  // 码制层的问题（取不到 DI / 校验位不符）比通用字符集问题更具体，排在前面
  const issues: LayerIssue[] = [...codeIssues, ...structure.issues];
  if (!structure.ok || codeIssues.length > 0) {
    const first = issues[0] as LayerIssue;
    return {
      ok: false,
      code: lookupCode,
      canonical_form: structure.canonical_form,
      raw_code_form,
      failed_layer: 'structure',
      reason_code: first.reason_code,
      message: first.message,
      issues,
      material: null,
    };
  }

  // ── 字典映射层：查院内耗材主数据
  const material = findMaterial(db, lookupCode);
  if (!material) {
    // 这个键看起来是 GTIN 却查不到：先看是不是**条码本身坏了** ——
    // 校验位不对要给独立错误码，不能混进「耗材未建档」里（处置动作不同）
    const gtin = checkGtin(lookupCode);
    if (gtin && !gtin.valid) {
      issues.push({
        layer: 'structure',
        reason_code: REASON_CODE_GTIN_CHECK_DIGIT_INVALID,
        message:
          `GTIN-${gtin.length} 校验位不符（期望 ${gtin.expected_check_digit}，实际 ${gtin.actual_check_digit}）：` +
          '条码本身有问题（可能扫坏或不是耗材码），不是「耗材未建档」',
      });
      const first = issues[0] as LayerIssue;
      return {
        ok: false,
        code: lookupCode,
        canonical_form: structure.canonical_form,
        raw_code_form,
        failed_layer: 'structure',
        reason_code: first.reason_code,
        message: first.message,
        issues,
        material: null,
      };
    }
    issues.push({
      layer: 'dictionary',
      reason_code: REASON_MATERIAL_NOT_REGISTERED,
      message: `耗材码 ${lookupCode} 不在院内耗材主数据中`,
    });
    const first = issues[0] as LayerIssue;
    return {
      ok: false,
      code: lookupCode,
      canonical_form: structure.canonical_form,
      raw_code_form,
      failed_layer: 'dictionary',
      reason_code: first.reason_code,
      message: first.message,
      issues,
      material: null,
    };
  }

  // ── 业务层：这条耗材现在能不能用
  const business: LayerIssue[] = [];
  if (!material.active) {
    business.push({
      layer: 'business',
      reason_code: REASON_MATERIAL_INACTIVE,
      message: `耗材 ${material.material_code} 已停用`,
    });
  }
  if (material.fee_category.trim().length === 0) {
    business.push({
      layer: 'business',
      reason_code: REASON_FEE_CATEGORY_MISSING,
      message: `耗材 ${material.material_code} 未登记费用类别`,
    });
  }
  if (material.medical_insurance_class.trim().length === 0) {
    business.push({
      layer: 'business',
      reason_code: REASON_INSURANCE_CLASS_MISSING,
      message: `耗材 ${material.material_code} 未登记医保分类`,
    });
  }
  // 费用类别与医保分类的口径校验（14 类允许集 / 医保分类取值 / 组合矩阵 / 耗材只落材料类）。
  // 口径不合规的耗材**算不出可对账的计费口径** —— 宁可转人工，也不按错口径计费。
  const feeVerdict = checkFeeCategoryPolicy({
    fee_category: material.fee_category,
    medical_insurance_class: material.medical_insurance_class,
  });
  if (!feeVerdict.ok) {
    business.push({
      layer: 'business',
      reason_code: feeVerdict.reason_code ?? REASON_FEE_CATEGORY_NOT_ALLOWED,
      message: `耗材 ${material.material_code} 费用口径不合规：${feeVerdict.message ?? ''}`,
    });
  }
  // 单位口径：包装 / 最小 / 计价单位与换算系数齐不齐、对不对得上。
  // 口径不自洽的耗材**算不出计价数量** —— 宁可转人工，也不按猜的系数计费。
  const unitVerdict = evaluateUnitMapping(material);
  if (!unitVerdict.ok) {
    business.push({
      layer: 'business',
      reason_code: unitVerdict.reason_code ?? REASON_UNIT_MAPPING_INCONSISTENT,
      message: `耗材 ${material.material_code} 单位口径不可用：${unitVerdict.message ?? ''}`,
    });
  }
  if (business.length > 0) {
    issues.push(...business);
    const first = business[0] as LayerIssue;
    return {
      ok: false,
      code: lookupCode,
      canonical_form: structure.canonical_form,
      raw_code_form,
      failed_layer: 'business',
      reason_code: first.reason_code,
      message: first.message,
      issues,
      material,
    };
  }

  return {
    ok: true,
    code: lookupCode,
    canonical_form: structure.canonical_form,
    raw_code_form,
    failed_layer: null,
    reason_code: null,
    message: null,
    issues,
    material,
  };
}
