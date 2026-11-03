/**
 * test_http_ingest：入站扫码事件端到端（验签 → 归一 → 绑定 → 台账 → 逐条回执）。
 *
 * 覆盖：
 *   ① 正确签名 → 6 条逐条结论（5 绑上 + 1 未建档），台账落 5 行；
 *   ② 错误签名 → 401 且台账行数不变；
 *   ③ 缺 Authorization / 过期时间戳 → 401 且不落台账；
 *   ④ 同批一条异常不丢其余 5 条；
 *   ⑤ 重复投递同一条 → 不产生第二行台账；
 *   ⑥ 码制归一（UDI / GS1 / 院内码 → 规范耗材码）与幂等键落库。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countBindings, findBindingByKey } from '../src/ledger/binding-repo.js';
import { startIngestServer, type IngestServerHandle } from '../src/ingest/http-server.js';
import {
  checkSignature,
  computeSignature,
  formatSignatureHeader,
  verifySignature,
} from '../src/ingest/signature.js';
import { newNonce } from '../src/ingest/replay-guard.js';
import { detectCodeForm, normalizeMaterialCode, normalizeScanItem } from '../src/ingest/normalize.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const TOKEN = 'test-scanner-token';
const SECRET = 'test-scanner-secret';

/** 一批 6 条：4 条院内码 + 1 条 UDI + 1 条 GS1 + 1 条未建档 */
function demoBatch() {
  return {
    operation_no: 'OP-SAMPLE-001',
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    scans: [
      { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00+08:00', batch_no: 'LOT-SAMPLE-A' },
      { material_code: 'MAT-SAMPLE-02', quantity: 2, scan_time: '2026-01-15T09:13:10+08:00', batch_no: 'LOT-SAMPLE-B' },
      { material_code: '(01)06912345678902(10)LOT-A1', quantity: 1, scan_time: '2026-01-15T09:14:22+08:00' },
      { material_code: '0106987654321092', quantity: 1, scan_time: '2026-01-15T09:15:40+08:00' },
      { material_code: 'MAT-SAMPLE-05', quantity: 1, scan_time: '2026-01-15T09:16:05+08:00', batch_no: 'LOT-SAMPLE-E' },
      { material_code: 'MAT-UNKNOWN-99', quantity: 1, scan_time: '2026-01-15T09:17:31+08:00' },
    ],
  };
}

interface BatchResponse {
  accepted: Array<{ material_code: string; operation_no: string; bound: boolean; conclusion: string; charge_state: string }>;
  rejected: Array<{ material_code: string; reason_code: string }>;
}

let ledger: LedgerDb;
let handle: IngestServerHandle;

before(async () => {
  ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  // 演示主数据里登记 UDI 的 DI 与 GS1 AI(01) 的 GTIN
  ledger.db
    .prepare(
      `INSERT INTO material (material_code, name, price_code, fee_category, medical_insurance_class, active, batch_no,
                              unit_pack, unit_min, charge_unit, ratio, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run('06912345678902', '药物洗脱支架（UDI 码登记）', 'PR-DEMO-UDI', '卫生材料', '甲类', 'LOT-A1', '包', '支', '支', 1, new Date().toISOString());
  ledger.db
    .prepare(
      `INSERT INTO material (material_code, name, price_code, fee_category, medical_insurance_class, active, batch_no,
                              unit_pack, unit_min, charge_unit, ratio, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run('06987654321092', '可吸收止血膜（GS1 包装码登记）', 'PR-DEMO-GS1', '卫生材料', '乙类', 'LOT-B1', '包', '片', '片', 1, new Date().toISOString());

  handle = await startIngestServer({ db: ledger.db, token: TOKEN, secret: SECRET });
});

after(async () => {
  await handle.close();
  ledger.close();
});

interface PostOptions {
  secret?: string;
  token?: string;
  timestamp?: string;
  signature?: string;
  /** 本次投递的 nonce（不给就现生成一个；重放用例要显式传同一个） */
  nonce?: string;
  omitAuthorization?: boolean;
  omitNonce?: boolean;
  body?: unknown;
}

async function postBatch(options: PostOptions = {}): Promise<{ status: number; json: BatchResponse | null; text: string }> {
  const rawBody = JSON.stringify(options.body ?? demoBatch());
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const secret = options.secret ?? SECRET;
  const nonce = options.nonce ?? newNonce();
  const signature = options.signature ?? formatSignatureHeader(timestamp, nonce, rawBody, secret);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-scan-timestamp': timestamp,
    'x-scan-signature': signature,
  };
  if (!options.omitNonce) {
    headers['x-scan-nonce'] = nonce;
  }
  if (!options.omitAuthorization) {
    headers['authorization'] = `Bearer ${options.token ?? TOKEN}`;
  }
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/v1/scan-events`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
  const text = await response.text();
  let json: BatchResponse | null = null;
  try {
    json = JSON.parse(text) as BatchResponse;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

describe('test_http_ingest · 入站验签 → 归一 → 绑定 → 逐条回执', () => {
  it('正确签名 → 6 条逐条结论，5 条绑上 + 1 条耗材码未建档', async () => {
    const before = countBindings(ledger.db);
    const response = await postBatch();

    assert.equal(response.status, 200);
    assert.ok(response.json);
    assert.equal(response.json.accepted.length + response.json.rejected.length, 6);
    assert.equal(response.json.accepted.length, 5);
    assert.equal(response.json.rejected.length, 1);

    // 一条失败不丢同批其余 5 条
    assert.deepEqual(
      response.json.accepted.map((item) => item.material_code).sort(),
      ['06912345678902', '06987654321092', 'MAT-SAMPLE-01', 'MAT-SAMPLE-02', 'MAT-SAMPLE-05'],
    );
    assert.equal(response.json.rejected[0]?.material_code, 'MAT-UNKNOWN-99');
    assert.equal(response.json.rejected[0]?.reason_code, 'MATERIAL_NOT_REGISTERED');

    // accepted 元素字段齐全
    for (const item of response.json.accepted) {
      assert.equal(item.bound, true);
      assert.equal(item.conclusion, 'BOUND');
      assert.equal(item.operation_no, 'OP-SAMPLE-001');
      assert.equal(item.charge_state, 'not_submitted');
    }

    // 台账新增 5 行（未建档那条不落台账）
    assert.equal(countBindings(ledger.db) - before, 5);
  });

  it('台账行带台次上下文、计价口径与幂等键', async () => {
    const row = ledger.db
      .prepare(
        `SELECT operation_no, room_no, dept_code, material_code, quantity, price_code,
                fee_category, medical_insurance_class, conclusion, status, idempotency_key, raw_code
         FROM material_binding WHERE material_code = ?`,
      )
      .get('MAT-SAMPLE-01') as Record<string, unknown>;

    assert.equal(row['operation_no'], 'OP-SAMPLE-001');
    assert.equal(row['room_no'], 'OR-01');
    assert.equal(row['dept_code'], 'SURG-01');
    assert.equal(row['quantity'], 1);
    assert.equal(row['price_code'], 'PR-SAMPLE-01');
    assert.equal(row['fee_category'], '卫生材料');
    assert.equal(row['medical_insurance_class'], '甲类');
    assert.equal(row['conclusion'], 'BOUND');
    assert.equal(row['status'], 'bound');

    // 幂等键 = sha256("v1|material_code|operation_no")（默认档位），与时间戳无关
    const expected = createHash('sha256').update('v1|MAT-SAMPLE-01|OP-SAMPLE-001').digest('hex');
    assert.equal(row['idempotency_key'], expected);
    assert.ok(findBindingByKey(ledger.db, expected));
  });

  it('UDI 与 GS1 码归一到规范耗材码并保留原始码', async () => {
    const row = ledger.db
      .prepare('SELECT material_code, raw_code FROM material_binding WHERE material_code = ?')
      .get('06912345678902') as { material_code: string; raw_code: string };
    assert.equal(row.material_code, '06912345678902');
    assert.equal(row.raw_code, '(01)06912345678902(10)LOT-A1');

    const gs1 = ledger.db
      .prepare('SELECT material_code, raw_code FROM material_binding WHERE material_code = ?')
      .get('06987654321092') as { material_code: string; raw_code: string };
    assert.equal(gs1.material_code, '06987654321092');
    assert.equal(gs1.raw_code, '0106987654321092');
  });

  it('错误签名 → 401 且台账行数不变', async () => {
    const before = countBindings(ledger.db);
    const response = await postBatch({ secret: 'wrong-secret' });

    assert.equal(response.status, 401);
    assert.match(response.text, /ERR_INVALID_SIGNATURE|ERR_MISSING_SIGNATURE/);
    assert.equal(countBindings(ledger.db), before);
  });

  it('缺 Authorization → 401 且台账行数不变', async () => {
    const before = countBindings(ledger.db);
    const response = await postBatch({ omitAuthorization: true });

    assert.equal(response.status, 401);
    assert.match(response.text, /ERR_BAD_AUTHORIZATION/);
    assert.equal(countBindings(ledger.db), before);
  });

  it('过期时间戳 → 401 且台账行数不变', async () => {
    const before = countBindings(ledger.db);
    const stale = String(Math.floor(Date.now() / 1000) - 4000);
    const response = await postBatch({ timestamp: stale });

    assert.equal(response.status, 401);
    assert.match(response.text, /ERR_STALE_TIMESTAMP/);
    assert.equal(countBindings(ledger.db), before);
  });

  it('空密钥 fail closed：verifySignature 直接返回 false', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify(demoBatch());
    const nonce = newNonce();
    assert.equal(
      verifySignature(timestamp, nonce, rawBody, '', computeSignature(timestamp, nonce, rawBody, SECRET)),
      false,
    );
    const check = checkSignature(timestamp, nonce, rawBody, '', 'v1=deadbeef');
    assert.equal(check.ok, false);
    assert.equal(check.ok === false ? check.code : '', 'ERR_MISSING_SIGNATURE');
  });

  it('重复投递同一条 → 不产生第二行台账', async () => {
    const before = countBindings(ledger.db);
    const batch = demoBatch();
    const single = { ...batch, scans: [batch.scans[0]] };
    const response = await postBatch({ body: single });

    assert.equal(response.status, 200);
    assert.ok(response.json);
    assert.equal(response.json.accepted.length, 0);
    assert.equal(response.json.rejected.length, 1);
    assert.equal(response.json.rejected[0]?.reason_code, 'DUPLICATE_SCAN');
    assert.equal(countBindings(ledger.db), before);
  });

  it('台次不存在 → 该条拒（其余条目照常给结论）', async () => {
    const batch = { ...demoBatch(), operation_no: 'OP-NOT-EXIST' };
    const response = await postBatch({ body: batch });

    assert.equal(response.status, 200);
    assert.ok(response.json);
    assert.equal(response.json.accepted.length, 0);
    assert.equal(response.json.rejected.length, 6);
    assert.equal(response.json.rejected[0]?.reason_code, 'OPERATION_NOT_FOUND');
  });

  it('请求体不是合法 JSON → 400 且不落台账', async () => {
    const before = countBindings(ledger.db);
    const response = await postBatch({ body: 'not-an-object' });

    assert.equal(response.status, 400);
    assert.match(response.text, /ERR_INVALID_SCAN_EVENT|ERR_MALFORMED_JSON/);
    assert.equal(countBindings(ledger.db), before);
  });
});

describe('test_http_ingest · 码制归一（纯字段映射）', () => {
  it('三种码制识别', () => {
    assert.equal(detectCodeForm('(01)06912345678902(10)LOT-A1'), 'UDI');
    assert.equal(detectCodeForm('0106987654321092'), 'GS1_AI01');
    assert.equal(detectCodeForm('MAT-SAMPLE-01'), 'INTERNAL');
  });

  it('UDI / GS1 / 院内码 → 规范耗材码', () => {
    assert.equal(normalizeMaterialCode('(01)06912345678902(10)LOT-A1').canonical_code, '06912345678902');
    assert.equal(normalizeMaterialCode('0106987654321092').canonical_code, '06987654321092');
    assert.equal(normalizeMaterialCode('MAT-SAMPLE-01').canonical_code, 'MAT-SAMPLE-01');
  });

  it('归一保留原始码、数量与扫描时间', () => {
    const normalized = normalizeScanItem({
      material_code: '(01)06912345678902(10)LOT-A1',
      quantity: 3,
      scan_time: '2026-01-15T09:12:00+08:00',
    });
    assert.equal(normalized.material_code, '06912345678902');
    assert.equal(normalized.raw_code, '(01)06912345678902(10)LOT-A1');
    assert.equal(normalized.code_form, 'UDI');
    assert.equal(normalized.quantity, 3);
    assert.equal(normalized.scan_time, '2026-01-15T01:12:00.000Z');
  });
});
