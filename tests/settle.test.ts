/**
 * test_settle：批量结算（逐条独立结算 · 单条失败不丢同批其余 · 批内去重）。
 *
 * 覆盖：
 *   ① 6 条批次中第 3 条抛错 → 其余 5 条仍全部返回结论，抛错那条落 rejected；
 *   ② 同批重复的 (material_code, operation_no) 只结算一次，其余标批内重复；
 *   ③ 默认处理器（绑定判定主路）→ 5 条绑上 + 1 条耗材码未建档，台账落 5 行；
 *   ④ 批次统计守恒：accepted + rejected === total；
 *   ⑤ 多批结算：不同台次互不干扰；同名耗材跨台次按「跨台次重复」拒后到者。
 *
 * 每个用例用**独立的内存台账**，互不干扰（台账行数、幂等占位、核查条目都从 0 起算）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { countCheckTasks } from '../src/check/task.js';
import { bindOne } from '../src/engine/binding.js';
import {
  settleBatch,
  settleEvent,
  REASON_DUPLICATE_IN_BATCH,
  type SettleBatch,
  type SettleProcessor,
} from '../src/engine/settle.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

/** 每个用例一份干净的内存台账 */
function freshLedger(): LedgerDb {
  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  return ledger;
}

function item(material_code: string, quantity = 1) {
  return { material_code, raw_code: material_code, quantity };
}

/** 一批 6 条：5 条主数据命中 + 1 条未建档 */
function sixItemBatch(): SettleBatch {
  return {
    operation_no: 'OP-SAMPLE-001',
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    items: [
      item('MAT-SAMPLE-01'),
      item('MAT-SAMPLE-02', 2),
      item('MAT-SAMPLE-03'),
      item('MAT-SAMPLE-04'),
      item('MAT-SAMPLE-05'),
      item('MAT-UNKNOWN-99'),
    ],
  };
}

function countRows(db: LedgerDb['db'], sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as { n: number } | undefined;
  return row?.n ?? 0;
}

describe('test_settle · 单条失败不丢同批其余', () => {
  it('6 条批次中第 3 条抛错，其余 5 条仍全部返回结论', () => {
    const ledger = freshLedger();
    try {
      const before = countBindings(ledger.db);
      const processor: SettleProcessor = (ctx) => {
        if (ctx.material_code === 'MAT-SAMPLE-03') {
          throw new Error('模拟第 3 条结算失败：台账写入异常');
        }
        return bindOne(ctx.db, ctx);
      };

      const result = settleBatch(ledger.db, [sixItemBatch()], { processor });

      // 结论条数守恒：6 条一条不丢
      assert.equal(result.stats.total, 6);
      assert.equal(result.accepted.length + result.rejected.length, 6);

      // 抛错那条只影响自己
      const failed = result.rejected.find((one) => one.material_code === 'MAT-SAMPLE-03');
      assert.ok(failed, '抛错的第 3 条应落在 rejected 里');
      assert.equal(failed.bound, false);
      assert.equal(failed.reason_code, 'INTERNAL_ERROR');
      assert.match(String(failed.detail ?? ''), /模拟第 3 条结算失败/);

      // 其余 5 条照常给结论
      const concluded = [...result.accepted, ...result.rejected]
        .filter((one) => one.material_code !== 'MAT-SAMPLE-03')
        .map((one) => one.material_code)
        .sort();
      assert.deepEqual(concluded, [
        'MAT-SAMPLE-01',
        'MAT-SAMPLE-02',
        'MAT-SAMPLE-04',
        'MAT-SAMPLE-05',
        'MAT-UNKNOWN-99',
      ]);

      // 绑定成功的 4 条落台账；抛错那条**不落台账**（失败不静默改数据）
      assert.equal(result.accepted.length, 4);
      assert.equal(countBindings(ledger.db) - before, 4);
      assert.equal(
        countRows(ledger.db, 'SELECT COUNT(*) AS n FROM material_binding WHERE material_code = ?', 'MAT-SAMPLE-03'),
        0,
      );
    } finally {
      ledger.close();
    }
  });

  it('结算顺序保持条目顺序，抛错不打断后续条目', () => {
    const ledger = freshLedger();
    try {
      const seen: string[] = [];
      const processor: SettleProcessor = (ctx) => {
        seen.push(ctx.material_code);
        if (ctx.material_code === 'MAT-SAMPLE-02') throw new Error('第 2 条失败');
        return {
          material_code: ctx.material_code,
          operation_no: ctx.operation_no,
          bound: true,
          conclusion: 'BOUND',
          reason_code: null,
          error_code: null,
          charge_state: 'not_submitted',
        };
      };

      const result = settleBatch(ledger.db, [sixItemBatch()], { processor });

      assert.deepEqual(seen, [
        'MAT-SAMPLE-01',
        'MAT-SAMPLE-02',
        'MAT-SAMPLE-03',
        'MAT-SAMPLE-04',
        'MAT-SAMPLE-05',
        'MAT-UNKNOWN-99',
      ]);
      assert.equal(result.accepted.length, 5);
      assert.equal(result.rejected.length, 1);
      assert.equal(result.stats.total, 6);
    } finally {
      ledger.close();
    }
  });
});

describe('test_settle · 批内去重', () => {
  it('同批重复的 (material_code, operation_no) 只结算一次，其余标批内重复', () => {
    const ledger = freshLedger();
    try {
      const before = countBindings(ledger.db);
      const batch: SettleBatch = {
        operation_no: 'OP-SAMPLE-002',
        room_no: 'OR-02',
        scanner_id: 'SCAN-GUN-07',
        items: [item('MAT-SAMPLE-03'), item('MAT-SAMPLE-03'), item('MAT-SAMPLE-04')],
      };

      const result = settleBatch(ledger.db, [batch]);

      assert.equal(result.stats.total, 3);
      assert.equal(result.stats.duplicate_in_batch, 1);
      assert.equal(result.accepted.length, 2);
      assert.equal(result.rejected.length, 1);

      const duplicated = result.rejected[0];
      assert.ok(duplicated, '批内重复那条应落在 rejected 里');
      assert.equal(duplicated.material_code, 'MAT-SAMPLE-03');
      assert.equal(duplicated.reason_code, REASON_DUPLICATE_IN_BATCH);
      assert.equal(duplicated.bound, false);

      // 只落一行台账（不重复计费）
      assert.equal(countBindings(ledger.db) - before, 2);
      assert.equal(
        countRows(
          ledger.db,
          'SELECT COUNT(*) AS n FROM material_binding WHERE material_code = ? AND operation_no = ?',
          'MAT-SAMPLE-03',
          'OP-SAMPLE-002',
        ),
        1,
      );
    } finally {
      ledger.close();
    }
  });

  it('批内重复不重复占位：同键只占一次幂等位', () => {
    const ledger = freshLedger();
    try {
      const before = countRows(ledger.db, 'SELECT COUNT(*) AS n FROM idempotency_claim');
      const batch: SettleBatch = {
        operation_no: 'OP-SAMPLE-002',
        room_no: 'OR-02',
        scanner_id: 'SCAN-GUN-07',
        items: [item('MAT-SAMPLE-03'), item('MAT-SAMPLE-03')],
      };

      const result = settleBatch(ledger.db, [batch]);

      // 第二条在结算之前就被批内去重挡下，不占位、不写台账
      assert.equal(result.stats.duplicate_in_batch, 1);
      assert.equal(
        countRows(ledger.db, 'SELECT COUNT(*) AS n FROM idempotency_claim') - before,
        1,
      );
      assert.equal(countRows(ledger.db, 'SELECT COUNT(*) AS n FROM material_binding'), 1);
    } finally {
      ledger.close();
    }
  });
});

describe('test_settle · 默认处理器（绑定判定主路）', () => {
  it('6 条批次 → 5 条绑上 + 1 条耗材码未建档，台账落 5 行', () => {
    const ledger = freshLedger();
    try {
      const before = countBindings(ledger.db);
      const beforeChecks = countCheckTasks(ledger.db);

      const result = settleEvent(ledger.db, sixItemBatch());

      assert.equal(result.stats.total, 6);
      assert.equal(result.stats.accepted, 5);
      assert.equal(result.stats.rejected, 1);
      assert.equal(result.stats.duplicate_in_batch, 0);

      for (const outcome of result.accepted) {
        assert.equal(outcome.conclusion, 'BOUND');
        assert.equal(outcome.bound, true);
        assert.equal(outcome.operation_no, 'OP-SAMPLE-001');
        assert.equal(outcome.charge_state, 'not_submitted');
      }

      const rejected = result.rejected[0];
      assert.ok(rejected, '未建档那条应落在 rejected 里');
      assert.equal(rejected.material_code, 'MAT-UNKNOWN-99');
      assert.equal(rejected.reason_code, 'MATERIAL_NOT_REGISTERED');

      // 台账 5 行；未建档那条不落台账但升成核查条目
      assert.equal(countBindings(ledger.db) - before, 5);
      assert.equal(countCheckTasks(ledger.db) - beforeChecks, 1);
    } finally {
      ledger.close();
    }
  });

  it('多批结算：不同台次互不干扰，各自落一行台账', () => {
    const ledger = freshLedger();
    try {
      const before = countBindings(ledger.db);
      const result = settleBatch(ledger.db, [
        {
          operation_no: 'OP-SAMPLE-001',
          room_no: 'OR-01',
          scanner_id: 'SCAN-GUN-07',
          items: [item('MAT-SAMPLE-02')],
        },
        {
          operation_no: 'OP-SAMPLE-002',
          room_no: 'OR-02',
          scanner_id: 'SCAN-GUN-07',
          items: [item('MAT-SAMPLE-03')],
        },
      ]);

      assert.equal(result.stats.total, 2);
      assert.equal(result.stats.accepted, 2);
      assert.equal(result.stats.duplicate_in_batch, 0);
      assert.equal(countBindings(ledger.db) - before, 2);
    } finally {
      ledger.close();
    }
  });

  it('同名耗材跨台次：后到者按「跨台次重复」拒，先到者记录保留', () => {
    const ledger = freshLedger();
    try {
      const result = settleBatch(ledger.db, [
        {
          operation_no: 'OP-SAMPLE-001',
          room_no: 'OR-01',
          scanner_id: 'SCAN-GUN-07',
          items: [item('MAT-SAMPLE-02')],
        },
        {
          operation_no: 'OP-SAMPLE-002',
          room_no: 'OR-02',
          scanner_id: 'SCAN-GUN-07',
          items: [item('MAT-SAMPLE-02')],
        },
      ]);

      assert.equal(result.stats.accepted, 1);
      assert.equal(result.stats.rejected, 1);
      assert.equal(result.rejected[0]?.conclusion, 'CROSS_OP_DUP');
      assert.equal(result.rejected[0]?.operation_no, 'OP-SAMPLE-002');

      // 先到者的台账行原样保留
      assert.equal(
        countRows(
          ledger.db,
          'SELECT COUNT(*) AS n FROM material_binding WHERE material_code = ? AND operation_no = ?',
          'MAT-SAMPLE-02',
          'OP-SAMPLE-001',
        ),
        1,
      );
    } finally {
      ledger.close();
    }
  });

  it('重复投递同一批：已入台账的条目判重复扫码，不产生第二行', () => {
    const ledger = freshLedger();
    try {
      const first = settleEvent(ledger.db, sixItemBatch());
      assert.equal(first.stats.accepted, 5);

      const before = countBindings(ledger.db);
      const second = settleEvent(ledger.db, sixItemBatch());

      assert.equal(second.stats.accepted, 0);
      assert.equal(second.stats.rejected, 6);
      assert.equal(countBindings(ledger.db) - before, 0);

      // 5 条已入台账 → 判重复扫码；未建档那条仍是耗材码未建档
      const reasons = second.rejected.map((one) => one.reason_code).sort();
      assert.deepEqual(reasons, [
        'DUPLICATE_SCAN',
        'DUPLICATE_SCAN',
        'DUPLICATE_SCAN',
        'DUPLICATE_SCAN',
        'DUPLICATE_SCAN',
        'MATERIAL_NOT_REGISTERED',
      ]);
    } finally {
      ledger.close();
    }
  });
});
