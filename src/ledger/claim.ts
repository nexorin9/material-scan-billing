/**
 * 幂等占位层：claim / confirm / release 三段租约 + 崩溃续跑。
 *
 * 语义来源（源产品主路径）：源产品的批量唯一消息
 * `UniqueMessage{message_content, entity, message_type}` 由网关按**唯一键**去重后
 * 逐条回执（`MessageReceipt{delivery_count, active}`）—— 同一把唯一键只投递一次、
 * 只产生一份回执，重投不产生第二份投递。本层把这条语义落到存储：
 *
 *   claim   —— 原子占位（INSERT OR IGNORE）：拿到租约的人才允许继续处理；
 *   confirm —— 处理成功并落台账后转确认：同键再次投递直接判重复，不再重复计费；
 *   release —— 处理失败或放弃时释放，原因写审计链；租约到期也会自动释放。
 *
 * 三条硬约束：
 *   ① 同键重复投递只产生一条台账行、一次计费；
 *   ② 租约不是永久锁 —— 持有者崩溃后租约到期自动释放，由下一位接管并续跑，
 *      接管时 claim_count 递增（可看出被重试过几次），但台账仍只有一行；
 *   ③ confirm / release 必须校验 token：防止上一位持有者或误提交确认了别人的占位。
 *
 * 与「键派生」的关系：幂等键由 `src/domain/idempotency.ts` 派生
 * （sha256(material_code|operation_no)，与时间戳 / 重试次数 / 扫码枪编号无关），
 * 本层只负责「这把键当前归谁处理、归谁确认」。
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { DEFAULT_LEASE_MS } from '../domain/idempotency.js';
import { appendAudit } from './audit.js';

/** 占位状态：claimed（处理中） / confirmed（已确认） / released（已释放） */
export type ClaimState = 'claimed' | 'confirmed' | 'released';

export const CLAIM_STATES: readonly ClaimState[] = ['claimed', 'confirmed', 'released'];

/**
 * claim 的三种结论：
 *   claimed   —— 拿到租约，可以继续处理；
 *   busy      —— 别人正持有未过期的租约，**不重复处理**（本条不落台账）；
 *   duplicate —— 这把键已经确认过（同一笔已入台账），直接判重复。
 */
export type ClaimStatus = 'claimed' | 'busy' | 'duplicate';

export interface ClaimRow {
  key: string;
  token: string;
  state: ClaimState;
  claim_count: number;
  operation_no: string | null;
  material_code: string | null;
  scanner_id: string | null;
  claimed_at: string;
  expires_at_ms: number;
  confirmed_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  updated_at: string;
}

export interface ClaimOptions {
  /** 租约时长（毫秒）；缺省 30s */
  leaseMs?: number;
  /** 当前时间（毫秒），测试可注入 */
  nowMs?: number;
  operation_no?: string | null;
  material_code?: string | null;
  scanner_id?: string | null;
  /**
   * 本次投递的标识（溯源用）。
   *
   * 占位与确认都会往审计链留一行；带上 request_id 后，
   * 「这一笔是哪一次扫码带进来的」在审计链里也查得到。
   */
  request_id?: string | null;
}

export interface ClaimResult {
  status: ClaimStatus;
  key: string;
  /** 租约令牌：只有 claimed 时非空，confirm / release 都要带上 */
  token: string | null;
  /** 租约到期时刻（epoch 毫秒） */
  expiresAtMs: number | null;
  /** 这把键被占位过几次（首次为 1，接管一次 +1） */
  claimCount: number;
  /** 本次是否是从过期 / 已释放的占位接管而来 */
  tookOver: boolean;
}

export interface ConfirmResult {
  key: string;
  confirmedAt: string;
  /** 之前已确认过（幂等重复确认） */
  alreadyConfirmed: boolean;
}

export interface ReleaseResult {
  key: string;
  releasedAt: string;
  reason: string;
}

export interface RequeuedClaim {
  key: string;
  operation_no: string | null;
  material_code: string | null;
  scanner_id: string | null;
  claimCount: number;
}

export const ERR_CLAIM_NOT_FOUND = 'ERR_CLAIM_NOT_FOUND';
export const ERR_CLAIM_TOKEN_MISMATCH = 'ERR_CLAIM_TOKEN_MISMATCH';
export const ERR_CLAIM_RELEASED = 'ERR_CLAIM_RELEASED';
export const ERR_CLAIM_ALREADY_CONFIRMED = 'ERR_CLAIM_ALREADY_CONFIRMED';

export class ClaimError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly key: string,
  ) {
    super(message);
    this.name = 'ClaimError';
  }
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/** 读占位行 */
export function getClaim(db: DatabaseSync, key: string): ClaimRow | undefined {
  return db.prepare('SELECT * FROM idempotency_claim WHERE key = ?').get(key) as unknown as
    | ClaimRow
    | undefined;
}

/**
 * 占位（原子）。
 *
 * 首次占位走 `INSERT OR IGNORE`（唯一键 = 幂等键），成功即拿到租约；
 * 已存在时按状态分流：
 *   confirmed → duplicate（同键重复投递，不再处理）
 *   claimed 且租约未过期 → busy（不重复处理）
 *   claimed 但租约已过期 / released → 接管（换 token、claim_count +1）
 */
export function claim(db: DatabaseSync, key: string, options: ClaimOptions = {}): ClaimResult {
  const nowMs = options.nowMs ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const expiresAtMs = nowMs + leaseMs;
  const token = randomUUID();
  const iso = nowIso(nowMs);

  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO idempotency_claim
         (key, token, state, claim_count, operation_no, material_code, scanner_id,
          claimed_at, expires_at_ms, updated_at)
       VALUES (?, ?, 'claimed', 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      key,
      token,
      options.operation_no ?? null,
      options.material_code ?? null,
      options.scanner_id ?? null,
      iso,
      expiresAtMs,
      iso,
    );

  if (Number(inserted.changes) === 1) {
    return { status: 'claimed', key, token, expiresAtMs, claimCount: 1, tookOver: false };
  }

  const row = getClaim(db, key);
  if (!row) {
    // INSERT OR IGNORE 刚失败却又读不到行：只可能是并发下的极端情形，重试一次
    const retry = db
      .prepare(
        `INSERT OR IGNORE INTO idempotency_claim
           (key, token, state, claim_count, operation_no, material_code, scanner_id,
            claimed_at, expires_at_ms, updated_at)
         VALUES (?, ?, 'claimed', 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        token,
        options.operation_no ?? null,
        options.material_code ?? null,
        options.scanner_id ?? null,
        iso,
        expiresAtMs,
        iso,
      );
    if (Number(retry.changes) === 1) {
      return { status: 'claimed', key, token, expiresAtMs, claimCount: 1, tookOver: false };
    }
    throw new ClaimError(ERR_CLAIM_NOT_FOUND, `幂等键 ${key} 的占位行不可读`, key);
  }

  if (row.state === 'confirmed') {
    return {
      status: 'duplicate',
      key,
      token: null,
      expiresAtMs: null,
      claimCount: row.claim_count,
      tookOver: false,
    };
  }

  if (row.state === 'claimed' && row.expires_at_ms > nowMs) {
    // 租约仍然有效：别人正处理这一条，本条不重复处理
    return {
      status: 'busy',
      key,
      token: null,
      expiresAtMs: row.expires_at_ms,
      claimCount: row.claim_count,
      tookOver: false,
    };
  }

  // 租约已过期 或 上一轮已释放 → 接管
  const takeover = db
    .prepare(
      `UPDATE idempotency_claim
          SET token = ?, state = 'claimed', claim_count = claim_count + 1,
              operation_no = COALESCE(?, operation_no),
              material_code = COALESCE(?, material_code),
              scanner_id = COALESCE(?, scanner_id),
              claimed_at = ?, expires_at_ms = ?, updated_at = ?
        WHERE key = ? AND token = ? AND state = ?`,
    )
    .run(
      token,
      options.operation_no ?? null,
      options.material_code ?? null,
      options.scanner_id ?? null,
      iso,
      expiresAtMs,
      iso,
      key,
      row.token,
      row.state,
    );

  if (Number(takeover.changes) === 1) {
    return {
      status: 'claimed',
      key,
      token,
      expiresAtMs,
      claimCount: row.claim_count + 1,
      tookOver: true,
    };
  }

  // 接管失败 = 这一刻被别的持有者抢走了：本条按 busy 处理，不重复处理
  const latest = getClaim(db, key);
  return {
    status: latest?.state === 'confirmed' ? 'duplicate' : 'busy',
    key,
    token: null,
    expiresAtMs: latest?.expires_at_ms ?? null,
    claimCount: latest?.claim_count ?? row.claim_count,
    tookOver: false,
  };
}

/**
 * 确认（处理成功并已落台账）。
 * token 不符一律拒绝：防止上一位持有者或误提交确认了别人的占位。
 */
export function confirm(
  db: DatabaseSync,
  key: string,
  token: string,
  options: { nowMs?: number; request_id?: string | null } = {},
): ConfirmResult {
  const nowMs = options.nowMs ?? Date.now();
  const row = getClaim(db, key);
  if (!row) throw new ClaimError(ERR_CLAIM_NOT_FOUND, `幂等键 ${key} 没有占位行`, key);
  if (row.token !== token) {
    throw new ClaimError(ERR_CLAIM_TOKEN_MISMATCH, `幂等键 ${key} 的租约令牌不符，拒绝确认`, key);
  }
  if (row.state === 'confirmed') {
    return { key, confirmedAt: row.confirmed_at ?? nowIso(nowMs), alreadyConfirmed: true };
  }
  if (row.state === 'released') {
    throw new ClaimError(ERR_CLAIM_RELEASED, `幂等键 ${key} 的占位已释放，不能确认`, key);
  }

  const iso = nowIso(nowMs);
  db.prepare(
    `UPDATE idempotency_claim
        SET state = 'confirmed', confirmed_at = ?, updated_at = ?
      WHERE key = ? AND token = ? AND state = 'claimed'`,
  ).run(iso, iso, key, token);

  appendAudit(db, {
    event_type: 'claim_confirmed',
    binding_key: key,
    operation_no: row.operation_no,
    scanner_id: row.scanner_id,
    actor: 'claim',
    request_id: options.request_id ?? null,
    detail: `幂等键已确认，台账行只此一条（claim_count=${row.claim_count}）`,
  });

  return { key, confirmedAt: iso, alreadyConfirmed: false };
}

/**
 * 释放（处理失败 / 放弃 / 主动让出）：原因写审计链。
 * 已确认的占位不允许释放 —— 那条已经落台账并计费，释放等于凭空撤回。
 */
export function release(
  db: DatabaseSync,
  key: string,
  token: string,
  reason: string,
  options: { nowMs?: number; request_id?: string | null } = {},
): ReleaseResult {
  const nowMs = options.nowMs ?? Date.now();
  const row = getClaim(db, key);
  if (!row) throw new ClaimError(ERR_CLAIM_NOT_FOUND, `幂等键 ${key} 没有占位行`, key);
  if (row.token !== token) {
    throw new ClaimError(ERR_CLAIM_TOKEN_MISMATCH, `幂等键 ${key} 的租约令牌不符，拒绝释放`, key);
  }
  if (row.state === 'confirmed') {
    throw new ClaimError(
      ERR_CLAIM_ALREADY_CONFIRMED,
      `幂等键 ${key} 已确认（台账已落行），不允许释放`,
      key,
    );
  }

  const iso = nowIso(nowMs);
  db.prepare(
    `UPDATE idempotency_claim
        SET state = 'released', released_at = ?, release_reason = ?, updated_at = ?
      WHERE key = ? AND token = ? AND state = 'claimed'`,
  ).run(iso, reason, iso, key, token);

  appendAudit(db, {
    event_type: 'claim_released',
    binding_key: key,
    operation_no: row.operation_no,
    scanner_id: row.scanner_id,
    actor: 'claim',
    request_id: options.request_id ?? null,
    detail: `释放原因：${reason}`,
  });

  return { key, releasedAt: iso, reason };
}

/**
 * 扫描租约已过期的未确认占位并重新入队。
 *
 * 进程启动时调用一次：上一轮崩溃留下的占位在此被释放并交回处理队列，
 * 由下一位接管续跑（接管时 claim_count 递增，但台账仍只有一行、不重复计费）。
 */
export function requeueExpired(
  db: DatabaseSync,
  options: { nowMs?: number } = {},
): RequeuedClaim[] {
  const nowMs = options.nowMs ?? Date.now();
  const iso = nowIso(nowMs);
  const rows = db
    .prepare(
      `SELECT key, operation_no, material_code, scanner_id, claim_count
         FROM idempotency_claim
        WHERE state = 'claimed' AND expires_at_ms <= ?`,
    )
    .all(nowMs) as unknown as Array<{
    key: string;
    operation_no: string | null;
    material_code: string | null;
    scanner_id: string | null;
    claim_count: number;
  }>;

  const requeued: RequeuedClaim[] = [];
  for (const row of rows) {
    const updated = db
      .prepare(
        `UPDATE idempotency_claim
            SET state = 'released', released_at = ?, release_reason = 'LEASE_EXPIRED', updated_at = ?
          WHERE key = ? AND state = 'claimed'`,
      )
      .run(iso, iso, row.key);
    if (Number(updated.changes) !== 1) continue;

    appendAudit(db, {
      event_type: 'claim_lease_expired',
      binding_key: row.key,
      operation_no: row.operation_no,
      scanner_id: row.scanner_id,
      actor: 'claim',
      detail: `租约到期未确认，重新入队续跑（原 claim_count=${row.claim_count}）`,
    });

    requeued.push({
      key: row.key,
      operation_no: row.operation_no,
      material_code: row.material_code,
      scanner_id: row.scanner_id,
      claimCount: row.claim_count,
    });
  }
  return requeued;
}

/** 占位总行数 */
export function countClaims(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM idempotency_claim').get() as { n: number };
  return row.n;
}

/** 仍被有效租约占着的行数（claimed 且未到期） */
export function countActiveClaims(db: DatabaseSync, nowMs: number = Date.now()): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM idempotency_claim WHERE state = 'claimed' AND expires_at_ms > ?`)
    .get(nowMs) as { n: number };
  return row.n;
}
