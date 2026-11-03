/**
 * 核查任务台账：异常条目 → **带台次上下文**的核查条目 → 人工确认闭环 / 撤回。
 *
 * 核查条目回答护士长与高值耗材管理岗最需要的三件事：
 *   ① 这条耗材扫在哪台手术（台次 / 手术间 / 科室 / 扫码枪）；
 *   ② 系统为什么判它异常（结论 + 原因码）；
 *   ③ 跨台次重复时，**先到者**绑在哪台次、哪间手术间（source_operation_no / source_room_no）。
 *
 * 闭环路径：
 *   异常条目 --创建--> 核查条目(pending) --人工确认--> 核查条目(closed) + 台账行(closed)
 *                                          --人工撤回--> 核查条目(pending) + 台账行(check_pending)
 *
 * 四条硬约束：
 *   ① **双向挂接** —— 核查条目 ↔ 耗材使用台账行互相可查（check_task.binding_id ↔
 *      material_binding.check_task_id），人工结论要能回写到具体那一条台账行；
 *   ② **不静默改数据** —— 核查条目行、台账行、审计行同事务提交或同事务回滚；
 *   ③ **白名单外迁移一律拒绝** —— 台账状态推不到「已闭环」就整体拒绝，不留半写；
 *   ④ **已回写计费的条目不自动冲正** —— 撤回只把条目退回待核查，计费侧一概不动。
 *
 * 幂等：同一台次 + 同一耗材 + 同一原因码的**待处理**条目只留一条 ——
 * 重复投递同一次扫码不会刷出一堆重复待办。
 *
 * 迁移留痕：每次成功的人工确认 / 撤回都在审计链留一行状态迁移轨迹（from / to / actor），
 * 状态序列可回放；**被拒**的越界迁移在事务外补记一行拒绝痕迹 ——
 * 事务回滚不该把「有人试图越界」这件事一起抹掉。
 *
 * 责任岗位路由（按异常类型分派、提醒与升级）落在 `src/check/route.ts`（后续任务）。
 */

import type { DatabaseSync } from 'node:sqlite';

import { errorCodeForReason } from '../log/error-codes.js';

import {
  StateTransitionError,
  type BindingState,
} from '../domain/state.js';
import {
  findBindingById,
  findLatestBindingByCodeAndOperation,
  manualRevokeBindingStatus,
  transitionBindingStatus,
  type BindingRowRef,
} from '../ledger/binding-repo.js';
import { appendAudit } from '../ledger/audit.js';
import { recordRejectedTransition } from '../ledger/state-history.js';
import { resolveAssignee } from './route.js';

export interface CheckTaskPayload {
  /** 当前台次（本次扫码挂的台次） */
  operation_no: string;
  /** 当前手术间（事件里的手术间） */
  room_no: string;
  /** 科室编码 */
  dept_code?: string | null;
  /** 扫码枪编号 */
  scanner_id?: string | null;
  /** 耗材码（归一后） */
  material_code: string;
  /** 数量 */
  quantity?: number | null;
  /** 绑定结论 */
  conclusion: string;
  /** 原因码 */
  reason_code: string;
  /**
   * 统一错误码（ERR_*）。
   *
   * 与结构化日志、计费回执行展示**同一个码** —— 护士长在核查清单上看到
   * `ERR_MATERIAL_NOT_REGISTERED`，去日志里搜同一个码就能定位到那一条；
   * 信息科按码查错误码表就知道该找谁处置。
   */
  error_code?: string | null;
  /** 检出时间（不传则取当前时间） */
  detected_at?: string;
  /** 跨台次重复时：先到者的台次 */
  source_operation_no?: string | null;
  /** 跨台次重复时：先到者的手术间 */
  source_room_no?: string | null;
  /**
   * 事件侧的手术间（扫码发生地）。
   *
   * 归属双因子核对的两侧都要留痕：`room_no` 是事件侧、`master_room_no` 是排台侧，
   * 事后能核对「当时到底对的是哪两个手术间」，而不是只看到一句「归属冲突」。
   */
  event_room_no?: string | null;
  /** 排台主数据里的手术间 */
  master_room_no?: string | null;
  /** 事件侧的科室上下文（扫码枪位置登记里登记的科室） */
  event_dept_code?: string | null;
  /** 排台主数据里的科室 */
  master_dept_code?: string | null;
  /** 关联的台账行 id（给了就精确挂到那一行；不给则按耗材码 + 台次找最新一行） */
  binding_id?: number | null;
  /**
   * 关联的对账差异行 id（给了就精确挂到那一条差异）。
   *
   * 差异台账与核查任务**双向挂接**：差异行的 check_task_id 指向核查条目，
   * 核查条目的 reconcile_diff_id 指回差异行 —— 护士长在核查条目上落定结论时，
   * 差异台账那边能查到「这条差异是从哪来的」。
   */
  reconcile_diff_id?: number | null;
}

export interface CheckTaskRow {
  id: number;
  operation_no: string;
  room_no: string;
  dept_code: string | null;
  scanner_id: string | null;
  material_code: string;
  quantity: number | null;
  conclusion: string;
  reason_code: string;
  /** 统一错误码（与日志、回执行同一个码） */
  error_code: string | null;
  /** pending（待核查） / closed（人工已落定闭环） */
  status: string;
  assignee_role: string | null;
  assigned_at: string | null;
  reminded_at: string | null;
  escalated_at: string | null;
  timeout_level: number;
  detected_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  confirmed_conclusion: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  source_operation_no: string | null;
  source_room_no: string | null;
  /** 事件侧手术间（归属核对的一侧） */
  event_room_no: string | null;
  /** 排台主数据里的手术间（归属核对的另一侧） */
  master_room_no: string | null;
  /** 事件侧科室上下文 */
  event_dept_code: string | null;
  /** 排台主数据里的科室 */
  master_dept_code: string | null;
  /** 双向挂接：核查条目指向的台账行 */
  binding_id: number | null;
  /** 双向挂接：核查条目指向的对账差异行 */
  reconcile_diff_id: number | null;
  created_at: string;
}

/** 核查任务层的错误（带错误码，供核查清单与日志归类） */
export class CheckTaskError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CheckTaskError';
    this.code = code;
  }
}

/** 核查任务不存在 */
export const ERR_CHECK_TASK_NOT_FOUND = 'ERR_CHECK_TASK_NOT_FOUND';
/** 核查任务已落定结论，重复确认被拒 */
export const ERR_CHECK_TASK_ALREADY_CLOSED = 'ERR_CHECK_TASK_ALREADY_CLOSED';
/** 核查任务尚未落定结论，无需撤回 */
export const ERR_CHECK_TASK_NOT_REVOCABLE = 'ERR_CHECK_TASK_NOT_REVOCABLE';

const TASK_COLUMNS = `id, operation_no, room_no, dept_code, scanner_id, material_code, quantity,
       conclusion, reason_code, error_code, status, assignee_role, assigned_at, reminded_at, escalated_at,
       timeout_level, detected_at, confirmed_at, confirmed_by, confirmed_conclusion,
       revoked_at, revoked_by, source_operation_no, source_room_no,
       event_room_no, master_room_no, event_dept_code, master_dept_code,
       binding_id, reconcile_diff_id, created_at`;

/**
 * 事务包装：核查条目行 + 台账行 + 审计行同事务提交或同事务回滚，不允许半写。
 * 已经在事务里（外层已开）就复用外层事务，不重复 BEGIN。
 */
function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始异常：失败不静默改数据
    }
    throw error;
  }
}

/**
 * 找同一台次 + 同一耗材 + 同一原因码的**待处理**核查条目。
 * 找到就复用，不重复建待办。
 */
export function findPendingCheckTask(
  db: DatabaseSync,
  operation_no: string,
  material_code: string,
  reason_code: string,
): CheckTaskRow | undefined {
  const row = db
    .prepare(
      `SELECT ${TASK_COLUMNS}
         FROM check_task
        WHERE operation_no = ? AND material_code = ? AND reason_code = ? AND status = 'pending'
        ORDER BY id ASC LIMIT 1`,
    )
    .get(operation_no, material_code, reason_code) as unknown as CheckTaskRow | undefined;
  return row;
}

/** 按 id 取核查条目 */
export function findCheckTask(db: DatabaseSync, id: number): CheckTaskRow | undefined {
  const row = db
    .prepare(`SELECT ${TASK_COLUMNS} FROM check_task WHERE id = ?`)
    .get(id) as unknown as CheckTaskRow | undefined;
  return row;
}

/** 核查条目总数 */
export function countCheckTasks(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM check_task').get() as { n: number };
  return row.n;
}

/** 待核查条目清单（按检出时间升序；给路由 / 提醒 / 导出用） */
export function listPendingCheckTasks(
  db: DatabaseSync,
  limit = 100,
): CheckTaskRow[] {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM check_task
        WHERE status = 'pending'
        ORDER BY detected_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as unknown as CheckTaskRow[];
}

/**
 * 把核查条目挂到台账行上（**双向挂接**）。
 *
 *   check_task.binding_id            → 台账行 id
 *   material_binding.check_task_id   → 核查条目 id
 *
 * 台账侧的指针**只填一次**：已有核查条目指向时保留先到的那条（与「先到者保留」口径一致），
 * 不让后来的核查条目把先到者的指针改掉；核查条目侧始终指着自己的台账行。
 */
function linkBinding(db: DatabaseSync, task_id: number, payload: CheckTaskPayload): number | null {
  let bindingId = payload.binding_id ?? null;
  if (bindingId == null) {
    const latest = findLatestBindingByCodeAndOperation(db, payload.material_code, payload.operation_no);
    bindingId = latest?.id ?? null;
  }
  if (bindingId == null) return null;

  const binding = findBindingById(db, bindingId);
  if (!binding) return null;

  db.prepare('UPDATE check_task SET binding_id = ? WHERE id = ? AND binding_id IS NULL').run(
    binding.id,
    task_id,
  );
  db.prepare('UPDATE material_binding SET check_task_id = ? WHERE id = ? AND check_task_id IS NULL').run(
    task_id,
    binding.id,
  );
  return binding.id;
}

/**
 * 建核查条目；同台次 + 同耗材 + 同原因码已有待处理条目时**复用**那条（不刷重复待办）。
 * 返回核查条目 id。
 */
export function createCheckTask(db: DatabaseSync, payload: CheckTaskPayload): number {
  const existing = findPendingCheckTask(db, payload.operation_no, payload.material_code, payload.reason_code);
  if (existing) {
    // 复用已有待办：把台账行补挂上（先到时台账行还不存在的情况）
    linkBinding(db, existing.id, payload);
    // 老待办没有责任岗位时补分派一次（已派过的不动，避免把升级过的条目拉回基础岗位）
    if (!existing.assignee_role) {
      assignExistingTask(db, existing, payload);
    }
    return existing.id;
  }

  const now = new Date().toISOString();
  const errorCode = payload.error_code ?? errorCodeForReason(payload.reason_code);
  // 自动路由：条目一建出来就落到责任岗位（异常类型 → 岗位，台次科室 → 哪个科室的岗位）
  const route = resolveAssignee({
    conclusion: payload.conclusion,
    reason_code: payload.reason_code,
    error_code: errorCode,
    dept_code: payload.dept_code,
  });
  const result = db
    .prepare(
      `INSERT INTO check_task
         (operation_no, room_no, dept_code, scanner_id, material_code, quantity,
          conclusion, reason_code, error_code, status, detected_at, created_at,
          assignee_role, assigned_at,
          source_operation_no, source_room_no,
          event_room_no, master_room_no, event_dept_code, master_dept_code, reconcile_diff_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      payload.operation_no,
      payload.room_no,
      payload.dept_code ?? null,
      payload.scanner_id ?? null,
      payload.material_code,
      payload.quantity ?? null,
      payload.conclusion,
      payload.reason_code,
      errorCode,
      payload.detected_at ?? now,
      now,
      route.role,
      now,
      payload.source_operation_no ?? null,
      payload.source_room_no ?? null,
      payload.event_room_no ?? payload.room_no ?? null,
      payload.master_room_no ?? null,
      payload.event_dept_code ?? null,
      payload.master_dept_code ?? payload.dept_code ?? null,
      payload.reconcile_diff_id ?? null,
    );
  const id = Number(result.lastInsertRowid);
  linkBinding(db, id, payload);
  appendAudit(db, {
    event_type: 'check_task_assigned',
    operation_no: payload.operation_no,
    scanner_id: payload.scanner_id ?? null,
    actor: 'check_router',
    detail: JSON.stringify({
      task_id: id,
      assignee_role: route.role,
      assignee_display: route.display,
      dept_code: payload.dept_code,
      conclusion: payload.conclusion,
      reason_code: payload.reason_code,
      error_code: errorCode,
      matched_by: route.matched_by,
      matched_key: route.matched_key,
      basis_zh: route.basis_zh,
      material_code: payload.material_code,
    }),
  });
  return id;
}

/**
 * 给一条**老**核查条目补分派（老条目没有责任岗位时用）。
 *
 * 只补空缺：已派过的条目不动 —— 升级过的条目不能被拉回基础岗位。
 */
function assignExistingTask(
  db: DatabaseSync,
  task: CheckTaskRow,
  payload: CheckTaskPayload,
): void {
  const route = resolveAssignee({
    conclusion: task.conclusion,
    reason_code: task.reason_code,
    error_code: task.error_code ?? errorCodeForReason(task.reason_code),
    dept_code: task.dept_code ?? payload.dept_code ?? null,
  });
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE check_task SET assignee_role = ?, assigned_at = ? WHERE id = ? AND assignee_role IS NULL',
  ).run(route.role, now, task.id);
  appendAudit(db, {
    event_type: 'check_task_assigned',
    operation_no: task.operation_no,
    scanner_id: task.scanner_id ?? null,
    actor: 'check_router',
    detail: JSON.stringify({
      task_id: task.id,
      assignee_role: route.role,
      assignee_display: route.display,
      dept_code: task.dept_code ?? payload.dept_code ?? null,
      conclusion: task.conclusion,
      reason_code: task.reason_code,
      error_code: task.error_code,
      matched_by: route.matched_by,
      matched_key: route.matched_key,
      basis_zh: route.basis_zh,
      material_code: task.material_code,
    }),
  });
}

/** 找到核查条目对应的台账行（先按 binding_id，再按耗材码 + 台次兜底） */
function resolveBinding(db: DatabaseSync, task: CheckTaskRow): BindingRowRef | undefined {
  if (task.binding_id != null) {
    const byId = findBindingById(db, task.binding_id);
    if (byId) return byId;
  }
  return findLatestBindingByCodeAndOperation(db, task.material_code, task.operation_no);
}

/**
 * 从当前状态到「已闭环」的**合法路径**（只走状态机白名单内的迁移）。
 *
 *   check_pending / rejected / confirmed → closed
 *   charged → confirmed → closed（已计费的条目由人确认后闭环，不自动冲正）
 *   其余（scanned / parsed / bound）→ 推不到 closed：白名单外迁移一律拒绝
 */
function pathToClosed(from: BindingState): BindingState[] {
  if (from === 'check_pending' || from === 'rejected' || from === 'confirmed') return ['closed'];
  if (from === 'charged') return ['confirmed', 'closed'];
  return [];
}

export interface ConfirmTaskResult {
  /** 核查条目 id */
  task_id: number;
  /** 人工结论 */
  conclusion: string;
  /** 操作人 */
  operator: string;
  /** 台账行的状态迁移（无台账行时为 null） */
  binding_transition: { from: BindingState; to: BindingState } | null;
  /** 落定时间 */
  confirmed_at: string;
}

/**
 * 人工确认：把核查条目的结论落定，并把对应台账行推进到「已闭环」。
 *
 * 处置轨迹：护士长 / 高值耗材管理岗在核查条目上落定结论 → 回写台账 → 条目闭环。
 * 核查条目行、台账行、审计行**同事务**提交：任何一步不成立就整体回滚，不留半写。
 *
 * 重复确认（条目已 closed）被拒 —— 幂等自环只在「待核查 → 待核查」上成立。
 */
export function confirmTask(
  db: DatabaseSync,
  task_id: number,
  conclusion: string,
  operator: string,
): ConfirmTaskResult {
  const task = findCheckTask(db, task_id);
  if (!task) {
    throw new CheckTaskError(ERR_CHECK_TASK_NOT_FOUND, `核查条目 #${task_id} 不存在`);
  }
  if (task.status === 'closed') {
    throw new CheckTaskError(
      ERR_CHECK_TASK_ALREADY_CLOSED,
      `核查条目 #${task_id} 已由 ${task.confirmed_by ?? '未知'} 于 ${task.confirmed_at ?? '未知时间'} 落定结论（${task.confirmed_conclusion ?? '—'}），重复确认被拒`,
    );
  }

  const binding = resolveBinding(db, task);

  try {
    return withTransaction(db, () => {
      let binding_transition: { from: BindingState; to: BindingState } | null = null;

      if (binding) {
        const path = pathToClosed(binding.status);
        if (path.length === 0) {
          // 白名单外迁移一律拒绝：状态推不到 closed 就整体拒绝（事务回滚，台账不变）
          throw new StateTransitionError(binding.status, 'closed', 'manual_confirm');
        }
        let from = binding.status;
        for (const to of path) {
          const step = transitionBindingStatus(db, {
            binding_id: binding.id,
            material_code: binding.material_code,
            operation_no: binding.operation_no,
            idempotency_key: binding.idempotency_key,
            to,
            actor: 'manual_confirm',
          });
          from = step.from;
        }
        binding_transition = { from, to: 'closed' };
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE check_task
          SET status = 'closed', confirmed_at = ?, confirmed_by = ?, confirmed_conclusion = ?
        WHERE id = ?`,
      ).run(now, operator, conclusion, task.id);

      appendAudit(db, {
        event_type: 'check_task_confirmed',
        binding_key: binding?.idempotency_key ?? null,
        operation_no: task.operation_no,
        scanner_id: task.scanner_id,
        actor: 'manual_confirm',
        detail: JSON.stringify({
          task_id: task.id,
          conclusion,
          operator,
          material_code: task.material_code,
          reason_code: task.reason_code,
          detected_conclusion: task.conclusion,
          binding_id: binding?.id ?? null,
          binding_from: binding_transition?.from ?? null,
          binding_to: binding_transition?.to ?? null,
        }),
      });

      return {
        task_id: task.id,
        conclusion,
        operator,
        binding_transition,
        confirmed_at: now,
      };
    });
  } catch (error) {
    // 事务已回滚（台账行、核查条目状态都没变）：此刻补记拒绝痕迹 ——
    // 「被拒」本身是业务事实，不该随事务回滚一起消失。
    if (error instanceof StateTransitionError) {
      recordRejectedTransition(db, {
        from: error.from,
        to: error.to,
        actor: error.actor ?? 'manual_confirm',
        binding_key: binding?.idempotency_key ?? null,
        operation_no: task.operation_no,
        material_code: task.material_code,
        note: error.message,
      });
    }
    throw error;
  }
}

export interface RevokeTaskResult {
  /** 核查条目 id */
  task_id: number;
  /** 操作人 */
  operator: string;
  /** 台账行的状态回退（无台账行或台账行本就不在 closed 时为 null） */
  binding_transition: { from: BindingState; to: BindingState } | null;
  /** 该条目此前是否已回写计费 */
  already_charged: boolean;
  /** 是否冲正了计费 —— 恒为 false：已回写计费的条目不自动冲正 */
  charge_reversed: boolean;
  /** 撤回时间 */
  revoked_at: string;
}

/** 该条目此前是否已回写计费（对端 accepted 过） */
function hasAcceptedCharge(db: DatabaseSync, material_code: string, operation_no: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM charge_receipt
        WHERE material_code = ? AND operation_no = ? AND accepted = 1`,
    )
    .get(material_code, operation_no) as { n: number };
  return row.n > 0;
}

/**
 * 人工撤回：把**已落定结论**的核查条目退回「待核查」，台账行同步退回「待核查」。
 *
 * 撤回是人工纠正（护士长误点确认），不是状态推进：自动迁移表里 closed 仍是终态，
 * 撤回走独立的撤回断言（只有 actor='revoke' 且 from='closed' 成立）。
 *
 * **已回写计费的条目不自动冲正** —— 只把条目退回待核查，计费侧一概不动
 * （冲正属本轮范围外，需人工在 HIS 侧处理）。
 */
export function revokeTask(db: DatabaseSync, task_id: number, operator: string): RevokeTaskResult {
  const task = findCheckTask(db, task_id);
  if (!task) {
    throw new CheckTaskError(ERR_CHECK_TASK_NOT_FOUND, `核查条目 #${task_id} 不存在`);
  }
  if (task.status !== 'closed') {
    throw new CheckTaskError(
      ERR_CHECK_TASK_NOT_REVOCABLE,
      `核查条目 #${task_id} 当前状态为 ${task.status}（尚未落定结论），无需撤回`,
    );
  }

  const binding = resolveBinding(db, task);

  try {
    return withTransaction(db, () => {
      let binding_transition: { from: BindingState; to: BindingState } | null = null;

      if (binding && binding.status === 'closed') {
        const step = manualRevokeBindingStatus(db, {
          binding_id: binding.id,
          to: 'check_pending',
          actor: 'revoke',
        });
        binding_transition = { from: step.from, to: step.to };
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE check_task
          SET status = 'pending', confirmed_at = NULL, confirmed_by = NULL, confirmed_conclusion = NULL,
              revoked_at = ?, revoked_by = ?
        WHERE id = ?`,
      ).run(now, operator, task.id);

      // 已回写计费的条目不自动冲正：只退台账状态，计费侧一概不动
      const already_charged = binding
        ? hasAcceptedCharge(db, binding.material_code, binding.operation_no)
        : false;

      appendAudit(db, {
        event_type: 'check_task_revoked',
        binding_key: binding?.idempotency_key ?? null,
        operation_no: task.operation_no,
        scanner_id: task.scanner_id,
        actor: 'revoke',
        detail: JSON.stringify({
          task_id: task.id,
          operator,
          material_code: task.material_code,
          reason_code: task.reason_code,
          revoked_conclusion: task.confirmed_conclusion,
          revoked_by_operator: task.confirmed_by,
          binding_id: binding?.id ?? null,
          binding_from: binding_transition?.from ?? null,
          binding_to: binding_transition?.to ?? null,
          already_charged,
          charge_reversed: false,
        }),
      });

      return {
        task_id: task.id,
        operator,
        binding_transition,
        already_charged,
        charge_reversed: false,
        revoked_at: now,
      };
    });
  } catch (error) {
    // 与确认同理：被拒的越界撤回在事务外补记痕迹（事务回滚不该抹掉「有人试图越界」）
    if (error instanceof StateTransitionError) {
      recordRejectedTransition(db, {
        from: error.from,
        to: error.to,
        actor: error.actor ?? 'revoke',
        binding_key: binding?.idempotency_key ?? null,
        operation_no: task.operation_no,
        material_code: task.material_code,
        note: error.message,
      });
    }
    throw error;
  }
}
