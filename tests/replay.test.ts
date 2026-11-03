/**
 * test_replay：replay 深化 —— 区间重放、幂等不变式验证与差异比对。
 *
 * 覆盖：
 *   ① **区间重放**：同一区间连续重放两次，**第二次**台账行数增量 = 0、
 *      计费调用增量 = 0（幂等不变式成立）；
 *   ② **四种区间选择**：时间窗 / 台次 / 批次号 / 来源各自命中预期条数；
 *   ③ **差异表结构**：四个对比维度齐全 + 分布维度齐全 + 落盘 JSON 结构完整；
 *   ④ **重放走生产同一条路径**：出站计费走真实 HTTP 替身（与生产同一条 fetch 路径），
 *      对端**只收到一次**请求 —— 不另开旁路。
 *
 * 替身说明：HIS 计费替身是 `tests/support/fake-his-server.ts` 里的**真实 HTTP 服务**
 * （node:http，不 mock fetch）；生产客户端与替身走同一条代码路径。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { appendEventLog, countEventLog } from '../src/ledger/event-log.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { HisChargingClient } from '../src/charge/client.js';
import { startFakeHisServer, type FakeHisServer } from './support/fake-his-server.js';
import {
  captureReplaySnapshot,
  defaultReplayDiffPath,
  diffReplaySnapshots,
  renderReplayDiffText,
  replayIntervalSlug,
  runReplayWithDiff,
  selectReplayEvents,
  writeReplayDiff,
} from '../src/cli/replay.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const HIS_TOKEN = 'his-token-plaintext-77ef';

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

let workDir: string;
let dbPath: string;
let ledger: LedgerDb;
let hisStub: FakeHisServer;

/** 一批 3 条扫码：2 条已建档 + 1 条未建档 */
function demoScans(): Array<{ material_code: string; quantity: number; scan_time: string; batch_no?: string }> {
  return [
    { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00+08:00', batch_no: 'LOT-SAMPLE-A' },
    { material_code: 'MAT-SAMPLE-02', quantity: 2, scan_time: '2026-01-15T09:13:10+08:00', batch_no: 'LOT-SAMPLE-B' },
    { material_code: 'MAT-UNKNOWN-99', quantity: 1, scan_time: '2026-01-15T09:17:31+08:00' },
  ];
}

/** 往事件日志里落一行（与生产入站落的是同一条记录形状） */
function seedEvent(input: {
  request_id: string;
  operation_no: string;
  batch_id: string;
  received_at: string;
  source?: string;
  items?: Array<{ material_code: string; raw_code?: string; quantity?: number }>;
}): number {
  const items = input.items ?? [
    { material_code: 'MAT-SAMPLE-01', raw_code: 'MAT-SAMPLE-01', quantity: 1 },
  ];
  return appendEventLog(ledger.db, {
    request_id: input.request_id,
    source: input.source ?? 'scanner_http',
    operation_no: input.operation_no,
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    received_at: input.received_at,
    batch_id: input.batch_id,
    signature_verified: true,
    normalized_json: JSON.stringify({
      operation_no: input.operation_no,
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      items: items.map((item) => ({
        material_code: item.material_code,
        raw_code: item.raw_code ?? item.material_code,
        quantity: item.quantity ?? 1,
        batch_no: null,
      })),
    }),
    conclusion: 'accepted=0;rejected=0',
  });
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'msb-replay-'));
  dbPath = resolve(workDir, 'ledger.db');
  ledger = openLedger(dbPath);
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  hisStub = await startFakeHisServer();
});

after(async () => {
  await hisStub.close();
  ledger.close();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  ledger.db.exec('DELETE FROM material_binding');
  ledger.db.exec('DELETE FROM charge_receipt');
  ledger.db.exec('DELETE FROM check_task');
  ledger.db.exec('DELETE FROM scan_event');
  ledger.db.exec('DELETE FROM idempotency_claim');
  ledger.db.exec('DELETE FROM meta');
  hisStub.requests.length = 0;
});

describe('replay 深化：区间重放 · 幂等不变式 · 差异比对', () => {
  it('区间重放：同一区间连续重放两次，第二次台账增量 = 0 且计费调用增量 = 0', async () => {
    // 事件日志里落一批（这一批此前**没有**入过账 —— 模拟「入站丢了、事后补跑」）
    seedEvent({
      request_id: 'req-replay-001',
      operation_no: 'OP-SAMPLE-001',
      batch_id: 'BATCH-20260115-01',
      received_at: '2026-01-15T09:12:00.000Z',
      items: demoScans(),
    });
    assert.equal(countEventLog(ledger.db), 1);

    const client = new HisChargingClient({
      baseUrl: hisStub.baseUrl,
      token: HIS_TOKEN,
      timeoutMs: 5000,
      logger: () => undefined,
    });

    // 第一遍：补跑这一批 —— 应当落 2 行台账（未建档那条不落台账）
    const first = await runReplayWithDiff(ledger.db, {
      charge: true,
      chargeClient: client,
      chargePath: '/api/v1/material-uses',
    });
    assert.equal(first.replayed_events, 1);
    assert.equal(first.matched_events, 1);
    assert.equal(first.before.ledger_rows, 0);
    assert.equal(first.after.ledger_rows, 2, '补跑后应有 2 行台账（未建档那条不落台账）');
    assert.equal(first.after.outbound_charge_calls, 1, '第一遍应当真的打了一次出站请求');
    assert.equal(hisStub.requests.length, 1, '对端只应收到 1 次计费请求');

    // 第二遍：同一区间再跑一次 —— 台账增量必须为 0、计费调用增量必须为 0
    const second = await runReplayWithDiff(ledger.db, {
      charge: true,
      chargeClient: client,
      chargePath: '/api/v1/material-uses',
    });
    assert.equal(second.replayed_events, 1);
    assert.equal(second.before.ledger_rows, 2);
    assert.equal(second.after.ledger_rows, 2, '第二次重放不得产生新台账行');
    assert.equal(second.after.outbound_charge_calls, 1, '第二次重放不得再打一次出站请求');
    assert.equal(hisStub.requests.length, 1, '对端不应收到第二次计费请求');
    assert.equal(hisStub.duplicateChargeCount, 0, '对端不得出现重复计费');

    // 不变式结论：成立，且三处增量都是 0
    assert.ok(second.invariant, '应当给出不变式验证结论');
    assert.equal(second.invariant.held, true);
    assert.equal(second.invariant.ledger_delta, 0);
    assert.equal(second.invariant.outbound_call_delta, 0);
    assert.equal(second.invariant.receipt_delta, 0);
    assert.match(second.invariant.conclusion_zh, /不变式成立/);

    // 第二次重放的逐条结论全是「重复扫码」—— 这正是幂等层在起作用
    const reasons = second.batches[0]?.reason_codes ?? [];
    assert.ok(
      reasons.some((item) => item.reason_code === 'DUPLICATE_SCAN' && item.count === 2),
      `重放结论应判重复扫码：${JSON.stringify(reasons)}`,
    );
  });

  it('四种区间选择：时间窗 / 台次 / 批次号 / 来源各自命中预期条数', async () => {
    seedEvent({
      request_id: 'req-a',
      operation_no: 'OP-SAMPLE-001',
      batch_id: 'BATCH-A',
      received_at: '2026-01-15T08:00:00.000Z',
    });
    seedEvent({
      request_id: 'req-b',
      operation_no: 'OP-SAMPLE-001',
      batch_id: 'BATCH-B',
      received_at: '2026-01-15T12:00:00.000Z',
    });
    seedEvent({
      request_id: 'req-c',
      operation_no: 'OP-SAMPLE-002',
      batch_id: 'BATCH-C',
      received_at: '2026-01-16T09:00:00.000Z',
      source: 'rfid_dir',
    });
    assert.equal(countEventLog(ledger.db), 3);

    // ① 时间窗：只落在窗内的那条
    const byTime = selectReplayEvents(ledger.db, {
      from: '2026-01-15T00:00:00.000Z',
      to: '2026-01-15T23:59:59.999Z',
    });
    assert.equal(byTime.matched, 2);
    assert.equal(byTime.taken, 2);
    assert.deepEqual(byTime.rows.map((row) => row.request_id), ['req-a', 'req-b']);

    // ② 台次
    const byOperation = selectReplayEvents(ledger.db, { operation_no: 'OP-SAMPLE-001' });
    assert.equal(byOperation.matched, 2);
    assert.deepEqual(byOperation.rows.map((row) => row.request_id), ['req-a', 'req-b']);

    // ③ 批次号
    const byBatch = selectReplayEvents(ledger.db, { batch_id: 'BATCH-B' });
    assert.equal(byBatch.matched, 1);
    assert.equal(byBatch.rows[0]?.request_id, 'req-b');

    // ④ 来源
    const bySource = selectReplayEvents(ledger.db, { source: 'rfid_dir' });
    assert.equal(bySource.matched, 1);
    assert.equal(bySource.rows[0]?.request_id, 'req-c');

    // 组合口径取交集：台次 + 时间窗
    const combined = selectReplayEvents(ledger.db, {
      operation_no: 'OP-SAMPLE-001',
      from: '2026-01-15T09:00:00.000Z',
    });
    assert.equal(combined.matched, 1);
    assert.equal(combined.rows[0]?.request_id, 'req-b');

    // limit 只截取、不改区间口径（matched 不受 limit 影响）
    const limited = selectReplayEvents(ledger.db, { operation_no: 'OP-SAMPLE-001', limit: 1 });
    assert.equal(limited.matched, 2);
    assert.equal(limited.taken, 1);
  });

  it('差异表：四个对比维度齐全、分布维度齐全、落盘 JSON 结构完整', async () => {
    seedEvent({
      request_id: 'req-diff-001',
      operation_no: 'OP-SAMPLE-001',
      batch_id: 'BATCH-DIFF',
      received_at: '2026-01-15T08:00:00.000Z',
      items: demoScans(),
    });

    const client = new HisChargingClient({
      baseUrl: hisStub.baseUrl,
      token: HIS_TOKEN,
      timeoutMs: 5000,
      logger: () => undefined,
    });

    const diff = await runReplayWithDiff(ledger.db, {
      charge: true,
      chargeClient: client,
      chargePath: '/api/v1/material-uses',
    });

    // ① 四个标量对比维度齐全
    const dimensions = diff.rows.map((row) => row.dimension);
    assert.deepEqual(dimensions, [
      'ledger_rows',
      'outbound_charge_calls',
      'charge_receipts',
      'check_pending',
    ]);
    for (const row of diff.rows) {
      assert.ok(row.label_zh.length > 0, '每个维度都要有中文说法');
      assert.equal(row.delta, row.after - row.before);
      assert.equal(row.changed, row.before !== row.after);
    }

    // ② 分布维度：五种结论 / 条目状态 / 重投次数
    const conclusionRows = diff.distributions.filter((row) => row.dimension === 'conclusion');
    assert.equal(conclusionRows.length, 5, '五种结论都要出现在分布差异里');
    assert.ok(conclusionRows.some((row) => row.key === 'BOUND' && row.delta === 2));
    assert.ok(conclusionRows.some((row) => row.key === 'NOT_REGISTERED' && row.delta === 1));
    assert.ok(diff.distributions.some((row) => row.dimension === 'status' && row.key === 'charged'));
    assert.ok(diff.distributions.some((row) => row.dimension === 'retry'));

    // ③ 快照与差异表自洽
    assert.equal(diff.before.ledger_rows, 0);
    assert.equal(diff.after.ledger_rows, 2);
    assert.equal(diff.after.outbound_charge_calls, 1);
    assert.equal(diff.after.charge_receipts, 2);
    assert.equal(diff.after.check_pending, 1, '未建档那条应升一条待核查');

    // ④ 落盘：默认路径 logs/replay-<区间>-diff.json，结构完整
    const slug = replayIntervalSlug(diff.interval);
    assert.ok(slug.length > 0);
    const target = writeReplayDiff(diff, resolve(workDir, 'logs', `replay-${slug}-diff.json`));
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    assert.ok(parsed['rows']);
    assert.ok(parsed['distributions']);
    assert.ok(parsed['before']);
    assert.ok(parsed['after']);
    assert.ok(parsed['invariant']);
    assert.equal((parsed['rows'] as unknown[]).length, 4);

    // 默认路径在 logs/ 下（运行时目录，不入库）
    assert.match(defaultReplayDiffPath({ operation_no: 'OP-SAMPLE-001' }), /logs[\\/]replay-op-OP-SAMPLE-001-diff\.json$/);

    // ⑤ 终端渲染含差异表与不变式两段
    const text = renderReplayDiffText(diff);
    assert.match(text, /重放差异表/);
    assert.match(text, /幂等不变式/);
    assert.match(text, /耗材使用台账行数/);
    assert.match(text, /计费调用次数/);
  });

  it('快照比对：数值没动的维度标 changed=false，分布按项逐个对比', () => {
    const snapshot = captureReplaySnapshot(ledger.db);
    const same = diffReplaySnapshots(snapshot, snapshot);
    assert.equal(same.rows.length, 4);
    for (const row of same.rows) {
      assert.equal(row.delta, 0);
      assert.equal(row.changed, false);
    }
    for (const row of same.distributions) {
      assert.equal(row.delta, 0);
    }
  });
});
