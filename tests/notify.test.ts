/**
 * test_notify：企业微信机器人批次摘要推送（失败不阻塞台账落库）。
 *
 * 替身说明：这里的「企业微信替身」是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走**同一条代码路径**（原生 fetch → 真实 socket → 真实请求头 / 请求体），
 * 不 mock fetch、不注入假响应对象。替身只存在于测试数据层。
 *
 * 覆盖：
 *   ① 正常批次产生一条企微消息体（计数 + 异常明细 + 台次号），URL 带 timestamp 与 sign；
 *   ② 推送失败（对端 5xx）时**台账落库不受影响**，审计链记失败计数，且不抛到主流程；
 *   ③ 无异常批次默认不推送（不打扰手术室）；
 *   ④ 同一批次最多推一条（重复投递不再推第二遍）；
 *   ⑤ 凭据脱敏：日志、异常与实例上都拿不到密钥与 webhook key 明文；
 *   ⑥ 主路径集成：扫码事件入站 → 逐条结论 → 批次摘要推送（端到端一条消息）。
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { bindOne } from '../src/engine/binding.js';
import { startIngestServer, type IngestServerHandle } from '../src/ingest/http-server.js';
import { formatSignatureHeader } from '../src/ingest/signature.js';
import { newNonce } from '../src/ingest/replay-guard.js';
import {
  NOTIFY_ERROR_CODES,
  WeComBotClient,
  buildBatchSummaryMessage,
  countNotifyFailures,
  deriveBatchKey,
  findNotifyDelivery,
  listFailedDeliveries,
  sendBatchSummary,
  signWeComRequest,
  type NotifyLogRecord,
  type NotifySummary,
} from '../src/check/notify.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const WECOM_SECRET = 'wecom-sign-secret-plaintext-7c1e';
const WECOM_KEY = 'wecom-webhook-key-plaintext-4b9d';
const SCAN_TOKEN = 'test-scanner-token';
const SCAN_SECRET = 'test-scanner-secret';

const OPEN_OP = 'OP-SAMPLE-001';

/* ── 企业微信替身：真实 HTTP 服务，记录收到的请求 ── */

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

class WeComStub {
  readonly requests: CapturedRequest[] = [];
  private readonly server: Server;
  private behavior: StubBehavior = { status: 200, body: JSON.stringify({ errcode: 0, errmsg: 'ok' }) };
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
          const body = behavior.body ?? JSON.stringify({ errcode: 0, errmsg: 'ok' });
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

  setBehavior(behavior: StubBehavior): void {
    this.behavior = behavior;
  }

  reset(): void {
    this.requests.length = 0;
    this.behavior = { status: 200, body: JSON.stringify({ errcode: 0, errmsg: 'ok' }) };
  }

  /** 拼一条带 key 的 webhook 地址（key 属于凭据，不进日志） */
  webhookUrl(): string {
    return `${this.baseUrl}/cgi-bin/webhook/send?key=${WECOM_KEY}`;
  }
}

let stub: WeComStub;
let ledger: LedgerDb;

before(async () => {
  stub = new WeComStub();
  await stub.start();
});

after(async () => {
  await stub.stop();
});

// 每个用例一份干净的台账：批次键与推送记录互不干扰
beforeEach(() => {
  stub.reset();
  ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
});

afterEach(() => {
  ledger.close();
});

/** 造一个推送客户端（日志收集到数组里，便于断言脱敏） */
function makeClient(logs: NotifyLogRecord[] = []): WeComBotClient {
  return new WeComBotClient({
    webhookUrl: stub.webhookUrl(),
    secret: WECOM_SECRET,
    logger: (record) => logs.push(record),
  });
}

/** 一批 6 条：5 条绑上 + 1 条耗材码未建档 */
function abnormalSummary(): NotifySummary {
  return {
    operation_no: OPEN_OP,
    room_no: 'OR-01',
    dept_code: 'SURG-01',
    scanner_id: 'SCAN-GUN-07',
    total: 6,
    accepted: 5,
    rejected: 1,
    exceptions: [
      {
        material_code: 'MAT-UNKNOWN-99',
        reason_code: 'MATERIAL_NOT_REGISTERED',
        conclusion: 'NOT_REGISTERED',
        quantity: 1,
        operation_no: OPEN_OP,
      },
    ],
    items: [
      { material_code: 'MAT-SAMPLE-01', quantity: 1 },
      { material_code: 'MAT-SAMPLE-02', quantity: 2 },
      { material_code: 'MAT-SAMPLE-03', quantity: 1 },
      { material_code: 'MAT-SAMPLE-04', quantity: 1 },
      { material_code: 'MAT-SAMPLE-05', quantity: 1 },
      { material_code: 'MAT-UNKNOWN-99', quantity: 1 },
    ],
  };
}

/** 一批全绑上的干净批次 */
function cleanSummary(): NotifySummary {
  return {
    operation_no: 'OP-SAMPLE-002',
    room_no: 'OR-02',
    dept_code: 'SURG-01',
    scanner_id: 'SCAN-GUN-08',
    total: 3,
    accepted: 3,
    rejected: 0,
    exceptions: [],
    items: [
      { material_code: 'MAT-SAMPLE-01', quantity: 1 },
      { material_code: 'MAT-SAMPLE-02', quantity: 1 },
      { material_code: 'MAT-SAMPLE-03', quantity: 1 },
    ],
  };
}

describe('test_notify · 企业微信批次摘要推送', () => {
  it('① 正常批次产生一条企微消息体（计数 + 异常明细 + 台次号 + 签名）', async () => {
    const client = makeClient();
    const outcome = await sendBatchSummary(ledger.db, client, abnormalSummary());

    assert.equal(outcome.sent, true, '本批应推送成功');
    assert.equal(outcome.result, 'sent');
    assert.equal(outcome.skipped, null);
    assert.equal(outcome.exception_count, 1);

    // 替身只收到一条请求
    assert.equal(stub.requests.length, 1);
    const request = stub.requests[0] as CapturedRequest;
    assert.equal(request.method, 'POST');

    // URL 带 key / timestamp / sign，且 sign = sha1("{timestamp}{secret}{key}")
    const url = new URL(request.url, stub.baseUrl);
    assert.equal(url.pathname, '/cgi-bin/webhook/send');
    assert.equal(url.searchParams.get('key'), WECOM_KEY);
    const timestamp = url.searchParams.get('timestamp');
    assert.ok(timestamp, 'URL 必须带 timestamp');
    assert.equal(
      url.searchParams.get('sign'),
      signWeComRequest(timestamp as string, WECOM_SECRET, WECOM_KEY),
      '签名必须是 sha1("{timestamp}{secret}{key}")',
    );
    assert.equal(
      signWeComRequest('1700000000', WECOM_SECRET, WECOM_KEY),
      createHash('sha1')
        .update(`${'1700000000'}${WECOM_SECRET}${WECOM_KEY}`, 'utf8')
        .digest('hex'),
    );

    // 请求体是 markdown 消息
    const body = JSON.parse(request.body) as {
      msgtype: string;
      markdown: { content: string };
    };
    assert.equal(body.msgtype, 'markdown');
    const content = body.markdown.content;
    assert.ok(content.includes(OPEN_OP), '消息里必须带台次号');
    assert.ok(content.includes('6'), '消息里必须带本批总条数');
    assert.ok(content.includes('5'), '消息里必须带绑定成功条数');
    assert.ok(content.includes('MAT-UNKNOWN-99'), '消息里必须带异常耗材码');
    assert.ok(
      content.includes('MATERIAL_NOT_REGISTERED'),
      '消息里必须带原始原因码（便于与核查清单反查）',
    );
    assert.ok(content.includes('耗材码不在院内耗材主数据中'), '消息里必须给中文说明');

    // 推送台账留一行 sent
    const delivery = findNotifyDelivery(ledger.db, outcome.batch_key);
    assert.equal(delivery?.status, 'sent');
    assert.equal(delivery?.operation_no, OPEN_OP);
  });

  it('② 推送失败时台账落库不受影响，审计链记失败计数，且不抛到主流程', async () => {
    // 先让台账落几行（模拟手术间已经在扫的现场）
    bindOne(ledger.db, {
      db: ledger.db,
      operation_no: OPEN_OP,
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      material_code: 'MAT-SAMPLE-01',
      raw_code: 'MAT-SAMPLE-01',
      quantity: 1,
    });
    const bindingsBefore = countBindings(ledger.db);
    assert.equal(bindingsBefore, 1, '前提：台账已落 1 行');

    // 对端 500：推送失败
    stub.setBehavior({ status: 500, body: 'upstream boom' });
    const outcome = await sendBatchSummary(ledger.db, makeClient(), abnormalSummary());

    // 不抛异常，结果是普通失败结果
    assert.equal(outcome.sent, false);
    assert.equal(outcome.result, 'failed');
    assert.equal(outcome.error_code, NOTIFY_ERROR_CODES.serverError);
    assert.equal(outcome.error_code, 'ERR_NOTIFY_HTTP_5XX');

    // 台账落库不受影响：一行不多、一行不少
    assert.equal(countBindings(ledger.db), bindingsBefore, '推送失败不改变台账行数');

    // 失败计数写进审计链
    const failure = ledger.db
      .prepare("SELECT detail FROM audit_chain WHERE event_type = 'notify_batch_failed'")
      .get() as { detail: string } | undefined;
    assert.ok(failure, '审计链必须留下一行推送失败');
    const detail = JSON.parse(failure.detail) as { error_code: string; batch_key: string };
    assert.equal(detail.error_code, 'ERR_NOTIFY_HTTP_5XX');
    assert.equal(detail.batch_key, outcome.batch_key);

    // 推送台账记 failed，失败计数可查（doctor 展示用）
    assert.equal(countNotifyFailures(ledger.db), 1);
    assert.equal(listFailedDeliveries(ledger.db).length, 1);
    assert.equal(findNotifyDelivery(ledger.db, outcome.batch_key)?.status, 'failed');
  });

  it('③ 无异常批次默认不推送（不打扰手术室）', async () => {
    const outcome = await sendBatchSummary(ledger.db, makeClient(), cleanSummary());

    assert.equal(outcome.sent, false);
    assert.equal(outcome.result, 'skipped');
    assert.equal(outcome.skipped, 'no_exception');
    assert.equal(stub.requests.length, 0, '无异常批次不发出任何请求');
    assert.equal(findNotifyDelivery(ledger.db, outcome.batch_key)?.status, 'skipped');
  });

  it('④ 同一批次最多推一条（重复投递不再推第二遍）', async () => {
    const summary = abnormalSummary();
    const client = makeClient();

    const first = await sendBatchSummary(ledger.db, client, summary);
    assert.equal(first.sent, true);
    assert.equal(stub.requests.length, 1);

    const second = await sendBatchSummary(ledger.db, client, summary);
    assert.equal(second.sent, false);
    assert.equal(second.result, 'skipped');
    assert.equal(second.skipped, 'duplicate_batch');
    assert.equal(second.batch_key, first.batch_key, '同一批次的键必须一致');
    assert.equal(stub.requests.length, 1, '同一批次最多推一条');

    // 批次键由批次内容派生：条目集合不变则键不变
    assert.equal(deriveBatchKey(summary), deriveBatchKey({ ...summary }));
    const otherBatch = deriveBatchKey({ ...summary, items: [{ material_code: 'MAT-SAMPLE-99', quantity: 1 }] });
    assert.notEqual(otherBatch, first.batch_key, '不同批次内容必须得到不同的键');
  });

  it('⑤ 凭据脱敏：日志、异常与实例上都拿不到密钥与 webhook key 明文', async () => {
    const logs: NotifyLogRecord[] = [];
    const client = makeClient(logs);
    stub.setBehavior({ status: 500, body: 'boom' });
    await sendBatchSummary(ledger.db, client, abnormalSummary());

    // 日志里没有明文密钥，也没有 webhook key
    const logText = JSON.stringify(logs);
    assert.ok(logs.length > 0, '失败也要留一条日志');
    assert.ok(!logText.includes(WECOM_SECRET), '日志不得出现加签密钥明文');
    assert.ok(!logText.includes(WECOM_KEY), '日志不得出现 webhook key 明文');
    for (const record of logs) {
      assert.equal(record.channel, 'notify');
      assert.ok(record.endpoint);
      assert.ok(!record.endpoint.includes(WECOM_KEY), '端点不得出现 webhook key 明文');
      assert.ok(record.endpoint.endsWith('?***'), '端点必须把 query 整段打码');
    }

    // 凭据单一出口：实例上没有任何可枚举属性暴露凭据
    assert.ok(!JSON.stringify(client).includes(WECOM_SECRET));
    assert.ok(!String(client).includes(WECOM_SECRET));
    assert.ok(!JSON.stringify(client).includes(WECOM_KEY));
    assert.ok(!Object.keys(client).includes('secret'));
    assert.ok(!Object.keys(client).includes('webhookUrl'));
  });

  it('⑥ 主路径集成：扫码事件入站 → 逐条结论 → 一条批次摘要', async () => {
    const logs: NotifyLogRecord[] = [];
    const client = makeClient(logs);
    const handle: IngestServerHandle = await startIngestServer({
      db: ledger.db,
      token: SCAN_TOKEN,
      secret: SCAN_SECRET,
      notify: { client },
    });

    try {
      const body = {
        operation_no: 'OP-SAMPLE-002',
        room_no: 'OR-02',
        scanner_id: 'SCAN-GUN-09',
        scans: [
          { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T10:00:00+08:00' },
          { material_code: 'MAT-SAMPLE-02', quantity: 1, scan_time: '2026-01-15T10:01:00+08:00' },
          { material_code: 'MAT-NOT-REGISTERED', quantity: 1, scan_time: '2026-01-15T10:02:00+08:00' },
        ],
      };
      const rawBody = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = newNonce();
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/v1/scan-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SCAN_TOKEN}`,
          'x-scan-timestamp': timestamp,
          'x-scan-nonce': nonce,
          'x-scan-signature': formatSignatureHeader(timestamp, nonce, rawBody, SCAN_SECRET),
        },
        body: rawBody,
      });

      assert.equal(response.status, 200);
      const result = (await response.json()) as {
        accepted: Array<{ material_code: string }>;
        rejected: Array<{ material_code: string; reason_code: string }>;
      };
      assert.equal(result.accepted.length, 2);
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0]?.reason_code, 'MATERIAL_NOT_REGISTERED');

      // 企微收到一条批次摘要：带台次号与异常耗材码
      assert.equal(stub.requests.length, 1, '入站一批只推一条');
      const pushed = JSON.parse((stub.requests[0] as CapturedRequest).body) as {
        markdown: { content: string };
      };
      assert.ok(pushed.markdown.content.includes('OP-SAMPLE-002'), '消息带台次号');
      assert.ok(
        pushed.markdown.content.includes('MAT-NOT-REGISTERED'),
        '消息带异常耗材码',
      );
    } finally {
      await handle.close();
    }
  });

  it('⑦ 对端返回业务错误码（errcode ≠ 0）时不静默当成成功', async () => {
    stub.setBehavior({ status: 200, body: JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' }) });
    const outcome = await sendBatchSummary(ledger.db, makeClient(), abnormalSummary());

    assert.equal(outcome.sent, false);
    assert.equal(outcome.result, 'failed');
    assert.equal(outcome.error_code, NOTIFY_ERROR_CODES.bizError);
    assert.equal(outcome.error_code, 'ERR_NOTIFY_BIZ_ERROR');
    assert.ok(outcome.message?.includes('93000'), '错误信息里带对端错误码');
  });

  it('⑧ 消息体构造：超出上限的异常折叠计数，重复扫码默认不进清单', async () => {
    const exceptions = Array.from({ length: 25 }, (_, index) => ({
      material_code: `MAT-X-${index}`,
      reason_code: 'MATERIAL_NOT_REGISTERED',
      conclusion: 'NOT_REGISTERED',
      quantity: 1,
    }));
    const message = buildBatchSummaryMessage(
      { ...abnormalSummary(), exceptions },
      { maxExceptionItems: 20 },
    );
    assert.ok(message.markdown.content.includes('另有 5 条未列出'), '超出的条数折叠计数');
    assert.ok(!message.markdown.content.includes('MAT-X-24'), '超出上限的条目不进消息');

    // 重复扫码（幂等层的正常结果）默认不进清单 —— 过滤发生在推送入口，不在消息构造里
    const duplicateOnly = await sendBatchSummary(ledger.db, makeClient(), {
      ...abnormalSummary(),
      exceptions: [
        {
          material_code: 'MAT-SAMPLE-01',
          reason_code: 'DUPLICATE_SCAN',
          conclusion: 'NOT_REGISTERED',
          quantity: 1,
        },
      ],
    });
    assert.equal(duplicateOnly.sent, false);
    assert.equal(duplicateOnly.skipped, 'no_exception');
    assert.equal(stub.requests.length, 0, '只有重复扫码的批次不进推送清单');
  });
});
