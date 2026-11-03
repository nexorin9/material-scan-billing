/**
 * test_check_task：核查任务台账 —— 异常条目生成核查任务、人工确认回写与撤回。
 *
 * 覆盖：
 *   ① 四类异常（未建档 / 跨台次重复 / 台次已关台 / 计费业务拒绝）各生成 1 条
 *      **带台次上下文**的核查条目（台次 / 手术间 / 科室 / 扫码枪 / 耗材码 / 数量 / 结论 / 原因码）；
 *   ② 核查条目 ↔ 耗材使用台账行**双向挂接**；
 *   ③ 人工确认：条目状态推进到 closed + 审计链新增一行；
 *   ④ 人工撤回：条目状态退回 check_pending；
 *   ⑤ 重复确认被拒（带错误码）；
 *   ⑥ 已回写计费的条目撤回时**不自动冲正**（计费侧一概不动）；
 *   ⑦ 台账状态机白名单外迁移一律拒绝，且不改动任何数据；
 *   ⑧ 撤回未落定的核查条目被拒；确认不存在的核查条目被拒；
 *   ⑨ 重复投递同一次扫码不刷重复待办；
 *   ⑩ 撤回轨迹留在审计链里，可回放处置过程。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import {
  findBindingById,
  findLatestBindingByCodeAndOperation,
  readBindingStatus,
  transitionBindingStatus,
  type BindingRowRef,
} from '../src/ledger/binding-repo.js';
import { countAuditByType, countAuditRows } from '../src/ledger/audit.js';
import { recordReceipt } from '../src/charge/receipt.js';
import { StateTransitionError } from '../src/domain/state.js';
import { bindOne } from '../src/engine/binding.js';
import { concludeAndRecord } from '../src/engine/conclude.js';
import {
  CheckTaskError,
  confirmTask,
  countCheckTasks,
  createCheckTask,
  findCheckTask,
  listPendingCheckTasks,
  revokeTask,
  type CheckTaskRow,
} from '../src/check/task.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const OPEN_OP = 'OP-SAMPLE-001';
const OPEN_OP_2 = 'OP-SAMPLE-002';
const CLOSED_OP = 'OP-SAMPLE-003';

let ledger: LedgerDb;

/** 造一个「计费业务拒绝 → 转核查」的现场：台账行已落、状态转待核查、核查条目已挂上 */
function chargeRejectedScenario(
  materialCode: string,
  operationNo: string,
): { task: CheckTaskRow; binding: BindingRowRef } {
  const bound = bindOne(ledger.db, {
    db: ledger.db,
    operation_no: operationNo,
    room_no: 'OR-02',
    scanner_id: 'SCANNER-07',
    material_code: materialCode,
    raw_code: materialCode,
    quantity: 2,
  });
  assert.equal(bound.bound, true, '前提：这条耗材先绑上本台次');

  const concluded = concludeAndRecord(ledger.db, {
    db: ledger.db,
    operation_no: operationNo,
    room_no: 'OR-02',
    scanner_id: 'SCANNER-07',
    material_code: materialCode,
    raw_code: materialCode,
    quantity: 2,
    charge_rejection: { reason_code: 'PRICE_CODE_NOT_FOUND', message: '价码不存在' },
  });
  assert.equal(concluded.conclusion, 'CHARGE_REJECTED');

  const task = findCheckTask(ledger.db, concluded.check_task_id as number);
  assert.ok(task, '前提：计费业务拒绝已升成核查条目');

  // 计费侧转人工：台账行 bound → check_pending
  transitionBindingStatus(ledger.db, {
    material_code: materialCode,
    operation_no: operationNo,
    to: 'check_pending',
    actor: 'charge_writeback',
    check_task_id: task.id,
  });

  const binding = findLatestBindingByCodeAndOperation(ledger.db, materialCode, operationNo);
  assert.ok(binding, '前提：台账行存在');
  return { task, binding };
}

describe('test_check_task · 核查任务台账', () => {
  beforeEach(() => {
    ledger = openLedger(':memory:');
    importMasterData(ledger.db, { operationsCsv, materialsCsv });
  });

  it('① 四类异常各生成 1 条带台次上下文的核查条目', () => {
    // (a) 耗材码未建档
    bindOne(ledger.db, {
      db: ledger.db,
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      scanner_id: 'SCANNER-01',
      material_code: 'MAT-NOT-REGISTERED',
      raw_code: 'MAT-NOT-REGISTERED',
      quantity: 1,
    });

    // (b) 跨台次重复：先绑 OP-SAMPLE-001，再扫到 OP-SAMPLE-002
    bindOne(ledger.db, {
      db: ledger.db,
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      scanner_id: 'SCANNER-01',
      material_code: 'MAT-SAMPLE-01',
      raw_code: 'MAT-SAMPLE-01',
      quantity: 1,
    });
    bindOne(ledger.db, {
      db: ledger.db,
      operation_no: OPEN_OP_2,
      room_no: 'OR-02',
      scanner_id: 'SCANNER-02',
      material_code: 'MAT-SAMPLE-01',
      raw_code: 'MAT-SAMPLE-01',
      quantity: 1,
    });

    // (c) 台次已关台
    bindOne(ledger.db, {
      db: ledger.db,
      operation_no: CLOSED_OP,
      room_no: 'OR-03',
      scanner_id: 'SCANNER-03',
      material_code: 'MAT-SAMPLE-02',
      raw_code: 'MAT-SAMPLE-02',
      quantity: 1,
    });

    // (d) 计费业务拒绝
    chargeRejectedScenario('MAT-SAMPLE-03', OPEN_OP_2);

    assert.equal(countCheckTasks(ledger.db), 4, '四类异常各一条核查条目');

    const tasks = listPendingCheckTasks(ledger.db);
    const byConclusion = new Map(tasks.map((task) => [task.conclusion, task]));
    assert.deepEqual(
      [...byConclusion.keys()].sort(),
      ['CHARGE_REJECTED', 'CLOSED', 'CROSS_OP_DUP', 'NOT_REGISTERED'],
    );

    for (const task of tasks) {
      // 台次上下文齐全：台次 / 手术间 / 科室 / 扫码枪 / 耗材码 / 数量 / 结论 / 原因码 / 检出时间
      assert.ok(task.operation_no, '核查条目必须带台次号');
      assert.ok(task.room_no, '核查条目必须带手术间');
      assert.ok(task.dept_code, '核查条目必须带科室');
      assert.ok(task.scanner_id, '核查条目必须带扫码枪');
      assert.ok(task.material_code, '核查条目必须带耗材码');
      assert.equal(typeof task.quantity, 'number', '核查条目必须带数量');
      assert.ok((task.quantity ?? 0) > 0, '核查条目的数量必须为正');
      assert.ok(task.reason_code, '核查条目必须带原因码');
      assert.ok(task.detected_at, '核查条目必须带检出时间');
      assert.equal(task.status, 'pending', '新建核查条目处于待核查');
    }

    // 每条核查条目带的是**本次扫码的**数量（不是固定值）
    assert.equal(byConclusion.get('NOT_REGISTERED')?.quantity, 1);
    assert.equal(byConclusion.get('CROSS_OP_DUP')?.quantity, 1);
    assert.equal(byConclusion.get('CLOSED')?.quantity, 1);
    assert.equal(byConclusion.get('CHARGE_REJECTED')?.quantity, 2);

    // 跨台次重复条目保留先到者归属
    const dup = byConclusion.get('CROSS_OP_DUP');
    assert.equal(dup?.source_operation_no, OPEN_OP);
    assert.equal(dup?.source_room_no, 'OR-01');
  });

  it('② 核查条目与台账行双向挂接', () => {
    const { task, binding } = chargeRejectedScenario('MAT-SAMPLE-04', OPEN_OP_2);

    assert.equal(task.binding_id, binding.id, '核查条目指向台账行');
    assert.equal(binding.check_task_id, task.id, '台账行反向指向核查条目');
    const reloaded = findBindingById(ledger.db, binding.id);
    assert.equal(reloaded?.check_task_id, task.id);
  });

  it('③ 人工确认：条目状态推进到 closed，审计链新增一行', () => {
    const { task } = chargeRejectedScenario('MAT-SAMPLE-05', OPEN_OP_2);
    const auditBefore = countAuditRows(ledger.db);
    const confirmedBefore = countAuditByType(ledger.db, 'check_task_confirmed');
    const transitionBefore = countAuditByType(ledger.db, 'state_transition');

    const result = confirmTask(ledger.db, task.id, '计费补录已完成，核对无误', '护士长 张敏');

    assert.equal(result.conclusion, '计费补录已完成，核对无误');
    assert.equal(result.operator, '护士长 张敏');
    assert.equal(result.binding_transition?.from, 'check_pending');
    assert.equal(result.binding_transition?.to, 'closed');

    // 台账行状态推进到 closed
    assert.equal(
      readBindingStatus(ledger.db, 'MAT-SAMPLE-05', OPEN_OP_2),
      'closed',
      '确认后台账行状态为 closed',
    );

    // 核查条目落定
    const confirmed = findCheckTask(ledger.db, task.id);
    assert.equal(confirmed?.status, 'closed');
    assert.equal(confirmed?.confirmed_by, '护士长 张敏');
    assert.equal(confirmed?.confirmed_conclusion, '计费补录已完成，核对无误');
    assert.ok(confirmed?.confirmed_at);

    // 审计链新增两行：确认动作一行（可回放）+ 状态迁移轨迹一行（check_pending → closed）
    assert.equal(countAuditRows(ledger.db), auditBefore + 2);
    assert.equal(countAuditByType(ledger.db, 'check_task_confirmed'), confirmedBefore + 1);
    assert.equal(countAuditByType(ledger.db, 'state_transition'), transitionBefore + 1);
    const auditRow = ledger.db
      .prepare("SELECT event_type, actor FROM audit_chain WHERE event_type = 'check_task_confirmed'")
      .get() as { event_type: string; actor: string };
    assert.equal(auditRow.actor, 'manual_confirm');
  });

  it('④ 人工撤回：条目状态退回 check_pending', () => {
    const { task } = chargeRejectedScenario('MAT-SAMPLE-02', OPEN_OP_2);
    confirmTask(ledger.db, task.id, '先按计费补录处理', '护士长 张敏');
    assert.equal(readBindingStatus(ledger.db, 'MAT-SAMPLE-02', OPEN_OP_2), 'closed');

    const revoked = revokeTask(ledger.db, task.id, '护士长 张敏');

    assert.equal(revoked.binding_transition?.from, 'closed');
    assert.equal(revoked.binding_transition?.to, 'check_pending');
    assert.equal(
      readBindingStatus(ledger.db, 'MAT-SAMPLE-02', OPEN_OP_2),
      'check_pending',
      '撤回后台账行状态回到 check_pending',
    );

    const task2 = findCheckTask(ledger.db, task.id);
    assert.equal(task2?.status, 'pending', '撤回后核查条目回到待核查');
    assert.equal(task2?.confirmed_by, null);
    assert.equal(task2?.revoked_by, '护士长 张敏');
    assert.ok(task2?.revoked_at);
  });

  it('⑤ 重复确认被拒并带错误码', () => {
    const { task } = chargeRejectedScenario('MAT-SAMPLE-03', OPEN_OP_2);
    confirmTask(ledger.db, task.id, '已核对无误', '护士长 张敏');

    assert.throws(
      () => confirmTask(ledger.db, task.id, '再确认一次', '护士长 张敏'),
      (error: unknown) => {
        assert.ok(error instanceof CheckTaskError);
        assert.equal(error.code, 'ERR_CHECK_TASK_ALREADY_CLOSED');
        return true;
      },
    );
  });

  it('⑥ 已回写计费的条目撤回时不自动冲正', () => {
    const { task } = chargeRejectedScenario('MAT-SAMPLE-04', OPEN_OP_2);

    // 这条此前已回写计费（对端 accepted 过）
    recordReceipt(ledger.db, {
      material_code: 'MAT-SAMPLE-04',
      operation_no: OPEN_OP_2,
      idempotency_key: 'idem-sample-04',
      key_profile: 'v1',
      request_idempotency_key: 'idem-request-sample-04',
      peer_idempotency_status: 'NOT_ECHOED',
      attempt: 1,
      delivery_count: 1,
      accepted: true,
      kind: 'ACCEPTED',
      reason_code: null,
      error_code: null,
      channel_reachable: true,
      retryable: false,
      disposition: null,
      requested_at: '2026-02-01T10:00:00+08:00',
      responded_at: '2026-02-01T10:00:01+08:00',
      response_summary: '对端已接收',
    });

    confirmTask(ledger.db, task.id, '计费已回写，核对无误', '收费员 李强');
    const revoked = revokeTask(ledger.db, task.id, '护士长 张敏');

    assert.equal(revoked.already_charged, true, '识别出该条目已回写计费');
    assert.equal(revoked.charge_reversed, false, '不自动冲正');

    // 计费侧一概不动：回执行原样保留
    const receipts = ledger.db
      .prepare('SELECT accepted, delivery_count FROM charge_receipt WHERE material_code = ?')
      .all('MAT-SAMPLE-04') as Array<{ accepted: number; delivery_count: number }>;
    assert.equal(receipts.length, 1, '撤回不产生任何冲正回执');
    assert.equal(receipts[0]?.accepted, 1, '原有回执不被改写');
    assert.equal(receipts[0]?.delivery_count, 1);
  });

  it('⑦ 白名单外迁移一律拒绝，且不改动任何数据', () => {
    // 台账行停在 bound（推不到 closed）
    const bound = bindOne(ledger.db, {
      db: ledger.db,
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      scanner_id: 'SCANNER-01',
      material_code: 'MAT-SAMPLE-01',
      raw_code: 'MAT-SAMPLE-01',
      quantity: 1,
    });
    assert.equal(bound.bound, true);

    const taskId = createCheckTask(ledger.db, {
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      dept_code: 'SURG-01',
      scanner_id: 'SCANNER-01',
      material_code: 'MAT-SAMPLE-01',
      quantity: 1,
      conclusion: 'CHARGE_REJECTED',
      reason_code: 'PRICE_CODE_NOT_FOUND',
    });
    const auditBefore = countAuditRows(ledger.db);
    const confirmedBefore = countAuditByType(ledger.db, 'check_task_confirmed');
    const transitionBefore = countAuditByType(ledger.db, 'state_transition');
    const rejectedBefore = countAuditByType(ledger.db, 'state_transition_rejected');

    assert.throws(
      () => confirmTask(ledger.db, taskId, '想直接闭环', '护士长 张敏'),
      (error: unknown) => {
        assert.ok(error instanceof StateTransitionError);
        assert.equal(error.code, 'ERR_ILLEGAL_STATE_TRANSITION');
        assert.equal(error.from, 'bound');
        assert.equal(error.to, 'closed');
        return true;
      },
    );

    // 失败不静默改数据：台账行与核查条目状态都没动
    assert.equal(readBindingStatus(ledger.db, 'MAT-SAMPLE-01', OPEN_OP), 'bound');
    assert.equal(findCheckTask(ledger.db, taskId)?.status, 'pending');
    // 审计链里没有多出任何「已落定」或「状态推进」的行
    assert.equal(countAuditByType(ledger.db, 'check_task_confirmed'), confirmedBefore);
    assert.equal(countAuditByType(ledger.db, 'state_transition'), transitionBefore);
    // 只多一行拒绝痕迹：越界这件事本身查有实据（事务回滚不该把它一起抹掉）
    assert.equal(countAuditByType(ledger.db, 'state_transition_rejected'), rejectedBefore + 1);
    assert.equal(countAuditRows(ledger.db), auditBefore + 1);
  });

  it('⑧ 撤回未落定的核查条目、确认不存在的核查条目都被拒', () => {
    const taskId = createCheckTask(ledger.db, {
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      dept_code: 'SURG-01',
      scanner_id: 'SCANNER-01',
      material_code: 'MAT-SAMPLE-02',
      quantity: 1,
      conclusion: 'NOT_REGISTERED',
      reason_code: 'MATERIAL_NOT_REGISTERED',
    });

    assert.throws(
      () => revokeTask(ledger.db, taskId, '护士长 张敏'),
      (error: unknown) => {
        assert.ok(error instanceof CheckTaskError);
        assert.equal(error.code, 'ERR_CHECK_TASK_NOT_REVOCABLE');
        return true;
      },
    );

    assert.throws(
      () => confirmTask(ledger.db, 999999, '核对无误', '护士长 张敏'),
      (error: unknown) => {
        assert.ok(error instanceof CheckTaskError);
        assert.equal(error.code, 'ERR_CHECK_TASK_NOT_FOUND');
        return true;
      },
    );
  });

  it('⑨ 重复投递同一次扫码不刷重复待办', () => {
    const input = {
      db: ledger.db,
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      scanner_id: 'SCANNER-01',
      material_code: 'MAT-NOT-REGISTERED',
      raw_code: 'MAT-NOT-REGISTERED',
      quantity: 1,
    };

    bindOne(ledger.db, input);
    const after = countCheckTasks(ledger.db);
    bindOne(ledger.db, input);
    bindOne(ledger.db, input);

    assert.equal(countCheckTasks(ledger.db), after, '重复投递不新增核查待办');
    assert.equal(listPendingCheckTasks(ledger.db).length, 1);
  });

  it('⑩ 撤回轨迹留在审计链里，可回放处置过程', () => {
    const { task } = chargeRejectedScenario('MAT-SAMPLE-05', OPEN_OP_2);
    confirmTask(ledger.db, task.id, '按补录处理', '护士长 张敏');
    revokeTask(ledger.db, task.id, '护士长 张敏');

    const rows = ledger.db
      .prepare("SELECT event_type, actor FROM audit_chain WHERE event_type LIKE 'check_task_%' ORDER BY id ASC")
      .all() as Array<{ event_type: string; actor: string }>;
    assert.deepEqual(
      rows.map((row) => row.event_type),
      // 建条目即分派（责任岗位路由）→ 人工确认 → 人工撤回：三段轨迹可回放
      ['check_task_assigned', 'check_task_confirmed', 'check_task_revoked'],
      '分派、确认与撤回各留一行审计',
    );
    assert.deepEqual(rows.map((row) => row.actor), ['check_router', 'manual_confirm', 'revoke']);
  });
});
