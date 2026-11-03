/**
 * 幂等键派生与租约语义。
 *
 * 语义来源（源产品主路径）：源产品的批量唯一消息用「消息内容 + 目标实体 + 消息类型」
 * 三元组作为唯一键，同一条消息重复投递只产生一次投递与一份回执；源在缓存层另用
 * 「键前缀 + 唯一命名空间」的方式让不同代际的键并存（迁移期新旧键互不误判）。
 * 本产品把它改写成「耗材码 + 手术台次」，并把键**版本化**：
 *
 *   - 消息内容身份 → material_code（这一条扫码指的是哪个耗材）
 *   - 目标实体     → operation_no（这一条扫码挂在哪台手术）
 *   - 消息类型     → 恒为 material-use（不产生区分，故 v1 不入键）
 *   - 批号维度     → v2 才入键（同一耗材码的不同生产批次是两次真实消耗）
 *
 * 键档位（profile）：
 *   legacy —— 历史键格式 `sha256(material_code|operation_no)`。**只读档位**：
 *             升级前的台账行与占位行都是这个格式，程序不再新写，但认得它，
 *             保证升级后老行不会被当成新事件（不重复计费）。
 *   v1     —— `sha256("v1|material_code|operation_no")`。同一耗材同一台次只算一次
 *             （默认档位）：**批号不参与**，同码不同批仍判重复。
 *   v2     —— `sha256("v2|material_code|operation_no|batch_no")`。批号参与去重：
 *             同一耗材同一台次的**不同批号各算一次**（各产生一行台账与一次计费）。
 *
 * 关键不变量（三个档位都成立）：
 *   **幂等键与时间戳、重试次数、扫码枪编号无关**。
 *   只有「哪个耗材 + 哪台手术（+ 哪一档键口径）」决定一次计费；
 *   否则重投会被当成新事件，重复计费。
 *
 * 另有一层**请求级**键（`deriveRequestIdempotencyKey`）：一批提交整体的去重键，
 * 与行级键一起**透传给对端**（见 `src/charge/submit.ts`），
 * 让 HIS 计费侧也能按键去重 —— 本侧幂等只挡得住「自己重复发」，挡不住对端重试。
 */

import { createHash } from 'node:crypto';

export const IDEMPOTENCY_KEY_SEPARATOR = '|';

/** 键档位：legacy（历史只读）/ v1（码 + 台次）/ v2（码 + 台次 + 批号） */
export type IdempotencyKeyProfile = 'legacy' | 'v1' | 'v2';

/** 配置项可选的键档位（legacy 不给选：程序不再新写历史格式的键） */
export const CONFIGURABLE_IDEMPOTENCY_KEY_PROFILES = ['v1', 'v2'] as const;

export type ConfigurableIdempotencyKeyProfile =
  (typeof CONFIGURABLE_IDEMPOTENCY_KEY_PROFILES)[number];

/** 默认档位：v1（同码同台次只算一次，批号不参与） */
export const DEFAULT_IDEMPOTENCY_KEY_PROFILE: ConfigurableIdempotencyKeyProfile = 'v1';

/** 历史档位（只读）：升级前的台账行与占位行仍是这个格式 */
export const LEGACY_IDEMPOTENCY_KEY_PROFILE: IdempotencyKeyProfile = 'legacy';

export interface IdempotencyKeyParts {
  material_code: string;
  operation_no: string;
  /** 批号：v2 档位参与去重；v1 档位不参与 */
  batch_no?: string | null;
}

/** 派生结果：键值 + 实际生效的档位 + 参与哈希的原文（排障时能一眼看出用的是哪把尺子） */
export interface DerivedIdempotencyKey {
  /** sha256 十六进制小写 */
  key: string;
  /** 实际生效的档位（v2 缺批号时会降级成 v1，这里是降级后的真实档位） */
  profile: IdempotencyKeyProfile;
  /** 参与哈希的原文 */
  payload: string;
  /** 键里是否带批号维度 */
  batch_scoped: boolean;
  /** 请求的是 v2 但没带批号 → 已降级成 v1（批号未知时不细分，避免重复计费） */
  batch_missing: boolean;
}

/** 档位取值是否合法（配置项校验用；legacy 不算合法取值） */
export function isConfigurableKeyProfile(value: string): value is ConfigurableIdempotencyKeyProfile {
  return (CONFIGURABLE_IDEMPOTENCY_KEY_PROFILES as readonly string[]).includes(value);
}

/** 档位取值是否认识（含历史档位 legacy —— 读历史行时要用） */
export function isKnownKeyProfile(value: string): value is IdempotencyKeyProfile {
  return value === 'legacy' || isConfigurableKeyProfile(value);
}

/**
 * 参与哈希的原文。
 *
 * 档位写在原文**最前面**（`v1|` / `v2|`）—— 键里因此自带版本号，
 * 迁移期新旧两代键可以并存，旧键不会被新口径误判成同一笔。
 */
export function keyPayloadForProfile(
  parts: IdempotencyKeyParts,
  profile: IdempotencyKeyProfile,
): string {
  const material = parts.material_code.trim();
  const operation = parts.operation_no.trim();
  if (profile === 'legacy') {
    return `${material}${IDEMPOTENCY_KEY_SEPARATOR}${operation}`;
  }
  if (profile === 'v2') {
    const batch = (parts.batch_no ?? '').trim();
    return `v2${IDEMPOTENCY_KEY_SEPARATOR}${material}${IDEMPOTENCY_KEY_SEPARATOR}${operation}${IDEMPOTENCY_KEY_SEPARATOR}${batch}`;
  }
  return `v1${IDEMPOTENCY_KEY_SEPARATOR}${material}${IDEMPOTENCY_KEY_SEPARATOR}${operation}`;
}

/**
 * 按档位派生幂等键。
 *
 * v2 档位但**没有批号**时降级成 v1：批号未知就分不清「同一批重扫」与
 * 「另一批的同款耗材」，宁可按 v1 只算一次（不重复计费），也不冒重复计费的风险。
 * 降级事实由 `batch_missing` 标出来，调用方据此把台账行的键档位写成 v1。
 */
export function deriveIdempotencyKeyForProfile(
  parts: IdempotencyKeyParts,
  profile: IdempotencyKeyProfile,
): DerivedIdempotencyKey {
  const effectiveProfile: IdempotencyKeyProfile =
    profile === 'v2' && (parts.batch_no ?? '').trim().length === 0 ? 'v1' : profile;
  const payload = keyPayloadForProfile(parts, effectiveProfile);
  return {
    key: createHash('sha256').update(payload, 'utf8').digest('hex'),
    profile: effectiveProfile,
    payload,
    batch_scoped: effectiveProfile === 'v2',
    batch_missing: profile === 'v2' && effectiveProfile === 'v1',
  };
}

/**
 * **默认档位（v1）**的键派生：`sha256("v1|material_code|operation_no")`。
 *
 * 这是产品当前默认口径（同码同台次只算一次）。要按批号细分请用
 * `deriveIdempotencyKeyForProfile(parts, 'v2')`。
 */
export function deriveIdempotencyKey(material_code: string, operation_no: string): string {
  return deriveIdempotencyKeyFromParts({ material_code, operation_no });
}

export function deriveIdempotencyKeyFromParts(parts: IdempotencyKeyParts): string {
  const payload = keyPayloadForProfile(parts, 'v1');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * **历史格式**的键派生：`sha256("material_code|operation_no")`，十六进制小写。
 *
 * 保留这个函数是为了**读历史行**：升级前的台账行与占位行都是这个格式，
 * 迁移时要按它反查哪些行属于旧口径（见 `src/ledger/migrations.ts` 的 v11 迁移）。
 * 新写入一律走 v1 / v2 档位。
 */
export function deriveLegacyIdempotencyKey(material_code: string, operation_no: string): string {
  const payload = `${material_code}${IDEMPOTENCY_KEY_SEPARATOR}${operation_no}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * 从一条扫码事件派生**默认档位（v1）**的幂等键。
 * 刻意只取 material_code 与 operation_no：scan_time / batch_no / 扫码枪编号 /
 * 重试次数都不参与，否则同一笔消费会被算成多笔。
 */
export function deriveIdempotencyKeyFromEvent(event: {
  material_code: string;
  operation_no: string;
}): string {
  return deriveIdempotencyKey(event.material_code, event.operation_no);
}

/* ── 请求级幂等键（整批提交的去重键） ─────────────────────────────────── */

/** 请求级键的原文前缀（与行级键区分：行级键是「这一笔耗材」，请求级键是「这一批提交」） */
export const IDEMPOTENCY_REQUEST_KEY_PREFIX = 'req';

/** 请求级键的派生结果 */
export interface DerivedRequestIdempotencyKey {
  /** sha256 十六进制小写 */
  key: string;
  /** 参与哈希的原文 */
  payload: string;
  /** 本批涉及的行级键个数（去重后） */
  line_count: number;
}

/**
 * 派生**请求级**幂等键：整批提交的去重键。
 *
 * 原文：`req|<台次号>|<行级键1>|<行级键2>…`
 *
 * 两条口径说明：
 *   ① **行级键升序入哈希** —— 同一批条目无论以什么顺序提交，请求级键都一样；
 *      否则「同一批换个顺序重发」会被对端当成另一笔，重复计费。
 *   ② **不掺入档位前缀** —— 行级键本身已带档位（`v1|…` / `v2|…`），
 *      档位变了行级键就变，请求级键随之变；这里再掺一次只会多一处能配错的地方。
 *
 * 为什么要有请求级键：行级键防的是「同一条明细被计费两次」，
 * 请求级键防的是「同一个请求被送了两遍」—— 对端按请求级键整单丢弃时，
 * 一批明细不会重复落账。
 */
export function deriveRequestIdempotencyKey(
  operation_no: string,
  lineKeys: readonly string[],
): DerivedRequestIdempotencyKey {
  const unique = [...new Set(lineKeys.map((key) => (key ?? '').trim()).filter((key) => key.length > 0))]
    .sort();
  const payload = [
    IDEMPOTENCY_REQUEST_KEY_PREFIX,
    operation_no.trim(),
    ...unique,
  ].join(IDEMPOTENCY_KEY_SEPARATOR);
  return {
    key: createHash('sha256').update(payload, 'utf8').digest('hex'),
    payload,
    line_count: unique.length,
  };
}

/** 租约：占位不是永久锁，持有者崩溃后到期自动释放，由下一位接管 */
export type LeaseState = 'claimed' | 'confirmed' | 'released';

export interface Lease {
  key: string;
  token: string;
  acquiredAt: number;
  expiresAt: number;
  state: LeaseState;
}

export const DEFAULT_LEASE_MS = 30_000;

export function leaseExpiry(nowMs: number, leaseMs: number = DEFAULT_LEASE_MS): number {
  return nowMs + leaseMs;
}

export function isLeaseExpired(lease: Lease, nowMs: number): boolean {
  return nowMs >= lease.expiresAt;
}

/** 仍然有效的占位：已 claim、未 confirm/release、且未到期 */
export function isLeaseActive(lease: Lease, nowMs: number): boolean {
  return lease.state === 'claimed' && !isLeaseExpired(lease, nowMs);
}
