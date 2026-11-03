/**
 * 并发同键串行化与租约争用压测 —— 幂等版 vs 朴素基线对照。
 *
 *   node dist/scripts/bench-concurrency.js --concurrency 200
 *
 * 跑三个场景：
 *   ① **幂等版并发压测**：同一条耗材扫码并发投递 N 次（产品主路径 + 关台回写路径）
 *      —— 台账 1 行、计费 1 次、对端 0 条重复计费；
 *   ② **租约争用**：持有者占位不确认时，后来者全部 busy；租约到期后一个接管并结算一次；
 *   ③ **朴素基线**（无幂等层）：同一批并发投递 —— N 行台账、N−1 条重复计费；
 *      再跑一遍「无间隙」变体，证明重复来自那个 await 间隙。
 *
 * 产物：
 *   data/bench/concurrency.json                运行时目录（不入库）
 *   docs/benchmarks/concurrency-benchmark.md   对照结论（入库）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runIdempotentConcurrency,
  runLeaseContention,
  runNaiveConcurrency,
  type ConcurrencyMetrics,
  type LeaseContentionMetrics,
  type NaiveConcurrencyMetrics,
} from './lib/concurrency-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

interface Args {
  concurrency: number;
  contention: number;
  leaseMs: number;
  gapMs: number;
  /** 朴素基线重复跑几次（竞态结果非确定，跑多次给区间） */
  naiveRepeats: number;
  out: string;
  docPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    concurrency: 200,
    contention: 20,
    leaseMs: 2_000,
    gapMs: 30,
    naiveRepeats: 3,
    out: resolve(projectRoot, 'data', 'bench', 'concurrency.json'),
    docPath: resolve(projectRoot, 'docs', 'benchmarks', 'concurrency-benchmark.md'),
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
      case '--concurrency':
        args.concurrency = Number.parseInt(take(), 10);
        break;
      case '--contention':
        args.contention = Number.parseInt(take(), 10);
        break;
      case '--lease-ms':
        args.leaseMs = Number.parseInt(take(), 10);
        break;
      case '--gap-ms':
        args.gapMs = Number.parseInt(take(), 10);
        break;
      case '--naive-repeats':
        args.naiveRepeats = Number.parseInt(take(), 10);
        break;
      case '--out':
        args.out = resolve(projectRoot, take());
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

function renderDoc(
  args: Args,
  idem: ConcurrencyMetrics,
  lease: LeaseContentionMetrics,
  naive: NaiveConcurrencyMetrics,
  naiveRuns: readonly NaiveConcurrencyMetrics[],
  naiveSync: NaiveConcurrencyMetrics,
  idempotencyKey: string,
): string {
  const dupCounts = naiveRuns.map((run) => run.peer_duplicate_charges);
  const dupMin = Math.min(...dupCounts);
  const dupMax = Math.max(...dupCounts);
  const rowCounts = naiveRuns.map((run) => run.ledger_rows);
  const rowMin = Math.min(...rowCounts);
  const rowMax = Math.max(...rowCounts);
  const savedMin = dupMin - idem.peer_duplicate_charges;

  return `# 并发同键串行化与租约争用压测

> 同一条耗材扫码并发投递 ${idem.concurrency} 次 —— **幂等版**台账 ${idem.ledger_rows} 行、
> 计费 ${idem.charge_calls} 次、对端收到 **${idem.peer_duplicate_charges} 条**重复计费；
> **朴素基线**台账 ${rowMin}–${rowMax} 行（竞态结果，见下）、对端收到 **${dupMin}–${dupMax} 条**重复计费。
> 幂等层至少省下 **${savedMin} 条**重复计费。

## 跑法

\`\`\`bash
# ① 幂等版并发压测 + 租约争用 + 朴素基线对照（产物：data/bench/concurrency.json）
node dist/scripts/bench-concurrency.js --concurrency ${args.concurrency}

# ② 单独跑朴素基线（产物：data/bench/concurrency-naive.json）
node dist/scripts/baseline-naive.js --concurrency ${args.concurrency} --gap-ms ${args.gapMs}

# 一次跑完（等价）
npm run bench:concurrency

# 只跑阈值断言（CI 用小样本）
node --test dist/tests/concurrency.test.js
\`\`\`

## 三个场景

| 场景 | 投递方式 | 幂等层 | 期望 |
|------|----------|--------|------|
| ① 幂等版并发压测 | ${idem.concurrency} 次**并发** HTTP 投递同一条扫码 | 幂等占位（claim → confirm） | 台账 1 行、计费 1 次、对端 0 条重复计费 |
| ② 租约争用 | 先占位不确认，再 ${lease.contention_requests} 次并发投递，租约到期后再投 1 次 | 幂等占位 + 租约到期接管 | 争用期全部 busy；接管后台账 1 行、计费 1 次 |
| ③ 朴素基线 | 同 ${naive.concurrency} 次**并发** HTTP 投递同一条扫码 | **无**（查不到就写） | 台账多行、对端出现重复计费（条数是竞态结果，见下） |

并发投递的 200 次里，**只有扫码时间 / 扫码枪编号 / 批号在变**，耗材码与台次不变 ——
幂等键派生自「耗材码 + 台次」，与这三者无关（键实测值 \`${idempotencyKey.slice(0, 16)}…\`）。

## 朴素基线的重复条数是竞态结果（非确定）

朴素基线「先查后写」之间有 ${naive.gap_ms} ms 的异步间隙，**有多少个请求在第一个请求落库之前
通过查重，取决于当时的调度** —— 所以重复条数每次跑都不一样。同一份代码连续跑 ${naiveRuns.length} 次：

| 运行 | 耗材使用台账行数 | 出站计费明细条数 | 对端收到的重复计费条目 |
|------|------------------|------------------|------------------------|
${naiveRuns
  .map(
    (run, index) =>
      `| 第 ${index + 1} 次 | ${run.ledger_rows} | ${run.charged_entries} | ${run.peer_duplicate_charges} |`,
  )
  .join('\n')}

区间：台账 ${rowMin}–${rowMax} 行、重复计费 ${dupMin}–${dupMax} 条。

**读法**：区间下界（${dupMin} 条）已经说明问题 —— 少则一条都不重复，多则接近全部 ${naive.concurrency} 条都重复。
关键是**幂等版那一列恒定**：无论调度怎么变，台账 ${idem.ledger_rows} 行、计费 ${idem.charge_calls} 次、
对端重复计费 ${idem.peer_duplicate_charges} 条，一次都不多。

## 对照结果

| 指标 | 幂等版（本产品） | 朴素基线（有异步间隙） | 朴素基线（无间隙） |
|------|------------------|------------------------|--------------------|
| 并发投递次数 | ${idem.concurrency} | ${naive.concurrency} | ${naiveSync.concurrency} |
| 查重与写库之间的异步间隙 | 无（占位在 await 之前完成） | ${naive.gap_ms} ms | ${naiveSync.gap_ms} ms |
| 耗材使用台账行数 | **${idem.ledger_rows}** | ${rowMin}–${rowMax} | ${naiveSync.ledger_rows} |
| 其中重复落行 | ${idem.ledger_rows - 1} | ${rowMin - 1}–${rowMax - 1} | ${naiveSync.duplicate_ledger_rows} |
| 绑上（bound）响应数 | ${idem.bound_responses} | ${naive.bound_responses} | ${naiveSync.bound_responses} |
| 被拒：租约忙（CLAIM_BUSY） | ${idem.busy_count} | ${naive.busy_count} | ${naiveSync.busy_count} |
| 被拒：重复扫码（DUPLICATE_SCAN） | ${idem.duplicate_count} | ${naive.duplicate_count} | ${naiveSync.duplicate_count} |
| 出站计费请求次数 | ${idem.charge_calls} | ${naive.charge_calls} | ${naiveSync.charge_calls} |
| 出站计费明细条数 | ${idem.charged_entries} | ${rowMin}–${rowMax} | ${naiveSync.charged_entries} |
| 对端收到的明细条数 | ${idem.peer_entries} | ${naive.peer_entries} | ${naiveSync.peer_entries} |
| **对端收到的重复计费条目** | **${idem.peer_duplicate_charges}** | **${dupMin}–${dupMax}** | ${naiveSync.peer_duplicate_charges} |
| 并发投递耗时 | ${idem.elapsed_ms} ms | ${naive.elapsed_ms} ms | ${naiveSync.elapsed_ms} ms |

三列跑的是**同一批并发投递**、**同一个出站客户端**、**同一个计费替身**、**同一条计费回写路径**
（\`writeBackOperationCharges\`），差别只在「有没有幂等占位层」以及那个 await 间隙。
朴素基线那一列给的是 ${naiveRuns.length} 次运行的**区间**（竞态结果，非确定）；幂等版那一列是**恒定值**。

## 幂等版实测明细

\`\`\`text
并发投递 ${idem.concurrency} 次同一条耗材扫码
HTTP 200 响应 ${idem.http_ok} 次 / 非 200 ${idem.http_errors} 次
绑上（bound）${idem.bound_responses} 次（应当只有 1 次）
被拒：租约忙 ${idem.busy_count} 次 / 重复扫码 ${idem.duplicate_count} 次 / 其他 ${idem.other_rejected_count} 次
耗材使用台账 ${idem.ledger_rows} 行
关台回写：出站请求 ${idem.charge_calls} 次 / 明细 ${idem.charged_entries} 条
对端收到明细 ${idem.peer_entries} 条 / 重复计费 ${idem.peer_duplicate_charges} 条
并发投递耗时 ${idem.elapsed_ms} ms
\`\`\`

## 租约争用实测明细

持有者占位（租约 ${lease.lease_ms} ms）后不确认，随后 ${lease.contention_requests} 次并发投递：

\`\`\`text
争用窗口内的并发投递：${lease.contention_requests} 次
  拿到 busy（CLAIM_BUSY，不重复处理、不重复计费）：${lease.busy_count} 次
  绑上（应当为 0）：${lease.bound_during_contention} 次
  争用窗口内产生的计费请求（应当为 0）：${lease.charge_calls_during_contention} 次
租约到期后接管：绑上 ${lease.takeover_bound ? '是' : '否'}（原因码 ${lease.takeover_reason_code ?? '-'}）
接管后台账 ${lease.ledger_rows_after_takeover} 行 / 出站计费请求 ${lease.charge_calls_after_takeover} 次 / 明细 ${lease.charged_entries_after_takeover} 条
对端收到的重复计费条目：${lease.peer_duplicate_charges} 条
占位 claim_count：${lease.claim_count}（接管一次 +1；台账仍只有 ${lease.ledger_rows_after_takeover} 行）
总耗时 ${lease.elapsed_ms} ms
\`\`\`

读法：租约不是永久锁 —— 持有者卡住时，后来者拿到 **busy**（不重复处理、不重复计费）；
租约到期后其中一个**接管**并完成结算（claim_count 递增，看得出被重试过几次），
但台账仍然只有一行、计费仍然只有一次。

## 阈值断言

| 断言 | 阈值 | 幂等版实测 | 结论 |
|------|------|------------|------|
| 耗材使用台账行数 | = 1 | ${idem.ledger_rows} | ${idem.ledger_rows === 1 ? '达标' : '未达标'} |
| 出站计费请求次数 | = 1 | ${idem.charge_calls} | ${idem.charge_calls === 1 ? '达标' : '未达标'} |
| 出站计费明细条数 | = 1 | ${idem.charged_entries} | ${idem.charged_entries === 1 ? '达标' : '未达标'} |
| 对端收到的重复计费条目 | = 0 | ${idem.peer_duplicate_charges} | ${idem.peer_duplicate_charges === 0 ? '达标' : '未达标'} |
| 并发投递中绑上的次数 | = 1 | ${idem.bound_responses} | ${idem.bound_responses === 1 ? '达标' : '未达标'} |
| 入站 HTTP 非 200 | = 0 | ${idem.http_errors} | ${idem.http_errors === 0 ? '达标' : '未达标'} |
| 租约争用期拿到 busy 的次数 | = ${lease.contention_requests} | ${lease.busy_count} | ${lease.busy_count === lease.contention_requests ? '达标' : '未达标'} |
| 租约争用期绑上的次数 | = 0 | ${lease.bound_during_contention} | ${lease.bound_during_contention === 0 ? '达标' : '未达标'} |
| 租约到期接管后台账行数 | = 1 | ${lease.ledger_rows_after_takeover} | ${lease.ledger_rows_after_takeover === 1 ? '达标' : '未达标'} |
| 租约到期接管后计费次数 | = 1 | ${lease.charge_calls_after_takeover} | ${lease.charge_calls_after_takeover === 1 ? '达标' : '未达标'} |
| 朴素基线重复计费（有间隙） | > 0 | ${dupMin}–${dupMax} | ${dupMin > 0 ? '达标' : '未达标'} |
| 幂等层省下的重复计费 | > 0 | 至少 ${savedMin} | ${savedMin > 0 ? '达标' : '未达标'} |

## 口径与局限（务必一起看）

- **重复计费来自那个 await 间隙，不是来自「没做查重」本身**：朴素基线还跑了一个
  **无间隙**变体（\`--gap-ms 0\`，查重与写库在同一个同步块里）——
  此时台账 ${naiveSync.ledger_rows} 行、重复计费 ${naiveSync.peer_duplicate_charges} 条。
  有间隙时是 ${rowMin}–${rowMax} 行 / ${dupMin}–${dupMax} 条。
  也就是说：**只要「查重」和「写库」之间有任何一个 await，朴素的先查后写就会重复计费**；
  幂等占位层把占位放在任何 await 之前，用**一把租约**把并发窗口关掉。
- **朴素基线的重复条数是竞态结果，不是定值**：有多少个请求在第一个请求落库之前通过查重，
  取决于当时的调度，因此同一份代码每次跑出来的数字都不同（本文给的是 ${naiveRuns.length} 次运行的区间）。
  **不要把某一次的数字当成基线**；要看的是「幂等版那一列恒定、朴素版那一列不为零」。
  幂等版的数字之所以恒定，是因为占位在**任何 await 之前**就完成了 ——
  它不依赖调度，只依赖那把幂等键。
- **出站对端是测试替身**：\`tests/support/fake-his-server.ts\` 里的真实 HTTP 服务
  （生产客户端与替身走同一条 \`fetch\` 代码路径），它额外逐条记账以统计重复计费。
  它是**测试数据层**，不是产品的最终对接方式；真实对接形态见 \`docs/api/his-charging.md\`。
- **计费发生在关台回写**，不在入站那一刻：三个场景都走同一条
  \`writeBackOperationCharges\` 路径，所以「对端收到几条明细」直接等于
  「台账里落了几行」—— 这正是本对比要看的量。
- **台账跑在内存 SQLite**（\`:memory:\`）：压测量的是幂等与判定逻辑，不是磁盘吞吐；
  磁盘上的持久化行为由 \`node --test dist/tests/db-migrations.test.js\` 一类用例覆盖。
- **单机单进程**：并发来自 ${idem.concurrency} 个同时在途的 HTTP 请求
  （真实 socket、真实请求头与请求体），不是多进程压测；跨进程去重靠台账里的
  唯一索引与租约，语义见 \`docs/api/errors.md\`。
- **耗时两列不可直接相比**：朴素基线少走验签、码制归一与占位三层，所以更快；
  **本对比的看点是重复计费条数，不是耗时**。
- **朴素基线不是产品代码**：它是 \`scripts/lib/concurrency-harness.ts\` 里的一段参照实现，
  用来说明「少了幂等层会发生什么」；它不参与产品运行路径。
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(
    `== ① 幂等版并发压测（产品主路径）==\n并发 ${args.concurrency} 次同一条耗材扫码`,
  );
  const idemRun = await runIdempotentConcurrency({ concurrency: args.concurrency });
  const idem = idemRun.metrics;
  console.log(
    `绑上 ${idem.bound_responses} 次 / 租约忙 ${idem.busy_count} 次 / 重复扫码 ${idem.duplicate_count} 次`,
  );
  console.log(`台账 ${idem.ledger_rows} 行 / 出站计费 ${idem.charge_calls} 次 / 明细 ${idem.charged_entries} 条`);
  console.log(`对端重复计费 ${idem.peer_duplicate_charges} 条 / 并发投递耗时 ${idem.elapsed_ms} ms`);

  console.log(`\n== ② 租约争用 ==\n持有者占位 ${args.leaseMs} ms 不确认，并发 ${args.contention} 次`);
  const leaseRun = await runLeaseContention({
    contention: args.contention,
    leaseMs: args.leaseMs,
  });
  const lease = leaseRun.metrics;
  console.log(
    `争用期：busy ${lease.busy_count} 次 / 绑上 ${lease.bound_during_contention} 次 / 争用期计费 ${lease.charge_calls_during_contention} 次`,
  );
  console.log(
    `租约到期接管：绑上 ${lease.takeover_bound ? '是' : '否'} / 台账 ${lease.ledger_rows_after_takeover} 行 / 计费 ${lease.charge_calls_after_takeover} 次 / claim_count ${lease.claim_count}`,
  );

  console.log(`\n== ③ 朴素基线（无幂等层）==\n并发 ${args.concurrency} 次，异步间隙 ${args.gapMs} ms`);
  const naiveRuns: NaiveConcurrencyMetrics[] = [];
  for (let round = 0; round < args.naiveRepeats; round += 1) {
    const naiveRun = await runNaiveConcurrency({ concurrency: args.concurrency, gapMs: args.gapMs });
    naiveRuns.push(naiveRun.metrics);
    console.log(
      `第 ${round + 1} 次：台账 ${naiveRun.metrics.ledger_rows} 行（重复落行 ${naiveRun.metrics.duplicate_ledger_rows} 行）/ 计费明细 ${naiveRun.metrics.charged_entries} 条 / 对端重复计费 **${naiveRun.metrics.peer_duplicate_charges} 条**`,
    );
  }
  const naive = naiveRuns[0] as NaiveConcurrencyMetrics;
  const dupCounts = naiveRuns.map((run) => run.peer_duplicate_charges);
  console.log(
    `重复计费区间 ${Math.min(...dupCounts)}–${Math.max(...dupCounts)} 条（竞态结果，非确定；幂等版那一列恒定为 ${idem.peer_duplicate_charges} 条）`,
  );

  console.log(`\n== ③b 朴素基线 · 无异步间隙（对照：重复来自间隙，不来自没查重）==`);
  const naiveSyncRun = await runNaiveConcurrency({ concurrency: args.concurrency, gapMs: 0 });
  const naiveSync = naiveSyncRun.metrics;
  console.log(
    `台账 ${naiveSync.ledger_rows} 行 / 计费明细 ${naiveSync.charged_entries} 条 / 对端重复计费 ${naiveSync.peer_duplicate_charges} 条`,
  );

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(
    args.out,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        args,
        idempotent: idem,
        lease_contention: lease,
        naive_with_gap_runs: naiveRuns,
        naive_without_gap: naiveSync,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`\n产物：${args.out}`);

  mkdirSync(dirname(args.docPath), { recursive: true });
  writeFileSync(
    args.docPath,
    renderDoc(args, idem, lease, naive, naiveRuns, naiveSync, idemRun.idempotency_key),
    'utf8',
  );
  console.log(`对照文档：${args.docPath}`);

  const ok =
    idem.ledger_rows === 1 &&
    idem.charge_calls === 1 &&
    idem.charged_entries === 1 &&
    idem.peer_duplicate_charges === 0 &&
    idem.bound_responses === 1 &&
    idem.http_errors === 0 &&
    lease.busy_count === lease.contention_requests &&
    lease.bound_during_contention === 0 &&
    lease.ledger_rows_after_takeover === 1 &&
    lease.charge_calls_after_takeover === 1 &&
    naiveRuns.every((run) => run.peer_duplicate_charges > 0);
  if (!ok) {
    console.error(
      '阈值未达标：幂等版应为台账 1 行 / 计费 1 次 / 零重复计费；租约争用期应全部 busy；朴素基线重复计费应大于 0',
    );
    process.exitCode = 1;
  }
}

await main();
