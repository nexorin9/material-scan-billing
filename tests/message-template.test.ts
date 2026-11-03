/**
 * test_message_template：企微批次消息模板与去重节流（按台次聚合 · 不刷屏）。
 *
 * 替身说明：这里的「企业微信替身」是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走**同一条代码路径**（原生 fetch → 真实 socket → 真实请求头 / 请求体），
 * 不 mock fetch、不注入假响应对象。替身只存在于测试数据层。
 *
 * 覆盖：
 *   ① 同台次 3 条异常在窗口内合并成**一条**消息，消息体带 3 个条目；
 *   ② 同一条异常重复扫码在窗口内不重复出现（去重 + 折叠计数）；
 *   ③ 无异常批次一条都不发（不打扰手术室）；
 *   ④ 消息体带「该谁处理」与「建议处置」（岗位看完能直接动手）；
 *   ⑤ 不同台次各成一条（不混台次）；窗口过期后新异常另起窗口；
 *   ⑥ 发送失败不丢信息（按退避重新排队）、同一窗口重发只推一条；
 *   ⑦ 消息里不含患者可识别字段；
 *   ⑧ 主路径集成：扫码事件入站 → 并进台次窗口 → 窗口结束发出一条消息。
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { startIngestServer, type IngestServerHandle } from '../src/ingest/http-server.js';
import { formatSignatureHeader } from '../src/ingest/signature.js';
import { newNonce } from '../src/ingest/replay-guard.js';
import {
  WeComBotClient,
  type NotifySummary,
} from '../src/check/notify.js';
import {
  BatchMessageAggregator,
  buildAggregatedMessage,
  createAggregatingSink,
  deriveExceptionKey,
  deriveWindowKey,
  sendAggregatedMessage,
  type AggregatedBatch,
} from '../src/check/message-template.js';

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
const WINDOW_MS = 30_000;

/* ── 企业微信替身：真实 HTTP 服务，记录收到的请求 ── */

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

class WeComStub {
  readonly requests: CapturedRequest[] = [];
  private readonly server: Server;
  private status = 200;
  private body = JSON.stringify({ errcode: 0, errmsg: 'ok' });
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
        res.writeHead(this.status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(this.body);
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

  setBehavior(status: number, body: string): void {
    this.status = status;
    this.body = body;
  }

  reset(): void {
    this.requests.length = 0;
    this.status = 200;
    this.body = JSON.stringify({ errcode: 0, errmsg: 'ok' });
  }

  webhookUrl(): string {
    return `${this.baseUrl}/cgi-bin/webhook/send?key=${WECOM_KEY}`;
  }
}

let stub: WeComStub;
let ledger: LedgerDb;
/** 可控时钟（毫秒） */
let clockMs = 1_700_000_000_000;

before(async () => {
  stub = new WeComStub();
  await stub.start();
});

after(async () => {
  await stub.stop();
});

beforeEach(() => {
  stub.reset();
  clockMs = 1_700_000_000_000;
  ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
});

afterEach(() => {
  ledger.close();
});

function makeClient(): WeComBotClient {
  return new WeComBotClient({
    webhookUrl: stub.webhookUrl(),
    secret: WECOM_SECRET,
    logger: () => undefined,
  });
}

function makeAggregator(windowMs = WINDOW_MS): BatchMessageAggregator {
  return new BatchMessageAggregator({ windowMs, nowMs: () => clockMs });
}

/** 造一批摘要：3 条异常 */
function summaryWith(
  exceptions: NotifySummary['exceptions'],
  overrides: Partial<NotifySummary> = {},
): NotifySummary {
  return {
    operation_no: OPEN_OP,
    room_no: 'OR-01',
    dept_code: 'SURG-01',
    scanner_id: 'SCAN-GUN-07',
    total: 6,
    accepted: 3,
    rejected: exceptions.length,
    exceptions,
    items: [
      { material_code: 'MAT-SAMPLE-01', quantity: 1 },
      { material_code: 'MAT-SAMPLE-02', quantity: 1 },
      { material_code: 'MAT-X-01', quantity: 1 },
      { material_code: 'MAT-X-02', quantity: 1 },
      { material_code: 'MAT-X-03', quantity: 1 },
    ],
    ...overrides,
  };
}

const THREE_EXCEPTIONS: NotifySummary['exceptions'] = [
  {
    material_code: 'MAT-X-01',
    reason_code: 'MATERIAL_NOT_REGISTERED',
    conclusion: 'NOT_REGISTERED',
    quantity: 1,
    operation_no: OPEN_OP,
  },
  {
    material_code: 'MAT-X-02',
    reason_code: 'OPERATION_CLOSED',
    conclusion: 'CLOSED',
    quantity: 1,
    operation_no: OPEN_OP,
  },
  {
    material_code: 'MAT-X-03',
    reason_code: 'CROSS_OP_DUPLICATE_MATERIAL',
    conclusion: 'CROSS_OP_DUP',
    quantity: 1,
    operation_no: OPEN_OP,
  },
];

describe('test_message_template · 企微消息模板与去重节流', () => {
  it('① 同台次 3 条异常在窗口内合并成一条消息，消息体带 3 个条目', async () => {
    const aggregator = makeAggregator();
    const outcome = aggregator.enqueue(summaryWith(THREE_EXCEPTIONS));
    assert.equal(outcome.buffered, 3, '三条异常都并进窗口');
    assert.equal(outcome.duplicates, 0);
    assert.equal(outcome.window_opened, true);
    assert.equal(outcome.skipped, null);

    // 窗口还没结束：不发
    assert.equal(aggregator.flushDue(clockMs + WINDOW_MS - 1).length, 0, '窗口内不提前发');

    // 窗口结束：出一条消息
    clockMs += WINDOW_MS;
    const due = aggregator.flushDue(clockMs);
    assert.equal(due.length, 1, '一个台次一条消息');
    const batch = due[0] as AggregatedBatch;
    assert.equal(batch.exception_count, 3, '三条异常一条不少');
    assert.equal(batch.exceptions.length, 3);
    assert.equal(batch.operation_no, OPEN_OP);
    assert.equal(batch.room_no, 'OR-01');
    assert.equal(batch.batch_count, 1);
    assert.equal(batch.total, 6);
    assert.equal(batch.accepted, 3);

    // 真发一次：企微替身只收到一条请求
    const sent = await sendAggregatedMessage(ledger.db, makeClient(), batch);
    assert.equal(sent.sent, true);
    assert.equal(sent.result, 'sent');
    assert.equal(stub.requests.length, 1, '同台次只推一条');

    const body = JSON.parse((stub.requests[0] as CapturedRequest).body) as {
      markdown: { content: string };
    };
    const content = body.markdown.content;
    assert.ok(content.includes(OPEN_OP), '消息带台次号');
    assert.ok(content.includes('OR-01'), '消息带手术间');
    assert.ok(content.includes('MAT-X-01'), '消息带异常耗材码 1');
    assert.ok(content.includes('MAT-X-02'), '消息带异常耗材码 2');
    assert.ok(content.includes('MAT-X-03'), '消息带异常耗材码 3');
    assert.ok(content.includes('待核 3 条'), '消息带待核条数（便于核对）');
    assert.ok(content.includes('时间窗'), '消息带时间窗');
  });

  it('② 同一条异常重复扫码在窗口内不重复出现（去重 + 折叠计数）', async () => {
    const aggregator = makeAggregator();
    const first = aggregator.enqueue(summaryWith([THREE_EXCEPTIONS[0] as never]));
    assert.equal(first.buffered, 1);
    assert.equal(first.duplicates, 0);

    // 同一耗材码、同一结论又扫了两遍
    const second = aggregator.enqueue(summaryWith([THREE_EXCEPTIONS[0] as never]));
    assert.equal(second.buffered, 0, '重复扫码不再进清单');
    assert.equal(second.duplicates, 1, '重复被折叠计数');

    clockMs += WINDOW_MS;
    const due = aggregator.flushDue(clockMs);
    assert.equal(due.length, 1);
    const batch = due[0] as AggregatedBatch;
    assert.equal(batch.exception_count, 1, '窗口内只出现一次');
    assert.equal(batch.duplicates_dropped, 1);
    assert.equal(batch.exceptions[0]?.repeat_count, 1);

    const message = buildAggregatedMessage(batch);
    assert.ok(message.markdown.content.includes('重复扫码折叠 1 条'), '折叠条数写进消息');
  });

  it('③ 无异常批次一条都不发（不打扰手术室）', async () => {
    const aggregator = makeAggregator();
    const outcome = aggregator.enqueue(summaryWith([]));
    assert.equal(outcome.skipped, 'no_exception');
    assert.equal(outcome.buffered, 0);
    assert.equal(aggregator.openWindowCount, 0, '无异常不开窗口');

    clockMs += WINDOW_MS * 2;
    const due = aggregator.flushDue(clockMs);
    assert.equal(due.length, 0, '没有消息可发');
    assert.equal(stub.requests.length, 0, '企微一条都没收到');

    // 只有「重复扫码」的批次同样不进清单（那是幂等层的正常结果）
    const dupOnly = aggregator.enqueue(
      summaryWith([
        {
          material_code: 'MAT-SAMPLE-01',
          reason_code: 'DUPLICATE_SCAN',
          conclusion: 'NOT_REGISTERED',
          quantity: 1,
        },
      ]),
    );
    assert.equal(dupOnly.skipped, 'no_exception');
    assert.equal(aggregator.openWindowCount, 0);
  });

  it('④ 消息体带「该谁处理」与「建议处置」', async () => {
    const aggregator = makeAggregator();
    aggregator.enqueue(summaryWith(THREE_EXCEPTIONS));
    clockMs += WINDOW_MS;
    const batch = aggregator.flushDue(clockMs)[0] as AggregatedBatch;

    const content = buildAggregatedMessage(batch).markdown.content;
    assert.ok(content.includes('该谁处理：'), '消息写明该谁处理');
    assert.ok(content.includes('建议处置：'), '消息写明建议处置');
    // 未建档 → 高值耗材管理岗；已关台 → 手术室护士长；跨台次重复 → 手术室护士长
    assert.ok(content.includes('高值耗材管理岗'), '未建档找耗材管理岗');
    assert.ok(content.includes('手术室护士长'), '已关台 / 跨台次重复找护士长');
    assert.ok(content.includes('补建档'), '建议处置是中文可执行的一句话，不是原始字段');
    // 原始原因码仍保留，便于与核查清单反查
    assert.ok(content.includes('MATERIAL_NOT_REGISTERED'));
    assert.ok(content.includes('OPERATION_CLOSED'));
  });

  it('⑤ 不同台次各成一条；窗口过期后新异常另起窗口', async () => {
    const aggregator = makeAggregator();
    const t0 = clockMs;

    // 台次 A 的窗口：[t0, t0+30s]
    aggregator.enqueue(summaryWith([THREE_EXCEPTIONS[0] as never]));
    // 台次 B 的窗口：[t0+25s, t0+55s]（错开，两个窗口不是同时到期）
    clockMs = t0 + 25_000;
    aggregator.enqueue(
      summaryWith([THREE_EXCEPTIONS[1] as never], {
        operation_no: 'OP-SAMPLE-002',
        room_no: 'OR-02',
      }),
    );
    assert.equal(aggregator.openWindowCount, 2, '两个台次两个窗口');

    // 只发到期的那条（A 到期，B 还没到）
    clockMs = t0 + 30_000;
    const due = aggregator.flushDue(clockMs);
    assert.equal(due.length, 1, '只发到期的那条');
    assert.equal(due[0]?.operation_no, OPEN_OP);

    // A 的窗口已过期并已取走：同一台次再来一条异常 → 另起一个新窗口，不并进旧窗口
    clockMs = t0 + 31_000;
    aggregator.enqueue(summaryWith([THREE_EXCEPTIONS[2] as never]));
    assert.equal(aggregator.openWindowCount, 2, 'B 的窗口 + A 的新窗口');

    clockMs = t0 + 61_000;
    const due2 = aggregator.flushDue(clockMs);
    assert.equal(due2.length, 2, '两个台次各一条');
    const byOperation = new Map(due2.map((batch) => [batch.operation_no, batch]));
    assert.equal(byOperation.get(OPEN_OP)?.exception_count, 1, 'A 的新窗口只有新来的那条');
    assert.equal(byOperation.get('OP-SAMPLE-002')?.exception_count, 1);
  });

  it('⑥ 发送失败不丢信息（按退避重新排队）；同一窗口重发只推一条', async () => {
    const aggregator = makeAggregator();
    aggregator.enqueue(summaryWith(THREE_EXCEPTIONS));
    clockMs += WINDOW_MS;
    const batch = aggregator.flushDue(clockMs)[0] as AggregatedBatch;

    // 对端 500：发送失败
    stub.setBehavior(500, 'boom');
    const failed = await sendAggregatedMessage(ledger.db, makeClient(), batch);
    assert.equal(failed.sent, false);
    assert.equal(failed.result, 'failed');
    assert.equal(failed.error_code, 'ERR_NOTIFY_HTTP_5XX');

    // 失败计数进审计链与推送台账
    const auditRow = ledger.db
      .prepare("SELECT detail FROM audit_chain WHERE event_type = 'notify_window_failed'")
      .get() as { detail: string } | undefined;
    assert.ok(auditRow, '审计链留一行失败');
    assert.ok(auditRow.detail.includes('ERR_NOTIFY_HTTP_5XX'));

    // 失败的消息按退避重新排队（不丢信息）
    aggregator.requeue(batch);
    assert.equal(aggregator.flushDue(clockMs).length, 0, '退避期内不再发');
    clockMs += 10_000;
    const again = aggregator.flushDue(clockMs);
    assert.equal(again.length, 1, '退避到期后重新可发');
    assert.equal(again[0]?.window_key, batch.window_key, '窗口键不变');

    // 对端恢复：这一条推出去
    stub.setBehavior(200, JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    const sent = await sendAggregatedMessage(ledger.db, makeClient(), again[0] as AggregatedBatch);
    assert.equal(sent.sent, true);
    assert.equal(stub.requests.length, 2, '第一次失败 + 第二次成功');

    // 同一窗口再发一次：被窗口键挡住，不再推第二遍
    const duplicate = await sendAggregatedMessage(ledger.db, makeClient(), again[0] as AggregatedBatch);
    assert.equal(duplicate.sent, false);
    assert.equal(duplicate.result, 'skipped');
    assert.equal(duplicate.skipped, 'duplicate_batch');
    assert.equal(stub.requests.length, 2, '同一窗口最多推一条');
  });

  it('⑦ 唯一键口径：异常键三段、窗口键与窗口起点绑定', () => {
    assert.equal(
      deriveExceptionKey(OPEN_OP, 'MAT-X-01', 'NOT_REGISTERED'),
      `${OPEN_OP}|MAT-X-01|NOT_REGISTERED`,
      '异常唯一键 = 台次 | 耗材码 | 结论',
    );
    assert.notEqual(
      deriveExceptionKey(OPEN_OP, 'MAT-X-01', 'NOT_REGISTERED'),
      deriveExceptionKey(OPEN_OP, 'MAT-X-01', 'CHARGE_REJECTED'),
      '换了结论就是另一件事',
    );
    assert.equal(
      deriveWindowKey(OPEN_OP, 1000),
      deriveWindowKey(OPEN_OP, 1000),
      '同一窗口键稳定',
    );
    assert.notEqual(
      deriveWindowKey(OPEN_OP, 1000),
      deriveWindowKey(OPEN_OP, 2000),
      '不同窗口键不同',
    );
  });

  it('⑧ 消息里不含患者可识别字段', async () => {
    const aggregator = makeAggregator();
    aggregator.enqueue(summaryWith(THREE_EXCEPTIONS));
    clockMs += WINDOW_MS;
    const batch = aggregator.flushDue(clockMs)[0] as AggregatedBatch;
    const content = buildAggregatedMessage(batch).markdown.content;

    for (const forbidden of ['患者', '姓名', '身份证', '住院号', '病案号', '门诊号']) {
      assert.ok(!content.includes(forbidden), `消息不得出现「${forbidden}」`);
    }
  });

  it('⑨ 重排队消息与新窗口合并：两边异常一条不少（节流不丢信息）', async () => {
    const aggregator = makeAggregator();

    // 窗口 A：一条异常 → 窗口结束 → 取出 → 发送失败 → 按退避重排队
    aggregator.enqueue(summaryWith([THREE_EXCEPTIONS[0] as never]));
    clockMs += WINDOW_MS;
    const batchA = aggregator.flushDue(clockMs)[0] as AggregatedBatch;
    stub.setBehavior(500, 'boom');
    const failed = await sendAggregatedMessage(ledger.db, makeClient(), batchA);
    assert.equal(failed.result, 'failed');
    aggregator.requeue(batchA);

    // 同一台次又来一条新异常：另起一个新窗口（重排队的那条还在退避里）
    clockMs += 1_000;
    aggregator.enqueue(summaryWith([THREE_EXCEPTIONS[1] as never]));
    assert.equal(aggregator.openWindowCount, 1, '新异常开了新窗口');

    // 新窗口到期：与重排队的旧消息**合并**成一条
    clockMs += WINDOW_MS;
    const due = aggregator.flushDue(clockMs);
    assert.equal(due.length, 1, '同一台次只出一条消息');
    const merged = due[0] as AggregatedBatch;
    const codes = merged.exceptions.map((exception) => exception.material_code).sort();
    assert.deepEqual(
      codes,
      ['MAT-X-01', 'MAT-X-02'],
      '先到那条的异常与后到那条的异常都在（不能覆盖丢信息）',
    );
    assert.equal(merged.exception_count, 2, '待核条数按合并后的实际条数');
    assert.equal(merged.batch_count, 2, '两批合成一条');
    assert.equal(merged.window_key, batchA.window_key, '窗口键取最早那批（同一台次仍算一条）');

    // 消息体里两边的耗材码都在
    const content = buildAggregatedMessage(merged).markdown.content;
    assert.ok(content.includes('MAT-X-01'), '消息带先到那条的耗材码');
    assert.ok(content.includes('MAT-X-02'), '消息带后到那条的耗材码');
    assert.ok(content.includes('待核 2 条'), '消息带合并后的待核条数');

    // 合并后发出去成功：先到那条的失败记录被覆盖成已送达，不留悬着的失败计数
    stub.setBehavior(200, JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    const sent = await sendAggregatedMessage(ledger.db, makeClient(), merged);
    assert.equal(sent.sent, true);
    const failures = ledger.db
      .prepare("SELECT COUNT(*) AS n FROM notify_delivery WHERE status = 'failed'")
      .get() as { n: number };
    assert.equal(failures.n, 0, '合并后送达 → 没有悬着的失败计数');
  });

  it('⑩ 主路径集成：扫码事件入站 → 并进台次窗口 → 窗口结束发出一条消息', async () => {
    const aggregator = makeAggregator();
    const sink = createAggregatingSink(aggregator);
    const handle: IngestServerHandle = await startIngestServer({
      db: ledger.db,
      token: SCAN_TOKEN,
      secret: SCAN_SECRET,
      notify: { client: makeClient(), sink },
    });

    try {
      const body = {
        operation_no: OPEN_OP,
        room_no: 'OR-01',
        scanner_id: 'SCAN-GUN-07',
        scans: [
          { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T10:00:00+08:00' },
          { material_code: 'MAT-NOT-REGISTERED', quantity: 1, scan_time: '2026-01-15T10:01:00+08:00' },
          { material_code: 'MAT-ALSO-NOT-REGISTERED', quantity: 1, scan_time: '2026-01-15T10:02:00+08:00' },
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
        accepted: unknown[];
        rejected: Array<{ material_code: string; reason_code: string }>;
      };
      assert.equal(result.accepted.length, 1);
      assert.equal(result.rejected.length, 2);

      // 入站这一批**没有**立刻发消息（并进窗口了）
      assert.equal(stub.requests.length, 0, '窗口内不发，等合并');
      assert.equal(aggregator.openWindowCount, 1);

      // 窗口结束 → 一条消息，2 条异常都在里面
      clockMs += WINDOW_MS;
      const due = aggregator.flushDue(clockMs);
      assert.equal(due.length, 1);
      const sent = await sendAggregatedMessage(ledger.db, makeClient(), due[0] as AggregatedBatch);
      assert.equal(sent.sent, true);
      assert.equal(stub.requests.length, 1, '两批异常只推一条');

      const pushed = JSON.parse((stub.requests[0] as CapturedRequest).body) as {
        markdown: { content: string };
      };
      assert.ok(pushed.markdown.content.includes('MAT-NOT-REGISTERED'));
      assert.ok(pushed.markdown.content.includes('MAT-ALSO-NOT-REGISTERED'));
      assert.ok(pushed.markdown.content.includes('待核 2 条'));
    } finally {
      await handle.close();
    }
  });
});
