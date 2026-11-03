/**
 * 朴素重发基线与幂等版对照 —— 量化「幂等层省下了多少重复计费」。
 *
 *   node dist/scripts/baseline-naive-resend.js --events 1000 --seed 20260101
 *
 * 基线口径（同一条事件流、同一个判定规则、同一个出站客户端、同一个计费替身，
 * **只少一层幂等**）：
 *   - 幂等版：不派生幂等键、不占位 → 同键只写一行台账、只计费一次；
 *   - 朴素版：不派生幂等键、不占位、不去重 → 每次扫码都写一行台账、都会计费。
 *
 * 两者之差就是对端收到的重复计费条目数。
 *
 * 产物：
 *   data/bench/naive-baseline.json               运行时目录（不入库）
 *   docs/benchmarks/idempotency-benchmark.md     对照结论（入库）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNaiveBaseline, runScaleRun, type ScaleMetrics } from './lib/scale-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

interface Args {
  events: number;
  seed: number;
  anomalyRate: number;
  duplicateRate: number;
  batchSize: number;
  idempotentArtifact: string;
  naiveArtifact: string;
  docPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    events: 1000,
    seed: 20260101,
    anomalyRate: 0.05,
    duplicateRate: 0.03,
    batchSize: 5,
    idempotentArtifact: resolve(projectRoot, 'data', 'bench', 'idempotent-scale.json'),
    naiveArtifact: resolve(projectRoot, 'data', 'bench', 'naive-baseline.json'),
    docPath: resolve(projectRoot, 'docs', 'benchmarks', 'idempotency-benchmark.md'),
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
      case '--idempotent-artifact':
        args.idempotentArtifact = resolve(projectRoot, take());
        break;
      case '--out':
        args.naiveArtifact = resolve(projectRoot, take());
        break;
      case '--doc':
        args.docPath = resolve(projectRoot, take());
        break;
      default:
        break;
    }
  }
  return args;
}

interface IdempotentArtifact {
  generated_at: string;
  args: { events: number; seed: number; anomalyRate: number; duplicateRate: number; batchSize: number };
  metrics: ScaleMetrics;
  counts: Record<string, number>;
}

function renderDoc(args: Args, idem: IdempotentArtifact, naive: {
  metrics: {
    events_total: number;
    ledger_rows: number;
    charged_entries: number;
    charge_calls: number;
    peer_duplicate_charges: number;
    peer_distinct_entries: number;
    extra_charged_entries: number;
    elapsed_ms: number;
  };
}): string {
  const m = idem.metrics;
  const n = naive.metrics;
  const saved = n.peer_duplicate_charges - m.peer_duplicate_charges;

  return `# 幂等层对照基线：零重复计费 vs 朴素重发

> 同一批 ${m.events_total} 条扫码事件、同一套判定规则、同一个出站客户端、同一个计费替身 ——
> **只差一层幂等**：幂等版按「耗材码 + 台次」去重，朴素版每次扫码都写台账、都会计费。
> 实测对端收到的重复计费条目：幂等版 **${m.peer_duplicate_charges} 条**，朴素版 **${n.peer_duplicate_charges} 条**。

## 跑法

\`\`\`bash
# ① 幂等版规模跑测（产物：data/bench/idempotent-scale.json）
node dist/scripts/load-1000.js --events ${args.events} --seed ${args.seed}

# ② 朴素重发基线 + 写出本文档（产物：data/bench/naive-baseline.json）
node dist/scripts/baseline-naive-resend.js --events ${args.events} --seed ${args.seed}

# 一次跑完（等价）
npm run bench:idempotency

# 只跑阈值断言（CI 用小样本）
node --test dist/tests/load-1000.test.js
\`\`\`

## 事件流构成（确定性生成，种子 ${args.seed}）

| 类别 | 条数 | 预期结论 | 说明 |
|------|------|----------|------|
| 正常扫码 | ${idem.counts['normal'] ?? 0} | BOUND | 全新耗材码，绑上本台次 |
| 耗材未建档 | ${idem.counts['unregistered'] ?? 0} | NOT_REGISTERED / MATERIAL_NOT_REGISTERED | 码不在院内耗材主数据 |
| 台次已关台 | ${idem.counts['closed'] ?? 0} | CLOSED / OPERATION_CLOSED | 扫到已关台台次 |
| 跨台次重复 | ${idem.counts['cross_op_dup'] ?? 0} | CROSS_OP_DUP / CROSS_OP_DUPLICATE_MATERIAL | 同一耗材已绑在别的台次 |
| 重复扫码 | ${idem.counts['duplicate'] ?? 0} | NOT_REGISTERED / DUPLICATE_SCAN | 同一耗材同一台次被再扫一次 |
| **合计** | **${m.events_total}** | — | 异常占比 ${(args.anomalyRate * 100).toFixed(0)}%，重复占比 ${(args.duplicateRate * 100).toFixed(0)}% |

## 对照结果

| 指标 | 幂等版（本产品） | 朴素重发基线 | 差 |
|------|------------------|--------------|----|
| 投递事件条数 | ${m.events_total} | ${n.events_total} | 0 |
| 耗材使用台账行数 | ${m.ledger_rows} | ${n.ledger_rows} | ${n.ledger_rows - m.ledger_rows} |
| 出站计费请求次数 | ${m.charge_calls} | ${n.charge_calls} | ${n.charge_calls - m.charge_calls} |
| 出站计费明细条数 | ${m.charged_entries} | ${n.charged_entries} | ${n.charged_entries - m.charged_entries} |
| 对端去重后计费条目 | ${m.peer_distinct_entries} | ${n.peer_distinct_entries} | ${n.peer_distinct_entries - m.peer_distinct_entries} |
| **对端收到的重复计费条目** | **${m.peer_duplicate_charges}** | **${n.peer_duplicate_charges}** | **${saved}** |
| 结论正确率 | ${(m.conclusion_accuracy * 100).toFixed(4)}% | — | — |
| 处理耗时 | ${m.elapsed_ms} ms | ${n.elapsed_ms} ms | — |

读法：**幂等版对端重复计费 ${m.peer_duplicate_charges} 条**（零重复计费），
朴素版 **${n.peer_duplicate_charges} 条** —— 差的 ${saved} 条正是「重复扫码」那一类
（${idem.counts['duplicate'] ?? 0} 条）在没有幂等层时会被重复计掉的账。

## 幂等版实测明细

\`\`\`text
批次 ${m.batches_total} 批（每批 ${args.batchSize} 条）
入站处理耗时 ${m.elapsed_ms} ms，吞吐 ${m.throughput_items_per_sec} 条/秒
单条均摊耗时 p50=${m.item_latency_p50_ms} ms / p95=${m.item_latency_p95_ms} ms / p99=${m.item_latency_p99_ms} ms（批次 p95=${m.batch_latency_p95_ms} ms）
结论正确率 ${(m.conclusion_accuracy * 100).toFixed(4)}%（${m.matched}/${m.events_total}）
结论分布：${Object.entries(m.conclusion_distribution).map(([k, v]) => `${k}=${v}`).join('  ')}
耗材使用台账 ${m.ledger_rows} 行 / 核查条目 ${m.check_tasks} 条
出站计费：请求 ${m.charge_calls} 次 / 明细 ${m.charged_entries} 条（对端接收 ${m.charge_accepted} / 拒收 ${m.charge_rejected}）
对端收到的计费明细：${m.peer_distinct_entries} 条去重后 / 重复计费 ${m.peer_duplicate_charges} 条
\`\`\`

## 阈值断言

| 断言 | 阈值 | 实测 | 结论 |
|------|------|------|------|
| 结论正确率 | = 100% | ${(m.conclusion_accuracy * 100).toFixed(4)}% | ${m.conclusion_accuracy === 1 ? '达标' : '未达标'} |
| 出站计费明细条数（同键只计一次） | = 去重后条目数（${m.expected_bound_entries}） | ${m.charged_entries} | ${m.charged_entries === m.expected_bound_entries ? '达标' : '未达标'} |
| 对端重复计费条目 | = 0 | ${m.peer_duplicate_charges} | ${m.peer_duplicate_charges === 0 ? '达标' : '未达标'} |
| 入站 HTTP 非 200 | = 0 | ${m.http_errors} | ${m.http_errors === 0 ? '达标' : '未达标'} |
| 朴素基线重复计费 | > 0 | ${n.peer_duplicate_charges} | ${n.peer_duplicate_charges > 0 ? '达标' : '未达标'} |

## 判定边界矩阵（同一批任务的另一半）

绑定结论的正确性不只看规模，还要看**边界**：码制形态 × 台次状态 × 耗材归属 ×
主数据状态 × 数量 的笛卡尔积逐条比对（预期结论写在 fixture 里，独立于产品代码）。

| 维度 | 取值 |
|------|------|
| 码制形态 | canonical / canonical_dotted / canonical_underscore / gtin / empty / too_long / illegal_charset / form_unrecognized / dictionary_miss |
| 台次状态 | open / closed / unknown |
| 耗材归属 | first / duplicate_other_op / same_op_bound |
| 主数据状态 | registered / inactive |
| 数量 | 1 / 2 / 3 |

\`\`\`bash
# 重新生成 fixture（确定性，重复执行逐字节一致）
npm run fixtures:boundary

# 逐条断言（≥200 条用例全绿）
node --test dist/tests/boundary-matrix.test.js
\`\`\`

用例文件（可读 CSV）：

- \`tests/boundary/boundary-cases.csv\` —— 每条用例带预期结论与原因码
- \`tests/boundary/boundary-operations.csv\` / \`tests/boundary/boundary-materials.csv\` —— 对应的主数据

## 口径与局限（务必一起看）

- **出站对端是测试替身**：\`tests/support/fake-his-server.ts\` 里的真实 HTTP 服务
  （生产客户端与替身走同一条 \`fetch\` 代码路径），它额外逐条记账以统计重复计费。
  它是**测试数据层**，不是产品的最终对接方式；真实对接形态见 \`docs/api/his-charging.md\`。
- **台账跑在内存 SQLite**（\`:memory:\`）：跑测量的是判定与幂等逻辑，不是磁盘吞吐；
  磁盘上的持久化行为由 \`npm test -- test_db_migrations\` 一类用例覆盖。
- **单机单进程**：吞吐与 p95 是本机开发机上的数字，不代表院内服务器；
  「单条均摊耗时」= 批次往返耗时 ÷ 批次条目数，是均摊值而非单条独占耗时。
- **两个版本跑的是同一条事件流**：事件流由固定种子确定性生成
  （\`buildScaleStream\`），因此两次运行的差异只来自幂等层本身。
- **耗时两列不可直接相比**：幂等版走完整入站 HTTP 路径（验签、归一、占位、台账），
  朴素基线直接调用判定函数与出站客户端（少一层 HTTP 与占位），
  所以朴素基线更快。**本对比的看点是重复计费条数，不是耗时。**
- **朴素基线不是产品代码**：它是本目录下的一段参照实现（\`runNaiveBaseline\`），
  用来说明「少了幂等层会发生什么」；它不参与产品运行路径。
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ① 幂等版：优先复用已有产物，没有就现跑一遍
  let idempotent: IdempotentArtifact | null = null;
  if (existsSync(args.idempotentArtifact)) {
    idempotent = JSON.parse(readFileSync(args.idempotentArtifact, 'utf8')) as IdempotentArtifact;
    console.log(`复用幂等版产物：${args.idempotentArtifact}`);
  } else {
    console.log('未找到幂等版产物，现场跑一遍…');
    const { metrics, stream } = await runScaleRun({
      events: args.events,
      seed: args.seed,
      anomalyRate: args.anomalyRate,
      duplicateRate: args.duplicateRate,
      batchSize: args.batchSize,
    });
    idempotent = {
      generated_at: new Date().toISOString(),
      args: {
        events: args.events,
        seed: args.seed,
        anomalyRate: args.anomalyRate,
        duplicateRate: args.duplicateRate,
        batchSize: args.batchSize,
      },
      metrics,
      counts: stream.counts,
    };
    mkdirSync(dirname(args.idempotentArtifact), { recursive: true });
    writeFileSync(args.idempotentArtifact, `${JSON.stringify(idempotent, null, 2)}\n`, 'utf8');
  }

  // ② 朴素重发基线
  console.log(`\n== 朴素重发基线（无幂等层）==\n事件 ${args.events} 条 / 种子 ${args.seed}`);
  const naive = await runNaiveBaseline({
    events: args.events,
    seed: args.seed,
    anomalyRate: args.anomalyRate,
    duplicateRate: args.duplicateRate,
    batchSize: args.batchSize,
  });

  console.log(`耗材使用台账 ${naive.metrics.ledger_rows} 行`);
  console.log(
    `出站计费：请求 ${naive.metrics.charge_calls} 次 / 明细 ${naive.metrics.charged_entries} 条`,
  );
  console.log(
    `对端收到的计费明细：${naive.metrics.peer_distinct_entries} 条去重后 / **重复计费 ${naive.metrics.peer_duplicate_charges} 条**`,
  );
  console.log(
    `对照幂等版：重复计费 ${idempotent.metrics.peer_duplicate_charges} 条 → 幂等层省下 ${naive.metrics.peer_duplicate_charges - idempotent.metrics.peer_duplicate_charges} 条重复计费`,
  );

  mkdirSync(dirname(args.naiveArtifact), { recursive: true });
  writeFileSync(
    args.naiveArtifact,
    `${JSON.stringify({ generated_at: new Date().toISOString(), args, metrics: naive.metrics }, null, 2)}\n`,
    'utf8',
  );
  console.log(`产物：${args.naiveArtifact}`);

  // ③ 写对照文档
  mkdirSync(dirname(args.docPath), { recursive: true });
  writeFileSync(args.docPath, renderDoc(args, idempotent, naive), 'utf8');
  console.log(`对照文档：${args.docPath}`);

  const ok =
    idempotent.metrics.peer_duplicate_charges === 0 &&
    naive.metrics.peer_duplicate_charges > 0 &&
    idempotent.metrics.conclusion_accuracy === 1;
  if (!ok) {
    console.error('阈值未达标：幂等版重复计费应为 0，朴素基线重复计费应大于 0');
    process.exitCode = 1;
  }
}

await main();
