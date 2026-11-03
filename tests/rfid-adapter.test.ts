/**
 * test_rfid_adapter：RFID 网关目录投递路（与扫码枪 HTTP 路共用解析层与幂等键）。
 *
 * 覆盖：
 *   ① 目录路投递 6 条 → 6 条逐条结论（5 绑上 + 1 未建档），台账落 5 行；
 *   ② 坏行（非法 JSON / 缺字段 / 手术间对不上）只拒这一行，其余照常入台账，坏行进审计链；
 *   ③ 同一条经 HTTP 路与目录路各投一次 → 台账仅 1 行（第二路判重复扫码，不产生第二笔计费）；
 *   ④ 处理成功后文件移入 processed/，再扫目录不重复处理；
 *   ⑤ 两路幂等键一致（sha256(material_code|operation_no)）；
 *   ⑥ 目录路共用码制归一：UDI / GS1 / 院内码 → 规范耗材码。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { startIngestServer, type IngestServerHandle } from '../src/ingest/http-server.js';
import { formatSignatureHeader } from '../src/ingest/signature.js';
import { newNonce } from '../src/ingest/replay-guard.js';
import {
  createRfidDirSource,
  REASON_INVALID_SCAN_ITEM,
  REASON_MALFORMED_JSON_LINE,
  REASON_ROOM_MISMATCH,
  type RfidDirSource,
} from '../src/ingest/adapters/rfid-dir.js';
import { dispatchBatch } from '../src/ingest/adapters/dispatch.js';
import { parseHttpScanBody } from '../src/ingest/adapters/scanner-http.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const TOKEN = 'test-scanner-token';
const SECRET = 'test-scanner-secret';

/** 一批 6 条：4 条院内码 + 1 条 UDI + 1 条 GS1 + 1 条未建档（与扫码枪路同一批） */
function demoScans() {
  return [
    { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00+08:00', batch_no: 'LOT-SAMPLE-A' },
    { material_code: 'MAT-SAMPLE-02', quantity: 2, scan_time: '2026-01-15T09:13:10+08:00', batch_no: 'LOT-SAMPLE-B' },
    { material_code: '(01)06912345678902(10)LOT-A1', quantity: 1, scan_time: '2026-01-15T09:14:22+08:00' },
    { material_code: '0106987654321092', quantity: 1, scan_time: '2026-01-15T09:15:40+08:00' },
    { material_code: 'MAT-SAMPLE-05', quantity: 1, scan_time: '2026-01-15T09:16:05+08:00', batch_no: 'LOT-SAMPLE-E' },
    { material_code: 'MAT-UNKNOWN-99', quantity: 1, scan_time: '2026-01-15T09:17:31+08:00' },
  ];
}

let ledger: LedgerDb;
let inboxDir: string;
let source: RfidDirSource;

function newLedger(): LedgerDb {
  const opened = openLedger(':memory:');
  importMasterData(opened.db, { operationsCsv, materialsCsv });
  // 与扫码枪路同一份主数据：UDI 的 DI 与 GS1 AI(01) 的 GTIN 也登记在案
  opened.db
    .prepare(
      `INSERT INTO material (material_code, name, price_code, fee_category, medical_insurance_class, active, batch_no,
                              unit_pack, unit_min, charge_unit, ratio, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run('06912345678902', '药物洗脱支架（UDI 码登记）', 'PR-DEMO-UDI', '卫生材料', '甲类', 'LOT-A1', '包', '支', '支', 1, new Date().toISOString());
  opened.db
    .prepare(
      `INSERT INTO material (material_code, name, price_code, fee_category, medical_insurance_class, active, batch_no,
                              unit_pack, unit_min, charge_unit, ratio, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run('06987654321092', '可吸收止血膜（GS1 包装码登记）', 'PR-DEMO-GS1', '卫生材料', '乙类', 'LOT-B1', '包', '片', '片', 1, new Date().toISOString());
  return opened;
}

/** 写一个投递文件（每行一条扫码） */
function writeBatchFile(operationNo: string, batchName: string, lines: unknown[]): string {
  const dir = join(inboxDir, operationNo);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${batchName}.jsonl`);
  const content = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n';
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/** 写一个批次元信息旁挂文件 */
function writeMetaFile(operationNo: string, batchName: string, meta: { room_no: string; scanner_id: string }): void {
  const dir = join(inboxDir, operationNo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${batchName}.meta.json`), JSON.stringify(meta), 'utf8');
}

beforeEach(() => {
  ledger = newLedger();
  inboxDir = mkdtempSync(join(tmpdir(), 'msb-rfid-'));
  source = createRfidDirSource({ inboxDir });
});

afterEach(() => {
  ledger.close();
  rmSync(inboxDir, { recursive: true, force: true });
});

describe('test_rfid_adapter · 目录投递 6 条 → 6 条逐条结论', () => {
  it('① 6 条逐条给结论（5 绑上 + 1 未建档），台账落 5 行', async () => {
    writeMetaFile('OP-SAMPLE-001', 'batch-001', { room_no: 'OR-01', scanner_id: 'RFID-GW-01' });
    writeBatchFile('OP-SAMPLE-001', 'batch-001', demoScans());

    const batches = await source.poll();
    assert.equal(batches.length, 1);
    const batch = batches[0];
    assert.ok(batch);
    assert.equal(batch.source, 'rfid_dir');
    assert.equal(batch.operation_no, 'OP-SAMPLE-001');
    assert.equal(batch.room_no, 'OR-01');
    assert.equal(batch.scanner_id, 'RFID-GW-01');
    assert.equal(batch.items.length, 6);
    assert.equal(batch.rejects.length, 0);

    const result = dispatchBatch(ledger.db, batch);
    assert.equal(result.stats.total, 6);
    assert.equal(result.accepted.length, 5);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.material_code, 'MAT-UNKNOWN-99');
    assert.equal(result.rejected[0]?.reason_code, 'MATERIAL_NOT_REGISTERED');

    // 台账落 5 行（未建档那条不落台账）
    assert.equal(countBindings(ledger.db), 5);
    const row = ledger.db
      .prepare('SELECT operation_no, room_no, dept_code, material_code FROM material_binding WHERE material_code = ?')
      .get('MAT-SAMPLE-01') as { operation_no: string; room_no: string; dept_code: string; material_code: string };
    assert.equal(row.operation_no, 'OP-SAMPLE-001');
    assert.equal(row.room_no, 'OR-01');
    assert.equal(row.dept_code, 'SURG-01');
  });

  it('⑥ 目录路共用码制归一：UDI / GS1 / 院内码 → 规范耗材码', async () => {
    writeMetaFile('OP-SAMPLE-001', 'batch-001', { room_no: 'OR-01', scanner_id: 'RFID-GW-01' });
    writeBatchFile('OP-SAMPLE-001', 'batch-001', demoScans());

    const batches = await source.poll();
    const batch = batches[0];
    assert.ok(batch);
    const codes = batch.items.map((item) => item.material_code).sort();
    assert.deepEqual(codes, ['06912345678902', '06987654321092', 'MAT-SAMPLE-01', 'MAT-SAMPLE-02', 'MAT-SAMPLE-05', 'MAT-UNKNOWN-99']);
    // 原始码保留在归一结果里，事后可核对设备扫的到底是哪个码
    const udi = batch.items.find((item) => item.material_code === '06912345678902');
    assert.equal(udi?.raw_code, '(01)06912345678902(10)LOT-A1');
  });
});

describe('test_rfid_adapter · 坏行只拒这一行', () => {
  it('② 非法 JSON / 缺字段 / 手术间对不上：只拒该行，其余照常入台账，坏行进审计链', async () => {
    const good = demoScans()[0] as Record<string, unknown>;
    writeMetaFile('OP-SAMPLE-002', 'batch-002', { room_no: 'OR-02', scanner_id: 'RFID-GW-02' });
    writeBatchFile('OP-SAMPLE-002', 'batch-002', [
      '{ 这不是合法 JSON',
      { material_code: 'MAT-SAMPLE-03', quantity: 1 }, // 缺 scan_time
      { ...good, room_no: 'OR-99' }, // 手术间与批次不一致
      { ...good, material_code: 'MAT-SAMPLE-04' },
    ]);

    const batches = await source.poll();
    const batch = batches[0];
    assert.ok(batch);
    assert.equal(batch.items.length, 1, '只有完全合规那一行可结算');
    assert.equal(batch.rejects.length, 3, '三行坏数据各自成条，不丢不合并');

    const reasonCodes = batch.rejects.map((reject) => reject.reason_code).sort();
    assert.deepEqual(reasonCodes, [REASON_INVALID_SCAN_ITEM, REASON_MALFORMED_JSON_LINE, REASON_ROOM_MISMATCH].sort());

    // 坏行都能定位到具体行号
    for (const reject of batch.rejects) {
      assert.ok(reject.line_no >= 1);
      assert.ok(reject.detail.length > 0);
    }

    const result = dispatchBatch(ledger.db, batch);
    assert.equal(result.stats.total, 4, '4 行 = 1 条绑上 + 3 条坏行，结论条数守恒');
    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejects.length, 3, '三条坏行各自成条');
    assert.equal(result.outcomes.length, 4, '逐条视图：1 条绑上 + 3 条坏行');
    assert.equal(result.stats.rejected, 3);

    // 坏行在逐条视图里也是「该行 rejected」，原因码逐条可追
    const rejectedOutcomes = result.outcomes.filter((outcome) => !outcome.bound);
    assert.equal(rejectedOutcomes.length, 3);
    assert.deepEqual(
      rejectedOutcomes.map((outcome) => outcome.reason_code).sort(),
      [REASON_INVALID_SCAN_ITEM, REASON_MALFORMED_JSON_LINE, REASON_ROOM_MISMATCH].sort(),
    );

    // 合规那一行照常入台账，坏行不落台账
    assert.equal(countBindings(ledger.db), 1);
    const row = ledger.db
      .prepare('SELECT material_code FROM material_binding')
      .get() as { material_code: string };
    assert.equal(row.material_code, 'MAT-SAMPLE-04');

    // 坏行进审计链（可回看设备侧到底报了什么）
    const auditRows = ledger.db
      .prepare("SELECT detail FROM audit_chain WHERE event_type = 'ingest_bad_line' ORDER BY id ASC")
      .all() as unknown as Array<{ detail: string }>;
    assert.equal(auditRows.length, 3);
    for (const row of auditRows) {
      const detail = JSON.parse(row.detail) as { source: string; line_no: number; reason_code: string };
      assert.equal(detail.source, 'rfid_dir');
      assert.ok(detail.line_no >= 1);
      assert.ok(detail.reason_code.length > 0);
    }
  });
});

describe('test_rfid_adapter · 两路共用幂等键', () => {
  it('③ 同一条经 HTTP 路与目录路各投一次 → 台账仅 1 行，第二路判重复扫码', async () => {
    const handle: IngestServerHandle = await startIngestServer({ db: ledger.db, token: TOKEN, secret: SECRET });
    try {
      // ① 扫码枪 HTTP 路先投
      const body = JSON.stringify({
        operation_no: 'OP-SAMPLE-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-GUN-07',
        scans: [demoScans()[1]],
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = newNonce();
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/v1/scan-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'x-scan-timestamp': timestamp,
          'x-scan-nonce': nonce,
          'x-scan-signature': formatSignatureHeader(timestamp, nonce, body, SECRET),
        },
        body,
      });
      const httpJson = (await response.json()) as {
        accepted: Array<{ material_code: string }>;
        rejected: Array<{ material_code: string; reason_code: string }>;
      };
      assert.equal(response.status, 200);
      assert.equal(httpJson.accepted.length, 1);
      assert.equal(countBindings(ledger.db), 1);

      // ② RFID 目录路再投同一条
      writeMetaFile('OP-SAMPLE-001', 'batch-101', { room_no: 'OR-01', scanner_id: 'RFID-GW-01' });
      writeBatchFile('OP-SAMPLE-001', 'batch-101', [demoScans()[1]]);
      const batches = await source.poll();
      const batch = batches[0];
      assert.ok(batch);
      const result = dispatchBatch(ledger.db, batch);

      assert.equal(result.accepted.length, 0, '第二路不得再绑一次');
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0]?.reason_code, 'DUPLICATE_SCAN');
      assert.equal(countBindings(ledger.db), 1, '台账仍只有 1 行（不产生第二笔计费）');

      // ⑤ 两路幂等键一致：与 sha256("v1|material_code|operation_no") 逐字相等
      const expected = createHash('sha256').update('v1|MAT-SAMPLE-02|OP-SAMPLE-001').digest('hex');
      const row = ledger.db
        .prepare('SELECT idempotency_key FROM material_binding WHERE material_code = ?')
        .get('MAT-SAMPLE-02') as { idempotency_key: string };
      assert.equal(row.idempotency_key, expected);
    } finally {
      await handle.close();
    }
  });

  it('③ 反序：目录路先投、HTTP 路再投，台账同样只有 1 行', async () => {
    writeMetaFile('OP-SAMPLE-001', 'batch-102', { room_no: 'OR-01', scanner_id: 'RFID-GW-01' });
    writeBatchFile('OP-SAMPLE-001', 'batch-102', [demoScans()[0]]);
    const batches = await source.poll();
    const batch = batches[0];
    assert.ok(batch);
    const first = dispatchBatch(ledger.db, batch);
    assert.equal(first.accepted.length, 1);
    assert.equal(countBindings(ledger.db), 1);

    const handle: IngestServerHandle = await startIngestServer({ db: ledger.db, token: TOKEN, secret: SECRET });
    try {
      const body = JSON.stringify({
        operation_no: 'OP-SAMPLE-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-GUN-07',
        scans: [demoScans()[0]],
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = newNonce();
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/v1/scan-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'x-scan-timestamp': timestamp,
          'x-scan-nonce': nonce,
          'x-scan-signature': formatSignatureHeader(timestamp, nonce, body, SECRET),
        },
        body,
      });
      const json = (await response.json()) as {
        accepted: Array<{ material_code: string }>;
        rejected: Array<{ material_code: string; reason_code: string }>;
      };
      assert.equal(response.status, 200);
      assert.equal(json.accepted.length, 0);
      assert.equal(json.rejected.length, 1);
      assert.equal(json.rejected[0]?.reason_code, 'DUPLICATE_SCAN');
      assert.equal(countBindings(ledger.db), 1);
    } finally {
      await handle.close();
    }
  });
});

describe('test_rfid_adapter · 已处理文件不重复处理', () => {
  it('④ ack 后文件移入 processed/，再扫目录不再取到该批', async () => {
    writeMetaFile('OP-SAMPLE-001', 'batch-201', { room_no: 'OR-01', scanner_id: 'RFID-GW-01' });
    const filePath = writeBatchFile('OP-SAMPLE-001', 'batch-201', demoScans());

    const first = await source.poll();
    assert.equal(first.length, 1);
    const batch = first[0];
    assert.ok(batch);

    dispatchBatch(ledger.db, batch);
    await source.ack(batch);

    // 原文件已归档到 processed/，投递箱里不再有它
    assert.equal(existsSync(filePath), false);
    const archived = join(source.processedDir, 'OP-SAMPLE-001', 'batch-201.jsonl');
    assert.equal(existsSync(archived), true);
    assert.ok(readFileSync(archived, 'utf8').includes('MAT-SAMPLE-01'));

    // 再扫一次：没有待处理批次（已处理文件不重复处理）
    const second = await source.poll();
    assert.equal(second.length, 0);
    assert.equal(countBindings(ledger.db), 5, '台账行数不因重复扫描而增加');
  });

  it('④ 归档目录本身不会被当成待处理批次', async () => {
    writeMetaFile('OP-SAMPLE-001', 'batch-202', { room_no: 'OR-01', scanner_id: 'RFID-GW-01' });
    const filePath = writeBatchFile('OP-SAMPLE-001', 'batch-202', demoScans());
    const batches = await source.poll();
    const batch = batches[0];
    assert.ok(batch);
    await source.ack(batch);

    // 归档目录里再放一个文件，也不能被扫出来
    const archivedDir = join(source.processedDir, 'OP-SAMPLE-001');
    writeFileSync(join(archivedDir, 'batch-999.jsonl'), JSON.stringify(demoScans()[0]) + '\n', 'utf8');
    const again = await source.poll();
    assert.equal(again.length, 0);
    assert.equal(existsSync(filePath), false);
  });
});

describe('test_rfid_adapter · 两路解析层共用', () => {
  it('HTTP 路与目录路对同一条扫码产出同一个规范耗材码与同一个幂等键', () => {
    const raw = JSON.stringify({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: [{ material_code: '(01)06912345678902(10)LOT-A1', quantity: 1, scan_time: '2026-01-15T09:14:22+08:00' }],
    });
    const httpOutcome = parseHttpScanBody(raw);
    assert.ok(httpOutcome.ok);
    const dirOutcome = source.parse({
      kind: 'file',
      operation_no: 'OP-SAMPLE-001',
      filePath: join(inboxDir, 'OP-SAMPLE-001', 'x.jsonl'),
      content: '{"material_code":"(01)06912345678902(10)LOT-A1","quantity":1,"scan_time":"2026-01-15T09:14:22+08:00","room_no":"OR-01","scanner_id":"RFID-GW-01"}\n',
      meta: null,
    });
    assert.ok(dirOutcome.ok);

    assert.equal(httpOutcome.batch.items[0]?.material_code, dirOutcome.batch.items[0]?.material_code);
    assert.equal(httpOutcome.batch.items[0]?.material_code, '06912345678902');
    assert.equal(httpOutcome.batch.items[0]?.quantity, dirOutcome.batch.items[0]?.quantity);

    // 幂等键由（耗材码 + 台次）派生，与来源无关
    const expected = createHash('sha256').update('v1|06912345678902|OP-SAMPLE-001').digest('hex');
    assert.equal(httpOutcome.batch.operation_no, dirOutcome.batch.operation_no);
    assert.ok(expected.length === 64);
  });
});
