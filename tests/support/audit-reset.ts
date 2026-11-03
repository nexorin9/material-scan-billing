/**
 * 测试用：把审计链清空到「一条都没有」的状态。
 *
 * 为什么需要这个helper：v10 迁移给 `audit_chain` 装了**库层护栏**
 * （BEFORE UPDATE / BEFORE DELETE 触发器），库里直接 `DELETE FROM audit_chain`
 * 会被触发器拒绝 —— 这正是产品要的行为，但单测的 `beforeEach` 需要清库。
 *
 * 口径：临时摘掉护栏 → 清空 → 把 id 序列拨回 1 → **立刻把护栏装回去**。
 * 装回去之后，链从创世哈希重新开始，后续 append 仍然是一条完整的链
 * （首行 prev_hash = 创世哈希，行号从 1 连号）。
 *
 * 这个 helper 只在测试里用；产品代码里没有任何「清空审计链」的口子
 * （审计层不导出 update / delete）。
 */

import type { DatabaseSync } from 'node:sqlite';

import { AUDIT_IMMUTABILITY_TRIGGER_SQL } from '../../src/ledger/migrations.js';

/** 清空审计链并把护栏装回去 */
export function resetAuditChain(db: DatabaseSync): void {
  db.exec('DROP TRIGGER IF EXISTS trg_audit_chain_no_update');
  db.exec('DROP TRIGGER IF EXISTS trg_audit_chain_no_delete');
  db.exec('DELETE FROM audit_chain');
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'audit_chain'");
  db.exec(AUDIT_IMMUTABILITY_TRIGGER_SQL);
}

/**
 * 临时摘掉护栏（模拟「有人绕过触发器直接改库文件」），
 * 用来验证**第二道防线**（哈希链校验）确实能抓到篡改。
 *
 * 调用方必须在测试结束前调 `restoreAuditGuards` 把护栏装回去。
 */
export function disableAuditGuards(db: DatabaseSync): void {
  db.exec('DROP TRIGGER IF EXISTS trg_audit_chain_no_update');
  db.exec('DROP TRIGGER IF EXISTS trg_audit_chain_no_delete');
}

/** 把护栏装回去 */
export function restoreAuditGuards(db: DatabaseSync): void {
  db.exec(AUDIT_IMMUTABILITY_TRIGGER_SQL);
}
