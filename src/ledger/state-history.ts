/**
 * 状态迁移轨迹：**只增不改**的迁移历史，供状态序列回放。
 *
 * 一条耗材条目从「扫到」到「闭环」会走过好几个状态，谁在什么时候把它推到哪一步，
 * 必须能原样回放 —— 内审与飞检语境下这是「台账可信」的前提。
 *
 * 每次成功迁移写一行 `state_transition`：
 *   from / to / actor / request_id / created_at
 * 每次**被拒**的越界迁移写一行 `state_transition_rejected`：
 *   多记一句「谁想把它推回哪一步、被拒的原因是什么」。
 *
 * 拒绝痕迹的落点有个细节：若调用方在事务里，事务内的写入会随回滚一起消失。
 * 因此「拒绝痕迹」由**事务外**的调用点补记（见 `src/check/task.ts` 的 confirmTask），
 * 保证「被拒」这件事本身不会因为业务事务回滚而查无实据。
 */

import type { DatabaseSync } from 'node:sqlite';

import { appendAudit } from './audit.js';
import type { BindingState, TransitionActor } from '../domain/state.js';

/** 成功迁移的审计事件类型 */
export const STATE_TRANSITION_EVENT = 'state_transition';
/** 被拒的越界迁移的审计事件类型 */
export const STATE_TRANSITION_REJECTED_EVENT = 'state_transition_rejected';

/** 非法迁移的错误码（与日志、核查条目展示同一个码） */
export const ERR_ILLEGAL_STATE_TRANSITION = 'ERR_ILLEGAL_STATE_TRANSITION';

export interface StateTransitionRecord {
  /** 迁移前的状态 */
  from: BindingState;
  /** 目标状态 */
  to: BindingState;
  /** 谁触发的这次迁移 */
  actor: TransitionActor | string;
  /** 幂等键（台账行键；可回溯到具体条目） */
  binding_key?: string | null;
  /** 台次号 */
  operation_no?: string | null;
  /** 耗材码 */
  material_code?: string | null;
  /** 本次投递 / 处置的请求标识 */
  request_id?: string | null;
  /** 中文说明（拒绝原因 / 迁移含义） */
  note?: string | null;
}

function detailOf(record: StateTransitionRecord): string {
  return JSON.stringify({
    from: record.from,
    to: record.to,
    actor: record.actor,
    request_id: record.request_id ?? null,
    material_code: record.material_code ?? null,
    note: record.note ?? null,
  });
}

/**
 * 记一次**成功**的状态迁移。
 *
 * 与台账行写在同一事务里（调用方决定事务边界）：台账推进了但审计行没落，
 * 或者审计行落了但台账没推，都是「说不清」的半写。
 */
export function recordStateTransition(db: DatabaseSync, record: StateTransitionRecord): number {
  return appendAudit(db, {
    event_type: STATE_TRANSITION_EVENT,
    binding_key: record.binding_key ?? null,
    operation_no: record.operation_no ?? null,
    actor: record.actor,
    request_id: record.request_id ?? null,
    detail: detailOf(record),
  });
}

/**
 * 记一次**被拒**的越界迁移。
 *
 * 只记事实，不动台账：被拒的那一步在业务上从未发生，留痕是为了事后能回答
 * 「谁在什么时候试图把这条耗材退回已计费前的状态」。
 */
export function recordRejectedTransition(db: DatabaseSync, record: StateTransitionRecord): number {
  return appendAudit(db, {
    event_type: STATE_TRANSITION_REJECTED_EVENT,
    binding_key: record.binding_key ?? null,
    operation_no: record.operation_no ?? null,
    actor: record.actor,
    request_id: record.request_id ?? null,
    detail: JSON.stringify({
      from: record.from,
      to: record.to,
      actor: record.actor,
      request_id: record.request_id ?? null,
      material_code: record.material_code ?? null,
      error_code: ERR_ILLEGAL_STATE_TRANSITION,
      note: record.note ?? null,
      rejected: true,
    }),
  });
}

/** 迁移轨迹的一行（回放用） */
export interface StateTransitionRow {
  id: number;
  event_type: string;
  binding_key: string | null;
  operation_no: string | null;
  actor: string | null;
  request_id: string | null;
  from: BindingState;
  to: BindingState;
  note: string | null;
  created_at: string;
}

interface RawTransitionRow {
  id: number;
  event_type: string;
  binding_key: string | null;
  operation_no: string | null;
  actor: string | null;
  request_id: string | null;
  detail: string | null;
  created_at: string;
}

function toTransitionRow(row: RawTransitionRow): StateTransitionRow {
  let parsed: { from?: BindingState; to?: BindingState; note?: string | null } = {};
  if (row.detail) {
    try {
      parsed = JSON.parse(row.detail) as typeof parsed;
    } catch {
      // 明细不是合法 JSON 时不中断回放：轨迹本身仍可读
      parsed = {};
    }
  }
  return {
    id: row.id,
    event_type: row.event_type,
    binding_key: row.binding_key,
    operation_no: row.operation_no,
    actor: row.actor,
    request_id: row.request_id,
    from: parsed.from ?? ('scanned' as BindingState),
    to: parsed.to ?? ('scanned' as BindingState),
    note: parsed.note ?? null,
    created_at: row.created_at,
  };
}

/** 查迁移轨迹（给了幂等键就只看那一条；不给就全量），按写入顺序 */
export function queryStateTransitions(
  db: DatabaseSync,
  binding_key?: string | null,
): StateTransitionRow[] {
  const sql = binding_key
    ? `SELECT id, event_type, binding_key, operation_no, actor, request_id, detail, created_at
         FROM audit_chain
        WHERE event_type IN (?, ?) AND binding_key = ?
        ORDER BY id ASC`
    : `SELECT id, event_type, binding_key, operation_no, actor, request_id, detail, created_at
         FROM audit_chain
        WHERE event_type IN (?, ?)
        ORDER BY id ASC`;
  const params = binding_key
    ? [STATE_TRANSITION_EVENT, STATE_TRANSITION_REJECTED_EVENT, binding_key]
    : [STATE_TRANSITION_EVENT, STATE_TRANSITION_REJECTED_EVENT];
  const rows = db.prepare(sql).all(...params) as unknown as RawTransitionRow[];
  return rows.map(toTransitionRow);
}

/**
 * 回放某一条耗材条目的状态序列（成功与被拒按写入顺序排在一起）。
 *
 * 顺序即事实：谁先谁后一目了然，不用再翻别的表对时间。
 */
export function replayStateSequence(
  db: DatabaseSync,
  binding_key: string,
): Array<StateTransitionRow & { rejected: boolean }> {
  return queryStateTransitions(db, binding_key).map((row) => ({
    ...row,
    rejected: row.event_type === STATE_TRANSITION_REJECTED_EVENT,
  }));
}

/** 某一条目被拒的迁移次数（越界尝试的计数） */
export function countRejectedTransitions(db: DatabaseSync, binding_key?: string | null): number {
  const sql = binding_key
    ? 'SELECT COUNT(*) AS n FROM audit_chain WHERE event_type = ? AND binding_key = ?'
    : 'SELECT COUNT(*) AS n FROM audit_chain WHERE event_type = ?';
  const row = (
    binding_key
      ? db.prepare(sql).get(STATE_TRANSITION_REJECTED_EVENT, binding_key)
      : db.prepare(sql).get(STATE_TRANSITION_REJECTED_EVENT)
  ) as { n: number };
  return row.n;
}
