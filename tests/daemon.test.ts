/**
 * 部署与进程管理的验收用例：启动自检、心跳、优雅停机、交付形态文件。
 *
 * 这一组用例回答四个问题：
 *   ① **缺凭据位会不会拒绝启动** —— 会，而且指名到变量名（子进程实跑验退出码与 stderr）；
 *   ② **心跳写没写、写得齐不齐** —— 字段齐全、每周期更新、doctor 与 healthcheck 读得到；
 *   ③ **收到 SIGTERM 会不会把在途批次砍掉** —— 不会：在途批次结算完、退出码 0、
 *      台账状态推进到已计费（子进程实跑 + 真实 HTTP 计费替身）；
 *   ④ **交付形态文件在不在** —— systemd unit / Dockerfile / compose 三件套齐全且含关键字段。
 *
 * 计费替身是 `tests/support/fake-his-server.ts`（**真实 HTTP 服务**，与生产客户端同一条
 * fetch 代码路径）：它延迟 900ms 响应，正好制造「SIGTERM 到达时计费回写还在路上」的窗口。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { openLedger, LEDGER_SCHEMA_VERSION } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { getMeta } from '../src/ledger/meta.js';
import { formatSignatureHeader } from '../src/ingest/signature.js';
import { newNonce } from '../src/ingest/replay-guard.js';
import {
  buildHeartbeat,
  formatHeartbeat,
  isHeartbeatFresh,
  readHeartbeat,
  writeHeartbeat,
} from '../src/daemon/heartbeat.js';
import {
  formatStartupCheckResult,
  runStartupChecks,
  STARTUP_CHECK_ERROR_CODE,
} from '../src/daemon/startup-check.js';
import { createInFlightTracker, waitForIdle } from '../src/daemon/shutdown.js';
import { runDoctor } from '../src/cli/commands.js';
import { startFakeHisServer, type FakeHisServer } from './support/fake-his-server.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');
const daemonEntry = resolve(projectRoot, 'dist', 'daemon.js');
const healthcheckEntry = resolve(projectRoot, 'dist', 'scripts', 'healthcheck.js');

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor<T>(
  probe: () => T | null | undefined | false,
  timeoutMs = 8_000,
  intervalMs = 25,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value as T;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待超时（${timeoutMs}ms）：条件一直没满足`);
    }
    await sleep(intervalMs);
  }
}

/** 找一个当前空闲的端口（起一个监听再关掉） */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** 一套齐备的三路凭据（值是测试用的假凭据，不连任何真实系统） */
function fullEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    OR_SCANNER_BASE_URL: 'https://scanner.example.internal',
    OR_SCANNER_TOKEN: 'test-scanner-token',
    OR_SCANNER_SECRET: 'test-scanner-secret',
    HIS_CHARGING_BASE_URL: 'https://his.example.internal',
    HIS_CHARGING_TOKEN: 'test-his-token',
    WECOM_WEBHOOK_URL: 'https://wecom.example.internal/cgi-bin/webhook/send?key=test',
    WECOM_SECRET: 'test-wecom-secret',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

describe('启动自检', () => {
  test('缺 HIS_CHARGING_TOKEN 时自检不通过并指名变量名', () => {
    const dir = makeTempDir('msb-check-');
    const result = runStartupChecks({
      env: fullEnv({ HIS_CHARGING_TOKEN: undefined }),
      ledgerDbPath: resolve(dir, 'ledger.db'),
      scanInboxDir: resolve(dir, 'scan-inbox'),
    });

    assert.equal(result.ok, false);
    assert.equal(result.error_code, STARTUP_CHECK_ERROR_CODE);

    const outbound = result.items.find((item) => item.name.includes('出站 HIS 计费'));
    assert.ok(outbound, '应当有出站通道的自检项');
    assert.equal(outbound.ok, false);
    assert.deepEqual(outbound.missing_vars, ['HIS_CHARGING_TOKEN']);
    assert.match(outbound.detail, /HIS_CHARGING_TOKEN/);

    // 渲染出来的那段话要能照着改：点名变量名 + 明说拒绝启动
    const text = formatStartupCheckResult(result);
    assert.match(text, /Missing required environment variable: HIS_CHARGING_TOKEN/);
    assert.match(text, /拒绝启动/);
    // 其余两路不受影响
    assert.equal(result.items.find((item) => item.name.includes('入站扫码网关'))?.ok, true);
    assert.equal(result.items.find((item) => item.name.includes('企业微信推送'))?.ok, true);
  });

  test('凭据齐备且目录可用时自检通过', () => {
    const dir = makeTempDir('msb-check-ok-');
    const result = runStartupChecks({
      env: fullEnv(),
      ledgerDbPath: resolve(dir, 'ledger.db'),
      scanInboxDir: resolve(dir, 'scan-inbox'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.error_code, '');
    assert.ok(result.items.every((item) => item.ok));
  });

  test('台账库版本高于本程序时拒绝启动', () => {
    const dir = makeTempDir('msb-check-version-');
    const dbPath = resolve(dir, 'ledger.db');
    const ledger = openLedger(dbPath);
    ledger.db.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION + 3}`);
    ledger.close();

    const result = runStartupChecks({
      env: fullEnv(),
      ledgerDbPath: dbPath,
      scanInboxDir: resolve(dir, 'scan-inbox'),
    });
    assert.equal(result.ok, false);
    const versionItem = result.items.find((item) => item.name === '台账库版本');
    assert.ok(versionItem);
    assert.equal(versionItem.ok, false);
    assert.match(versionItem.detail, /高于本程序支持的/);
  });

  test('子进程实跑：缺 HIS_CHARGING_TOKEN 时退出码非 0 且 stderr 指名变量名', async () => {
    const dir = makeTempDir('msb-proc-missing-');
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...fullEnv({ HIS_CHARGING_TOKEN: undefined }),
      LEDGER_DB_PATH: resolve(dir, 'ledger.db'),
      SCAN_INBOX_DIR: resolve(dir, 'scan-inbox'),
    };
    delete env['HIS_CHARGING_TOKEN'];

    const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((done) => {
      const child = spawn(process.execPath, [daemonEntry], { env, cwd: projectRoot });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('close', (code) => done({ code, stderr, stdout }));
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Missing required environment variable: HIS_CHARGING_TOKEN/);
    assert.match(result.stderr, /拒绝启动/);
  });
});

describe('心跳', () => {
  test('心跳记录字段齐全、可读回、每周期更新', async () => {
    const dir = makeTempDir('msb-heartbeat-');
    const ledger = openLedger(resolve(dir, 'ledger.db'));
    const db = ledger.db;

    const first = buildHeartbeat({
      db,
      startedAtMs: Date.now() - 5_000,
      nowMs: Date.now(),
      channels: { inbound: true, outbound: true, notify: false },
    });
    writeHeartbeat(db, first);

    const read = readHeartbeat(db);
    assert.ok(read, '心跳应当读得回来');
    assert.equal(read.version, first.version);
    assert.equal(read.uptime_s, first.uptime_s);
    assert.equal(read.ledger_rows, 0);
    assert.equal(read.pending_check, 0);
    assert.equal(read.last_event_at, null);
    assert.equal(read.channels.inbound, true);
    assert.equal(read.channels.outbound, true);
    assert.equal(read.channels.notify, false);
    assert.ok(read.written_at.length > 0);

    // 再写一条：内容更新，写入时刻前进
    await sleep(5);
    const second = buildHeartbeat({
      db,
      startedAtMs: Date.now() - 10_000,
      nowMs: Date.now(),
      channels: { inbound: true, outbound: true, notify: true },
    });
    writeHeartbeat(db, second);
    const readSecond = readHeartbeat(db);
    assert.ok(readSecond);
    assert.equal(readSecond.channels.notify, true);
    assert.ok(
      Date.parse(readSecond.written_at) >= Date.parse(read.written_at),
      '心跳写入时刻应当前进',
    );
    assert.ok(readSecond.uptime_s >= read.uptime_s);

    // 展示口径：doctor 与 healthcheck 共用同一份文字
    assert.match(formatHeartbeat(readSecond), /版本/);
    assert.match(formatHeartbeat(readSecond), /待核查/);
    ledger.close();
  });

  test('心跳不新鲜时判为不健康', () => {
    const dir = makeTempDir('msb-heartbeat-stale-');
    const ledger = openLedger(resolve(dir, 'ledger.db'));
    const record = buildHeartbeat({
      db: ledger.db,
      startedAtMs: Date.now() - 600_000,
      nowMs: Date.now() - 600_000,
      channels: { inbound: true, outbound: true, notify: true },
    });
    assert.equal(isHeartbeatFresh(record, Date.now(), 90_000), false);
    assert.equal(isHeartbeatFresh(record, Date.now(), 900_000), true);
    assert.equal(isHeartbeatFresh(null, Date.now(), 90_000), false);
    ledger.close();
  });

  test('doctor 能读到心跳', () => {
    const dir = makeTempDir('msb-doctor-heartbeat-');
    const ledger = openLedger(resolve(dir, 'ledger.db'));
    const record = buildHeartbeat({
      db: ledger.db,
      startedAtMs: Date.now(),
      nowMs: Date.now(),
      channels: { inbound: true, outbound: true, notify: true },
    });
    writeHeartbeat(ledger.db, record);

    const report = runDoctor(ledger.db, fullEnv(), { ledger_db_path: 'ledger.db' });
    assert.ok(report.heartbeat, 'doctor 应当读得到心跳');
    assert.equal(report.heartbeat.version, record.version);
    ledger.close();
  });

  test('心跳探针：心跳新鲜退出码 0，缺心跳退出码非 0', async () => {
    const dir = makeTempDir('msb-healthcheck-');
    const dbPath = resolve(dir, 'ledger.db');
    const ledger = openLedger(dbPath);
    const record = buildHeartbeat({
      db: ledger.db,
      startedAtMs: Date.now(),
      nowMs: Date.now(),
      channels: { inbound: true, outbound: true, notify: true },
    });
    writeHeartbeat(ledger.db, record);
    ledger.close();

    const fresh = await runHealthcheck(['--db', dbPath, '--max-age', '90000']);
    assert.equal(fresh.code, 0, `心跳新鲜时期望退出码 0，实际 ${fresh.code}：${fresh.stderr}`);
    assert.match(fresh.stdout, /健康/);

    const missing = await runHealthcheck(['--db', resolve(dir, 'not-exist.db')]);
    assert.notEqual(missing.code, 0);
  });
});

describe('优雅停机', () => {
  test('在途批次计数与等待（超时如实报告，不无限等）', async () => {
    const tracker = createInFlightTracker();
    tracker.begin();
    tracker.begin();
    assert.equal(tracker.count(), 2);
    tracker.end();
    assert.equal(tracker.count(), 1);
    tracker.end();
    assert.equal(tracker.count(), 0);

    const drained = await waitForIdle(tracker, 500);
    assert.equal(drained.drained, true);
    assert.equal(drained.remaining, 0);

    // 永远不结束的在途：超时后如实返回，不无限等
    tracker.begin();
    const timedOut = await waitForIdle(tracker, 60);
    assert.equal(timedOut.drained, false);
    assert.equal(timedOut.remaining, 1);
  });

  test('子进程实跑：SIGTERM 后在途计费回写结算完，退出码 0', async () => {
    const dir = makeTempDir('msb-daemon-');
    const dbPath = resolve(dir, 'ledger.db');
    const inboxDir = resolve(dir, 'scan-inbox');
    mkdirSync(inboxDir, { recursive: true });

    // 先把院内主数据导进台账（台次 + 耗材），守护进程才有东西可绑
    const seed = openLedger(dbPath);
    importMasterData(seed.db, {
      operationsCsv: readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8'),
      materialsCsv: readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8'),
    });
    seed.close();

    // 计费替身延迟 900ms 响应：制造「SIGTERM 到达时回写还在路上」的窗口
    let fake: FakeHisServer | null = null;
    fake = await startFakeHisServer({ delayMs: 900 });
    const port = await freePort();

    const env = {
      ...process.env,
      ...fullEnv({
        HIS_CHARGING_BASE_URL: fake.baseUrl,
        WECOM_WEBHOOK_URL: `${fake.baseUrl}/cgi-bin/webhook/send?key=test`,
      }),
      LEDGER_DB_PATH: dbPath,
      SCAN_INBOX_DIR: inboxDir,
      HTTP_PORT: String(port),
      DAEMON_HTTP_HOST: '127.0.0.1',
      DAEMON_POLL_INTERVAL_MS: '100',
      DAEMON_HEARTBEAT_INTERVAL_MS: '200',
      DAEMON_SHUTDOWN_TIMEOUT_MS: '10000',
    };

    const child = spawn(process.execPath, [daemonEntry], { env, cwd: projectRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    try {
      // ① 等守护进程起来（stdout 打印监听地址）
      await waitFor(() => stdout.includes('/api/v1/scan-events'), 10_000);

      // ② 心跳开始写 —— 证明常驻进程在按周期写状态
      const ledgerWatch = openLedger(dbPath);
      await waitFor(() => readHeartbeat(ledgerWatch.db), 5_000);
      ledgerWatch.close();

      // ③ 投一批 2 条能绑上的耗材
      const rawBody = JSON.stringify({
        operation_no: 'OP-SAMPLE-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-GUN-07',
        scans: [
          { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00+08:00', batch_no: 'LOT-SAMPLE-A' },
          { material_code: 'MAT-SAMPLE-02', quantity: 2, scan_time: '2026-01-15T09:13:10+08:00', batch_no: 'LOT-SAMPLE-B' },
        ],
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = newNonce();
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/scan-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-scanner-token',
          'x-scan-timestamp': timestamp,
          'x-scan-nonce': nonce,
          'x-scan-signature': formatSignatureHeader(timestamp, nonce, rawBody, 'test-scanner-secret'),
        },
        body: rawBody,
      });
      const body = (await response.json()) as { accepted: unknown[]; rejected: unknown[] };
      assert.equal(response.status, 200);
      assert.equal(body.accepted.length, 2);
      assert.equal(body.rejected.length, 0);

      // ④ 等计费替身收到这次回写 —— 此刻守护进程正卡在在途的出站请求上
      await waitFor(() => fake.requests.length > 0, 10_000);

      // ⑤ 在途还没结束就发 SIGTERM
      child.kill('SIGTERM');

      const exit = await new Promise<{ code: number | null; signal: string | null }>((done) => {
        child.on('close', (code, signal) => done({ code, signal }));
      });

      // ⑥ 退出码 0（正常停机不是故障），且不是被信号打死
      assert.equal(exit.code, 0, `期望退出码 0，实际 ${exit.code}/${exit.signal}；stderr：${stderr}`);
      assert.equal(exit.signal, null);

      // ⑦ 在途批次结算完了：台账行推进到已计费，替身确实收到了这一笔
      const ledger = openLedger(dbPath);
      const rows = ledger.db
        .prepare('SELECT material_code, status FROM material_binding ORDER BY material_code ASC')
        .all() as unknown as Array<{ material_code: string; status: string }>;
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((row) => row.status),
        ['charged', 'charged'],
        '在途的计费回写必须结算完（不能停在半路）',
      );
      const receipts = ledger.db
        .prepare('SELECT COUNT(*) AS n FROM charge_receipt')
        .get() as { n: number };
      assert.equal(receipts.n, 2, '两条耗材各留一条回执行');

      // ⑧ 停机记录落库（可回看停机结论）
      const stopMeta = getMeta(ledger.db, 'daemon.stop');
      assert.ok(stopMeta, '应当有停机记录');
      const stop = JSON.parse(stopMeta.value) as {
        reason: string;
        drained: boolean;
        remaining: number;
      };
      assert.equal(stop.reason, 'SIGTERM');
      assert.equal(stop.drained, true, '在途批次应当已结算完');
      assert.equal(stop.remaining, 0);
      ledger.close();

      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0]?.operation_no, 'OP-SAMPLE-001');
      assert.equal(fake.duplicateChargeCount, 0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await fake.close();
    }
  });
});

describe('交付形态文件', () => {
  test('systemd unit 含常驻、日志、凭据文件与停机信号', () => {
    const path = resolve(projectRoot, 'deploy', 'material-scan-billing.service');
    assert.ok(existsSync(path), 'deploy/material-scan-billing.service 应当存在');
    const text = readFileSync(path, 'utf8');
    assert.match(text, /\[Unit\]/);
    assert.match(text, /\[Service\]/);
    assert.match(text, /\[Install\]/);
    assert.match(text, /Restart=always/);
    assert.match(text, /RestartSec=/);
    assert.match(text, /WorkingDirectory=/);
    assert.match(text, /EnvironmentFile=-\/etc\/chaosforge\/material-scan-billing\.env/);
    assert.match(text, /ExecStart=.*node dist\/daemon\.js/);
    assert.match(text, /KillSignal=SIGTERM/);
    assert.match(text, /TimeoutStopSec=/);
    assert.match(text, /StandardOutput=journal/);
    assert.match(text, /StandardError=journal/);
    assert.match(text, /WantedBy=multi-user\.target/);
  });

  test('Dockerfile 用 Node 22 slim、默认非 root、健康检查走心跳探针', () => {
    const path = resolve(projectRoot, 'Dockerfile');
    assert.ok(existsSync(path), 'Dockerfile 应当存在');
    const text = readFileSync(path, 'utf8');
    assert.match(text, /FROM node:22-slim/);
    assert.match(text, /USER node/);
    assert.match(text, /HEALTHCHECK/);
    assert.match(text, /healthcheck\.js/);
    assert.match(text, /ENTRYPOINT \["node", "dist\/daemon\.js"\]/);
    assert.match(text, /STOPSIGNAL SIGTERM/);
  });

  test('compose 含状态卷、env_file 与 healthcheck', () => {
    const path = resolve(projectRoot, 'deploy', 'docker-compose.yml');
    assert.ok(existsSync(path), 'deploy/docker-compose.yml 应当存在');
    const text = readFileSync(path, 'utf8');
    assert.match(text, /env_file:/);
    assert.match(text, /material-scan-billing\.env/);
    assert.match(text, /volumes:/);
    assert.match(text, /\.\/data:\/var\/lib\/material-scan-billing/);
    assert.match(text, /healthcheck:/);
    assert.match(text, /healthcheck\.js/);
    assert.match(text, /stop_grace_period:/);
  });
});

/** 跑一次心跳探针，返回退出码与输出 */
async function runHealthcheck(
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [healthcheckEntry, ...args], { cwd: projectRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}
