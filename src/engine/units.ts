/**
 * 数量与计价单位换算：扫码计数单位 → 计价单位。
 *
 * 为什么这是核心模块：同一类耗材主数据上常挂着三层单位口径 ——
 *   扫码计数单位（包 / 盒 / 支）—— 设备扫的那个包装，扫一次记一个；
 *   最小单位（支 / 根 / 枚）—— 拆零后手术台上真正用的东西；
 *   计价单位（支 / 套 / 包）—— HIS 计费按什么单位收钱。
 * 扫码事件给的是**扫码计数单位的个数**，HIS 计费要的是**计价单位的个数**。
 * 换算错一个数量就是一次错账 —— 多算一倍是浪费耗材，少算一半是科室自己贴钱。
 *
 * 三条口径，缺一不可：
 *
 *   ① **换算系数是正数** —— `ratio` 的含义是「1 个扫码计数单位 = ratio 个计价单位」。
 *      它可以是整数（1 包 = 5 支 → 5），也可以是分数（2 支 = 1 包 → 0.5，
 *      因为这时计费单位比扫码单位粗）。但它必须**大于 0**；写成 0、负数或非数值
 *      是主数据录错 —— 这类主数据在**导入时**就进待补录清单。
 *
 *   ② **换算结果必须是整数且为正** —— 扫码数量可能是拆零用的分数包装（0.5 包），
 *      换算后如果不是整数（0.5 包 × 5 = 2.5 支）就说明**口径对不上**：
 *      要么包装规格录错了，要么这次上报的数量不对。**一律判异常转人工**，
 *      **不做四舍五入、不做静默取整** —— 宁可让人来看一眼，也不要悄悄算错账。
 *
 *   ③ **换算关系自洽** —— `unit_pack` / `unit_min` / `charge_unit` 三个单位名与
 *      `ratio` 要对得上：
 *        - ratio = 1 → 计价单位只能是扫码计数单位或最小单位（两者指同一物）；
 *        - 计价单位 = 扫码计数单位 → ratio 必须是 1（按包装计价就是按包装数计）；
 *        - 计价单位 = 最小单位 → ratio 不能小于 1（一个包装最少含一个最小单位）。
 *      对不上 → 判异常，**绝不猜**。
 *
 * 换算轨迹（原始数量 / 包装单位 / 系数 / 计价数量）随台账行一起落库 ——
 * 关台核对与月度对账时要能回答「这一笔到底按几支算的、凭什么」。
 */

/** 换算原因码（业务层，与错误码表一一对应） */
export const REASON_UNIT_RATIO_MISSING = 'UNIT_RATIO_MISSING';
export const REASON_UNIT_RATIO_INVALID = 'UNIT_RATIO_INVALID';
export const REASON_UNIT_MAPPING_INCONSISTENT = 'UNIT_MAPPING_INCONSISTENT';
export const REASON_UNIT_UNIT_MISSING = 'UNIT_UNIT_MISSING';
export const REASON_UNIT_QUANTITY_NOT_INTEGER = 'QUANTITY_NOT_DIVISIBLE';
export const REASON_UNIT_QUANTITY_NOT_POSITIVE = 'UNIT_QUANTITY_NOT_POSITIVE';

/**
 * 单位口径的缺口类型集合（主数据待补录清单按类型归组销项时用）。
 *
 * `UNIT_RATIO_ASSUMED` 是老库升级时按 1:1 假定补齐留下的那条 ——
 * 它也是单位口径的一条缺口，补录了真实包装规格后同样要销项。
 */
export const UNIT_GAP_TYPES: readonly string[] = [
  REASON_UNIT_UNIT_MISSING,
  REASON_UNIT_RATIO_MISSING,
  REASON_UNIT_RATIO_INVALID,
  REASON_UNIT_MAPPING_INCONSISTENT,
  'UNIT_RATIO_ASSUMED',
];

/**
 * 耗材主数据上的单位口径（四列）。
 *
 * 字段名与院内耗材主数据导入表逐字一致（`unit_pack` / `unit_min` / `charge_unit` / `ratio`）。
 */
export interface UnitMapping {
  /** 扫码计数单位（设备扫的那个包装单位，如「包」；拆零扫单件时填最小单位） */
  unit_pack: string | null;
  /** 最小单位（拆零后的最小可计数单位，如「支」） */
  unit_min: string | null;
  /** 计价单位（HIS 计费的单位，如「支」「套」） */
  charge_unit: string | null;
  /** 换算系数：1 个扫码计数单位 = ratio 个计价单位 */
  ratio: number | null;
}

/** 换算轨迹（落台账，事后可核对「这一笔按几支算的」） */
export interface QuantityTrace {
  /** 耗材码 */
  material_code: string;
  /** 原始数量（扫码计数单位的个数，设备上报的那个数） */
  raw_quantity: number;
  /** 扫码计数单位 */
  pack_unit: string;
  /** 换算系数 */
  ratio: number;
  /** 计价单位 */
  charge_unit: string;
  /** 计价数量（换算结果；异常时为 null） */
  charge_quantity: number | null;
}

/** 换算结果 */
export interface QuantityConversion {
  /** 是否换算成功 */
  ok: boolean;
  /** 原因码（成功时为 null） */
  reason_code: string | null;
  /** 中文说明（成功时为 null） */
  message: string | null;
  /** 换算轨迹（成功与失败都有，失败时 charge_quantity 为 null） */
  trace: QuantityTrace;
}

/** 单位口径自洽性判定结果 */
export interface UnitMappingVerdict {
  ok: boolean;
  reason_code: string | null;
  message: string | null;
}

/** 浮点比较容差：换算结果是否整数的判定用它，避免 0.1+0.2 这类二进制误差误伤 */
const EPSILON = 1e-9;

function trimUnit(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 判定「除不尽」用的整数检查：容差内视为整数。
 *
 * 不用 `Number.isInteger` —— 0.1 × 10 在二进制浮点下是 0.9999999999999999，
 * 直接判会误伤合法的换算结果。
 */
export function isIntegralQuantity(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return Math.abs(value - Math.round(value)) < EPSILON;
}

/**
 * 单位口径自洽性判定（**只判主数据，不碰业务状态**）。
 *
 * 判定顺序（逐层短路，先给最具体的原因码）：
 *   ① 三个单位名缺一           → UNIT_UNIT_MISSING
 *   ② ratio 缺失               → UNIT_RATIO_MISSING
 *   ③ ratio 不是正数           → UNIT_RATIO_INVALID
 *   ④ ratio 与三个单位名不自洽 → UNIT_MAPPING_INCONSISTENT
 */
export function evaluateUnitMapping(mapping: UnitMapping): UnitMappingVerdict {
  const pack = trimUnit(mapping.unit_pack);
  const min = trimUnit(mapping.unit_min);
  const charge = trimUnit(mapping.charge_unit);

  if (pack.length === 0 || min.length === 0 || charge.length === 0) {
    const missing = [
      pack.length === 0 ? '扫码计数单位(unit_pack)' : null,
      min.length === 0 ? '最小单位(unit_min)' : null,
      charge.length === 0 ? '计价单位(charge_unit)' : null,
    ]
      .filter((item): item is string => item !== null)
      .join('、');
    return {
      ok: false,
      reason_code: REASON_UNIT_UNIT_MISSING,
      message: `耗材单位口径缺项：${missing}`,
    };
  }

  const ratio = mapping.ratio;
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return {
      ok: false,
      reason_code: REASON_UNIT_RATIO_MISSING,
      message: `耗材单位口径缺换算系数：1 个${pack}折算成多少个${charge}未登记`,
    };
  }
  if (ratio <= 0) {
    return {
      ok: false,
      reason_code: REASON_UNIT_RATIO_INVALID,
      message: `换算系数 ${ratio} 不是正数（1 个${pack}至少折成 1 个${charge}）`,
    };
  }

  if (isIntegralQuantity(ratio) && Math.round(ratio) === 1) {
    // 包装即计价：计价单位只能是扫码计数单位或最小单位（两者指同一物）
    if (charge !== pack && charge !== min) {
      return {
        ok: false,
        reason_code: REASON_UNIT_MAPPING_INCONSISTENT,
        message: `换算系数为 1 时计价单位只能是扫码计数单位（${pack}）或最小单位（${min}），当前为 ${charge}`,
      };
    }
  } else {
    if (charge === pack) {
      // 按包装计价：系数只能是 1
      return {
        ok: false,
        reason_code: REASON_UNIT_MAPPING_INCONSISTENT,
        message: `计价单位就是扫码计数单位（${pack}）时换算系数只能是 1，当前为 ${ratio}`,
      };
    }
    if (charge === min && ratio < 1) {
      // 按最小单位计价：一个包装最少含一个最小单位
      return {
        ok: false,
        reason_code: REASON_UNIT_MAPPING_INCONSISTENT,
        message: `按最小单位（${min}）计价时，换算系数不能小于 1，当前为 ${ratio}`,
      };
    }
  }

  return { ok: true, reason_code: null, message: null };
}

/**
 * 数量换算：扫码计数单位的个数 → 计价单位的个数。
 *
 * 判定顺序：
 *   ① 数量不是正数（零 / 负数 / 非数值） → UNIT_QUANTITY_NOT_POSITIVE
 *   ② 单位口径不自洽（缺 ratio / 系数非正 / 口径对不上） → 各自的独立原因码
 *   ③ 换算结果不是整数（除不尽）        → QUANTITY_NOT_DIVISIBLE
 *   ④ 换算结果不是正数                   → UNIT_QUANTITY_NOT_POSITIVE
 *
 * **不做四舍五入、不做静默取整** —— 换算不出来的量交给人看，不替人做决定。
 *
 * @param quantity 扫码上报的原始数量（扫码计数单位的个数）
 * @param material 耗材主数据上的单位口径四列
 * @param material_code 耗材码（写进换算轨迹）
 */
export function convertQuantity(
  quantity: number,
  material: UnitMapping,
  material_code = '',
): QuantityConversion {
  const pack = trimUnit(material.unit_pack);
  const charge = trimUnit(material.charge_unit);
  const ratio = material.ratio;

  const trace: QuantityTrace = {
    material_code,
    raw_quantity: quantity,
    pack_unit: pack,
    ratio: typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 0,
    charge_unit: charge,
    charge_quantity: null,
  };

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return {
      ok: false,
      reason_code: REASON_UNIT_QUANTITY_NOT_POSITIVE,
      message: `扫码数量 ${quantity} 不是正数，不换算、不计费`,
      trace,
    };
  }

  const verdict = evaluateUnitMapping(material);
  if (!verdict.ok) {
    return {
      ok: false,
      reason_code: verdict.reason_code,
      message: verdict.message,
      trace,
    };
  }

  const effectiveRatio = material.ratio as number;
  const chargeQuantity = quantity * effectiveRatio;

  if (!isIntegralQuantity(chargeQuantity)) {
    return {
      ok: false,
      reason_code: REASON_UNIT_QUANTITY_NOT_INTEGER,
      message:
        `数量换算不整：${quantity} ${pack} × ${effectiveRatio} = ${chargeQuantity} ${charge}，` +
        '除不尽，不四舍五入、不静默取整，转人工核对包装规格',
      trace,
    };
  }

  const integral = Math.round(chargeQuantity);
  if (integral <= 0) {
    return {
      ok: false,
      reason_code: REASON_UNIT_QUANTITY_NOT_POSITIVE,
      message: `换算后的计价数量 ${integral} 不是正数，不换算、不计费`,
      trace,
    };
  }

  trace.ratio = effectiveRatio;
  trace.charge_quantity = integral;

  return {
    ok: true,
    reason_code: null,
    message: null,
    trace,
  };
}

/** 换算轨迹落库用的 JSON 字符串（异常时也留轨迹，便于事后看清当时算的是什么） */
export function serializeQuantityTrace(trace: QuantityTrace): string {
  return JSON.stringify(trace);
}
