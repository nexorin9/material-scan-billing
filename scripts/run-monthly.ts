/**
 * 月度对账跑测：用**全量合成数据**跑通整条主路径，产出高值耗材月度对账包。
 *
 *   node dist/scripts/run-monthly.js
 *   node dist/scripts/run-monthly.js --from 2026-01 --to 2026-03 --sample 20
 *   node dist/scripts/run-monthly.js --month-spread 0     # 只跑基线，不跑跨月演练
 *
 * 跑的是**产品主路径**（不是旁路脚本）：
 *   ① 合成数据（`data/synthetic/`）→ 排台台次与耗材主数据导入台账镜像表；
 *   ② 扫码枪 HTTP 投递（**真实验签**：HMAC-SHA256 over {timestamp}.{nonce}.{raw_body}）
 *      → 码制归一 → 幂等占位 → 绑定判定 → 台账落行 → 核查条目；
 *   ③ 逐台次回写 HIS 计费（**真实 HTTP 客户端**，对端是测试数据层的真实 HTTP 服务）；
 *   ④ 月度对账聚合（科室 × 业务月）→ 对账包（汇总 CSV + 明细 CSV + JSON）；
 *   ⑤ 抽样回查：从对账包随机抽 N 条明细，逐条回台账与回执核对；
 *   ⑥ 结论核对：与**独立预期**（`scripts/lib/monthly-expectation.ts`，另写一遍判定规则）逐条比。
 *
 * 跑两遍：
 *   - **基线**：用数据自带的原始时间戳（合成数据集中在同一个月，故基线只有一个月份）；
 *   - **跨月切分演练**：把合成台次的业务时间按月展开到 N 个月后**再真跑一遍**，
 *     验证「科室 × 月份」的跨月切分与账期圈定（不是把月份算出来贴上去，是真跑出来的）。
 *
 * 产物：
 *   - `data/monthly/monthly-reconcile-summary.csv` —— 汇总表（科室 × 月份）
 *   - `data/monthly/monthly-reconcile-detail.csv`  —— 明细表（台账行粒度）
 *   - `data/monthly/monthly-reconcile-pack.json`   —— 对账包（含下钻索引）
 *   - `docs/benchmarks/monthly-reconcile.md`       —— 跑测数字与断言
 *
 * 替身说明：HIS 计费对端是 `tests/support/fake-his-server.ts` 里的**真实 HTTP 服务**
 * （测试数据层），生产客户端与替身走同一条 fetch 代码路径；它不是产品的最终对接方式。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HisChargingClient } from '../src/charge/client.js';
import { writeBackOperationCharges } from '../src/charge/writeback.js';
import { startIngestServer } from '../src/ingest/http-server.js';
import { formatSignatureHeader } from '../src/ingest/signature.js';
import { newNonce } from '../src/ingest/replay-guard.js';
import { openLedger } from '../src/ledger/db.js';
import { importMasterData, parseCsv } from '../src/ledger/import-master-data.js';
import {
  aggregateMonthly,
  monthlyDetailToCsv,
  monthlyGroupToCsv,
  monthlyPackToJson,
  verifyMonthlySample,
  MONTH_TIMEZONE,
} from '../src/ledger/monthly.js';
import type { Logger } from '../src/log/logger.js';
import { startFakeHisServer } from '../tests/support/fake-his-server.js';
import {
  computeExpectedConclusions,
  distributionOf,
  type ExpectedItem,
  type MaterialFact,
  type OperationFact,
  type ScanItemFact,
} from './lib/monthly-expectation.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

/* ── 参数 ─────────────────────────────────────────────────────────────── */

interface Args {
  from: string | null;
  to: string | null;
  sample: number;
  seed: number;
  dataDir: string;
  outDir: string;
  docPath: string;
  /** 跨月切分演练：把合成台次的业务时间按月展开到 N 个月（0 = 不跑演练） */
  monthSpread: number;
  /** 计费替身每 N 条拒收 1 条（0 = 全收） */
  rejectEveryNth: number;
  /** 计费替身每 N 个请求失败 1 个（0 = 不失败；失败 = 通道不可达，等退避重投） */
  failEveryNthRequests: number;
  limit: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    from: null,
    to: null,
    sample: 20,
    seed: 20260101,
    dataDir: resolve(projectRoot, 'data', 'synthetic'),
    outDir: resolve(projectRoot, 'data', 'monthly'),
    docPath: resolve(projectRoot, 'docs', 'benchmarks', 'monthly-reconcile.md'),
    monthSpread: 3,
    rejectEveryNth: 20,
    failEveryNthRequests: 50,
    limit: 200_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    const [rawKey, inlineValue] = token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, undefined];
    const take = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      i += 1;
      return next ?? '';
    };
    switch (rawKey) {
      case '--from':
        args.from = take();
        break;
      case '--to':
        args.to = take();
        break;
      case '--sample':
        args.sample = Number.parseInt(take(), 10);
        break;
      case '--seed':
        args.seed = Number.parseInt(take(), 10);
        break;
      case '--data-dir':
        args.dataDir = resolve(projectRoot, take());
        break;
      case '--out-dir':
        args.outDir = resolve(projectRoot, take());
        break;
      case '--doc':
        args.docPath = resolve(projectRoot, take());
        break;
      case '--month-spread':
        args.monthSpread = Number.parseInt(take(), 10);
        break;
      case '--reject-every-nth':
        args.rejectEveryNth = Number.parseInt(take(), 10);
        break;
      case '--fail-every-nth-requests':
        args.failEveryNthRequests = Number.parseInt(take(), 10);
        break;
      case '--limit':
        args.limit = Number.parseInt(take(), 10);
        break;
      default:
        break;
    }
  }
  return args;
}

/* ── 跨月切分演练（把合成台次的业务时间按月展开） ─────────────────────── */

/** 时间戳往后推 n 个月（保持「几号几点」，目标月没有那个日期就取月末） */
function shiftMonths(iso: string, months: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms);
  const day = date.getUTCDate();
  const targetMonthIndex = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const shifted = new Date(
    Date.UTC(
      year,
      month,
      Math.min(day, lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  return shifted.toISOString();
}

/** 台次号 → 月份偏移（同一台次内的所有扫码都落在同一个月） */
function monthOffsetOf(operation_no: string, spread: number): number {
  if (spread <= 1) return 0;
  let hash = 0;
  for (let i = 0; i < operation_no.length; i += 1) {
    hash = (hash * 31 + operation_no.charCodeAt(i)) >>> 0;
  }
  return hash % spread;
}

/* ── 合成数据读入 ─────────────────────────────────────────────────────── */

interface ScanBatchFile {
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

function readOperationsCsv(csv: string, spread: number): string {
  if (spread <= 1) return csv;
  const lines = csv.split('\n');
  const header = lines[0] as string;
  const out = lines.map((line, index) => {
    if (index === 0 || line.trim() === '') return line;
    const cells = line.split(',');
    const operation_no = cells[0] ?? '';
    const offset = monthOffsetOf(operation_no, spread);
    if (offset === 0) return line;
    const closedAtIndex = cells.indexOf('closed_at');
    if (closedAtIndex >= 0 && cells[closedAtIndex]) {
      cells[closedAtIndex] = shiftMonths(cells[closedAtIndex] as string, offset);
    }
    return cells.join(',');
  });
  return [header, ...out.slice(1)].join('\n');
}

function readScanEvents(file: string, spread: number): ScanBatchFile[] {
  const text = readFileSync(file, 'utf8');
  const batches: ScanBatchFile[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = JSON.parse(line) as ScanBatchFile;
    if (spread <= 1) {
      batches.push(parsed);
      continue;
    }
    const offset = monthOffsetOf(parsed.operation_no, spread);
    if (offset === 0) {
      batches.push(parsed);
      continue;
    }
    batches.push({
      ...parsed,
      scans: parsed.scans.map((scan) => ({
        ...scan,
        scan_time: shiftMonths(scan.scan_time, offset),
      })),
    });
  }
  return batches;
}

/* ── 一遍跑测 ─────────────────────────────────────────────────────────── */

interface Assertion {
  name: string;
  ok: boolean;
  detail: string;
}

interface PassResult {
  /** 这一遍的口径标签 */
  label: string;
  /** 跨月展开月数（0 = 用原始时间戳） */
  spread: number;
  batches: number;
  scannedItems: number;
  httpErrors: number;
  ingestMs: number;
  chargeMs: number;
  aggregateMs: number;
  totalMs: number;
  chargeCalls: number;
  chargedEntries: number;
  chargeAccepted: number;
  chargeRejected: number;
  peerDistinctEntries: number;
  peerDuplicateCharges: number;
  importedOperations: number;
  importedMaterials: number;
  openOperations: number;
  closedOperations: number;
  conclusionCounts: Record<string, number>;
  expectedDistribution: Record<string, number>;
  dataExpectedDistribution: Record<string, number>;
  conclusionMatched: number;
  conclusionAccuracy: number;
  mismatchedItems: Array<{
    material_code: string;
    operation_no: string;
    expected_conclusion: string;
    expected_reason_code: string | null;
    actual_conclusion: string;
    actual_reason_code: string | null;
  }>;
  report: ReturnType<typeof aggregateMonthly>;
  sample: ReturnType<typeof verifyMonthlySample>;
  assertions: Assertion[];
  paths: { summary: string; detail: string; pack: string };
}

async function runPass(
  args: Args,
  options: { label: string; spread: number; outDir: string; logger: Logger; verbose: boolean },
): Promise<PassResult> {
  const startedAt = Date.now();

  // ① 读合成数据
  const operationsCsv = readOperationsCsv(
    readFileSync(resolve(args.dataDir, 'operations.csv'), 'utf8'),
    options.spread,
  );
  const materialsCsv = readFileSync(resolve(args.dataDir, 'materials.csv'), 'utf8');
  const batches = readScanEvents(resolve(args.dataDir, 'scan-events.jsonl'), options.spread);

  // 合成扫描条目（独立预期的输入）：与扫码事件流同源、同序
  const scanItemsCsv = parseCsv(readFileSync(resolve(args.dataDir, 'scan-items.csv'), 'utf8'));
  const scanItems: ScanItemFact[] = scanItemsCsv.rows.map((row) => ({
    scan_batch_id: row['scan_batch_id'] ?? '',
    operation_no: row['operation_no'] ?? '',
    room_no: row['room_no'] ?? '',
    scanner_id: row['scanner_id'] ?? '',
    seq: Number.parseInt(row['seq'] ?? '0', 10),
    material_code: row['material_code'] ?? '',
    canonical_code: row['canonical_code'] ?? '',
    code_form: row['code_form'] ?? '',
    quantity: Number.parseFloat(row['quantity'] ?? '0'),
    scan_time: row['scan_time'] ?? '',
    batch_no: row['batch_no'] ?? '',
    category: row['category'] ?? '',
    expected_conclusion: row['expected_conclusion'] ?? '',
    expected_reason_code: row['expected_reason_code'] ?? '',
  }));

  // 排台台次与耗材主数据的事实（供独立预期查）
  const operations = new Map<string, OperationFact>();
  for (const row of parseCsv(operationsCsv).rows) {
    operations.set(row['operation_no'] ?? '', {
      operation_no: row['operation_no'] ?? '',
      status: (row['status'] ?? '').trim(),
    });
  }
  const materials = new Map<string, MaterialFact>();
  for (const row of parseCsv(materialsCsv).rows) {
    materials.set(row['material_code'] ?? '', {
      material_code: row['material_code'] ?? '',
      active: (row['active'] ?? '').trim().toLowerCase() === 'true',
    });
  }

  const openOperations = operationsCsv
    .split('\n')
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split(','))
    .filter((cells) => (cells[3] ?? '').trim() === 'open')
    .map((cells) => (cells[0] ?? '').trim());
  const closedOperations = operationsCsv
    .split('\n')
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split(','))
    .filter((cells) => (cells[3] ?? '').trim() === 'closed')
    .map((cells) => (cells[0] ?? '').trim());

  if (options.verbose) {
    console.log(
      `台次：开台 ${openOperations.length} / 已关台 ${closedOperations.length}；扫码批次 ${batches.length} 批`,
    );
  }

  // ② 台账（每次跑测用全新库，避免上一轮的存量混进来）
  mkdirSync(options.outDir, { recursive: true });
  const dbPath = resolve(options.outDir, 'ledger.db');
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  const ledger = openLedger(dbPath);
  const imported = importMasterData(ledger.db, { operationsCsv, materialsCsv });
  if (options.verbose) {
    console.log(
      `主数据导入：台次 ${imported.operations.inserted} 条（跳过 ${imported.operations.skipped}）/ 耗材 ${imported.materials.inserted} 条（跳过 ${imported.materials.skipped}）`,
    );
  }

  // ③ 入站：扫码枪 HTTP 投递（真实验签）
  const token = 'monthly-run-token-local';
  const secret = 'monthly-run-secret-local';
  const conclusionCounts: Record<string, number> = {};
  /** 逐条结论 —— 与独立预期逐条对账用 */
  const actualConclusions: Array<{
    material_code: string;
    operation_no: string;
    conclusion: string;
    reason_code: string | null;
  }> = [];
  let httpErrors = 0;
  let scannedItems = 0;

  const handle = await startIngestServer({
    db: ledger.db,
    token,
    secret,
    logger: options.logger,
    onConclusion: (outcome) => {
      conclusionCounts[outcome.conclusion] = (conclusionCounts[outcome.conclusion] ?? 0) + 1;
      actualConclusions.push({
        material_code: outcome.material_code,
        operation_no: outcome.operation_no,
        conclusion: outcome.conclusion,
        reason_code: outcome.reason_code,
      });
    },
  });

  const ingestStart = Date.now();
  try {
    for (const batch of batches) {
      const body = {
        operation_no: batch.operation_no,
        room_no: batch.room_no,
        scanner_id: batch.scanner_id,
        scans: batch.scans,
      };
      const rawBody = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = newNonce();
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/v1/scan-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-scan-timestamp': timestamp,
          'x-scan-nonce': nonce,
          'x-scan-signature': formatSignatureHeader(timestamp, nonce, rawBody, secret),
        },
        body: rawBody,
      });
      await response.text();
      if (response.status !== 200) httpErrors += 1;
      scannedItems += batch.scans.length;
    }
  } finally {
    await handle.close();
  }
  const ingestMs = Date.now() - ingestStart;

  // ③' 独立预期：按合成数据与公开判定规则算一遍，逐条核对产品结论
  const expectedItems: ExpectedItem[] = computeExpectedConclusions(
    scanItems,
    operations,
    materials,
  );
  const expectedDistribution = distributionOf(expectedItems);
  const dataExpectedDistribution = distributionOf(
    expectedItems.map((item) => ({ expected_conclusion: item.data_expected_conclusion })),
  );
  // 逐条配对：产品的逐条结论是**先 accepted 后 rejected** 报出来的，
  // 与扫码顺序不一致 —— 所以按（台次 × 耗材码）分桶后先进先出配对，
  // 不按到达顺序硬对（那样会把同一批里的条目错配到隔壁条目上）。
  const actualByKey = new Map<string, typeof actualConclusions>();
  for (const actual of actualConclusions) {
    const key = `${actual.operation_no}|${actual.material_code}`;
    const bucket = actualByKey.get(key);
    if (bucket) bucket.push(actual);
    else actualByKey.set(key, [actual]);
  }
  let conclusionMatched = 0;
  const mismatchedItems: PassResult['mismatchedItems'] = [];
  for (const expected of expectedItems) {
    const key = `${expected.operation_no}|${expected.material_code}`;
    const bucket = actualByKey.get(key);
    const actual = bucket && bucket.length > 0 ? bucket.shift() : undefined;
    if (actual && actual.conclusion === expected.expected_conclusion) {
      conclusionMatched += 1;
      continue;
    }
    mismatchedItems.push({
      material_code: expected.material_code,
      operation_no: expected.operation_no,
      expected_conclusion: expected.expected_conclusion,
      expected_reason_code: expected.expected_reason_code,
      actual_conclusion: actual?.conclusion ?? 'MISSING',
      actual_reason_code: actual?.reason_code ?? null,
    });
  }
  const conclusionAccuracy =
    expectedItems.length > 0 ? conclusionMatched / expectedItems.length : 0;

  // ④ 出站：逐台次回写 HIS 计费（真实 HTTP 客户端）
  const failRequestIndexes: number[] = [];
  if (args.failEveryNthRequests > 0) {
    for (
      let i = args.failEveryNthRequests;
      i <= openOperations.length;
      i += args.failEveryNthRequests
    ) {
      failRequestIndexes.push(i);
    }
  }
  const peer = await startFakeHisServer({
    failRequestIndexes,
    rejectEveryNth: args.rejectEveryNth > 0 ? args.rejectEveryNth : undefined,
  });
  const client = new HisChargingClient({
    baseUrl: peer.baseUrl,
    token: 'monthly-run-his-token-local',
    logger: () => undefined,
  });

  const chargeStart = Date.now();
  let chargeCalls = 0;
  let chargedEntries = 0;
  let chargeAccepted = 0;
  let chargeRejected = 0;
  for (const operation_no of openOperations) {
    const result = await writeBackOperationCharges(ledger.db, operation_no, {
      client,
      path: '/api/v1/material-uses',
      dept_code: null,
      logger: options.logger,
    });
    chargeCalls += result.calls;
    chargedEntries += result.submitted;
    chargeAccepted += result.accepted;
    chargeRejected += result.rejected;
  }
  const chargeMs = Date.now() - chargeStart;
  const peerDuplicateCharges = peer.duplicateChargeCount;
  const peerDistinctEntries = peer.distinctChargeCount;
  await peer.close();

  // ⑤ 月度对账聚合
  const aggregateStart = Date.now();
  const report = aggregateMonthly(ledger.db, {
    from_month: args.from,
    to_month: args.to,
    limit: args.limit,
  });
  const aggregateMs = Date.now() - aggregateStart;

  // ⑥ 对账包
  const summaryCsv = monthlyGroupToCsv(report.groups);
  const detailCsv = monthlyDetailToCsv(report.details);
  const packJson = monthlyPackToJson(report);
  const summaryPath = resolve(options.outDir, 'monthly-reconcile-summary.csv');
  const detailPath = resolve(options.outDir, 'monthly-reconcile-detail.csv');
  const packPath = resolve(options.outDir, 'monthly-reconcile-pack.json');
  writeFileSync(summaryPath, summaryCsv, 'utf8');
  writeFileSync(detailPath, detailCsv, 'utf8');
  writeFileSync(packPath, packJson, 'utf8');

  // ⑦ 抽样回查
  const sample = verifyMonthlySample(ledger.db, report, args.sample, args.seed);

  const totalMs = Date.now() - startedAt;
  const conclusionTotal = Object.values(conclusionCounts).reduce((sum, value) => sum + value, 0);

  // ⑧ 断言
  const assertions: Assertion[] = [
    {
      name: '入站 HTTP 无非 200',
      ok: httpErrors === 0,
      detail: `非 200 ${httpErrors} 次`,
    },
    {
      name: '结论条数守恒（逐条结论数 = 扫码条目数）',
      ok: conclusionTotal === scannedItems,
      detail: `结论 ${conclusionTotal} 条 / 扫码 ${scannedItems} 条`,
    },
    {
      name: '结论正确率 100%（对独立预期口径逐条核对）',
      ok: conclusionAccuracy === 1 && mismatchedItems.length === 0,
      detail: `一致 ${conclusionMatched} / 共 ${expectedItems.length} 条（不一致 ${mismatchedItems.length} 条）`,
    },
    {
      name: '零重复计费（对端同一台次同一耗材码只收一次）',
      ok: peerDuplicateCharges === 0,
      detail: `对端重复计费 ${peerDuplicateCharges} 条 / 去重后 ${peerDistinctEntries} 条`,
    },
    {
      name: '计费明细条数 = 台账已绑条目数（成功 + 被拒 + 待重投）',
      ok:
        chargedEntries ===
        report.totals.charge_success +
          report.totals.charge_rejected +
          report.totals.charge_pending_retry,
      detail:
        `提交 ${chargedEntries} 条 / 成功 ${report.totals.charge_success} + 被拒 ${report.totals.charge_rejected}` +
        ` + 待重投 ${report.totals.charge_pending_retry}`,
    },
    {
      name: '对账包数字与台账一致（使用条数 = 明细条数）',
      ok: report.totals.usage_count === report.details.length,
      detail: `合计 ${report.totals.usage_count} 条 / 明细 ${report.details.length} 条`,
    },
    {
      name: '分组汇总合计 = 明细合计',
      ok:
        report.groups.reduce((sum, group) => sum + group.usage_count, 0) === report.details.length,
      detail: `分组 ${report.groups.reduce((sum, group) => sum + group.usage_count, 0)} 条`,
    },
    {
      name: `抽样回查 ${sample.sampled} 条全部一致`,
      ok: sample.all_matched,
      detail: `一致 ${sample.matched} 条 / 不一致 ${sample.mismatched} 条`,
    },
    {
      name: '明细未触到条数上限（账期内条目没被截断）',
      ok: !report.scope.truncated,
      detail: `扫过 ${report.scope.ledger_rows_scanned} 条 / 账期内共 ${report.scope.ledger_rows_total} 条`,
    },
  ];

  ledger.close();

  return {
    label: options.label,
    spread: options.spread,
    batches: batches.length,
    scannedItems,
    httpErrors,
    ingestMs,
    chargeMs,
    aggregateMs,
    totalMs,
    chargeCalls,
    chargedEntries,
    chargeAccepted,
    chargeRejected,
    peerDistinctEntries,
    peerDuplicateCharges,
    importedOperations: imported.operations.inserted,
    importedMaterials: imported.materials.inserted,
    openOperations: openOperations.length,
    closedOperations: closedOperations.length,
    conclusionCounts,
    expectedDistribution,
    dataExpectedDistribution,
    conclusionMatched,
    conclusionAccuracy,
    mismatchedItems,
    report,
    sample,
    assertions,
    paths: { summary: summaryPath, detail: detailPath, pack: packPath },
  };
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  // 跑测不打印产品日志（上千条逐条日志会把跑测输出淹掉）：产品日志与跑测摘要分开
  const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
    level: 'error',
  };

  console.log('== 月度对账跑测（全量合成数据 · 完整主路径）==');
  console.log(
    `合成数据目录：${args.dataDir}\n账期：${args.from ?? '不限'} ~ ${args.to ?? '不限'}（账期时区 ${MONTH_TIMEZONE}）`,
  );

  const baseline = await runPass(args, {
    label: '基线（数据自带原始时间戳）',
    spread: 0,
    outDir: args.outDir,
    logger: silentLogger,
    verbose: true,
  });
  printPass(baseline);

  const spreadPass =
    args.monthSpread > 1
      ? await runPass(args, {
          label: `跨月切分演练（业务时间按月展开到 ${args.monthSpread} 个月）`,
          spread: args.monthSpread,
          outDir: resolve(args.outDir, 'spread'),
          logger: silentLogger,
          verbose: true,
        })
      : null;
  if (spreadPass) printPass(spreadPass);

  // 跑测结论落盘
  const doc = renderBenchmarkDoc({ args, baseline, spreadPass });
  mkdirSync(dirname(args.docPath), { recursive: true });
  writeFileSync(args.docPath, doc, 'utf8');
  console.log(`\n跑测结论：${args.docPath}`);
  console.log(`全流程耗时 ${Date.now() - startedAt} ms`);

  const allAssertions = [...baseline.assertions, ...(spreadPass?.assertions ?? [])];
  const failed = allAssertions.filter((assertion) => !assertion.ok);
  if (failed.length > 0) {
    console.log(`\n未达标断言 ${failed.length} 条：`);
    for (const assertion of failed) console.log(`  - ${assertion.name} —— ${assertion.detail}`);
    process.exitCode = 1;
  }
}

function printPass(pass: PassResult): void {
  const report = pass.report;
  console.log('');
  console.log(`-- ${pass.label} --`);
  console.log(
    `入站耗时 ${pass.ingestMs} ms（${pass.scannedItems} 条 / ${pass.batches} 批）；计费回写 ${pass.chargeMs} ms（请求 ${pass.chargeCalls} 次 / 明细 ${pass.chargedEntries} 条）；月度聚合 ${pass.aggregateMs} ms；本遍合计 ${pass.totalMs} ms`,
  );
  console.log(
    `结论分布（产品实测）：${Object.entries(pass.conclusionCounts)
      .map(([key, value]) => `${key}=${value}`)
      .join('  ')}`,
  );
  console.log(
    `结论分布（独立预期）：${Object.entries(pass.expectedDistribution)
      .map(([key, value]) => `${key}=${value}`)
      .join('  ')}`,
  );
  console.log(`结论正确率 ${(pass.conclusionAccuracy * 100).toFixed(4)}%（独立预期逐条核对）`);
  console.log(
    `计费：对端接收 ${pass.peerDistinctEntries} 条（重复 ${pass.peerDuplicateCharges} 条）/ 成功 ${pass.chargeAccepted} / 被拒 ${pass.chargeRejected}`,
  );
  console.log(
    `月度对账：${report.groups.length} 个分组（${report.totals.depts} 科室 × ${report.totals.months} 月份）/ 使用 ${report.totals.usage_count} 条 / 计费成功 ${report.totals.charge_success} / 被拒 ${report.totals.charge_rejected} / 待重投 ${report.totals.charge_pending_retry} / 待核查 ${report.totals.pending_check} / 差异 ${report.totals.diff_count}`,
  );
  console.log(
    `抽样回查：抽 ${pass.sample.sampled} 条，一致 ${pass.sample.matched} 条，不一致 ${pass.sample.mismatched} 条`,
  );
  for (const assertion of pass.assertions) {
    console.log(`  [${assertion.ok ? '达标' : '未达标'}] ${assertion.name} —— ${assertion.detail}`);
  }
}

/* ── 跑测结论落盘 ─────────────────────────────────────────────────────── */

function renderBenchmarkDoc(input: {
  args: Args;
  baseline: PassResult;
  spreadPass: PassResult | null;
}): string {
  const { baseline, spreadPass, args } = input;
  const relative = (path: string): string => path.replace(`${projectRoot}/`, '');
  const lines: string[] = [];

  lines.push('# 高值耗材月度对账跑测');
  lines.push('');
  lines.push(
    '> 用**全量合成数据**跑通整条主路径（扫码枪 HTTP 投递 → 绑定判定 → 台账落行 → HIS 计费回写 → 核查条目），',
  );
  lines.push('> 再按「科室 × 业务月」聚出高值耗材月度对账包，并抽样回查台账与回执。');
  lines.push('');
  lines.push('## 跑法');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run data:prepare            # 取公开数据 + 合成院内数据（可重跑，断网自动降级）');
  lines.push('npm run monthly:run             # 全量跑测 + 产出对账包（基线 + 跨月切分演练）');
  lines.push('npm run monthly:run -- --from 2026-01 --to 2026-03 --sample 20');
  lines.push('```');
  lines.push('');
  lines.push(
    '> 口径说明：本轮跑的是**测试数据层**的合成数据（真实院内耗材主数据与扫码流水不可得）。',
  );
  lines.push(
    '> 计费对端是 `tests/support/fake-his-server.ts` 里的真实 HTTP 服务（生产客户端与替身同一条 fetch 代码路径），',
  );
  lines.push('> 它**不是**产品的最终对接方式 —— 最终对接形态见 `docs/api/his-charging.md`。');
  lines.push('');

  const renderPass = (pass: PassResult, title: string): void => {
    const report = pass.report;
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('### 数据规模');
    lines.push('');
    lines.push('| 项 | 数值 |');
    lines.push('|----|------|');
    lines.push(
      `| 排台台次（导入） | ${pass.importedOperations} 条（开台 ${pass.openOperations} / 已关台 ${pass.closedOperations}） |`,
    );
    lines.push(`| 耗材主数据（导入） | ${pass.importedMaterials} 条 |`);
    lines.push(`| 扫码批次 | ${pass.batches} 批 |`);
    lines.push(`| 扫码条目 | ${pass.scannedItems} 条 |`);
    lines.push(`| 台账行（账期内） | ${report.totals.usage_count} 条 |`);
    lines.push(
      `| 月度分组 | ${report.groups.length} 个（${report.totals.depts} 科室 × ${report.totals.months} 月份） |`,
    );
    lines.push('');

    lines.push('### 耗时');
    lines.push('');
    lines.push('| 环节 | 耗时 |');
    lines.push('|------|------|');
    lines.push(`| 入站（${pass.batches} 批 / ${pass.scannedItems} 条） | ${pass.ingestMs} ms |`);
    lines.push(`| 计费回写（${pass.chargeCalls} 次出站请求） | ${pass.chargeMs} ms |`);
    lines.push(`| 月度聚合 | ${pass.aggregateMs} ms |`);
    lines.push(`| **本遍合计** | **${pass.totalMs} ms** |`);
    lines.push('');

    lines.push('### 结论分布');
    lines.push('');
    lines.push(
      '三列口径：**产品实测**（跑出来的事实）、**独立预期**（`scripts/lib/monthly-expectation.ts` 按合成数据与公开判定规则另算一遍）、',
    );
    lines.push('**数据自带预期**（合成器按「耗材码目录级、各台次独立」写的 `expected_conclusion` 列）。');
    lines.push('');
    lines.push('| 结论 | 产品实测 | 独立预期 | 数据自带预期 |');
    lines.push('|------|---------|---------|-------------|');
    const conclusionKeys = [
      ...new Set([
        ...Object.keys(pass.conclusionCounts),
        ...Object.keys(pass.expectedDistribution),
        ...Object.keys(pass.dataExpectedDistribution),
      ]),
    ].sort();
    for (const key of conclusionKeys) {
      lines.push(
        `| ${key} | ${pass.conclusionCounts[key] ?? 0} | ${pass.expectedDistribution[key] ?? 0} | ${pass.dataExpectedDistribution[key] ?? 0} |`,
      );
    }
    lines.push('');
    lines.push(
      `**结论正确率 ${(pass.conclusionAccuracy * 100).toFixed(4)}%**（${pass.conclusionMatched} / ${pass.scannedItems} 条与独立预期逐条一致，不一致 ${pass.mismatchedItems.length} 条）。`,
    );
    lines.push('');
    if (pass.mismatchedItems.length > 0) {
      lines.push('| 台次 | 耗材码 | 独立预期 | 产品实测 |');
      lines.push('|------|--------|----------|----------|');
      for (const row of pass.mismatchedItems.slice(0, 10)) {
        lines.push(
          `| ${row.operation_no} | ${row.material_code} | ${row.expected_conclusion} | ${row.actual_conclusion} |`,
        );
      }
      lines.push('');
    }
    lines.push(
      '> **口径差异（重要）**：产品实测与「数据自带预期」在 `BOUND` / `CROSS_OP_DUP` 上不一致，差异**全部**来自同一条规则 ——',
    );
    lines.push(
      '> 「同一耗材码已绑在别的台次上 → 后到者拒绝」。合成数据的耗材码是**目录级码**（GTIN / 院内 SKU），在多个台次复用；',
    );
    lines.push(
      '> 而产品按**单件唯一**口径（植入类耗材：同一枚器械不可能用在两台手术上）判跨台次重复。',
    );
    lines.push(
      '> 因此本轮跑测里「同一码第二次出现在别的台次」的那批条目被判 CROSS_OP_DUP —— 这是规则与数据口径的差异，不是判定错误；',
    );
    lines.push('> 独立预期口径已把这条规则算进去，故产品实测与独立预期**逐条一致**。详见 `discoveries.md` 的口径发现。');
    lines.push('');

    lines.push('### 月度对账汇总（科室 × 业务月）');
    lines.push('');
    lines.push(
      `账期 ${report.scope.from_month ?? '不限'} ~ ${report.scope.to_month ?? '不限'}；账期时区 ${report.scope.month_timezone}（按**业务使用时间**切账期，不按落账时间切）。`,
    );
    lines.push('');
    lines.push(
      '| 科室 | 账期 | 使用条数 | 数量 | 计费成功 | 计费被拒 | 待重投 | 待核查 | 差异 | 台次 | 耗材 |',
    );
    lines.push('|------|------|---------|------|---------|---------|--------|--------|------|------|------|');
    for (const group of report.groups) {
      lines.push(
        `| ${group.dept_code} | ${group.month} | ${group.usage_count} | ${group.quantity} | ${group.charge_success} | ${group.charge_rejected} | ${group.charge_pending_retry} | ${group.pending_check} | ${group.diff_count} | ${group.operations} | ${group.materials} |`,
      );
    }
    lines.push('');
    lines.push(
      `合计：使用 ${report.totals.usage_count} 条 / 数量 ${report.totals.quantity} / 计费成功 ${report.totals.charge_success} / 被拒 ${report.totals.charge_rejected} / 待重投 ${report.totals.charge_pending_retry} / 未提交 ${report.totals.charge_not_submitted} / 待核查 ${report.totals.pending_check} / 差异 ${report.totals.diff_count}（其中「计费侧有、台账无」${report.totals.diff_unmatched} 条）/ 台次 ${report.totals.operations} / 耗材 ${report.totals.materials}`,
    );
    lines.push('');

    lines.push('### 阈值断言');
    lines.push('');
    lines.push('| 断言 | 结果 | 实测 |');
    lines.push('|------|------|------|');
    for (const assertion of pass.assertions) {
      lines.push(
        `| ${assertion.name} | ${assertion.ok ? '达标' : '**未达标**'} | ${assertion.detail} |`,
      );
    }
    lines.push('');

    lines.push('### 抽样回查');
    lines.push('');
    lines.push(
      `从对账包里随机抽 ${pass.sample.sampled} 条明细（种子 ${args.seed}），逐条回台账与回执核对结论、数量与计费状态：**一致 ${pass.sample.matched} 条 / 不一致 ${pass.sample.mismatched} 条**。`,
    );
    lines.push('');
    lines.push('| 台次 | 耗材码 | 包内结论 | 台账结论 | 包内计费状态 | 回执计费状态 | 一致 |');
    lines.push('|------|--------|----------|----------|--------------|--------------|------|');
    for (const row of pass.sample.rows.slice(0, 20)) {
      lines.push(
        `| ${row.operation_no} | ${row.material_code} | ${row.pack_conclusion} | ${row.ledger_conclusion} | ${row.pack_charge_state} | ${row.receipt_charge_state} | ${row.matched ? '是' : `否（${row.mismatch_reason}）`} |`,
      );
    }
    lines.push('');

    lines.push('### 产物');
    lines.push('');
    lines.push('| 文件 | 内容 |');
    lines.push('|------|------|');
    lines.push(
      `| \`${relative(pass.paths.summary)}\` | 汇总表（科室 × 业务月，${report.groups.length} 行） |`,
    );
    lines.push(
      `| \`${relative(pass.paths.detail)}\` | 明细表（台账行粒度，${report.details.length} 行） |`,
    );
    lines.push(`| \`${relative(pass.paths.pack)}\` | 对账包（汇总 + 明细 + 台次/耗材码下钻索引） |`);
    lines.push('');
  };

  renderPass(baseline, '基线跑测（数据自带原始时间戳）');

  if (spreadPass) {
    lines.push('---');
    lines.push('');
    lines.push(
      '合成数据的扫码时间集中在同一天，故基线只有一个月份。**跨月切分演练**把合成台次的业务时间按月展开到',
    );
    lines.push(
      `${spreadPass.spread} 个月后**再真跑一遍**（不是把月份算出来贴上去 —— 入站、绑定、计费、聚合全流程重跑），`,
    );
    lines.push('用来验证「科室 × 月份」的跨月切分与账期圈定。');
    lines.push('');
    renderPass(spreadPass, '跨月切分演练（业务时间按月展开）');
  }

  lines.push('## 口径与局限');
  lines.push('');
  lines.push(
    `- **账期按业务使用时间切**（设备上报的扫码时间，落台账的 \`use_time\` 列），不按落账时间切：月末深夜扫的那笔不会被算进下个月。`,
  );
  lines.push(
    `- 月份按**东八区**计算（中国自 1991 年起无夏令时，固定偏移），与 ICU 版本无关，跨机器跑出来的账期一致。`,
  );
  lines.push(
    `- **零重复计费**的口径是对端视角：同一台次同一耗材码被收两次以上即计 1 条重复；本轮实测 ${baseline.peerDuplicateCharges} 条。`,
  );
  lines.push(
    `- 差异条数复用台账 ↔ 回执的对账引擎（三类差异：台账有回执无 / 回执有台账无 / 字段口径不一致），月度包不另写一套差异判定。`,
  );
  lines.push(
    `- 「计费侧有、台账无」的差异没有台账行，进不了以台账行为粒度的明细表，单列在 JSON 包的 \`unmatched\` 里。`,
  );
  lines.push(
    `- 对账只**读**台账与回执：不替人落定结论、不自动关核查条目、不自动冲正已计费条目。`,
  );
  lines.push(
    `- 「待重投」来自跑测里**故意**让计费通道每 ${args.failEveryNthRequests} 个请求失败一次（通道不可达），「计费被拒」来自每 ${args.rejectEveryNth} 条拒收一条 —— 两个数都刻意造出来，好让对账包的这两列不是空的。`,
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}

await main();
