/**
 * test_charge_batch：计费请求分批与字段长度边界（按对端限批切分）。
 *
 * 替身说明：这里的「HIS 计费替身」是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走**同一条代码路径**（原生 fetch → 真实 socket → 真实请求头 / 请求体），
 * 不 mock fetch、不注入假响应对象。替身还能「让第 N 批失败」，用来验证
 * **某批整体失败不阻断其他批**。
 *
 * 覆盖：
 *   ① 250 条提交切成 3 批（上限 100 / 批），结论条数恒等于提交条数；
 *   ② 某批整体失败（5xx）时其余批照常成功，失败批的条目留在台账里等退避重投；
 *   ③ 字段超长即拒：**请求里不出现**该耗材码，给独立错误码并转人工核查；
 *   ④ 请求级字段（台次号 / 科室编码）超长 → 一个请求都不发；
 *   ⑤ 批次上限可配（默认 100，可按对端口径覆盖）；
 *   ⑥ 分批后对端收到的重复计费仍为 0（分批不改变幂等语义）；
 *   ⑦ 文档与错误码表同步（分批约定 + 长度上限 + 新错误码）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HisChargingClient } from '../src/charge/client.js';
import {
  CHARGE_BATCH_MAX_SIZE_DEFAULT,
  resolveChargeBatchSize,
  submitChargeBatches,
} from '../src/charge/batch.js';
import {
  CHARGE_ERROR_CODES,
  type ChargeLogRecord,
} from '../src/charge/client.js';
import {
  countReceipts,
  loadReceipts,
} from '../src/charge/receipt.js';
import { writeBackOperationCharges } from '../src/charge/writeback.js';
import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countBindings, readBindingStatus } from '../src/ledger/binding-repo.js';
import { countCheckTasks } from '../src/check/task.js';
import { listRetryCandidates } from '../src/charge/retry.js';
import { bindOne } from '../src/engine/binding.js';
import { deriveIdempotencyKey } from '../src/domain/idempotency.js';
import { ERROR_CODES } from '../src/log/error-codes.js';
import {
  defaultFieldLengthLimits,
  OUTBOUND_FIELD_LENGTH_LIMITS,
  checkFieldLength,
} from '../src/api/contracts.js';
import { startFakeHisServer, type FakeHisServer } from './support/fake-his-server.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

const TOKEN = 'his-charging-token-plaintext-b73d';
const ENDPOINT_PATH = '/api/v1/material-uses';
const OPERATION_NO = 'OP-BATCH-001';

/** 造一份主数据 CSV：N 条耗材 + 1 个台次 */
function operationsCsvFor(): string {
  return [
    'operation_no,room_no,dept_code,status,closed_at',
    `${OPERATION_NO},OR-01,SURG-01,open,`,
  ].join('\n');
}

/** 每个用例一份干净的内存台账 + 已绑定的耗材行 */
function freshLedger(materialCodes: string[]): LedgerDb {
  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, {
    operationsCsv: operationsCsvFor(),
    materialsCsv: materialsCsvFor(materialCodes),
  });
  for (const material_code of materialCodes) {
    const outcome = bindOne(ledger.db, {
      db: ledger.db,
      operation_no: OPERATION_NO,
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-07',
      material_code,
      raw_code: material_code,
      quantity: 1,
    });
    assert.equal(outcome.bound, true, `前置条件：${material_code} 应绑上台次`);
  }
  return ledger;
}

/** 只按耗材码列表生成耗材主数据 CSV */
function materialsCsvFor(materialCodes: string[]): string {
  const rows: string[] = [
    'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio',
  ];
  materialCodes.forEach((code, index) => {
    rows.push(
      `${code},高值耗材${index + 1},PR-BATCH-${String(index + 1).padStart(4, '0')},卫生材料,甲类,true,LOT-BATCH,包,支,支,1`,
    );
  });
  return rows.join('\n');
}

let server: FakeHisServer;
const logs: ChargeLogRecord[] = [];

before(async () => {
  server = await startFakeHisServer();
});

after(async () => {
  await server.close();
});

/** 起一个替身（用例可指定「让第 N 批失败」） */
async function startServer(
  options: Parameters<typeof startFakeHisServer>[0] = {},
): Promise<FakeHisServer> {
  return startFakeHisServer(options);
}

function newClient(baseUrl = server.baseUrl): HisChargingClient {
  return new HisChargingClient({
    baseUrl,
    token: TOKEN,
    timeoutMs: 5_000,
    logger: (record) => {
      logs.push(record);
    },
  });
}

describe('test_charge_batch · 分批切分与条数守恒', () => {
  it('① 250 条提交切成 3 批（每批 ≤ 100），结论条数恒等于提交条数', async () => {
    const codes = Array.from({ length: 250 }, (_, index) => `MAT-BATCH-${String(index + 1).padStart(4, '0')}`);
    const ledger = freshLedger(codes);
    await server.close();
    server = await startServer();
    try {
      const client = newClient();
      const result = await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client,
        path: ENDPOINT_PATH,
        maxBatchSize: CHARGE_BATCH_MAX_SIZE_DEFAULT,
      });

      // 分批：250 → 100 / 100 / 50
      assert.equal(result.batches, 3, '250 条按上限 100 应切成 3 批');
      assert.equal(result.calls, 3, '每批一次出站请求');
      assert.equal(result.submitted, 250, '提交条目数 = 250');
      assert.equal(server.requests.length, 3, '对端收到 3 个请求');
      assert.deepEqual(
        server.requests.map((request) => request.uses.length),
        [100, 100, 50],
        '每批条目数不得超过上限',
      );

      // 条数守恒：提交 250 条 → 250 条结论（回执），台账 250 行推进到 charged
      assert.equal(result.receipts.length, 250, '结论条数必须等于提交条数');
      assert.equal(result.accepted, 250);
      assert.equal(result.rejected, 0);
      assert.equal(countReceipts(ledger.db), 250, '回执行数 = 提交条数');
      assert.equal(countBindings(ledger.db), 250);
      assert.equal(result.failed_batches, 0);
      assert.equal(result.rejected_locally, 0);

      // 每条都拿到自己的回执（不靠耗材码反查）
      const receipts = loadReceipts(ledger.db, codes[0]!, OPERATION_NO);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]!.accepted, true);

      // 分批不改变幂等语义：对端收到的明细 250 条、零重复
      assert.equal(server.entries.length, 250);
      assert.equal(server.duplicateChargeCount, 0, '分批不得造成重复计费');
    } finally {
      ledger.close();
    }
  });

  it('② 某批整体失败（5xx）时其余批照常成功，失败批留在台账里等退避重投', async () => {
    const codes = Array.from({ length: 250 }, (_, index) => `MAT-BATCH-${String(index + 1).padStart(4, '0')}`);
    const ledger = freshLedger(codes);
    // 让第 2 批失败
    await server.close();
    server = await startServer({ failRequestIndexes: [2] });
    try {
      const client = newClient();
      const result = await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client,
        path: ENDPOINT_PATH,
        maxBatchSize: 100,
      });

      assert.equal(result.batches, 3);
      assert.equal(result.failed_batches, 1, '第 2 批整体失败');
      assert.equal(result.calls, 3);

      // 条数守恒：失败批的条目同样有回执（不静默丢弃）
      assert.equal(result.receipts.length, 250, '失败批的条目也要有回执');
      assert.equal(countReceipts(ledger.db), 250);
      assert.equal(result.accepted, 150, '第 1 批 100 条 + 第 3 批 50 条照常成功');
      assert.equal(result.error_code, CHARGE_ERROR_CODES.serverError);

      // 失败批的条目：状态停在 bound（等退避重投），回执标可重投
      const failedCode = codes[150]!; // 第 2 批的第一条
      const failedReceipts = loadReceipts(ledger.db, failedCode, OPERATION_NO);
      assert.equal(failedReceipts.length, 1);
      assert.equal(failedReceipts[0]!.accepted, false);
      assert.equal(failedReceipts[0]!.error_code, CHARGE_ERROR_CODES.serverError);
      assert.equal(failedReceipts[0]!.retryable, true, '5xx 可重投');
      assert.equal(
        readBindingStatus(ledger.db, failedCode, OPERATION_NO, deriveIdempotencyKey(failedCode, OPERATION_NO)),
        'bound',
        '失败批的条目留在 bound 等重投',
      );

      // 其余批的条目照常推进到 charged
      for (const code of [codes[0]!, codes[249]!]) {
        const receipts = loadReceipts(ledger.db, code, OPERATION_NO);
        assert.equal(receipts[0]!.accepted, true, '其余批照常成功');
        assert.equal(
          readBindingStatus(ledger.db, code, OPERATION_NO, deriveIdempotencyKey(code, OPERATION_NO)),
          'charged',
        );
      }

      // 失败批的 50 条进入退避重投候选（进程重启后也能重建）
      const pending = listRetryCandidates(ledger.db);
      assert.equal(pending.length, 100, '失败批的 100 条应进重投队列');

      // 审计链留了这一批的失败痕迹（带批序号）
      const failed = ledger.db
        .prepare(
          `SELECT detail FROM audit_chain WHERE event_type = 'charge_writeback_failed' ORDER BY id DESC LIMIT 1`,
        )
        .get() as { detail: string };
      const detail = JSON.parse(failed.detail) as { batch_index: number; submitted: number };
      assert.equal(detail.batch_index, 2, '审计留批序号');
      assert.equal(detail.submitted, 100, '失败批 100 条');
    } finally {
      ledger.close();
    }
  });

  it('⑤ 批次上限可配：上限 2 时 5 条切成 3 批', async () => {
    const codes = Array.from({ length: 5 }, (_, index) => `MAT-BATCH-${String(index + 1).padStart(4, '0')}`);
    const ledger = freshLedger(codes);
    await server.close();
    server = await startServer();
    try {
      const client = newClient();
      const result = await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client,
        path: ENDPOINT_PATH,
        maxBatchSize: 2,
      });

      assert.equal(result.batches, 3, '5 条按上限 2 应切成 3 批');
      assert.deepEqual(
        server.requests.map((request) => request.uses.length),
        [2, 2, 1],
      );
      assert.equal(result.receipts.length, 5, '结论条数守恒');
      assert.equal(result.accepted, 5);
    } finally {
      ledger.close();
    }
  });

  it('⑤ 批次上限非法值退回默认（不把整台手术塞进一个请求）', () => {
    assert.equal(resolveChargeBatchSize(undefined), CHARGE_BATCH_MAX_SIZE_DEFAULT);
    assert.equal(resolveChargeBatchSize(0), CHARGE_BATCH_MAX_SIZE_DEFAULT);
    assert.equal(resolveChargeBatchSize(-5), CHARGE_BATCH_MAX_SIZE_DEFAULT);
    assert.equal(resolveChargeBatchSize(1.5), CHARGE_BATCH_MAX_SIZE_DEFAULT);
    assert.equal(resolveChargeBatchSize(37), 37);
  });

  it('⑤ 分批提交器本身：某批失败不影响其余批（逐批独立结算）', async () => {
    await server.close();
    server = await startServer({ failRequestIndexes: [1] });
    const client = newClient();
    const uses = Array.from({ length: 5 }, (_, index) => ({
      material_code: `MAT-BATCH-${String(index + 1).padStart(4, '0')}`,
      quantity: 1,
      price_code: 'PR-BATCH-0001',
      use_time: '2026-01-15T09:12:00.000Z',
      fee_category: '卫生材料',
      medical_insurance_class: '甲类',
    }));

    const outcomes = await submitChargeBatches(
      client,
      OPERATION_NO,
      'SURG-01',
      uses.map((use) => ({ use, payload: use.material_code })),
      { path: ENDPOINT_PATH, maxBatchSize: 2 },
    );

    assert.equal(outcomes.length, 3);
    assert.equal(outcomes[0]!.status, 'failed', '第 1 批失败');
    assert.equal(outcomes[0]!.failure?.error_code, CHARGE_ERROR_CODES.serverError);
    assert.equal(outcomes[1]!.status, 'delivered');
    assert.equal(outcomes[2]!.status, 'delivered');
    assert.equal(outcomes.reduce((sum, outcome) => sum + outcome.size, 0), 5, '批内条目数守恒');
  });
});

describe('test_charge_batch · 字段长度边界', () => {
  it('③ 字段超长即拒：该耗材码不出现在任何请求里，给独立错误码并转人工核查', async () => {
    const codes = Array.from({ length: 3 }, (_, index) => `MAT-BATCH-${String(index + 1).padStart(4, '0')}`);
    // 40 位耗材码：入站能扫能绑（入站上限 64），但出站列宽放不下（出站上限 32）
    const longCode = `MAT-BATCH-${'X'.repeat(30)}`;
    const ledger = freshLedger([...codes, longCode]);
    await server.close();
    server = await startServer();
    try {
      const client = newClient();
      const result = await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client,
        path: ENDPOINT_PATH,
        maxBatchSize: 100,
      });

      // 超长的那一条被本地拒掉：请求里不出现
      const sentCodes = server.requests.flatMap((request) => request.uses.map((use) => use.material_code));
      assert.equal(sentCodes.includes(longCode), false, '超长字段不得出现在请求里');
      assert.equal(sentCodes.length, 3, '其余 3 条照常提交');
      assert.equal(result.rejected_locally, 1);
      assert.equal(result.submitted, 3);

      // 独立错误码 + 核查条目 + 台账转人工
      const receipts = loadReceipts(ledger.db, longCode, OPERATION_NO);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]!.error_code, CHARGE_ERROR_CODES.fieldTooLong);
      assert.equal(receipts[0]!.accepted, false);
      assert.equal(receipts[0]!.retryable, false, '超长不是通道问题，重投没有意义');
      assert.equal(countCheckTasks(ledger.db), 1, '超长条目要转人工核查');
      assert.equal(
        readBindingStatus(ledger.db, longCode, OPERATION_NO, deriveIdempotencyKey(longCode, OPERATION_NO)),
        'check_pending',
      );

      // 条数守恒：4 条提交 → 4 条结论
      assert.equal(result.receipts.length, 4);
      assert.equal(countReceipts(ledger.db), 4);

      // 其余 3 条照常计费成功
      assert.equal(result.accepted, 3);
      for (const code of codes) {
        const row = loadReceipts(ledger.db, code, OPERATION_NO)[0]!;
        assert.equal(row.accepted, true);
      }
    } finally {
      ledger.close();
    }
  });

  it('③ 超长是「拒」不是「截断」：请求里的耗材码与主数据逐字一致', async () => {
    const code = 'MAT-BATCH-0001';
    const ledger = freshLedger([code]);
    try {
      const client = newClient();
      await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client,
        path: ENDPOINT_PATH,
      });

      const sent = server.requests[0]!.uses[0]!;
      assert.equal(sent.material_code, code, '不得截断后照发');
    } finally {
      ledger.close();
    }
  });

  it('④ 请求级字段（科室编码）超长 → 一个请求都不发，全部条目本地拒收', async () => {
    const codes = Array.from({ length: 3 }, (_, index) => `MAT-BATCH-${String(index + 1).padStart(4, '0')}`);
    const ledger = freshLedger(codes);
    await server.close();
    server = await startServer();
    try {
      const client = newClient();
      // 科室编码 33 位 > 出站上限 32
      const result = await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client,
        path: ENDPOINT_PATH,
        dept_code: 'D'.repeat(33),
      });

      assert.equal(server.requests.length, 0, '抬头有问题就不该发出请求');
      assert.equal(result.calls, 0);
      assert.equal(result.rejected_locally, 3);
      assert.equal(result.error_code, CHARGE_ERROR_CODES.fieldTooLong);
      assert.equal(result.receipts.length, 3, '条目仍各有结论（不静默丢弃）');
      assert.equal(countReceipts(ledger.db), 3);
    } finally {
      ledger.close();
    }
  });

  it('③ 长度上限表：四个关键字段都有上限，超长即判越界', () => {
    const limits = defaultFieldLengthLimits();
    assert.equal(limits['operation_no'], 64);
    assert.equal(limits['dept_code'], 32);
    // 出站的耗材码上限比入站（64）更紧：扫码枪扫得出来 ≠ HIS 计费表放得下
    assert.equal(limits['material_code'], 32);
    assert.equal(limits['price_code'], 32);

    for (const field of ['operation_no', 'dept_code', 'material_code', 'price_code']) {
      const limit = limits[field]!;
      const within = checkFieldLength(field, 'x'.repeat(limit), limits);
      assert.equal(within.exceeded, false, `${field} 恰好等于上限不算越界`);
      const over = checkFieldLength(field, 'x'.repeat(limit + 1), limits);
      assert.equal(over.exceeded, true, `${field} 超过上限即越界`);
      assert.equal(over.actual, limit + 1);
    }

    // 未登记的字段不限长（不擅自给未登记字段设上限）
    assert.equal(checkFieldLength('use_time', 'x'.repeat(500), limits).exceeded, false);
    assert.equal(Object.keys(OUTBOUND_FIELD_LENGTH_LIMITS).length, 4);
  });
});

describe('test_charge_batch · 文档与错误码同步', () => {
  it('⑦ 出站规范文档写清分批约定、长度上限与新错误码', () => {
    const doc = readFileSync(resolve(projectRoot, 'docs', 'api', 'his-charging.md'), 'utf8');
    assert.ok(doc.includes('分批'), '文档须写分批约定');
    assert.ok(doc.includes('HIS_CHARGING_MAX_BATCH_SIZE'), '文档须写批次上限配置项');
    assert.ok(doc.includes('ERR_CHARGE_FIELD_TOO_LONG'), '文档须写新的字段超长错误码');
    for (const field of ['operation_no', 'dept_code', 'material_code', 'price_code']) {
      assert.ok(doc.includes(field), `文档须写长度上限字段 ${field}`);
    }
    for (const limit of Object.values(defaultFieldLengthLimits())) {
      assert.ok(doc.includes(String(limit)), `文档须写长度上限 ${limit}`);
    }
  });

  it('⑦ 统一错误码表含新码，错误码文档逐码对齐', () => {
    const entry = ERROR_CODES.find((item) => item.code === CHARGE_ERROR_CODES.fieldTooLong);
    assert.ok(entry, '错误码表须含 ERR_CHARGE_FIELD_TOO_LONG');
    assert.equal(entry!.stage, 'charge');
    assert.equal(entry!.retryable, false, '超长重投没有意义');
    assert.equal(entry!.needs_manual, true);

    const doc = readFileSync(resolve(projectRoot, 'docs', 'api', 'errors.md'), 'utf8');
    assert.ok(doc.includes(CHARGE_ERROR_CODES.fieldTooLong), '错误码文档须含新码');
    assert.ok(doc.includes(entry!.meaning_zh), '错误码文档须含新码的中文含义');
  });
});
