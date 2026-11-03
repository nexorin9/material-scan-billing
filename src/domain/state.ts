/**
 * 条目状态机：**全量迁移表**（8 状态 × 8 目标 = 64 对逐对判定）、非法迁移拒绝、终态保护。
 *
 * 状态流转（spec.md「业务状态生命周期」）：
 *   scanned → parsed → (bound | rejected) → charged → (confirmed | check_pending) → closed
 *
 * 五条硬约束：
 *   ① closed 是终态，自动迁移表里**没有任何出边**；
 *   ② charged 之后不自动冲正（不存在 charged → rejected / charged → parsed）；
 *   ③ 白名单外的迁移一律拒绝并带错误码、当前态与目标态，**不静默改数据**；
 *   ④ 幂等自环（check_pending → check_pending、confirmed → confirmed）放行但**不推进状态**；
 *   ⑤ 每次成功迁移都往审计链追加一行（from / to / actor / request_id / created_at），
 *      状态序列可回放 —— 见 `src/ledger/state-history.ts`。
 *
 * 唯一的例外是**人工撤回**（见 `MANUAL_REVOKE_EDGES`）：护士长误点确认需要能撤回，
 * 撤回是**人工纠正**而非状态推进，故单列一张表、单独一个断言函数，不并入自动迁移白名单。
 * 全量矩阵里 `closed → check_pending` 这一对标为 `manual_retract`：**自动迁移不放行**
 * （终态保护不变），只有走 `assertManualRevoke` 的人工撤回入口才成立。
 */

export type BindingState =
  | 'scanned'
  | 'parsed'
  | 'bound'
  | 'rejected'
  | 'charged'
  | 'confirmed'
  | 'check_pending'
  | 'closed';

export const ALL_STATES: readonly BindingState[] = [
  'scanned',
  'parsed',
  'bound',
  'rejected',
  'charged',
  'confirmed',
  'check_pending',
  'closed',
];

/** 迁移触发方：谁有权把条目推到下一个状态 */
export type TransitionActor = 'ingest' | 'binding_engine' | 'charge_writeback' | 'manual_confirm' | 'revoke';

/** 迁移性质：全量矩阵里每一对 (from, to) 的判定结果 */
export type TransitionKind =
  /** 状态推进 */
  | 'advance'
  /** 幂等自环：放行但不推进 */
  | 'self_loop'
  /** 白名单外，一律拒绝 */
  | 'forbidden'
  /** 人工纠正路径（撤回）：自动迁移表不放行，需走独立断言 */
  | 'manual_retract';

export interface TransitionRule {
  from: BindingState;
  to: BindingState;
  /** 有权执行这条迁移的角色（缺省不限） */
  actors: readonly TransitionActor[];
  note: string;
}

/**
 * 状态推进边（12 条）：每一次都改变条目状态。
 *
 * 每条边都标注了**触发方** —— 同一对 (from, to) 只认表里列出的角色，
 * 角色不符即拒（例如只有绑定引擎能把 parsed 推成 bound，人工确认无权代劳）。
 */
export const ADVANCE_EDGES: readonly TransitionRule[] = [
  { from: 'scanned', to: 'parsed', actors: ['ingest'], note: '入站解析完成' },
  { from: 'parsed', to: 'bound', actors: ['binding_engine'], note: '绑定本台次成功' },
  { from: 'parsed', to: 'rejected', actors: ['binding_engine'], note: '绑定判定为异常' },
  { from: 'parsed', to: 'check_pending', actors: ['binding_engine'], note: '异常条目转核查' },
  { from: 'bound', to: 'charged', actors: ['charge_writeback'], note: '计费回写成功' },
  {
    from: 'bound',
    to: 'check_pending',
    actors: ['binding_engine', 'charge_writeback'],
    note: '计费业务拒绝，转人工',
  },
  { from: 'rejected', to: 'check_pending', actors: ['binding_engine'], note: '异常条目生成核查任务' },
  { from: 'rejected', to: 'closed', actors: ['manual_confirm'], note: '人工判定无需处理，直接闭环' },
  { from: 'charged', to: 'confirmed', actors: ['manual_confirm'], note: '人工确认已计费' },
  {
    from: 'charged',
    to: 'check_pending',
    actors: ['charge_writeback', 'manual_confirm'],
    note: '计费结果存疑，转人工',
  },
  { from: 'confirmed', to: 'closed', actors: ['manual_confirm'], note: '确认后闭环' },
  { from: 'check_pending', to: 'closed', actors: ['manual_confirm'], note: '核查结论落定，闭环' },
];

/**
 * 幂等自环边（2 条）：放行，但**不推进状态**。
 *
 * 重复落结论 / 重复确认是常态（网络重投、护士长手滑点两下），
 * 这类请求既不该报错，也不该把状态往前推，更不该重写确认时间。
 */
export const SELF_LOOP_EDGES: readonly TransitionRule[] = [
  { from: 'confirmed', to: 'confirmed', actors: ['manual_confirm'], note: '重复确认：幂等自环，不推进' },
  {
    from: 'check_pending',
    to: 'check_pending',
    actors: ['manual_confirm', 'revoke'],
    note: '撤回 / 重复落结论：幂等自环，不推进',
  },
];

/**
 * 人工撤回边：**只有 actor='revoke'** 能把已闭环（closed）的条目退回「待核查」（check_pending）。
 *
 * 为什么不并进自动迁移表：
 *   - 自动迁移表里 `closed` 仍然**没有任何出边** —— 终态保护不变，白名单外迁移一律拒绝；
 *   - 撤回是**人工纠正**，不是状态推进：它有独立的入口、独立的断言、强制留审计痕迹，
 *     与自动迁移互不干扰，也不会让任何自动路径「顺手」把终态条目改回去。
 */
export const MANUAL_REVOKE_EDGES: readonly TransitionRule[] = [
  {
    from: 'closed',
    to: 'check_pending',
    actors: ['revoke'],
    note: '人工撤回误确认：退回待核查；已回写计费的条目不自动冲正',
  },
];

/** 终态：自动迁移表里没有任何出边 */
export const TERMINAL_STATES: readonly BindingState[] = ['closed'];

/**
 * 合法迁移表（自动迁移 = 状态推进 + 幂等自环）。
 * 保留这个导出是为了兼容既有调用方；判定真源是下面的**全量矩阵**。
 */
export const TRANSITIONS: readonly TransitionRule[] = [...ADVANCE_EDGES, ...SELF_LOOP_EDGES];

/** 全量矩阵里每一对 (from, to) 的判定结论 */
export interface TransitionDecision {
  from: BindingState;
  to: BindingState;
  /** 自动状态机是否放行这一对 */
  allowed: boolean;
  /** 这一对的性质 */
  kind: TransitionKind;
  /** 有权执行的角色（forbidden 时为空数组） */
  actors: readonly TransitionActor[];
  /** 中文说明（拒绝原因 / 放行含义） */
  note: string;
}

/** 拒绝原因文案：按「当前态 → 目标态」给出人话，便于核查清单与日志直接展示 */
function forbiddenNote(from: BindingState, to: BindingState): string {
  if (from === 'closed') {
    return 'closed 是终态：自动迁移表内没有任何出边，只能由人工撤回入口纠正';
  }
  if (from === 'charged' && (to === 'rejected' || to === 'parsed')) {
    return '已回写计费的条目不自动冲正：不能退回已计费前的状态';
  }
  if (to === 'closed') {
    return '当前状态到「已闭环」没有合法路径：需先按顺序推进或转人工核查';
  }
  return '不在合法迁移表内：已拒绝且不改动台账';
}

/**
 * 构建全量迁移矩阵：8 个状态两两组合共 64 对，**逐对**给出允许 / 拒绝与触发方。
 *
 * 为什么要「逐对」而不是只列允许边：白名单外的迁移要能被当场说清「为什么不行」——
 * 非法迁移在手术室里必须能当场指出缺的是哪一步，而不是只丢一个异常。
 */
function buildMatrix(): TransitionDecision[] {
  const decisions: TransitionDecision[] = [];
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const advance = ADVANCE_EDGES.find((edge) => edge.from === from && edge.to === to);
      const loop = SELF_LOOP_EDGES.find((edge) => edge.from === from && edge.to === to);
      const retract = MANUAL_REVOKE_EDGES.find((edge) => edge.from === from && edge.to === to);

      if (advance) {
        decisions.push({
          from,
          to,
          allowed: true,
          kind: 'advance',
          actors: advance.actors,
          note: advance.note,
        });
      } else if (loop) {
        decisions.push({
          from,
          to,
          allowed: true,
          kind: 'self_loop',
          actors: loop.actors,
          note: loop.note,
        });
      } else if (retract) {
        decisions.push({
          from,
          to,
          allowed: false,
          kind: 'manual_retract',
          actors: retract.actors,
          note: `${retract.note}（自动迁移不放行，需走人工撤回断言）`,
        });
      } else {
        decisions.push({
          from,
          to,
          allowed: false,
          kind: 'forbidden',
          actors: [],
          note: forbiddenNote(from, to),
        });
      }
    }
  }
  return decisions;
}

/**
 * 全量迁移矩阵（64 对，逐对判定）。
 * 判定真源：状态推进边 + 幂等自环边 + 人工撤回边 + 其余一律拒绝。
 */
export const FULL_TRANSITION_MATRIX: readonly TransitionDecision[] = buildMatrix();

const MATRIX_INDEX: ReadonlyMap<string, TransitionDecision> = new Map(
  FULL_TRANSITION_MATRIX.map((decision) => [`${decision.from}->${decision.to}`, decision]),
);

/** 某一对 (from, to) 的判定结论 */
export function transitionDecision(from: BindingState, to: BindingState): TransitionDecision {
  const decision = MATRIX_INDEX.get(`${from}->${to}`);
  if (!decision) {
    // 理论上不可达（矩阵覆盖全部 64 对）：兜底成拒绝，失败不静默放行
    return {
      from,
      to,
      allowed: false,
      kind: 'forbidden',
      actors: [],
      note: forbiddenNote(from, to),
    };
  }
  return decision;
}

/** 这条迁移在白名单内吗（带角色时同时校验角色） */
export function canTransition(from: BindingState, to: BindingState, actor?: TransitionActor): boolean {
  const decision = transitionDecision(from, to);
  if (!decision.allowed) return false;
  if (!actor) return true;
  return decision.actors.includes(actor);
}

/** 非法状态迁移：带错误码、当前态与目标态，供核查任务展示与日志归类 */
export class StateTransitionError extends Error {
  readonly code = 'ERR_ILLEGAL_STATE_TRANSITION';

  constructor(
    readonly from: BindingState,
    readonly to: BindingState,
    readonly actor?: TransitionActor,
    readonly note?: string,
  ) {
    super(
      `Illegal state transition: ${from} → ${to}` +
        (actor ? ` (actor: ${actor})` : '') +
        (note ? `；${note}` : '') +
        '；不在合法迁移白名单内，已拒绝且不改动台账',
    );
    this.name = 'StateTransitionError';
  }
}

/** 断言迁移合法；不合法即抛带错误码的异常 */
export function assertTransition(from: BindingState, to: BindingState, actor?: TransitionActor): void {
  const decision = transitionDecision(from, to);
  if (!canTransition(from, to, actor)) {
    const reason =
      !decision.allowed
        ? decision.note
        : `角色不符：这条迁移只认 ${decision.actors.join(' / ')}`;
    throw new StateTransitionError(from, to, actor, reason);
  }
}

/** 某状态当前允许去往的目标状态（推进边 + 幂等自环） */
export function allowedTargets(from: BindingState): BindingState[] {
  return FULL_TRANSITION_MATRIX.filter((decision) => decision.from === from && decision.allowed).map(
    (decision) => decision.to,
  );
}

/** 终态判定：closed 没有任何出边 */
export function isTerminal(state: BindingState): boolean {
  return allowedTargets(state).length === 0;
}

/** 这条迁移是不是幂等自环（放行但不推进状态） */
export function isSelfLoop(from: BindingState, to: BindingState): boolean {
  return transitionDecision(from, to).kind === 'self_loop';
}

/** 这条人工撤回是否成立（在撤回表内且角色是 revoke） */
export function canManualRevoke(from: BindingState, to: BindingState, actor?: TransitionActor): boolean {
  const rule = MANUAL_REVOKE_EDGES.find((edge) => edge.from === from && edge.to === to);
  if (!rule) return false;
  if (!actor) return true;
  return rule.actors.includes(actor);
}

/** 断言人工撤回合法；不合法即抛带错误码的异常 */
export function assertManualRevoke(from: BindingState, to: BindingState, actor?: TransitionActor): void {
  if (!canManualRevoke(from, to, actor)) throw new StateTransitionError(from, to, actor);
}
