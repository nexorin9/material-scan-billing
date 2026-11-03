/**
 * test_check_routing：核查任务的责任岗位路由、超时提醒与逐级升级。
 *
 * 覆盖：
 *   ① 五类异常（未建档 / 跨台次重复 / 台次已关台 / 计费业务拒绝 / 归属冲突）
 *      分别路由到预期责任岗位，条目一建出来就带着岗位；
 *   ② 通道类错误码（超时 / 5xx / 熔断）路由到信息科接口工程师，不是收费员；
 *   ③ 科室决定落到哪个科室的岗位（岗位 + 科室的说法）；
 *   ④ 超时提醒**只发一次**（重复扫描不刷屏），提醒失败不阻塞台账；
 *   ⑤ 超时升级：处置档位递增、责任岗位升到上一级，**条目状态仍为待核查**（不自动闭环）；
 *   ⑥ 分派 / 提醒 / 升级三个动作各在审计链留一行，处置轨迹可回放；
 *   ⑦ 迁移 v22：五列齐备 + 路由扫描索引存在。
 *
 * 替身说明：企业微信替身是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走同一条代码路径（原生 fetch → 真实 socket），不 mock fetch。
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { readBindingStatus, transitionBindingStatus } from '../src/ledger/binding-repo.js';
import { countAuditByType, countAuditRows } from '../src/ledger/audit.js';
import { bindOne } from '../src/engine/binding.js';
import { concludeAndRecord } from '../src/engine/conclude.js';
import {
  createCheckTask,
  findCheckTask,
  listPendingCheckTasks,
  type CheckTaskRow,
} from '../src/check/task.js';
import {
  ROLE_CASHIER,
  ROLE_CASHIER_LEAD,
  ROLE_IT_INTERFACE,
  ROLE_MATERIAL_MANAGER,
  ROLE_OR_NURSE_MANAGER,
  ROLE_OR_SUPERVISOR,
  assignCheckTask,
  assignUnroutedTasks,
  escalateOverdueTasks,
  escalationDueAtMs,
  formatAssignee,
  listTasksNeedingReminder,
  remindOverdueTasks,
  resolveAssignee,
  sweepCheckTaskRouting,
  taskAgeMs,
} from '../src/check/route.js';
import { WeComBotClient } from '../src/check/notify.js';
import { runDoctor } from '../src/cli/commands.js';
import { runDaemon } from '../src/daemon/runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const WECOM_SECRET = 'wecom-sign-secret-plaintext-7c1e';
const WECOM_KEY = 'wecom-webhook-key-plaintext-4b9d';

const OPEN_OP = 'OP-SAMPLE-001';
const OPEN_OP_2 = 'OP-SAMPLE-002';
const CLOSED_OP = 'OP-SAMPLE-003';

/** 一小时（毫秒） */
const HOUR = 60 * 60 * 1000;

/* ── 企业微信替身：真实 HTTP 服务，记录收到的请求 ── */

interface CapturedRequest {
  url: string;
  body: string;
}

class WeComStub {
  readonly requests: CapturedRequest[] = [];
  private readonly server: Server;
  private status = 200;
  baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.requests.push({
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(this.status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
      });
      res.on('error', () => {
        // 客户端超时后主动断开：忽略写回失败（替身侧）
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((done) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address !== null && typeof address !== 'string') {
          this.baseUrl = `http://127.0.0.1:${address.port}`;
        }
        done();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => {
      this.server.close(() => done());
    });
  }

  setStatus(status: number): void {
    this.status = status;
  }

  reset(): void {
    this.requests.length = 0;
    this.status = 200;
  }

  webhookUrl(): string {
    return `${this.baseUrl}/cgi-bin/webhook/send?key=${WECOM_KEY}`;
  }
}

let stub: WeComStub;
let ledger: LedgerDb;

/** 守护进程用例的临时目录（结束后清掉） */
const tempDirs: string[] = [];

/** 等一小会儿（守护进程周期扫描用例用） */
function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

before(async () => {
  stub = new WeComStub();
  await stub.start();
});

after(async () => {
  await stub.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  stub.reset();
  ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
});

afterEach(() => {
  ledger.close();
});

/** 造一个企微客户端 */
function makeClient(): WeComBotClient {
  return new WeComBotClient({
    webhookUrl: stub.webhookUrl(),
    secret: WECOM_SECRET,
    logger: () => {},
  });
}

/** 取刚建出来的核查条目（按耗材码找最近一条待处理条目） */
function taskFor(materialCode: string, db: DatabaseSync = ledger.db): CheckTaskRow {
  const tasks = listPendingCheckTasks(db).filter((task) => task.material_code === materialCode);
  const task = tasks[tasks.length - 1];
  assert.ok(task, `前提：耗材 ${materialCode} 应已升成核查条目`);
  return task;
}

/** 场景①：耗材未建档 */
function notRegisteredScenario(materialCode: string): CheckTaskRow {
  bindOne(ledger.db, {
    db: ledger.db,
    operation_no: OPEN_OP,
    room_no: 'OR-01',
    scanner_id: 'SCANNER-01',
    material_code: materialCode,
    raw_code: materialCode,
    quantity: 1,
  });
  return taskFor(materialCode);
}

/** 场景②：跨台次重复（先绑 OP-SAMPLE-001，再扫到 OP-SAMPLE-002） */
function crossOpDupScenario(materialCode: string): CheckTaskRow {
  bindOne(ledger.db, {
    db: ledger.db,
    operation_no: OPEN_OP,
    room_no: 'OR-01',
    scanner_id: 'SCANNER-01',
    material_code: materialCode,
    raw_code: materialCode,
    quantity: 1,
  });
  bindOne(ledger.db, {
    db: ledger.db,
    operation_no: OPEN_OP_2,
    room_no: 'OR-02',
    scanner_id: 'SCANNER-02',
    material_code: materialCode,
    raw_code: materialCode,
    quantity: 1,
  });
  return taskFor(materialCode);
}

/** 场景③：台次已关台 */
function closedScenario(materialCode: string, db: DatabaseSync = ledger.db): CheckTaskRow {
  bindOne(db, {
    db,
    operation_no: CLOSED_OP,
    room_no: 'OR-03',
    scanner_id: 'SCANNER-03',
    material_code: materialCode,
    raw_code: materialCode,
    quantity: 1,
  });
  return taskFor(materialCode, db);
}

/** 场景④：计费业务拒绝（绑定成立但对端拒收） */
function chargeRejectedScenario(materialCode: string, operationNo: string): CheckTaskRow {
  bindOne(ledger.db, {
    db: ledger.db,
    operation_no: operationNo,
    room_no: 'OR-02',
    scanner_id: 'SCANNER-07',
    material_code: materialCode,
    raw_code: materialCode,
    quantity: 2,
  });
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
  transitionBindingStatus(ledger.db, {
    material_code: materialCode,
    operation_no: operationNo,
    to: 'check_pending',
    actor: 'charge_writeback',
    check_task_id: task.id,
  });
  return task;
}

/** 场景⑤：归属冲突（事件手术间与排台对不上） */
function attributionConflictScenario(materialCode: string): CheckTaskRow {
  bindOne(ledger.db, {
    db: ledger.db,
    operation_no: OPEN_OP,
    room_no: 'OR-99',
    scanner_id: 'SCANNER-01',
    material_code: materialCode,
    raw_code: materialCode,
    quantity: 1,
  });
  return taskFor(materialCode);
}

describe('test_check_routing · 核查任务路由与超时升级', () => {
  it('① 五类异常分别路由到预期责任岗位（条目一建出来就带着岗位）', () => {
    const notRegistered = notRegisteredScenario('MAT-NOT-REGISTERED');
    assert.equal(notRegistered.conclusion, 'NOT_REGISTERED');
    assert.equal(notRegistered.reason_code, 'MATERIAL_NOT_REGISTERED');
    assert.equal(notRegistered.assignee_role, ROLE_MATERIAL_MANAGER, '未建档 → 高值耗材管理岗');
    assert.ok(notRegistered.assigned_at, '分派时点必须落库');

    const crossOp = crossOpDupScenario('MAT-SAMPLE-01');
    assert.equal(crossOp.conclusion, 'CROSS_OP_DUP');
    assert.equal(crossOp.assignee_role, ROLE_OR_NURSE_MANAGER, '跨台次重复 → 手术室护士长');

    const closed = closedScenario('MAT-SAMPLE-02');
    assert.equal(closed.conclusion, 'CLOSED');
    assert.equal(closed.assignee_role, ROLE_OR_NURSE_MANAGER, '台次已关台 → 手术室护士长');

    const rejected = chargeRejectedScenario('MAT-SAMPLE-03', OPEN_OP_2);
    assert.equal(rejected.conclusion, 'CHARGE_REJECTED');
    assert.equal(rejected.assignee_role, ROLE_CASHIER, '计费业务拒绝 → 收费员');

    const conflict = attributionConflictScenario('MAT-SAMPLE-04');
    assert.equal(conflict.conclusion, 'NOT_REGISTERED');
    assert.equal(conflict.reason_code, 'OPERATION_ATTRIBUTION_CONFLICT');
    assert.equal(conflict.assignee_role, ROLE_OR_NURSE_MANAGER, '归属冲突 → 手术室护士长');

    // 路由依据说得清「为什么找你」
    const resolution = resolveAssignee({
      conclusion: 'CHARGE_REJECTED',
      reason_code: 'PRICE_CODE_NOT_FOUND',
      dept_code: 'SURG-01',
    });
    assert.equal(resolution.role, ROLE_CASHIER);
    assert.equal(resolution.matched_by, 'reason_code');
    assert.equal(resolution.matched_key, 'PRICE_CODE_NOT_FOUND');
    assert.ok(resolution.basis_zh.length > 5, '分派依据必须是一句中文说明');
  });

  it('② 通道类错误码路由到信息科接口工程师（联调问题不是业务问题）', () => {
    const resolution = resolveAssignee({
      conclusion: 'CHARGE_REJECTED',
      reason_code: 'CHARGE_FAILED',
      error_code: 'ERR_CHARGE_TIMEOUT',
    });
    assert.equal(resolution.role, ROLE_IT_INTERFACE);
    assert.equal(resolution.matched_by, 'error_code');

    // 落到台账里也是同一个岗位
    const task = createCheckTask(ledger.db, {
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      dept_code: 'SURG-01',
      material_code: 'MAT-SAMPLE-05',
      quantity: 1,
      conclusion: 'CHARGE_REJECTED',
      reason_code: 'CHARGE_FAILED',
      error_code: 'ERR_CHARGE_CIRCUIT_OPEN',
    });
    const row = findCheckTask(ledger.db, task);
    assert.equal(row?.assignee_role, ROLE_IT_INTERFACE);
  });

  it('③ 科室决定落到哪个科室的岗位（岗位 + 科室的说法）', () => {
    assert.equal(formatAssignee(ROLE_OR_NURSE_MANAGER, 'SURG-ORT'), '手术室护士长（SURG-ORT）');
    assert.equal(formatAssignee(ROLE_OR_NURSE_MANAGER, '  '), '手术室护士长');
    assert.equal(formatAssignee(ROLE_OR_NURSE_MANAGER, null), '手术室护士长');

    const task = notRegisteredScenario('MAT-NOT-REGISTERED');
    const row = ledger.db
      .prepare(
        `SELECT detail FROM audit_chain
          WHERE event_type = 'check_task_assigned' AND operation_no = ?`,
      )
      .get(task.operation_no) as { detail: string };
    const detail = JSON.parse(row.detail) as {
      dept_code: string;
      assignee_display: string;
      basis_zh: string;
    };
    assert.equal(detail.dept_code, 'SURG-01', '分派依据必须带上科室');
    assert.ok(detail.assignee_display.includes('SURG-01'), '面向人的说法必须带科室');
    assert.ok(detail.basis_zh.includes('建档'), '分派依据要说清为什么找你');
  });

  it('④ 超时提醒只发一次（重复扫描不刷屏），失败不阻塞台账', async () => {
    const task = closedScenario('MAT-SAMPLE-02');
    const client = makeClient();
    const base = Date.now();

    // 未到时限：不提醒
    assert.equal(listTasksNeedingReminder(ledger.db, { nowMs: base + HOUR }).length, 0);
    assert.equal(stub.requests.length, 0, '没超时就不该发消息');

    // 超时（手术室护士长 2 小时）：提醒一次
    const first = await remindOverdueTasks(ledger.db, client, { nowMs: base + 3 * HOUR });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.sent, true);
    assert.equal(stub.requests.length, 1, '超时提醒发出一条');
    const body = JSON.parse(stub.requests[0]?.body ?? '{}') as {
      msgtype: string;
      markdown: { content: string };
    };
    assert.equal(body.msgtype, 'markdown');
    assert.ok(body.markdown.content.includes('核查待办超时'));
    assert.ok(body.markdown.content.includes('手术室护士长'), '提醒里要写清该谁处理');
    assert.ok(body.markdown.content.includes(task.material_code), '提醒里要点名耗材码');

    // reminded_at 落库
    const reminded = findCheckTask(ledger.db, task.id);
    assert.ok(reminded?.reminded_at, '提醒后必须记 reminded_at');

    // 再扫一次：不重复发
    const second = await remindOverdueTasks(ledger.db, client, { nowMs: base + 4 * HOUR });
    assert.equal(second.length, 0, '已提醒过的条目不再进提醒清单');
    assert.equal(stub.requests.length, 1, '同一条目只提醒一次，不刷屏');

    // 提醒失败：台账不受影响，审计链留失败痕迹，下次还能再催
    const failedTask = notRegisteredScenario('MAT-NOT-REGISTERED');
    stub.reset();
    stub.setStatus(500);
    const failed = await remindOverdueTasks(ledger.db, client, { nowMs: base + 5 * HOUR });
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.sent, false);
    assert.ok(failed[0]?.error_code, '失败必须带错误码');
    const afterFail = findCheckTask(ledger.db, failedTask.id);
    assert.equal(afterFail?.reminded_at, null, '提醒失败不写 reminded_at（下轮还能再催）');
    assert.equal(
      countAuditByType(ledger.db, 'check_task_remind_failed'),
      1,
      '提醒失败在审计链留一行',
    );
    assert.ok(countAuditRows(ledger.db) > 0, '审计链照常留痕');
  });

  it('⑤ 超时升级：档位递增、岗位升到上一级，条目状态仍为待核查', async () => {
    // 用计费业务拒绝这条：它有台账行（bound → check_pending），
    // 升级后能证明「台账状态不被系统推进」。
    const task = chargeRejectedScenario('MAT-SAMPLE-03', OPEN_OP_2);
    const base = Date.now();

    // 收费员的升级时限：8 小时 × 2^0
    assert.equal(escalationDueAtMs(ROLE_CASHIER, 0), 8 * HOUR);

    // 升级前：档位 0，责任岗位是收费员
    assert.equal(task.timeout_level, 0);
    assert.equal(task.assignee_role, ROLE_CASHIER);

    const escalations = escalateOverdueTasks(ledger.db, { nowMs: base + 9 * HOUR });
    const escalated = escalations.find((item) => item.task_id === task.id);
    assert.ok(escalated?.escalated, '超时未确认应当升级');
    assert.equal(escalated?.from_role, ROLE_CASHIER);
    assert.equal(escalated?.to_role, ROLE_CASHIER_LEAD, '升到上一级：收费处主管');
    assert.equal(escalated?.timeout_level, 1);

    const after = findCheckTask(ledger.db, task.id);
    assert.equal(after?.timeout_level, 1, '处置档位递增');
    assert.equal(after?.assignee_role, ROLE_CASHIER_LEAD);
    assert.ok(after?.escalated_at, '升级时刻必须落库');
    assert.equal(after?.status, 'pending', '升级不关闭条目：仍待人工落定结论');

    // 条目状态不动：台账行仍是待核查，系统不代人工闭环
    assert.equal(
      readBindingStatus(ledger.db, 'MAT-SAMPLE-03', OPEN_OP_2),
      'check_pending',
      '升级不推进台账状态',
    );

    // 再超时一个时限：升到第二级
    const second = escalateOverdueTasks(ledger.db, { nowMs: base + 20 * HOUR });
    const escalated2 = second.find((item) => item.task_id === task.id);
    assert.equal(escalated2?.timeout_level, 2);
    assert.equal(escalated2?.to_role, '财务科主任');

    // 已在最高档：不再往上升（再往上没有处置岗位）
    const third = escalateOverdueTasks(ledger.db, { nowMs: base + 40 * HOUR });
    const escalated3 = third.find((item) => item.task_id === task.id);
    assert.equal(escalated3?.escalated, false);
    assert.equal(escalated3?.skipped_reason, 'top_level');
    assert.equal(findCheckTask(ledger.db, task.id)?.timeout_level, 2, '档位停在最高档');
    assert.equal(
      readBindingStatus(ledger.db, 'MAT-SAMPLE-03', OPEN_OP_2),
      'check_pending',
      '顶档之后台账状态依旧不动',
    );

    // 手术室护士长那条：两小时就升级（关台条目没有台账行，只看条目状态）
    const nurseTask = closedScenario('MAT-SAMPLE-02');
    const nurse = escalateOverdueTasks(ledger.db, { nowMs: base + 3 * HOUR }).find(
      (item) => item.task_id === nurseTask.id,
    );
    assert.equal(nurse?.to_role, ROLE_OR_SUPERVISOR, '升到上一级：手术室科护士长');
    assert.equal(findCheckTask(ledger.db, nurseTask.id)?.status, 'pending');

    // 升级通知也发一条给新的责任岗位
    stub.reset();
    const client = makeClient();
    await sweepCheckTaskRouting(ledger.db, { client, nowMs: base + 41 * HOUR });
    assert.ok(stub.requests.length >= 1, '升级要通知新的责任岗位');
  });

  it('⑥ 分派 / 提醒 / 升级三个动作各在审计链留一行', async () => {
    const task = closedScenario('MAT-SAMPLE-02');
    const base = Date.now();
    const client = makeClient();

    assert.equal(countAuditByType(ledger.db, 'check_task_assigned'), 1, '分派留一行');
    await remindOverdueTasks(ledger.db, client, { nowMs: base + 3 * HOUR });
    assert.equal(countAuditByType(ledger.db, 'check_task_reminded'), 1, '提醒留一行');
    escalateOverdueTasks(ledger.db, { nowMs: base + 3 * HOUR });
    assert.equal(countAuditByType(ledger.db, 'check_task_escalated'), 1, '升级留一行');

    // 审计详情可回放处置轨迹
    const row = ledger.db
      .prepare("SELECT detail FROM audit_chain WHERE event_type = 'check_task_escalated'")
      .get() as { detail: string };
    const detail = JSON.parse(row.detail) as {
      task_id: number;
      from_role: string;
      to_role: string;
      timeout_level: number;
    };
    assert.equal(detail.task_id, task.id);
    assert.equal(detail.from_role, ROLE_OR_NURSE_MANAGER);
    assert.equal(detail.to_role, ROLE_OR_SUPERVISOR);
    assert.equal(detail.timeout_level, 1);
  });

  it('⑦ 周期扫描：补分派 → 提醒 → 升级一次跑完，且不动台账状态', async () => {
    const task = chargeRejectedScenario('MAT-SAMPLE-04', OPEN_OP_2);
    const base = Date.now();
    const client = makeClient();

    const result = await sweepCheckTaskRouting(ledger.db, { client, nowMs: base + 9 * HOUR });
    assert.equal(result.assigned, 0, '已分派的条目不重复分派');
    assert.equal(result.overdue, 1);
    assert.equal(result.reminded, 1);
    assert.equal(result.escalated, 1);

    const after = findCheckTask(ledger.db, task.id);
    assert.equal(after?.timeout_level, 1);
    assert.equal(after?.status, 'pending');
    assert.equal(readBindingStatus(ledger.db, 'MAT-SAMPLE-04', OPEN_OP_2), 'check_pending');

    // 老条目（没有责任岗位）由扫描补分派
    ledger.db.prepare('UPDATE check_task SET assignee_role = NULL, assigned_at = NULL').run();
    const assigned = assignUnroutedTasks(ledger.db, { nowMs: base });
    assert.equal(assigned.length, 1);
    assert.equal(assigned[0]?.changed, true);
    assert.equal(assigned[0]?.role, ROLE_CASHIER);
    assert.equal(findCheckTask(ledger.db, task.id)?.assignee_role, ROLE_CASHIER);

    // 已派过的条目再分派一次：不动（幂等），不重写分派时点
    const again = assignCheckTask(ledger.db, task.id, { nowMs: base + HOUR });
    assert.equal(again.changed, false);
    assert.equal(again.skipped_reason, 'already_assigned');
  });

  it('⑧ 台龄按分派时点算（条目建出来到被分派之间不算岗位的责任）', () => {
    const task = closedScenario('MAT-SAMPLE-02');
    const base = Date.now();
    const age = taskAgeMs(
      { ...task, assigned_at: new Date(base - 5 * HOUR).toISOString() },
      base,
    );
    assert.equal(age, 5 * HOUR);
  });

  it('⑨ 迁移 v22：五列齐备 + 路由扫描索引存在', () => {
    const columns = (
      ledger.db.prepare('PRAGMA table_info(check_task)').all() as unknown as Array<{ name: string }>
    ).map((row) => row.name);
    for (const column of [
      'assignee_role',
      'assigned_at',
      'reminded_at',
      'escalated_at',
      'timeout_level',
    ]) {
      assert.ok(columns.includes(column), `check_task 必须有 ${column} 列`);
    }

    const index = ledger.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_check_task_routing'")
      .get() as { name?: string } | undefined;
    assert.ok(index?.name, '路由扫描索引 ix_check_task_routing 必须存在');
  });

  it('⑩ 升级链与岗位时限口径固定（各岗位在班节奏不同）', () => {
    const resolution = resolveAssignee({
      conclusion: 'CHARGE_REJECTED',
      reason_code: 'PRICE_CODE_NOT_FOUND',
    });
    assert.deepEqual(
      [...resolution.chain],
      [ROLE_CASHIER, ROLE_CASHIER_LEAD, '财务科主任'],
      '收费员的升级链',
    );
    assert.equal(escalationDueAtMs(ROLE_CASHIER, 0), 8 * HOUR, '收费员 8 小时');
    assert.equal(escalationDueAtMs(ROLE_OR_NURSE_MANAGER, 0), 2 * HOUR, '手术室护士长 2 小时');
    assert.equal(escalationDueAtMs(ROLE_OR_NURSE_MANAGER, 1), 4 * HOUR, '升一级后时限翻倍');
  });

  it('⑪ doctor 分组视图：待核查条目按责任岗位列出（科室交办清单）', () => {
    notRegisteredScenario('MAT-NOT-REGISTERED'); // → 高值耗材管理岗
    chargeRejectedScenario('MAT-SAMPLE-03', OPEN_OP_2); // → 收费员

    const report = runDoctor(ledger.db, {});
    const byRole = new Map(report.pending_by_assignee.map((row) => [row.assignee_role, row]));
    assert.equal(byRole.size, 2, '两类异常落到两个责任岗位');
    assert.equal(byRole.get(ROLE_MATERIAL_MANAGER)?.count, 1);
    assert.equal(byRole.get(ROLE_CASHIER)?.count, 1);
    // 科室写清楚：交办时不用再逐条翻台账找人
    assert.deepEqual(byRole.get(ROLE_CASHIER)?.depts, ['SURG-01']);
    assert.equal(byRole.get(ROLE_CASHIER)?.reminded, 0);
    assert.equal(byRole.get(ROLE_CASHIER)?.escalated, 0);
    // 视图里不含凭据明文
    assert.ok(!JSON.stringify(report).includes(WECOM_SECRET));
  });

  it('⑫ 常驻守护进程周期扫描：超时条目自动收到提醒（不用人盯着）', async () => {
    // 一份落盘台账 + 一条待核查条目（关台异常 → 手术室护士长，2 小时时限）
    const dir = mkdtempSync(resolve(tmpdir(), 'msb-routing-'));
    tempDirs.push(dir);
    const ledgerPath = resolve(dir, 'ledger.db');
    const fileLedger = openLedger(ledgerPath);
    importMasterData(fileLedger.db, { operationsCsv, materialsCsv });
    const task = closedScenario('MAT-SAMPLE-02', fileLedger.db);

    // 时钟拨到 3 小时后：条目看起来已超时
    const base = Date.now();
    const handle = await runDaemon({
      env: {
        OR_SCANNER_BASE_URL: 'https://scanner.example.internal',
        OR_SCANNER_TOKEN: 'test-scanner-token',
        OR_SCANNER_SECRET: 'test-scanner-secret',
        HIS_CHARGING_BASE_URL: 'https://his.example.internal',
        HIS_CHARGING_TOKEN: 'test-his-token',
        WECOM_WEBHOOK_URL: stub.webhookUrl(),
        WECOM_SECRET: WECOM_SECRET,
        LEDGER_DB_PATH: ledgerPath,
        SCAN_INBOX_DIR: resolve(dir, 'scan-inbox'),
      } as unknown as NodeJS.ProcessEnv,
      ledgerDbPath: ledgerPath,
      scanInboxDir: resolve(dir, 'scan-inbox'),
      httpPort: 0,
      // 路由扫描周期压到 50 毫秒，事件轮询周期拉长（避免计费回写干扰本用例）
      routingSweepIntervalMs: 50,
      pollIntervalMs: 600_000,
      heartbeatIntervalMs: 600_000,
      installSignalHandlers: false,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      now: () => base + 3 * HOUR,
      ledger: fileLedger,
    });

    try {
      // 等守护进程自己扫到并发出提醒
      const deadline = Date.now() + 5_000;
      while (stub.requests.length === 0 && Date.now() < deadline) {
        await sleep(25);
      }
      assert.ok(stub.requests.length >= 1, '守护进程应自动发出超时提醒');
      const body = JSON.parse(stub.requests[0]?.body ?? '{}') as {
        markdown: { content: string };
      };
      assert.ok(body.markdown.content.includes('核查待办超时'));
      assert.ok(body.markdown.content.includes('手术室护士长'), '提醒写清该谁处理');

      const reminded = fileLedger.db
        .prepare('SELECT reminded_at FROM check_task WHERE id = ?')
        .get(task.id) as { reminded_at: string | null };
      assert.ok(reminded.reminded_at, '提醒后 reminded_at 落库');
      assert.equal(
        fileLedger.db
          .prepare("SELECT COUNT(*) AS n FROM audit_chain WHERE event_type = 'check_task_reminded'")
          .get() !== null,
        true,
      );
    } finally {
      await handle.stop('test');
      fileLedger.close();
    }
  });
});
