/**
 * test_logging：可观测性三件套 —— 结构化日志 / 统一错误码表 / 周期运行摘要。
 *
 * 覆盖：
 *   ① 日志每行都是可 JSON.parse 的一行 JSON，固定字段齐全（timestamp / level /
 *      request_id / channel / operation_no / material_code / conclusion /
 *      error_code / duration_ms），可按字段检索；
 *   ② 日志与异常信息里**绝不出现任何凭据明文**（键名打码 + 已登记密钥打码 +
 *      URL 打码三道防线）；
 *   ③ 统一错误码表：每码都有中文含义 / 可重投标记 / 建议处置 / 归属环节 /
 *      排查顺序，且覆盖 ≥12 个类别；
 *   ④ 错误码表落盘到 docs/api/errors.md，且与代码里的表**逐码对齐**；
 *   ⑤ 运行摘要的每个数字都与台账实际行数逐项相等（数字从 SQL 聚合，不靠内存计数）；
 *   ⑥ **错误码贯穿主路径**：同一个码在结构化日志、核查条目、计费回执行里
 *      展示的是**同一个**码；
 *   ⑦ doctor 与 summary 共用同一份摘要实现 —— 两边的数字必须一致。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { countEventLog } from '../src/ledger/event-log.js';
import { startIngestServer, type IngestServerHandle } from '../src/ingest/http-server.js';
import { formatSignatureHeader } from '../src/ingest/signature.js';
import { newNonce } from '../src/ingest/replay-guard.js';
import { HisChargingClient } from '../src/charge/client.js';
import { writeBackOperationCharges } from '../src/charge/writeback.js';
import { runDoctor, runSummary } from '../src/cli/commands.js';
import { resetAuditChain } from './support/audit-reset.js';
import {
  ERROR_CODES,
  ERROR_STAGE_LABELS,
  REASON_TO_ERROR_CODE,
  describeErrorCode,
  errorCodeForReason,
  isKnownErrorCode,
} from '../src/log/error-codes.js';
import {
  clearRegisteredSecrets,
  createLogger,
  registerSecret,
  type Logger,
} from '../src/log/logger.js';
import { collectRunSummary, formatRunSummary } from '../src/log/summary.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const SCANNER_TOKEN = 'scanner-token-plaintext-4c1d';
const SCANNER_SECRET = 'scanner-secret-plaintext-9a2b';
const HIS_TOKEN = 'his-token-plaintext-77ef';

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

/** 收集日志行 */
function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (line) => lines.push(line),
    base: { request_id: null },
  });
  return { logger, lines };
}

/** 一批 4 条扫码：3 条院内码 + 1 条未建档 */
function demoScans() {
  return [
    { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00+08:00', batch_no: 'LOT-SAMPLE-A' },
    { material_code: 'MAT-SAMPLE-02', quantity: 2, scan_time: '2026-01-15T09:13:10+08:00', batch_no: 'LOT-SAMPLE-B' },
    { material_code: 'MAT-SAMPLE-05', quantity: 1, scan_time: '2026-01-15T09:16:05+08:00', batch_no: 'LOT-SAMPLE-E' },
    { material_code: 'MAT-UNKNOWN-99', quantity: 1, scan_time: '2026-01-15T09:17:31+08:00' },
  ];
}

/** HIS 计费替身：真实 HTTP 服务；MAT-SAMPLE-01 业务拒绝，其余接收 */
class HisChargingStub {
  private readonly server: Server;
  baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed: { uses?: Array<{ material_code: string }> } = {};
        try {
          parsed = JSON.parse(body) as { uses?: Array<{ material_code: string }> };
        } catch {
          parsed = {};
        }
        const uses = parsed.uses ?? [];
        const payload = JSON.stringify({
          accepted: uses
            .filter((use) => use.material_code !== 'MAT-SAMPLE-01')
            .map((use) => ({ material_code: use.material_code })),
          rejected: uses
            .filter((use) => use.material_code === 'MAT-SAMPLE-01')
            .map((use) => ({ material_code: use.material_code, reason_code: 'PRICE_CODE_NOT_FOUND' })),
        });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(payload);
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
}

let workDir: string;
let ledger: LedgerDb;
let ingest: IngestServerHandle;
let hisStub: HisChargingStub;
let logLines: string[];
let logger: Logger;

async function postBatch(body: unknown, secret = SCANNER_SECRET): Promise<number> {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = newNonce();
  const signature = formatSignatureHeader(timestamp, nonce, rawBody, secret);
  const response = await fetch(`http://127.0.0.1:${ingest.port}/api/v1/scan-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SCANNER_TOKEN}`,
      'x-scan-timestamp': timestamp,
      'x-scan-nonce': nonce,
      'x-scan-signature': signature,
    },
    body: rawBody,
  });
  await response.text();
  return response.status;
}

/** 解析收集到的日志行 */
function parsedLogs(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'msb-logging-'));
  ledger = openLedger(resolve(workDir, 'ledger.db'));
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  const collector = collectingLogger();
  logger = collector.logger;
  logLines = collector.lines;
  ingest = await startIngestServer({
    db: ledger.db,
    token: SCANNER_TOKEN,
    secret: SCANNER_SECRET,
    logger,
  });
  hisStub = new HisChargingStub();
  await hisStub.start();
  // 把三路凭据位登记进日志打码名单
  registerSecret(SCANNER_TOKEN);
  registerSecret(SCANNER_SECRET);
  registerSecret(HIS_TOKEN);
});

after(async () => {
  await ingest.close();
  await hisStub.stop();
  ledger.close();
  clearRegisteredSecrets();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  ledger.db.exec('DELETE FROM material_binding');
  ledger.db.exec('DELETE FROM charge_receipt');
  ledger.db.exec('DELETE FROM check_task');
  // 审计链有库层护栏（禁止 UPDATE / DELETE），清库要走专用helper（临时摘护栏再装回）
  resetAuditChain(ledger.db);
  ledger.db.exec('DELETE FROM scan_event');
  ledger.db.exec('DELETE FROM notify_delivery');
  ledger.db.exec('DELETE FROM idempotency_claim');
  logLines.length = 0;
});

describe('可观测性：结构化日志 / 统一错误码表 / 运行摘要', () => {
  it('① 日志每行可 JSON.parse，固定字段齐全（缺值为 null，便于按字段检索）', async () => {
    const status = await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });
    assert.equal(status, 200);
    assert.ok(logLines.length > 0, '入站应落日志');

    const records = parsedLogs(logLines);
    for (const record of records) {
      for (const field of [
        'timestamp',
        'level',
        'request_id',
        'channel',
        'operation_no',
        'material_code',
        'conclusion',
        'error_code',
        'duration_ms',
      ]) {
        assert.ok(field in record, `日志缺少固定字段 ${field}`);
      }
      assert.ok(['debug', 'info', 'warn', 'error'].includes(record['level'] as string));
      assert.ok(!Number.isNaN(Date.parse(record['timestamp'] as string)));
    }

    // 逐条结论日志带台次、耗材码、结论、耗时
    const perItem = records.find(
      (record) => record['channel'] === 'binding' && record['material_code'] === 'MAT-UNKNOWN-99',
    );
    assert.ok(perItem, '未建档那条应有逐条日志');
    assert.equal(perItem['operation_no'], 'OP-SAMPLE-001');
    assert.equal(perItem['conclusion'], 'NOT_REGISTERED');
    assert.equal(perItem['error_code'], 'ERR_MATERIAL_NOT_REGISTERED');
    assert.equal(typeof perItem['duration_ms'], 'number');

    // 批次级日志带条数
    const batchLog = records.find((record) => record['message'] === '扫码批次已处理');
    assert.ok(batchLog, '应有批次级日志');
    assert.equal(batchLog['total'], 4);
    assert.equal(batchLog['accepted'], 3);
    assert.equal(batchLog['rejected'], 1);
  });

  it('② 日志与异常里绝不出现凭据明文（键名打码 + 已登记密钥打码 + URL 打码）', async () => {
    // 三道防线：
    //   ① 键名敏感 → 值打码
    //   ② 已登记的凭据明文出现在任何文本里 → 打码
    //   ③ URL 只留协议 + 主机 + 路径（query 里的 webhook key 被抹掉）
    const lines: string[] = [];
    const guarded = createLogger({
      level: 'debug',
      sink: (line) => lines.push(line),
    });
    guarded.info('网关用了令牌 abcdef123456 去调 HIS', {
      channel: 'outbound',
      his_charging_token: HIS_TOKEN,
      authorization: `Bearer ${HIS_TOKEN}`,
      webhook_url: 'http://127.0.0.1:8097/cgi-bin/webhook/send?key=secret-key-value',
      detail: `原始报文里带了 ${SCANNER_SECRET}`,
    });
    guarded.error('出站失败', {
      channel: 'outbound',
      error_code: 'ERR_CHARGE_TIMEOUT',
      error_message: `连接 ${SCANNER_TOKEN} 失败`,
    });

    const serialized = lines.join('\n');
    for (const secret of [HIS_TOKEN, SCANNER_SECRET, SCANNER_TOKEN, 'secret-key-value']) {
      assert.ok(!serialized.includes(secret), `日志里出现了凭据明文：${secret}`);
    }
    assert.ok(serialized.includes('***'), '打码后的占位符应出现');
    assert.ok(!serialized.includes('key=secret-key-value'), 'URL 的 query 参数应被抹掉');

    // 异常信息同样过一遍打码
    const errorLines: string[] = [];
    const guardedError = createLogger({ level: 'debug', sink: (line) => errorLines.push(line) });
    guardedError.error('异常', {
      error_message: `凭据 ${HIS_TOKEN} 出现在异常里`,
    });
    assert.ok(!errorLines.join('\n').includes(HIS_TOKEN), '异常信息里出现了凭据明文');
  });

  it('③ 统一错误码表：每码有中文含义 / 可重投标记 / 处置口径 / 排查顺序，且覆盖 ≥12 类', () => {
    assert.ok(ERROR_CODES.length >= 12, `错误码条目数应 ≥12，实际 ${ERROR_CODES.length}`);
    const seen = new Set<string>();
    for (const entry of ERROR_CODES) {
      assert.ok(entry.code.startsWith('ERR_'), `错误码应以 ERR_ 开头：${entry.code}`);
      assert.ok(!seen.has(entry.code), `错误码重复：${entry.code}`);
      seen.add(entry.code);
      assert.ok(entry.meaning_zh.length > 0, `${entry.code} 缺中文含义`);
      assert.ok(entry.action_zh.length > 0, `${entry.code} 缺建议处置`);
      assert.ok(typeof entry.retryable === 'boolean', `${entry.code} 缺可重投标记`);
      assert.ok(entry.triage_order >= 0, `${entry.code} 缺排查顺序`);
      assert.ok(ERROR_STAGE_LABELS[entry.stage], `${entry.code} 归属环节未登记`);
    }

    // 覆盖的类别（≥12 类）：入站验签 / 签名过期 / 重复投递 / 字段缺失 / 台次未知 /
    // 台次已关台 / 归属冲突 / 耗材未建档 / 跨台次重复 / 计费超时 / 计费业务拒绝 /
    // 推送失败 / 凭据缺失 / 内部错误
    const codes = new Set(ERROR_CODES.map((entry) => entry.code));
    for (const required of [
      'ERR_INVALID_SIGNATURE',
      'ERR_STALE_TIMESTAMP',
      'ERR_DUPLICATE_SCAN',
      'ERR_INVALID_SCAN_EVENT',
      'ERR_OPERATION_NOT_FOUND',
      'ERR_OPERATION_CLOSED',
      'ERR_OPERATION_CONFLICT',
      'ERR_MATERIAL_NOT_REGISTERED',
      'ERR_CROSS_OP_DUPLICATE',
      'ERR_CHARGE_TIMEOUT',
      'ERR_CHARGE_BUSINESS_REJECTED',
      'ERR_NOTIFY_HTTP_5XX',
      'ERR_MISSING_CREDENTIAL',
      'ERR_INTERNAL',
    ]) {
      assert.ok(codes.has(required), `错误码表缺少类别：${required}`);
    }

    // 业务原因码 → 错误码的映射：每个原因码都能落到一个已登记的码
    for (const [reason, code] of Object.entries(REASON_TO_ERROR_CODE)) {
      assert.ok(isKnownErrorCode(code), `原因码 ${reason} 映射到的 ${code} 不在错误码表里`);
    }
    assert.equal(errorCodeForReason('MATERIAL_NOT_REGISTERED'), 'ERR_MATERIAL_NOT_REGISTERED');
    assert.equal(errorCodeForReason('OPERATION_CLOSED'), 'ERR_OPERATION_CLOSED');
    assert.equal(errorCodeForReason('CROSS_OP_DUPLICATE_MATERIAL'), 'ERR_CROSS_OP_DUPLICATE');
    // 对端给的业务码按判定表落到**具体**的统一错误码（价码缺失 ≠ 库存不足 ≠ 医保分类错）
    assert.equal(errorCodeForReason('PRICE_CODE_NOT_FOUND'), 'ERR_CHARGE_PRICE_CODE_NOT_FOUND');
    assert.equal(errorCodeForReason('INSUFFICIENT_STOCK'), 'ERR_CHARGE_INSUFFICIENT_STOCK');
    // 没登记过的对端业务码按「不可重投 + 需人工」定性（不默认当作可重投）
    assert.equal(errorCodeForReason('SOME_PEER_CODE_WE_DO_NOT_KNOW'), 'ERR_CHARGE_BUSINESS_REJECTED');
    // 本侧错误码原样返回：5xx / 超时不能被误判成「对端业务拒绝」
    assert.equal(errorCodeForReason('ERR_CHARGE_HTTP_5XX'), 'ERR_CHARGE_HTTP_5XX');
    assert.equal(errorCodeForReason('ERR_CHARGE_TIMEOUT'), 'ERR_CHARGE_TIMEOUT');
    // 未知码不默认当作可重投
    assert.equal(describeErrorCode('ERR_SOMETHING_UNKNOWN').retryable, false);
    assert.equal(describeErrorCode('ERR_SOMETHING_UNKNOWN').needs_manual, true);
  });

  it('④ 错误码表落盘 docs/api/errors.md，且与代码里的表逐码对齐', () => {
    const doc = readFileSync(resolve(projectRoot, 'docs', 'api', 'errors.md'), 'utf8');
    assert.ok(doc.length > 2000, '错误码文档内容过短');
    for (const entry of ERROR_CODES) {
      assert.ok(doc.includes(entry.code), `错误码文档缺少 ${entry.code}`);
      assert.ok(doc.includes(entry.meaning_zh), `错误码文档缺少 ${entry.code} 的中文含义`);
    }
    // 文档里要有排查顺序与可重投标记的说明
    assert.ok(doc.includes('排查顺序'));
    assert.ok(doc.includes('可重投'));
    assert.ok(doc.includes('建议处置'));
  });

  it('⑤ 运行摘要：每个数字都与台账实际行数逐项相等（从 SQL 聚合，不靠内存计数）', async () => {
    const status = await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });
    assert.equal(status, 200);

    const summary = collectRunSummary(ledger.db);

    // 台账行数
    assert.equal(summary.ledger_rows, countBindings(ledger.db));
    // 事件日志行数
    assert.equal(summary.events, countEventLog(ledger.db));
    // 各路收到事件数（扫码枪 HTTP 路 1 批，目录路 0 批）
    const httpSource = summary.by_source.find((row) => row.source === 'scanner_http');
    assert.equal(httpSource?.events, 1);
    const rfidSource = summary.by_source.find((row) => row.source === 'rfid_dir');
    assert.equal(rfidSource?.events, 0);
    // 五种结论分布：BOUND 3 条 + NOT_REGISTERED 1 条，其余为 0
    const byConclusion = new Map(summary.by_conclusion.map((row) => [row.conclusion, row.count]));
    assert.equal(byConclusion.get('BOUND'), 3);
    assert.equal(byConclusion.get('NOT_REGISTERED'), 1);
    assert.equal(byConclusion.get('CROSS_OP_DUP'), 0);
    assert.equal(byConclusion.get('CLOSED'), 0);
    assert.equal(byConclusion.get('CHARGE_REJECTED'), 0);
    // 待核查条目数与核查表实际行数相等
    const pendingRows = ledger.db
      .prepare("SELECT COUNT(*) AS n FROM check_task WHERE status = 'pending'")
      .get() as { n: number };
    assert.equal(summary.check.pending, pendingRows.n);
    assert.equal(summary.check.total, pendingRows.n);
    // 计费：还没回写时成功率为 0
    assert.equal(summary.charge.attempts, 0);
    assert.equal(summary.charge.success_rate, 0);
    assert.equal(summary.charge.total_retries, 0);

    // 渲染成人看的文字也不报错，且含关键数字
    const text = formatRunSummary(summary);
    assert.ok(text.includes('绑定结论分布'));
    assert.ok(text.includes('BOUND：3'));
  });

  it('⑥ 错误码贯穿主路径：日志、核查条目、计费回执行展示同一个码', async () => {
    // 场景一：耗材未建档 → 核查条目 + 逐条日志，同一个码
    const status = await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });
    assert.equal(status, 200);

    const notRegisteredTask = ledger.db
      .prepare(
        "SELECT * FROM check_task WHERE material_code = 'MAT-UNKNOWN-99' AND conclusion = 'NOT_REGISTERED'",
      )
      .get() as { error_code: string; reason_code: string } | undefined;
    assert.ok(notRegisteredTask, '未建档那条应生成核查条目');
    assert.equal(notRegisteredTask.error_code, 'ERR_MATERIAL_NOT_REGISTERED');
    assert.equal(notRegisteredTask.reason_code, 'MATERIAL_NOT_REGISTERED');

    const logRecord = parsedLogs(logLines).find(
      (record) => record['material_code'] === 'MAT-UNKNOWN-99',
    );
    assert.ok(logRecord, '应有该耗材的逐条日志');
    assert.equal(logRecord['error_code'], notRegisteredTask.error_code, '日志与核查条目的码必须一致');

    // 场景二：计费业务拒绝 → 回执行 + 核查条目 + 计费日志，同一个码
    const client = new HisChargingClient({
      baseUrl: hisStub.baseUrl,
      token: HIS_TOKEN,
    });
    const writebackResult = await writeBackOperationCharges(ledger.db, 'OP-SAMPLE-001', {
      client,
      path: '/api/v1/material-uses',
      logger,
    });
    assert.equal(writebackResult.rejected, 1, 'MAT-SAMPLE-01 应被对端拒收');

    const receipt = ledger.db
      .prepare(
        "SELECT * FROM charge_receipt WHERE material_code = 'MAT-SAMPLE-01' AND accepted = 0",
      )
      .get() as { error_code: string; reason_code: string; kind: string } | undefined;
    assert.ok(receipt, '被拒的条目应留一条回执');
    // 统一错误码按判定表落到具体码（价码不存在），不是笼统的「业务拒绝」
    assert.equal(receipt.error_code, 'ERR_CHARGE_PRICE_CODE_NOT_FOUND');
    assert.equal(receipt.kind, 'BUSINESS_REJECTED');

    const chargeTask = ledger.db
      .prepare(
        "SELECT * FROM check_task WHERE material_code = 'MAT-SAMPLE-01' AND conclusion = 'CHARGE_REJECTED'",
      )
      .get() as { error_code: string } | undefined;
    assert.ok(chargeTask, '业务拒绝应生成核查条目');
    assert.equal(chargeTask.error_code, receipt.error_code, '核查条目与回执行的码必须一致');

    const chargeLog = parsedLogs(logLines).find(
      (record) =>
        record['material_code'] === 'MAT-SAMPLE-01' &&
        record['conclusion'] === 'CHARGE_REJECTED',
    );
    assert.ok(chargeLog, '计费拒绝应落一条日志');
    assert.equal(chargeLog['error_code'], receipt.error_code, '日志与回执行的码必须一致');

    // 摘要里的计费统计也跟着对上：1 次投递、0 次接收、1 次业务拒绝
    const summary = collectRunSummary(ledger.db);
    assert.equal(summary.charge.attempts, 3);
    assert.equal(summary.charge.accepted, 2);
    assert.equal(summary.charge.rejected, 1);
    assert.equal(summary.charge.success_rate, Number((2 / 3).toFixed(4)));
    assert.equal(summary.charge.total_retries, 0);
    assert.equal(summary.charge.retry_distribution.length, 1);
    assert.equal(summary.charge.retry_distribution[0]?.delivery_count, 1);
  });

  it('⑦ doctor 与 summary 共用同一份摘要实现 —— 两边数字必须一致', async () => {
    const status = await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });
    assert.equal(status, 200);

    const env = {
      OR_SCANNER_BASE_URL: 'http://127.0.0.1:8099',
      OR_SCANNER_TOKEN: SCANNER_TOKEN,
      OR_SCANNER_SECRET: SCANNER_SECRET,
      HIS_CHARGING_BASE_URL: 'http://127.0.0.1:8098',
      HIS_CHARGING_TOKEN: HIS_TOKEN,
      WECOM_WEBHOOK_URL: 'http://127.0.0.1:8097/cgi-bin/webhook/send?key=secret-key-value',
      WECOM_SECRET: 'wecom-secret-plaintext-2a9c',
    };

    const doctor = runDoctor(ledger.db, env, { ledger_db_path: 'ledger.db' });
    const summary = runSummary(ledger.db, {});

    assert.equal(doctor.run_summary.ledger_rows, summary.ledger_rows);
    assert.equal(doctor.run_summary.events, summary.events);
    assert.equal(doctor.run_summary.audit_rows, summary.audit_rows);
    assert.equal(doctor.run_summary.check.total, summary.check.total);
    assert.equal(doctor.run_summary.check.pending, summary.check.pending);
    assert.equal(doctor.run_summary.charge.attempts, summary.charge.attempts);
    assert.deepEqual(
      doctor.run_summary.by_conclusion.map((row) => [row.conclusion, row.count]),
      summary.by_conclusion.map((row) => [row.conclusion, row.count]),
    );

    // doctor 输出里仍不出现凭据明文
    const serialized = JSON.stringify(doctor);
    for (const secret of [SCANNER_TOKEN, SCANNER_SECRET, HIS_TOKEN, 'secret-key-value']) {
      assert.ok(!serialized.includes(secret), `doctor 输出里出现了凭据明文：${secret}`);
    }
  });

  it('⑧ doctor 把待核查条目按统一错误码分组（卡着的是哪几类问题，一眼看清）', async () => {
    const status = await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });
    assert.equal(status, 200);

    const env = {
      OR_SCANNER_BASE_URL: 'http://127.0.0.1:8099',
      OR_SCANNER_TOKEN: SCANNER_TOKEN,
      OR_SCANNER_SECRET: SCANNER_SECRET,
      HIS_CHARGING_BASE_URL: 'http://127.0.0.1:8098',
      HIS_CHARGING_TOKEN: HIS_TOKEN,
      WECOM_WEBHOOK_URL: 'http://127.0.0.1:8097/cgi-bin/webhook/send?key=secret-key-value',
      WECOM_SECRET: 'wecom-secret-plaintext-2a9c',
    };

    const doctor = runDoctor(ledger.db, env, { ledger_db_path: 'ledger.db' });
    assert.equal(doctor.pending_by_error_code.length, 1);
    const row = doctor.pending_by_error_code[0]!;
    assert.equal(row.error_code, 'ERR_MATERIAL_NOT_REGISTERED');
    assert.equal(row.count, 1);
    assert.equal(row.needs_manual, true);
    assert.ok(row.meaning_zh.length > 0, '错误码要带中文含义');
    assert.ok(isKnownErrorCode(row.error_code));
  });
});
