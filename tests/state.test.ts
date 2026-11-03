/**
 * test_state：条目状态机 —— 合法迁移放行、白名单外迁移拒绝并带错误码。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_STATES,
  StateTransitionError,
  allowedTargets,
  assertTransition,
  canTransition,
  isTerminal,
  type BindingState,
} from '../src/domain/state.js';

describe('test_state · 条目状态机', () => {
  it('八个状态齐备', () => {
    assert.deepEqual([...ALL_STATES].sort(), [
      'bound',
      'charged',
      'check_pending',
      'closed',
      'confirmed',
      'parsed',
      'rejected',
      'scanned',
    ]);
  });

  it('主路径 scanned → parsed → bound → charged → confirmed → closed 全程合法', () => {
    const path: BindingState[] = ['scanned', 'parsed', 'bound', 'charged', 'confirmed', 'closed'];
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i] as BindingState;
      const to = path[i + 1] as BindingState;
      assert.equal(canTransition(from, to), true, `${from} → ${to} 应当合法`);
      assert.doesNotThrow(() => assertTransition(from, to));
    }
  });

  it('异常支线 parsed → rejected → check_pending → closed 合法', () => {
    assert.equal(canTransition('parsed', 'rejected'), true);
    assert.equal(canTransition('rejected', 'check_pending'), true);
    assert.equal(canTransition('check_pending', 'closed'), true);
    assert.equal(canTransition('bound', 'check_pending'), true);
  });

  it('白名单外的迁移一律拒绝并带错误码', () => {
    const illegal: Array<[BindingState, BindingState]> = [
      ['scanned', 'bound'],
      ['scanned', 'charged'],
      ['parsed', 'charged'],
      ['bound', 'confirmed'],
      ['charged', 'rejected'],
      ['charged', 'parsed'],
      ['rejected', 'charged'],
      ['closed', 'check_pending'],
      ['closed', 'scanned'],
    ];
    for (const [from, to] of illegal) {
      assert.equal(canTransition(from, to), false, `${from} → ${to} 应当被拒`);
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

  it('closed 是终态：没有任何出边', () => {
    assert.deepEqual(allowedTargets('closed'), []);
    assert.equal(isTerminal('closed'), true);
    assert.equal(isTerminal('check_pending'), false);
  });

  it('幂等自环：check_pending → check_pending 与 confirmed → confirmed 放行', () => {
    assert.equal(canTransition('check_pending', 'check_pending'), true);
    assert.equal(canTransition('confirmed', 'confirmed'), true);
    assert.doesNotThrow(() => assertTransition('check_pending', 'check_pending', 'revoke'));
  });

  it('角色不符时拒绝：只有绑定引擎能把 parsed 推成 bound', () => {
    assert.equal(canTransition('parsed', 'bound', 'binding_engine'), true);
    assert.equal(canTransition('parsed', 'bound', 'manual_confirm'), false);
    assert.throws(() => assertTransition('parsed', 'bound', 'manual_confirm'), StateTransitionError);
  });
});
