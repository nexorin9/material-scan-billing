/**
 * 字段契约：把「文档写的」和「代码发的」绑成**一份可执行的约定**。
 *
 * 为什么要有这张表：
 *   出站对接最怕「文档写的和代码发的不一样」。字段改个名、对端不认，
 *   表现是**静默丢计费条目** —— 请求发出去、对端收了一部分、账上少几笔，
 *   要到月底对账才发现。对端回一个字段名拼错的响应更麻烦：
 *   本侧把「看不懂的响应」当成成功，这笔耗材就再也不会重投。
 *
 *   所以本模块把契约写成**数据**（不是散落在代码里的 if），
 *   三处共用同一份：
 *     ① 出站请求发出前逐字段校验 —— 不合规**不外发**，给独立错误码；
 *     ② 出站响应回来后逐字段校验 —— 不符按「对端协议不符」进重投队列；
 *     ③ 入站扫码事件逐条校验 —— 字段缺失 / 类型错的**那一条**落 rejected，
 *        同批其余照常处理（一条坏数据不拖累整台手术）。
 *
 *   字段名与长度上限与 `docs/api/his-charging.md` / `docs/api/scan-event.md`
 *   **同源**：文档由契约渲染，代码由契约校验，不再各写一份。
 *
 * 表的读法：
 *   长度上限表（§1）→ 字段名的字符数上限；
 *   字段契约（§2）→ 字段名 / 类型 / 必填 / 枚举 / 长度上限 / 元素契约。
 */

import { FEE_CATEGORIES, MEDICAL_INSURANCE_CLASSES } from '../engine/fee-category.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * §1 字段长度上限表
 *
 * 为什么要有这张表：
 *   HIS 计费接口对单字段宽度有上限（对端库表列宽 / 网关报文长度限制）。超长字段发过去
 *   的后果分两种：有的对端直接 4xx 拒收；有的**截断后照收** —— 后者最坏：
 *   耗材码被截成另一个码，计费记到了别的耗材头上，要到月底对账才发现。
 *
 *   本项目的口径是**超长即拒**（`ERR_CHARGE_FIELD_TOO_LONG`），三条硬约束：
 *     ① **不截断后照发** —— 截断过的耗材码就是另一个耗材，计费会记错人；
 *     ② **不静默丢弃** —— 被拒的条目照样有回执、有核查条目，账目条数守恒；
 *     ③ **请求级字段与明细级字段分开处置** —— `operation_no` / `dept_code` 超长时
 *        整个请求发不出去；`material_code` / `price_code` 超长只拒**那一条**，
 *        同批其余条目照常提交，不让一条坏数据拖垮整台手术的计费。
 *
 * 表的读法：字段名 → 长度上限（字符数）。
 * 契约是**出站侧**的硬约束，与 `docs/api/his-charging.md` 的请求约定小节同源。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 字段长度上限项 */
export interface FieldLengthLimit {
  /** 字段名（与出站请求体字段名逐字一致） */
  field: string;
  /** 长度上限（字符数） */
  max_length: number;
  /** 中文含义 */
  meaning_zh: string;
}

/**
 * 请求级字段的长度上限。
 *
 * 这一层是「整张单据的抬头」：台次号与科室编码定的是**这一批计费记到哪台手术**，
 * 超长即整单发不出去 —— 没有「截一半抬头」的说法。
 */
export const ENVELOPE_FIELD_LENGTH_LIMITS: readonly FieldLengthLimit[] = [
  { field: 'operation_no', max_length: 64, meaning_zh: '手术台次号' },
  { field: 'dept_code', max_length: 32, meaning_zh: '科室编码' },
];

/**
 * 明细级字段的长度上限。
 *
 * 这一层是「单条耗材明细」：一条超长只影响这一条，同批其余照常提交。
 *
 * 注意 `material_code` 的出站上限（32）**比入站上限（64）更紧**：
 * 扫码枪能扫出来的码空间比 HIS 计费表的列宽宽（UDI 的 DI 段最长可到 20 位，
 * 院内码也可能更长），但对端计费表放不下 —— 这种码**不能截断后照发**
 * （截断后就是另一个耗材），只能拒，转人工改主数据。
 */
export const ITEM_FIELD_LENGTH_LIMITS: readonly FieldLengthLimit[] = [
  { field: 'material_code', max_length: 32, meaning_zh: '院内耗材码（归一后的规范码）' },
  { field: 'price_code', max_length: 32, meaning_zh: '价码（耗材主数据的价格编码）' },
];

/** 全部出站字段的长度上限（请求级 + 明细级），按字段名索引 */
export const OUTBOUND_FIELD_LENGTH_LIMITS: Readonly<Record<string, FieldLengthLimit>> = Object.freeze(
  Object.fromEntries(
    [...ENVELOPE_FIELD_LENGTH_LIMITS, ...ITEM_FIELD_LENGTH_LIMITS].map((item) => [item.field, item]),
  ),
);

/** 长度上限的扁平视图：字段名 → 上限 */
export type FieldLengthLimits = Readonly<Record<string, number>>;

/** 取默认的长度上限表（扁平视图） */
export function defaultFieldLengthLimits(): FieldLengthLimits {
  return Object.freeze(
    Object.fromEntries(
      Object.values(OUTBOUND_FIELD_LENGTH_LIMITS).map((item) => [item.field, item.max_length]),
    ),
  );
}

/** 字段长度是否越界 */
export interface FieldLengthCheck {
  /** 字段名 */
  field: string;
  /** 实际长度 */
  actual: number;
  /** 上限（字段不在表里时等于实际长度，即不限） */
  limit: number;
  /** 是否越界 */
  exceeded: boolean;
}

/**
 * 量一个字段的长度并与上限比对。
 *
 * 字段不在表里 → **不限**（不擅自给未登记的字段设上限）。
 * 长度按 JavaScript 字符串长度计（UTF-16 码元）—— 与 JSON 序列化后的字符数一致。
 */
export function checkFieldLength(
  field: string,
  value: string,
  limits: FieldLengthLimits = defaultFieldLengthLimits(),
): FieldLengthCheck {
  const limit = limits[field];
  const actual = typeof value === 'string' ? value.length : 0;
  return {
    field,
    actual,
    limit: typeof limit === 'number' ? limit : actual,
    exceeded: typeof limit === 'number' && actual > limit,
  };
}

/** 把长度上限表渲染成 Markdown 表格行（供文档生成与测试比对） */
export function renderFieldLengthLimitRows(
  limits: FieldLengthLimits = defaultFieldLengthLimits(),
): string {
  return Object.entries(limits)
    .map(
      ([field, max]) =>
        `| \`${field}\` | ${max} | ${OUTBOUND_FIELD_LENGTH_LIMITS[field]?.meaning_zh ?? ''} |`,
    )
    .join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §2 字段契约模型（类型 / 必填 / 枚举 / 长度上限 / 元素契约）
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 契约字段的类型口径 */
export type ContractFieldType =
  | 'string' // 字符串（可带长度上限 / 枚举）
  | 'timestamp' // ISO 8601 时间戳（字符串且可被 Date.parse 解析）
  | 'integer' // 整数（可带下限）
  | 'number' // 数值
  | 'boolean' // 布尔
  | 'array'; // 数组（元素契约由 item_contract 给出）

/** 契约里的一个字段 */
export interface ContractField {
  /** 字段名（与报文里的键逐字一致） */
  name: string;
  /** 类型口径 */
  type: ContractFieldType;
  /** 是否必填 */
  required: boolean;
  /** 字符串长度上限（字符数） */
  max_length?: number;
  /** 数值下限（如数量必须 ≥ 1） */
  min?: number;
  /** 取值允许集（枚举） */
  enum?: readonly string[];
  /** 数组元素契约（元素是对象时用它） */
  item_contract?: Contract;
  /** 中文含义（给对端看的一句话） */
  meaning_zh: string;
}

/** 一份契约（一个报文的形状） */
export interface Contract {
  /** 契约标识（稳定字符串，用于日志与文档定位） */
  id: string;
  /** 中文标题 */
  title_zh: string;
  /** 方向：入站（设备 → 本系统）/ 出站（本系统 → HIS 计费） */
  direction: 'inbound' | 'outbound';
  /** 字段清单（顺序即报文里的展示顺序） */
  fields: readonly ContractField[];
}

/** 违规类型 */
export type ViolationKind =
  /** 必填字段缺失 */
  | 'missing_required'
  /** 类型不对 */
  | 'type_mismatch'
  /** 超过长度上限 */
  | 'too_long'
  /** 数值越界（如数量 ≤ 0） */
  | 'value_out_of_range'
  /** 取值不在允许集内 */
  | 'enum_violation';

/** 一条字段级违规 */
export interface ContractViolation {
  /** 定位路径：`uses[0].quantity` / `operation_no` */
  path: string;
  /** 字段名 */
  field: string;
  /** 违规类型 */
  kind: ViolationKind;
  /** 期望（中文，可直接发给对端） */
  expected: string;
  /** 实际（截断后的值描述，不整包回显） */
  actual: string;
  /** 中文说明 */
  message_zh: string;
}

/** 值的简短描述（不回显整包内容，避免日志被撑爆） */
export function describeActual(value: unknown): string {
  if (value === undefined) return '未提供';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const preview = value.length > 32 ? `${value.slice(0, 32)}…` : value;
    return `字符串「${preview}」（长度 ${value.length}）`;
  }
  if (typeof value === 'number') return `数值 ${value}`;
  if (typeof value === 'boolean') return `布尔 ${value}`;
  if (Array.isArray(value)) return `数组（长度 ${value.length}）`;
  if (typeof value === 'object') return '对象';
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeLabel(type: ContractFieldType): string {
  switch (type) {
    case 'string':
      return '字符串';
    case 'timestamp':
      return 'ISO 8601 时间戳字符串';
    case 'integer':
      return '整数';
    case 'number':
      return '数值';
    case 'boolean':
      return '布尔值';
    case 'array':
      return '数组';
    default:
      return type;
  }
}

/** 字段的期望描述（写进违规项的 expected） */
export function describeExpectation(field: ContractField): string {
  const parts: string[] = [typeLabel(field.type)];
  if (field.enum && field.enum.length > 0) parts.push(`取值 ∈ {${field.enum.join(' / ')}}`);
  if (typeof field.max_length === 'number') parts.push(`长度 ≤ ${field.max_length}`);
  if (typeof field.min === 'number') parts.push(`≥ ${field.min}`);
  return parts.join('，');
}

/**
 * 校验一个字段（返回违规项清单，**不抛异常**）。
 *
 * 不抛异常是刻意的：入站侧要「拒这一条、不丢同批其余」，
 * 出站侧要「把不合规的条目一次性说清楚」，两边都需要拿到**清单**而不是第一个错误。
 */
function validateField(
  field: ContractField,
  value: unknown,
  path: string,
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const expected = describeExpectation(field);

  const push = (kind: ViolationKind, actual: string, message: string): void => {
    violations.push({ path, field: field.name, kind, expected, actual, message_zh: message });
  };

  // 缺失：必填 → 违规；选填 → 直接跳过
  if (value === undefined || value === null) {
    if (field.required) {
      push('missing_required', describeActual(value), `字段 ${path} 必填但未提供`);
    }
    return violations;
  }

  switch (field.type) {
    case 'string':
    case 'timestamp': {
      if (typeof value !== 'string') {
        push('type_mismatch', describeActual(value), `字段 ${path} 类型不对，应为${typeLabel(field.type)}`);
        return violations;
      }
      if (field.type === 'timestamp' && Number.isNaN(Date.parse(value))) {
        push('type_mismatch', describeActual(value), `字段 ${path} 不是可解析的时间戳`);
        return violations;
      }
      if (typeof field.max_length === 'number' && value.length > field.max_length) {
        push(
          'too_long',
          describeActual(value),
          `字段 ${path} 长度 ${value.length} 超过上限 ${field.max_length}`,
        );
      }
      if (field.enum && !field.enum.includes(value)) {
        push(
          'enum_violation',
          describeActual(value),
          `字段 ${path} 取值不在允许集内（允许：${field.enum.join(' / ')}）`,
        );
      }
      return violations;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        push('type_mismatch', describeActual(value), `字段 ${path} 类型不对，应为整数`);
        return violations;
      }
      if (typeof field.min === 'number' && value < field.min) {
        push(
          'value_out_of_range',
          describeActual(value),
          `字段 ${path} 取值 ${value} 小于下限 ${field.min}`,
        );
      }
      return violations;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        push('type_mismatch', describeActual(value), `字段 ${path} 类型不对，应为数值`);
        return violations;
      }
      return violations;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        push('type_mismatch', describeActual(value), `字段 ${path} 类型不对，应为布尔值`);
      }
      return violations;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        push('type_mismatch', describeActual(value), `字段 ${path} 类型不对，应为数组`);
        return violations;
      }
      if (field.item_contract) {
        value.forEach((element, index) => {
          violations.push(
            ...validateAgainst(field.item_contract as Contract, element, `${path}[${index}]`),
          );
        });
      }
      return violations;
    }
    default:
      return violations;
  }
}

/**
 * 按契约逐字段校验一个载荷。
 *
 * @param contract 契约
 * @param payload 待校验的载荷（通常是 JSON.parse 出来的对象）
 * @param basePath 路径前缀（数组元素递归时用）
 * @returns 违规项清单（空数组 = 合规）
 *
 * 口径：
 *   - **不检查未登记的字段** —— 对端加字段是常态（向前兼容），不该因此拒收；
 *   - **必填字段缺失**、**类型不对**、**超长**、**枚举越界**、**数值越界**五类都算违规；
 *   - 违规项带**字段名 + 期望 + 实际**，可以直接贴给对端或设备厂商看。
 */
export function validateAgainst(
  contract: Contract,
  payload: unknown,
  basePath = '',
): ContractViolation[] {
  if (!isPlainObject(payload)) {
    return [
      {
        path: basePath || contract.id,
        field: contract.id,
        kind: 'type_mismatch',
        expected: 'JSON 对象',
        actual: describeActual(payload),
        message_zh: `载荷不是对象，无法按契约 ${contract.id} 逐字段校验`,
      },
    ];
  }

  const violations: ContractViolation[] = [];
  for (const field of contract.fields) {
    const path = basePath ? `${basePath}.${field.name}` : field.name;
    violations.push(...validateField(field, payload[field.name], path));
  }
  return violations;
}

/** 契约里的字段名（按顺序） */
export function contractFieldNames(contract: Contract): string[] {
  return contract.fields.map((field) => field.name);
}

/** 把契约渲染成 Markdown 表格行（文档与代码同源的保证） */
export function renderContractRows(contract: Contract): string {
  return contract.fields
    .map((field) => {
      const type = field.type === 'timestamp' ? 'string（ISO 8601）' : field.type;
      const limit =
        typeof field.max_length === 'number'
          ? String(field.max_length)
          : typeof field.min === 'number'
            ? `≥ ${field.min}`
            : '—';
      const allowed = field.enum && field.enum.length > 0 ? field.enum.join(' / ') : '—';
      return `| \`${field.name}\` | ${type} | ${field.required ? '是' : '否'} | ${limit} | ${allowed} | ${field.meaning_zh} |`;
    })
    .join('\n');
}

/** 契约表格的表头（渲染与文档比对共用同一份） */
export const CONTRACT_TABLE_HEADER =
  '| 字段 | 类型 | 必填 | 长度上限 | 允许取值 | 说明 |\n|---|---|---|---|---|---|';

/**
 * 渲染一份契约的**完整** Markdown 表格（表头 + 数据行）。
 *
 * 文档生成器（`scripts/gen-api-docs.ts`）用它把契约表写进
 * `docs/api/his-charging.md` 与 `docs/api/scan-event.md`，
 * 测试用它断言「文档里的表 = 代码里的契约」—— 文档与实现不会各写一份。
 */
export function renderContractTable(contract: Contract): string {
  return `${CONTRACT_TABLE_HEADER}\n${renderContractRows(contract)}`;
}

/** 按契约 id 查契约（文档生成器按 id 定位要渲染的表） */
export function findContract(id: string): Contract | undefined {
  return ALL_CONTRACTS.find((contract) => contract.id === id);
}

/**
 * 契约表在文档里的**锚点标记**。
 *
 * 文档生成器只替换这两个标记之间的内容，标记之外的正文（说明、示例、错误码）
 * 仍由人写 —— 表格是机器生成的，叙述是人写的，两边各管各的。
 */
export const CONTRACT_TABLE_OPEN = (contractId: string): string =>
  `<!-- contract-table:${contractId} -->`;

/** 契约表锚点的结束标记 */
export const CONTRACT_TABLE_CLOSE = '<!-- /contract-table -->';

/* ═══════════════════════════════════════════════════════════════════════════
 * §3 契约实例
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 键档位允许集（legacy 是历史只读档位） */
export const KEY_PROFILES: readonly string[] = ['v1', 'v2', 'legacy'];

/** 院内 14 类费用口径的取值允许集 */
export const FEE_CATEGORY_NAMES: readonly string[] = FEE_CATEGORIES.map((entry) => entry.name);

/**
 * 出站明细契约：一条耗材使用明细。
 *
 * 字段名与 `src/charge/submit.ts` 的 `MATERIAL_USE_FIELDS` **逐字一致**。
 */
export const MATERIAL_USE_CONTRACT: Contract = {
  id: 'material-use',
  title_zh: '耗材使用明细（出站）',
  direction: 'outbound',
  fields: [
    {
      name: 'material_code',
      type: 'string',
      required: true,
      max_length: 32,
      meaning_zh: '院内耗材码（归一后的规范码）',
    },
    {
      name: 'quantity',
      type: 'integer',
      required: true,
      min: 1,
      meaning_zh: '使用数量（正整数，计价单位口径）',
    },
    {
      name: 'price_code',
      type: 'string',
      required: true,
      max_length: 32,
      meaning_zh: '价码（耗材主数据的价格编码）',
    },
    {
      name: 'use_time',
      type: 'timestamp',
      required: true,
      meaning_zh: '使用时间（ISO 8601）',
    },
    {
      name: 'fee_category',
      type: 'string',
      required: true,
      enum: FEE_CATEGORY_NAMES,
      meaning_zh: '费用类别（院内 14 类口径；耗材只落卫生材料类）',
    },
    {
      name: 'medical_insurance_class',
      type: 'string',
      required: true,
      enum: MEDICAL_INSURANCE_CLASSES,
      meaning_zh: '医保分类（甲类 / 乙类 / 丙类）',
    },
    {
      name: 'idempotency_key',
      type: 'string',
      required: true,
      max_length: 64,
      meaning_zh: '行级幂等键（这一笔耗材消费的去重键，重投复用同一把）',
    },
    {
      name: 'key_profile',
      type: 'string',
      required: true,
      max_length: 16,
      enum: KEY_PROFILES,
      meaning_zh: '行级键档位（v1 / v2 / 历史行 legacy）',
    },
  ],
};

/**
 * 出站请求契约：一次计费提交。
 *
 * 字段名与 `src/charge/submit.ts` 的 `MATERIAL_USES_REQUEST_FIELDS` **逐字一致**。
 */
export const MATERIAL_USES_REQUEST_CONTRACT: Contract = {
  id: 'material-uses-request',
  title_zh: '耗材计费请求（出站）',
  direction: 'outbound',
  fields: [
    {
      name: 'operation_no',
      type: 'string',
      required: true,
      max_length: 64,
      meaning_zh: '手术台次号（这一批计费记到哪台手术）',
    },
    {
      name: 'dept_code',
      type: 'string',
      required: true,
      max_length: 32,
      meaning_zh: '台次所属科室编码',
    },
    {
      name: 'idempotency_key',
      type: 'string',
      required: true,
      max_length: 64,
      meaning_zh: '请求级幂等键（整批提交的去重键）',
    },
    {
      name: 'key_profile',
      type: 'string',
      required: true,
      max_length: 16,
      enum: KEY_PROFILES,
      meaning_zh: '请求级键档位（对端按版本灰度）',
    },
    {
      name: 'uses',
      type: 'array',
      required: true,
      item_contract: MATERIAL_USE_CONTRACT,
      meaning_zh: '耗材使用明细数组',
    },
  ],
};

/** 出站响应里的「已接收」条目契约 */
export const MATERIAL_ACCEPTED_CONTRACT: Contract = {
  id: 'material-accepted',
  title_zh: '计费回执 · 已接收条目',
  direction: 'outbound',
  fields: [
    {
      name: 'material_code',
      type: 'string',
      required: true,
      max_length: 64,
      meaning_zh: '被接收的耗材码',
    },
    {
      name: 'idempotency_key',
      type: 'string',
      required: false,
      max_length: 64,
      meaning_zh: '对端回显的行级键（对端未启用幂等时无此字段）',
    },
  ],
};

/** 出站响应里的「被拒」条目契约 */
export const MATERIAL_REJECTED_CONTRACT: Contract = {
  id: 'material-rejected',
  title_zh: '计费回执 · 被拒条目',
  direction: 'outbound',
  fields: [
    {
      name: 'material_code',
      type: 'string',
      required: true,
      max_length: 64,
      meaning_zh: '被拒的耗材码',
    },
    {
      name: 'reason_code',
      type: 'string',
      required: true,
      max_length: 64,
      meaning_zh: '拒绝原因码（处置档位见对端回执码契约）',
    },
    {
      name: 'idempotency_key',
      type: 'string',
      required: false,
      max_length: 64,
      meaning_zh: '对端回显的行级键（对端未启用幂等时无此字段）',
    },
  ],
};

/**
 * 出站响应契约：对端回执的形状。
 *
 * 「结构不符」按**对端协议不符**处理：进重投队列，**不静默当成成功**。
 */
export const MATERIAL_USES_RESPONSE_CONTRACT: Contract = {
  id: 'material-uses-response',
  title_zh: '耗材计费回执（出站响应）',
  direction: 'outbound',
  fields: [
    {
      name: 'accepted',
      type: 'array',
      required: true,
      item_contract: MATERIAL_ACCEPTED_CONTRACT,
      meaning_zh: '对端已接收的条目数组',
    },
    {
      name: 'rejected',
      type: 'array',
      required: true,
      item_contract: MATERIAL_REJECTED_CONTRACT,
      meaning_zh: '对端拒绝的条目数组',
    },
    {
      name: 'idempotency_key',
      type: 'string',
      required: false,
      max_length: 64,
      meaning_zh: '对端回显的请求级键（对端未启用幂等时无此字段）',
    },
  ],
};

/**
 * 入站明细契约：一条扫码。
 *
 * 字段名与《最小数据格式与字段要求》**逐字一致**。
 * 入站的 `material_code` 上限（64）比出站宽 —— 扫码枪能扫出来的码空间更大，
 * 归一之后才按出站口径（32）再拒一次。
 */
export const SCAN_ITEM_CONTRACT: Contract = {
  id: 'scan-item',
  title_zh: '单条扫码（入站明细）',
  direction: 'inbound',
  fields: [
    {
      name: 'material_code',
      type: 'string',
      required: true,
      max_length: 64,
      meaning_zh: '扫码枪读到的耗材码（UDI / GS1 / 院内码均可）',
    },
    {
      name: 'quantity',
      type: 'integer',
      required: true,
      min: 1,
      meaning_zh: '使用数量（正整数）',
    },
    {
      name: 'scan_time',
      type: 'timestamp',
      required: true,
      meaning_zh: '扫描时间（ISO 8601）',
    },
    {
      name: 'batch_no',
      type: 'string',
      required: false,
      max_length: 64,
      meaning_zh: '耗材批号（选填；用于键档位 v2 的去重维度）',
    },
  ],
};

/**
 * 入站信封契约：批次抬头（台次 / 手术间 / 扫码枪）。
 *
 * 抬头不合规 → **整批拒**：没有台次号就没有归属，条目无处可落。
 * 明细不合规 → 只拒**那一条**（见 `SCAN_ITEM_CONTRACT`）。
 */
export const SCAN_EVENT_ENVELOPE_CONTRACT: Contract = {
  id: 'scan-event-envelope',
  title_zh: '扫码批次抬头（入站）',
  direction: 'inbound',
  fields: [
    {
      name: 'operation_no',
      type: 'string',
      required: true,
      max_length: 64,
      meaning_zh: '手术台次号',
    },
    {
      name: 'room_no',
      type: 'string',
      required: true,
      max_length: 32,
      meaning_zh: '手术间号',
    },
    {
      name: 'scanner_id',
      type: 'string',
      required: true,
      max_length: 64,
      meaning_zh: '扫码枪 / 网关编号（追溯是谁扫的）',
    },
  ],
};

/** 入站整批契约：抬头 + 明细数组（文档与联调用） */
export const SCAN_EVENT_CONTRACT: Contract = {
  id: 'scan-event',
  title_zh: '扫码事件（入站）',
  direction: 'inbound',
  fields: [
    ...SCAN_EVENT_ENVELOPE_CONTRACT.fields,
    {
      name: 'scans',
      type: 'array',
      required: true,
      item_contract: SCAN_ITEM_CONTRACT,
      meaning_zh: '本批扫码明细数组',
    },
  ],
};

/** 全部契约（文档渲染与自检用） */
export const ALL_CONTRACTS: readonly Contract[] = [
  SCAN_EVENT_CONTRACT,
  SCAN_EVENT_ENVELOPE_CONTRACT,
  SCAN_ITEM_CONTRACT,
  MATERIAL_USES_REQUEST_CONTRACT,
  MATERIAL_USE_CONTRACT,
  MATERIAL_USES_RESPONSE_CONTRACT,
  MATERIAL_ACCEPTED_CONTRACT,
  MATERIAL_REJECTED_CONTRACT,
];

/** 把一组违规项渲染成中文短句（写进回执 / 核查条目 / 日志 detail） */
export function renderViolations(violations: readonly ContractViolation[]): string {
  return violations
    .map((violation) => `${violation.path} ${violation.message_zh}（期望 ${violation.expected}；实际 ${violation.actual}）`)
    .join('；');
}
