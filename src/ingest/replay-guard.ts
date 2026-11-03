/**
 * 入站重放防护的**第二层**：nonce 去重存储。
 *
 * 三层叠加，逐层收紧：
 *   ① **时间戳窗口**（`src/ingest/signature.ts`）—— 抓到的报文隔天再放，签名早就过期；
 *   ② **nonce 去重**（本模块）—— 同一个 nonce 在 TTL 内只准进一次；
 *   ③ **幂等键**（`src/domain/idempotency.ts`）—— 就算前两层都被绕过，
 *      同码同台次也只可能产生一行台账、一次计费。
 *
 * 为什么 nonce 必须**落在签名内容里**（`{timestamp}.{nonce}.{raw_body}`）：
 *   只把 nonce 放请求头的话，抓包的人改个时间戳重算签名就能换一个 nonce 混进来；
 *   nonce 进了签名内容，改时间戳就必须重算签名，而重算之后**nonce 还是原来那个** ——
 *   第二层照样把它拦下。三层里第二层挡的就是这一路。
 *
 * 存储落在台账 SQLite（`replay_nonce` 表）而不是内存：
 *   守护进程重启后，内存里的 nonce 记录会**清零**，抓包重放就能趁重启混进来；
 *   落盘则重启不丢，TTL 到了由清理周期回收。
 *
 * 与源产品的对应：源产品在共享网关上为每条投递留一份逐目标回执
 * （`delivery_count` / `active`，见 `crates/connection_gateway_models/src/lib.rs`），
 * 「同一条消息只算一次、投递了几次看得见」是它那边的既有语义；
 * 本模块把这条语义落到**入站侧**：同一条扫码报文只准进一次，
 * 进了几次、被重放挡下几次，都在审计链里逐条留痕。
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** nonce 默认存活时长（秒）：比时间戳窗口（300s）宽一倍，留出换戳重放的余量 */
export const DEFAULT_NONCE_TTL_SEC = 600;

/** nonce 清理周期默认值（毫秒）：多久扫一次过期记录 */
export const DEFAULT_NONCE_CLEANUP_INTERVAL_MS = 60_000;

/** nonce 长度上下限（字符）：太短的挡不住猜，太长的没意义 */
export const MIN_NONCE_LENGTH = 8;
export const MAX_NONCE_LENGTH = 128;

/** 允许的字符集：URL 安全字符（设备侧一般用 UUID 或十六进制串） */
const NONCE_PATTERN = /^[A-Za-z0-9._~:+=@-]{8,128}$/;

/** nonce 缺失 / 格式非法 */
export const ERR_MISSING_NONCE = 'ERR_MISSING_NONCE';

/** nonce 命中（同一 nonce 在 TTL 内第二次出现） */
export const ERR_REPLAY_NONCE_REPLAY = 'ERR_REPLAY_NONCE_REPLAY';

/** 生成一个合规的 nonce（设备侧与测试用同一套规则） */
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

/** nonce 格式是否合规（非空、长度在界内、字符集合法） */
export function isValidNonce(nonce: string | undefined | null): boolean {
  if (typeof nonce !== 'string') return false;
  const value = nonce.trim();
  if (value.length < MIN_NONCE_LENGTH || value.length > MAX_NONCE_LENGTH) return false;
  return NONCE_PATTERN.test(value);
}

/** 占位结果 */
export type NonceClaim =
  | {
      ok: true;
      nonce: string;
      /** 本次占位时刻 */
      first_seen_at: string;
      /** 过期时刻 */
      expires_at: string;
    }
  | {
      ok: false;
      /** 失败原因码（ERR_REPLAY_NONCE_REPLAY） */
      code: string;
      nonce: string;
      /** 首次被看到的时间（这一条 replay 之前就已经有记录了） */
      first_seen_at: string;
      /** 首次占位的过期时刻 */
      expires_at: string;
      /** 中文说明 */
      message: string;
    };

export interface NonceClaimOptions {
  /** 存活时长（秒），默认 600 */
  ttlSec?: number;
  /** 当前时间（毫秒），测试可注入 */
  nowMs?: number;
  /** 来源（scanner_http / rfid_dir），只作留痕用 */
  source?: string | null;
}

/**
 * 占位一个 nonce：TTL 内第一次出现 → 放行；第二次出现 → 拒绝（按重放处理）。
 *
 * 原子性：先删掉这个 nonce 自己的过期记录，再 `INSERT OR IGNORE` 占位 ——
 * 两步都在**写事务**里（`BEGIN IMMEDIATE`），并发两个请求同时到，
 * 只有一个能占到位，另一个被判重放。不会两个请求都以为自己第一次来。
 *
 * 已过期的旧记录允许重新使用（TTL 到了就作废）：nonce 只在 TTL 内唯一，
 * 过了期就是新的一次投递。
 */
export function claimNonce(
  db: DatabaseSync,
  nonce: string,
  options: NonceClaimOptions = {},
): NonceClaim {
  const ttlSec = options.ttlSec ?? DEFAULT_NONCE_TTL_SEC;
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + Math.max(1, ttlSec) * 1000).toISOString();

  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    // 本 nonce 的旧记录若已过期 → 先清掉，让这次投递能重新占位
    db.prepare('DELETE FROM replay_nonce WHERE nonce = ? AND expires_at <= ?').run(nonce, nowIso);
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO replay_nonce (nonce, first_seen_at, expires_at, source)
         VALUES (?, ?, ?, ?)`,
      )
      .run(nonce, nowIso, expiresIso, options.source ?? null);
    const inserted = Number(result.changes) > 0;

    if (inserted) {
      if (ownsTransaction) db.exec('COMMIT');
      return { ok: true, nonce, first_seen_at: nowIso, expires_at: expiresIso };
    }

    // 已被占过：读出首次占位信息（TTL 内 = 重放）
    const existing = db
      .prepare('SELECT first_seen_at, expires_at FROM replay_nonce WHERE nonce = ?')
      .get(nonce) as { first_seen_at: string; expires_at: string } | undefined;
    if (ownsTransaction) db.exec('COMMIT');
    const firstSeenAt = existing?.first_seen_at ?? nowIso;
    const expiresAt = existing?.expires_at ?? expiresIso;
    return {
      ok: false,
      code: ERR_REPLAY_NONCE_REPLAY,
      nonce,
      first_seen_at: firstSeenAt,
      expires_at: expiresAt,
      message: '同一 nonce 在有效期内重复投递，已按重放拒绝（不会产生台账行，也不会触发计费）',
    };
  } catch (error) {
    if (ownsTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败时保留原始异常：失败不静默改数据
      }
    }
    throw error;
  }
}

/** 清掉过期 nonce 记录；返回清掉了几条（doctor 里能看到清理前后的计数） */
export function cleanupExpiredNonces(db: DatabaseSync, nowMs: number = Date.now()): number {
  const nowIso = new Date(nowMs).toISOString();
  const result = db.prepare('DELETE FROM replay_nonce WHERE expires_at <= ?').run(nowIso);
  return Number(result.changes);
}

/** 当前存着的 nonce 条数（含已过期但还没清理的） */
export function countNonces(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM replay_nonce').get() as { n: number };
  return row.n;
}

/** 已过期但还没清理的 nonce 条数 */
export function countExpiredNonces(db: DatabaseSync, nowMs: number = Date.now()): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM replay_nonce WHERE expires_at <= ?')
    .get(new Date(nowMs).toISOString()) as { n: number };
  return row.n;
}

/** 最近一次过期时刻（doctor 展示用；没有记录时为 null） */
export function lastNonceExpiry(db: DatabaseSync): string | null {
  const row = db
    .prepare('SELECT MAX(expires_at) AS at FROM replay_nonce')
    .get() as { at: string | null } | undefined;
  return row?.at ?? null;
}
