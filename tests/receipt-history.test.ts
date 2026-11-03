/**
 * test_receipt_history：计费重投历史按条目追溯（每次 attempt 全量留痕）。
 *
 * 替身说明：这里的「HIS 计费替身」是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走**同一条代码路径**（原生 fetch → 真实 socket → 真实请求头 / 请求体），
 * 不 mock fetch、不注入假响应对象。
 *
 * 覆盖：
 *   ① **每次尝试留一行**：成功 / 业务拒绝 / 通道不可达三类都留痕（不得只记成功）；
 *   ② 三次尝试留下三行，尝试序号连续（1、2、3，不重号不跳号）；
 *   ③ 三种查询口径（按条目 / 按台次 / 按时间窗）条数一致；
 *   ④ 导出 CSV 行数 = 尝试数，字段白名单断言无患者标识；
 *   ⑤ fixture 样例（一条被拒 3 次后成功）台账与导出逐字一致；
 *   ⑥ 历史行回填：迁移 v21 补齐五要素并标注，回填不了的留空并标注。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';

import { HisChargingClient } from '../src/charge/client.js';
import { submitMaterialUses } from '../src/charge/submit.js';
import {
  CHARGE_RECEIPT_KINDS,
  countReceipts,
  listAttemptsInWindow,
  listOperationAttempts,
  loadReceipts,
  nextAttemptNumber,
} from '../src/charge/receipt.js';
import {
  ATTEMPT_HISTORY_EXPORT_FIELDS,
  attemptHistoryToCsv,
  attemptHistoryToJson,
  renderAttemptTimeline,
  summarizeAttemptHistory,
  toAttemptExportRows,
} from '../src/charge/attempt-history.js';
import {
  ChargeRetryScheduler,
  toMaterialUse,
  type ChargeItem,
  type ChargeSubmitFn,
} from '../src/charge/retry.js';
import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { MIGRATIONS, LATEST_SCHEMA_VERSION, applyMigrations } from '../src/ledger/migrations.js';
import { deriveIdempotencyKey } from '../src/domain/idempotency.js';
import { bindOne } from '../src/engine/binding.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');
const attemptHistoryCsv = readFileSync(
  resolve(fixturesDir, 'charge-attempt-history.csv'),
  'utf8',
);

const TOKEN = 'his-charging-token-plaintext-7c41';
const ENDPOINT_PATH = '/api/v1/material-uses';

const execFileAsync = promisify(execFile);

interface StubBehavior {
  status?: number;
  body?: string;
  delayMs?: number;
}

/** HIS 计费替身：真实 HTTP 服务，行为按队列逐次给出 */
class HisChargingStub {
  readonly requests: string[] = [];
  private readonly server: Server;
  private readonly behaviors: StubBehavior[] = [];
  baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.requests.push(Buffer.concat(chunks).toString('utf8'));
        const behavior = this.behaviors.shift() ?? {
          status: 200,
          body: JSON.stringify({ accepted: [], rejected: [] }),
        };
        const respond = (): void => {
          const status = behavior.status ?? 200;
          const body = behavior.body ?? JSON.stringify({ accepted: [], rejected: [] });
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(body);
        };
        if (behavior.delayMs && behavior.delayMs > 0) setTimeout(respond, behavior.delayMs);
        else respond();
      });
      res.on('error', () => {
        // 客户端超时后主动断开：忽略写回失败（替身侧）
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          resolvePromise();
          return;
        }
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        resolvePromise();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => {
      this.server.close(() => done());
    });
  }

  push(behavior: StubBehavior): void {
    this.behaviors.push(behavior);
  }

  reset(): void {
    this.requests.length = 0;
    this.behaviors.length = 0;
  }
}

const stub = new HisChargingStub();

before(async () => {
  await stub.start();
});

after(async () => {
  await stub.stop();
});

beforeEach(() => {
  stub.reset();
});

/** 每个用例一份干净的内存台账（主数据已导入） */
function freshLedger(): LedgerDb {
  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  return ledger;
}

/** 造一条已绑定（status = bound）的台账行 */
function bindMaterial(
  ledger: LedgerDb,
  material_code = 'MAT-SAMPLE-01',
  operation_no = 'OP-SAMPLE-001',
): void {
  const outcome = bindOne(ledger.db, {
    db: ledger.db,
    operation_no,
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    material_code,
    raw_code: material_code,
    quantity: 1,
  });
  assert.equal(outcome.bound, true, `前置条件：${material_code} 应绑上台次`);
}

function chargeItem(
  material_code = 'MAT-SAMPLE-01',
  operation_no = 'OP-SAMPLE-001',
): ChargeItem {
  return {
    material_code,
    operation_no,
    room_no: 'OR-01',
    dept_code: 'SURG-01',
    scanner_id: 'SCAN-GUN-07',
    quantity: 1,
    price_code: 'PR-SAMPLE-01',
    use_time: '2026-01-15T09:12:00.000Z',
    fee_category: '卫生材料',
    medical_insurance_class: '甲类',
    idempotency_key: deriveIdempotencyKey(material_code, operation_no),
    key_profile: 'v1',
  };
}

/** 接到真实出站客户端的投递函数（与生产同一条代码路径） */
function makeSubmit(timeoutMs = 2_000): ChargeSubmitFn {
  const client = new HisChargingClient({
    baseUrl: stub.baseUrl,
    token: TOKEN,
    timeoutMs,
    logger: () => {
      // 测试里不落日志
    },
  });
  return async (item: ChargeItem) =>
    submitMaterialUses(client, item.operation_no, item.dept_code, [toMaterialUse(item)], {
      path: ENDPOINT_PATH,
    });
}

/** 读 fixture 里的样例行（一条被拒 3 次后成功） */
interface FixtureRow {
  material_code: string;
  operation_no: string;
  attempt: number;
  expected_kind: string;
  expected_reason_code: string;
  expected_error_code: string;
  expected_channel_reachable: number;
  expected_accepted: boolean;
  expected_delivery_count: number;
}

function readFixture(): FixtureRow[] {
  const lines = attemptHistoryCsv
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((name, index) => {
      row[name] = cells[index] ?? '';
    });
    return {
      material_code: row['material_code']!,
      operation_no: row['operation_no']!,
      attempt: Number(row['attempt']),
      expected_kind: row['expected_kind']!,
      expected_reason_code: row['expected_reason_code']!,
      expected_error_code: row['expected_error_code']!,
      expected_channel_reachable: Number(row['expected_channel_reachable']),
      expected_accepted: row['expected_accepted'] === 'true',
      expected_delivery_count: Number(row['expected_delivery_count']),
    };
  });
}

describe('test_receipt_history · 每次尝试全量留痕', () => {
  it('成功、业务拒绝、通道不可达三类各留一行：不得只记成功', async () => {
    const ledger = freshLedger();
    try {
      // 四条耗材各走各的结局：接收成功 / 业务拒绝 / 对端 5xx / 通道超时
      bindMaterial(ledger, 'MAT-SAMPLE-01');
      bindMaterial(ledger, 'MAT-SAMPLE-02');
      bindMaterial(ledger, 'MAT-SAMPLE-03');
      bindMaterial(ledger, 'MAT-SAMPLE-05');

      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [{ material_code: 'MAT-SAMPLE-01' }], rejected: [] }),
      });
      stub.push({
        status: 200,
        body: JSON.stringify({
          accepted: [],
          rejected: [{ material_code: 'MAT-SAMPLE-02', reason_code: 'PRICE_CODE_NOT_FOUND' }],
        }),
      });
      stub.push({ status: 503, body: JSON.stringify({ message: 'service unavailable' }) });
      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [], rejected: [] }),
        delayMs: 400,
      });

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        // 第四条走短超时：制造「通道当时不可达」
        submit: async (item: ChargeItem) =>
          item.material_code === 'MAT-SAMPLE-05'
            ? makeSubmit(60)(item)
            : makeSubmit(2_000)(item),
        maxAttempts: 3,
        baseDelayMs: 0,
      });

      await scheduler.submit(chargeItem('MAT-SAMPLE-01'));
      await scheduler.submit(chargeItem('MAT-SAMPLE-02'));
      await scheduler.submit(chargeItem('MAT-SAMPLE-03'));
      await scheduler.submit(chargeItem('MAT-SAMPLE-05'));

      // 四次尝试 = 四行回执（成功那条也在，失败的三条同样在）
      assert.equal(countReceipts(ledger.db), 4, '成功与失败都要留行');

      const kinds = new Map<string, string>();
      for (const code of ['MAT-SAMPLE-01', 'MAT-SAMPLE-02', 'MAT-SAMPLE-03', 'MAT-SAMPLE-05']) {
        const rows = loadReceipts(ledger.db, code, 'OP-SAMPLE-001');
        assert.equal(rows.length, 1, `${code} 应留一行回执`);
        kinds.set(code, rows[0]!.kind ?? '');
      }

      assert.equal(kinds.get('MAT-SAMPLE-01'), CHARGE_RECEIPT_KINDS.accepted);
      assert.equal(kinds.get('MAT-SAMPLE-02'), CHARGE_RECEIPT_KINDS.business_rejected);
      assert.equal(kinds.get('MAT-SAMPLE-03'), CHARGE_RECEIPT_KINDS.channel_error);
      assert.equal(kinds.get('MAT-SAMPLE-05'), CHARGE_RECEIPT_KINDS.channel_unreachable);

      // 每一行都带齐五要素：尝试序号 / 请求时间 / 响应时间 / 错误码 / 通道可达性
      for (const code of ['MAT-SAMPLE-01', 'MAT-SAMPLE-02', 'MAT-SAMPLE-03', 'MAT-SAMPLE-05']) {
        const row = loadReceipts(ledger.db, code, 'OP-SAMPLE-001')[0]!;
        assert.equal(row.attempt, 1);
        assert.ok(row.requested_at, '请求时间必须留痕');
        assert.ok(row.responded_at, '响应时间必须留痕');
        assert.equal(typeof row.channel_reachable, 'boolean', '通道可达性必须留痕');
        assert.equal(row.attempt_source, 'native', '落库时原生记录的尝试序号标 native');
      }
    } finally {
      ledger.close();
    }
  });

  it('三次尝试留下三行且尝试序号连续（1、2、3）', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      stub.push({ status: 503, body: JSON.stringify({ message: 'boom' }) });
      stub.push({ status: 503, body: JSON.stringify({ message: 'boom' }) });
      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [{ material_code: 'MAT-SAMPLE-01' }], rejected: [] }),
      });

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 5,
        baseDelayMs: 0,
      });
      await scheduler.submit(chargeItem());
      await scheduler.retryDue();
      await scheduler.retryDue();

      const receipts = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      assert.equal(receipts.length, 3, '三次尝试 = 三行回执');
      assert.deepEqual(
        receipts.map((row) => row.attempt),
        [1, 2, 3],
        '尝试序号必须连续',
      );
      assert.deepEqual(
        receipts.map((row) => row.delivery_count),
        [1, 2, 3],
        '重投次数在回执里可见',
      );
      // 前两次失败也留痕（不是只记最后一次成功）
      assert.equal(receipts[0]!.accepted, false);
      assert.equal(receipts[1]!.accepted, false);
      assert.equal(receipts[2]!.accepted, true);
      assert.equal(receipts[0]!.error_code, 'ERR_CHARGE_HTTP_5XX');
    } finally {
      ledger.close();
    }
  });

  it('按条目 / 按台次 / 按时间窗三种查询口径条数一致', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      stub.push({ status: 503, body: JSON.stringify({ message: 'boom' }) });
      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [{ material_code: 'MAT-SAMPLE-01' }], rejected: [] }),
      });

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 5,
        baseDelayMs: 0,
      });
      await scheduler.submit(chargeItem());
      await scheduler.retryDue();

      const byItem = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      const byOperation = listOperationAttempts(ledger.db, 'OP-SAMPLE-001');
      const byWindow = listAttemptsInWindow(
        ledger.db,
        '2000-01-01T00:00:00.000Z',
        '2999-12-31T23:59:59.999Z',
      );

      assert.equal(byItem.length, 2);
      assert.equal(byOperation.length, 2, '按台次取应与按条目取一致');
      assert.equal(byWindow.length, 2, '按时间窗取应与按条目取一致');

      // 三个口径的内容逐条一致（顺序按各自口径排）
      const key = (row: { attempt: number; material_code: string }): string =>
        `${row.material_code}#${row.attempt}`;
      assert.deepEqual(
        byOperation.map(key).sort(),
        byItem.map(key).sort(),
      );
      assert.deepEqual(
        byWindow.map(key).sort(),
        byItem.map(key).sort(),
      );

      // 时间窗外取不到
      const empty = listAttemptsInWindow(
        ledger.db,
        '2000-01-01T00:00:00.000Z',
        '2000-01-02T00:00:00.000Z',
      );
      assert.equal(empty.length, 0, '窗外不该取到行');
    } finally {
      ledger.close();
    }
  });
});

describe('test_receipt_history · 导出与脱敏', () => {
  it('导出 CSV 行数等于尝试数，字段白名单断言无患者标识', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      stub.push({ status: 503, body: JSON.stringify({ message: 'boom' }) });
      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [{ material_code: 'MAT-SAMPLE-01' }], rejected: [] }),
      });

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 5,
        baseDelayMs: 0,
      });
      await scheduler.submit(chargeItem());
      await scheduler.retryDue();

      const receipts = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      const exportRows = toAttemptExportRows(receipts);
      assert.equal(exportRows.length, receipts.length, '导出行数 = 尝试数');

      const csv = attemptHistoryToCsv(receipts);
      const lines = csv.split('\n');
      assert.equal(lines[0], ATTEMPT_HISTORY_EXPORT_FIELDS.join(','), '表头逐字等于白名单');
      assert.equal(lines.length - 1, receipts.length, 'CSV 数据行数 = 尝试数');

      // 关键列逐行可核对：时间 / attempt / 结果 / 错误码 / 通道可达性
      const first = exportRows[0]!;
      assert.equal(first.attempt, 1);
      assert.equal(first.result, 'REJECTED');
      assert.equal(first.error_code, 'ERR_CHARGE_HTTP_5XX');
      assert.equal(first.channel_reachable, '1');
      assert.ok(first.requested_at);
      assert.ok(first.responded_at);
      assert.equal(exportRows[1]!.result, 'ACCEPTED');

      // 脱敏：导出字段与内容都不含患者标识
      const forbidden = /patient|患者|姓名|身份证|住院号|病案号|门诊号|证件/i;
      for (const field of ATTEMPT_HISTORY_EXPORT_FIELDS) {
        assert.equal(forbidden.test(field), false, `导出字段 ${field} 不该出现患者标识`);
      }
      assert.equal(forbidden.test(csv), false, 'CSV 内容不含患者标识');
      const json = attemptHistoryToJson(receipts);
      assert.equal(forbidden.test(json), false, 'JSON 内容不含患者标识');
      const parsed = JSON.parse(json) as { fields: string[]; rows: unknown[] };
      assert.deepEqual(parsed.fields, [...ATTEMPT_HISTORY_EXPORT_FIELDS]);
      assert.equal(parsed.rows.length, receipts.length);

      // 小结与终端可读版本
      const summaries = summarizeAttemptHistory(receipts);
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0]!.attempts, 2);
      assert.equal(summaries[0]!.charged, true);
      assert.match(summaries[0]!.conclusion_zh, /第 2 次已计费/);
      const timeline = renderAttemptTimeline(receipts);
      assert.match(timeline, /MAT-SAMPLE-01 \/ OP-SAMPLE-001/);
      assert.match(timeline, /#1/);
      assert.match(timeline, /#2/);
    } finally {
      ledger.close();
    }
  });

  it('fixture 样例（一条被拒 3 次后成功）：台账与导出逐字一致', async () => {
    const ledger = freshLedger();
    try {
      const fixture = readFixture();
      assert.equal(fixture.length, 4, 'fixture 应描述 4 次尝试');
      const material = fixture[0]!.material_code;
      const operation = fixture[0]!.operation_no;
      bindMaterial(ledger, material, operation);

      // ① 对端限流（可重投）→ ② 通道超时 → ③ 对端繁忙（可重投）→ ④ 接收成功
      stub.push({
        status: 200,
        body: JSON.stringify({
          accepted: [],
          rejected: [{ material_code: material, reason_code: 'PEER_RATE_LIMITED' }],
        }),
      });
      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [], rejected: [] }),
        delayMs: 400,
      });
      stub.push({
        status: 200,
        body: JSON.stringify({
          accepted: [],
          rejected: [{ material_code: material, reason_code: 'PEER_SERVICE_BUSY' }],
        }),
      });
      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [{ material_code: material }], rejected: [] }),
      });

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: async (item: ChargeItem) =>
          item.idempotency_key === deriveIdempotencyKey(material, operation)
            ? makeSubmit(60)(item)
            : makeSubmit(2_000)(item),
        maxAttempts: 8,
        baseDelayMs: 0,
      });

      await scheduler.submit(chargeItem(material, operation));
      await scheduler.retryDue();
      await scheduler.retryDue();
      await scheduler.retryDue();

      const receipts = loadReceipts(ledger.db, material, operation);
      assert.equal(receipts.length, fixture.length, '台账尝试数 = fixture 行数');

      const exportRows = toAttemptExportRows(receipts);
      fixture.forEach((expected, index) => {
        const row = receipts[index]!;
        const exported = exportRows[index]!;
        assert.equal(row.attempt, expected.attempt, `第 ${expected.attempt} 次尝试序号`);
        assert.equal(row.kind, expected.expected_kind);
        assert.equal(row.reason_code ?? '', expected.expected_reason_code);
        assert.equal(row.error_code ?? '', expected.expected_error_code);
        assert.equal(row.channel_reachable ? 1 : 0, expected.expected_channel_reachable);
        assert.equal(row.accepted, expected.expected_accepted);
        assert.equal(row.delivery_count, expected.expected_delivery_count);
        // 导出行与台账行一致
        assert.equal(exported.attempt, expected.attempt);
        assert.equal(exported.kind, expected.expected_kind);
        assert.equal(exported.error_code, expected.expected_error_code);
        assert.equal(exported.result, expected.expected_accepted ? 'ACCEPTED' : 'REJECTED');
      });

      // 最后一次成功 → 小结说「已计费」
      const summaries = summarizeAttemptHistory(receipts);
      assert.equal(summaries[0]!.charged, true);
      assert.equal(summaries[0]!.attempts, 4);
      assert.equal(summaries[0]!.unreachable_count, 1, '有一次通道不可达');
    } finally {
      ledger.close();
    }
  });
});

describe('test_receipt_history · 运维 CLI 出口', () => {
  it('attempts 子命令：终端可读版与 CSV 导出都能跑，且不含患者标识', async () => {
    // 用**文件库**：CLI 是独立进程，读不到内存库
    const workDir = mkdtempSync(join(tmpdir(), 'material-scan-attempts-'));
    const dbPath = resolve(workDir, 'ledger.db');
    const ledger = openLedger(dbPath);
    try {
      importMasterData(ledger.db, { operationsCsv, materialsCsv });
      bindMaterial(ledger);
      stub.push({ status: 503, body: JSON.stringify({ message: 'boom' }) });
      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [{ material_code: 'MAT-SAMPLE-01' }], rejected: [] }),
      });
      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 5,
        baseDelayMs: 0,
      });
      await scheduler.submit(chargeItem());
      await scheduler.retryDue();
    } finally {
      ledger.close();
    }

    try {
      const env = { ...process.env, LEDGER_DB_PATH: dbPath };

      // 终端可读版
      const table = await execFileAsync(
        process.execPath,
        [resolve(projectRoot, 'dist', 'cli.js'), 'attempts', '--db', dbPath],
        { env, cwd: projectRoot },
      );
      assert.match(table.stdout, /计费尝试史/);
      assert.match(table.stdout, /MAT-SAMPLE-01/);
      assert.match(table.stdout, /第 2 次已计费/);
      assert.match(table.stdout, /ERR_CHARGE_HTTP_5XX/);

      // CSV 导出
      const outPath = resolve(workDir, 'attempts.csv');
      const csv = await execFileAsync(
        process.execPath,
        [
          resolve(projectRoot, 'dist', 'cli.js'),
          'attempts',
          '--db',
          dbPath,
          '--format',
          'csv',
          '--out',
          outPath,
        ],
        { env, cwd: projectRoot },
      );
      assert.match(csv.stdout, /已导出 2 次尝试/);
      const csvText = readFileSync(outPath, 'utf8');
      const lines = csvText.split('\n').filter((line) => line.trim().length > 0);
      assert.equal(lines[0], ATTEMPT_HISTORY_EXPORT_FIELDS.join(','));
      assert.equal(lines.length - 1, 2, '导出行数 = 尝试数');
      assert.equal(
        /patient|患者|姓名|身份证|住院号|病案号/i.test(csvText),
        false,
        '导出不含患者标识',
      );

      // 帮助里能看到这个子命令
      const help = await execFileAsync(
        process.execPath,
        [resolve(projectRoot, 'dist', 'cli.js'), '--help'],
        { env, cwd: projectRoot },
      );
      assert.ok(help.stdout.includes('attempts'));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('test_receipt_history · 历史行回填与标注', () => {
  it('迁移 v21：历史行回填尝试序号与时间并标注；回填不了的留空并标注', () => {
    const ledger = openLedger(':memory:');
    try {
      const db = ledger.db;
      // 造三条「老库写法」的行：尝试序号一律 1（列默认值），请求/响应时间没记，
      // 归类档位与通道可达性也没记 —— 这些正是回填要补的。
      const createdAt = '2026-01-15T09:00:00.000Z';
      for (let index = 0; index < 3; index += 1) {
        db.prepare(
          `INSERT INTO charge_receipt
             (material_code, operation_no, attempt, accepted, kind, reason_code, error_code,
              channel_reachable, requested_at, responded_at, response_summary, created_at)
           VALUES (?, ?, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
        ).run('MAT-SAMPLE-01', 'OP-SAMPLE-001', createdAt);
      }

      // 把库拨回 v20（模拟「升级前的老库」），再跑一次迁移链
      db.exec('PRAGMA user_version = 20');
      db.prepare('DELETE FROM migrations WHERE version = 21').run();

      const result = applyMigrations(db);
      assert.equal(result.from, 20);
      // 链尾版本随新迁移推进：断言「v21 回填迁移被应用」，不把版本号钉死
      assert.equal(result.to, LATEST_SCHEMA_VERSION);
      assert.ok(
        result.applied.some((row) => row.name === 'receipt_attempt_history'),
        'v21 回填迁移必须被应用',
      );

      const rows = loadReceipts(db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      assert.equal(rows.length, 3);
      // 尝试序号按落账顺序回填成 1、2、3（老库全是 1）
      assert.deepEqual(
        rows.map((row) => row.attempt),
        [1, 2, 3],
      );
      rows.forEach((row, index) => {
        assert.equal(row.attempt_source, 'recovered', '回填的行标 recovered');
        assert.ok(row.history_note, '回填的行要留中文备注');
        assert.match(row.history_note!, /请求时间按落账时间补记/);
        assert.match(row.history_note!, /响应时间按落账时间补记/);
        // 回填不了的留空并标注（不编造）
        assert.equal(row.channel_reachable, null, '推不出来的通道可达性留空');
        assert.match(row.history_note!, /通道可达性无法回填（留空）/);
        assert.match(row.history_note!, /历史行未记录归类档位/);
        assert.equal(row.requested_at, createdAt, '请求时间按落账时间补记');
        assert.equal(row.responded_at, createdAt, '响应时间按落账时间补记');
        // 第一行序号本来就对得上（1 == 1），后两行才需要回填 —— 备注按实际动作写
        if (index === 0) {
          assert.equal(row.history_note!.includes('尝试序号按落账顺序回填'), false);
        } else {
          assert.match(row.history_note!, /尝试序号按落账顺序回填/);
        }
      });
    } finally {
      ledger.close();
    }
  });

  it('回填不了的字段留空并标注，不编造错误码', () => {
    const ledger = openLedger(':memory:');
    try {
      const db = ledger.db;
      db.prepare(
        `INSERT INTO charge_receipt
           (material_code, operation_no, attempt, accepted, kind, reason_code, error_code,
            channel_reachable, requested_at, responded_at, response_summary, created_at)
         VALUES (?, ?, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      ).run('MAT-SAMPLE-02', 'OP-SAMPLE-002', '2026-01-15T09:00:00.000Z');

      const v21 = MIGRATIONS.find((m) => m.version === 21)!;
      v21.up(db);

      const row = db
        .prepare(
          `SELECT attempt_source, history_note, error_code, channel_reachable, requested_at
             FROM charge_receipt WHERE material_code = 'MAT-SAMPLE-02'`,
        )
        .get() as {
        attempt_source: string;
        history_note: string;
        error_code: string | null;
        channel_reachable: number | null;
        requested_at: string | null;
      };
      assert.equal(row.attempt_source, 'recovered');
      assert.equal(row.error_code, null, '没有的错误码不许编造');
      assert.equal(row.channel_reachable, null, '推不出来的通道可达性留空');
      assert.match(row.history_note!, /通道可达性无法回填（留空）/);
      assert.match(row.history_note!, /历史行未记录归类档位/);
      assert.ok(row.requested_at, '落账时间可作补记依据');

      // 幂等：再跑一遍不重复改
      const before = db
        .prepare('SELECT * FROM charge_receipt WHERE material_code = ?')
        .get('MAT-SAMPLE-02') as Record<string, unknown>;
      v21.up(db);
      const after = db
        .prepare('SELECT * FROM charge_receipt WHERE material_code = ?')
        .get('MAT-SAMPLE-02') as Record<string, unknown>;
      assert.deepEqual(after, before, '迁移重跑不改动已有行');
    } finally {
      ledger.close();
    }
  });

  it('原生记录的行标 native，迁移不回填它', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      stub.push({
        status: 200,
        body: JSON.stringify({ accepted: [{ material_code: 'MAT-SAMPLE-01' }], rejected: [] }),
      });
      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      await scheduler.submit(chargeItem());

      const row = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001')[0]!;
      assert.equal(row.attempt_source, 'native');
      assert.equal(row.history_note, null);

      // 下一条尝试序号从台账现读（不重号）
      assert.equal(nextAttemptNumber(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001'), 2);
    } finally {
      ledger.close();
    }
  });
});
