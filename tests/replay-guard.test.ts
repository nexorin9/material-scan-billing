/**
 * test_replay_guard：入站重放防护（时间戳窗口 + nonce + 幂等键三层）。
 *
 * 覆盖：
 *   ① 时间戳超窗 → 401 ERR_STALE_TIMESTAMP，台账无新增，审计留行；
 *   ② 签名不符 → 401 ERR_INVALID_SIGNATURE（与「过期」分开，原因码可查）；
 *   ③ 缺 nonce → 401 ERR_MISSING_NONCE，台账无新增，审计留行；
 *   ④ 同一 nonce 二次投递 → 401 ERR_REPLAY_NONCE_REPLAY，台账无新增，审计留行；
 *   ⑤ 改时间戳重算签名（nonce 不变）→ 仍被 nonce 层拦下；
 *   ⑥ 换 nonce 改戳 → 窗口内可入，但幂等键拦下：台账不新增第二行，结论 DUPLICATE_SCAN；
 *   ⑦ nonce 记录有 TTL：过期后清理，计数归零，doctor 里看得见清理前后的数；
 *   ⑧ 并发同 nonce 20 次 → 只有 1 次放行，其余按重放拒。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { countAuditByType, queryAuditByType } from '../src/ledger/audit.js';
import { startIngestServer, type IngestServerHandle } from '../src/ingest/http-server.js';
import { checkSignature, formatSignatureHeader } from '../src/ingest/signature.js';
import {
  claimNonce,
  cleanupExpiredNonces,
  countExpiredNonces,
  countNonces,
  DEFAULT_NONCE_TTL_SEC,
  ERR_REPLAY_NONCE_REPLAY,
  isValidNonce,
  newNonce,
} from '../src/ingest/replay-guard.js';
import { runDoctor } from '../src/cli/commands.js';
import { resetAuditChain } from './support/audit-reset.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const TOKEN = 'test-scanner-token';
const SECRET = 'test-scanner-secret';

/** 一批 2 条能绑上的耗材 */
function demoBatch() {
  return {
    operation_no: 'OP-SAMPLE-001',
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    scans: [
      { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00+08:00', batch_no: 'LOT-SAMPLE-A' },
      { material_code: 'MAT-SAMPLE-02', quantity: 2, scan_time: '2026-01-15T09:13:10+08:00', batch_no: 'LOT-SAMPLE-B' },
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
  handle = await startIngestServer({ db: ledger.db, token: TOKEN, secret: SECRET });
});

after(async () => {
  await handle.close();
  ledger.close();
});

beforeEach(() => {
  // 每条用例独立：清掉台账、核查条目、幂等占位、审计链与 nonce 记录
  // （幂等占位必须一起清：不清的话后面用例的同码同台次会被当成重复投递）
  ledger.db.exec('DELETE FROM material_binding');
  ledger.db.exec('DELETE FROM charge_receipt');
  ledger.db.exec('DELETE FROM check_task');
  ledger.db.exec('DELETE FROM idempotency_claim');
  ledger.db.exec('DELETE FROM replay_nonce');
  ledger.db.exec('DELETE FROM scan_event');
  resetAuditChain(ledger.db);
});

interface PostOptions {
  body?: unknown;
  timestamp?: string;
  nonce?: string;
  /** 覆盖请求头里的 nonce（默认与签名用同一个） */
  headerNonce?: string;
  omitNonce?: boolean;
  signature?: string;
  secret?: string;
}

async function postBatch(options: PostOptions = {}): Promise<{ status: number; json: BatchResponse | null; text: string }> {
  const rawBody = JSON.stringify(options.body ?? demoBatch());
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? newNonce();
  const secret = options.secret ?? SECRET;
  const signature = options.signature ?? formatSignatureHeader(timestamp, nonce, rawBody, secret);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${TOKEN}`,
    'x-scan-timestamp': timestamp,
    'x-scan-signature': signature,
  };
  if (!options.omitNonce) {
    headers['x-scan-nonce'] = options.headerNonce ?? nonce;
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

describe('test_replay_guard · 入站重放防护（时间戳窗口 + nonce + 幂等键）', () => {
  it('① 过期时间戳 → 401 ERR_STALE_TIMESTAMP，台账无新增且审计留行', async () => {
    const before = countBindings(ledger.db);
    const stale = String(Math.floor(Date.now() / 1000) - 4000);
    const response = await postBatch({ timestamp: stale });

    assert.equal(response.status, 401);
    assert.match(response.text, /ERR_STALE_TIMESTAMP/);
    // 拒绝不落台账（台账行数不变）
    assert.equal(countBindings(ledger.db), before);
    // 拒绝要留痕：审计链有一行 inbound_rejected，明细里带原因码
    const rows = queryAuditByType(ledger.db, 'inbound_rejected');
    assert.ok(rows.length >= 1, '拒绝路径没有写审计');
    assert.match(String(rows[rows.length - 1]?.detail), /ERR_STALE_TIMESTAMP/);
  });

  it('② 签名不符 → 401 ERR_INVALID_SIGNATURE（与「过期」分得开）', async () => {
    const before = countBindings(ledger.db);
    const rawBody = JSON.stringify(demoBatch());
    const timestamp = String(Math.floor(Date.now() / 1000));
    // 用别的密钥算的签名
    const response = await postBatch({
      timestamp,
      nonce: newNonce(),
      signature: formatSignatureHeader(timestamp, newNonce(), rawBody, 'wrong-secret'),
    });

    assert.equal(response.status, 401);
    assert.match(response.text, /ERR_INVALID_SIGNATURE/);
    assert.equal(countBindings(ledger.db), before);
  });

  it('③ 缺 nonce → 401 ERR_MISSING_NONCE，台账无新增且审计留行', async () => {
    const before = countBindings(ledger.db);
    const rawBody = JSON.stringify(demoBatch());
    const timestamp = String(Math.floor(Date.now() / 1000));
    // 签名照算（nonce 参与签名内容），但请求头不带 nonce
    const response = await postBatch({
      timestamp,
      omitNonce: true,
      signature: formatSignatureHeader(timestamp, 'nonce-not-sent', rawBody, SECRET),
    });

    assert.equal(response.status, 401);
    assert.match(response.text, /ERR_MISSING_NONCE/);
    assert.equal(countBindings(ledger.db), before);
    const rows = queryAuditByType(ledger.db, 'inbound_rejected');
    assert.match(String(rows[rows.length - 1]?.detail), /ERR_MISSING_NONCE/);
  });

  it('④ 同一 nonce 二次投递 → 401 ERR_REPLAY_NONCE_REPLAY，台账无新增且审计留行', async () => {
    const nonce = newNonce();
    const first = await postBatch({ nonce });
    assert.equal(first.status, 200);
    const rowsAfterFirst = countBindings(ledger.db);
    assert.equal(rowsAfterFirst, 2);

    const second = await postBatch({ nonce });
    assert.equal(second.status, 401);
    assert.match(second.text, new RegExp(ERR_REPLAY_NONCE_REPLAY));
    // 重放不产生第二行台账
    assert.equal(countBindings(ledger.db), rowsAfterFirst);

    const replayRows = queryAuditByType(ledger.db, 'inbound_replay_rejected');
    assert.equal(replayRows.length, 1);
    assert.match(String(replayRows[0]?.detail), new RegExp(ERR_REPLAY_NONCE_REPLAY));
    assert.ok(replayRows[0]?.request_id, '重放审计行应带请求标识');
  });

  it('⑤ 改时间戳重算签名（nonce 不变）→ 仍被 nonce 层拦下', async () => {
    const nonce = newNonce();
    const rawBody = JSON.stringify(demoBatch());
    const first = await postBatch({ nonce });
    assert.equal(first.status, 200);
    const rowsAfterFirst = countBindings(ledger.db);

    // 换一个「新鲜」时间戳重算签名 —— nonce 还是原来那个
    const newTimestamp = String(Math.floor(Date.now() / 1000));
    const replay = await postBatch({
      timestamp: newTimestamp,
      nonce,
      signature: formatSignatureHeader(newTimestamp, nonce, rawBody, SECRET),
    });

    assert.equal(replay.status, 401);
    assert.match(replay.text, new RegExp(ERR_REPLAY_NONCE_REPLAY));
    assert.equal(countBindings(ledger.db), rowsAfterFirst);
  });

  it('⑥ 换 nonce 改戳 → 窗口内可入，但幂等键拦下（不产生第二行台账）', async () => {
    const rawBody = JSON.stringify(demoBatch());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const first = await postBatch({ nonce: newNonce(), timestamp });
    assert.equal(first.status, 200);
    assert.equal(first.json?.accepted.length, 2);
    const rowsAfterFirst = countBindings(ledger.db);
    assert.equal(rowsAfterFirst, 2);

    // 换 nonce、换时间戳、重算签名 —— 前两层都过得了，第三层（幂等键）拦住
    const newTimestamp = String(Math.floor(Date.now() / 1000));
    const newNonceValue = newNonce();
    const second = await postBatch({
      timestamp: newTimestamp,
      nonce: newNonceValue,
      signature: formatSignatureHeader(newTimestamp, newNonceValue, rawBody, SECRET),
    });

    assert.equal(second.status, 200);
    assert.equal(second.json?.accepted.length, 0);
    assert.equal(second.json?.rejected.length, 2);
    for (const rejected of second.json?.rejected ?? []) {
      assert.equal(rejected.reason_code, 'DUPLICATE_SCAN');
    }
    // 台账仍然只有 2 行：三层里最后一层兜住了
    assert.equal(countBindings(ledger.db), rowsAfterFirst);
  });

  it('⑦ nonce 记录有 TTL：过期后清理，计数归零，doctor 里看得见', async () => {
    const nonce = newNonce();
    const response = await postBatch({ nonce });
    assert.equal(response.status, 200);
    assert.equal(countNonces(ledger.db), 1);

    // 还没到期：清理不动它
    assert.equal(cleanupExpiredNonces(ledger.db, Date.now()), 0);
    assert.equal(countNonces(ledger.db), 1);

    // 过了 TTL：清掉
    const afterTtl = Date.now() + (DEFAULT_NONCE_TTL_SEC + 60) * 1000;
    assert.equal(countExpiredNonces(ledger.db, afterTtl), 1);
    assert.equal(cleanupExpiredNonces(ledger.db, afterTtl), 1);
    assert.equal(countNonces(ledger.db), 0);

    // doctor 看得见：nonce 条数、过期条数、窗口与有效期
    const report = runDoctor(ledger.db, process.env, { ledger_db_path: ':memory:' });
    assert.equal(report.replay_guard.nonce_rows, 0);
    assert.equal(report.replay_guard.nonce_expired_rows, 0);
    assert.equal(report.replay_guard.timestamp_tolerance_sec, 300);
    assert.equal(report.replay_guard.nonce_ttl_sec, 600);
  });

  it('⑦-2 doctor 能看到被挡下的重放次数与入站拒绝次数', async () => {
    // 一条签名不符（入站拒绝）+ 一条 nonce 重放（重放拒绝）
    await postBatch({ nonce: newNonce(), signature: 'v1=deadbeef' });
    const nonce = newNonce();
    await postBatch({ nonce });
    await postBatch({ nonce });

    const report = runDoctor(ledger.db, process.env, { ledger_db_path: ':memory:' });
    assert.equal(report.replay_guard.replay_rejections, 1);
    assert.ok(report.replay_guard.inbound_rejections >= 1);
    assert.equal(report.replay_guard.nonce_rows, 1);
    assert.ok(report.replay_guard.last_nonce_expires_at);
  });

  it('⑧ 并发同 nonce 20 次 → 只有 1 次放行，其余按重放拒', async () => {
    const nonce = newNonce();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => postBatch({ nonce })),
    );
    const ok = responses.filter((response) => response.status === 200);
    const rejected = responses.filter((response) => response.status === 401);

    assert.equal(ok.length, 1);
    assert.equal(rejected.length, 19);
    for (const response of rejected) {
      assert.match(response.text, new RegExp(ERR_REPLAY_NONCE_REPLAY));
    }
    // 并发重放同样不产生第二行台账
    assert.equal(countBindings(ledger.db), 2);
  });

  it('⑨ nonce 参与签名内容：改 nonce 不重算签名 → 验签不通过', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify(demoBatch());
    const nonce = newNonce();
    const signature = formatSignatureHeader(timestamp, nonce, rawBody, SECRET);

    // 原样验签：通过
    assert.equal(checkSignature(timestamp, nonce, rawBody, SECRET, signature).ok, true);
    // 换 nonce 但不重算签名：验签不通过（nonce 确实进了签名内容）
    const swapped = checkSignature(timestamp, newNonce(), rawBody, SECRET, signature);
    assert.equal(swapped.ok, false);
    assert.equal(swapped.ok === false ? swapped.code : '', 'ERR_INVALID_SIGNATURE');
    // 换 nonce 并重算签名：通过
    const other = newNonce();
    assert.equal(
      checkSignature(timestamp, other, rawBody, SECRET, formatSignatureHeader(timestamp, other, rawBody, SECRET)).ok,
      true,
    );
  });

  it('⑩ nonce 占位：TTL 内第二次出现被拒，过期后可重新占位', () => {
    const nonce = newNonce();
    const now = Date.now();

    const first = claimNonce(ledger.db, nonce, { nowMs: now, ttlSec: 600 });
    assert.equal(first.ok, true);

    const second = claimNonce(ledger.db, nonce, { nowMs: now + 1000, ttlSec: 600 });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false ? second.code : '', ERR_REPLAY_NONCE_REPLAY);
    assert.equal(second.ok === false ? second.first_seen_at : '', first.ok ? first.first_seen_at : '');

    // TTL 到了 → 同一条 nonce 可以重新占位（新的一次投递）
    const later = now + 601 * 1000;
    const third = claimNonce(ledger.db, nonce, { nowMs: later, ttlSec: 600 });
    assert.equal(third.ok, true);
    assert.equal(countNonces(ledger.db), 1);
  });

  it('⑪ nonce 格式校验：太短 / 太长 / 非法字符一律判不合规', () => {
    assert.equal(isValidNonce(newNonce()), true);
    assert.equal(isValidNonce(undefined), false);
    assert.equal(isValidNonce(''), false);
    assert.equal(isValidNonce('short'), false);
    assert.equal(isValidNonce('a'.repeat(129)), false);
    assert.equal(isValidNonce('has space in it'), false);
    assert.equal(isValidNonce('换行\n串'), false);
  });

  it('⑫ 审计链：三类拒绝各留一行，事件类型分得开', async () => {
    // 签名不符
    await postBatch({ nonce: newNonce(), signature: 'v1=deadbeef' });
    // 缺 nonce
    const rawBody = JSON.stringify(demoBatch());
    const timestamp = String(Math.floor(Date.now() / 1000));
    await postBatch({
      timestamp,
      omitNonce: true,
      signature: formatSignatureHeader(timestamp, 'nonce-not-sent-0001', rawBody, SECRET),
    });
    // nonce 重放
    const nonce = newNonce();
    await postBatch({ nonce });
    await postBatch({ nonce });

    assert.ok(countAuditByType(ledger.db, 'inbound_rejected') >= 2);
    assert.equal(countAuditByType(ledger.db, 'inbound_replay_rejected'), 1);
  });
});
