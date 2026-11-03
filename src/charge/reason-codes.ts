/**
 * 计费回执 reason_code 全集与「可重投 / 不可重投 / 需人工」三档处置判定表。
 *
 * 为什么必须有这张表：
 *   HIS 计费侧回执里带回来的 `reason_code` 决定这条耗材**要不要重投、重投有没有意义**。
 *   同一个「对端拒收」，有的过十分钟自己就好了（限流、库存临时锁），
 *   有的是主数据没配好（价码不存在、医保分类对不上），重投一万次也是拒收。
 *   处置错了有两个后果：
 *     - 把可重投的当不可重投 → 一台手术的耗材全压成人工待办，护士长被淹没；
 *     - 把不可重投的当可重投 → 退避队列空转，重投次数刷高，计费侧日志被刷屏。
 *   所以这张表把每个码**钉死**到一档，代码里不再出现「看情况」。
 *
 * 三档口径：
 *   RETRYABLE    —— 对端暂时收不了 / 收得慢；进指数退避队列，重投有意义；
 *   NOT_RETRYABLE —— 对端明确不收（主数据、权限、台次、库存口径问题）；
 *                    **立即**转核查任务，不做无谓重试；
 *   NEEDS_HUMAN  —— 对端要求人来判断（医保规则冲突、特殊耗材审批、疑似重复计费）；
 *                    转核查任务并标注，等护士长 / 医保办 / 收费员落定结论。
 *
 * 未知码口径（fail safe）：
 *   没登记过的码一律落 **NEEDS_HUMAN**，并且**不默认当作可重投** ——
 *   对本侧没读懂的东西，重投是最坏的选择（可能造成对端重复记账）。
 *   同时把原始码记进审计链与错误码表待补项，等信息科与对端确认口径后补登记。
 *
 * 本模块**不依赖任何其他模块**：它是「对端说了什么 → 我们怎么办」的唯一真源，
 * 被回执层（`receipt.ts`）、重投层（`retry.ts`）、回写层（`writeback.ts`）共用。
 */

/** 三档处置 */
export const RECEIPT_DISPOSITIONS = {
  /** 可重投：进指数退避队列 */
  RETRYABLE: 'RETRYABLE',
  /** 不可重投：立即转核查任务，不做无谓重试 */
  NOT_RETRYABLE: 'NOT_RETRYABLE',
  /** 需人工判断：转核查任务并标注，等人工落定 */
  NEEDS_HUMAN: 'NEEDS_HUMAN',
} as const;

export type ReceiptDisposition = (typeof RECEIPT_DISPOSITIONS)[keyof typeof RECEIPT_DISPOSITIONS];

/** 档位的中文标签（给核查清单与错误码表看） */
export const RECEIPT_DISPOSITION_LABELS: Readonly<Record<ReceiptDisposition, string>> = {
  RETRYABLE: '可重投',
  NOT_RETRYABLE: '不可重投',
  NEEDS_HUMAN: '需人工',
};

/**
 * 码的来源。
 *
 *   peer —— HIS 计费侧回执里带回来的业务码（本项目与对端的约定契约，
 *           端点与字段见 `docs/api/his-charging.md`）；
 *   local —— 本侧协议类码（对端回执缺条目、回执整体为空），不是对端给的业务码，
 *           但同样要决定「重投还是转人工」。
 */
export type ReceiptReasonOrigin = 'peer' | 'local';

/** 判定表的一行 */
export interface ReceiptReasonEntry {
  /** 码（对端给的业务码，或本侧协议码） */
  code: string;
  /** 中文含义 */
  meaning_zh: string;
  /** 处置档位 */
  disposition: ReceiptDisposition;
  /** 建议处置（给信息科 / 耗材管理岗的一句话动作） */
  action_zh: string;
  /** 统一错误码（ERR_*；与日志、核查条目、回执行展示同一个码） */
  error_code: string;
  /** 是否常见（院内日常能撞上的） */
  common: boolean;
  /** 码的来源 */
  origin: ReceiptReasonOrigin;
}

/** 未知对端码的统一错误码 */
export const UNKNOWN_RECEIPT_REASON_ERROR_CODE = 'ERR_CHARGE_REASON_UNKNOWN';

/** 对端回执整体为空时用的本侧协议码 */
export const REASON_EMPTY_RECEIPT = 'EMPTY_RECEIPT';

/** 对端回执缺这一条耗材结论时用的本侧协议码 */
export const REASON_MISSING_RECEIPT = 'MISSING_RECEIPT';

/**
 * 回执码 → 三档处置判定表（唯一真源）。
 *
 * 分档依据一句话：**同样的报文再发一次，对端会不会给出不同结论？**
 *   会  → 可重投（限流 / 服务繁忙 / 临时库存锁）；
 *   不会，但人要判断 → 需人工（医保规则冲突 / 特殊耗材审批 / 疑似重复计费）；
 *   不会，改了主数据才会变 → 不可重投（价码不存在 / 医保分类不匹配 / 库存不足）。
 */
export const RECEIPT_REASON_CODES: readonly ReceiptReasonEntry[] = [
  /* ── 可重投：对端暂时收不了 ─────────────────────────────────────────── */
  {
    code: 'PEER_RATE_LIMITED',
    meaning_zh: '对端计费侧限流（同一时刻提交过多）',
    disposition: RECEIPT_DISPOSITIONS.RETRYABLE,
    action_zh: '已进退避重投队列；核对单批提交条数与投递频率，必要时调小批次上限',
    error_code: 'ERR_CHARGE_RATE_LIMITED',
    common: true,
    origin: 'peer',
  },
  {
    code: 'PEER_SERVICE_BUSY',
    meaning_zh: '对端计费服务繁忙（临时不可用）',
    disposition: RECEIPT_DISPOSITIONS.RETRYABLE,
    action_zh: '已进退避重投队列；持续出现时找 HIS 计费侧查该时段的服务负载',
    error_code: 'ERR_CHARGE_SERVICE_BUSY',
    common: true,
    origin: 'peer',
  },
  {
    code: 'PEER_UPSTREAM_TIMEOUT',
    meaning_zh: '对端内部调用计费上游超时（对端自己没等到）',
    disposition: RECEIPT_DISPOSITIONS.RETRYABLE,
    action_zh: '已进退避重投队列；对端多半已收到但没记账，重投由幂等键去重',
    error_code: 'ERR_CHARGE_PEER_TIMEOUT',
    common: false,
    origin: 'peer',
  },
  {
    code: 'PEER_STOCK_LOCKED',
    meaning_zh: '耗材库存临时锁定（出入库作业占用中）',
    disposition: RECEIPT_DISPOSITIONS.RETRYABLE,
    action_zh: '已进退避重投队列；核对出入库作业时段，避开锁定期再重投',
    error_code: 'ERR_CHARGE_STOCK_LOCKED',
    common: false,
    origin: 'peer',
  },

  /* ── 不可重投：对端明确不收（改主数据才会变） ───────────────────────── */
  {
    code: 'PRICE_CODE_NOT_FOUND',
    meaning_zh: '价码在计费侧不存在（耗材主数据的价码没同步过去）',
    disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
    action_zh: '由高值耗材管理岗核对耗材主数据的价码并同步给 HIS 计费侧，修正后由人工重投',
    error_code: 'ERR_CHARGE_PRICE_CODE_NOT_FOUND',
    common: true,
    origin: 'peer',
  },
  {
    code: 'MATERIAL_NOT_CHARGEABLE',
    meaning_zh: '耗材在计费侧未建档（可计费耗材目录里查不到）',
    disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
    action_zh: '核对该耗材是否已在 HIS 计费侧建档；本系统只报不建，不代建档',
    error_code: 'ERR_CHARGE_MATERIAL_NOT_CHARGEABLE',
    common: true,
    origin: 'peer',
  },
  {
    code: 'INSURANCE_CLASS_MISMATCH',
    meaning_zh: '医保分类与计费侧目录不一致（甲 / 乙 / 丙类对不上）',
    disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
    action_zh: '核对耗材主数据的医保分类与 HIS 计费侧目录口径是否同一套',
    error_code: 'ERR_CHARGE_INSURANCE_CLASS_MISMATCH',
    common: true,
    origin: 'peer',
  },
  {
    code: 'FEE_CATEGORY_MISMATCH',
    meaning_zh: '费用类别与计费侧归类口径不一致（收费项目归类对不上）',
    disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
    action_zh: '核对费用类别（院内 14 类口径）与计费侧归类，口径见 docs/api/fee-category.md',
    error_code: 'ERR_CHARGE_FEE_CATEGORY_MISMATCH',
    common: false,
    origin: 'peer',
  },
  {
    code: 'QUANTITY_EXCEEDED',
    meaning_zh: '数量超出计费侧上限（单次或本台次累计消耗超限）',
    disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
    action_zh: '核对换算后的计价数量与耗材主数据的单次上限；不截断后照发',
    error_code: 'ERR_CHARGE_QUANTITY_EXCEEDED',
    common: false,
    origin: 'peer',
  },
  {
    code: 'QUANTITY_NOT_POSITIVE',
    meaning_zh: '数量不是正数（计费侧拒收零数或负数）',
    disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
    action_zh: '核对扫码枪上报的数量与包装换算关系；不取整、不截断',
    error_code: 'ERR_CHARGE_QUANTITY_INVALID',
    common: false,
    origin: 'peer',
  },
  {
    code: 'INSUFFICIENT_STOCK',
    meaning_zh: '高值耗材库存不足（计费侧按库存扣减，账上不够）',
    disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
    action_zh: '核对该耗材的库存与出库单；补货或退库后由人工重投',
    error_code: 'ERR_CHARGE_INSUFFICIENT_STOCK',
    common: true,
    origin: 'peer',
  },
  {
    code: 'PEER_OPERATION_NOT_FOUND',
    meaning_zh: '计费侧查不到这个台次（手术排台没同步过去）',
    disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
    action_zh: '核对手术排台是否已同步到 HIS 计费侧；补同步后由人工重投',
    error_code: 'ERR_CHARGE_OPERATION_NOT_FOUND',
    common: false,
    origin: 'peer',
  },
  {
    code: 'PEER_OPERATION_CLOSED',
    meaning_zh: '计费侧台次已关台（不再接受该台次的计费）',
    disposition: RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
    action_zh: '走院内人工计费补录流程；本系统不自动补录、不自动冲正',
    error_code: 'ERR_CHARGE_OPERATION_CLOSED',
    common: false,
    origin: 'peer',
  },

  /* ── 需人工：对端要求人判断 ─────────────────────────────────────────── */
  {
    code: 'INSURANCE_RULE_CONFLICT',
    meaning_zh: '医保规则冲突（该耗材的支付条件与结算规则冲突）',
    disposition: RECEIPT_DISPOSITIONS.NEEDS_HUMAN,
    action_zh: '转医保办核对结算规则与目录冲突后人工落定；系统不代判医保口径',
    error_code: 'ERR_CHARGE_INSURANCE_RULE_CONFLICT',
    common: false,
    origin: 'peer',
  },
  {
    code: 'SPECIAL_MATERIAL_APPROVAL',
    meaning_zh: '特殊耗材需审批（高值耗材要先走院内审批才能计费）',
    disposition: RECEIPT_DISPOSITIONS.NEEDS_HUMAN,
    action_zh: '转高值耗材管理岗走院内审批流程，审批通过后由人工重投',
    error_code: 'ERR_CHARGE_SPECIAL_MATERIAL_APPROVAL',
    common: false,
    origin: 'peer',
  },
  {
    code: 'OPERATOR_NOT_AUTHORIZED',
    meaning_zh: '收费员权限不足（该台次不在本账号的授权范围）',
    disposition: RECEIPT_DISPOSITIONS.NEEDS_HUMAN,
    action_zh: '核对出站账号的科室授权范围；授权补齐后由人工重投',
    error_code: 'ERR_CHARGE_OPERATOR_NOT_AUTHORIZED',
    common: false,
    origin: 'peer',
  },
  {
    code: 'MANUAL_CHARGE_REQUIRED',
    meaning_zh: '对端要求人工补录（对端明确说这条要人来处理）',
    disposition: RECEIPT_DISPOSITIONS.NEEDS_HUMAN,
    action_zh: '按对端提示在 HIS 侧人工补录；本系统只报不代补录',
    error_code: 'ERR_CHARGE_MANUAL_REQUIRED',
    common: false,
    origin: 'peer',
  },
  {
    code: 'DUPLICATE_CHARGE',
    meaning_zh: '对端判本笔为重复计费（同一台次同一耗材已记过）',
    disposition: RECEIPT_DISPOSITIONS.NEEDS_HUMAN,
    action_zh: '核对是否确为重复；若确已计费则人工闭环，系统不自动冲正',
    error_code: 'ERR_CHARGE_DUPLICATE_ON_PEER',
    common: false,
    origin: 'peer',
  },
  {
    code: 'IDEMPOTENCY_KEY_CONFLICT',
    meaning_zh: '幂等键冲突（对端见过这把键，但内容与本次不同）',
    disposition: RECEIPT_DISPOSITIONS.NEEDS_HUMAN,
    action_zh: '核对台账行的幂等键与对端已记的那笔；由信息科与对端确认后人工处理',
    error_code: 'ERR_CHARGE_IDEMPOTENCY_KEY_CONFLICT',
    common: false,
    origin: 'peer',
  },

  /* ── 本侧协议码：对端没把这一条说清楚 ───────────────────────────────── */
  {
    code: REASON_MISSING_RECEIPT,
    meaning_zh: '对端回执里缺这一条耗材的结论（对端只回了一部分）',
    disposition: RECEIPT_DISPOSITIONS.RETRYABLE,
    action_zh: '按「协议不符」进退避重投队列；核对对端是否截断了条目',
    error_code: 'ERR_MISSING_RECEIPT',
    common: true,
    origin: 'local',
  },
  {
    code: REASON_EMPTY_RECEIPT,
    meaning_zh: '对端回执整体为空（一条结论都没给）',
    disposition: RECEIPT_DISPOSITIONS.RETRYABLE,
    action_zh: '按「通道不可达」进退避重投队列；核对对端接口版本与该时段的可用性',
    error_code: 'ERR_CHARGE_EMPTY_RECEIPT',
    common: false,
    origin: 'local',
  },
];

/** 码 → 表项 的索引 */
export const RECEIPT_REASON_MAP: ReadonlyMap<string, ReceiptReasonEntry> = new Map(
  RECEIPT_REASON_CODES.map((entry) => [entry.code, entry]),
);

/** 这个码在判定表里吗 */
export function isKnownReceiptReason(code: string | null | undefined): boolean {
  return typeof code === 'string' && RECEIPT_REASON_MAP.has(code);
}

/** 判定表全量（按档位、再按码排序；给文档与 doctor 展示用） */
export function listReceiptReasonCodes(): readonly ReceiptReasonEntry[] {
  return [...RECEIPT_REASON_CODES].sort(
    (a, b) =>
      a.disposition.localeCompare(b.disposition) || a.code.localeCompare(b.code),
  );
}

/** 取某个档位的全部码 */
export function receiptReasonsByDisposition(disposition: ReceiptDisposition): ReceiptReasonEntry[] {
  return RECEIPT_REASON_CODES.filter((entry) => entry.disposition === disposition);
}

/** 一个码的处置判定结论 */
export interface ReceiptReasonDecision {
  /** 原始码（未登记时原样返回，供审计链留痕） */
  code: string;
  /** 这个码在判定表里吗 */
  known: boolean;
  /** 处置档位 */
  disposition: ReceiptDisposition;
  /** 统一错误码 */
  error_code: string;
  /** 中文含义 */
  meaning_zh: string;
  /** 建议处置 */
  action_zh: string;
  /** 值不值得重投（只 RETRYABLE 档为 true） */
  retryable: boolean;
  /** 是否需要人工介入（NOT_RETRYABLE / NEEDS_HUMAN 两档为 true） */
  needs_manual: boolean;
}

/**
 * 查一个回执码的处置判定。
 *
 * **未知码 = 需人工 + 不可重投**（fail safe）：
 * 对本侧没读懂的码重投，可能在对端造成重复记账 —— 那比多一条人工待办危险得多。
 */
export function disposeReceiptReason(code: string | null | undefined): ReceiptReasonDecision {
  const raw = typeof code === 'string' ? code.trim() : '';
  const entry = RECEIPT_REASON_MAP.get(raw);
  if (entry) {
    return {
      code: entry.code,
      known: true,
      disposition: entry.disposition,
      error_code: entry.error_code,
      meaning_zh: entry.meaning_zh,
      action_zh: entry.action_zh,
      retryable: entry.disposition === RECEIPT_DISPOSITIONS.RETRYABLE,
      needs_manual: entry.disposition !== RECEIPT_DISPOSITIONS.RETRYABLE,
    };
  }
  const shown = raw.length > 0 ? raw : '(空码)';
  return {
    code: raw,
    known: false,
    disposition: RECEIPT_DISPOSITIONS.NEEDS_HUMAN,
    error_code: UNKNOWN_RECEIPT_REASON_ERROR_CODE,
    meaning_zh: `未登记的对端回执码（${shown}）`,
    action_zh:
      '按「未知码不默认当作可重投」处理：转人工核查并把该码登记进错误码表待补项，' +
      '等与 HIS 计费侧确认口径后补登记',
    retryable: false,
    needs_manual: true,
  };
}
