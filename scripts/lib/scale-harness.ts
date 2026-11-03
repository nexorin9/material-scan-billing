/**
 * 规模跑测与朴素基线对照的可复用内核。
 *
 * 两块内容：
 *
 *   ① `runScaleRun` —— **幂等版**：把一批合成扫码事件走**完整主路径**
 *      （扫码枪 HTTP 投递 → 验签 → 码制归一 → 幂等占位 → 绑定判定 → 台账落行
 *        → 计费回写 → 核查条目），产出耗时 / 吞吐 / 结论正确率 / 计费调用次数等指标。
 *
 *   ② `runNaiveBaseline` —— **朴素重发基线**：同一条事件流、同一套判定规则、同一个
 *      出站 HTTP 客户端、同一个计费替身，**只少一层幂等**（不派生幂等键、不占位、
 *      不去重，查到什么算什么）。两者的差就是幂等层省下的重复计费。
 *
 * 事件流是**确定性生成**的（固定种子 → 同样的事件、同样的顺序），
 * 所以两个版本跑的是同一批数据，对比才有意义。
 *
 * 替身说明：出站对端是 `tests/support/fake-his-server.ts` 里的**真实 HTTP 服务**
 * （测试数据层），生产客户端与替身走同一条 fetch 代码路径；它不是产品的最终对接方式。
 */

import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';

import { HisChargingClient } from '../../src/charge/client.js';
import { writeBackOperationCharges } from '../../src/charge/writeback.js';
import { toGtin14 } from '../../src/data/catalog.js';
import { normalizeScanItem } from '../../src/ingest/normalize.js';
import { formatSignatureHeader } from '../../src/ingest/signature.js';
import { newNonce } from '../../src/ingest/replay-guard.js';
import { startIngestServer } from '../../src/ingest/http-server.js';
import { countBindings, insertBinding } from '../../src/ledger/binding-repo.js';
import { openLedger } from '../../src/ledger/db.js';
import { importMasterData } from '../../src/ledger/import-master-data.js';
import { classify } from '../../src/engine/conclude.js';
import type { BindingOutcome } from '../../src/engine/binding.js';
import type { ConclusionCode } from '../../src/domain/scan-event.js';
import { startFakeHisServer } from '../../tests/support/fake-his-server.js';
import { dropIdempotencyDefenses, naiveRowKey } from './naive-baseline.js';

/* ── 事件流 ── */

export type StreamCategory = 'normal' | 'unregistered' | 'closed' | 'cross_op_dup' | 'duplicate';

export interface StreamItem {
  /** 事件所属台次 */
  operation_no: string;
  /** 设备上报的原始码（可能是 UDI / GS1 包装码 / 院内码） */
  raw_code: string;
  /** 归一后的院内耗材码（幂等键与主数据都用它） */
  canonical_code: string;
  quantity: number;
  scan_time: string;
  batch_no: string;
  /** 这一条在事件流里的类别 */
  category: StreamCategory;
  /** 预期结论（独立写出的期望表，不来自产品代码） */
  expected_conclusion: ConclusionCode;
  /** 预期原因码 */
  expected_reason_code: string | null;
}

export interface StreamBatch {
  operation_no: string;
  room_no: string;
  scanner_id: string;
  items: StreamItem[];
}

export interface ScaleStream {
  batches: StreamBatch[];
  /** 展平后的事件条目（与 batches 顺序一致） */
  items: StreamItem[];
  /** 排台台次主数据 CSV */
  operationsCsv: string;
  /** 耗材主数据 CSV */
  materialsCsv: string;
  /** 需要回写计费的台次（开台） */
  openOperations: string[];
  /** 各类别的实际条数 */
  counts: Record<StreamCategory, number>;
  /** 预期绑上的条目数（去重后）—— 计费条数的分母 */
  expected_bound_entries: number;
}

/* ── 原因码（与产品常量一致，但在此独立列出以便核对） ── */

export const REASON = {
  notRegistered: 'MATERIAL_NOT_REGISTERED',
  operationClosed: 'OPERATION_CLOSED',
  crossOpDuplicate: 'CROSS_OP_DUPLICATE_MATERIAL',
  duplicateScan: 'DUPLICATE_SCAN',
} as const;

/* ── 确定性随机 ── */

/** mulberry32：32 位种子伪随机数发生器（同一 seed 必得同一序列） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 洗牌 */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** 分位数（p 取 0–100） */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[index] as number;
}

/* ── 事件流生成 ── */

export interface ScaleStreamOptions {
  /** 事件条目总数（默认 1000） */
  events?: number;
  /** 异常条目占比（默认 0.05） */
  anomalyRate?: number;
  /** 重复扫码条目占比（默认 0.03） */
  duplicateRate?: number;
  /** 随机种子（默认 20260101） */
  seed?: number;
  /** 每批条目数（默认 5） */
  batchSize?: number;
  /** 每个台次摊到的批次数（默认 3：一台手术扫好几批才说得通） */
  batchesPerOperation?: number;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header: string[], rows: Array<Array<string | number | boolean>>): string {
  return [header.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n') + '\n';
}

/**
 * 生成一条确定性事件流。
 *
 * 布局：
 *   - 末尾若干「已关台批次」承载 CLOSED 类异常（专用的已关台台次）；
 *   - 其余为开台批次，同一台次连续摊 `batchesPerOperation` 批（术中分批扫码）；
 *   - 异常三类：耗材未建档 / 跨台次重复 / 台次已关台；
 *   - 重复类：同一耗材在**同一台次的后续批次**被再扫一次（幂等键相同 → 应判重复扫码）。
 */
export function buildScaleStream(options: ScaleStreamOptions = {}): ScaleStream {
  const events = options.events ?? 1000;
  const anomalyRate = options.anomalyRate ?? 0.05;
  const duplicateRate = options.duplicateRate ?? 0.03;
  const seed = options.seed ?? 20260101;
  const batchSize = options.batchSize ?? 5;
  const batchesPerOperation = options.batchesPerOperation ?? 3;

  const rng = mulberry32(seed);

  const anomalyTarget = Math.round(events * anomalyRate);
  const duplicateTarget = Math.round(events * duplicateRate);
  const closedTarget = Math.round(anomalyTarget * 0.4);
  const unregisteredTarget = Math.round(anomalyTarget * 0.3);
  const crossOpTarget = Math.max(0, anomalyTarget - closedTarget - unregisteredTarget);

  // ① 批次规划
  const closedBatches = Math.max(1, Math.ceil(closedTarget / batchSize));
  const closedItems = closedTarget;
  const openItems = Math.max(0, events - closedItems);
  const openBatches = Math.max(1, Math.ceil(openItems / batchSize));
  const openOpCount = Math.ceil(openBatches / batchesPerOperation);

  const operations: Array<Array<string | number | boolean>> = [];
  const openOperations: string[] = [];
  for (let g = 0; g < openOpCount; g += 1) {
    const no = `OP-SCALE-OPEN-${pad(g + 1, 4)}`;
    operations.push([no, `OR-SCALE-${pad(g + 1, 3)}`, 'SURG-SCALE', 'open', '']);
    openOperations.push(no);
  }
  for (let c = 0; c < closedBatches; c += 1) {
    operations.push([
      `OP-SCALE-CLOSED-${pad(c + 1, 4)}`,
      `OR-SCALE-CL-${pad(c + 1, 3)}`,
      'SURG-SCALE',
      'closed',
      '2026-01-20T11:00:00+08:00',
    ]);
  }

  // ② 槽位规划：给开台槽位分配类别
  const slots: Array<{ batch: number; index: number }> = [];
  for (let b = 0; b < openBatches; b += 1) {
    const size = b === openBatches - 1 ? openItems - (openBatches - 1) * batchSize : batchSize;
    for (let i = 0; i < size; i += 1) slots.push({ batch: b, index: slots.length });
  }

  const plan = new Array<StreamCategory | null>(slots.length).fill(null);
  const perBatchNonNormal = new Array<number>(openBatches).fill(0);
  const shuffled = shuffle(slots, rng);

  let duplicatesAssigned = 0;
  for (const slot of shuffled) {
    if (duplicatesAssigned >= duplicateTarget) break;
    // 台次的首批没有「先到者」，不能放重复条目
    if (slot.batch % batchesPerOperation === 0) continue;
    // 每批至少留一条正常条目，保证后续批次有可重复 / 可跨台次引用的先到者
    if ((perBatchNonNormal[slot.batch] as number) >= batchSize - 1) continue;
    plan[slot.index] = 'duplicate';
    perBatchNonNormal[slot.batch] = (perBatchNonNormal[slot.batch] as number) + 1;
    duplicatesAssigned += 1;
  }

  let crossAssigned = 0;
  for (const slot of shuffled) {
    if (crossAssigned >= crossOpTarget) break;
    if (plan[slot.index]) continue;
    // 跨台次重复需要一个**更早的、别的台次**的先到者
    if (slot.batch < batchesPerOperation) continue;
    if ((perBatchNonNormal[slot.batch] as number) >= batchSize - 1) continue;
    plan[slot.index] = 'cross_op_dup';
    perBatchNonNormal[slot.batch] = (perBatchNonNormal[slot.batch] as number) + 1;
    crossAssigned += 1;
  }

  let unregisteredAssigned = 0;
  for (const slot of shuffled) {
    if (unregisteredAssigned >= unregisteredTarget) break;
    if (plan[slot.index]) continue;
    if ((perBatchNonNormal[slot.batch] as number) >= batchSize - 1) continue;
    plan[slot.index] = 'unregistered';
    perBatchNonNormal[slot.batch] = (perBatchNonNormal[slot.batch] as number) + 1;
    unregisteredAssigned += 1;
  }

  // ③ 填条目
  const materials: Array<Array<string | number | boolean>> = [];
  const batches: StreamBatch[] = [];
  const items: StreamItem[] = [];
  const counts: Record<StreamCategory, number> = {
    normal: 0,
    unregistered: 0,
    closed: 0,
    cross_op_dup: 0,
    duplicate: 0,
  };

  let seq = 0;
  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };

  /** 给一条正常条目分配「注册码 + 上报码」（UDI / GS1 / 院内码三种形态） */
  const makeMaterial = (): { canonical: string; raw: string } => {
    const n = nextSeq();
    if (n % 20 === 0) {
      // 真 GTIN-14：带合法校验位（否则条码本身就不合法，扫出来就该被拒）
      const di = toGtin14(`069${pad(n, 10)}`);
      return { canonical: di, raw: `01${di}` };
    }
    if (n % 20 === 3) {
      const di = toGtin14(`069${pad(n, 10)}`);
      return { canonical: di, raw: `(01)${di}(10)LOT-SCALE-${n}` };
    }
    const code = `MAT-SCALE-${pad(n, 5)}`;
    return { canonical: code, raw: code };
  };

  const registerMaterial = (code: string, n: number): void => {
    materials.push([
      code,
      `压测样例耗材 ${n}`,
      `PR-SCALE-${pad(n, 5)}`,
      '卫生材料',
      '甲类',
      'true',
      `LOT-SCALE-${n}`,
      // 单位口径：1 包 = 1 支（包装即计价）
      '包',
      '支',
      '支',
      1,
    ]);
  };

  const scanTime = (n: number): string => {
    const base = new Date('2026-01-20T08:00:00+08:00').getTime() + n * 1000;
    return new Date(base).toISOString();
  };

  // 每个台次已落下的正常条目（按批次分桶），供「同台次重复」引用
  const normalByGroupBatch = new Map<string, StreamItem[]>();
  // 每个台次里「已经放过正常条目的批次号」（升序）
  const batchesWithNormal = new Map<number, number[]>();
  // 各台次的正常条目，供「跨台次重复」引用
  const normalItemsByGroup = new Map<number, StreamItem[]>();

  const normalEntries: Array<{ group: number; item: StreamItem }> = [];

  const pushNormal = (group: number, batch: number, item: StreamItem): void => {
    normalEntries.push({ group, item });
    const bucketKey = `${group}:${batch}`;
    if (!normalByGroupBatch.has(bucketKey)) normalByGroupBatch.set(bucketKey, []);
    (normalByGroupBatch.get(bucketKey) as StreamItem[]).push(item);
    if (!batchesWithNormal.has(group)) batchesWithNormal.set(group, []);
    const batches = batchesWithNormal.get(group) as number[];
    if (batches[batches.length - 1] !== batch) batches.push(batch);
    if (!normalItemsByGroup.has(group)) normalItemsByGroup.set(group, []);
    (normalItemsByGroup.get(group) as StreamItem[]).push(item);
  };

  /** 同一台次里**更早批次**的正常条目（由近及远） */
  const earlierNormals = (group: number, batch: number): StreamItem[] => {
    const out: StreamItem[] = [];
    const batches = batchesWithNormal.get(group) ?? [];
    for (let i = batches.length - 1; i >= 0; i -= 1) {
      const candidate = batches[i] as number;
      if (candidate >= batch) continue;
      const bucket = normalByGroupBatch.get(`${group}:${candidate}`) ?? [];
      out.push(...[...bucket].reverse());
    }
    return out;
  };

  /** 别的台次上已落下的正常条目（由近及远） */
  const otherGroupNormals = (group: number): StreamItem[] => {
    const out: StreamItem[] = [];
    for (let i = normalEntries.length - 1; i >= 0; i -= 1) {
      const entry = normalEntries[i] as { group: number; item: StreamItem };
      if (entry.group === group) continue;
      out.push(entry.item);
    }
    return out;
  };

  let openItemCursor = 0;
  for (let b = 0; b < openBatches; b += 1) {
    const group = Math.floor(b / batchesPerOperation);
    const operation_no = `OP-SCALE-OPEN-${pad(group + 1, 4)}`;
    const room_no = `OR-SCALE-${pad(group + 1, 3)}`;
    const scanner_id = `SCAN-SCALE-${pad(group + 1, 3)}`;
    const size = b === openBatches - 1 ? openItems - (openBatches - 1) * batchSize : batchSize;
    const batchItems: StreamItem[] = [];
    // 本批已引用过的耗材码：同一批不重复引用同一个先到者
    const referencedInBatch = new Set<string>();

    for (let i = 0; i < size; i += 1) {
      const category = plan[openItemCursor] ?? 'normal';
      openItemCursor += 1;
      const n = nextSeq();

      if (category === 'normal') {
        const { canonical, raw } = makeMaterial();
        registerMaterial(canonical, n);
        const item: StreamItem = {
          operation_no,
          raw_code: raw,
          canonical_code: canonical,
          quantity: 1 + Math.floor(rng() * 3),
          scan_time: scanTime(n),
          batch_no: `LOT-SCALE-${n}`,
          category,
          expected_conclusion: 'BOUND',
          expected_reason_code: null,
        };
        batchItems.push(item);
        pushNormal(group, b, item);
        continue;
      }

      if (category === 'unregistered') {
        const code = `MAT-SCALE-UNREG-${pad(n, 5)}`;
        batchItems.push({
          operation_no,
          raw_code: code,
          canonical_code: code,
          quantity: 1,
          scan_time: scanTime(n),
          batch_no: `LOT-SCALE-${n}`,
          category,
          expected_conclusion: 'NOT_REGISTERED',
          expected_reason_code: REASON.notRegistered,
        });
        continue;
      }

      if (category === 'cross_op_dup') {
        // 引用**别的台次**上更早落下的正常条目 → 跨台次重复
        // （同一批里不重复引用同一个耗材：否则会落成「批内重复」而不是跨台次重复）
        const source = otherGroupNormals(group).find(
          (candidate) => !referencedInBatch.has(candidate.canonical_code),
        );
        if (!source) {
          // 兜底：没有更早的别台次条目 → 改判为耗材未建档（异常条目数不变）
          const code = `MAT-SCALE-UNREG-${pad(n, 5)}`;
          batchItems.push({
            operation_no,
            raw_code: code,
            canonical_code: code,
            quantity: 1,
            scan_time: scanTime(n),
            batch_no: `LOT-SCALE-${n}`,
            category: 'unregistered',
            expected_conclusion: 'NOT_REGISTERED',
            expected_reason_code: REASON.notRegistered,
          });
          continue;
        }
        referencedInBatch.add(source.canonical_code);
        batchItems.push({
          operation_no,
          raw_code: source.canonical_code,
          canonical_code: source.canonical_code,
          quantity: source.quantity,
          scan_time: scanTime(n),
          batch_no: `LOT-SCALE-${n}`,
          category: 'cross_op_dup',
          expected_conclusion: 'CROSS_OP_DUP',
          expected_reason_code: REASON.crossOpDuplicate,
        });
        continue;
      }

      // duplicate：引用同一台次**更早批次**里的正常条目 → 同键重复扫码
      const source = earlierNormals(group, b).find(
        (candidate) => !referencedInBatch.has(candidate.canonical_code),
      );
      if (!source) {
        const { canonical, raw } = makeMaterial();
        registerMaterial(canonical, n);
        const item: StreamItem = {
          operation_no,
          raw_code: raw,
          canonical_code: canonical,
          quantity: 1,
          scan_time: scanTime(n),
          batch_no: `LOT-SCALE-${n}`,
          category: 'normal',
          expected_conclusion: 'BOUND',
          expected_reason_code: null,
        };
        batchItems.push(item);
        pushNormal(group, b, item);
        continue;
      }
      referencedInBatch.add(source.canonical_code);
      batchItems.push({
        operation_no,
        raw_code: source.canonical_code,
        canonical_code: source.canonical_code,
        quantity: source.quantity,
        scan_time: scanTime(n),
        // 重复扫码 = 同一笔扫码被重投一次，批号与原条目一致（不是另一批的同款耗材）
        batch_no: source.batch_no,
        category: 'duplicate',
        expected_conclusion: 'NOT_REGISTERED',
        expected_reason_code: REASON.duplicateScan,
      });
    }

    batches.push({ operation_no, room_no, scanner_id, items: batchItems });
    for (const item of batchItems) items.push(item);
  }

  // ④ 已关台批次（专供 CLOSED 异常）
  let closedRemaining = closedItems;
  for (let c = 0; c < closedBatches && closedRemaining > 0; c += 1) {
    const size = Math.min(batchSize, closedRemaining);
    closedRemaining -= size;
    const operation_no = `OP-SCALE-CLOSED-${pad(c + 1, 4)}`;
    const room_no = `OR-SCALE-CL-${pad(c + 1, 3)}`;
    const scanner_id = `SCAN-SCALE-CL-${pad(c + 1, 3)}`;
    const batchItems: StreamItem[] = [];
    for (let i = 0; i < size; i += 1) {
      const n = nextSeq();
      const { canonical, raw } = makeMaterial();
      registerMaterial(canonical, n);
      batchItems.push({
        operation_no,
        raw_code: raw,
        canonical_code: canonical,
        quantity: 1,
        scan_time: scanTime(n),
        batch_no: `LOT-SCALE-${n}`,
        category: 'closed',
        expected_conclusion: 'CLOSED',
        expected_reason_code: REASON.operationClosed,
      });
    }
    batches.push({ operation_no, room_no, scanner_id, items: batchItems });
    for (const item of batchItems) items.push(item);
  }

  for (const item of items) counts[item.category] += 1;

  const operationsCsv = toCsv(
    ['operation_no', 'room_no', 'dept_code', 'status', 'closed_at'],
    operations,
  );
  const materialsCsv = toCsv(
    [
      'material_code',
      'name',
      'price_code',
      'fee_category',
      'medical_insurance_class',
      'active',
      'batch_no',
      'unit_pack',
      'unit_min',
      'charge_unit',
      'ratio',
    ],
    materials,
  );

  return {
    batches,
    items,
    operationsCsv,
    materialsCsv,
    openOperations,
    counts,
    expected_bound_entries: counts.normal,
  };
}

/* ── 指标 ── */

export interface ScaleMetrics {
  events_total: number;
  batches_total: number;
  elapsed_ms: number;
  throughput_items_per_sec: number;
  /** 单条均摊耗时（批次耗时 ÷ 批次条目数）分位数 */
  item_latency_p50_ms: number;
  item_latency_p95_ms: number;
  item_latency_p99_ms: number;
  item_latency_max_ms: number;
  /** 批次耗时 p95 */
  batch_latency_p95_ms: number;
  /** 结论正确率（0–1） */
  conclusion_accuracy: number;
  matched: number;
  mismatched: Array<{
    material_code: string;
    operation_no: string;
    expected_conclusion: string;
    expected_reason_code: string | null;
    actual_conclusion: string;
    actual_reason_code: string | null;
  }>;
  conclusion_distribution: Record<string, number>;
  expected_distribution: Record<string, number>;
  ledger_rows: number;
  check_tasks: number;
  /** 出站计费请求次数 */
  charge_calls: number;
  /** 出站计费条目数（对端收到的明细条数） */
  charged_entries: number;
  charge_accepted: number;
  charge_rejected: number;
  /** 对端收到的重复计费条目数（同一台次同一耗材码收了两次以上） */
  peer_duplicate_charges: number;
  peer_distinct_entries: number;
  peer_requests: number;
  /** 预期绑上（去重后）的条目数 */
  expected_bound_entries: number;
  /** 入站 HTTP 非 200 的次数（应为 0） */
  http_errors: number;
}

export interface ScaleRunResult {
  metrics: ScaleMetrics;
  stream: ScaleStream;
}

export interface ScaleRunOptions extends ScaleStreamOptions {
  /** 入站令牌（跑测用本地值，不连真实系统） */
  token?: string;
  /** 入站签名密钥（跑测用本地值） */
  secret?: string;
  /** 出站计费端点路径 */
  chargePath?: string;
  /** 出站令牌（跑测用本地值） */
  chargeToken?: string;
}

/** 把结论按（台次 × 耗材码）归拢：同键的多条结论按到达顺序排队 */
function outcomeQueues(outcomes: readonly BindingOutcome[]): Map<string, BindingOutcome[]> {
  const map = new Map<string, BindingOutcome[]>();
  for (const outcome of outcomes) {
    const key = `${outcome.operation_no}::${outcome.material_code}`;
    const list = map.get(key);
    if (list) list.push(outcome);
    else map.set(key, [outcome]);
  }
  return map;
}

/** 核查条目数 */
function countCheckTasks(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM check_task').get() as { n: number };
  return row.n;
}

/** 幂等版规模跑测：完整主路径 */
export async function runScaleRun(options: ScaleRunOptions = {}): Promise<ScaleRunResult> {
  const stream = buildScaleStream(options);
  const token = options.token ?? 'scale-run-token-local';
  const secret = options.secret ?? 'scale-run-secret-local';
  const chargePath = options.chargePath ?? '/api/v1/material-uses';
  const chargeToken = options.chargeToken ?? 'scale-run-his-token-local';

  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, {
    operationsCsv: stream.operationsCsv,
    materialsCsv: stream.materialsCsv,
  });

  const peer = await startFakeHisServer();
  const outcomes: BindingOutcome[] = [];
  const handle = await startIngestServer({
    db: ledger.db,
    token,
    secret,
    onConclusion: (outcome) => outcomes.push(outcome),
  });

  const itemLatencies: number[] = [];
  const batchLatencies: number[] = [];
  let httpErrors = 0;

  const startedAt = performance.now();
  try {
    for (const batch of stream.batches) {
      const body = {
        operation_no: batch.operation_no,
        room_no: batch.room_no,
        scanner_id: batch.scanner_id,
        scans: batch.items.map((item) => ({
          material_code: item.raw_code,
          quantity: item.quantity,
          scan_time: item.scan_time,
          batch_no: item.batch_no,
        })),
      };
      const rawBody = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = newNonce();
      const signature = formatSignatureHeader(timestamp, nonce, rawBody, secret);
      const batchStart = performance.now();
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/v1/scan-events`, {
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
      await response.text();
      if (response.status !== 200) httpErrors += 1;
      const batchMs = performance.now() - batchStart;
      batchLatencies.push(batchMs);
      const perItem = batch.items.length > 0 ? batchMs / batch.items.length : batchMs;
      for (let i = 0; i < batch.items.length; i += 1) itemLatencies.push(perItem);
    }
  } finally {
    await handle.close();
  }
  const ingestElapsed = performance.now() - startedAt;

  // 计费回写：逐台次提交（与关台回写同一条产品路径）
  const client = new HisChargingClient({
    baseUrl: peer.baseUrl,
    token: chargeToken,
    logger: () => {
      // 跑测不打印出站日志（凭据与噪声都不必出现在跑测输出里）
    },
  });
  let chargeCalls = 0;
  let chargedEntries = 0;
  let chargeAccepted = 0;
  let chargeRejected = 0;
  for (const operation_no of stream.openOperations) {
    const result = await writeBackOperationCharges(ledger.db, operation_no, {
      client,
      path: chargePath,
      dept_code: 'SURG-SCALE',
    });
    chargeCalls += result.calls;
    chargedEntries += result.submitted;
    chargeAccepted += result.accepted;
    chargeRejected += result.rejected;
  }
  await peer.close();

  // 结论核对：按（台次 × 耗材码）逐条比对，重复条目按到达顺序排队
  const queues = outcomeQueues(outcomes);
  const conclusionDistribution: Record<string, number> = {};
  const expectedDistribution: Record<string, number> = {};
  const mismatched: ScaleMetrics['mismatched'] = [];
  let matched = 0;
  for (const item of stream.items) {
    const queueKey = `${item.operation_no}::${item.canonical_code}`;
    const queue = queues.get(queueKey);
    const outcome = queue && queue.length > 0 ? queue.shift() : undefined;
    const actual = outcome?.conclusion ?? 'MISSING';
    conclusionDistribution[actual] = (conclusionDistribution[actual] ?? 0) + 1;
    expectedDistribution[item.expected_conclusion] =
      (expectedDistribution[item.expected_conclusion] ?? 0) + 1;
    if (
      outcome &&
      outcome.conclusion === item.expected_conclusion &&
      (outcome.reason_code ?? null) === item.expected_reason_code
    ) {
      matched += 1;
    } else {
      mismatched.push({
        material_code: item.canonical_code,
        operation_no: item.operation_no,
        expected_conclusion: item.expected_conclusion,
        expected_reason_code: item.expected_reason_code,
        actual_conclusion: actual,
        actual_reason_code: outcome?.reason_code ?? null,
      });
    }
  }

  const total = stream.items.length;
  const metrics: ScaleMetrics = {
    events_total: total,
    batches_total: stream.batches.length,
    elapsed_ms: Math.round(ingestElapsed * 100) / 100,
    throughput_items_per_sec:
      ingestElapsed > 0 ? Math.round((total / (ingestElapsed / 1000)) * 100) / 100 : 0,
    item_latency_p50_ms: Math.round(percentile(itemLatencies, 50) * 1000) / 1000,
    item_latency_p95_ms: Math.round(percentile(itemLatencies, 95) * 1000) / 1000,
    item_latency_p99_ms: Math.round(percentile(itemLatencies, 99) * 1000) / 1000,
    item_latency_max_ms: Math.round(Math.max(0, ...itemLatencies) * 1000) / 1000,
    batch_latency_p95_ms: Math.round(percentile(batchLatencies, 95) * 1000) / 1000,
    conclusion_accuracy: total > 0 ? Math.round((matched / total) * 1e6) / 1e6 : 0,
    matched,
    mismatched,
    conclusion_distribution: conclusionDistribution,
    expected_distribution: expectedDistribution,
    ledger_rows: countBindings(ledger.db),
    check_tasks: countCheckTasks(ledger.db),
    charge_calls: chargeCalls,
    charged_entries: chargedEntries,
    charge_accepted: chargeAccepted,
    charge_rejected: chargeRejected,
    peer_duplicate_charges: peer.duplicateChargeCount,
    peer_distinct_entries: peer.distinctChargeCount,
    peer_requests: peer.requests.length,
    expected_bound_entries: stream.expected_bound_entries,
    http_errors: httpErrors,
  };

  ledger.close();
  return { metrics, stream };
}

/* ── 朴素重发基线 ── */

export interface NaiveMetrics {
  events_total: number;
  ledger_rows: number;
  /** 出站计费条目数（对端收到的明细条数） */
  charged_entries: number;
  charge_calls: number;
  /** 对端收到的重复计费条目数 */
  peer_duplicate_charges: number;
  peer_distinct_entries: number;
  peer_requests: number;
  /** 相对幂等版多计的条数（= 重复计费条数） */
  extra_charged_entries: number;
  elapsed_ms: number;
}

export interface NaiveBaselineResult {
  metrics: NaiveMetrics;
  stream: ScaleStream;
}

/**
 * 朴素重发基线：**不派生幂等键、不占位、不去重**。
 *
 * 判定规则、码制归一、出站客户端与计费替身都与幂等版完全一致 ——
 * 唯一的差别就是少了幂等层，所以两者的差就是幂等层的价值。
 */
export async function runNaiveBaseline(options: ScaleRunOptions = {}): Promise<NaiveBaselineResult> {
  const stream = buildScaleStream(options);
  const chargePath = options.chargePath ?? '/api/v1/material-uses';
  const chargeToken = options.chargeToken ?? 'scale-run-his-token-local';

  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, {
    operationsCsv: stream.operationsCsv,
    materialsCsv: stream.materialsCsv,
  });
  // 朴素实现的台账**没有幂等层的第二道防线**（三张唯一索引）：
  // 同一把键能写进第二行 —— 这正是幂等层要挡掉的场景。
  // 其余部分（判定规则 / 码制归一 / 出站客户端 / 计费替身 / 回写路径）与幂等版同一条。
  dropIdempotencyDefenses(ledger.db);

  const peer = await startFakeHisServer();
  const startedAt = performance.now();

  const boundOperations = new Set<string>();

  for (const batch of stream.batches) {
    for (const item of batch.items) {
      const normalized = normalizeScanItem({
        material_code: item.raw_code,
        quantity: item.quantity,
        scan_time: item.scan_time,
        batch_no: item.batch_no,
      });
      const judged = classify({
        db: ledger.db,
        operation_no: batch.operation_no,
        room_no: batch.room_no,
        scanner_id: batch.scanner_id,
        material_code: normalized.material_code,
        raw_code: normalized.raw_code,
        quantity: normalized.quantity,
      });

      if (judged.conclusion !== 'BOUND' || !judged.material) {
        // 异常条目：判定层与幂等版一致，都不计费
        continue;
      }

      // 朴素写法：查到就写，每次扫码都写一行台账、都会计费
      // 键用**同一把尺子**（v1：耗材码 + 台次）—— 派生口径不是幂等层，
      // 差的是没人拿它去重：同一把键写进两行、对端收到两笔计费。
      const naiveKey = naiveRowKey(normalized.material_code, batch.operation_no);
      insertBinding(ledger.db, {
        idempotency_key: naiveKey.idempotency_key,
        key_profile: naiveKey.key_profile,
        operation_no: batch.operation_no,
        room_no: batch.room_no,
        dept_code: judged.operation?.dept_code ?? '',
        material_code: normalized.material_code,
        quantity: normalized.quantity,
        price_code: judged.material.price_code,
        fee_category: judged.material.fee_category,
        medical_insurance_class: judged.material.medical_insurance_class,
        conclusion: 'BOUND',
        status: 'bound',
        raw_code: normalized.raw_code,
      });
      boundOperations.add(batch.operation_no);
    }
  }

  const client = new HisChargingClient({
    baseUrl: peer.baseUrl,
    token: chargeToken,
    logger: () => {
      // 跑测不打印出站日志
    },
  });
  let chargeCalls = 0;
  let chargedEntries = 0;
  for (const operation_no of boundOperations) {
    const result = await writeBackOperationCharges(ledger.db, operation_no, {
      client,
      path: chargePath,
      dept_code: 'SURG-SCALE',
    });
    chargeCalls += result.calls;
    chargedEntries += result.submitted;
  }
  const elapsed = performance.now() - startedAt;
  await peer.close();

  const metrics: NaiveMetrics = {
    events_total: stream.items.length,
    ledger_rows: countBindings(ledger.db),
    charged_entries: chargedEntries,
    charge_calls: chargeCalls,
    peer_duplicate_charges: peer.duplicateChargeCount,
    peer_distinct_entries: peer.distinctChargeCount,
    peer_requests: peer.requests.length,
    extra_charged_entries: chargedEntries - stream.expected_bound_entries,
    elapsed_ms: Math.round(elapsed * 100) / 100,
  };

  ledger.close();
  return { metrics, stream };
}
