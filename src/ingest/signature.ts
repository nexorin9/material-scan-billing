/**
 * 入站签名：HMAC-SHA256 over `{timestamp}.{nonce}.{raw_body}`。
 *
 * 语义来源（源产品主路径）：源产品在服务入口用 `requiredVars` 逐项检查环境变量，
 * 缺失即打印变量名并 `process.exit(1)` —— 缺位 = 拒绝启动，绝不带着空凭据继续跑。
 * 入站验签把这条语义改写成**逐请求 fail closed**：密钥为空 / 签名不匹配 / 时间戳过期 /
 * nonce 缺失，一律拒绝并返回 401，**台账不落任何行**。
 *
 * 签名值格式：`v1=<hex>`（与 spec.md「最小数据格式与字段要求」逐字一致）。
 * 比较用常量时间，避免逐字节早退泄露信息。
 *
 * **nonce 为什么进了签名内容**：只把 nonce 放请求头，抓包的人改个时间戳重算签名
 * 就能换一个 nonce 混进来；nonce 进了签名内容，改时间戳就得重算签名，
 * 而重算之后 nonce 还是原来那个 —— 第二层（`src/ingest/replay-guard.ts`）照样拦下。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { ERR_MISSING_NONCE, isValidNonce } from './replay-guard.js';

/** 签名版本前缀 */
export const SIGNATURE_VERSION = 'v1';

/** 时间戳容差窗口（秒）：过期或超前过远一律拒绝，挡住重放 */
export const DEFAULT_TIMESTAMP_TOLERANCE_SEC = 300;

/** 错误码（与 docs/api/errors.md 的错误码表同源） */
export const ERR_INVALID_SIGNATURE = 'ERR_INVALID_SIGNATURE';
export const ERR_MISSING_SIGNATURE = 'ERR_MISSING_SIGNATURE';
export const ERR_STALE_TIMESTAMP = 'ERR_STALE_TIMESTAMP';
export const ERR_BAD_AUTHORIZATION = 'ERR_BAD_AUTHORIZATION';

export interface SignatureOptions {
  /** 当前时间（毫秒）；测试可注入 */
  nowMs?: number;
  /** 时间戳容差窗口（秒），默认 300 */
  toleranceSec?: number;
}

export type SignatureCheck =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * 拼签名原文：`{timestamp}.{nonce}.{raw_body}`。
 *
 * nonce 在中间：时间戳在前（窗口判定）、nonce 居中（重放判定）、报文在后（防篡改）。
 */
export function buildSigningPayload(timestamp: string, nonce: string, rawBody: string): string {
  return `${timestamp}.${nonce}.${rawBody}`;
}

/**
 * 计算签名：HMAC-SHA256 over `{timestamp}.{nonce}.{raw_body}`，十六进制小写。
 * 密钥为空时返回空串 —— 调用方必须先判空（fail closed），不拿空密钥算出一个「合法」签名。
 */
export function computeSignature(
  timestamp: string,
  nonce: string,
  rawBody: string,
  secret: string,
): string {
  if (!secret) return '';
  return createHmac('sha256', secret).update(buildSigningPayload(timestamp, nonce, rawBody)).digest('hex');
}

/** 组装请求头用的签名值：`v1=<hex>` */
export function formatSignatureHeader(
  timestamp: string,
  nonce: string,
  rawBody: string,
  secret: string,
): string {
  const hex = computeSignature(timestamp, nonce, rawBody, secret);
  return hex ? `${SIGNATURE_VERSION}=${hex}` : '';
}

/** 拆出签名头里的十六进制部分（兼容带 / 不带 `v1=` 前缀） */
export function parseSignatureHeader(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const value = header.trim();
  if (!value) return null;
  const withPrefix = value.startsWith(`${SIGNATURE_VERSION}=`);
  const hex = withPrefix ? value.slice(SIGNATURE_VERSION.length + 1) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  return hex.toLowerCase();
}

/** 时间戳是否在容差窗口内（过期 / 超前过远都算不可信） */
export function isTimestampFresh(
  timestamp: string,
  nowMs: number = Date.now(),
  toleranceSec: number = DEFAULT_TIMESTAMP_TOLERANCE_SEC,
): boolean {
  const seconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(seconds)) return false;
  const deltaSec = Math.abs(nowMs / 1000 - seconds);
  return deltaSec <= toleranceSec;
}

/** 常量时间比较两个十六进制串（长度不同直接判不等，不早退） */
function constantTimeHexEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 验签：HMAC-SHA256 over `{timestamp}.{nonce}.{raw_body}`，十六进制常量时间比较。
 *
 * 语义（fail closed）：
 *   - secret 为空 → 直接失败，不拿空密钥兜底；
 *   - 缺少待校验的签名值 → 直接失败；
 *   - 签名头格式非法 → 失败；
 *   - nonce 缺失或格式非法 → 失败（没有 nonce 就没法判重放）；
 *   - 时间戳超出容差窗口 → 失败（防重放）；
 *   - 十六进制不匹配 → 失败。
 *
 * `providedSignature` 可以是 `v1=<hex>` 原始请求头，也可以是裸 hex。
 */
export function verifySignature(
  timestamp: string | undefined,
  nonce: string | undefined,
  rawBody: string,
  secret: string,
  providedSignature?: string | null,
  options: SignatureOptions = {},
): boolean {
  if (!secret) return false;
  if (!timestamp) return false;
  if (!isValidNonce(nonce)) return false;
  const toleranceSec = options.toleranceSec ?? DEFAULT_TIMESTAMP_TOLERANCE_SEC;
  if (!isTimestampFresh(timestamp, options.nowMs ?? Date.now(), toleranceSec)) return false;
  const provided = parseSignatureHeader(providedSignature ?? undefined);
  if (!provided) return false;
  const expected = computeSignature(timestamp, nonce as string, rawBody, secret);
  if (!expected) return false;
  return constantTimeHexEquals(expected, provided);
}

/**
 * 验签（带原因码）：入站服务用这个，好把「为什么拒」落到日志与错误码表上。
 *
 * 原因码分开给，是为了信息科一眼分清「过期」与「签名不符」：
 *   - 过期 → 设备时钟漂移，校时钟重发即可；
 *   - 签名不符 → 两边密钥不一致（配置漂移），重发多少次都没用。
 */
export function checkSignature(
  timestamp: string | undefined,
  nonce: string | undefined,
  rawBody: string,
  secret: string,
  signatureHeader: string | undefined,
  options: SignatureOptions = {},
): SignatureCheck {
  if (!secret) {
    return { ok: false, code: ERR_MISSING_SIGNATURE, message: '入站签名密钥未配置，已拒绝该请求' };
  }
  if (!timestamp) {
    return { ok: false, code: ERR_MISSING_SIGNATURE, message: '缺少 X-Scan-Timestamp 请求头' };
  }
  const toleranceSec = options.toleranceSec ?? DEFAULT_TIMESTAMP_TOLERANCE_SEC;
  if (!isTimestampFresh(timestamp, options.nowMs ?? Date.now(), toleranceSec)) {
    return {
      ok: false,
      code: ERR_STALE_TIMESTAMP,
      message: `请求时间戳超出 ${toleranceSec} 秒容差窗口，已拒绝`,
    };
  }
  if (!isValidNonce(nonce)) {
    return {
      ok: false,
      code: ERR_MISSING_NONCE,
      message: '缺少或格式非法的 X-Scan-Nonce 请求头（没有 nonce 就没法判重放）',
    };
  }
  const provided = parseSignatureHeader(signatureHeader);
  if (!provided) {
    return { ok: false, code: ERR_MISSING_SIGNATURE, message: '缺少或格式非法的 X-Scan-Signature 请求头' };
  }
  const expected = computeSignature(timestamp, nonce as string, rawBody, secret);
  if (!expected || !constantTimeHexEquals(expected, provided)) {
    return { ok: false, code: ERR_INVALID_SIGNATURE, message: '签名校验不通过' };
  }
  return { ok: true };
}

/**
 * Bearer 令牌比对（常量时间）：设备侧调用入站接口时携带 `Authorization: Bearer <token>`。
 */
export function verifyBearerToken(header: string | undefined, token: string): boolean {
  if (!token) return false;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const provided = match[1].trim();
  const expected = token.trim();
  const bufA = Buffer.from(provided);
  const bufB = Buffer.from(expected);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
