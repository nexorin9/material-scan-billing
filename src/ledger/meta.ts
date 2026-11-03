/**
 * 进程元信息读写（`meta` 表）：心跳记录、守护进程启动信息、停机记录。
 *
 * 这一张表与审计链（`audit_chain`）**刻意分开**：
 *   - 审计链是只增不改的**业务事实**（谁扫的、扫在哪台次、是否重复、回写成没成功）；
 *   - `meta` 是**进程自身状态**（心跳每周期覆盖写一行、停机时写一条收尾记录）。
 * 两者混在一张表里，心跳会把审计链污染成一堆重复行 —— 台账能被改就不可信。
 */

import type { DatabaseSync } from 'node:sqlite';

export interface MetaRow {
  key: string;
  value: string;
  updated_at: string;
}

/**
 * 出站计费请求计数器的键名（`meta` 表）。
 *
 * 口径：**真的打出去一次对端的 HTTP 请求算 1 次**（不含被本地拒收、
 * 压根没发出去的条目）。重放与对账都用它证明「没有产生第二笔计费」。
 */
export const META_KEY_OUTBOUND_CALLS = 'charge_outbound_calls';

/** 写一条元信息（同键覆盖写） */
export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

/** 读一条元信息（没有则返回 null） */
export function getMeta(db: DatabaseSync, key: string): MetaRow | null {
  const row = db.prepare('SELECT key, value, updated_at FROM meta WHERE key = ?').get(key) as
    | MetaRow
    | undefined;
  return row ?? null;
}

/** 读一条元信息的文本值（没有则返回 null） */
export function getMetaText(db: DatabaseSync, key: string): string | null {
  return getMeta(db, key)?.value ?? null;
}

/**
 * 计数器自增（`meta` 表里的一行，**单调不减**）。
 *
 * 为什么要有它：重放要证明「同一区间重放两次，**计费调用次数**不变」。
 * 出站请求次数是**运行时事实**，回执行记的是「条目维度投了几次」，
 * 两者不是一个数 —— 所以必须有一个跨进程、跨重放都留得住的出站请求计数，
 * 否则「第二次没再打对端」这件事只能靠当次进程的内存数字作证。
 *
 * 计数只增不减：宁可多算一次，也不让某次失败把计数改小（那会让前后快照失去可比性）。
 */
export function addMetaCounter(db: DatabaseSync, key: string, delta = 1): number {
  const current = Number.parseInt(getMetaText(db, key) ?? '0', 10);
  const base = Number.isFinite(current) && current > 0 ? current : 0;
  const next = base + Math.max(0, Math.trunc(delta));
  setMeta(db, key, String(next));
  return next;
}

/** 读计数器（没有则按 0 算） */
export function getMetaCounter(db: DatabaseSync, key: string): number {
  const parsed = Number.parseInt(getMetaText(db, key) ?? '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
