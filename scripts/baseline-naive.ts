/**
 * 朴素基线（无幂等层）并发压测 —— 量化「没有幂等占位层时会重复计多少费」。
 *
 *   node dist/scripts/baseline-naive.js --concurrency 200 --gap-ms 30
 *
 * 基线口径：同一条耗材扫码并发投递 N 次，**只少一层幂等**：
 *   - 不派生幂等键、不占位、不去重 —— 「查不到就写」；
 *   - 查重与写库之间留一段**真实异步间隙**（默认 30ms，对应真实实现里
 *     「查重 → 调下游计费 → 写台账」中间那个 await）；
 *   - 计费走与幂等版**完全相同**的关台回写路径（`writeBackOperationCharges`），
 *     所以两者的差只来自台账里落了几行。
 *
 * `--gap-ms 0` 表示查重与写库在同一个同步块里（没有间隙）——
 * 用来证明重复计费**来自那个间隙**，而不是来自「没做查重」本身。
 *
 * 产物：data/bench/concurrency-naive.json（运行时目录，不入库）
 *
 * 说明：本脚本是**参照实现**，不参与产品运行路径；出站对端是测试数据层的
 * 真实 HTTP 替身（生产客户端与替身走同一条 fetch 代码路径）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNaiveConcurrency } from './lib/concurrency-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

interface Args {
  concurrency: number;
  gapMs: number;
  out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    concurrency: 200,
    gapMs: 30,
    out: resolve(projectRoot, 'data', 'bench', 'concurrency-naive.json'),
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
      case '--gap-ms':
        args.gapMs = Number.parseInt(take(), 10);
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
    `== 朴素基线并发压测（无幂等层）==\n并发 ${args.concurrency} 次 / 查重与写库之间的异步间隙 ${args.gapMs} ms`,
  );

  const { metrics } = await runNaiveConcurrency({
    concurrency: args.concurrency,
    gapMs: args.gapMs,
  });

  console.log(`耗材使用台账 ${metrics.ledger_rows} 行（同一台次同一耗材重复落行 ${metrics.duplicate_ledger_rows} 行）`);
  console.log(`出站计费：请求 ${metrics.charge_calls} 次 / 明细 ${metrics.charged_entries} 条`);
  console.log(
    `对端收到的计费明细：${metrics.peer_entries} 条 / 去重后 ${metrics.peer_requests} 次请求 / **重复计费 ${metrics.peer_duplicate_charges} 条**`,
  );
  console.log(`并发投递耗时 ${metrics.elapsed_ms} ms`);

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(
    args.out,
    `${JSON.stringify({ generated_at: new Date().toISOString(), args, metrics }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\n产物：${args.out}`);

  // 阈值：有间隙时重复计费必须大于 0（否则这个基线证明不了任何事）
  if (args.gapMs > 0 && metrics.peer_duplicate_charges <= 0) {
    console.error('阈值未达标：无幂等层的并发投递应当出现重复计费');
    process.exitCode = 1;
  }
}

await main();
