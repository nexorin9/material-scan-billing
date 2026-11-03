/**
 * test_load_1000：规模跑测的阈值断言（幂等版 vs 朴素重发基线）。
 *
 * 本测试用**较小样本**跑同一套阈值（CI 里要快），完整 1000 条由
 * `npm run bench:idempotency` 产出（产物：data/bench/*.json 与
 * docs/benchmarks/idempotency-benchmark.md）。
 *
 * 覆盖：
 *   ① 事件流确定性：同一 seed 两次生成逐条一致（两个版本跑的是同一批数据）；
 *   ② 幂等版：结论正确率 100%、入站无 HTTP 错误、台账行数 = 去重后条目数、
 *      **对端收到的重复计费条目 = 0**；
 *   ③ 朴素重发基线：同一批事件下重复计费 > 0（没有幂等层就会重复计费）；
 *   ④ 事件流里异常与重复条目确实存在（否则上面的断言是空的）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScaleStream,
  runNaiveBaseline,
  runScaleRun,
} from '../scripts/lib/scale-harness.js';

/** CI 用的小样本（完整 1000 条见 npm run bench:idempotency） */
const SAMPLE_EVENTS = 200;
const SEED = 20260101;

describe('规模跑测阈值断言', () => {
  it('事件流是确定性的：同一 seed 两次生成逐条一致', () => {
    const a = buildScaleStream({ events: SAMPLE_EVENTS, seed: SEED });
    const b = buildScaleStream({ events: SAMPLE_EVENTS, seed: SEED });
    const fingerprint = (stream: { items: Array<{ operation_no: string; raw_code: string; expected_conclusion: string; expected_reason_code: string | null }> }): string[] =>
      stream.items.map(
        (item) =>
          `${item.operation_no}::${item.raw_code}::${item.expected_conclusion}::${item.expected_reason_code ?? '-'}`,
      );
    assert.deepEqual(fingerprint(a), fingerprint(b));
    assert.equal(a.items.length, SAMPLE_EVENTS);
  });

  it('幂等版：结论正确率 100%、零重复计费、台账行数 = 去重后条目数', async () => {
    const { metrics, stream } = await runScaleRun({ events: SAMPLE_EVENTS, seed: SEED });

    assert.equal(metrics.http_errors, 0, '入站请求不应有非 200');
    assert.deepEqual(metrics.mismatched, [], '每条事件的结论都应与预期矩阵一致');
    assert.equal(metrics.matched, metrics.events_total);
    assert.equal(metrics.conclusion_accuracy, 1);

    // 零重复计费：同键只计费一次
    assert.equal(metrics.peer_duplicate_charges, 0, '对端不应收到任何重复计费条目');
    assert.equal(metrics.charged_entries, metrics.expected_bound_entries);
    assert.equal(metrics.ledger_rows, metrics.expected_bound_entries);
    assert.equal(metrics.charge_accepted, metrics.expected_bound_entries);
    assert.equal(metrics.peer_distinct_entries, metrics.expected_bound_entries);

    // 结论分布：异常条目各归各类
    assert.equal(metrics.conclusion_distribution['BOUND'], stream.counts.normal);
    assert.equal(metrics.conclusion_distribution['CLOSED'], stream.counts.closed);
    assert.equal(
      metrics.conclusion_distribution['CROSS_OP_DUP'],
      stream.counts.cross_op_dup,
    );
  });

  it('事件流里确实有异常条目与重复条目（否则上面的断言是空的）', () => {
    const { counts } = buildScaleStream({ events: SAMPLE_EVENTS, seed: SEED });
    assert.ok(counts.normal > 0, '应有正常扫码条目');
    assert.ok(counts.unregistered > 0, '应有耗材未建档条目');
    assert.ok(counts.closed > 0, '应有台次已关台条目');
    assert.ok(counts.cross_op_dup > 0, '应有跨台次重复条目');
    assert.ok(counts.duplicate > 0, '应有重复扫码条目');
  });

  it('朴素重发基线：同一批事件会重复计费（> 0），幂等层把这部分挡掉了', async () => {
    const naive = await runNaiveBaseline({ events: SAMPLE_EVENTS, seed: SEED });
    const idempotent = await runScaleRun({ events: SAMPLE_EVENTS, seed: SEED });

    assert.ok(
      naive.metrics.peer_duplicate_charges > 0,
      '没有幂等层时重复扫码会被重复计费，重复条数应大于 0',
    );
    assert.equal(
      naive.metrics.peer_duplicate_charges,
      naive.metrics.extra_charged_entries,
      '多计的条数应等于对端收到的重复计费条数',
    );
    assert.equal(idempotent.metrics.peer_duplicate_charges, 0);
    assert.ok(naive.metrics.charged_entries > idempotent.metrics.charged_entries);
    assert.ok(naive.metrics.ledger_rows > idempotent.metrics.ledger_rows);
  });
});
