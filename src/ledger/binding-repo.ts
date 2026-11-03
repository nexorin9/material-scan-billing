/**
 * 耗材码 ↔ 台次 ↔ 科室 的绑定读写（台账层，纯持久化，不做判定）。
 *
 * 本层只回答「主数据里有没有这条」「台账里有没有这一行」，不做任何结论判断 ——
 * 判断在 `src/engine/`。这样判定规则可以随口径迭代，而台账读写保持稳定。
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  assertManualRevoke,
  assertTransition,
  type BindingState,
  type TransitionActor,
} from '../domain/state.js';
import { recordRejectedTransition, recordStateTransition } from './state-history.js';

export interface OperationRow {
  operation_no: string;
  room_no: string;
  dept_code: string;
  status: 'open' | 'closed';
  closed_at: string | null;
}

export interface MaterialRow {
  material_code: string;
  name: string;
  price_code: string;
  fee_category: string;
  medical_insurance_class: string;
  active: boolean;
  batch_no: string | null;
  /** 包装单位（扫码计数的单位，如「包」） */
  unit_pack: string | null;
  /** 最小单位（拆零后的最小可计数单位，如「支」） */
  unit_min: string | null;
  /** 计价单位（HIS 计费的单位，如「支」） */
  charge_unit: string | null;
  /** 换算系数：1 个包装单位 = ratio 个计价单位 */
  ratio: number | null;
}

export interface BindingInsert {
  idempotency_key: string;
  operation_no: string;
  room_no: string;
  dept_code: string;
  material_code: string;
  quantity: number;
  price_code: string | null;
  fee_category: string | null;
  medical_insurance_class: string | null;
  conclusion: string;
  status: string;
  raw_code: string | null;
  /** 幂等键派生档位：v1 = 码 + 台次；v2 = 码 + 台次 + 批号；legacy = 历史格式（只读） */
  key_profile?: string;
  /** 批号：v2 档位的去重维度；v1 档位也记下来（事后核对「哪一批」用） */
  batch_no?: string | null;
  /** 码制：UDI / GS1_AI01 / INTERNAL */
  code_form?: string | null;
  /** 码制解析轨迹（JSON 字符串；失效期只落类别，不落具体日期） */
  code_parse_trace?: string | null;
  /** 计价数量（包装数换算成计价单位后的数量；计费回写用这个数） */
  charge_quantity?: number | null;
  /** 换算轨迹（JSON 字符串：原始数量 / 包装单位 / 系数 / 计价数量） */
  quantity_trace?: string | null;
  /**
   * 事件侧的手术间（扫码发生地）。
   *
   * 与 `master_room_no` **成对落库**：归属双因子核对过的两个手术间都留在行上，
   * 事后能核对「当时核的是哪两个手术间」，而不是只看到一句「归属一致」。
   */
  event_room_no?: string | null;
  /** 排台主数据里的手术间 */
  master_room_no?: string | null;
  /** 事件侧的科室上下文（扫码枪位置登记里登记的科室） */
  event_dept_code?: string | null;
  /**
   * 是哪一次投递把这一行带进来的（本次扫码的投递标识）。
   *
   * 溯源用：按 request_id 就能把「设备报了什么 → 落了哪几行台账 → 怎么处置」
   * 串成一条线（事件日志、台账、审计链三边共用同一个标识）。
   */
  request_id?: string | null;
  /**
   * 业务使用时间（设备上报的扫码时间，归一后落库）。
   *
   * 月度对账按**业务月**切账期，用的就是这一列 —— 不是落账时间。
   */
  use_time?: string | null;
}

/** 按台次号查排台台次；查不到返回 undefined */
export function findOperation(db: DatabaseSync, operation_no: string): OperationRow | undefined {
  const row = db
    .prepare('SELECT operation_no, room_no, dept_code, status, closed_at FROM operation WHERE operation_no = ?')
    .get(operation_no) as
    | { operation_no: string; room_no: string; dept_code: string; status: string; closed_at: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    operation_no: row.operation_no,
    room_no: row.room_no,
    dept_code: row.dept_code,
    status: row.status === 'closed' ? 'closed' : 'open',
    closed_at: row.closed_at,
  };
}

/** 按耗材码查院内耗材主数据；查不到返回 undefined */
export function findMaterial(db: DatabaseSync, material_code: string): MaterialRow | undefined {
  const row = db
    .prepare(
      `SELECT material_code, name, price_code, fee_category, medical_insurance_class, active, batch_no,
              unit_pack, unit_min, charge_unit, ratio
       FROM material WHERE material_code = ?`,
    )
    .get(material_code) as
    | {
        material_code: string;
        name: string;
        price_code: string;
        fee_category: string;
        medical_insurance_class: string;
        active: number;
        batch_no: string | null;
        unit_pack: string | null;
        unit_min: string | null;
        charge_unit: string | null;
        ratio: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    material_code: row.material_code,
    name: row.name,
    price_code: row.price_code,
    fee_category: row.fee_category,
    medical_insurance_class: row.medical_insurance_class,
    active: row.active === 1,
    batch_no: row.batch_no,
    unit_pack: row.unit_pack,
    unit_min: row.unit_min,
    charge_unit: row.charge_unit,
    ratio: row.ratio == null ? null : Number(row.ratio),
  };
}

/** 写一行耗材使用台账；返回新行 id */
export function insertBinding(db: DatabaseSync, row: BindingInsert): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO material_binding
         (idempotency_key, operation_no, room_no, dept_code, material_code, quantity,
          price_code, fee_category, medical_insurance_class, conclusion, status,
          raw_code, key_profile, batch_no, code_form, code_parse_trace,
          charge_quantity, quantity_trace,
          event_room_no, master_room_no, event_dept_code, request_id, use_time,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.idempotency_key,
      row.operation_no,
      row.room_no,
      row.dept_code,
      row.material_code,
      row.quantity,
      row.price_code,
      row.fee_category,
      row.medical_insurance_class,
      row.conclusion,
      row.status,
      row.raw_code,
      row.key_profile ?? 'v1',
      row.batch_no ?? null,
      row.code_form ?? null,
      row.code_parse_trace ?? null,
      row.charge_quantity ?? null,
      row.quantity_trace ?? null,
      row.event_room_no ?? row.room_no,
      row.master_room_no ?? row.room_no,
      row.event_dept_code ?? null,
      row.request_id ?? null,
      row.use_time ?? null,
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

/** 按幂等键查台账行 */
export function findBindingByKey(db: DatabaseSync, idempotency_key: string): { id: number } | undefined {
  const row = db
    .prepare('SELECT id FROM material_binding WHERE idempotency_key = ?')
    .get(idempotency_key) as { id: number } | undefined;
  return row;
}

/**
 * 按（耗材码 + 台次）查台账行 —— 第二道去重防线的读侧。
 *
 * 口径覆盖 **legacy + v1** 两档：老行（升级前写的历史格式键）与新行
 * （v1 档位）在业务上都是「同一耗材同一台次只算一次」，必须互相挡住，
 * 否则老行会被当成新事件再计一笔。
 */
export function findBindingByCodeAndOperation(
  db: DatabaseSync,
  material_code: string,
  operation_no: string,
): { id: number; idempotency_key: string } | undefined {
  const row = db
    .prepare(
      `SELECT id, idempotency_key FROM material_binding
        WHERE material_code = ? AND operation_no = ? AND key_profile IN ('legacy', 'v1')
        ORDER BY id ASC LIMIT 1`,
    )
    .get(material_code, operation_no) as { id: number; idempotency_key: string } | undefined;
  return row;
}

/** 同一耗材在同一台次下的台账行（去重判定的读侧：按档位 + 批号判断是不是同一笔） */
export interface BindingDuplicateCandidate {
  id: number;
  idempotency_key: string;
  /** 键档位：legacy（历史）/ v1（码+台次）/ v2（码+台次+批号） */
  key_profile: string;
  /** 批号：v2 档位有值；老行与未细分时为 null */
  batch_no: string | null;
  material_code: string;
  operation_no: string;
  room_no: string;
  quantity: number;
  created_at: string;
}

/**
 * 取该耗材在该台次下的**全部**台账行（按 id 升序）。
 *
 * 键版本化后同一（耗材码 + 台次）可能有多行（v2 档位下不同批号各一行），
 * 所以这里不做 LIMIT —— 判定层要看到全部行才能分清
 * 「同一批重扫」与「另一批的同款耗材」。
 */
export function listBindingsByCodeAndOperation(
  db: DatabaseSync,
  material_code: string,
  operation_no: string,
): BindingDuplicateCandidate[] {
  const rows = db
    .prepare(
      `SELECT id, idempotency_key, key_profile, batch_no, material_code, operation_no, room_no,
              quantity, created_at
         FROM material_binding
        WHERE material_code = ? AND operation_no = ?
        ORDER BY id ASC`,
    )
    .all(material_code, operation_no) as unknown as BindingDuplicateCandidate[];
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
    quantity: Number(row.quantity ?? 0),
    key_profile: row.key_profile ?? 'legacy',
    batch_no: row.batch_no ?? null,
  }));
}

/** 台账行的引用形状（核查任务与台账双向挂接时用） */
export interface BindingRowRef {
  id: number;
  idempotency_key: string;
  operation_no: string;
  room_no: string;
  dept_code: string;
  material_code: string;
  quantity: number;
  conclusion: string;
  status: BindingState;
  check_task_id: number | null;
}

function toBindingRowRef(row: Record<string, unknown>): BindingRowRef {
  return {
    id: Number(row.id),
    idempotency_key: String(row.idempotency_key ?? ''),
    operation_no: String(row.operation_no ?? ''),
    room_no: String(row.room_no ?? ''),
    dept_code: String(row.dept_code ?? ''),
    material_code: String(row.material_code ?? ''),
    quantity: Number(row.quantity ?? 0),
    conclusion: String(row.conclusion ?? ''),
    status: String(row.status ?? 'scanned') as BindingState,
    check_task_id: row.check_task_id == null ? null : Number(row.check_task_id),
  };
}

/** 按台账行 id 取行（人工确认 / 撤回要精确落到某一行，不能只靠「耗材码 + 台次」） */
export function findBindingById(db: DatabaseSync, id: number): BindingRowRef | undefined {
  const row = db.prepare('SELECT * FROM material_binding WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toBindingRowRef(row) : undefined;
}

/** 按（耗材码 + 台次）取**最新**一行台账（不限定键档位；核查任务挂接用） */
export function findLatestBindingByCodeAndOperation(
  db: DatabaseSync,
  material_code: string,
  operation_no: string,
): BindingRowRef | undefined {
  const row = db
    .prepare(
      `SELECT * FROM material_binding
        WHERE material_code = ? AND operation_no = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(material_code, operation_no) as Record<string, unknown> | undefined;
  return row ? toBindingRowRef(row) : undefined;
}

/** 台账行数（演示与 doctor 用） */
export function countBindings(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM material_binding').get() as { n: number };
  return row.n;
}

/**
 * 把「出站载荷归一前后对照」写到台账行上。
 *
 * 为什么台账要记这个：出站载荷在发出去之前可能被清洗过（全角转半角、去零宽字符、
 * 折叠空白）。事后对账时如果 HIS 计费侧收到的耗材码与台账里长得不一样，
 * 靠这一列就能回答「是主数据改了，还是清洗改了」——
 * 没有这一列，对账差异就只能靠人回忆。
 *
 * 只写不读改：同一行重复写以最后一次为准（重投时归一结果不变，重复写也无害）。
 */
export function recordSanitizeTrace(
  db: DatabaseSync,
  binding_id: number,
  trace_json: string | null,
): void {
  if (binding_id == null) return;
  db.prepare(
    `UPDATE material_binding
        SET sanitize_trace = ?, updated_at = ?
      WHERE id = ?`,
  ).run(trace_json, new Date().toISOString(), binding_id);
}

/**
 * 读台账行的当前状态。
 *
 * 给了 `idempotency_key` 就按键定位（键版本化到 v2 后同码同台次可能有多行，
 * 不按键定位会张冠李戴）；没给就按（耗材码 + 台次）取最新一行。
 */
export function readBindingStatus(
  db: DatabaseSync,
  material_code: string,
  operation_no: string,
  idempotency_key?: string | null,
): BindingState | undefined {
  const row = db
    .prepare(
      `SELECT status FROM material_binding
        WHERE material_code = ? AND operation_no = ?
          AND (? IS NULL OR idempotency_key = ?)
        ORDER BY id DESC LIMIT 1`,
    )
    .get(
      material_code,
      operation_no,
      idempotency_key ?? null,
      idempotency_key ?? null,
    ) as { status: string } | undefined;
  return row ? (row.status as BindingState) : undefined;
}

/** 台账行找不到时的错误（带错误码） */
export class BindingNotFoundError extends Error {
  readonly code = 'ERR_BINDING_NOT_FOUND';

  constructor(
    readonly material_code: string,
    readonly operation_no: string,
  ) {
    super(`台账里没有这条耗材使用记录：${material_code} / ${operation_no}`);
    this.name = 'BindingNotFoundError';
  }
}

export interface BindingStatusUpdate {
  material_code: string;
  operation_no: string;
  /** 幂等键（给了就按键定位） */
  idempotency_key?: string | null;
  /** 台账行 id（给了就按 id 精确定位；键版本化到 v2 后同码同台次可能有多行） */
  binding_id?: number | null;
  /** 目标状态 */
  to: BindingState;
  /** 谁触发的这次迁移（白名单按角色校验） */
  actor: TransitionActor;
  /** 关联的核查条目 id（给了就回写双向挂接） */
  check_task_id?: number | null;
  /** 本次投递 / 处置的请求标识（写进迁移轨迹，便于回放） */
  request_id?: string | null;
}

/** 台账行上跟迁移轨迹有关的列 */
interface TransitionRowView {
  id: number;
  status: string;
  idempotency_key: string;
  operation_no: string;
  material_code: string;
}

/**
 * 推进台账行的状态。
 *
 * 迁移合法性由状态机全量迁移表把关：**白名单外的迁移被拒且不改动台账**（失败不静默改数据）。
 * 状态被拒时抛 `StateTransitionError`（带 error_code / from / to / actor）。
 *
 * 两条留痕：
 *   ① 成功迁移 → 审计链追加一行 `state_transition`（from / to / actor / request_id），
 *      与台账行同一事务提交，状态序列可回放；
 *   ② 越界尝试 → 审计链追加一行 `state_transition_rejected`。
 *      若调用方在事务里，这一行会随事务回滚消失 —— 事务语义优先（不留半写），
 *      需要留存拒绝痕迹的调用点在**事务外**补记（见 `src/check/task.ts`）。
 */
export function transitionBindingStatus(
  db: DatabaseSync,
  update: BindingStatusUpdate,
): { from: BindingState; to: BindingState } {
  const row =
    update.binding_id != null
      ? (db
          .prepare(
            `SELECT id, status, idempotency_key, operation_no, material_code
               FROM material_binding WHERE id = ?`,
          )
          .get(update.binding_id) as TransitionRowView | undefined)
      : (db
          .prepare(
            `SELECT id, status, idempotency_key, operation_no, material_code
               FROM material_binding
              WHERE material_code = ? AND operation_no = ?
                AND (? IS NULL OR idempotency_key = ?)
              ORDER BY id DESC LIMIT 1`,
          )
          .get(
            update.material_code,
            update.operation_no,
            update.idempotency_key ?? null,
            update.idempotency_key ?? null,
          ) as TransitionRowView | undefined);

  if (!row) {
    throw new BindingNotFoundError(update.material_code, update.operation_no);
  }

  const from = row.status as BindingState;
  try {
    // 白名单外迁移在这里被拒：抛异常且不写任何台账行
    assertTransition(from, update.to, update.actor);
  } catch (error) {
    recordRejectedTransition(db, {
      from,
      to: update.to,
      actor: update.actor,
      binding_key: row.idempotency_key,
      operation_no: row.operation_no,
      material_code: row.material_code,
      request_id: update.request_id ?? null,
      note: error instanceof Error ? error.message : undefined,
    });
    throw error;
  }

  db.prepare(
    `UPDATE material_binding
        SET status = ?,
            check_task_id = COALESCE(?, check_task_id),
            updated_at = ?
      WHERE id = ?`,
  ).run(update.to, update.check_task_id ?? null, new Date().toISOString(), row.id);

  recordStateTransition(db, {
    from,
    to: update.to,
    actor: update.actor,
    binding_key: row.idempotency_key,
    operation_no: row.operation_no,
    material_code: row.material_code,
    request_id: update.request_id ?? null,
  });

  return { from, to: update.to };
}

/** 台账行按 id 找不到时的错误（带错误码） */
export class BindingRowNotFoundError extends Error {
  readonly code = 'ERR_BINDING_NOT_FOUND';

  constructor(readonly binding_id: number) {
    super(`台账里没有 id = ${binding_id} 的耗材使用记录`);
    this.name = 'BindingRowNotFoundError';
  }
}

export interface ManualRevokeUpdate {
  /** 要撤回的台账行 id */
  binding_id: number;
  /** 撤回后的状态（固定为「待核查」） */
  to: BindingState;
  /** 谁撤的（只有 revoke 角色成立） */
  actor: TransitionActor;
  /** 本次处置的请求标识（写进迁移轨迹） */
  request_id?: string | null;
}

/**
 * 人工撤回：把**已闭环**的台账行退回「待核查」。
 *
 * 与自动迁移分开：自动迁移表里 closed 仍是终态（无出边），撤回是人工纠正，
 * 走独立的撤回断言（`assertManualRevoke`），只有 actor='revoke' 且 from='closed' 成立。
 *
 * **已回写计费的条目不自动冲正** —— 本函数只改台账状态，不碰计费侧任何数据。
 * 撤回本身留一行迁移轨迹（actor=revoke），事后可回放「谁把哪条撤回了」。
 */
export function manualRevokeBindingStatus(
  db: DatabaseSync,
  update: ManualRevokeUpdate,
): { from: BindingState; to: BindingState } {
  const row = db
    .prepare(
      `SELECT id, status, idempotency_key, operation_no, material_code
         FROM material_binding WHERE id = ?`,
    )
    .get(update.binding_id) as TransitionRowView | undefined;
  if (!row) throw new BindingRowNotFoundError(update.binding_id);

  const from = row.status as BindingState;
  try {
    // 不成立即抛异常且不写任何台账行（失败不静默改数据）
    assertManualRevoke(from, update.to, update.actor);
  } catch (error) {
    recordRejectedTransition(db, {
      from,
      to: update.to,
      actor: update.actor,
      binding_key: row.idempotency_key,
      operation_no: row.operation_no,
      material_code: row.material_code,
      request_id: update.request_id ?? null,
      note: error instanceof Error ? error.message : undefined,
    });
    throw error;
  }

  db.prepare('UPDATE material_binding SET status = ?, updated_at = ? WHERE id = ?').run(
    update.to,
    new Date().toISOString(),
    row.id,
  );

  recordStateTransition(db, {
    from,
    to: update.to,
    actor: update.actor,
    binding_key: row.idempotency_key,
    operation_no: row.operation_no,
    material_code: row.material_code,
    request_id: update.request_id ?? null,
  });

  return { from, to: update.to };
}
