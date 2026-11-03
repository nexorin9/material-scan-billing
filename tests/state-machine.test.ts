/**
 * test_state_machine：条目状态机**全量迁移表** —— 64 对逐对判定、终态保护、幂等自环、
 * 非法迁移拒绝且不改台账、迁移轨迹只增不改且可回放。
 *
 * 覆盖：
 *   ① 全量矩阵 8 状态 × 8 目标 = 64 对，逐对断言「允许 / 拒绝」与独立写出的预期一致
 *      （每个状态对一条用例，共 64 条）；
 *   ② 每条放行边都标注触发方，角色不符一律拒绝；
 *   ③ 终态保护：closed 没有任何出边；charged 不允许回到 rejected / parsed；
 *   ④ 人工撤回是独立入口（不并进自动迁移表），角色不符仍被拒；
 *   ⑤ 幂等自环放行但不推进状态、不重写确认时间；
 *   ⑥ 非法迁移被拒：台账行不改动，并留下拒绝痕迹；
 *   ⑦ 成功迁移留痕：审计链追加一行（from / to / actor / request_id / created_at），可回放。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_STATES,
  ADVANCE_EDGES,
  FULL_TRANSITION_MATRIX,
  MANUAL_REVOKE_EDGES,
  SELF_LOOP_EDGES,
  StateTransitionError,
  TERMINAL_STATES,
  allowedTargets,
  assertTransition,
  canManualRevoke,
  canTransition,
  isSelfLoop,
  isTerminal,
  transitionDecision,
  type BindingState,
  type TransitionActor,
} from '../src/domain/state.js';
import { deriveIdempotencyKey } from '../src/domain/idempotency.js';
import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import {
  findBindingById,
  insertBinding,
  manualRevokeBindingStatus,
  transitionBindingStatus,
} from '../src/ledger/binding-repo.js';
import {
  STATE_TRANSITION_EVENT,
  STATE_TRANSITION_REJECTED_EVENT,
  countRejectedTransitions,
  queryStateTransitions,
  replayStateSequence,
} from '../src/ledger/state-history.js';
import { countAuditRows } from '../src/ledger/audit.js';
import { createCheckTask, findCheckTask } from '../src/check/task.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const OPEN_OP = 'OP-SAMPLE-001';
const OPEN_OP_2 = 'OP-SAMPLE-002';

/**
 * 预期放行边 —— **独立手工写出**，不引用实现里的边表，
 * 这样「实现和预期不一致」才会被测出来（而不是自说自话地通过）。
 */
const EXPECTED_ALLOWED: ReadonlySet<string> = new Set([
  'scanned->parsed',
  'parsed->bound',
  'parsed->rejected',
  'parsed->check_pending',
  'bound->charged',
  'bound->check_pending',
  'rejected->check_pending',
  'rejected->closed',
  'charged->confirmed',
  'charged->check_pending',
  'confirmed->closed',
  'confirmed->confirmed',
  'check_pending->closed',
  'check_pending->check_pending',
]);

/** 预期的人工撤回边（不进自动迁移表） */
const EXPECTED_MANUAL_RETRACT: ReadonlySet<string> = new Set(['closed->check_pending']);

let ledger: LedgerDb;

/** 直接造一条指定状态的台账行（状态机测试要精确控制起点） */
function seedBinding(
  status: BindingState,
  material_code = 'MAT-SAMPLE-01',
  operation_no = OPEN_OP,
): number {
  return insertBinding(ledger.db, {
    idempotency_key: deriveIdempotencyKey(material_code, operation_no),
    operation_no,
    room_no: 'OR-01',
    dept_code: 'SURG-01',
    material_code,
    quantity: 1,
    price_code: 'PR-SAMPLE-01',
    fee_category: '卫生材料',
    medical_insurance_class: '甲类',
    conclusion: 'BOUND',
    status,
    raw_code: material_code,
  });
}

describe('test_state_machine · 条目状态机全量迁移表', () => {
  beforeEach(() => {
    ledger = openLedger(':memory:');
    importMasterData(ledger.db, { operationsCsv, materialsCsv });
  });

  /* ---------------------------------------------------------- ① 全量矩阵 64 对 */
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      it(`① 迁移矩阵 ${from} → ${to}：${EXPECTED_ALLOWED.has(`${from}->${to}`) ? '放行' : '拒绝'}`, () => {
        const expected = EXPECTED_ALLOWED.has(`${from}->${to}`);
        assert.equal(canTransition(from, to), expected, `${from} → ${to} 判定与预期不符`);
        assert.equal(transitionDecision(from, to).allowed, expected);

        if (expected) {
          assert.doesNotThrow(() => assertTransition(from, to));
        } else {
          assert.throws(
            () => assertTransition(from, to),
            (error: unknown) => {
              assert.ok(error instanceof StateTransitionError);
              assert.equal(error.code, 'ERR_ILLEGAL_STATE_TRANSITION');
              assert.equal(error.from, from);
              assert.equal(error.to, to);
              return true;
            },
          );
        }
      });
    }
  }

  it('① 全量矩阵恰好覆盖 64 对，每对出现一次', () => {
    assert.equal(FULL_TRANSITION_MATRIX.length, 64);
    const seen = new Set(FULL_TRANSITION_MATRIX.map((d) => `${d.from}->${d.to}`));
    assert.equal(seen.size, 64);
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        assert.ok(seen.has(`${from}->${to}`), `矩阵缺少 ${from} → ${to}`);
      }
    }
    // 矩阵里的放行集合与独立预期完全一致
    const matrixAllowed = FULL_TRANSITION_MATRIX.filter((d) => d.allowed).map((d) => `${d.from}->${d.to}`);
    assert.deepEqual([...matrixAllowed].sort(), [...EXPECTED_ALLOWED].sort());
  });

  /* ---------------------------------------------------------- ② 角色校验 */
  it('② 每条放行边都标注触发方，角色不符一律拒绝', () => {
    for (const decision of FULL_TRANSITION_MATRIX) {
      if (!decision.allowed) {
        if (decision.kind === 'manual_retract') {
          // 人工撤回：自动迁移不放行，但角色信息保留（撤回走独立断言）
          assert.deepEqual([...decision.actors], ['revoke']);
          assert.equal(
            canTransition(decision.from, decision.to, 'revoke'),
            false,
            `${decision.from} → ${decision.to} 自动迁移不得放行`,
          );
        } else {
          assert.deepEqual([...decision.actors], [], `${decision.from} → ${decision.to} 不该有放行角色`);
        }
        continue;
      }
      assert.ok(decision.actors.length > 0, `${decision.from} → ${decision.to} 必须标注触发方`);
      for (const actor of decision.actors) {
        assert.equal(canTransition(decision.from, decision.to, actor), true);
      }
      // 表里没有的角色一律无权推进
      assert.equal(
        canTransition(decision.from, decision.to, '__unknown_actor__' as TransitionActor),
        false,
        `${decision.from} → ${decision.to} 不该放行未知角色`,
      );
    }
    // 边表与矩阵口径一致：推进边 + 幂等自环边 = 矩阵里的放行集合
    assert.equal(ADVANCE_EDGES.length + SELF_LOOP_EDGES.length, EXPECTED_ALLOWED.size);
  });

  /* ---------------------------------------------------------- ③ 终态保护 */
  it('③ closed 是终态：自动迁移表里没有任何出边', () => {
    assert.deepEqual([...TERMINAL_STATES], ['closed']);
    assert.equal(isTerminal('closed'), true);
    assert.deepEqual(allowedTargets('closed'), []);
    for (const to of ALL_STATES) {
      assert.equal(canTransition('closed', to), false, `closed → ${to} 应当被拒`);
      assert.throws(() => assertTransition('closed', to), StateTransitionError);
    }
  });

  it('③ charged 不允许回到 rejected / parsed（已计费不自动冲正）', () => {
    assert.equal(canTransition('charged', 'rejected'), false);
    assert.equal(canTransition('charged', 'parsed'), false);
    assert.equal(canTransition('charged', 'scanned'), false);
    assert.equal(canTransition('charged', 'bound'), false);
    assert.equal(canTransition('charged', 'closed'), false);
    // 仍允许的去向：确认、存疑转人工
    assert.equal(canTransition('charged', 'confirmed'), true);
    assert.equal(canTransition('charged', 'check_pending'), true);
    // 拒绝时带得上「不自动冲正」这句人话
    const decision = transitionDecision('charged', 'rejected');
    assert.equal(decision.kind, 'forbidden');
    assert.match(decision.note, /不自动冲正/);
  });

  /* ---------------------------------------------------------- ④ 人工撤回是独立入口 */
  it('④ 人工撤回独立于自动迁移表：只有 revoke 角色成立', () => {
    assert.equal(MANUAL_REVOKE_EDGES.length, 1);
    assert.equal(canManualRevoke('closed', 'check_pending', 'revoke'), true);
    assert.equal(canManualRevoke('closed', 'check_pending', 'manual_confirm'), false);
    assert.equal(canManualRevoke('closed', 'check_pending', 'binding_engine'), false);
    assert.equal(canManualRevoke('charged', 'check_pending', 'revoke'), false);
    // 自动迁移表里 closed 仍然没有出边（终态保护不被撤回入口破坏）
    assert.equal(canTransition('closed', 'check_pending'), false);
    const decision = transitionDecision('closed', 'check_pending');
    assert.equal(decision.kind, 'manual_retract');
    assert.equal(decision.allowed, false);
  });

  /* ---------------------------------------------------------- ⑤ 幂等自环 */
  it('⑤ 幂等自环放行但不推进状态、不重写确认时间', () => {
    assert.equal(isSelfLoop('check_pending', 'check_pending'), true);
    assert.equal(isSelfLoop('confirmed', 'confirmed'), true);
    assert.equal(transitionDecision('check_pending', 'check_pending').kind, 'self_loop');
    assert.equal(transitionDecision('confirmed', 'confirmed').kind, 'self_loop');

    // check_pending → check_pending：状态不推进
    const pendingId = seedBinding('check_pending', 'MAT-SAMPLE-02', OPEN_OP);
    const taskId = createCheckTask(ledger.db, {
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      dept_code: 'SURG-01',
      scanner_id: 'SCANNER-01',
      material_code: 'MAT-SAMPLE-02',
      quantity: 1,
      conclusion: 'NOT_REGISTERED',
      reason_code: 'MATERIAL_NOT_REGISTERED',
      binding_id: pendingId,
    });
    const before = findBindingById(ledger.db, pendingId);
    assert.equal(before?.status, 'check_pending');

    const step = transitionBindingStatus(ledger.db, {
      binding_id: pendingId,
      material_code: 'MAT-SAMPLE-02',
      operation_no: OPEN_OP,
      to: 'check_pending',
      actor: 'manual_confirm',
    });
    assert.deepEqual(step, { from: 'check_pending', to: 'check_pending' });
    assert.equal(findBindingById(ledger.db, pendingId)?.status, 'check_pending', '自环不得推进状态');

    // 核查条目不被自环顺手关掉、确认时间不被重写
    const task = findCheckTask(ledger.db, taskId);
    assert.equal(task?.status, 'pending');
    assert.equal(task?.confirmed_at, null);

    // confirmed → confirmed：同样不推进
    const confirmedId = seedBinding('confirmed', 'MAT-SAMPLE-03', OPEN_OP);
    const step2 = transitionBindingStatus(ledger.db, {
      binding_id: confirmedId,
      material_code: 'MAT-SAMPLE-03',
      operation_no: OPEN_OP,
      to: 'confirmed',
      actor: 'manual_confirm',
    });
    assert.deepEqual(step2, { from: 'confirmed', to: 'confirmed' });
    assert.equal(findBindingById(ledger.db, confirmedId)?.status, 'confirmed');
  });

  /* ---------------------------------------------------------- ⑥ 非法迁移不改台账 + 记拒绝痕迹 */
  it('⑥ 非法迁移被拒：台账行不改动，并留下拒绝痕迹', () => {
    const id = seedBinding('charged', 'MAT-SAMPLE-04', OPEN_OP);
    const before = findBindingById(ledger.db, id);
    const auditBefore = countAuditRows(ledger.db);

    assert.throws(
      () =>
        transitionBindingStatus(ledger.db, {
          binding_id: id,
          material_code: 'MAT-SAMPLE-04',
          operation_no: OPEN_OP,
          to: 'rejected',
          actor: 'charge_writeback',
        }),
      (error: unknown) => {
        assert.ok(error instanceof StateTransitionError);
        assert.equal(error.code, 'ERR_ILLEGAL_STATE_TRANSITION');
        assert.equal(error.from, 'charged');
        assert.equal(error.to, 'rejected');
        assert.equal(error.actor, 'charge_writeback');
        assert.match(error.message, /不自动冲正|不在合法迁移表内/);
        return true;
      },
    );

    // 台账行一个字节都没改（失败不静默改数据）
    const after = findBindingById(ledger.db, id);
    assert.equal(after?.status, 'charged', '被拒的迁移不得改动台账状态');
    assert.equal(after?.status, before?.status);

    // 但「有人试图越界」这件事留下痕迹
    assert.equal(countAuditRows(ledger.db), auditBefore + 1);
    assert.equal(countRejectedTransitions(ledger.db), 1);
    const rejected = queryStateTransitions(ledger.db, deriveIdempotencyKey('MAT-SAMPLE-04', OPEN_OP));
    const rejection = rejected.find((row) => row.event_type === STATE_TRANSITION_REJECTED_EVENT);
    assert.ok(rejection, '应有拒绝痕迹');
    assert.equal(rejection.from, 'charged');
    assert.equal(rejection.to, 'rejected');
    assert.equal(rejection.actor, 'charge_writeback');
  });

  it('⑥ 人工撤回越界同样被拒且不改台账', () => {
    const id = seedBinding('charged', 'MAT-SAMPLE-05', OPEN_OP);
    assert.throws(
      () =>
        manualRevokeBindingStatus(ledger.db, {
          binding_id: id,
          to: 'check_pending',
          actor: 'revoke',
        }),
      StateTransitionError,
    );
    assert.equal(findBindingById(ledger.db, id)?.status, 'charged');
    assert.equal(countRejectedTransitions(ledger.db), 1);
  });

  /* ---------------------------------------------------------- ⑦ 迁移轨迹留痕与回放 */
  it('⑦ 成功迁移在审计链留一行（from / to / actor / request_id / created_at），可回放', () => {
    const id = seedBinding('bound', 'MAT-SAMPLE-06', OPEN_OP_2);
    const key = deriveIdempotencyKey('MAT-SAMPLE-06', OPEN_OP_2);

    const step = transitionBindingStatus(ledger.db, {
      binding_id: id,
      material_code: 'MAT-SAMPLE-06',
      operation_no: OPEN_OP_2,
      to: 'charged',
      actor: 'charge_writeback',
      request_id: 'req-charge-0001',
    });
    assert.deepEqual(step, { from: 'bound', to: 'charged' });
    assert.equal(findBindingById(ledger.db, id)?.status, 'charged');

    const rows = queryStateTransitions(ledger.db, key);
    assert.equal(rows.length, 1);
    const row = rows[0] as (typeof rows)[number];
    assert.equal(row.event_type, STATE_TRANSITION_EVENT);
    assert.equal(row.from, 'bound');
    assert.equal(row.to, 'charged');
    assert.equal(row.actor, 'charge_writeback');
    assert.equal(row.request_id, 'req-charge-0001');
    assert.ok(row.created_at, '迁移行必须带写入时刻');

    // 明细里也带着 from / to / actor / request_id，便于直接看
    const raw = ledger.db
      .prepare("SELECT detail FROM audit_chain WHERE event_type = ? AND binding_key = ?")
      .get(STATE_TRANSITION_EVENT, key) as { detail: string };
    const detail = JSON.parse(raw.detail) as Record<string, unknown>;
    assert.equal(detail.from, 'bound');
    assert.equal(detail.to, 'charged');
    assert.equal(detail.actor, 'charge_writeback');
    assert.equal(detail.request_id, 'req-charge-0001');
  });

  it('⑦ 状态序列可回放：推进与被拒按写入顺序排在一起', () => {
    const id = seedBinding('bound', 'MAT-SAMPLE-02', OPEN_OP_2);
    const key = deriveIdempotencyKey('MAT-SAMPLE-02', OPEN_OP_2);

    transitionBindingStatus(ledger.db, {
      binding_id: id,
      material_code: 'MAT-SAMPLE-02',
      operation_no: OPEN_OP_2,
      to: 'charged',
      actor: 'charge_writeback',
      request_id: 'req-1',
    });
    // 越界尝试：已计费不得退回 rejected
    assert.throws(
      () =>
        transitionBindingStatus(ledger.db, {
          binding_id: id,
          material_code: 'MAT-SAMPLE-02',
          operation_no: OPEN_OP_2,
          to: 'rejected',
          actor: 'charge_writeback',
          request_id: 'req-2',
        }),
      StateTransitionError,
    );
    // 再推进一次：转人工
    transitionBindingStatus(ledger.db, {
      binding_id: id,
      material_code: 'MAT-SAMPLE-02',
      operation_no: OPEN_OP_2,
      to: 'check_pending',
      actor: 'manual_confirm',
      request_id: 'req-3',
    });

    const sequence = replayStateSequence(ledger.db, key);
    assert.equal(sequence.length, 3);
    assert.deepEqual(
      sequence.map((step) => [step.from, step.to, step.rejected]),
      [
        ['bound', 'charged', false],
        ['charged', 'rejected', true],
        ['charged', 'check_pending', false],
      ],
    );
    assert.deepEqual(
      sequence.map((step) => step.request_id),
      ['req-1', 'req-2', 'req-3'],
    );
  });

  it('⑦ 迁移轨迹只增不改：审计层不提供 update / delete', async () => {
    const audit = await import('../src/ledger/audit.js');
    assert.equal(typeof audit.appendAudit, 'function');
    assert.equal((audit as Record<string, unknown>).updateAudit, undefined);
    assert.equal((audit as Record<string, unknown>).deleteAudit, undefined);
    assert.equal((audit as Record<string, unknown>).removeAudit, undefined);
  });
});
