/**
 * 费用类别与医保分类口径校验。
 *
 * 为什么这是核心模块：耗材计费单上的「费用类别」与「医保分类」不是随手填的 ——
 * 它决定**住院收费票据的分区**、**医保结算清单的分区**，以及事后对账时两边能不能勾上。
 * 口径填错，当时看不出毛病，关台对账时才发现 HIS 那边进了另一个分区，
 * 返工的是收费员与耗材管理岗，病人还得跑一趟收费窗口。
 *
 * 口径来源（domain 资产 `dictionaries/医保结算清单字段规范.md` §医疗收费信息）：
 *   「与医疗住院收费票据口径一致：结算期间、金额合计、甲乙类/自费/其他、
 *     14 类费用（床位/诊察/检查/化验/治疗/手术/护理/卫生材料/西药/中药饮片/
 *     中成药/一般诊疗/挂号/其他）、医保统筹基金支付等」
 *   —— 14 类费用类别与甲乙丙三类医保分类都出自这一条。
 *
 * 本模块只做**口径一致性校验**：
 *   - **不做任何医学判断**（不判断这个耗材该不该用、用几支）；
 *   - **不改主数据**（主数据是院内权威，导入器不替耗材管理岗改行）；
 *   - **不改业务状态**（不合规只给结论，不自动关台、不自动冲正）。
 *
 * 四条判定规则（逐层短路，先给最具体的原因码）：
 *   ① 费用类别必须落在院内 **14 类允许集**内           → FEE_CATEGORY_NOT_ALLOWED
 *   ② 医保分类必须是 **甲类 / 乙类 / 丙类** 之一        → INSURANCE_CLASS_INVALID
 *   ③ 组合必须落在「费用类别 → 允许医保分类」矩阵内     → FEE_CATEGORY_INSURANCE_MISMATCH
 *   ④ **耗材只允许落在「卫生材料」类**                  → FEE_CATEGORY_NOT_CONSUMABLE
 *
 * 关于第 ③ 条（矩阵）：
 *   甲类 = 纳入医保支付范围、全额支付；乙类 = 纳入医保支付范围、部分先行自付；
 *   丙类 = **不纳入**医保支付范围（全自费）。在医保结算清单口径下，
 *   不纳入支付范围的费用按「自费」列示、**不带甲乙丙分类**；
 *   而床位 / 诊察 / 检查 / 化验 / 治疗 / 手术 / 护理 / 一般诊疗 / 挂号
 *   这些**基本诊疗与床位项目在医保目录内**，只能是甲类或乙类 ——
 *   把它们写成丙类在结算清单口径下不自洽，判错配。
 *
 *   耗材（卫生材料）与药品（西药 / 中药饮片 / 中成药）三类都允许：
 *   高值耗材里甲类、乙类、丙类（全自费）三种都真实存在。
 *
 *   **口径说明**：第 ③ 条的矩阵是**本项目采用的口径**（依据写在上面的说明里）。
 *   若院内口径与此不同，改本文件里的 `FEE_CATEGORIES` 矩阵即可 ——
 *   导入期差异清单与运行期绑定校验读的是同一张表，两处同步生效。
 */

/** 医保分类：甲类 / 乙类 / 丙类 */
export const MEDICAL_INSURANCE_CLASSES: readonly string[] = ['甲类', '乙类', '丙类'];

/** 耗材唯一允许落地的费用类别（院内 14 类费用口径中的材料类） */
export const CONSUMABLE_FEE_CATEGORY = '卫生材料';

/** 一个费用类别的口径规则 */
export interface FeeCategory {
  /** 费用类别名称 */
  name: string;
  /** 耗材是否允许落在该类别 */
  consumable_allowed: boolean;
  /** 该类别允许的医保分类（组合矩阵的一行） */
  insurance_classes: readonly string[];
  /** 给耗材管理岗看的一句话说明 */
  note_zh: string;
}

/** 医保分类口径说明（写进文档与核查条目，避免「丙类」被当成随手填的值） */
export const INSURANCE_CLASS_NOTES: Readonly<Record<string, string>> = {
  甲类: '纳入医保支付范围，按规定比例支付（个人不掏）',
  乙类: '纳入医保支付范围，但按规定先行自付一部分',
  丙类: '不纳入医保支付范围，全部由个人支付（自费）',
};

/**
 * 院内 14 类费用口径（与住院收费票据分区一致）。
 *
 * 顺序与 domain 资产里列举的顺序逐字一致，便于与收费票据、结算清单逐行核对。
 */
export const FEE_CATEGORIES: readonly FeeCategory[] = [
  {
    name: '床位',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类'],
    note_zh: '住院床位费：属基本诊疗项目，医保目录内，只能是甲类或乙类',
  },
  {
    name: '诊察',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类'],
    note_zh: '医生查房与诊断费：属基本诊疗项目，医保目录内，只能是甲类或乙类',
  },
  {
    name: '检查',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类'],
    note_zh: '影像与检验检查费：属基本诊疗项目，医保目录内，只能是甲类或乙类',
  },
  {
    name: '化验',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类'],
    note_zh: '实验室检验费：属基本诊疗项目，医保目录内，只能是甲类或乙类',
  },
  {
    name: '治疗',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类'],
    note_zh: '治疗操作费：属基本诊疗项目，医保目录内，只能是甲类或乙类',
  },
  {
    name: '手术',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类'],
    note_zh: '手术费：属基本诊疗项目，医保目录内，只能是甲类或乙类',
  },
  {
    name: '护理',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类'],
    note_zh: '护理费：属基本诊疗项目，医保目录内，只能是甲类或乙类',
  },
  {
    name: '卫生材料',
    consumable_allowed: true,
    insurance_classes: ['甲类', '乙类', '丙类'],
    note_zh: '医用耗材类：耗材唯一允许落地的费用类别；甲类、乙类、丙类（全自费）都真实存在',
  },
  {
    name: '西药',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类', '丙类'],
    note_zh: '西药费：属药品类，耗材不得落在这里',
  },
  {
    name: '中药饮片',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类', '丙类'],
    note_zh: '中药饮片费：属药品类，耗材不得落在这里',
  },
  {
    name: '中成药',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类', '丙类'],
    note_zh: '中成药费：属药品类，耗材不得落在这里',
  },
  {
    name: '一般诊疗',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类'],
    note_zh: '一般诊疗费：属基本诊疗项目，医保目录内，只能是甲类或乙类',
  },
  {
    name: '挂号',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类'],
    note_zh: '挂号费：属基本诊疗项目，医保目录内，只能是甲类或乙类',
  },
  {
    name: '其他',
    consumable_allowed: false,
    insurance_classes: ['甲类', '乙类', '丙类'],
    note_zh: '兜底类：未单列的费用落这里；不纳入医保支付范围的费用也落这里（自费）',
  },
];

/* ── 口径原因码（业务层，与错误码表一一对应） ── */

/** 费用类别不在院内 14 类允许集内 */
export const REASON_FEE_CATEGORY_NOT_ALLOWED = 'FEE_CATEGORY_NOT_ALLOWED';
/** 医保分类取值非法（不是 甲类 / 乙类 / 丙类） */
export const REASON_INSURANCE_CLASS_INVALID = 'INSURANCE_CLASS_INVALID';
/** 费用类别与医保分类的组合错配 */
export const REASON_FEE_CATEGORY_INSURANCE_MISMATCH = 'FEE_CATEGORY_INSURANCE_MISMATCH';
/** 耗材落在了非材料类（药品类 / 诊疗床位类） */
export const REASON_FEE_CATEGORY_NOT_CONSUMABLE = 'FEE_CATEGORY_NOT_CONSUMABLE';

/** 费用口径的缺口类型集合（主数据待补录清单按类型归组销项时用） */
export const FEE_CATEGORY_GAP_TYPES: readonly string[] = [
  REASON_FEE_CATEGORY_NOT_ALLOWED,
  REASON_INSURANCE_CLASS_INVALID,
  REASON_FEE_CATEGORY_INSURANCE_MISMATCH,
  REASON_FEE_CATEGORY_NOT_CONSUMABLE,
];

/** 口径问题类型 */
export type FeeCategoryIssue =
  | 'fee_category_not_allowed'
  | 'insurance_class_invalid'
  | 'fee_category_insurance_mismatch'
  | 'fee_category_not_consumable';

/** 口径判定结果 */
export interface FeeCategoryVerdict {
  /** 是否合规 */
  ok: boolean;
  /** 原因码（合规时为 null） */
  reason_code: string | null;
  /** 中文说明（合规时为 null） */
  message: string | null;
  /** 命中的口径问题类型（合规时为 null） */
  issue: FeeCategoryIssue | null;
  /** 该费用类别的允许医保分类（类别不在允许集时为 null） */
  allowed_insurance_classes: readonly string[] | null;
}

function trim(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 按名称查费用类别口径（不在允许集内返回 undefined） */
export function findFeeCategory(name: string | null | undefined): FeeCategory | undefined {
  const key = trim(name);
  if (key.length === 0) return undefined;
  return FEE_CATEGORIES.find((entry) => entry.name === key);
}

/** 费用类别是否落在院内 14 类允许集内 */
export function isAllowedFeeCategory(name: string | null | undefined): boolean {
  return findFeeCategory(name) !== undefined;
}

/** 该费用类别是否允许耗材落地 */
export function isConsumableFeeCategory(name: string | null | undefined): boolean {
  return findFeeCategory(name)?.consumable_allowed === true;
}

/** 医保分类取值是否合法（甲类 / 乙类 / 丙类） */
export function isValidInsuranceClass(value: string | null | undefined): boolean {
  return MEDICAL_INSURANCE_CLASSES.includes(trim(value));
}

/** 该费用类别允许的医保分类（类别不在允许集内返回 null） */
export function allowedInsuranceClasses(
  feeCategory: string | null | undefined,
): readonly string[] | null {
  return findFeeCategory(feeCategory)?.insurance_classes ?? null;
}

/**
 * 费用类别与医保分类的口径校验。
 *
 * 判定顺序逐层短路（先给最具体的原因码）：
 *   ① 费用类别不在 14 类允许集内  → FEE_CATEGORY_NOT_ALLOWED
 *   ② 医保分类取值非法            → INSURANCE_CLASS_INVALID
 *   ③ 组合不在矩阵内              → FEE_CATEGORY_INSURANCE_MISMATCH
 *   ④ 耗材落在非材料类            → FEE_CATEGORY_NOT_CONSUMABLE
 *
 * @param input.fee_category            主数据上的费用类别
 * @param input.medical_insurance_class 主数据上的医保分类
 */
export function checkFeeCategoryPolicy(input: {
  fee_category: string | null | undefined;
  medical_insurance_class: string | null | undefined;
}): FeeCategoryVerdict {
  const feeCategory = trim(input.fee_category);
  const insuranceClass = trim(input.medical_insurance_class);

  // ① 费用类别必须在院内 14 类允许集内
  const rule = findFeeCategory(feeCategory);
  if (!rule) {
    return {
      ok: false,
      reason_code: REASON_FEE_CATEGORY_NOT_ALLOWED,
      message:
        feeCategory.length === 0
          ? '费用类别为空：须落在院内 14 类费用口径内'
          : `费用类别「${feeCategory}」不在院内 14 类费用口径内（允许集：${FEE_CATEGORIES.map((c) => c.name).join(' / ')}）`,
      issue: 'fee_category_not_allowed',
      allowed_insurance_classes: null,
    };
  }

  // ② 医保分类取值必须合法
  if (!isValidInsuranceClass(insuranceClass)) {
    return {
      ok: false,
      reason_code: REASON_INSURANCE_CLASS_INVALID,
      message: `医保分类「${insuranceClass}」取值非法，只接受 ${MEDICAL_INSURANCE_CLASSES.join(' / ')}`,
      issue: 'insurance_class_invalid',
      allowed_insurance_classes: rule.insurance_classes,
    };
  }

  // ③ 组合必须落在矩阵内
  if (!rule.insurance_classes.includes(insuranceClass)) {
    return {
      ok: false,
      reason_code: REASON_FEE_CATEGORY_INSURANCE_MISMATCH,
      message:
        `费用类别「${rule.name}」与医保分类「${insuranceClass}」组合错配：` +
        `该类别只允许 ${rule.insurance_classes.join(' / ')}（${rule.note_zh}）`,
      issue: 'fee_category_insurance_mismatch',
      allowed_insurance_classes: rule.insurance_classes,
    };
  }

  // ④ 耗材只允许落在材料类
  if (!rule.consumable_allowed) {
    return {
      ok: false,
      reason_code: REASON_FEE_CATEGORY_NOT_CONSUMABLE,
      message:
        `耗材不得落在费用类别「${rule.name}」：耗材只允许落在「${CONSUMABLE_FEE_CATEGORY}」类` +
        `（${rule.note_zh}）`,
      issue: 'fee_category_not_consumable',
      allowed_insurance_classes: rule.insurance_classes,
    };
  }

  return {
    ok: true,
    reason_code: null,
    message: null,
    issue: null,
    allowed_insurance_classes: rule.insurance_classes,
  };
}
