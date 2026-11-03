/**
 * 核查任务的责任岗位路由、超时提醒与逐级升级。
 *
 * 为什么要有这一层：核查条目建出来只是「有人要管」，**没人管就等于没闭环**。
 * 本模块回答三个问题：
 *   ① 这条异常**该谁管** —— 按异常类型定责任岗位，按台次所属科室定落到哪个科室的岗位；
 *   ② 没人管**怎么催** —— 超时未确认发一次企微提醒（不重复刷屏）；
 *   ③ 催了还没人管**怎么升级** —— 超过时限升到上一级岗位，条目状态仍留在待核查。
 *
 * 岗位口径（院内实际岗位名，不用研发黑话）：
 *   高值耗材管理岗 —— 耗材未建档 / 停用 / 费用与医保口径缺失（补建档后导入即生效）
 *   手术室护士长 —— 台次已关台 / 跨台次重复 / 归属冲突（现场核对是哪台手术）
 *   收费员         —— 计费业务拒绝（价码、库存、重复上报等收费侧问题）
 *   医保办         —— 医保分类与医保口径类拒绝
 *   信息科接口工程师 —— 计费通道不可达（超时 / 5xx / 熔断：那是联调问题，不是业务问题）
 *
 * 三条硬约束：
 *   ① **不自动闭环**：提醒与升级只改责任岗位与处置档位，条目状态始终留在 `check_pending` ——
 *      落定结论只能由人来做（`confirmTask`），系统不代劳、不自动关闭；
 *   ② **不刷屏**：同一条核查条目**只提醒一次**（`reminded_at` 记下就不再推），
 *      重复扫描不重复发；
 *   ③ **处置轨迹可回放**：分派 / 提醒 / 升级三个动作各写一行审计链，
 *      按 task_id 能把「这条异常分给了谁、催过没有、升到哪一级」串成一条线。
 *
 * 与源产品的对应（参考地基见 spec.md → `## 开源对照`）：
 *   源产品按**目标实体**路由批量唯一消息，并**逐条**返回回执
 *   （`UniqueMessage{entity, message_type}` / `SendMessageResponse{receipts}`）；
 *   本模块把「按实体路由」改写成「按异常类型路由到院内岗位」—— 收件人从外部通道换成岗位，
 *   但**逐条处理、逐条留痕、单条失败不影响其余**的语义不变。
 */

import type { DatabaseSync } from 'node:sqlite';

import { appendAudit } from '../ledger/audit.js';
import {
  buildCheckTaskReminderMessage,
  buildEscalationNoticeMessage,
  type WeComBotClient,
} from './notify.js';

/* ── 责任岗位（院内岗位名；升级链里逐字一致） ── */

/** 高值耗材管理岗：耗材主数据类问题（补建档 / 补口径） */
export const ROLE_MATERIAL_MANAGER = '高值耗材管理岗';
/** 手术室护士长：台次、归属与重复类问题（现场核对） */
export const ROLE_OR_NURSE_MANAGER = '手术室护士长';
/** 收费员：收费侧业务拒绝 */
export const ROLE_CASHIER = '收费员';
/** 医保办：医保分类与医保口径类拒绝 */
export const ROLE_INSURANCE_OFFICE = '医保办';
/** 信息科接口工程师：计费通道与联调类问题 */
export const ROLE_IT_INTERFACE = '信息科接口工程师';

/** 升级链上的上级岗位 */
export const ROLE_MATERIAL_LEAD = '耗材科主任';
export const ROLE_OR_SUPERVISOR = '手术室科护士长';
export const ROLE_CASHIER_LEAD = '收费处主管';
export const ROLE_INSURANCE_LEAD = '医保科主任';
export const ROLE_IT_LEAD = '信息科科长';
export const ROLE_MEDICAL_ADMIN = '医务科';
export const ROLE_FINANCE_LEAD = '财务科主任';

/**
 * 升级链：岗位 → 逐级升级对象。
 *
 * **数组下标 = 处置档位**（`timeout_level`）：0 是本岗位，1 是上一级，2 是再上一级。
 * 末位之后不再往上升（升到医务科 / 财务科主任已经是院级视角，再往上没有处置岗位）。
 *
 * 链上的**每一个岗位**都映射到同一条链：条目升到第 1 档后，责任岗位变成上级，
 * 但它仍然属于原来那条链 —— 查链时按当前岗位查，得到的是同一条链，
 * 于是「再升一级」永远是链上的下一格，不会因为换了岗位就断链。
 */
export const ROLE_ESCALATION_CHAIN: Readonly<Record<string, readonly string[]>> = {
  [ROLE_MATERIAL_MANAGER]: [ROLE_MATERIAL_MANAGER, ROLE_MATERIAL_LEAD, ROLE_MEDICAL_ADMIN],
  [ROLE_MATERIAL_LEAD]: [ROLE_MATERIAL_MANAGER, ROLE_MATERIAL_LEAD, ROLE_MEDICAL_ADMIN],
  [ROLE_OR_NURSE_MANAGER]: [ROLE_OR_NURSE_MANAGER, ROLE_OR_SUPERVISOR, ROLE_MEDICAL_ADMIN],
  [ROLE_OR_SUPERVISOR]: [ROLE_OR_NURSE_MANAGER, ROLE_OR_SUPERVISOR, ROLE_MEDICAL_ADMIN],
  [ROLE_CASHIER]: [ROLE_CASHIER, ROLE_CASHIER_LEAD, ROLE_FINANCE_LEAD],
  [ROLE_CASHIER_LEAD]: [ROLE_CASHIER, ROLE_CASHIER_LEAD, ROLE_FINANCE_LEAD],
  [ROLE_INSURANCE_OFFICE]: [ROLE_INSURANCE_OFFICE, ROLE_INSURANCE_LEAD, ROLE_MEDICAL_ADMIN],
  [ROLE_INSURANCE_LEAD]: [ROLE_INSURANCE_OFFICE, ROLE_INSURANCE_LEAD, ROLE_MEDICAL_ADMIN],
  [ROLE_IT_INTERFACE]: [ROLE_IT_INTERFACE, ROLE_IT_LEAD, ROLE_MEDICAL_ADMIN],
  [ROLE_IT_LEAD]: [ROLE_IT_INTERFACE, ROLE_IT_LEAD, ROLE_MEDICAL_ADMIN],
  [ROLE_MEDICAL_ADMIN]: [ROLE_MATERIAL_MANAGER, ROLE_MATERIAL_LEAD, ROLE_MEDICAL_ADMIN],
  [ROLE_FINANCE_LEAD]: [ROLE_CASHIER, ROLE_CASHIER_LEAD, ROLE_FINANCE_LEAD],
};

/** 责任岗位缺省（没匹配到任何规则时）：按耗材主数据类兜底 */
export const DEFAULT_ROLE = ROLE_MATERIAL_MANAGER;

/**
 * 各岗位的响应时限（毫秒）。
 *
 * 口径：超过该时限仍未确认 → 先提醒一次；再过一个时限 → 升一级。
 * 时限按**岗位实际在班节奏**定：手术室护士长 2 小时（术中与关台当场就要看），
 * 收费员与医保办 8 小时（当日处理完），信息科 4 小时（联调问题不能过夜）。
 */
export const ROLE_RESPONSE_WINDOW_MS: Readonly<Record<string, number>> = {
  [ROLE_OR_NURSE_MANAGER]: 2 * 60 * 60 * 1000,
  [ROLE_OR_SUPERVISOR]: 2 * 60 * 60 * 1000,
  [ROLE_MATERIAL_MANAGER]: 4 * 60 * 60 * 1000,
  [ROLE_MATERIAL_LEAD]: 4 * 60 * 60 * 1000,
  [ROLE_IT_INTERFACE]: 4 * 60 * 60 * 1000,
  [ROLE_IT_LEAD]: 4 * 60 * 60 * 1000,
  [ROLE_CASHIER]: 8 * 60 * 60 * 1000,
  [ROLE_CASHIER_LEAD]: 8 * 60 * 60 * 1000,
  [ROLE_INSURANCE_OFFICE]: 8 * 60 * 60 * 1000,
  [ROLE_INSURANCE_LEAD]: 8 * 60 * 60 * 1000,
  [ROLE_MEDICAL_ADMIN]: 8 * 60 * 60 * 1000,
  [ROLE_FINANCE_LEAD]: 8 * 60 * 60 * 1000,
};

/** 岗位没有登记时限时用的兜底时限（毫秒） */
export const DEFAULT_RESPONSE_WINDOW_MS = 8 * 60 * 60 * 1000;

/* ── 路由表 ── */

/** 一条路由规则：命中后落到哪个岗位、依据是什么 */
interface RouteRule {
  /** 责任岗位（进升级链） */
  readonly role: string;
  /** 分派依据（中文一句话，给岗位看「为什么找你」） */
  readonly basis_zh: string;
}

/**
 * 按**原因码**路由。
 *
 * 原因码比结论细：同样是异常结论，「耗材未建档」与「台次已关台」要找的人完全不同，
 * 所以先按原因码定岗位，结论只作兜底。
 */
const REASON_ROUTES: Readonly<Record<string, RouteRule>> = {
  /* 耗材主数据类 —— 高值耗材管理岗 */
  MATERIAL_NOT_REGISTERED: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材码不在院内耗材主数据里，请高值耗材管理岗补建档（导入即生效，无需重启）',
  },
  MATERIAL_INACTIVE: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材已停用，请高值耗材管理岗确认是停用过期还是误停，并恢复后再扫',
  },
  FEE_CATEGORY_MISSING: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材主数据缺费用类别，请高值耗材管理岗补登记后重新导入',
  },
  INSURANCE_CLASS_MISSING: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材主数据缺医保分类，请高值耗材管理岗补登记后重新导入',
  },
  CODE_EMPTY: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '扫到的耗材码是空的，请高值耗材管理岗核对主数据并检查扫码枪录入',
  },
  CODE_TOO_LONG: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材码超长，请高值耗材管理岗核对主数据码长与设备上报格式',
  },
  CODE_ILLEGAL_CHARSET: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材码含非法字符，请高值耗材管理岗核对主数据与设备上报编码',
  },
  CODE_FORM_UNRECOGNIZED: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材码形态无法识别，请高值耗材管理岗核对主数据码制',
  },
  CODE_GTIN_CHECK_DIGIT_INVALID: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: 'GTIN 校验位不符，请高值耗材管理岗核对主数据条码',
  },
  CODE_DI_MISSING: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: 'UDI 码缺 DI 段，请高值耗材管理岗核对主数据条码',
  },
  QUANTITY_NOT_DIVISIBLE: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '包装数换算不成计价单位数，请高值耗材管理岗核对主数据换算系数',
  },
  QUANTITY_NOT_POSITIVE: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '扫码数量不是正数，请高值耗材管理岗核对主数据与扫码枪计数',
  },
  UNIT_RATIO_MISSING: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '主数据缺包装与计价单位的换算系数，请高值耗材管理岗补录',
  },
  UNIT_RATIO_INVALID: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '主数据换算系数不合法，请高值耗材管理岗补录',
  },

  /* 台次与归属类 —— 手术室护士长 */
  OPERATION_NOT_FOUND: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '这台手术不在排台台次里，请手术室护士长核对台次号与排台',
  },
  OPERATION_CLOSED: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '台次已关台，这条耗材不能自动计费，请手术室护士长确认是否走人工补录',
  },
  CROSS_OP_DUPLICATE_MATERIAL: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '同一耗材已记在另一台次上，请手术室护士长核对到底算在哪台手术',
  },
  OPERATION_ATTRIBUTION_CONFLICT: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '扫码枪登记的手术间与排台对不上，请手术室护士长核对台次（必要时转信息科改扫码枪位置登记）',
  },
  ROOM_MISMATCH: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '批次内手术间与扫码枪登记不一致，请手术室护士长核对台次',
  },
  SCANNER_MISMATCH: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '扫码枪与批次登记不一致，请手术室护士长核对台次与扫码枪',
  },

  /* 医保口径类 —— 医保办 */
  INSURANCE_CLASS_MISMATCH: {
    role: ROLE_INSURANCE_OFFICE,
    basis_zh: '耗材的医保分类与 HIS 计费口径对不上，请医保办核对医保结算口径',
  },
  INSURANCE_RULE_CONFLICT: {
    role: ROLE_INSURANCE_OFFICE,
    basis_zh: '触发了医保规则冲突，请医保办核对医保结算口径',
  },
  SPECIAL_MATERIAL_APPROVAL: {
    role: ROLE_INSURANCE_OFFICE,
    basis_zh: '耗材需要特殊审批才能计费，请医保办核对审批口径',
  },

  /* 收费侧业务拒绝 —— 收费员 */
  PRICE_CODE_NOT_FOUND: {
    role: ROLE_CASHIER,
    basis_zh: '价码在 HIS 侧查不到，请收费员核对价码与计费项目',
  },
  INSUFFICIENT_STOCK: {
    role: ROLE_CASHIER,
    basis_zh: '库存不足，请收费员核对出库与计费口径',
  },
  STOCK_LOCKED: {
    role: ROLE_CASHIER,
    basis_zh: '耗材被锁定，请收费员核对库存锁定原因',
  },
  QUANTITY_EXCEEDED: {
    role: ROLE_CASHIER,
    basis_zh: '计费数量超出 HIS 侧上限，请收费员核对本次用量',
  },
  DUPLICATE_ON_PEER: {
    role: ROLE_CASHIER,
    basis_zh: 'HIS 侧判定这笔已经计过费，请收费员核对是否重复上报',
  },
  MANUAL_REQUIRED: {
    role: ROLE_CASHIER,
    basis_zh: '对端要求人工处理，请收费员在 HIS 侧确认这笔耗材',
  },
  OPERATION_NOT_FOUND_ON_PEER: {
    role: ROLE_CASHIER,
    basis_zh: 'HIS 侧找不到这台手术，请收费员核对台次号',
  },
};

/**
 * 按**统一错误码**路由（原因码缺失时用这个）。
 *
 * 通道类错误（超时 / 5xx / 熔断 / 网络）**不是业务问题**：让收费员去查没用，
 * 该找信息科接口工程师看联调。
 */
const ERROR_CODE_ROUTES: Readonly<Record<string, RouteRule>> = {
  ERR_CHARGE_TIMEOUT: {
    role: ROLE_IT_INTERFACE,
    basis_zh: 'HIS 计费通道响应超时，请信息科接口工程师查通道与对端负载',
  },
  ERR_CHARGE_CONNECT_TIMEOUT: {
    role: ROLE_IT_INTERFACE,
    basis_zh: 'HIS 计费通道连不上，请信息科接口工程师查网络与对端服务',
  },
  ERR_CHARGE_PEER_TIMEOUT: {
    role: ROLE_IT_INTERFACE,
    basis_zh: 'HIS 侧处理超时，请信息科接口工程师与对端排查',
  },
  ERR_CHARGE_CIRCUIT_OPEN: {
    role: ROLE_IT_INTERFACE,
    basis_zh: '计费通道已熔断，请信息科接口工程师处理对端故障',
  },
  ERR_CHARGE_NETWORK: {
    role: ROLE_IT_INTERFACE,
    basis_zh: '计费通道连接失败，请信息科接口工程师查网络',
  },
  ERR_CHARGE_HTTP_5XX: {
    role: ROLE_IT_INTERFACE,
    basis_zh: 'HIS 计费接口返回 5xx，请信息科接口工程师与对端排查',
  },
  ERR_CHARGE_RESPONSE_INVALID: {
    role: ROLE_IT_INTERFACE,
    basis_zh: 'HIS 计费接口回执结构不符，请信息科接口工程师核联调文档',
  },
  ERR_CHARGE_CONFIG: {
    role: ROLE_IT_INTERFACE,
    basis_zh: '计费通道配置缺失，请信息科接口工程师核对环境变量',
  },
  ERR_CHARGE_INTERNAL: {
    role: ROLE_IT_INTERFACE,
    basis_zh: '计费回写内部异常，请信息科接口工程师查日志',
  },
  ERR_CHARGE_BUSINESS_REJECTED: {
    role: ROLE_CASHIER,
    basis_zh: 'HIS 计费业务拒绝，请收费员核对价码、库存与医保口径',
  },
  ERR_CHARGE_PRICE_CODE_NOT_FOUND: {
    role: ROLE_CASHIER,
    basis_zh: '价码在 HIS 侧查不到，请收费员核对价码与计费项目',
  },
  ERR_CHARGE_INSURANCE_RULE_CONFLICT: {
    role: ROLE_INSURANCE_OFFICE,
    basis_zh: '触发了医保规则冲突，请医保办核对医保结算口径',
  },
  ERR_CHARGE_INSURANCE_CLASS_MISMATCH: {
    role: ROLE_INSURANCE_OFFICE,
    basis_zh: '耗材医保分类与 HIS 口径对不上，请医保办核对',
  },
  ERR_CHARGE_SPECIAL_MATERIAL_APPROVAL: {
    role: ROLE_INSURANCE_OFFICE,
    basis_zh: '耗材需要特殊审批才能计费，请医保办核对审批口径',
  },
  ERR_CHARGE_INSUFFICIENT_STOCK: {
    role: ROLE_CASHIER,
    basis_zh: '库存不足，请收费员核对出库与计费口径',
  },
  ERR_CHARGE_STOCK_LOCKED: {
    role: ROLE_CASHIER,
    basis_zh: '耗材被锁定，请收费员核对库存锁定原因',
  },
  ERR_CHARGE_QUANTITY_EXCEEDED: {
    role: ROLE_CASHIER,
    basis_zh: '计费数量超出 HIS 侧上限，请收费员核对本次用量',
  },
  ERR_CHARGE_DUPLICATE_ON_PEER: {
    role: ROLE_CASHIER,
    basis_zh: 'HIS 侧判定这笔已经计过费，请收费员核对是否重复上报',
  },
  ERR_CHARGE_OPERATION_NOT_FOUND: {
    role: ROLE_CASHIER,
    basis_zh: 'HIS 侧找不到这台手术，请收费员核对台次号',
  },
  ERR_CHARGE_OPERATION_CLOSED: {
    role: ROLE_CASHIER,
    basis_zh: 'HIS 侧台次已关闭，请收费员确认关台后的补录口径',
  },
  ERR_CHARGE_MANUAL_REQUIRED: {
    role: ROLE_CASHIER,
    basis_zh: '对端要求人工处理，请收费员在 HIS 侧确认这笔耗材',
  },
  ERR_OPERATION_NOT_FOUND: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '这台手术不在排台台次里，请手术室护士长核对台次号与排台',
  },
  ERR_OPERATION_CLOSED: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '台次已关台，这条耗材不能自动计费，请手术室护士长确认是否走人工补录',
  },
  ERR_OPERATION_CONFLICT: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '扫码枪登记与排台对不上，请手术室护士长核对台次',
  },
  ERR_CROSS_OP_DUPLICATE: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '同一耗材已记在另一台次上，请手术室护士长核对到底算在哪台手术',
  },
  ERR_MATERIAL_NOT_REGISTERED: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材码不在院内耗材主数据里，请高值耗材管理岗补建档（导入即生效，无需重启）',
  },
  ERR_MATERIAL_INACTIVE: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材已停用，请高值耗材管理岗确认停用原因',
  },
  ERR_FEE_CATEGORY_MISSING: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材主数据缺费用类别，请高值耗材管理岗补登记',
  },
  ERR_INSURANCE_CLASS_MISSING: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材主数据缺医保分类，请高值耗材管理岗补登记',
  },
};

/** 按**结论**兜底（五种绑定结论 → 责任岗位） */
const CONCLUSION_ROUTES: Readonly<Record<string, RouteRule>> = {
  NOT_REGISTERED: {
    role: ROLE_MATERIAL_MANAGER,
    basis_zh: '耗材没绑上本台次，请高值耗材管理岗核对耗材主数据',
  },
  CROSS_OP_DUP: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '同一耗材已记在另一台次上，请手术室护士长核对到底算在哪台手术',
  },
  CLOSED: {
    role: ROLE_OR_NURSE_MANAGER,
    basis_zh: '台次已关台，这条耗材不能自动计费，请手术室护士长确认是否走人工补录',
  },
  CHARGE_REJECTED: {
    role: ROLE_CASHIER,
    basis_zh: '计费被对端拒绝，请收费员核对价码、库存与医保口径',
  },
};

/** 兜底规则：什么都没匹配上时的分派依据 */
const DEFAULT_RULE: RouteRule = {
  role: DEFAULT_ROLE,
  basis_zh: '未匹配到具体异常类型，先按耗材主数据类分派，请责任岗位核对后转办',
};

/* ── 路由解析（纯函数，不碰台账） ── */

/** 路由输入 */
export interface RouteInput {
  /** 绑定结论（五种之一） */
  conclusion?: string | null;
  /** 原因码 */
  reason_code?: string | null;
  /** 统一错误码（ERR_*） */
  error_code?: string | null;
  /** 台次所属科室（决定落到哪个科室的岗位） */
  dept_code?: string | null;
}

/** 路由结论 */
export interface AssigneeResolution {
  /** 责任岗位（基础岗位名，升级链按它查） */
  role: string;
  /** 面向人的说法：手术室护士长（SURG-ORT） */
  display: string;
  /** 分派依据（中文一句话） */
  basis_zh: string;
  /** 命中的口径 */
  matched_by: 'reason_code' | 'error_code' | 'conclusion' | 'default';
  /** 命中的键（原因码 / 错误码 / 结论） */
  matched_key: string;
  /** 该岗位的升级链 */
  chain: readonly string[];
}

/**
 * 面向人的岗位说法：岗位 + 科室。
 *
 * 科室决定「落到哪个科室的岗位」：同样是「手术室护士长」，
 * 骨科手术间的和心外科手术间的不是同一个人 —— 科室写清楚才不会互相甩。
 */
export function formatAssignee(role: string, dept_code?: string | null): string {
  const dept = (dept_code ?? '').trim();
  return dept.length > 0 ? `${role}（${dept}）` : role;
}

/**
 * 解析责任岗位。
 *
 * 命中顺序：**原因码 → 统一错误码 → 结论 → 兜底**。
 * 原因码最细（同一结论下原因不同，找的人不同）；错误码用于通道类问题；
 * 结论只作兜底。
 */
export function resolveAssignee(input: RouteInput): AssigneeResolution {
  const reason = (input.reason_code ?? '').trim();
  const errorCode = (input.error_code ?? '').trim();
  const conclusion = (input.conclusion ?? '').trim();

  let rule: RouteRule | undefined;
  let matched_by: AssigneeResolution['matched_by'] = 'default';
  let matched_key = 'DEFAULT';

  if (reason.length > 0) {
    rule = REASON_ROUTES[reason];
    if (rule) {
      matched_by = 'reason_code';
      matched_key = reason;
    }
  }
  if (!rule && errorCode.length > 0) {
    rule = ERROR_CODE_ROUTES[errorCode];
    if (rule) {
      matched_by = 'error_code';
      matched_key = errorCode;
    }
  }
  if (!rule && conclusion.length > 0) {
    rule = CONCLUSION_ROUTES[conclusion];
    if (rule) {
      matched_by = 'conclusion';
      matched_key = conclusion;
    }
  }
  if (!rule) {
    rule = DEFAULT_RULE;
  }

  const role = rule.role;
  return {
    role,
    display: formatAssignee(role, input.dept_code),
    basis_zh: rule.basis_zh,
    matched_by,
    matched_key,
    chain: ROLE_ESCALATION_CHAIN[role] ?? [role],
  };
}

/* ── 台账读写 ── */

/** 路由用到的核查条目字段（与 `check_task` 表列一一对应） */
export interface RoutableTask {
  id: number;
  operation_no: string;
  room_no: string;
  dept_code: string | null;
  scanner_id: string | null;
  material_code: string;
  quantity: number | null;
  conclusion: string;
  reason_code: string;
  error_code: string | null;
  status: string;
  assignee_role: string | null;
  assigned_at: string | null;
  reminded_at: string | null;
  escalated_at: string | null;
  timeout_level: number;
  detected_at: string;
}

const TASK_COLUMNS = `id, operation_no, room_no, dept_code, scanner_id, material_code, quantity,
       conclusion, reason_code, error_code, status, assignee_role, assigned_at,
       reminded_at, escalated_at, timeout_level, detected_at`;

/** 路由与提醒的公共选项 */
export interface RoutingOptions {
  /** 当前时间（毫秒）；不给取 Date.now() */
  nowMs?: number;
  /** 各岗位响应时限覆盖（毫秒），键是岗位名 */
  windows?: Record<string, number>;
  /** 单次最多处理多少条（默认 200） */
  limit?: number;
}

/** 取当前时间（毫秒） */
function nowOf(options: RoutingOptions): number {
  return options.nowMs ?? Date.now();
}

/** 取某岗位的响应时限（毫秒） */
export function responseWindowMs(role: string | null | undefined, options: RoutingOptions = {}): number {
  const override = options.windows?.[role ?? ''];
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  if (role && ROLE_RESPONSE_WINDOW_MS[role] !== undefined) return ROLE_RESPONSE_WINDOW_MS[role];
  return DEFAULT_RESPONSE_WINDOW_MS;
}

/**
 * 该条目从分派（或检出）到现在过了多久（毫秒）。
 *
 * 以 `assigned_at` 为准：条目建出来到被分派之间的时间不算岗位的责任。
 */
export function taskAgeMs(task: RoutableTask, nowMs: number): number {
  const since = Date.parse(task.assigned_at ?? task.detected_at);
  if (!Number.isFinite(since)) return 0;
  return Math.max(0, nowMs - since);
}

/** 待处理的核查条目（按检出时间升序） */
export function listPendingRoutableTasks(
  db: DatabaseSync,
  options: RoutingOptions = {},
): RoutableTask[] {
  const limit = options.limit ?? 200;
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM check_task
        WHERE status = 'pending'
        ORDER BY detected_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as unknown as RoutableTask[];
}

/** 按 id 取核查条目 */
export function findRoutableTask(db: DatabaseSync, id: number): RoutableTask | undefined {
  return db
    .prepare(`SELECT ${TASK_COLUMNS} FROM check_task WHERE id = ?`)
    .get(id) as unknown as RoutableTask | undefined;
}

/** 分派结果 */
export interface AssignOutcome {
  task_id: number;
  /** 责任岗位 */
  role: string;
  /** 面向人的说法（岗位 + 科室） */
  display: string;
  /** 分派依据 */
  basis_zh: string;
  /** 是否发生了改派（false = 已经派到同一个岗位，或条目已闭环） */
  changed: boolean;
  /** 未改派时的原因 */
  skipped_reason: 'already_assigned' | 'closed' | 'not_found' | null;
}

/**
 * 把一条核查条目派给责任岗位。
 *
 * 幂等：已经派到**同一个**岗位就不动它（不重写 `assigned_at`，不重复写审计）——
 * 重复扫描不刷屏、也不把处置轨迹搅乱。
 * 已闭环的条目不再改派（人已经落定结论了）。
 */
export function assignCheckTask(
  db: DatabaseSync,
  task_id: number,
  options: RoutingOptions = {},
): AssignOutcome {
  const task = findRoutableTask(db, task_id);
  if (!task) {
    return {
      task_id,
      role: '',
      display: '',
      basis_zh: '',
      changed: false,
      skipped_reason: 'not_found',
    };
  }
  if (task.status !== 'pending') {
    return {
      task_id,
      role: task.assignee_role ?? '',
      display: formatAssignee(task.assignee_role ?? '', task.dept_code),
      basis_zh: '',
      changed: false,
      skipped_reason: 'closed',
    };
  }

  const resolution = resolveAssignee({
    conclusion: task.conclusion,
    reason_code: task.reason_code,
    error_code: task.error_code,
    dept_code: task.dept_code,
  });

  if (task.assignee_role === resolution.role) {
    return {
      task_id,
      role: resolution.role,
      display: resolution.display,
      basis_zh: resolution.basis_zh,
      changed: false,
      skipped_reason: 'already_assigned',
    };
  }

  const now = new Date(nowOf(options)).toISOString();
  db.prepare(
    'UPDATE check_task SET assignee_role = ?, assigned_at = ? WHERE id = ?',
  ).run(resolution.role, now, task.id);

  appendAudit(db, {
    event_type: 'check_task_assigned',
    operation_no: task.operation_no,
    scanner_id: task.scanner_id,
    actor: 'check_router',
    detail: JSON.stringify({
      task_id: task.id,
      assignee_role: resolution.role,
      assignee_display: resolution.display,
      dept_code: task.dept_code,
      conclusion: task.conclusion,
      reason_code: task.reason_code,
      error_code: task.error_code,
      matched_by: resolution.matched_by,
      matched_key: resolution.matched_key,
      basis_zh: resolution.basis_zh,
      material_code: task.material_code,
    }),
  });

  return {
    task_id,
    role: resolution.role,
    display: resolution.display,
    basis_zh: resolution.basis_zh,
    changed: true,
    skipped_reason: null,
  };
}

/**
 * 把**还没派过**的待处理条目补分派。
 *
 * 只补空缺（`assignee_role IS NULL`）：已派过的条目**不改** ——
 * 否则升级过的条目会被这一轮重新拉回基础岗位，处置档位就乱了。
 */
export function assignUnroutedTasks(
  db: DatabaseSync,
  options: RoutingOptions = {},
): AssignOutcome[] {
  const rows = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM check_task
        WHERE status = 'pending' AND assignee_role IS NULL
        ORDER BY detected_at ASC, id ASC LIMIT ?`,
    )
    .all(options.limit ?? 200) as unknown as RoutableTask[];
  const outcomes: AssignOutcome[] = [];
  for (const row of rows) {
    outcomes.push(assignCheckTask(db, row.id, options));
  }
  return outcomes;
}

/* ── 超时提醒 ── */

/** 超时条目 */
export interface OverdueTask extends RoutableTask {
  /** 已过多久（毫秒） */
  age_ms: number;
  /** 该岗位的响应时限（毫秒） */
  window_ms: number;
  /** 超时多久（毫秒） */
  overdue_ms: number;
  /** 责任岗位（面向人） */
  assignee_display: string;
}

/**
 * 列出**该催**的条目：待处理、已过响应时限、还没提醒过。
 *
 * 提醒**只发一次** —— `reminded_at` 有值的条目不再出现在这里，
 * 重复扫描不会重复刷屏。
 */
export function listTasksNeedingReminder(
  db: DatabaseSync,
  options: RoutingOptions = {},
): OverdueTask[] {
  const nowMs = nowOf(options);
  const pending = listPendingRoutableTasks(db, options);
  const result: OverdueTask[] = [];
  for (const task of pending) {
    if (task.reminded_at) continue;
    const window = responseWindowMs(task.assignee_role, options);
    const age = taskAgeMs(task, nowMs);
    if (age < window) continue;
    result.push({
      ...task,
      age_ms: age,
      window_ms: window,
      overdue_ms: age - window,
      assignee_display: formatAssignee(task.assignee_role ?? DEFAULT_ROLE, task.dept_code),
    });
  }
  return result;
}

/** 提醒结果 */
export interface RemindOutcome {
  task_id: number;
  /** 是否真的发出去了 */
  sent: boolean;
  /** 失败时的错误码 */
  error_code?: string | null;
  /** 失败信息（已脱敏） */
  message?: string | null;
}

/**
 * 给超时条目发一次提醒（企微），并记 `reminded_at`。
 *
 * 失败**不抛到主流程**：提醒推不动不该影响台账；
 * 失败时不写 `reminded_at`（下轮还能再催），但审计链留一行失败痕迹。
 */
export async function remindOverdueTasks(
  db: DatabaseSync,
  client: WeComBotClient,
  options: RoutingOptions = {},
): Promise<RemindOutcome[]> {
  const candidates = listTasksNeedingReminder(db, options);
  const outcomes: RemindOutcome[] = [];

  for (const task of candidates) {
    const message = buildCheckTaskReminderMessage({
      task_id: task.id,
      operation_no: task.operation_no,
      room_no: task.room_no,
      dept_code: task.dept_code,
      material_code: task.material_code,
      quantity: task.quantity,
      conclusion: task.conclusion,
      reason_code: task.reason_code,
      error_code: task.error_code,
      assignee_display: task.assignee_display,
      overdue_ms: task.overdue_ms,
      timeout_level: task.timeout_level,
    });

    try {
      await client.postMessage(message);
      const now = new Date(nowOf(options)).toISOString();
      db.prepare('UPDATE check_task SET reminded_at = ? WHERE id = ?').run(now, task.id);
      appendAudit(db, {
        event_type: 'check_task_reminded',
        operation_no: task.operation_no,
        scanner_id: task.scanner_id,
        actor: 'check_router',
        detail: JSON.stringify({
          task_id: task.id,
          assignee_role: task.assignee_role,
          assignee_display: task.assignee_display,
          overdue_ms: task.overdue_ms,
          window_ms: task.window_ms,
          timeout_level: task.timeout_level,
          material_code: task.material_code,
          reason_code: task.reason_code,
          reminded_at: now,
        }),
      });
      outcomes.push({ task_id: task.id, sent: true });
    } catch (error) {
      const message2 = error instanceof Error ? error.message : String(error);
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code ?? 'ERR_NOTIFY_INTERNAL')
          : 'ERR_NOTIFY_INTERNAL';
      appendAudit(db, {
        event_type: 'check_task_remind_failed',
        operation_no: task.operation_no,
        scanner_id: task.scanner_id,
        actor: 'check_router',
        detail: JSON.stringify({
          task_id: task.id,
          error_code: code,
          message: message2,
          assignee_role: task.assignee_role,
          overdue_ms: task.overdue_ms,
        }),
      });
      outcomes.push({ task_id: task.id, sent: false, error_code: code, message: message2 });
    }
  }

  return outcomes;
}

/* ── 超时升级 ── */

/** 升级结果 */
export interface EscalateOutcome {
  task_id: number;
  /** 原责任岗位 */
  from_role: string | null;
  /** 新责任岗位（未升级时为 null） */
  to_role: string | null;
  /** 升级后的处置档位 */
  timeout_level: number;
  /** 是否真的升级了 */
  escalated: boolean;
  /** 未升级时的原因 */
  skipped_reason: 'not_overdue' | 'top_level' | null;
}

/**
 * 该条目现在该不该升级。
 *
 * 升级时限 = 岗位响应时限 × 2^处置档位：0 档一个时限，1 档两个时限，2 档四个时限。
 * 升到链上最后一档后**不再往上升**（再往上没有处置岗位了）。
 */
export function escalationDueAtMs(
  role: string | null | undefined,
  timeoutLevel: number,
  options: RoutingOptions = {},
): number {
  const window = responseWindowMs(role, options);
  return window * Math.pow(2, Math.max(0, timeoutLevel));
}

/**
 * 把超时仍未确认的条目升级到上一级岗位。
 *
 * **只改责任岗位与处置档位**：条目状态保持 `check_pending` —— 系统不代人工闭环。
 * 审计链记一行 `check_task_escalated`，可按 task_id 回放处置轨迹。
 */
export function escalateOverdueTasks(
  db: DatabaseSync,
  options: RoutingOptions = {},
): EscalateOutcome[] {
  const nowMs = nowOf(options);
  const pending = listPendingRoutableTasks(db, options);
  const outcomes: EscalateOutcome[] = [];

  for (const task of pending) {
    const role = task.assignee_role ?? DEFAULT_ROLE;
    const chain = ROLE_ESCALATION_CHAIN[role] ?? [role];
    const level = task.timeout_level ?? 0;

    if (level >= chain.length - 1) {
      // 已在最高档：再往上没有处置岗位，静默跳过（不重复写审计）
      outcomes.push({
        task_id: task.id,
        from_role: task.assignee_role,
        to_role: null,
        timeout_level: level,
        escalated: false,
        skipped_reason: 'top_level',
      });
      continue;
    }

    const due = escalationDueAtMs(role, level, options);
    const age = taskAgeMs(task, nowMs);
    if (age < due) {
      outcomes.push({
        task_id: task.id,
        from_role: task.assignee_role,
        to_role: null,
        timeout_level: level,
        escalated: false,
        skipped_reason: 'not_overdue',
      });
      continue;
    }

    const nextRole = chain[level + 1] ?? role;
    const nextLevel = level + 1;
    const now = new Date(nowMs).toISOString();
    db.prepare(
      'UPDATE check_task SET assignee_role = ?, timeout_level = ?, escalated_at = ? WHERE id = ?',
    ).run(nextRole, nextLevel, now, task.id);

    appendAudit(db, {
      event_type: 'check_task_escalated',
      operation_no: task.operation_no,
      scanner_id: task.scanner_id,
      actor: 'check_router',
      detail: JSON.stringify({
        task_id: task.id,
        from_role: role,
        to_role: nextRole,
        timeout_level: nextLevel,
        overdue_ms: age - due,
        due_ms: due,
        material_code: task.material_code,
        reason_code: task.reason_code,
        dept_code: task.dept_code,
        escalated_at: now,
        top_level: nextLevel >= chain.length - 1,
      }),
    });

    outcomes.push({
      task_id: task.id,
      from_role: role,
      to_role: nextRole,
      timeout_level: nextLevel,
      escalated: true,
      skipped_reason: null,
    });
  }

  return outcomes;
}

/* ── 周期扫描（守护进程调这个） ── */

/** 一轮路由扫描的结论 */
export interface RoutingSweepResult {
  /** 本轮补分派的条目数 */
  assigned: number;
  /** 该催的条目数（提醒前） */
  overdue: number;
  /** 提醒发出去的数量 */
  reminded: number;
  /** 提醒失败的数量 */
  remind_failed: number;
  /** 升级的条目数 */
  escalated: number;
  /** 已在最高档、未再升级的条目数 */
  top_level: number;
}

/** 一轮扫描的选项 */
export interface RoutingSweepOptions extends RoutingOptions {
  /** 企微客户端（不给 = 只分派与升级，不发提醒与升级通知） */
  client?: WeComBotClient | null;
}

/**
 * 一轮核查任务路由扫描：**补分派 → 提醒 → 升级**。
 *
 * 顺序有讲究：先按当前责任岗位提醒（催的是该管的人），
 * 再把仍然没人管的升级给上一级（升级通知里写明原岗位与新岗位）。
 *
 * 全程不抛异常：提醒与升级推不动都不该把守护进程带崩。
 */
export async function sweepCheckTaskRouting(
  db: DatabaseSync,
  options: RoutingSweepOptions = {},
): Promise<RoutingSweepResult> {
  const result: RoutingSweepResult = {
    assigned: 0,
    overdue: 0,
    reminded: 0,
    remind_failed: 0,
    escalated: 0,
    top_level: 0,
  };

  // ① 补分派：只补还没派过的条目
  try {
    const assigned = assignUnroutedTasks(db, options);
    result.assigned = assigned.filter((item) => item.changed).length;
  } catch {
    result.assigned = 0;
  }

  // ② 提醒：只发一次
  const client = options.client ?? null;
  if (client) {
    try {
      const overdue = listTasksNeedingReminder(db, options);
      result.overdue = overdue.length;
      const outcomes = await remindOverdueTasks(db, client, options);
      result.reminded = outcomes.filter((item) => item.sent).length;
      result.remind_failed = outcomes.filter((item) => !item.sent).length;
    } catch {
      result.reminded = 0;
      result.remind_failed = 0;
    }
  } else {
    try {
      result.overdue = listTasksNeedingReminder(db, options).length;
    } catch {
      result.overdue = 0;
    }
  }

  // ③ 升级：条目状态保持待核查，系统不代人工闭环
  try {
    const escalations = escalateOverdueTasks(db, options);
    result.escalated = escalations.filter((item) => item.escalated).length;
    result.top_level = escalations.filter((item) => item.skipped_reason === 'top_level').length;

    // 升级通知：推不动不影响升级本身（台账已经改了）
    if (client) {
      for (const escalation of escalations) {
        if (!escalation.escalated) continue;
        const task = findRoutableTask(db, escalation.task_id);
        if (!task) continue;
        try {
          await client.postMessage(
            buildEscalationNoticeMessage({
              task_id: task.id,
              operation_no: task.operation_no,
              room_no: task.room_no,
              dept_code: task.dept_code,
              material_code: task.material_code,
              quantity: task.quantity,
              conclusion: task.conclusion,
              reason_code: task.reason_code,
              from_role: escalation.from_role ?? task.assignee_role ?? '',
              to_role: escalation.to_role ?? '',
              timeout_level: escalation.timeout_level,
            }),
          );
        } catch (error) {
          appendAudit(db, {
            event_type: 'check_task_escalation_notify_failed',
            operation_no: task.operation_no,
            scanner_id: task.scanner_id,
            actor: 'check_router',
            detail: JSON.stringify({
              task_id: task.id,
              from_role: escalation.from_role,
              to_role: escalation.to_role,
              timeout_level: escalation.timeout_level,
              message: error instanceof Error ? error.message : String(error),
            }),
          });
        }
      }
    }
  } catch {
    result.escalated = 0;
  }

  return result;
}
