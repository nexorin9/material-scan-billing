/**
 * test_health_probe：doctor 深化 —— 通道可达性**主动探测**与凭据位体检。
 *
 * 覆盖：
 *   ① 出站主动探测 —— 发**空批次**健康检查（`uses` 为空数组），
 *      对端**不产生任何计费明细**，台账一个字都不变；
 *   ② 对端 5xx → 判**不可达**并记下错误码；4xx → 通道通但被拒（另一档）；
 *   ③ 凭据缺失 → 该路**未探测**，输出里看得见**变量名**、看不见**值**；
 *   ④ 入站探测 —— 监听端口在不在监听、验签密钥配没配、投递箱读写；
 *   ⑤ 推送探测 —— 地址格式 + 连通性，**不发任何业务消息**（对端收到 0 个请求）；
 *   ⑥ doctor 近况 —— 各路最近一次成功 / 最近一次失败 / 最近一个错误码；
 *   ⑦ `doctor --json` 输出可被 JSON.parse 且字段齐全；全部输出不含凭据明文。
 *
 * 替身说明：HIS 计费替身与推送替身都是 tests/ 内的**真实 HTTP 服务**
 * （node:http），生产客户端与替身走同一条 HTTP 代码路径。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { countAuditRows } from '../src/ledger/audit.js';
import { runDoctor, runDoctorWithProbes, renderDoctorText } from '../src/cli/commands.js';
import {
  buildEmptyProbeBody,
  inspectWebhookUrl,
  probeAllChannels,
  probeInboundListener,
  probeNotifyEndpoint,
  probeOutboundCharge,
  type ChannelProbeResult,
} from '../src/health/probe.js';
import { runChannelHealth } from '../src/health/channel-health.js';
import { readSettings } from '../src/config/env.js';
import { resetAuditChain } from './support/audit-reset.js';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const SCANNER_TOKEN = 'scanner-token-plaintext-4c1d';
const SCANNER_SECRET = 'scanner-secret-plaintext-9a2b';
const HIS_TOKEN = 'his-token-plaintext-77ef';
const WECOM_SECRET = 'wecom-secret-plaintext-2a9c';

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

/** HIS 计费替身：真实 HTTP 服务，逐条记账（重复计费口径同其他测试） */
interface HisStub {
  baseUrl: string;
  requests: Array<{ body: string; headers: Record<string, string | string[] | undefined> }>;
  /** 收到的耗材明细条数 */
  entries: Array<{ operation_no: string; material_code: string }>;
  close(): Promise<void>;
}

async function startHisStub(options: { status?: number } = {}): Promise<HisStub> {
  const requests: HisStub['requests'] = [];
  const entries: HisStub['entries'] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ body, headers: req.headers });
      let parsed: { operation_no?: string; uses?: Array<{ material_code: string }> } = {};
      try {
        parsed = JSON.parse(body) as { operation_no?: string; uses?: Array<{ material_code: string }> };
      } catch {
        parsed = {};
      }
      for (const use of parsed.uses ?? []) {
        entries.push({ operation_no: String(parsed.operation_no ?? ''), material_code: use.material_code });
      }
      const status = options.status ?? 200;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          accepted: (parsed.uses ?? []).map((use) => ({ material_code: use.material_code })),
          rejected: [],
        }),
      );
    });
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => done());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    entries,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** 推送替身：真实 HTTP 服务，用来证明「探测不发业务消息」 */
interface WebhookStub {
  baseUrl: string;
  /** 收到的 HTTP 请求数（探测应当是 0） */
  requests: number;
  /** 建立的 TCP 连接数（探测会连一下再断开） */
  connections: number;
  close(): Promise<void>;
}

async function startWebhookStub(): Promise<WebhookStub> {
  const state = { requests: 0, connections: 0 };
  const server: Server = createServer((_req, res) => {
    state.requests += 1;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
  });
  server.on('connection', () => {
    state.connections += 1;
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => done());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get requests() {
      return state.requests;
    },
    get connections() {
      return state.connections;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

let workDir: string;
let inboxDir: string;
let dbPath: string;
let ledger: LedgerDb;
let hisStub: HisStub;
let webhookStub: WebhookStub;
/** 没人监听的端口：用来验「监听端口没在监听」 */
let deadPort: number;

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OR_SCANNER_BASE_URL: 'http://127.0.0.1:8099',
    OR_SCANNER_TOKEN: SCANNER_TOKEN,
    OR_SCANNER_SECRET: SCANNER_SECRET,
    HIS_CHARGING_BASE_URL: hisStub.baseUrl,
    HIS_CHARGING_TOKEN: HIS_TOKEN,
    WECOM_WEBHOOK_URL: `${webhookStub.baseUrl}/cgi-bin/webhook/send?key=secret-key-value`,
    WECOM_SECRET: WECOM_SECRET,
    HTTP_PORT: String(deadPort),
    SCAN_INBOX_DIR: inboxDir,
    ...overrides,
  };
}

function probeOptions(env: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  settings: ReturnType<typeof readSettings>;
} {
  return { env, settings: readSettings(env) };
}

/** 取某一路的探测结论 */
function pick(probes: readonly ChannelProbeResult[], channel: string): ChannelProbeResult {
  const found = probes.find((probe) => probe.channel === channel);
  assert.ok(found, `没有 ${channel} 这一路的探测结论`);
  return found;
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'msb-probe-'));
  inboxDir = resolve(workDir, 'scan-inbox');
  mkdirSync(inboxDir, { recursive: true });
  dbPath = resolve(workDir, 'ledger.db');
  ledger = openLedger(dbPath);
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  hisStub = await startHisStub();
  webhookStub = await startWebhookStub();

  // 找一个确定没人监听的端口：起一个服务拿到端口号，再关掉
  const probeServer = createServer();
  await new Promise<void>((done) => {
    probeServer.listen(0, '127.0.0.1', () => done());
  });
  const address = probeServer.address();
  deadPort = typeof address === 'object' && address !== null ? address.port : 59999;
  await new Promise<void>((done) => {
    probeServer.close(() => done());
  });
});

after(async () => {
  await hisStub.close();
  await webhookStub.close();
  ledger.close();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  ledger.db.exec('DELETE FROM material_binding');
  ledger.db.exec('DELETE FROM charge_receipt');
  ledger.db.exec('DELETE FROM check_task');
  resetAuditChain(ledger.db);
  ledger.db.exec('DELETE FROM scan_event');
  ledger.db.exec('DELETE FROM notify_delivery');
  hisStub.requests.length = 0;
  hisStub.entries.length = 0;
});

describe('doctor 主动探测', () => {
  it('① 出站探测发的是**空批次**：请求体 uses 为空数组，对端不产生任何计费明细', async () => {
    const env = baseEnv();
    const before = {
      bindings: countBindings(ledger.db),
      audit: countAuditRows(ledger.db),
    };

    const result = await probeOutboundCharge(probeOptions(env));

    // 对端确实收到了这次健康检查
    assert.equal(hisStub.requests.length, 1, '应当向 HIS 计费侧发出一次健康检查');
    const body = JSON.parse(hisStub.requests[0]?.body ?? '{}') as {
      operation_no?: string;
      dept_code?: string;
      uses?: unknown[];
    };
    assert.ok(Array.isArray(body.uses), '请求体必须带 uses 数组');
    assert.equal(body.uses?.length, 0, 'uses 必须是空数组 —— 空批次不产生计费条目');
    // 凭据盖章照旧（走的是生产同一条代码路径）
    assert.equal(
      hisStub.requests[0]?.headers['authorization'],
      `Bearer ${HIS_TOKEN}`,
      '健康检查必须带同一个 Bearer（与真实计费同一条代码路径）',
    );

    // 对端一条耗材明细都没记
    assert.equal(hisStub.entries.length, 0, '空批次不得在对端产生任何计费明细');

    // 探测不写台账、不写审计链
    assert.equal(countBindings(ledger.db), before.bindings, '探测不得改台账');
    assert.equal(countAuditRows(ledger.db), before.audit, '探测不得写审计链');

    // 结论
    assert.equal(result.outcome, 'ok');
    assert.equal(result.reachable, true);
    assert.equal(result.error_code, null);
    assert.equal(result.channel, 'outbound');
    assert.ok(result.duration_ms >= 0);
    assert.ok(result.checks.length >= 1);
  });

  it('② 对端 5xx → 判不可达并记下错误码；4xx → 通道通但被拒（另一档结论）', async () => {
    const failing = await startHisStub({ status: 503 });
    try {
      const env = baseEnv({ HIS_CHARGING_BASE_URL: failing.baseUrl });
      const result = await probeOutboundCharge(probeOptions(env));
      assert.equal(result.outcome, 'unreachable', '5xx 应当判不可达');
      assert.equal(result.reachable, false);
      assert.equal(result.error_code, 'ERR_CHARGE_HTTP_5XX');
      assert.equal(result.status, 503);
      assert.ok(result.error_code_zh.length > 0, '错误码要有中文含义');
    } finally {
      await failing.close();
    }

    const rejecting = await startHisStub({ status: 400 });
    try {
      const env = baseEnv({ HIS_CHARGING_BASE_URL: rejecting.baseUrl });
      const result = await probeOutboundCharge(probeOptions(env));
      assert.equal(result.outcome, 'rejected', '4xx 是「通道通但被拒」，与不可达不是一档');
      assert.equal(result.reachable, true);
      assert.equal(result.error_code, 'ERR_CHARGE_HTTP_4XX');
      assert.equal(result.status, 400);
    } finally {
      await rejecting.close();
    }
  });

  it('③ 凭据缺失 → 该路未探测：看得见变量名，看不见值', async () => {
    const env = baseEnv({ HIS_CHARGING_TOKEN: '' });
    const result = await probeOutboundCharge(probeOptions(env));

    assert.equal(result.outcome, 'skipped');
    assert.equal(result.reachable, false);
    assert.equal(result.error_code, 'ERR_MISSING_CREDENTIAL');
    assert.ok(result.detail.includes('HIS_CHARGING_TOKEN'), '缺哪个变量名要看得见');
    // 其余两路不受影响
    const probes = await probeAllChannels(probeOptions(env));
    assert.equal(pick(probes, 'outbound').outcome, 'skipped');
    assert.notEqual(pick(probes, 'notify').outcome, 'skipped');
  });

  it('④ 入站探测：端口没在监听 / 密钥没配 / 投递箱不可写，三个检查项各给一个结论', async () => {
    const env = baseEnv({ OR_SCANNER_SECRET: '' });
    const result = await probeInboundListener(probeOptions(env));

    assert.equal(result.channel, 'inbound');
    assert.equal(result.outcome, 'unreachable');
    assert.equal(result.reachable, false, '端口没人监听 → 入站不通');

    const byName = new Map(result.checks.map((check) => [check.name, check]));
    assert.equal(byName.get('验签密钥已配置')?.ok, false);
    assert.equal(byName.get('验签密钥已配置')?.error_code, 'ERR_MISSING_SIGNATURE');
    assert.equal(byName.get('监听端口在监听')?.ok, false);
    assert.equal(byName.get('监听端口在监听')?.error_code, 'ERR_INBOUND_PORT_NOT_LISTENING');
    assert.equal(byName.get('目录投递箱可读可写')?.ok, true);
    // 密钥只报齐否，不报值
    assert.ok(!JSON.stringify(result).includes(SCANNER_SECRET), '输出里不得出现密钥明文');
  });

  it('④-2 投递箱读不到时给出独立错误码 ERR_SCAN_INBOX_NOT_WRITABLE', async () => {
    const env = baseEnv({ SCAN_INBOX_DIR: resolve(workDir, 'no-such-inbox') });
    const result = await probeInboundListener(probeOptions(env));
    const check = result.checks.find((item) => item.name === '目录投递箱可读可写');
    assert.ok(check);
    assert.equal(check.ok, false);
    assert.equal(check.error_code, 'ERR_SCAN_INBOX_NOT_WRITABLE');
  });

  it('⑤ 推送探测只校验格式与连通性，**不发任何业务消息**', async () => {
    const env = baseEnv();
    const result = await probeNotifyEndpoint(probeOptions(env));

    assert.equal(result.outcome, 'ok');
    assert.equal(result.reachable, true);
    // 对端一个 HTTP 请求都没收到（只做了 TCP 连接）
    assert.equal(webhookStub.requests, 0, '探测不得往群里发消息');
    assert.ok(webhookStub.connections >= 1, '探测应当连过一次端口（只握手）');

    // 地址格式不对 → 独立结论
    const broken = await probeNotifyEndpoint(
      probeOptions(baseEnv({ WECOM_WEBHOOK_URL: 'http://qyapi.weixin.qq.com/cgi-bin/webhook/send' })),
    );
    assert.equal(broken.outcome, 'unreachable');
    assert.equal(broken.error_code, 'ERR_NOTIFY_CONFIG');

    // 缺 key 参数同样判不可用
    const noKey = inspectWebhookUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send');
    assert.equal(noKey.ok, false);
    assert.ok(noKey.reason.includes('key'));
  });

  it('⑥ doctor 近况：各路最近一次成功 / 最近一次失败 / 最近一个错误码', async () => {
    const health = runChannelHealth(ledger.db, baseEnv());
    assert.equal(health.length, 3);
    for (const row of health) {
      assert.ok(row.label.length > 0);
      assert.equal(row.credentials_ready, true);
      assert.deepEqual(row.missing, []);
      assert.ok('last_success_at' in row);
      assert.ok('last_failure_at' in row);
      assert.ok('last_error_code' in row);
    }

    // 入站失败：造一条「耗材未建档」的核查条目（入站侧问题）
    ledger.db
      .prepare(
        `INSERT INTO check_task
           (operation_no, room_no, dept_code, scanner_id, material_code, quantity, conclusion,
            reason_code, status, detected_at, created_at)
         VALUES ('OP-SAMPLE-001', 'OR-01', 'DEPT-01', 'SCAN-GUN-07', 'MAT-UNKNOWN-99', 1,
                 'NOT_REGISTERED', 'MATERIAL_NOT_REGISTERED', 'pending', ?, ?)`,
      )
      .run('2026-01-15T09:17:31.000Z', '2026-01-15T09:17:31.000Z');

    const after = runChannelHealth(ledger.db, baseEnv());
    const inbound = after.find((row) => row.channel === 'inbound');
    assert.ok(inbound);
    assert.equal(inbound.last_failure_at, '2026-01-15T09:17:31.000Z');
    assert.equal(inbound.last_error_code, 'ERR_MATERIAL_NOT_REGISTERED');
    assert.ok(inbound.last_error_code_zh.length > 0);
    assert.ok(inbound.note.includes('ERR_MATERIAL_NOT_REGISTERED'));
  });

  it('⑦ doctor --json：输出可被 JSON.parse 且字段齐全；全部输出不含凭据明文', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve(projectRoot, 'dist', 'cli.js'), 'doctor', '--db', dbPath, '--json'],
      {
        env: { PATH: process.env['PATH'] ?? '', ...baseEnv() },
        cwd: projectRoot,
      },
    );

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    assert.ok(Array.isArray(parsed['channels']));
    assert.ok(Array.isArray(parsed['channel_health']));
    assert.ok(Array.isArray(parsed['probes']));
    assert.ok(typeof parsed['generated_at'] === 'string');
    assert.ok(parsed['counters'] !== undefined);
    assert.ok(parsed['outbound_circuit'] !== undefined);
    assert.ok(parsed['heartbeat'] !== undefined);
    assert.ok(parsed['master_data'] !== undefined);

    // 凭据明文一律不出现
    for (const secret of [SCANNER_TOKEN, SCANNER_SECRET, HIS_TOKEN, WECOM_SECRET, 'secret-key-value']) {
      assert.ok(!stdout.includes(secret), `doctor --json 输出里出现了凭据明文：${secret}`);
    }
  });

  it('⑧ doctor 的人类可读输出含「各路近况」与「主动探测」两段，且不含凭据明文', async () => {
    const report = await runDoctorWithProbes(ledger.db, baseEnv(), {
      ledger_db_path: dbPath,
      probe: true,
    });
    const text = renderDoctorText(report);

    assert.ok(text.includes('== 各路近况 =='));
    assert.ok(text.includes('== 主动探测 =='));
    assert.ok(text.includes('最近成功='));
    assert.ok(text.includes('最近失败='));
    assert.ok(text.includes('错误码='));
    // 三路探测结论都在
    assert.equal(report.probes.length, 3);
    for (const secret of [SCANNER_TOKEN, SCANNER_SECRET, HIS_TOKEN, WECOM_SECRET, 'secret-key-value']) {
      assert.ok(!text.includes(secret), `doctor 输出里出现了凭据明文：${secret}`);
    }
  });

  it('⑨ 默认 doctor 不探测：不加 --probe 时 probes 为空，且不会碰外部系统', async () => {
    const report = runDoctor(ledger.db, baseEnv(), { ledger_db_path: dbPath });
    assert.deepEqual(report.probes, [], '默认 doctor 只读本地台账，不做主动探测');
    assert.equal(hisStub.requests.length, 0, '默认 doctor 不得向 HIS 计费侧发任何请求');
    assert.equal(webhookStub.requests, 0, '默认 doctor 不得向推送侧发任何请求');
  });

  it('⑩ 探测用的是独立客户端：探测失败不会把守护进程在跑的熔断档位打乱', async () => {
    const failing = await startHisStub({ status: 503 });
    try {
      const env = baseEnv({ HIS_CHARGING_BASE_URL: failing.baseUrl });
      await probeOutboundCharge(probeOptions(env));
      // 熔断快照在台账 meta 里 —— 探测不写它
      const snapshot = ledger.db
        .prepare("SELECT value FROM meta WHERE key = 'charge_circuit'")
        .get() as { value: string } | undefined;
      assert.equal(snapshot, undefined, '探测不得改写守护进程的熔断状态');
    } finally {
      await failing.close();
    }
  });

  it('⑪ 空批次体检请求体就是那三个字段（逐字对齐出站规范）', () => {
    const body = buildEmptyProbeBody();
    assert.deepEqual(Object.keys(body).sort(), ['dept_code', 'operation_no', 'uses']);
    assert.deepEqual(body.uses, []);
    assert.equal(body.operation_no, '');
    assert.equal(body.dept_code, '');
  });
});
