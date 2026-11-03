/**
 * test_cli：审计链 + 运维 CLI（doctor / replay / ledger / pack / summary）。
 *
 * 覆盖：
 *   ① doctor —— 三路凭据位齐否、末次收到事件 / 末次计费回写、推送失败计数，
 *      且**输出里不出现任何凭据明文**；
 *   ② replay —— 从事件日志重放同批事件：**新增台账行数 = 0**（同键不重复入账），
 *      首次重放回写计费 1 次、第二次重放 **触发计费次数 = 0**（不重复计费）；
 *   ③ ledger —— 台账查询与导出，行数与台账实际行数一致；
 *   ④ pack —— 核查包导出字段来自固定白名单，**不含患者标识字段**；
 *   ⑤ summary —— 统计数字与台账实际行数逐项相等；
 *   ⑥ 审计链完整性校验通过（行号连续 / 时间不倒序 / 事件类型非空）。
 *
 * 替身说明：HIS 计费替身是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走同一条 fetch 代码路径。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { verifyAuditIntegrity, countAuditRows } from '../src/ledger/audit.js';
import { countEventLog, listEventLog } from '../src/ledger/event-log.js';
import { startIngestServer, type IngestServerHandle } from '../src/ingest/http-server.js';
import { formatSignatureHeader } from '../src/ingest/signature.js';
import { newNonce } from '../src/ingest/replay-guard.js';
import { HisChargingClient } from '../src/charge/client.js';
import {
  PACK_EXPORT_FIELDS,
  packToCsv,
  runDoctor,
  runLedgerQuery,
  runPack,
  runReplay,
  runSummary,
} from '../src/cli/commands.js';
import { parseArgs, CLI_HELP } from '../src/cli/index.js';
import { resetAuditChain } from './support/audit-reset.js';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const SCANNER_TOKEN = 'scanner-token-plaintext-4c1d';
const SCANNER_SECRET = 'scanner-secret-plaintext-9a2b';
const HIS_TOKEN = 'his-token-plaintext-77ef';
const WECOM_SECRET = 'wecom-secret-plaintext-2a9c';

/** 患者标识字段黑名单：核查包 / 台账导出里出现任何一个都不允许 */
const PATIENT_IDENTIFIER_PATTERN =
  /patient|patient_name|id_card|idcard|identity|mrn|medical_record|姓名|身份证|证件|住院号|门诊号|患者/iu;

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

/** 一批 6 条扫码：4 条院内码 + 1 条 UDI + 1 条 GS1 + 1 条未建档 */
function demoScans() {
  return [
    { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00+08:00', batch_no: 'LOT-SAMPLE-A' },
    { material_code: 'MAT-SAMPLE-02', quantity: 2, scan_time: '2026-01-15T09:13:10+08:00', batch_no: 'LOT-SAMPLE-B' },
    { material_code: 'MAT-SAMPLE-05', quantity: 1, scan_time: '2026-01-15T09:16:05+08:00', batch_no: 'LOT-SAMPLE-E' },
    { material_code: 'MAT-UNKNOWN-99', quantity: 1, scan_time: '2026-01-15T09:17:31+08:00' },
  ];
}

/** HIS 计费替身：真实 HTTP 服务，记录收到的请求 */
class HisChargingStub {
  readonly requests: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  private readonly server: Server;
  baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.requests.push({ body, headers: req.headers });
        let parsed: { uses?: Array<{ material_code: string }> } = {};
        try {
          parsed = JSON.parse(body) as { uses?: Array<{ material_code: string }> };
        } catch {
          parsed = {};
        }
        const uses = parsed.uses ?? [];
        const payload = JSON.stringify({
          accepted: uses.map((use) => ({ material_code: use.material_code })),
          rejected: [],
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
let dbPath: string;
let ledger: LedgerDb;
let ingest: IngestServerHandle;
let hisStub: HisChargingStub;

/** 投递一批扫码事件（走真实入站 HTTP 路径） */
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

/** 完整的运行环境（凭据位齐否由各路自己判断） */
function readyEnv(): NodeJS.ProcessEnv {
  return {
    OR_SCANNER_BASE_URL: 'http://127.0.0.1:8099',
    OR_SCANNER_TOKEN: SCANNER_TOKEN,
    OR_SCANNER_SECRET: SCANNER_SECRET,
    HIS_CHARGING_BASE_URL: 'http://127.0.0.1:8098',
    HIS_CHARGING_TOKEN: HIS_TOKEN,
    WECOM_WEBHOOK_URL: 'http://127.0.0.1:8097/cgi-bin/webhook/send?key=secret-key-value',
    WECOM_SECRET: WECOM_SECRET,
  };
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'msb-cli-'));
  dbPath = resolve(workDir, 'ledger.db');
  ledger = openLedger(dbPath);
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  ingest = await startIngestServer({ db: ledger.db, token: SCANNER_TOKEN, secret: SCANNER_SECRET });
  hisStub = new HisChargingStub();
  await hisStub.start();
});

after(async () => {
  await ingest.close();
  await hisStub.stop();
  ledger.close();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // 每条用例前把台账清空到只剩主数据，保证断言互不干扰
  // （幂等占位也要清：不清的话同键会被判重复扫码，台账不再落行）
  ledger.db.exec('DELETE FROM material_binding');
  ledger.db.exec('DELETE FROM charge_receipt');
  ledger.db.exec('DELETE FROM check_task');
  // 审计链有库层护栏（禁止 UPDATE / DELETE），清库要走专用helper（临时摘护栏再装回）
  resetAuditChain(ledger.db);
  ledger.db.exec('DELETE FROM scan_event');
  ledger.db.exec('DELETE FROM notify_delivery');
  ledger.db.exec('DELETE FROM idempotency_claim');
  hisStub.requests.length = 0;
});

describe('运维 CLI', () => {
  it('doctor：三路凭据位齐否 + 末次事件 / 末次计费回写 + 推送失败计数，且不出现凭据明文', async () => {
    const status = await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });
    assert.equal(status, 200);

    const report = runDoctor(ledger.db, readyEnv(), { ledger_db_path: dbPath });

    // 三路都在，且都齐备
    assert.equal(report.channels.length, 3);
    for (const channel of report.channels) {
      assert.equal(channel.ready, true, `${channel.channel} 应当齐备`);
      assert.deepEqual(channel.missing, []);
    }
    // 缺位时只报变量名，不报值
    const missing = runDoctor(ledger.db, { ...readyEnv(), HIS_CHARGING_TOKEN: '' });
    const outbound = missing.channels.find((channel) => channel.channel === 'outbound');
    assert.ok(outbound);
    assert.equal(outbound.ready, false);
    assert.deepEqual(outbound.missing, ['HIS_CHARGING_TOKEN']);

    // 末次收到事件的时间有值；末次计费回写暂时为空（还没回写过）
    assert.ok(report.last_event_at, '末次收到事件的时间应有值');
    assert.equal(report.last_charge_at, null);
    assert.equal(report.notify_failures, 0);
    assert.equal(report.counters.events, 1);
    assert.equal(report.counters.ledger_rows, countBindings(ledger.db));

    // 两路来源各体检一次：扫码枪路可用、目录路按投递目录可读判定
    assert.equal(report.sources.length, 2);
    const httpSource = report.sources.find((source) => source.source === 'scanner_http');
    assert.equal(httpSource?.ready, true);
    assert.equal(httpSource?.events, 1);
    assert.ok(httpSource?.last_event_at);
    const rfidSource = report.sources.find((source) => source.source === 'rfid_dir');
    assert.equal(rfidSource?.ready, false, '投递目录不存在时应判目录路不可用');
    assert.equal(rfidSource?.events, 0);

    // 凭据明文一律不出现在输出里
    const serialized = JSON.stringify(report);
    for (const secret of [SCANNER_TOKEN, SCANNER_SECRET, HIS_TOKEN, WECOM_SECRET, 'secret-key-value']) {
      assert.ok(!serialized.includes(secret), `doctor 输出里出现了凭据明文：${secret}`);
    }
    // 企微 webhook 的 key 也不该出现（端点只留协议 + 主机 + 路径）
    const notify = report.channels.find((channel) => channel.channel === 'notify');
    assert.ok(notify?.endpoint);
    assert.ok(!notify.endpoint.includes('secret-key-value'));
  });

  it('replay：重放同批事件新增台账行数为 0；首次回写计费 1 次，第二次触发计费次数为 0', async () => {
    await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });
    assert.equal(countBindings(ledger.db), 3, '入库后应有 3 行台账');
    assert.equal(countEventLog(ledger.db), 1, '事件日志应有 1 行');

    // ① 只重放（不回写计费）：同键重放不产生新台账行
    const first = await runReplay(ledger.db, { limit: 10 });
    assert.equal(first.events_replayed, 1);
    assert.equal(first.new_ledger_rows, 0, '同键重放不得产生新台账行');
    assert.equal(countBindings(ledger.db), 3);
    assert.ok(first.charge_skipped_reason);
    // 重放的逐条结论全是「重复扫码」—— 这正是幂等层在起作用
    const reasons = first.batches[0]?.reason_codes ?? [];
    assert.ok(
      reasons.some((item) => item.reason_code === 'DUPLICATE_SCAN' && item.count === 3),
      `重放结论应全部判重复扫码：${JSON.stringify(reasons)}`,
    );

    // ② 带计费回写重放：绑定成功的 3 条回写 HIS 计费（1 次出站请求）
    const client = new HisChargingClient({
      baseUrl: hisStub.baseUrl,
      token: HIS_TOKEN,
      timeoutMs: 5000,
      logger: () => undefined,
    });
    const second = await runReplay(ledger.db, {
      limit: 10,
      charge: true,
      chargeClient: client,
      chargePath: '/api/v1/material-uses',
    });
    assert.equal(second.new_ledger_rows, 0);
    assert.equal(second.charge_calls, 1, '绑定成功的条目应一次回写计费');
    assert.equal(second.charge_submitted, 3);
    assert.equal(second.charge_accepted, 3);
    assert.equal(hisStub.requests.length, 1, '对端只应收到 1 次计费请求');
    // 计费成功后条目状态推进到 charged
    const charged = ledger.db
      .prepare("SELECT COUNT(*) AS n FROM material_binding WHERE status = 'charged'")
      .get() as { n: number };
    assert.equal(charged.n, 3);

    // ③ 再重放一次：条目已计费，不再重复投递（触发计费次数 = 0）
    const third = await runReplay(ledger.db, {
      limit: 10,
      charge: true,
      chargeClient: client,
      chargePath: '/api/v1/material-uses',
    });
    assert.equal(third.new_ledger_rows, 0);
    assert.equal(third.charge_calls, 0, '已回写计费的条目不得重复投递');
    assert.equal(hisStub.requests.length, 1, '对端不应收到第二次计费请求');
  });

  it('ledger：台账查询行数与实际一致，可按台次 / 状态过滤', async () => {
    await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });

    const all = runLedgerQuery(ledger.db, {});
    assert.equal(all.rows.length, countBindings(ledger.db));
    assert.equal(all.total, 3);

    const byOperation = runLedgerQuery(ledger.db, { operation_no: 'OP-SAMPLE-001' });
    assert.equal(byOperation.rows.length, 3);

    const byStatus = runLedgerQuery(ledger.db, { status: 'bound' });
    assert.equal(byStatus.rows.length, 3);
    for (const row of byStatus.rows) {
      assert.equal(row.status, 'bound');
      assert.equal(row.charge_state, 'not_submitted');
      assert.ok(row.material_code.length > 0);
      assert.ok(row.created_at.length > 0);
    }

    const empty = runLedgerQuery(ledger.db, { operation_no: 'OP-NOT-EXIST' });
    assert.equal(empty.rows.length, 0);
  });

  it('pack：核查包导出字段来自白名单，不含患者标识字段', async () => {
    await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });

    const pack = runPack(ledger.db, {});
    assert.ok(pack.rows.length >= 1, '未建档的耗材应产生核查条目');
    assert.deepEqual(pack.fields, [...PACK_EXPORT_FIELDS]);

    // 字段名里不含任何患者标识
    for (const field of pack.fields) {
      assert.ok(
        !PATIENT_IDENTIFIER_PATTERN.test(field),
        `核查包导出字段含患者标识：${field}`,
      );
    }

    // 行的取值里也不含患者标识（值全是耗材码 / 台次 / 结论）
    for (const row of pack.rows) {
      assert.equal(row.operation_no, 'OP-SAMPLE-001');
      assert.equal(row.room_no, 'OR-01');
      assert.equal(row.material_code, 'MAT-UNKNOWN-99');
      assert.equal(row.reason_code, 'MATERIAL_NOT_REGISTERED');
      assert.equal(row.check_status, 'pending');
      for (const value of Object.values(row)) {
        if (typeof value !== 'string') continue;
        assert.ok(
          !PATIENT_IDENTIFIER_PATTERN.test(value),
          `核查包内容含患者标识：${value}`,
        );
      }
    }

    // CSV 表头与白名单逐字一致
    const csv = packToCsv(pack);
    const header = csv.split('\n')[0] ?? '';
    assert.equal(header, PACK_EXPORT_FIELDS.join(','));
    assert.equal(csv.split('\n').length, pack.rows.length + 1);
  });

  it('summary：统计数字与台账实际行数逐项相等', async () => {
    await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });

    const summary = runSummary(ledger.db, {});
    assert.equal(summary.ledger_rows, countBindings(ledger.db));
    assert.equal(summary.events, countEventLog(ledger.db));
    assert.equal(summary.audit_rows, countAuditRows(ledger.db));
    assert.equal(summary.check.total, 1, '未建档那条应生成 1 条核查条目');
    assert.equal(summary.check.pending, 1);

    const bound = summary.by_conclusion.find((row) => row.conclusion === 'BOUND');
    assert.equal(bound?.count, 3);
    const notRegistered = summary.by_conclusion.find((row) => row.conclusion === 'NOT_REGISTERED');
    assert.equal(notRegistered?.count, 1);

    const operations = summary.by_operation.find((row) => row.operation_no === 'OP-SAMPLE-001');
    assert.equal(operations?.rows, 3);
    assert.equal(operations?.pending, 1);
  });

  it('审计链：完整性校验通过，且只增不改（无 update / delete 接口）', async () => {
    await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });

    const integrity = verifyAuditIntegrity(ledger.db);
    assert.equal(integrity.intact, true, `审计链校验未通过：${integrity.issues.join('；')}`);
    assert.ok(integrity.rows > 0);
    assert.deepEqual(integrity.issues, []);

    // 审计层只暴露 append / query / verify —— 不提供改写接口
    const auditModule = await import('../src/ledger/audit.js');
    const exported = Object.keys(auditModule).sort();
    for (const forbidden of ['updateAudit', 'deleteAudit', 'truncateAudit', 'rewriteAudit']) {
      assert.ok(!exported.includes(forbidden), `审计层不应导出 ${forbidden}`);
    }
  });

  it('事件日志：两路来源的事件都落盘，原始报文按原文保存', async () => {
    await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });
    const events = listEventLog(ledger.db, {});
    assert.equal(events.length, 1);
    assert.equal(events[0]?.source, 'scanner_http');
    assert.equal(events[0]?.signature_verified, true);
    assert.equal(events[0]?.operation_no, 'OP-SAMPLE-001');
    assert.ok(events[0]?.raw_body?.includes('MAT-UNKNOWN-99'), '原始报文应按原文保存');
    assert.ok(events[0]?.normalized_json?.includes('MAT-UNKNOWN-99'));
  });

  it('命令行入口：doctor / pack 子命令可跑，且输出不含凭据明文', async () => {
    await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });

    const env = { ...process.env, ...readyEnv() };
    const doctor = await execFileAsync(
      process.execPath,
      [resolve(projectRoot, 'dist', 'cli.js'), 'doctor', '--db', dbPath],
      { env, cwd: projectRoot },
    );
    assert.ok(doctor.stdout.includes('通道体检'));
    assert.ok(doctor.stdout.includes('入站扫码网关'));
    assert.ok(doctor.stdout.includes('出站 HIS 计费'));
    assert.ok(doctor.stdout.includes('企业微信推送'));
    assert.ok(doctor.stdout.includes('末次收到扫码事件'));
    for (const secret of [SCANNER_TOKEN, SCANNER_SECRET, HIS_TOKEN, WECOM_SECRET, 'secret-key-value']) {
      assert.ok(!doctor.stdout.includes(secret), `CLI 输出里出现了凭据明文：${secret}`);
    }

    const pack = await execFileAsync(
      process.execPath,
      [resolve(projectRoot, 'dist', 'cli.js'), 'pack', '--db', dbPath, '--format', 'csv'],
      { env, cwd: projectRoot },
    );
    assert.ok(pack.stdout.includes('check_task_id,operation_no'));
    assert.ok(pack.stdout.includes('MAT-UNKNOWN-99'));

    const help = await execFileAsync(
      process.execPath,
      [resolve(projectRoot, 'dist', 'cli.js'), '--help'],
      { env, cwd: projectRoot },
    );
    for (const command of ['doctor', 'replay', 'ledger', 'pack', 'summary']) {
      assert.ok(help.stdout.includes(command), `帮助里缺少子命令 ${command}`);
    }
  });

  it('参数解析：--key value / --key=value / --flag 三种写法都能认', () => {
    const parsed = parseArgs(['doctor', '--db', '/tmp/x.db', '--format=csv', '--charge', 'extra']);
    assert.equal(parsed.command, 'doctor');
    assert.equal(parsed.options['db'], '/tmp/x.db');
    assert.equal(parsed.options['format'], 'csv');
    assert.equal(parsed.flags.has('charge'), true);
    assert.deepEqual(parsed.positional, ['extra']);
    assert.ok(CLI_HELP.includes('node dist/cli.js'));
  });

  it('事件日志文件重放：--file 走同一套装配，同键重放不新增台账行', async () => {
    await postBatch({
      operation_no: 'OP-SAMPLE-001',
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      scans: demoScans(),
    });

    const filePath = resolve(workDir, 'events.jsonl');
    writeFileSync(
      filePath,
      `${JSON.stringify({
        source: 'scanner_http',
        operation_no: 'OP-SAMPLE-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-GUN-07',
        items: [
          { material_code: 'MAT-SAMPLE-01', raw_code: 'MAT-SAMPLE-01', quantity: 1 },
          { material_code: 'MAT-SAMPLE-02', raw_code: 'MAT-SAMPLE-02', quantity: 2 },
        ],
      })}\n`,
      'utf8',
    );

    const report = await runReplay(ledger.db, { limit: 10, eventsFile: filePath });
    assert.equal(report.events_replayed, 1);
    assert.equal(report.new_ledger_rows, 0, '同键重放不得产生新台账行');
    assert.equal(countBindings(ledger.db), 3);
  });
});
