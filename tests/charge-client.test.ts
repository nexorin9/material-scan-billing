/**
 * test_charge_client：出站层（HIS 计费 HTTP 客户端 + 请求组装）。
 *
 * 替身说明：这里的「HIS 计费替身」是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走**同一条代码路径**（原生 fetch → 真实 socket → 真实请求头 / 请求体），
 * 不 mock fetch、不注入假响应对象。
 *
 * 覆盖：
 *   ① 请求头含正确 Bearer（且 content-type / accept 固定）；
 *   ② 请求体字段名逐字匹配规范（并与 docs/api/his-charging.md 同步）；
 *   ③ 5xx 与超时分别抛对应错误码（通道可达 / 可重投标记正确）；
 *   ④ 日志与异常信息中不出现令牌明文；
 *   ⑤ 凭据单一出口：业务层拿得到 client、拿不到令牌字符串。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';

import {
  CHARGE_ERROR_CODES,
  ChargeError,
  HisChargingClient,
  redactHeaders,
  type ChargeLogRecord,
} from '../src/charge/client.js';
import {
  MATERIAL_USE_FIELDS,
  MATERIAL_USES_REQUEST_FIELDS,
  submitMaterialUses,
  type MaterialUse,
} from '../src/charge/submit.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

const TOKEN = 'his-charging-token-plaintext-9f3a';
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

/** HIS 计费替身：真实 HTTP 服务，记录收到的请求 */
class HisChargingStub {
  readonly requests: CapturedRequest[] = [];
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
        this.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
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

  setBehavior(behavior: StubBehavior): void {
    this.behavior = behavior;
  }

  reset(): void {
    this.requests.length = 0;
    this.behavior = { status: 200, body: JSON.stringify({ accepted: [], rejected: [] }) };
  }
}

const stub = new HisChargingStub();
const logs: ChargeLogRecord[] = [];
const logger = (record: ChargeLogRecord): void => {
  logs.push(record);
};

function newClient(overrides: { timeoutMs?: number; baseUrl?: string } = {}): HisChargingClient {
  return new HisChargingClient({
    baseUrl: overrides.baseUrl ?? stub.baseUrl,
    token: TOKEN,
    timeoutMs: overrides.timeoutMs ?? 2_000,
    logger,
  });
}

const sampleUses: MaterialUse[] = [
  {
    material_code: 'MAT-SAMPLE-01',
    quantity: 1,
    price_code: 'PR-SAMPLE-01',
    use_time: '2026-01-15T09:12:00.000Z',
    fee_category: '卫生材料',
    medical_insurance_class: '甲类',
  },
  {
    material_code: 'MAT-SAMPLE-02',
    quantity: 2,
    price_code: 'PR-SAMPLE-02',
    use_time: '2026-01-15T09:13:10.000Z',
    fee_category: '卫生材料',
    medical_insurance_class: '乙类',
  },
];

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

describe('出站客户端：请求形状与凭据盖章', () => {
  it('请求头含正确 Bearer，content-type / accept 固定', async () => {
    const client = newClient();
    stub.setBehavior({ status: 200, body: JSON.stringify({ accepted: [{ material_code: 'MAT-SAMPLE-01' }], rejected: [] }) });

    await submitMaterialUses(client, 'OP-SAMPLE-001', 'DEPT-0301', sampleUses, {
      path: ENDPOINT_PATH,
    });

    assert.equal(stub.requests.length, 1);
    const captured = stub.requests[0]!;
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url, ENDPOINT_PATH);
    assert.equal(captured.headers['authorization'], `Bearer ${TOKEN}`);
    assert.equal(captured.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(captured.headers['accept'], 'application/json');
  });

  it('请求体字段名逐字匹配规范', async () => {
    const client = newClient();
    await submitMaterialUses(client, 'OP-SAMPLE-001', 'DEPT-0301', sampleUses, {
      path: ENDPOINT_PATH,
    });

    const body = JSON.parse(stub.requests[0]!.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), [...MATERIAL_USES_REQUEST_FIELDS]);
    const uses = body['uses'] as MaterialUse[];
    assert.deepEqual(Object.keys(uses[0]!), [...MATERIAL_USE_FIELDS]);
    assert.equal(body['operation_no'], 'OP-SAMPLE-001');
    assert.equal(body['dept_code'], 'DEPT-0301');
    assert.equal(uses.length, 2);
  });

  it('字段规范文档与实现逐字同步（字段名 + 错误码）', () => {
    const doc = readFileSync(resolve(projectRoot, 'docs', 'api', 'his-charging.md'), 'utf8');
    for (const field of [...MATERIAL_USES_REQUEST_FIELDS, ...MATERIAL_USE_FIELDS]) {
      assert.ok(doc.includes(field), `字段规范文档缺少字段 ${field}`);
    }
    for (const code of Object.values(CHARGE_ERROR_CODES)) {
      assert.ok(doc.includes(code), `字段规范文档缺少错误码 ${code}`);
    }
  });
});

describe('出站客户端：失败分档与错误码', () => {
  it('5xx → ERR_CHARGE_HTTP_5XX（通道可达、可重投）', async () => {
    const client = newClient();
    stub.setBehavior({ status: 503, body: JSON.stringify({ message: 'service unavailable' }) });

    const error = await client.postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' }).catch((e) => e);

    assert.ok(error instanceof ChargeError);
    assert.equal(error.code, CHARGE_ERROR_CODES.serverError);
    assert.equal(error.kind, 'server_error');
    assert.equal(error.status, 503);
    assert.equal(error.channelReachable, true);
    assert.equal(error.retryable, true);
  });

  it('4xx → ERR_CHARGE_HTTP_4XX（通道可达、不可重投）', async () => {
    const client = newClient();
    stub.setBehavior({ status: 422, body: JSON.stringify({ message: 'bad request' }) });

    const error = await client.postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' }).catch((e) => e);

    assert.ok(error instanceof ChargeError);
    assert.equal(error.code, CHARGE_ERROR_CODES.clientError);
    assert.equal(error.status, 422);
    assert.equal(error.channelReachable, true);
    assert.equal(error.retryable, false);
  });

  it('超时 → ERR_CHARGE_TIMEOUT（通道不可达、可重投）', async () => {
    const client = newClient({ timeoutMs: 60 });
    stub.setBehavior({ status: 200, body: JSON.stringify({ accepted: [], rejected: [] }), delayMs: 500 });

    const error = await client.postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' }).catch((e) => e);

    assert.ok(error instanceof ChargeError);
    assert.equal(error.code, CHARGE_ERROR_CODES.timeout);
    assert.equal(error.channelReachable, false);
    assert.equal(error.retryable, true);
  });

  it('连接失败 → ERR_CHARGE_NETWORK（通道不可达、可重投）', async () => {
    // 先占一个端口再关掉：连上去必然被拒
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', () => done()));
    const address = probe.address();
    const port = address !== null && typeof address !== 'string' ? address.port : 1;
    await new Promise<void>((done) => probe.close(() => done()));

    const client = newClient({ baseUrl: `http://127.0.0.1:${port}` });
    const error = await client.postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' }).catch((e) => e);

    assert.ok(error instanceof ChargeError);
    assert.equal(error.code, CHARGE_ERROR_CODES.network);
    assert.equal(error.channelReachable, false);
    assert.equal(error.retryable, true);
  });

  it('响应不是合法 JSON → ERR_CHARGE_RESPONSE_INVALID', async () => {
    const client = newClient();
    stub.setBehavior({ status: 200, body: 'not-json-at-all' });

    const error = await client.postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' }).catch((e) => e);

    assert.ok(error instanceof ChargeError);
    assert.equal(error.code, CHARGE_ERROR_CODES.responseInvalid);
    assert.equal(error.retryable, true);
  });

  it('响应结构不符（缺 accepted / rejected）→ ERR_CHARGE_RESPONSE_INVALID', async () => {
    const client = newClient();
    stub.setBehavior({ status: 200, body: JSON.stringify({ ok: true }) });

    const error = await submitMaterialUses(client, 'OP-SAMPLE-001', 'DEPT-0301', sampleUses, {
      path: ENDPOINT_PATH,
    }).catch((e) => e);

    assert.ok(error instanceof ChargeError);
    assert.equal(error.code, CHARGE_ERROR_CODES.responseInvalid);
  });

  it('请求体缺必填字段 → ERR_CHARGE_REQUEST_INVALID 且不发请求', async () => {
    const client = newClient();
    const error = await submitMaterialUses(
      client,
      'OP-SAMPLE-001',
      'DEPT-0301',
      [{ ...sampleUses[0]!, price_code: '' }],
      { path: ENDPOINT_PATH },
    ).catch((e) => e);

    assert.ok(error instanceof ChargeError);
    assert.equal(error.code, CHARGE_ERROR_CODES.requestInvalid);
    assert.equal(stub.requests.length, 0, '不合规请求不得发出');
  });

  it('基址缺失 → ERR_CHARGE_CONFIG', () => {
    const error = (() => {
      try {
        return new HisChargingClient({ baseUrl: '', token: TOKEN });
      } catch (e) {
        return e;
      }
    })();

    assert.ok(error instanceof ChargeError);
    assert.equal(error.code, CHARGE_ERROR_CODES.config);
    assert.ok(error.message.includes('HIS_CHARGING_BASE_URL'));
  });
});

describe('出站客户端：凭据单一出口与脱敏', () => {
  it('日志与异常信息中不出现令牌明文', async () => {
    const client = newClient();
    stub.setBehavior({ status: 500, body: JSON.stringify({ message: 'boom' }) });

    const error = await client.postJson(ENDPOINT_PATH, { operation_no: 'OP-SAMPLE-001' }).catch((e) => e);

    assert.ok(error instanceof ChargeError);
    assert.equal(String(error.message).includes(TOKEN), false, '异常信息不得含令牌明文');
    assert.equal(String(error.stack ?? '').includes(TOKEN), false, '异常堆栈不得含令牌明文');
    assert.equal(JSON.stringify(logs).includes(TOKEN), false, '日志不得含令牌明文');
    assert.ok(logs.length >= 1);
    assert.equal(logs[0]!.channel, 'outbound');
    assert.equal(logs[0]!.error_code, CHARGE_ERROR_CODES.serverError);
  });

  it('请求头打码后不含令牌明文', () => {
    const redacted = redactHeaders({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
    assert.equal(redacted['authorization'], 'Bearer ***');
    assert.equal(JSON.stringify(redacted).includes(TOKEN), false);
    assert.equal(redacted['content-type'], 'application/json');
  });

  it('业务层拿得到 client、拿不到令牌字符串', () => {
    const client = newClient();

    // 客户端实例上没有任何属性暴露令牌
    assert.equal(Object.getOwnPropertyNames(client).includes('token'), false);
    assert.equal(JSON.stringify(client).includes(TOKEN), false);
    assert.equal(String(client).includes(TOKEN), false);
    assert.equal(
      Object.values(client as unknown as Record<string, unknown>).some(
        (value) => typeof value === 'string' && value.includes(TOKEN),
      ),
      false,
    );

    // 业务层只拿得到「能发请求的端口」与基址（基址不含凭据）
    assert.equal(client.baseUrl, stub.baseUrl);
    assert.equal(client.baseUrl.includes(TOKEN), false);
  });

  it('成功提交返回逐条 accepted / rejected', async () => {
    const client = newClient();
    stub.setBehavior({
      status: 200,
      body: JSON.stringify({
        accepted: [{ material_code: 'MAT-SAMPLE-01' }],
        rejected: [{ material_code: 'MAT-SAMPLE-02', reason_code: 'PRICE_CODE_NOT_FOUND' }],
      }),
    });

    const response = await submitMaterialUses(client, 'OP-SAMPLE-001', 'DEPT-0301', sampleUses, {
      path: ENDPOINT_PATH,
    });

    assert.deepEqual(response.accepted, [{ material_code: 'MAT-SAMPLE-01' }]);
    assert.deepEqual(response.rejected, [
      { material_code: 'MAT-SAMPLE-02', reason_code: 'PRICE_CODE_NOT_FOUND' },
    ]);
  });
});
