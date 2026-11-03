/**
 * test_concurrency：并发同键串行化与租约争用（对照基线：朴素实现重复计费）。
 *
 * 本测试用**小样本**跑同一套断言（CI 里要快），完整的 200 并发由
 * `npm run bench:concurrency` 产出（产物：data/bench/concurrency.json 与
 * docs/benchmarks/concurrency-benchmark.md）。
 *
 * 覆盖：
 *   ① **租约层**：并发 20 次抢同一把幂等键 → 只有 1 个拿到租约、19 个 busy；
 *      拿到租约的那个完成绑定 → 台账 1 行；关台回写 → 计费 1 次、对端 0 条重复计费；
 *   ② **端到端并发**：20 次并发 HTTP 投递同一条扫码 → 台账 1 行、计费 1 次、
 *      绑上 1 次、其余 19 次被拒（租约忙 / 重复扫码），对端 0 条重复计费；
 *   ③ **租约争用**：持有者占位不确认 → 20 次并发投递全部 busy、台账 0 行、
 *      争用期 0 次计费；租约到期后接管 → 台账 1 行、计费 1 次、claim_count 递增；
 *   ④ **朴素基线**：同一批并发投递，无幂等层 → 台账多行、对端出现重复计费。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HisChargingClient } from '../src/charge/client.js';
import { writeBackOperationCharges } from '../src/charge/writeback.js';
import { deriveIdempotencyKey } from '../src/domain/idempotency.js';
import { countBindings, insertBinding } from '../src/ledger/binding-repo.js';
import { claim, confirm, getClaim } from '../src/ledger/claim.js';
import { openLedger } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { startFakeHisServer } from './support/fake-his-server.js';
import {
  benchmarkMasterDataCsv,
  DEFAULT_FIXTURE,
  runIdempotentConcurrency,
  runLeaseContention,
  runNaiveConcurrency,
} from '../scripts/lib/concurrency-harness.js';

/** CI 用的小样本（完整 200 并发见 npm run bench:concurrency） */
const SAMPLE_CONCURRENCY = 20;
const CHARGE_PATH = '/api/v1/material-uses';

const fixture = DEFAULT_FIXTURE;
const key = deriveIdempotencyKey(fixture.material_code, fixture.operation_no);

/** 压测用例不刷屏：结构化日志在 tests/logging.test.ts 里单独验证 */
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
  level: 'error' as const,
};

describe('test_concurrency · 并发同键串行化', () => {
  it('租约层：并发 20 次抢同一把键 → 1 个拿到租约、19 个 busy；台账 1 行、计费 1 次', async () => {
    const ledger = openLedger(':memory:');
    importMasterData(ledger.db, benchmarkMasterDataCsv(fixture));
    const peer = await startFakeHisServer();
    try {
      // ① 并发抢同一把幂等键
      const leases = await Promise.all(
        Array.from({ length: SAMPLE_CONCURRENCY }, async () =>
          claim(ledger.db, key, {
            leaseMs: 60_000,
            operation_no: fixture.operation_no,
            material_code: fixture.material_code,
            scanner_id: fixture.scanner_id,
          }),
        ),
      );

      const claimed = leases.filter((item) => item.status === 'claimed');
      const busy = leases.filter((item) => item.status === 'busy');
      assert.equal(claimed.length, 1, '并发同键只应有一个拿到租约');
      assert.equal(busy.length, 19, '其余 19 个应当拿到 busy（不重复处理）');
      for (const item of busy) assert.equal(item.token, null, 'busy 的不发放令牌');

      // ② 拿到租约的那个完成绑定（与 bindOne 拿到租约后的动作一致）
      const winner = claimed[0] as { token: string };
      insertBinding(ledger.db, {
        idempotency_key: key,
        operation_no: fixture.operation_no,
        room_no: fixture.room_no,
        dept_code: fixture.dept_code,
        material_code: fixture.material_code,
        quantity: 1,
        price_code: 'PR-CONC-01',
        fee_category: '卫生材料',
        medical_insurance_class: '甲类',
        conclusion: 'BOUND',
        status: 'bound',
        raw_code: fixture.material_code,
      });
      confirm(ledger.db, key, winner.token);
      assert.equal(countBindings(ledger.db), 1, '并发 20 次同键只应落 1 行台账');
      assert.equal(getClaim(ledger.db, key)?.state, 'confirmed');

      // ③ 关台回写：只计费一次，对端不收到重复计费
      const client = new HisChargingClient({
        baseUrl: peer.baseUrl,
        token: 'concurrency-his-token-local',
        logger: () => {},
      });
      const writeback = await writeBackOperationCharges(ledger.db, fixture.operation_no, {
        client,
        path: CHARGE_PATH,
        dept_code: fixture.dept_code,
        logger: silentLogger,
      });
      assert.equal(writeback.calls, 1, '计费请求次数应为 1');
      assert.equal(writeback.submitted, 1, '计费明细条数应为 1');
      assert.equal(peer.requests.length, 1);
      assert.equal(peer.duplicateChargeCount, 0, '对端不应收到重复计费');
    } finally {
      await peer.close();
      ledger.close();
    }
  });

  it('端到端：20 次并发 HTTP 投递同一条扫码 → 台账 1 行、计费 1 次、零重复计费', async () => {
    const { metrics } = await runIdempotentConcurrency({ concurrency: SAMPLE_CONCURRENCY });

    assert.equal(metrics.http_errors, 0, '入站请求不应有非 200');
    assert.equal(metrics.http_ok, SAMPLE_CONCURRENCY);
    assert.equal(metrics.bound_responses, 1, '同一条扫码只应绑上 1 次');
    assert.equal(
      metrics.busy_count + metrics.duplicate_count,
      SAMPLE_CONCURRENCY - 1,
      '其余 19 次都应被拒（租约忙或重复扫码）',
    );
    assert.equal(metrics.other_rejected_count, 0, '不应出现其它原因码');

    assert.equal(metrics.ledger_rows, 1, '台账只应落 1 行');
    assert.equal(metrics.charge_calls, 1, '计费请求次数应为 1');
    assert.equal(metrics.charged_entries, 1, '计费明细条数应为 1');
    assert.equal(metrics.peer_entries, 1);
    assert.equal(metrics.peer_duplicate_charges, 0, '对端不应收到重复计费');
  });

  it('租约争用：持有者占位不确认 → 20 次并发投递全部 busy；到期后接管并结算一次', async () => {
    const { metrics } = await runLeaseContention({
      contention: SAMPLE_CONCURRENCY,
      leaseMs: 2_000,
    });

    assert.equal(metrics.busy_count, SAMPLE_CONCURRENCY, '争用窗口内全部应拿到 busy');
    assert.equal(metrics.bound_during_contention, 0, '争用窗口内不应有绑上的条目');
    assert.equal(metrics.ledger_rows_after_takeover, 1, '接管后台账仍只有 1 行');
    assert.equal(metrics.charge_calls_after_takeover, 1, '接管后只计费一次');
    assert.equal(metrics.charged_entries_after_takeover, 1);
    assert.equal(metrics.peer_duplicate_charges, 0, '对端不应收到重复计费');
    assert.equal(metrics.claim_count, 2, '接管一次 claim_count 应递增到 2');
  });

  it('朴素基线：同一批并发投递、无幂等层 → 台账多行且对端出现重复计费', async () => {
    const { metrics } = await runNaiveConcurrency({
      concurrency: SAMPLE_CONCURRENCY,
      gapMs: 30,
    });

    assert.ok(
      metrics.ledger_rows > 1,
      '没有幂等层时并发投递会落多行台账（实际行数应等于并发数）',
    );
    assert.equal(metrics.ledger_rows, SAMPLE_CONCURRENCY);
    assert.ok(
      metrics.peer_duplicate_charges > 0,
      '没有幂等层时对端会收到重复计费',
    );
    assert.equal(
      metrics.peer_duplicate_charges,
      metrics.charged_entries - 1,
      '重复计费条数应等于明细条数减去重的那一条',
    );
  });

  it('朴素基线 · 无异步间隙：查重与写库在同一同步块里时不会重复（说明重复来自间隙）', async () => {
    const { metrics } = await runNaiveConcurrency({ concurrency: SAMPLE_CONCURRENCY, gapMs: 0 });

    assert.equal(metrics.ledger_rows, 1, '没有 await 间隙时先查后写是原子的');
    assert.equal(metrics.peer_duplicate_charges, 0);
  });
});
