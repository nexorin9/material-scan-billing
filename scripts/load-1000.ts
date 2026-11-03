/**
 * 规模跑测：把 N 条合成扫码事件走完整主路径，输出可核对的指标。
 *
 *   node dist/scripts/load-1000.js --events 1000 --seed 20260101
 *
 * 走的是**产品主路径**：扫码枪 HTTP 投递（真实验签）→ 码制归一 → 幂等占位
 * → 绑定判定 → 台账落行 → 核查条目 → 逐台次回写 HIS 计费（真实 HTTP 客户端）。
 *
 * 输出指标：耗时 / 吞吐 / 单条 p95 耗时 / 结论正确率 / 台账行数 /
 * 计费调用次数 / **对端收到的重复计费条目数（必须为 0）**。
 *
 * 产物：data/bench/idempotent-scale.json（运行时目录，不入库）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScaleRun } from './lib/scale-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

interface Args {
  events: number;
  seed: number;
  anomalyRate: number;
  duplicateRate: number;
  batchSize: number;
  out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    events: 1000,
    seed: 20260101,
    anomalyRate: 0.05,
    duplicateRate: 0.03,
    batchSize: 5,
    out: resolve(projectRoot, 'data', 'bench', 'idempotent-scale.json'),
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
      case '--events':
        args.events = Number.parseInt(take(), 10);
        break;
      case '--seed':
        args.seed = Number.parseInt(take(), 10);
        break;
      case '--anomaly-rate':
        args.anomalyRate = Number.parseFloat(take());
        break;
      case '--duplicate-rate':
        args.duplicateRate = Number.parseFloat(take());
        break;
      case '--batch-size':
        args.batchSize = Number.parseInt(take(), 10);
        break;
      case '--out':
        args.out = resolve(projectRoot, take());
        break;
      default:
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `== 规模跑测（幂等版 · 完整主路径）==\n事件 ${args.events} 条 / 异常率 ${(args.anomalyRate * 100).toFixed(0)}% / 重复率 ${(args.duplicateRate * 100).toFixed(0)}% / 种子 ${args.seed}`,
  );

  const { metrics, stream } = await runScaleRun({
    events: args.events,
    seed: args.seed,
    anomalyRate: args.anomalyRate,
    duplicateRate: args.duplicateRate,
    batchSize: args.batchSize,
  });

  console.log(`批次 ${metrics.batches_total} 批（每批 ${args.batchSize} 条）`);
  console.log(
    `事件类别：正常 ${stream.counts.normal} / 未建档 ${stream.counts.unregistered} / 已关台 ${stream.counts.closed} / 跨台次重复 ${stream.counts.cross_op_dup} / 重复扫码 ${stream.counts.duplicate}`,
  );
  console.log(
    `入站处理耗时 ${metrics.elapsed_ms} ms，吞吐 ${metrics.throughput_items_per_sec} 条/秒`,
  );
  console.log(
    `单条均摊耗时 p50=${metrics.item_latency_p50_ms} ms / p95=${metrics.item_latency_p95_ms} ms / p99=${metrics.item_latency_p99_ms} ms（批次 p95=${metrics.batch_latency_p95_ms} ms）`,
  );
  console.log(
    `结论正确率 ${(metrics.conclusion_accuracy * 100).toFixed(4)}%（${metrics.matched}/${metrics.events_total}）`,
  );
  console.log(
    `结论分布：${Object.entries(metrics.conclusion_distribution)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ')}`,
  );
  console.log(`耗材使用台账 ${metrics.ledger_rows} 行 / 核查条目 ${metrics.check_tasks} 条`);
  console.log(
    `出站计费：请求 ${metrics.charge_calls} 次 / 明细 ${metrics.charged_entries} 条（对端接收 ${metrics.charge_accepted} / 拒收 ${metrics.charge_rejected}）`,
  );
  console.log(
    `对端收到的计费明细：${metrics.peer_distinct_entries} 条去重后 / 重复计费 ${metrics.peer_duplicate_charges} 条`,
  );
  console.log(
    `阈值断言：结论正确率 ${metrics.conclusion_accuracy === 1 ? '达标' : '未达标'} / 重复计费 ${metrics.peer_duplicate_charges === 0 ? '为 0（达标）' : `不为 0（未达标，共 ${metrics.peer_duplicate_charges} 条）`} / 计费条目数 ${metrics.charged_entries} = 去重后条目数 ${metrics.expected_bound_entries} → ${metrics.charged_entries === metrics.expected_bound_entries ? '相等（达标）' : '不等（未达标）'}`,
  );
  if (metrics.mismatched.length > 0) {
    console.log(`不一致条目（前 10 条）：`);
    for (const row of metrics.mismatched.slice(0, 10)) {
      console.log(
        `  ${row.material_code} @ ${row.operation_no} 期望 ${row.expected_conclusion}/${row.expected_reason_code ?? '-'} 实际 ${row.actual_conclusion}/${row.actual_reason_code ?? '-'}`,
      );
    }
  }

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(
    args.out,
    `${JSON.stringify({ generated_at: new Date().toISOString(), args, metrics, counts: stream.counts }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\n产物：${args.out}`);

  const ok =
    metrics.conclusion_accuracy === 1 &&
    metrics.peer_duplicate_charges === 0 &&
    metrics.charged_entries === metrics.expected_bound_entries &&
    metrics.http_errors === 0;
  if (!ok) {
    process.exitCode = 1;
  }
}

await main();
