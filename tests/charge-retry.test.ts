/**
 * test_charge_retry：计费回执层（逐条回执归类落库 + 指数退避重投 + 达上限转人工）。
 *
 * 替身说明：这里的「HIS 计费替身」是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走**同一条代码路径**（原生 fetch → 真实 socket → 真实请求头 / 请求体），
 * 不 mock fetch、不注入假响应对象。
 *
 * 覆盖：
 *   ① 对端响应拆成逐条回执并落台账（accepted / rejected + reason_code 各自一行）；
 *   ② 5xx 后重投：delivery_count 递增、回执行留每次 attempt、状态推进到 charged；
 *   ③ 通道当时不可达（超时）与通道可达但对端业务拒绝分开定性；
 *   ④ 业务拒绝**不重投**：直接转核查任务，台账状态转 check_pending；
 *   ⑤ 重投达上限 → 生成核查任务（带台次上下文）+ 台账状态转人工，不静默丢弃；
 *   ⑥ 状态不越级推进：已计费条目不重复投递（不自动冲正），charged → rejected 被拒；
 *   ⑦ 指数退避间隔与重投复用同一把幂等键。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';

import { HisChargingClient } from '../src/charge/client.js';
import { submitMaterialUses } from '../src/charge/submit.js';
import {
  CHARGE_RECEIPT_KINDS,
  classifyReceipts,
  countReceipts,
  loadReceipts,
} from '../src/charge/receipt.js';
import {
  ChargeRetryScheduler,
  computeBackoffDelay,
  listRetryCandidates,
  toMaterialUse,
  type ChargeItem,
  type ChargeSubmitFn,
} from '../src/charge/retry.js';
import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import {
  countBindings,
  readBindingStatus,
  transitionBindingStatus,
} from '../src/ledger/binding-repo.js';
import { countCheckTasks } from '../src/check/task.js';
import { deriveIdempotencyKey } from '../src/domain/idempotency.js';
import { StateTransitionError } from '../src/domain/state.js';
import { bindOne } from '../src/engine/binding.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const TOKEN = 'his-charging-token-plaintext-7c41';
const ENDPOINT_PATH = '/api/v1/material-uses';

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface StubBehavior {
  status?: number;
  body?: string;
  delayMs?: number;
}

/** HIS 计费替身：真实 HTTP 服务，行为按队列逐次给出 */
class HisChargingStub {
  readonly requests: CapturedRequest[] = [];
  private readonly server: Server;
  private readonly behaviors: StubBehavior[] = [];
  baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const behavior = this.behaviors.shift() ?? {
          status: 200,
          body: JSON.stringify({ accepted: [], rejected: [] }),
        };
        const respond = (): void => {
          const status = behavior.status ?? 200;
          const body = behavior.body ?? JSON.stringify({ accepted: [], rejected: [] });
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(body);
        };
        if (behavior.delayMs && behavior.delayMs > 0) setTimeout(respond, behavior.delayMs);
        else respond();
      });
      res.on('error', () => {
        // 客户端超时后主动断开：忽略写回失败（替身侧）
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          resolvePromise();
          return;
        }
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        resolvePromise();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => {
      this.server.close(() => done());
    });
  }

  push(behavior: StubBehavior): void {
    this.behaviors.push(behavior);
  }

  reset(): void {
    this.requests.length = 0;
    this.behaviors.length = 0;
  }
}

const stub = new HisChargingStub();

before(async () => {
  await stub.start();
});

after(async () => {
  await stub.stop();
});

beforeEach(() => {
  stub.reset();
});

/** 每个用例一份干净的内存台账（主数据已导入） */
function freshLedger(): LedgerDb {
  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  return ledger;
}

/** 造一条已绑定（status = bound）的台账行 */
function bindMaterial(
  ledger: LedgerDb,
  material_code = 'MAT-SAMPLE-01',
  operation_no = 'OP-SAMPLE-001',
): { idempotency_key: string } {
  const outcome = bindOne(ledger.db, {
    db: ledger.db,
    operation_no,
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    material_code,
    raw_code: material_code,
    quantity: 1,
  });
  assert.equal(outcome.bound, true, '前置条件：这条耗材应绑上台次');
  return { idempotency_key: deriveIdempotencyKey(material_code, operation_no) };
}

function chargeItem(
  material_code = 'MAT-SAMPLE-01',
  operation_no = 'OP-SAMPLE-001',
): ChargeItem {
  return {
    material_code,
    operation_no,
    room_no: 'OR-01',
    dept_code: 'SURG-01',
    scanner_id: 'SCAN-GUN-07',
    quantity: 1,
    price_code: 'PR-SAMPLE-01',
    use_time: '2026-01-15T09:12:00.000Z',
    fee_category: '卫生材料',
    medical_insurance_class: '甲类',
    idempotency_key: deriveIdempotencyKey(material_code, operation_no),
    key_profile: 'v1',
  };
}

/** 接到真实出站客户端的投递函数（与生产同一条代码路径） */
function makeSubmit(timeoutMs = 2_000): ChargeSubmitFn {
  const client = new HisChargingClient({
    baseUrl: stub.baseUrl,
    token: TOKEN,
    timeoutMs,
    logger: () => {
      // 测试里不落日志
    },
  });
  return async (item: ChargeItem) =>
    submitMaterialUses(client, item.operation_no, item.dept_code, [toMaterialUse(item)], {
      path: ENDPOINT_PATH,
    });
}

function countRows(db: LedgerDb['db'], sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as { n: number } | undefined;
  return row?.n ?? 0;
}

describe('test_charge_retry · 逐条回执归类落库', () => {
  it('对端响应拆成逐条回执：接受一条、拒收一条，各留一行', async () => {
    const ledger = freshLedger();
    try {
      const { idempotency_key } = bindMaterial(ledger);
      stub.push({
        status: 200,
        body: JSON.stringify({
          accepted: [{ material_code: 'MAT-SAMPLE-01' }],
          rejected: [{ material_code: 'MAT-SAMPLE-02', reason_code: 'PRICE_CODE_NOT_FOUND' }],
        }),
      });

      const scheduler = new ChargeRetryScheduler(ledger.db, { submit: makeSubmit() });
      const result = await scheduler.submit(chargeItem());

      assert.equal(result.status, 'delivered');
      assert.equal(result.accepted, true);
      assert.equal(result.receipt?.kind, CHARGE_RECEIPT_KINDS.accepted);
      assert.equal(result.receipt?.delivery_count, 1);
      assert.equal(result.receipt?.idempotency_key, idempotency_key);

      // 回执台账：这一条一行，attempt = 1
      const receipts = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]!.accepted, true);
      assert.equal(receipts[0]!.attempt, 1);
      assert.equal(receipts[0]!.delivery_count, 1);
      assert.equal(receipts[0]!.channel_reachable, true);

      // 台账状态推进到 charged
      assert.equal(
        readBindingStatus(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001', idempotency_key),
        'charged',
      );
    } finally {
      ledger.close();
    }
  });

  it('业务拒收的条目：回执行带对端原因码、不可重投', () => {
    const receipts = classifyReceipts({
      response: {
        accepted: [],
        rejected: [{ material_code: 'MAT-SAMPLE-02', reason_code: 'PRICE_CODE_NOT_FOUND' }],
      },
      submitted: [
        {
          material_code: 'MAT-SAMPLE-02',
          quantity: 1,
          price_code: 'PR-SAMPLE-02',
          use_time: '2026-01-15T09:12:00.000Z',
          fee_category: '卫生材料',
          medical_insurance_class: '甲类',
        },
      ],
      operation_no: 'OP-SAMPLE-001',
      attempt: 1,
    });

    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.accepted, false);
    assert.equal(receipts[0]!.kind, CHARGE_RECEIPT_KINDS.business_rejected);
    assert.equal(receipts[0]!.reason_code, 'PRICE_CODE_NOT_FOUND');
    assert.equal(receipts[0]!.retryable, false);
    assert.equal(receipts[0]!.channel_reachable, true);
  });

  it('对端没给结论的条目：按协议不符处理，不静默当成成功', () => {
    const receipts = classifyReceipts({
      response: { accepted: [], rejected: [] },
      submitted: [
        {
          material_code: 'MAT-SAMPLE-01',
          quantity: 1,
          price_code: 'PR-SAMPLE-01',
          use_time: '2026-01-15T09:12:00.000Z',
          fee_category: '卫生材料',
          medical_insurance_class: '甲类',
        },
      ],
      operation_no: 'OP-SAMPLE-001',
      attempt: 1,
    });

    assert.equal(receipts[0]!.accepted, false);
    assert.equal(receipts[0]!.kind, CHARGE_RECEIPT_KINDS.protocol_error);
    assert.equal(receipts[0]!.retryable, true);
  });
});

describe('test_charge_retry · 指数退避重投', () => {
  it('5xx 后重投：delivery_count 递增、回执行留每次 attempt、最终计费成功', async () => {
    const ledger = freshLedger();
    try {
      const { idempotency_key } = bindMaterial(ledger);
      stub.push({ status: 503, body: JSON.stringify({ message: 'service unavailable' }) });
      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [{ material_code: 'MAT-SAMPLE-01' }], rejected: [] }),
      });

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });

      const first = await scheduler.submit(chargeItem());
      assert.equal(first.status, 'retry_scheduled');
      assert.equal(first.accepted, false);
      assert.equal(first.receipt?.attempt, 1);
      assert.equal(first.receipt?.delivery_count, 1);
      assert.equal(first.receipt?.channel_reachable, true, '5xx = 通道可达');
      assert.equal(first.receipt?.retryable, true, '5xx 可重投');
      assert.equal(first.receipt?.error_code, 'ERR_CHARGE_HTTP_5XX');
      assert.equal(scheduler.pendingCount(), 1);

      const second = await scheduler.retryDue();
      assert.equal(second.length, 1);
      assert.equal(second[0]!.status, 'delivered');
      assert.equal(second[0]!.receipt?.attempt, 2);
      assert.equal(second[0]!.receipt?.delivery_count, 2, '重投次数在回执里可见');

      // 回执台账留了两次 attempt，序号连续
      const receipts = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      assert.equal(receipts.length, 2);
      assert.deepEqual(
        receipts.map((row) => row.attempt),
        [1, 2],
      );
      assert.deepEqual(
        receipts.map((row) => row.delivery_count),
        [1, 2],
      );
      assert.equal(receipts[1]!.accepted, true);

      // 台账状态推进到 charged
      assert.equal(
        readBindingStatus(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001', idempotency_key),
        'charged',
      );
      assert.equal(scheduler.pendingCount(), 0);
    } finally {
      ledger.close();
    }
  });

  it('重投复用同一把幂等键（不因重试次数变化而改键）', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      stub.push({ status: 503, body: JSON.stringify({ message: 'boom' }) });
      stub.push({ status: 503, body: JSON.stringify({ message: 'boom' }) });

      const seenKeys: string[] = [];
      const submit: ChargeSubmitFn = async (item) => {
        seenKeys.push(item.idempotency_key);
        const client = new HisChargingClient({
          baseUrl: stub.baseUrl,
          token: TOKEN,
          timeoutMs: 2_000,
          logger: () => {},
        });
        return submitMaterialUses(
          client,
          item.operation_no,
          item.dept_code,
          [toMaterialUse(item)],
          { path: ENDPOINT_PATH },
        );
      };

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit,
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      await scheduler.submit(chargeItem());
      await scheduler.retryDue();

      assert.equal(seenKeys.length, 2);
      assert.equal(seenKeys[0], seenKeys[1], '重投必须复用同一把幂等键');
      assert.equal(seenKeys[0], deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001'));
    } finally {
      ledger.close();
    }
  });

  it('退避间隔按 base × 2^n 递增并封顶', () => {
    assert.equal(computeBackoffDelay(1_000, 1), 1_000);
    assert.equal(computeBackoffDelay(1_000, 2), 2_000);
    assert.equal(computeBackoffDelay(1_000, 3), 4_000);
    assert.equal(computeBackoffDelay(1_000, 9, 30_000), 30_000, '封顶到 maxDelay');
  });

  it('通道当时不可达（超时）与通道可达但对端 4xx 分开定性', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);

      // 超时：通道不可达 → 可重投
      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [], rejected: [] }),
        delayMs: 400,
      });
      const timeoutScheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(60),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      const timeoutResult = await timeoutScheduler.submit(chargeItem());
      assert.equal(timeoutResult.receipt?.channel_reachable, false);
      assert.equal(timeoutResult.receipt?.retryable, true);
      assert.equal(timeoutResult.receipt?.error_code, 'ERR_CHARGE_TIMEOUT');
      assert.equal(timeoutResult.status, 'retry_scheduled');

      // 4xx：通道可达但对端不收 → 不可重投
      stub.push({ status: 422, body: JSON.stringify({ message: 'bad request' }) });
      const clientErrorScheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      const clientErrorResult = await clientErrorScheduler.submit(chargeItem());
      assert.equal(clientErrorResult.receipt?.channel_reachable, true);
      assert.equal(clientErrorResult.receipt?.retryable, false);
      assert.equal(clientErrorResult.receipt?.error_code, 'ERR_CHARGE_HTTP_4XX');
      assert.equal(clientErrorResult.status, 'escalated');
    } finally {
      ledger.close();
    }
  });
});

describe('test_charge_retry · 业务拒绝与达上限转人工', () => {
  it('业务拒绝不重投：直接转核查任务，台账状态转 check_pending', async () => {
    const ledger = freshLedger();
    try {
      const { idempotency_key } = bindMaterial(ledger);
      stub.push({
        status: 200,
        body: JSON.stringify({
          accepted: [],
          rejected: [{ material_code: 'MAT-SAMPLE-01', reason_code: 'PRICE_CODE_NOT_FOUND' }],
        }),
      });

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      const result = await scheduler.submit(chargeItem());

      assert.equal(result.status, 'escalated');
      assert.equal(result.receipt?.attempt, 1, '业务拒绝不重投，attempt 恒为 1');
      assert.equal(result.receipt?.delivery_count, 1);
      assert.ok(result.check_task_id && result.check_task_id > 0);
      assert.equal(stub.requests.length, 1, '业务拒绝只发过一次请求');

      // 核查任务带台次上下文
      const task = ledger.db
        .prepare('SELECT * FROM check_task WHERE id = ?')
        .get(result.check_task_id) as Record<string, unknown>;
      assert.equal(task['operation_no'], 'OP-SAMPLE-001');
      assert.equal(task['room_no'], 'OR-01');
      assert.equal(task['dept_code'], 'SURG-01');
      assert.equal(task['scanner_id'], 'SCAN-GUN-07');
      assert.equal(task['material_code'], 'MAT-SAMPLE-01');
      assert.equal(task['conclusion'], 'CHARGE_REJECTED');
      assert.equal(task['reason_code'], 'PRICE_CODE_NOT_FOUND');

      // 台账状态转人工，且与核查条目双向挂接
      assert.equal(
        readBindingStatus(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001', idempotency_key),
        'check_pending',
      );
      const binding = ledger.db
        .prepare('SELECT check_task_id FROM material_binding WHERE material_code = ? AND operation_no = ?')
        .get('MAT-SAMPLE-01', 'OP-SAMPLE-001') as { check_task_id: number };
      assert.equal(binding.check_task_id, result.check_task_id);
    } finally {
      ledger.close();
    }
  });

  it('重投达上限：生成核查任务并转人工，不静默丢弃', async () => {
    const ledger = freshLedger();
    try {
      const { idempotency_key } = bindMaterial(ledger);
      stub.push({ status: 503, body: JSON.stringify({ message: 'boom' }) });
      stub.push({ status: 503, body: JSON.stringify({ message: 'boom' }) });

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 2,
        baseDelayMs: 0,
      });

      const first = await scheduler.submit(chargeItem());
      assert.equal(first.status, 'retry_scheduled');
      assert.equal(scheduler.pendingCount(), 1);

      const second = await scheduler.retryDue();
      assert.equal(second.length, 1);
      assert.equal(second[0]!.status, 'escalated', '达上限即转人工，不静默丢弃');
      assert.equal(second[0]!.receipt?.attempt, 2);
      assert.equal(second[0]!.receipt?.delivery_count, 2);
      assert.ok(second[0]!.check_task_id && second[0]!.check_task_id > 0);
      assert.equal(scheduler.pendingCount(), 0);

      // 回执台账留了两次 attempt，重投次数可见
      const receipts = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      assert.equal(receipts.length, 2);
      assert.deepEqual(
        receipts.map((row) => row.delivery_count),
        [1, 2],
      );
      assert.equal(receipts[1]!.retryable, true, '最后一次仍标可重投（定性事实）');

      // 核查任务 + 台账状态
      assert.equal(countCheckTasks(ledger.db), 1);
      assert.equal(
        readBindingStatus(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001', idempotency_key),
        'check_pending',
      );
      assert.equal(countBindings(ledger.db), 1, '台账行仍在，不被丢弃');
    } finally {
      ledger.close();
    }
  });

  it('进程重启后可从台账重建待重投条目', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      stub.push({ status: 503, body: JSON.stringify({ message: 'boom' }) });

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      await scheduler.submit(chargeItem());

      const candidates = listRetryCandidates(ledger.db, 3);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]!.item.material_code, 'MAT-SAMPLE-01');
      assert.equal(candidates[0]!.attempt, 1);
      assert.equal(candidates[0]!.last_error_code, 'ERR_CHARGE_HTTP_5XX');
      assert.equal(countReceipts(ledger.db), 1);
    } finally {
      ledger.close();
    }
  });
});

describe('test_charge_retry · 状态不越级推进 · 不自动冲正', () => {
  it('已计费条目不重复投递，状态停在 charged', async () => {
    const ledger = freshLedger();
    try {
      const { idempotency_key } = bindMaterial(ledger);
      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [{ material_code: 'MAT-SAMPLE-01' }], rejected: [] }),
      });

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      const first = await scheduler.submit(chargeItem());
      assert.equal(first.status, 'delivered');
      assert.equal(stub.requests.length, 1);

      // 重复投递同一笔：不再发第二次计费请求
      const again = await scheduler.submit(chargeItem());
      assert.equal(again.status, 'skipped_already_charged');
      assert.equal(stub.requests.length, 1, '已计费条目不产生第二次计费');
      assert.equal(
        readBindingStatus(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001', idempotency_key),
        'charged',
      );
      assert.equal(countReceipts(ledger.db), 1);
    } finally {
      ledger.close();
    }
  });

  it('charged → rejected 的迁移被拒：不做自动冲正', () => {
    const ledger = freshLedger();
    try {
      const { idempotency_key } = bindMaterial(ledger);
      // 先手工推到 charged
      transitionBindingStatus(ledger.db, {
        material_code: 'MAT-SAMPLE-01',
        operation_no: 'OP-SAMPLE-001',
        idempotency_key,
        to: 'charged',
        actor: 'charge_writeback',
      });

      assert.throws(
        () =>
          transitionBindingStatus(ledger.db, {
            material_code: 'MAT-SAMPLE-01',
            operation_no: 'OP-SAMPLE-001',
            idempotency_key,
            to: 'rejected',
            actor: 'charge_writeback',
          }),
        (error: unknown) => {
          assert.ok(error instanceof StateTransitionError);
          assert.equal(error.code, 'ERR_ILLEGAL_STATE_TRANSITION');
          assert.equal(error.from, 'charged');
          assert.equal(error.to, 'rejected');
          return true;
        },
      );

      // 被拒的迁移不改动台账
      assert.equal(
        readBindingStatus(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001', idempotency_key),
        'charged',
      );
      assert.equal(countRows(ledger.db, 'SELECT COUNT(*) AS n FROM material_binding'), 1);
    } finally {
      ledger.close();
    }
  });
});
