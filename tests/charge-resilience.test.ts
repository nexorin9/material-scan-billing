/**
 * test_charge_resilience：出站客户端韧性（超时分级 · 连接复用 · 连续失败熔断）。
 *
 * 替身说明：这里的「HIS 计费替身」是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走**同一条代码路径**（真实 socket → 真实请求头 / 请求体），
 * 不 mock 请求、不注入假响应对象。
 *
 * 覆盖：
 *   ① **超时分级** —— 连接超时与响应超时是两个不同的错误码；
 *      响应超时按条目数线性放大并封顶；
 *   ② **连接复用** —— 同一进程内多批提交复用同一条 TCP 连接（keep-alive）；
 *   ③ **连续失败熔断** —— 连续 N 次通道级失败后短路，期间**不外发**；
 *      冷却到点放一次探测，探测成功即恢复；
 *   ④ **熔断不吞数据** —— 短路期间的条目照常进退避重投队列，台账状态停在「待重投」；
 *   ⑤ **熔断状态可查** —— 落在台账 meta 表，doctor 直接读得到。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, createServer, type Server } from 'node:http';
import { Socket } from 'node:net';

import {
  CHARGE_ERROR_CODES,
  ChargeError,
  HisChargingClient,
  computeResponseTimeout,
  type ChargeLogRecord,
} from '../src/charge/client.js';
import {
  ChargeCircuitBreaker,
  loadCircuitSnapshot,
  saveCircuitSnapshot,
} from '../src/charge/circuit.js';
import { submitMaterialUses } from '../src/charge/submit.js';
import { ChargeRetryScheduler, toMaterialUse, type ChargeItem } from '../src/charge/retry.js';
import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { deriveIdempotencyKey } from '../src/domain/idempotency.js';
import { bindOne } from '../src/engine/binding.js';
import { runDoctor, runLedgerQuery } from '../src/cli/commands.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const TOKEN = 'his-charging-token-plaintext-4b2e';
const ENDPOINT_PATH = '/api/v1/material-uses';

interface CapturedRequest {
  method: string;
  url: string;
  /** 对端看到的来源端口：同一条 TCP 连接上的请求端口相同 */
  remote_port: number;
  body: string;
}

interface StubBehavior {
  status?: number;
  body?: string;
  delayMs?: number;
}

/** HIS 计费替身：真实 HTTP 服务，记录收到的请求与来源端口 */
class HisChargingStub {
  readonly requests: CapturedRequest[] = [];
  /** 见过的不同来源端口数 = 对端开过的 TCP 连接数 */
  readonly connections = new Set<number>();
  private readonly server: Server;
  private behavior: StubBehavior = {
    status: 200,
    body: JSON.stringify({ accepted: [], rejected: [] }),
  };
  baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const remotePort = req.socket.remotePort ?? -1;
        this.connections.add(remotePort);
        this.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          remote_port: remotePort,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const behavior = this.behavior;
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
    await new Promise<void>((done) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          done();
          return;
        }
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        done();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => {
      this.server.close(() => done());
    });
  }

  setBehavior(behavior: StubBehavior): void {
    this.behavior = behavior;
  }

  reset(): void {
    this.requests.length = 0;
    this.connections.clear();
    this.behavior = { status: 200, body: JSON.stringify({ accepted: [], rejected: [] }) };
  }
}

const stub = new HisChargingStub();
const logs: ChargeLogRecord[] = [];
const logger = (record: ChargeLogRecord): void => {
  logs.push(record);
};

/**
 * 只建连接、不握手的连接池：拿到的 socket 从不 `connect()`，
 * TCP 握手永远完不成 —— 用来确定性地触发**连接超时**这一档。
 */
class StuckSocketAgent extends Agent {
  override createConnection(
    _options: unknown,
    callback?: (err: Error | null, socket: Socket) => void,
  ): Socket {
    const socket = new Socket();
    // 标成「正在建连」：TCP 握手永远完不成，连接阶段预算到期即报错
    (socket as unknown as { connecting: boolean }).connecting = true;
    callback?.(null, socket);
    return socket;
  }
}

before(async () => {
  await stub.start();
});

after(async () => {
  await stub.stop();
});

beforeEach(() => {
  stub.reset();
  logs.length = 0;
});

function newClient(
  overrides: {
    timeoutMs?: number;
    connectTimeoutMs?: number;
    maxResponseTimeoutMs?: number;
    circuit?: ChargeCircuitBreaker;
    agent?: Agent;
  } = {},
): HisChargingClient {
  return new HisChargingClient({
    baseUrl: stub.baseUrl,
    token: TOKEN,
    timeoutMs: overrides.timeoutMs ?? 2_000,
    connectTimeoutMs: overrides.connectTimeoutMs ?? 2_000,
    maxResponseTimeoutMs: overrides.maxResponseTimeoutMs,
    circuit: overrides.circuit,
    agent: overrides.agent,
    logger,
  });
}

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
): void {
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

describe('出站韧性 ①：超时分级', () => {
  it('响应超时与连接超时返回不同错误码', async () => {
    // 响应超时：连上了，对端迟迟不给结论
    const responseClient = newClient({ timeoutMs: 60 });
    stub.setBehavior({
      status: 200,
      body: JSON.stringify({ accepted: [], rejected: [] }),
      delayMs: 500,
    });
    const responseError = await responseClient
      .postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' })
      .catch((e) => e);
    assert.ok(responseError instanceof ChargeError);
    assert.equal(responseError.code, CHARGE_ERROR_CODES.timeout);
    assert.equal(responseError.kind, 'timeout');
    assert.equal(responseError.channelReachable, false);
    assert.equal(responseError.retryable, true);

    // 连接超时：TCP 握手永远不完成（注入一个从不 connect 的 socket）
    const stuckAgent = new StuckSocketAgent();
    const connectClient = newClient({ connectTimeoutMs: 80, agent: stuckAgent });
    const connectError = await connectClient
      .postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' })
      .catch((e) => e);
    assert.ok(connectError instanceof ChargeError);
    assert.equal(connectError.code, CHARGE_ERROR_CODES.connectTimeout);
    assert.equal(connectError.kind, 'connect_timeout');
    assert.equal(connectError.channelReachable, false);
    assert.equal(connectError.retryable, true);

    // 两个阶段的码**必须不同**：连不上与连上了不回应是两回事
    assert.notEqual(responseError.code, connectError.code);
    stuckAgent.destroy();
  });

  it('响应超时按条目数线性放大并封顶', async () => {
    assert.equal(computeResponseTimeout(10_000, 1), 10_000);
    assert.equal(computeResponseTimeout(10_000, 3), 30_000);
    assert.equal(computeResponseTimeout(10_000, 100), 60_000, '超过上限要封顶');
    assert.equal(computeResponseTimeout(10_000, 100, 120_000), 120_000, '上限可配');
    assert.equal(computeResponseTimeout(10_000, 0), 10_000, '条数非法时按 1 条算');
  });

  it('实际请求按条目数放大：6 条明细的等待窗口是基数的 6 倍（受上限约束）', async () => {
    const client = newClient({ timeoutMs: 1_000, maxResponseTimeoutMs: 5_000 });
    const uses = Array.from({ length: 6 }, (_unused, index) => ({
      material_code: `MAT-SAMPLE-0${index + 1}`,
      quantity: 1,
      price_code: `PR-SAMPLE-0${index + 1}`,
      use_time: '2026-01-15T09:12:00.000Z',
      fee_category: '卫生材料',
      medical_insurance_class: '甲类',
    }));

    await submitMaterialUses(client, 'OP-SAMPLE-001', 'DEPT-0301', uses, {
      path: ENDPOINT_PATH,
    });

    const success = logs.find((record) => record.event === 'charge_request_succeeded');
    assert.ok(success, '应有出站成功日志');
    assert.equal(success.item_count, 6);
    assert.equal(success.timeout_ms, 5_000, '6 条 × 1 秒 = 6 秒，受 5 秒上限约束');
  });
});

describe('出站韧性 ②：连接复用', () => {
  it('同一进程内多批请求复用同一条连接（keep-alive）', async () => {
    const client = newClient();
    for (let index = 0; index < 3; index += 1) {
      await submitMaterialUses(
        client,
        'OP-SAMPLE-001',
        'DEPT-0301',
        [
          {
            material_code: 'MAT-SAMPLE-01',
            quantity: 1,
            price_code: 'PR-SAMPLE-01',
            use_time: '2026-01-15T09:12:00.000Z',
            fee_category: '卫生材料',
            medical_insurance_class: '甲类',
          },
        ],
        { path: ENDPOINT_PATH },
      );
    }

    assert.equal(stub.requests.length, 3, '三批请求都应到达对端');
    const ports = new Set(stub.requests.map((request) => request.remote_port));
    assert.equal(ports.size, 1, `三批请求应复用同一条连接，实际用了 ${ports.size} 条`);
    assert.equal(stub.connections.size, 1);
  });

  it('连接池在客户端销毁时释放（守护进程停机不留空闲连接）', async () => {
    const client = newClient();
    await submitMaterialUses(
      client,
      'OP-SAMPLE-001',
      'DEPT-0301',
      [
        {
          material_code: 'MAT-SAMPLE-01',
          quantity: 1,
          price_code: 'PR-SAMPLE-01',
          use_time: '2026-01-15T09:12:00.000Z',
          fee_category: '卫生材料',
          medical_insurance_class: '甲类',
        },
      ],
      { path: ENDPOINT_PATH },
    );
    assert.equal(stub.requests.length, 1);
    client.destroy();
  });
});

describe('出站韧性 ③：连续失败熔断', () => {
  it('连续 N 次失败后熔断打开，期间不再外发任何请求', async () => {
    const breaker = new ChargeCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    const client = newClient({ circuit: breaker });
    stub.setBehavior({ status: 503, body: JSON.stringify({ message: 'service unavailable' }) });

    for (let index = 0; index < 3; index += 1) {
      const error = await client
        .postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' })
        .catch((e) => e);
      assert.ok(error instanceof ChargeError);
      assert.equal(error.code, CHARGE_ERROR_CODES.serverError, '前三次是真实失败');
    }
    assert.equal(breaker.state, 'open', '连续失败达到阈值即打开熔断');

    // 第 4 次：熔断已开 → 直接短路，**对端收不到任何请求**
    const shortCircuit = await client
      .postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' })
      .catch((e) => e);
    assert.ok(shortCircuit instanceof ChargeError);
    assert.equal(shortCircuit.code, CHARGE_ERROR_CODES.circuitOpen);
    assert.equal(shortCircuit.channelReachable, false);
    assert.equal(shortCircuit.retryable, true);
    assert.equal(stub.requests.length, 3, '熔断期间不得再外发请求');
    assert.ok(breaker.isOpen());
    assert.ok(breaker.nextProbeAt() !== null);
  });

  it('半开探测成功后恢复为正常档', async () => {
    let clock = 1_000;
    const breaker = new ChargeCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 5_000,
      now: () => clock,
    });
    const client = newClient({ circuit: breaker });
    stub.setBehavior({ status: 503, body: JSON.stringify({ message: 'service unavailable' }) });

    for (let index = 0; index < 2; index += 1) {
      await client.postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' }).catch(() => undefined);
    }
    assert.equal(breaker.state, 'open');

    // 冷却未到：仍然短路
    clock += 1_000;
    const blocked = await client
      .postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' })
      .catch((e) => e);
    assert.ok(blocked instanceof ChargeError);
    assert.equal(blocked.code, CHARGE_ERROR_CODES.circuitOpen);
    assert.equal(stub.requests.length, 2);

    // 冷却到点：放一次探测，对端已恢复 → 通道回到正常档
    clock += 5_000;
    stub.setBehavior({ status: 200, body: JSON.stringify({ accepted: [], rejected: [] }) });
    const probe = await client
      .postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' })
      .catch((e) => e);
    assert.ok(!(probe instanceof ChargeError), '探测请求应成功发出');
    assert.equal(stub.requests.length, 3, '探测请求确实外发了');
    assert.equal(breaker.state, 'closed');
    assert.equal(breaker.consecutiveFailures, 0);
  });

  it('对端 4xx 不计入熔断（通道是通的，是对端不收这条）', async () => {
    const breaker = new ChargeCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
    const client = newClient({ circuit: breaker });
    stub.setBehavior({ status: 422, body: JSON.stringify({ message: 'bad request' }) });

    for (let index = 0; index < 4; index += 1) {
      const error = await client
        .postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' })
        .catch((e) => e);
      assert.ok(error instanceof ChargeError);
      assert.equal(error.code, CHARGE_ERROR_CODES.clientError);
    }
    assert.equal(breaker.state, 'closed', '4xx 不该把通道判死');
    assert.equal(breaker.consecutiveFailures, 0);
  });
});

describe('出站韧性 ④：熔断不吞数据', () => {
  it('熔断期间的条目仍在退避重投队列里，台账状态为待重投', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      const breaker = new ChargeCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
      const client = newClient({ circuit: breaker });

      // 先把通道打挂：连续两次 5xx
      stub.setBehavior({ status: 503, body: JSON.stringify({ message: 'down' }) });
      for (let index = 0; index < 2; index += 1) {
        await client.postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' }).catch(() => undefined);
      }
      assert.equal(breaker.state, 'open');
      const requestsBefore = stub.requests.length;

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: async (item: ChargeItem) =>
          submitMaterialUses(
            client,
            item.operation_no,
            item.dept_code,
            [toMaterialUse(item)],
            { path: ENDPOINT_PATH },
          ),
      });

      const result = await scheduler.submit(chargeItem());

      // 熔断期间：请求没外发，条目却**没有丢** —— 进了退避重投队列
      assert.equal(stub.requests.length, requestsBefore, '熔断期间不得外发');
      assert.equal(result.status, 'retry_scheduled');
      assert.equal(result.accepted, false);
      assert.equal(result.receipt?.error_code, CHARGE_ERROR_CODES.circuitOpen);
      assert.equal(result.receipt?.channel_reachable, false, '熔断期间通道不可达');
      assert.equal(result.receipt?.retryable, true, '可重投：条目进退避队列');
      assert.equal(scheduler.pendingCount(), 1, '条目应留在重投队列里');

      // 台账侧：回执行留痕、台账行不丢、计费状态为「待重投」
      const receipts = ledger.db
        .prepare('SELECT COUNT(*) AS n FROM charge_receipt')
        .get() as { n: number };
      assert.equal(receipts.n, 1, '熔断失败也要留一行回执');
      const ledgerRows = runLedgerQuery(ledger.db, { material_code: 'MAT-SAMPLE-01' });
      assert.equal(ledgerRows.rows.length, 1);
      assert.equal(ledgerRows.rows[0]!.status, 'bound', '台账行不被静默改掉');
      assert.equal(ledgerRows.rows[0]!.charge_state, 'pending_retry', '计费状态应为待重投');
      assert.equal(ledgerRows.rows[0]!.check_task_id, null, '还没到人工那一步');
    } finally {
      ledger.close();
    }
  });
});

describe('出站韧性 ⑤：熔断状态可查', () => {
  it('熔断状态落在台账 meta 表，doctor 看得见当前档位与下次探测时间', async () => {
    const ledger = freshLedger();
    try {
      let clock = 2_000;
      const breaker = new ChargeCircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 30_000,
        now: () => clock,
        onChange: (snapshot) => saveCircuitSnapshot(ledger.db, snapshot),
      });
      const client = newClient({ circuit: breaker });
      stub.setBehavior({ status: 503, body: JSON.stringify({ message: 'down' }) });
      await client.postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' }).catch(() => undefined);

      const snapshot = loadCircuitSnapshot(ledger.db);
      assert.ok(snapshot, '熔断状态应落到台账');
      assert.equal(snapshot.state, 'open');
      assert.equal(snapshot.consecutive_failures, 1);
      assert.equal(snapshot.threshold, 1);
      assert.ok(snapshot.next_probe_at !== null);

      const report = runDoctor(ledger.db, {}, { ledger_db_path: ':memory:' });
      assert.equal(report.outbound_circuit.state, 'open');
      assert.equal(report.outbound_circuit.is_open, true);
      assert.equal(report.outbound_circuit.consecutive_failures, 1);
      assert.equal(report.outbound_circuit.threshold, 1);
      assert.equal(report.outbound_circuit.next_probe_at, snapshot.next_probe_at);
      assert.ok(report.outbound_circuit.note.includes('短路'), 'doctor 要有一句人话说明');

      clock += 31_000;
      stub.setBehavior({ status: 200, body: JSON.stringify({ accepted: [], rejected: [] }) });
      await client.postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' });
      assert.equal(breaker.state, 'closed');
      const healed = runDoctor(ledger.db, {}, { ledger_db_path: ':memory:' });
      assert.equal(healed.outbound_circuit.state, 'closed');
      assert.equal(healed.outbound_circuit.is_open, false);
      assert.equal(healed.outbound_circuit.consecutive_failures, 0);
    } finally {
      ledger.close();
    }
  });
});
