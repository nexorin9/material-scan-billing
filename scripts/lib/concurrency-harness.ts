/**
 * 并发压测与朴素基线对照的可复用内核。
 *
 * 三个场景 —— 同一个产品、同一个出站客户端、同一个计费替身，
 * **只差「有没有幂等占位层」这一件事**：
 *
 *   ① `runIdempotentConcurrency` —— **幂等版（产品主路径）**
 *      并发投递 N 次**同一条**耗材扫码（扫码时间 / 扫码枪 / 批号各不相同，
 *      幂等键与这三者无关），走产品真实链路：
 *        扫码枪 HTTP 投递 → 验签 → 码制归一 → 幂等占位 → 绑定判定 → 台账落行
 *      随后走产品真实回写链路（关台回写 `writeBackOperationCharges`）回写 HIS 计费。
 *      期望：台账 1 行、计费 1 次、对端收到 0 条重复计费。
 *
 *   ② `runLeaseContention` —— **租约争用**
 *      先占位不确认（模拟持有者卡住 / 进程崩溃前那一瞬），再并发投递 N 次：
 *      全部拿到 busy（**不重复处理、不重复计费**）；租约到期后其中一个接管并完成结算，
 *      结算次数仍然只有 1 次，台账仍然只有 1 行。
 *
 *   ③ `runNaiveConcurrency` —— **朴素基线（无幂等层）**
 *      不派生幂等键、不占位，「查不到就写」。查重与写库之间留一段**真实异步间隙**
 *      （对应真实实现里「查重 → 调下游计费 → 写台账」中间那个 await）：
 *      并发下 N 个请求全部通过查重 → N 行台账 → 对端收到 N−1 条重复计费。
 *      间隙设为 0（查重与写库在同一个同步块里）时同样跑一遍 ——
 *      用来证明重复计费**来自那个间隙**，而不是来自「没做查重」本身。
 *
 * 替身说明：出站对端是 `tests/support/fake-his-server.ts` 里的**真实 HTTP 服务**
 * （测试数据层），生产客户端与替身走同一条 `fetch` 代码路径；
 * 它**不是产品的最终对接方式**，真实对接形态见 `docs/api/his-charging.md`。
 */

import { performance } from 'node:perf_hooks';
import { createServer, type Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

import { HisChargingClient } from '../../src/charge/client.js';
import { writeBackOperationCharges } from '../../src/charge/writeback.js';
import { deriveIdempotencyKey } from '../../src/domain/idempotency.js';
import { formatSignatureHeader } from '../../src/ingest/signature.js';
import { newNonce } from '../../src/ingest/replay-guard.js';
import { startIngestServer } from '../../src/ingest/http-server.js';
import { countBindings, insertBinding } from '../../src/ledger/binding-repo.js';
import { claim, getClaim } from '../../src/ledger/claim.js';
import { openLedger } from '../../src/ledger/db.js';
import { importMasterData } from '../../src/ledger/import-master-data.js';
import type { Logger } from '../../src/log/logger.js';
import { startFakeHisServer } from '../../tests/support/fake-his-server.js';
import { dropIdempotencyDefenses, naiveRowKey } from './naive-baseline.js';

/* ── 静默日志器：压测不刷屏（结构化日志在别处验证） ── */

const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quietLogger,
  level: 'error',
};

/* ── 主数据夹具 ── */

export interface BenchmarkFixture {
  operation_no: string;
  room_no: string;
  dept_code: string;
  material_code: string;
  scanner_id: string;
}

export const DEFAULT_FIXTURE: BenchmarkFixture = {
  operation_no: 'OP-CONC-001',
  room_no: 'OR-CONC-01',
  dept_code: 'SURG-CONC',
  material_code: 'MAT-CONC-01',
  scanner_id: 'SCAN-CONC-01',
};

/** 压测用的院内主数据夹具（台次 + 耗材，字段与 import-master-data 的 CSV 口径一致） */
export function benchmarkMasterDataCsv(fixture: BenchmarkFixture): {
  operationsCsv: string;
  materialsCsv: string;
} {
  const operationsCsv = [
    'operation_no,room_no,dept_code,status,closed_at',
    `${fixture.operation_no},${fixture.room_no},${fixture.dept_code},open,`,
    '',
  ].join('\n');
  const materialsCsv = [
    'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio',
    `${fixture.material_code},压测样例高值耗材,PR-CONC-01,卫生材料,甲类,true,LOT-CONC-01,包,支,支,1`,
    '',
  ].join('\n');
  return { operationsCsv, materialsCsv };
}

/* ── 扫码事件投递 ── */

export interface ScanEventBody {
  operation_no: string;
  room_no: string;
  scanner_id: string;
  scans: Array<{
    material_code: string;
    quantity: number;
    scan_time: string;
    batch_no: string;
  }>;
}

export interface DeliveryResponse {
  status: number;
  accepted: Array<{
    material_code: string;
    operation_no: string;
    bound: boolean;
    conclusion: string;
    charge_state: string;
  }>;
  rejected: Array<{ material_code: string; reason_code: string }>;
}

/** 构造一条扫码事件体：只有扫码时间 / 扫码枪 / 批号在变，耗材与台次不变 */
export function buildScanBody(fixture: BenchmarkFixture, index: number): ScanEventBody {
  const base = Date.parse('2026-01-20T08:00:00+08:00');
  return {
    operation_no: fixture.operation_no,
    room_no: fixture.room_no,
    scanner_id: `${fixture.scanner_id}-${index % 4}`,
    scans: [
      {
        material_code: fixture.material_code,
        quantity: 1,
        scan_time: new Date(base + index * 1000).toISOString(),
        batch_no: `LOT-CONC-${index}`,
      },
    ],
  };
}

async function postScanEvent(
  baseUrl: string,
  body: ScanEventBody,
  token: string,
  secret: string,
): Promise<DeliveryResponse> {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = newNonce();
  const signature = formatSignatureHeader(timestamp, nonce, rawBody, secret);
  const response = await fetch(`${baseUrl}/api/v1/scan-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-scan-timestamp': timestamp,
      'x-scan-nonce': nonce,
      'x-scan-signature': signature,
    },
    body: rawBody,
  });
  const text = await response.text();
  let parsed: { accepted?: DeliveryResponse['accepted']; rejected?: DeliveryResponse['rejected'] } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    parsed = {};
  }
  return {
    status: response.status,
    accepted: parsed.accepted ?? [],
    rejected: parsed.rejected ?? [],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── 逐条结论归类 ── */

export const REASON_CLAIM_BUSY = 'CLAIM_BUSY';
export const REASON_DUPLICATE_SCAN = 'DUPLICATE_SCAN';
/** 批号差异原因码：同码同台次重复、但批号与已入台账那笔不同（v1 档位仍判重复） */
export const REASON_DUPLICATE_BATCH_MISMATCH = 'DUPLICATE_SCAN_BATCH_MISMATCH';

export interface ResponseTally {
  http_ok: number;
  http_errors: number;
  bound_responses: number;
  busy_count: number;
  duplicate_count: number;
  other_rejected_count: number;
}

function tallyResponses(responses: readonly DeliveryResponse[]): ResponseTally {
  const tally: ResponseTally = {
    http_ok: 0,
    http_errors: 0,
    bound_responses: 0,
    busy_count: 0,
    duplicate_count: 0,
    other_rejected_count: 0,
  };
  for (const response of responses) {
    if (response.status !== 200) {
      tally.http_errors += 1;
      continue;
    }
    tally.http_ok += 1;
    tally.bound_responses += response.accepted.filter((item) => item.bound).length;
    for (const rejected of response.rejected) {
      if (rejected.reason_code === REASON_CLAIM_BUSY) tally.busy_count += 1;
      else if (
        rejected.reason_code === REASON_DUPLICATE_SCAN ||
        rejected.reason_code === REASON_DUPLICATE_BATCH_MISMATCH
      ) {
        // 重复扫码（含批号差异那一类）——两种都是「不产生第二行台账、不重复计费」
        tally.duplicate_count += 1;
      } else tally.other_rejected_count += 1;
    }
  }
  return tally;
}

/* ── 场景 ①：幂等版并发压测 ── */

export interface ConcurrencyOptions {
  /** 并发投递次数（默认 200） */
  concurrency?: number;
  /** 主数据夹具 */
  fixture?: Partial<BenchmarkFixture>;
  /** 入站 Bearer 令牌（压测用本地值，不连真实系统） */
  token?: string;
  /** 入站签名密钥（压测用本地值） */
  secret?: string;
  /** 出站计费令牌（压测用本地值） */
  chargeToken?: string;
  /** 出站计费端点路径 */
  chargePath?: string;
}

export interface ConcurrencyMetrics extends ResponseTally {
  concurrency: number;
  ledger_rows: number;
  charge_calls: number;
  charged_entries: number;
  peer_requests: number;
  peer_entries: number;
  peer_duplicate_charges: number;
  elapsed_ms: number;
}

export interface ConcurrencyRunResult {
  metrics: ConcurrencyMetrics;
  fixture: BenchmarkFixture;
  idempotency_key: string;
}

function resolveFixture(options: ConcurrencyOptions): BenchmarkFixture {
  return { ...DEFAULT_FIXTURE, ...(options.fixture ?? {}) };
}

/**
 * 幂等版并发压测：N 次并发投递同一条耗材扫码。
 *
 * 走的是**产品主路径**（扫码枪 HTTP → 验签 → 归一 → 幂等占位 → 判定 → 台账）
 * 加上**产品回写路径**（关台回写 → 出站 HTTP 客户端 → 逐条回执）。
 */
export async function runIdempotentConcurrency(
  options: ConcurrencyOptions = {},
): Promise<ConcurrencyRunResult> {
  const concurrency = options.concurrency ?? 200;
  const fixture = resolveFixture(options);
  const token = options.token ?? 'concurrency-token-local';
  const secret = options.secret ?? 'concurrency-secret-local';
  const chargeToken = options.chargeToken ?? 'concurrency-his-token-local';
  const chargePath = options.chargePath ?? '/api/v1/material-uses';

  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, benchmarkMasterDataCsv(fixture));

  const peer = await startFakeHisServer();
  const handle = await startIngestServer({ db: ledger.db, token, secret, logger: quietLogger });

  const startedAt = performance.now();
  const responses = await Promise.all(
    Array.from({ length: concurrency }, (_unused, index) =>
      postScanEvent(`http://127.0.0.1:${handle.port}`, buildScanBody(fixture, index), token, secret),
    ),
  );
  const elapsed = performance.now() - startedAt;
  await handle.close();

  // 关台回写（产品主路径）：台账里已绑定的条目一次性回写 HIS 计费
  const client = new HisChargingClient({
    baseUrl: peer.baseUrl,
    token: chargeToken,
    logger: () => {
      // 压测不打印出站日志
    },
  });
  const writeback = await writeBackOperationCharges(ledger.db, fixture.operation_no, {
    client,
    path: chargePath,
    dept_code: fixture.dept_code,
    logger: quietLogger,
  });

  const peerRequests = peer.requests.length;
  const peerEntries = peer.entries.length;
  const peerDuplicates = peer.duplicateChargeCount;
  await peer.close();

  const metrics: ConcurrencyMetrics = {
    ...tallyResponses(responses),
    concurrency,
    ledger_rows: countBindings(ledger.db),
    charge_calls: writeback.calls,
    charged_entries: writeback.submitted,
    peer_requests: peerRequests,
    peer_entries: peerEntries,
    peer_duplicate_charges: peerDuplicates,
    elapsed_ms: Math.round(elapsed * 100) / 100,
  };

  ledger.close();
  return {
    metrics,
    fixture,
    idempotency_key: deriveIdempotencyKey(fixture.material_code, fixture.operation_no),
  };
}

/* ── 场景 ②：租约争用 ── */

export interface LeaseContentionOptions extends ConcurrencyOptions {
  /** 争用窗口内的并发投递次数（默认 20） */
  contention?: number;
  /** 租约时长（毫秒，默认 2000）：必须覆盖整个争用窗口 */
  leaseMs?: number;
}

export interface LeaseContentionMetrics {
  lease_ms: number;
  contention_requests: number;
  busy_count: number;
  other_rejected_count: number;
  bound_during_contention: number;
  ledger_rows_after_contention: number;
  charge_calls_during_contention: number;
  takeover_bound: boolean;
  takeover_reason_code: string | null;
  ledger_rows_after_takeover: number;
  charge_calls_after_takeover: number;
  charged_entries_after_takeover: number;
  peer_duplicate_charges: number;
  claim_count: number;
  elapsed_ms: number;
}

export interface LeaseContentionResult {
  metrics: LeaseContentionMetrics;
  fixture: BenchmarkFixture;
  idempotency_key: string;
}

/**
 * 租约争用：持有者卡住（占位不确认）时，后来者怎么办。
 *
 * 期望：
 *   ① 争用窗口内的并发投递**全部**拿到 busy —— 不重复处理、不重复计费；
 *   ② 租约到期后其中一个接管并完成结算 —— 台账 1 行、计费 1 次；
 *   ③ 接管时 claim_count 递增（看得出被重试过几次），但台账仍只有一行。
 */
export async function runLeaseContention(
  options: LeaseContentionOptions = {},
): Promise<LeaseContentionResult> {
  const contention = options.contention ?? 20;
  const leaseMs = options.leaseMs ?? 2_000;
  const fixture = resolveFixture(options);
  const token = options.token ?? 'concurrency-token-local';
  const secret = options.secret ?? 'concurrency-secret-local';
  const chargeToken = options.chargeToken ?? 'concurrency-his-token-local';
  const chargePath = options.chargePath ?? '/api/v1/material-uses';
  const key = deriveIdempotencyKey(fixture.material_code, fixture.operation_no);

  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, benchmarkMasterDataCsv(fixture));

  const peer = await startFakeHisServer();
  const handle = await startIngestServer({ db: ledger.db, token, secret, logger: quietLogger });

  const startedAt = performance.now();

  // ① 持有者占位后卡住（不确认）
  const lease = claim(ledger.db, key, {
    operation_no: fixture.operation_no,
    material_code: fixture.material_code,
    scanner_id: fixture.scanner_id,
    leaseMs,
  });

  // ② 争用窗口：并发投递 N 次 —— 全部应拿到 busy
  const contentionResponses = await Promise.all(
    Array.from({ length: contention }, (_unused, index) =>
      postScanEvent(`http://127.0.0.1:${handle.port}`, buildScanBody(fixture, index), token, secret),
    ),
  );
  const contentionTally = tallyResponses(contentionResponses);

  // ③ 等租约到期后接管
  const waited = performance.now() - startedAt;
  if (waited < leaseMs) await sleep(leaseMs - waited + 50);
  const takeoverResponse = await postScanEvent(
    `http://127.0.0.1:${handle.port}`,
    buildScanBody(fixture, contention),
    token,
    secret,
  );
  const elapsed = performance.now() - startedAt;
  await handle.close();

  // ④ 关台回写：接管者落台账 → 计费一次
  const client = new HisChargingClient({
    baseUrl: peer.baseUrl,
    token: chargeToken,
    logger: () => {
      // 压测不打印出站日志
    },
  });
  const writeback = await writeBackOperationCharges(ledger.db, fixture.operation_no, {
    client,
    path: chargePath,
    dept_code: fixture.dept_code,
    logger: quietLogger,
  });

  const peerDuplicates = peer.duplicateChargeCount;
  await peer.close();

  const takeoverAccepted = takeoverResponse.accepted.find((item) => item.bound);
  const metrics: LeaseContentionMetrics = {
    lease_ms: leaseMs,
    contention_requests: contention,
    busy_count: contentionTally.busy_count,
    other_rejected_count: contentionTally.other_rejected_count,
    bound_during_contention: contentionTally.bound_responses,
    ledger_rows_after_contention: 0,
    charge_calls_during_contention: 0,
    takeover_bound: takeoverAccepted !== undefined,
    takeover_reason_code: takeoverResponse.rejected[0]?.reason_code ?? null,
    ledger_rows_after_takeover: countBindings(ledger.db),
    charge_calls_after_takeover: writeback.calls,
    charged_entries_after_takeover: writeback.submitted,
    peer_duplicate_charges: peerDuplicates,
    claim_count: getClaim(ledger.db, key)?.claim_count ?? 0,
    elapsed_ms: Math.round(elapsed * 100) / 100,
  };

  ledger.close();
  return { metrics, fixture, idempotency_key: key };
}

/* ── 场景 ③：朴素基线（无幂等层） ── */

export interface NaiveConcurrencyOptions extends ConcurrencyOptions {
  /**
   * 查重与写库之间的异步间隙（毫秒）。
   *
   * 默认 30：对应真实实现里「查重 → 调下游计费 → 写台账」中间那个 await。
   * 传 0 表示查重与写库在**同一个同步块**里（没有间隙）——
   * 用来证明重复计费来自那个间隙，而不是来自「没做查重」本身。
   */
  gapMs?: number;
}

export interface NaiveConcurrencyMetrics extends ResponseTally {
  concurrency: number;
  gap_ms: number;
  ledger_rows: number;
  duplicate_ledger_rows: number;
  charge_calls: number;
  charged_entries: number;
  peer_requests: number;
  peer_entries: number;
  peer_duplicate_charges: number;
  elapsed_ms: number;
}

export interface NaiveConcurrencyResult {
  metrics: NaiveConcurrencyMetrics;
  fixture: BenchmarkFixture;
}

/** 朴素实现里那把「查重」的 SELECT：不认键档位，只看（耗材码 + 台次）有没有行 */
function naiveFindExisting(db: DatabaseSync, material_code: string, operation_no: string): boolean {
  const row = db
    .prepare('SELECT id FROM material_binding WHERE material_code = ? AND operation_no = ?')
    .get(material_code, operation_no) as { id: number } | undefined;
  return row !== undefined;
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 朴素入站服务（**参照实现，不是产品代码**）。
 *
 * 与产品入站的差别只有一处：**没有幂等占位层**。
 * 「查不到就写」，写台账时不带幂等键约束（键档位标 naive，绕开 v1 的唯一索引）。
 */
function startNaiveServer(deps: {
  db: DatabaseSync;
  fixture: BenchmarkFixture;
  gapMs: number;
}): Promise<{ port: number; close: () => Promise<void> }> {

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const text = await readBody(req);
        const body = JSON.parse(text) as ScanEventBody;
        const accepted: DeliveryResponse['accepted'] = [];
        const rejected: DeliveryResponse['rejected'] = [];

        for (const scan of body.scans ?? []) {
          // ① 查重（无锁、无占位）
          if (naiveFindExisting(deps.db, scan.material_code, body.operation_no)) {
            rejected.push({ material_code: scan.material_code, reason_code: REASON_DUPLICATE_SCAN });
            continue;
          }
          // ② 真实异步间隙：真实实现里这一步是「调下游计费」，是个 await
          if (deps.gapMs > 0) await sleep(deps.gapMs);
          // ③ 写台账（不带幂等键约束）
          //    键用**同一把尺子**（v1：耗材码 + 台次）—— 派生口径不是幂等层，
          //    差的是没人拿它去重：同一把键写进两行、对端收到两笔计费。
              const material = deps.db
            .prepare('SELECT price_code, fee_category, medical_insurance_class FROM material WHERE material_code = ?')
            .get(scan.material_code) as
            | { price_code: string; fee_category: string; medical_insurance_class: string }
            | undefined;
          const naiveKey = naiveRowKey(scan.material_code, body.operation_no);
          insertBinding(deps.db, {
            idempotency_key: naiveKey.idempotency_key,
            key_profile: naiveKey.key_profile,
            operation_no: body.operation_no,
            room_no: body.room_no,
            dept_code: deps.fixture.dept_code,
            material_code: scan.material_code,
            quantity: scan.quantity,
            price_code: material?.price_code ?? null,
            fee_category: material?.fee_category ?? null,
            medical_insurance_class: material?.medical_insurance_class ?? null,
            conclusion: 'BOUND',
            status: 'bound',
            raw_code: scan.material_code,
          });
          accepted.push({
            material_code: scan.material_code,
            operation_no: body.operation_no,
            bound: true,
            conclusion: 'BOUND',
            charge_state: 'not_submitted',
          });
        }

        const payload = JSON.stringify({ accepted, rejected });
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
        });
        res.end(payload);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'ERR_BAD_REQUEST' } }));
      }
    })();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * 朴素基线并发压测：同一批并发投递，只少一层幂等。
 *
 * 计费走**与幂等版完全相同**的关台回写路径（`writeBackOperationCharges`），
 * 所以两者的差只来自台账里落了几行 —— 也就是幂等层省下了多少重复计费。
 */
export async function runNaiveConcurrency(
  options: NaiveConcurrencyOptions = {},
): Promise<NaiveConcurrencyResult> {
  const concurrency = options.concurrency ?? 200;
  const gapMs = options.gapMs ?? 30;
  const fixture = resolveFixture(options);
  const chargeToken = options.chargeToken ?? 'concurrency-his-token-local';
  const chargePath = options.chargePath ?? '/api/v1/material-uses';

  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, benchmarkMasterDataCsv(fixture));
  // 朴素实现的台账**没有幂等层的第二道防线**（三张唯一索引）：
  // 同一把键能写进第二行 —— 这正是幂等层要挡掉的场景。
  dropIdempotencyDefenses(ledger.db);

  const peer = await startFakeHisServer();
  const handle = await startNaiveServer({ db: ledger.db, fixture, gapMs });

  const startedAt = performance.now();
  const responses = await Promise.all(
    Array.from({ length: concurrency }, (_unused, index) =>
      postScanEvent(
        `http://127.0.0.1:${handle.port}`,
        buildScanBody(fixture, index),
        options.token ?? 'concurrency-token-local',
        options.secret ?? 'concurrency-secret-local',
      ),
    ),
  );
  const elapsed = performance.now() - startedAt;
  await handle.close();

  const client = new HisChargingClient({
    baseUrl: peer.baseUrl,
    token: chargeToken,
    logger: () => {
      // 压测不打印出站日志
    },
  });
  const writeback = await writeBackOperationCharges(ledger.db, fixture.operation_no, {
    client,
    path: chargePath,
    dept_code: fixture.dept_code,
    logger: quietLogger,
  });

  const ledgerRows = countBindings(ledger.db);
  const distinct = ledger.db
    .prepare(
      `SELECT COUNT(DISTINCT material_code || '::' || operation_no) AS n FROM material_binding`,
    )
    .get() as { n: number };

  const peerRequests = peer.requests.length;
  const peerEntries = peer.entries.length;
  const peerDuplicates = peer.duplicateChargeCount;
  await peer.close();

  const metrics: NaiveConcurrencyMetrics = {
    ...tallyResponses(responses),
    concurrency,
    gap_ms: gapMs,
    ledger_rows: ledgerRows,
    duplicate_ledger_rows: ledgerRows - Number(distinct.n),
    charge_calls: writeback.calls,
    charged_entries: writeback.submitted,
    peer_requests: peerRequests,
    peer_entries: peerEntries,
    peer_duplicate_charges: peerDuplicates,
    elapsed_ms: Math.round(elapsed * 100) / 100,
  };

  ledger.close();
  return { metrics, fixture };
}
