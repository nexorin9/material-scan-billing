/**
 * test_event_log：事件日志落盘与溯源。
 *
 * 覆盖：
 *   ① **原始报文逐字保留** —— 事件日志里的 raw_body 与入参一字节不差
 *      （设备到底报了什么，是排障的第一手材料；改了就没法复盘）；
 *   ② **三向回查** —— 由 request_id 一次查出「事件 → 台账条目 → 审计链」；
 *   ③ **按耗材码回查事件序列** —— 原始码（UDI / GS1）与院内码都能反查；
 *   ④ **保留策略** —— 超保留期 / 超最大行数的旧事件按最旧清掉，
 *      清了多少写进审计链（清的是日志，不是账）；
 *   ⑤ **溯源索引与列** —— request_id / received_at 索引、耗材码关联表、
 *      台账行 request_id 列都在位。
 *
 * 替身说明：本文件只读本地台账，不连任何外部系统；入站走本地 HTTP 服务
 * （真实 socket + 真实签名），不 mock fetch。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import {
  appendEventLog,
  applyEventLogRetention,
  countEventLog,
  listEventLog,
  listEventsByMaterialCode,
  listEventsByRequestId,
  traceRequest,
} from '../src/ledger/event-log.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { queryAuditByType } from '../src/ledger/audit.js';
import { startIngestServer, type IngestServerHandle } from '../src/ingest/http-server.js';
import { formatSignatureHeader } from '../src/ingest/signature.js';
import { newNonce } from '../src/ingest/replay-guard.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const TOKEN = 'event-log-scanner-token';
const SECRET = 'event-log-scanner-secret';

/** 一批 3 条扫码（含中文科室语汇的原始报文，用来验「逐字保留」） */
function demoBatch() {
  return {
    operation_no: 'OP-SAMPLE-001',
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    scans: [
      { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00+08:00', batch_no: 'LOT-SAMPLE-A' },
      { material_code: 'MAT-SAMPLE-02', quantity: 2, scan_time: '2026-01-15T09:13:10+08:00', batch_no: 'LOT-SAMPLE-B' },
      { material_code: 'MAT-UNKNOWN-99', quantity: 1, scan_time: '2026-01-15T09:17:31+08:00' },
    ],
  };
}

let ledger: LedgerDb;
let handle: IngestServerHandle;

before(async () => {
  ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  handle = await startIngestServer({ db: ledger.db, token: TOKEN, secret: SECRET });
});

after(async () => {
  await handle.close();
  ledger.close();
});

/** 投一批带正确签名的扫码事件；返回状态码与**逐字**的请求体 */
async function postBatch(body: unknown = demoBatch()): Promise<{ status: number; rawBody: string }> {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = newNonce();
  const signature = formatSignatureHeader(timestamp, nonce, rawBody, SECRET);
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/v1/scan-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${TOKEN}`,
      'x-scan-timestamp': timestamp,
      'x-scan-nonce': nonce,
      'x-scan-signature': signature,
    },
    body: rawBody,
  });
  await response.text();
  return { status: response.status, rawBody };
}

describe('test_event_log · 事件日志落盘与溯源', () => {
  it('事件落库：原始报文与入参逐字一致，归一结果与结论同时落一行', async () => {
    const before = countEventLog(ledger.db);
    const posted = await postBatch();
    assert.equal(posted.status, 200);

    const events = listEventLog(ledger.db, { limit: 10 });
    assert.equal(events.length, before + 1, '应新增一行事件日志');

    const event = events[events.length - 1]!;
    assert.equal(event.raw_body, posted.rawBody, '原始报文必须与入参逐字一致');
    assert.equal(event.source, 'scanner_http');
    assert.equal(event.operation_no, 'OP-SAMPLE-001');
    assert.equal(event.room_no, 'OR-01');
    assert.equal(event.scanner_id, 'SCAN-GUN-07');
    assert.equal(event.signature_verified, true);
    assert.equal(event.conclusion, 'accepted=2;rejected=1');

    // 归一结果落在同一行里（重放与核对都靠它）
    const normalized = JSON.parse(event.normalized_json ?? '{}') as {
      items: Array<{ material_code: string; raw_code: string }>;
    };
    assert.equal(normalized.items.length, 3);
    assert.deepEqual(
      normalized.items.map((item) => item.material_code).sort(),
      ['MAT-SAMPLE-01', 'MAT-SAMPLE-02', 'MAT-UNKNOWN-99'],
    );
  });

  it('三向回查：由 request_id 查出事件 → 台账条目 → 审计链', async () => {
    const posted = await postBatch({
      ...demoBatch(),
      scans: [
        { material_code: 'MAT-SAMPLE-05', quantity: 1, scan_time: '2026-01-15T10:12:00+08:00' },
      ],
    });
    assert.equal(posted.status, 200);

    const events = listEventLog(ledger.db, { limit: 20 });
    const event = events[events.length - 1]!;
    const requestId = event.request_id;
    assert.ok(requestId.length > 0);

    // ① 事件侧：按 request_id 能查到这一行
    const byRequest = listEventsByRequestId(ledger.db, requestId);
    assert.equal(byRequest.length, 1);
    assert.equal(byRequest[0]!.id, event.id);

    // ② 台账侧：这一批落下的台账行带着同一个 request_id
    const trace = traceRequest(ledger.db, requestId);
    assert.equal(trace.request_id, requestId);
    assert.equal(trace.events.length, 1);
    assert.ok(trace.bindings.length >= 1, '应能查到本次投递带进来的台账条目');
    for (const binding of trace.bindings) {
      assert.equal(binding.request_id, requestId);
      assert.equal(binding.material_code, 'MAT-SAMPLE-05');
      assert.equal(binding.operation_no, 'OP-SAMPLE-001');
      assert.equal(binding.conclusion, 'BOUND');
    }

    // ③ 审计侧：占位确认等处置轨迹也能按 request_id 捞出来
    assert.ok(trace.audit.length >= 1, '应能查到本次投递的审计行');
    for (const row of trace.audit) {
      assert.equal(row.request_id, requestId);
    }
    assert.ok(
      trace.audit.some((row) => row.event_type === 'claim_confirmed'),
      '审计链里应有本批的幂等占位确认记录',
    );
  });

  it('按耗材码回查：该码的全部事件序列都能查出来（原始码与院内码同查）', async () => {
    // 同一台次同一码投两次（第二次会被幂等判重复，但**事件日志照样各留一行**）
    const first = await postBatch({
      ...demoBatch(),
      scans: [{ material_code: 'MAT-SAMPLE-02', quantity: 1, scan_time: '2026-01-15T11:12:00+08:00' }],
    });
    assert.equal(first.status, 200);
    const second = await postBatch({
      ...demoBatch(),
      scans: [{ material_code: 'MAT-SAMPLE-02', quantity: 1, scan_time: '2026-01-15T11:20:00+08:00' }],
    });
    assert.equal(second.status, 200);

    const events = listEventsByMaterialCode(ledger.db, 'MAT-SAMPLE-02', { limit: 100 });
    // 前面几批也扫过这个码 —— 序列是**全部**，不是只有最后一批
    assert.ok(events.length >= 2, `应查到该码的全部事件，实得 ${events.length}`);
    // 按收到时刻升序
    const times = events.map((event) => event.received_at);
    assert.deepEqual([...times].sort(), times, '事件序列应按收到时刻升序');
    for (const event of events) {
      assert.equal(event.operation_no, 'OP-SAMPLE-001');
      assert.ok(event.raw_body?.includes('MAT-SAMPLE-02'));
    }

    // 原始码（设备上印的那串）也能反查
    const rawPosted = await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: [{ material_code: '(01)06912345678902(10)LOT-A1', quantity: 1, scan_time: '2026-01-15T12:00:00+08:00' }],
    });
    assert.equal(rawPosted.status, 200);
    const byRaw = listEventsByMaterialCode(ledger.db, '(01)06912345678902(10)LOT-A1', { limit: 50 });
    assert.equal(byRaw.length, 1, '原始码也应能反查到事件');
    assert.ok(byRaw[0]!.raw_body?.includes('(01)06912345678902(10)LOT-A1'));
  });

  it('保留策略：超保留期与超最大行数的旧事件按最旧清掉，并留下清理审计', () => {
    const auditBefore = queryAuditByType(ledger.db, 'event_log_pruned').length;

    // 造 30 行「很久以前」的事件（保留期 7 天 → 全部过期）
    const oldIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    for (let index = 0; index < 30; index += 1) {
      appendEventLog(ledger.db, {
        request_id: `old-request-${index}`,
        source: 'scanner_http',
        operation_no: 'OP-SAMPLE-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-GUN-07',
        received_at: oldIso,
        raw_body: '{"operation_no":"OP-SAMPLE-001"}',
        material_codes: ['MAT-SAMPLE-01'],
      });
    }
    // 再造 15 行「一小时前」的事件（未过期，但条数会顶破最大行数上限）
    const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    for (let index = 0; index < 15; index += 1) {
      appendEventLog(ledger.db, {
        request_id: `recent-request-${index}`,
        source: 'scanner_http',
        operation_no: 'OP-SAMPLE-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-GUN-07',
        received_at: recentIso,
        raw_body: '{"operation_no":"OP-SAMPLE-001"}',
        material_codes: ['MAT-SAMPLE-02'],
      });
    }
    const totalBefore = countEventLog(ledger.db);
    assert.ok(totalBefore >= 45);

    // 保留期 7 天 + 最大行数 10：过期行先清，剩下的还超上限再按最旧清
    const result = applyEventLogRetention(ledger.db, {
      retentionDays: 7,
      maxRows: 10,
      nowMs: Date.now(),
    });

    assert.equal(result.removed_expired, 30, '30 行过期事件应被清掉');
    assert.ok(result.removed_overflow >= 1, '超出最大行数的应按最旧清掉');
    assert.equal(result.remaining, 10, '清理后行数回到上限内');
    assert.equal(countEventLog(ledger.db), 10);
    assert.equal(result.removed_total, result.removed_expired + result.removed_overflow);

    // 清理留痕：审计链里有一行 event_log_pruned，写清清了多少、按什么阈值清的
    const pruned = queryAuditByType(ledger.db, 'event_log_pruned');
    assert.equal(pruned.length, auditBefore + 1, '应有且仅有一行清理审计');
    const detail = JSON.parse(pruned[pruned.length - 1]!.detail ?? '{}') as {
      removed_expired: number;
      removed_total: number;
      remaining: number;
      cutoff_at: string | null;
      max_rows: number | null;
      retention_days: number | null;
    };
    assert.equal(detail.removed_expired, 30);
    assert.equal(detail.removed_total, result.removed_total);
    assert.equal(detail.remaining, 10);
    assert.ok(detail.cutoff_at);
    assert.equal(detail.max_rows, 10);
    assert.equal(detail.retention_days, 7);

    // 关联行跟着一起清，不留悬空引用
    const orphan = ledger.db
      .prepare('SELECT COUNT(*) AS n FROM scan_event_material WHERE event_id NOT IN (SELECT id FROM scan_event)')
      .get() as { n: number };
    assert.equal(orphan.n, 0, '事件行删了，耗材码关联行不能悬空');

    // 台账行、审计链、核查任务**不受影响** —— 清的是日志，不是账
    assert.ok(countBindings(ledger.db) > 0);
  });

  it('溯源索引与列就位：request_id / received_at 索引、耗材码关联表、台账行 request_id 列', () => {
    const indexes = ledger.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%scan_event%'")
      .all() as unknown as Array<{ name: string }>;
    const names = indexes.map((row) => row.name);
    assert.ok(names.includes('ix_scan_event_request'), '缺 request_id 索引');
    assert.ok(names.includes('ix_scan_event_received_at'), '缺 received_at 索引');
    assert.ok(names.includes('ix_scan_event_material_code'), '缺耗材码关联索引');

    const tables = ledger.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scan_event_material'")
      .all() as unknown as Array<{ name: string }>;
    assert.equal(tables.length, 1, '缺耗材码关联表');

    const columns = ledger.db
      .prepare('PRAGMA table_info(material_binding)')
      .all() as unknown as Array<{ name: string }>;
    assert.ok(
      columns.some((column) => column.name === 'request_id'),
      '台账行缺 request_id 列',
    );
  });

  it('事件日志是 replay 的数据源：落库的行带齐重放所需的字段', () => {
    // 自带一行「设备投递」形状的事件（与入站落的是同一条记录形状），
    // 断言重放要用的四个字段齐备：投递标识 / 归一结果 / 批次号 / 来源
    const requestId = 'replay-source-request-01';
    appendEventLog(ledger.db, {
      request_id: requestId,
      source: 'scanner_http',
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      batch_id: 'replay-source-batch-01',
      signature_verified: true,
      raw_body: '{"operation_no":"OP-SAMPLE-001","room_no":"OR-01","scanner_id":"SCAN-GUN-07","scans":[]}',
      normalized_json: JSON.stringify({
        operation_no: 'OP-SAMPLE-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-GUN-07',
        items: [{ material_code: 'MAT-SAMPLE-01', raw_code: 'MAT-SAMPLE-01', quantity: 1 }],
      }),
      material_codes: ['MAT-SAMPLE-01'],
    });

    const events = listEventsByRequestId(ledger.db, requestId);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.ok(event.request_id.length > 0, '重放要按投递标识定位');
    assert.ok(event.normalized_json && event.normalized_json.length > 0, '重放要归一结果');
    assert.ok(event.batch_id && event.batch_id.length > 0, '重放要按批次选区间');
    assert.ok(event.source.length > 0);
    assert.ok(event.received_at.length > 0, '重放要按收到时刻选区间');
  });
});
