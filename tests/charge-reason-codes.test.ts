/**
 * test_charge_reason_codes：计费回执 reason_code 全集与「可重投 / 不可重投 / 需人工」三档判定。
 *
 * 覆盖：
 *   ① 判定表自身：每码有中文含义 / 建议处置 / 已登记的统一错误码；档位与「可重投」标记一致；
 *   ② 三档分流各 ≥2 个码：可重投 / 不可重投 / 需人工的回执定性正确；
 *   ③ 未知码落入「需人工 + 不可重投」，原始码进审计链与错误码表待补项；
 *   ④ 兜底：对端回执为空 / 响应结构不符 → 按通道不可达处理并进重投，不静默当成成功；
 *   ⑤ 端到端：可重投的拒收进退避队列（不生成核查条目）、不可重投与需人工立即转核查条目；
 *   ⑥ 回执行落库带处置档位列；判定表与 docs/api/errors.md 的回执码小节逐码对齐。
 *
 * 替身说明：HIS 计费替身是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走同一条代码路径（原生 fetch → 真实 socket），不 mock fetch。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';

import { HisChargingClient } from '../src/charge/client.js';
import { submitMaterialUses } from '../src/charge/submit.js';
import {
  CHARGE_RECEIPT_KINDS,
  classifyReceipts,
  loadReceipts,
} from '../src/charge/receipt.js';
import {
  RECEIPT_DISPOSITIONS,
  RECEIPT_REASON_CODES,
  disposeReceiptReason,
  isKnownReceiptReason,
  listReceiptReasonCodes,
  receiptReasonsByDisposition,
} from '../src/charge/reason-codes.js';
import {
  ChargeRetryScheduler,
  toMaterialUse,
  type ChargeItem,
  type ChargeSubmitFn,
} from '../src/charge/retry.js';
import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { readBindingStatus } from '../src/ledger/binding-repo.js';
import { queryAuditByType, countAuditByType } from '../src/ledger/audit.js';
import { findCheckTask } from '../src/check/task.js';
import {
  ERROR_CODES,
  ERROR_CODE_MAP,
  clearPendingErrorCodes,
  listPendingErrorCodes,
} from '../src/log/error-codes.js';
import { deriveIdempotencyKey } from '../src/domain/idempotency.js';
import { bindOne } from '../src/engine/binding.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const TOKEN = 'his-charging-token-plaintext-7c41';
const ENDPOINT_PATH = '/api/v1/material-uses';

interface StubBehavior {
  status?: number;
  body?: string;
}

/** HIS 计费替身：真实 HTTP 服务，行为按队列逐次给出 */
class HisChargingStub {
  readonly requests: Array<{ method: string; url: string; body: string }> = [];
  private readonly server: Server;
  private readonly behaviors: StubBehavior[] = [];
  baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const behavior = this.behaviors.shift() ?? {
          status: 200,
          body: JSON.stringify({ accepted: [], rejected: [] }),
        };
        const status = behavior.status ?? 200;
        const body = behavior.body ?? JSON.stringify({ accepted: [], rejected: [] });
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(body);
      });
      res.on('error', () => {
        // 客户端超时后主动断开：忽略写回失败（替身侧）
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((done) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          done();
          return;
        }
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        done();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => {
      this.server.close(() => done());
    });
  }

  push(behavior: StubBehavior): void {
    this.behaviors.push(behavior);
  }

  reset(): void {
    this.requests.length = 0;
    this.behaviors.length = 0;
  }
}

const stub = new HisChargingStub();

before(async () => {
  await stub.start();
});

after(async () => {
  await stub.stop();
});

beforeEach(() => {
  stub.reset();
  clearPendingErrorCodes();
});

/** 每个用例一份干净的内存台账（主数据已导入） */
function freshLedger(): LedgerDb {
  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  return ledger;
}

/** 造一条已绑定（status = bound）的台账行 */
function bindMaterial(
  ledger: LedgerDb,
  material_code = 'MAT-SAMPLE-01',
  operation_no = 'OP-SAMPLE-001',
): { idempotency_key: string } {
  const outcome = bindOne(ledger.db, {
    db: ledger.db,
    operation_no,
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    material_code,
    raw_code: material_code,
    quantity: 1,
  });
  assert.equal(outcome.bound, true, '前置条件：这条耗材应绑上台次');
  return { idempotency_key: deriveIdempotencyKey(material_code, operation_no) };
}

function chargeItem(
  material_code = 'MAT-SAMPLE-01',
  operation_no = 'OP-SAMPLE-001',
): ChargeItem {
  return {
    material_code,
    operation_no,
    room_no: 'OR-01',
    dept_code: 'SURG-01',
    scanner_id: 'SCAN-GUN-07',
    quantity: 1,
    price_code: 'PR-SAMPLE-01',
    use_time: '2026-01-15T09:12:00.000Z',
    fee_category: '卫生材料',
    medical_insurance_class: '甲类',
    idempotency_key: deriveIdempotencyKey(material_code, operation_no),
    key_profile: 'v1',
  };
}

/** 接到真实出站客户端的投递函数（与生产同一条代码路径） */
function makeSubmit(timeoutMs = 2_000): ChargeSubmitFn {
  const client = new HisChargingClient({
    baseUrl: stub.baseUrl,
    token: TOKEN,
    timeoutMs,
    logger: () => {
      // 测试里不落日志
    },
  });
  return async (item: ChargeItem) =>
    submitMaterialUses(client, item.operation_no, item.dept_code, [toMaterialUse(item)], {
      path: ENDPOINT_PATH,
    });
}

/** 让对端拒收某一条耗材，理由码由用例给定 */
function rejectWith(reason_code: string, material_code = 'MAT-SAMPLE-01'): void {
  stub.push({
    status: 200,
    body: JSON.stringify({
      accepted: [],
      rejected: [{ material_code, reason_code }],
    }),
  });
}

/** 造一条回执（只测逐条定性，不落库） */
function receiptFor(reason_code: string): ReturnType<typeof classifyReceipts>[number] {
  const receipts = classifyReceipts({
    response: {
      accepted: [],
      rejected: [{ material_code: 'MAT-SAMPLE-01', reason_code }],
    },
    submitted: [
      {
        material_code: 'MAT-SAMPLE-01',
        quantity: 1,
        price_code: 'PR-SAMPLE-01',
        use_time: '2026-01-15T09:12:00.000Z',
        fee_category: '卫生材料',
        medical_insurance_class: '甲类',
      },
    ],
    operation_no: 'OP-SAMPLE-001',
    attempt: 1,
  });
  return receipts[0]!;
}

describe('test_charge_reason_codes · 判定表自身', () => {
  it('① 每个码都有中文含义 / 建议处置 / 已登记的统一错误码，且档位与「可重投」标记一致', () => {
    assert.ok(RECEIPT_REASON_CODES.length >= 12, '判定表至少覆盖 12 个回执码');
    for (const entry of RECEIPT_REASON_CODES) {
      assert.ok(entry.meaning_zh.length > 0, `${entry.code} 缺中文含义`);
      assert.ok(entry.action_zh.length > 0, `${entry.code} 缺建议处置`);
      assert.ok(entry.error_code.startsWith('ERR_'), `${entry.code} 的统一错误码应以 ERR_ 开头`);
      const registered = ERROR_CODE_MAP.get(entry.error_code);
      assert.ok(registered, `${entry.code} 的统一错误码 ${entry.error_code} 未登记进错误码表`);
      assert.equal(
        registered!.retryable,
        entry.disposition === RECEIPT_DISPOSITIONS.RETRYABLE,
        `${entry.code} 的处置档位与统一错误码的可重投标记不一致`,
      );
      assert.equal(
        registered!.needs_manual,
        entry.disposition !== RECEIPT_DISPOSITIONS.RETRYABLE,
        `${entry.code} 的处置档位与统一错误码的人工介入标记不一致`,
      );
    }
  });

  it('② 三档各有 ≥2 个码，且判定表能按档位筛出来', () => {
    for (const disposition of [
      RECEIPT_DISPOSITIONS.RETRYABLE,
      RECEIPT_DISPOSITIONS.NOT_RETRYABLE,
      RECEIPT_DISPOSITIONS.NEEDS_HUMAN,
    ]) {
      const entries = receiptReasonsByDisposition(disposition);
      assert.ok(entries.length >= 2, `${disposition} 档至少要有 2 个码，实际 ${entries.length}`);
    }
    assert.equal(listReceiptReasonCodes().length, RECEIPT_REASON_CODES.length);
  });

  it('③ 判定表里的码与错误码表逐码对齐（每个码都有对应的 ERR_* 且在错误码表里登记）', () => {
    const codes = new Set(ERROR_CODES.map((entry) => entry.code));
    for (const entry of RECEIPT_REASON_CODES) {
      assert.ok(codes.has(entry.error_code), `错误码表缺 ${entry.error_code}`);
      assert.ok(isKnownReceiptReason(entry.code), `${entry.code} 应在判定表里`);
    }
  });
});

describe('test_charge_reason_codes · 三档分流', () => {
  it('④ 可重投档 2 条：限流 / 服务繁忙 → 可重投，进退避队列', () => {
    for (const [reason, errorCode] of [
      ['PEER_RATE_LIMITED', 'ERR_CHARGE_RATE_LIMITED'],
      ['PEER_SERVICE_BUSY', 'ERR_CHARGE_SERVICE_BUSY'],
    ] as const) {
      const receipt = receiptFor(reason);
      assert.equal(receipt.accepted, false);
      assert.equal(receipt.kind, CHARGE_RECEIPT_KINDS.business_rejected);
      assert.equal(receipt.reason_code, reason);
      assert.equal(receipt.error_code, errorCode);
      assert.equal(receipt.disposition, RECEIPT_DISPOSITIONS.RETRYABLE);
      assert.equal(receipt.retryable, true, `${reason} 应可重投`);
    }
  });

  it('⑤ 不可重投档 2 条：价码不存在 / 库存不足 → 不可重投，立即转人工', () => {
    for (const [reason, errorCode] of [
      ['PRICE_CODE_NOT_FOUND', 'ERR_CHARGE_PRICE_CODE_NOT_FOUND'],
      ['INSUFFICIENT_STOCK', 'ERR_CHARGE_INSUFFICIENT_STOCK'],
    ] as const) {
      const receipt = receiptFor(reason);
      assert.equal(receipt.kind, CHARGE_RECEIPT_KINDS.business_rejected);
      assert.equal(receipt.error_code, errorCode);
      assert.equal(receipt.disposition, RECEIPT_DISPOSITIONS.NOT_RETRYABLE);
      assert.equal(receipt.retryable, false, `${reason} 不该重投`);
      assert.equal(receipt.channel_reachable, true, `${reason} 是业务拒绝，通道是通的`);
    }
  });

  it('⑥ 需人工档 2 条：医保规则冲突 / 对端判重复计费 → 需人工，不可重投', () => {
    for (const [reason, errorCode] of [
      ['INSURANCE_RULE_CONFLICT', 'ERR_CHARGE_INSURANCE_RULE_CONFLICT'],
      ['DUPLICATE_CHARGE', 'ERR_CHARGE_DUPLICATE_ON_PEER'],
    ] as const) {
      const receipt = receiptFor(reason);
      assert.equal(receipt.error_code, errorCode);
      assert.equal(receipt.disposition, RECEIPT_DISPOSITIONS.NEEDS_HUMAN);
      assert.equal(receipt.retryable, false, `${reason} 不该重投`);
    }
  });

  it('⑦ 未知码：落「需人工 + 不可重投」，不默认当作可重投', () => {
    const decision = disposeReceiptReason('SOME_NEW_PEER_CODE');
    assert.equal(decision.known, false);
    assert.equal(decision.disposition, RECEIPT_DISPOSITIONS.NEEDS_HUMAN);
    assert.equal(decision.retryable, false);
    assert.equal(decision.needs_manual, true);
    assert.equal(decision.error_code, 'ERR_CHARGE_REASON_UNKNOWN');

    const receipt = receiptFor('SOME_NEW_PEER_CODE');
    assert.equal(receipt.reason_code, 'SOME_NEW_PEER_CODE', '原始码必须原样保留');
    assert.equal(receipt.error_code, 'ERR_CHARGE_REASON_UNKNOWN');
    assert.equal(receipt.disposition, RECEIPT_DISPOSITIONS.NEEDS_HUMAN);
    assert.equal(receipt.retryable, false);
  });

  it('⑧ 兜底：回执整体为空 → 按通道不可达处理并进重投，不静默当成成功', () => {
    const receipts = classifyReceipts({
      response: { accepted: [], rejected: [] },
      submitted: [
        {
          material_code: 'MAT-SAMPLE-01',
          quantity: 1,
          price_code: 'PR-SAMPLE-01',
          use_time: '2026-01-15T09:12:00.000Z',
          fee_category: '卫生材料',
          medical_insurance_class: '甲类',
        },
      ],
      operation_no: 'OP-SAMPLE-001',
      attempt: 1,
    });
    const receipt = receipts[0]!;
    assert.equal(receipt.accepted, false, '空回执不得当成成功');
    assert.equal(receipt.kind, CHARGE_RECEIPT_KINDS.protocol_error);
    assert.equal(receipt.reason_code, 'EMPTY_RECEIPT');
    assert.equal(receipt.error_code, 'ERR_CHARGE_EMPTY_RECEIPT');
    assert.equal(receipt.channel_reachable, false, '空回执按通道不可达处理');
    assert.equal(receipt.retryable, true, '空回执进重投队列');
    assert.equal(receipt.disposition, RECEIPT_DISPOSITIONS.RETRYABLE);
  });

  it('⑧-2 兜底：只缺这一条（回执非空）→ 协议不符，可重投但通道是通的', () => {
    const receipts = classifyReceipts({
      response: {
        accepted: [{ material_code: 'MAT-SAMPLE-02' }],
        rejected: [],
      },
      submitted: [
        {
          material_code: 'MAT-SAMPLE-01',
          quantity: 1,
          price_code: 'PR-SAMPLE-01',
          use_time: '2026-01-15T09:12:00.000Z',
          fee_category: '卫生材料',
          medical_insurance_class: '甲类',
        },
      ],
      operation_no: 'OP-SAMPLE-001',
      attempt: 1,
    });
    const receipt = receipts[0]!;
    assert.equal(receipt.reason_code, 'MISSING_RECEIPT');
    assert.equal(receipt.error_code, 'ERR_MISSING_RECEIPT');
    assert.equal(receipt.channel_reachable, true);
    assert.equal(receipt.retryable, true);
  });
});

describe('test_charge_reason_codes · 端到端分流', () => {
  it('⑨ 可重投的对端拒收：进退避重投队列，不生成核查条目，台账状态不变', async () => {
    const ledger = freshLedger();
    try {
      const { idempotency_key } = bindMaterial(ledger);
      rejectWith('PEER_RATE_LIMITED');

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      const result = await scheduler.submit(chargeItem());

      assert.equal(result.status, 'retry_scheduled');
      assert.equal(result.check_task_id, null, '可重投的拒收不该压成人工待办');
      assert.equal(scheduler.pendingCount(), 1, '应进退避重投队列');
      assert.equal(
        readBindingStatus(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001', idempotency_key),
        'bound',
        '台账状态不该被临时拒收改动',
      );

      const receipts = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]!.disposition, RECEIPT_DISPOSITIONS.RETRYABLE);
      assert.equal(receipts[0]!.retryable, true);
      assert.equal(receipts[0]!.error_code, 'ERR_CHARGE_RATE_LIMITED');
    } finally {
      ledger.close();
    }
  });

  it('⑩ 不可重投的对端拒收：立即转核查条目，条目带台次上下文与统一错误码', async () => {
    const ledger = freshLedger();
    try {
      const { idempotency_key } = bindMaterial(ledger);
      rejectWith('PRICE_CODE_NOT_FOUND');

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      const result = await scheduler.submit(chargeItem());

      assert.equal(result.status, 'escalated');
      assert.ok(result.check_task_id && result.check_task_id > 0, '不可重投的拒收应转核查条目');
      assert.equal(scheduler.pendingCount(), 0, '不可重投的拒收不该进重投队列');
      assert.equal(stub.requests.length, 1, '不可重投的拒收只发过一次请求');

      const task = findCheckTask(ledger.db, result.check_task_id!);
      assert.ok(task, '核查条目应存在');
      assert.equal(task!.reason_code, 'PRICE_CODE_NOT_FOUND');
      assert.equal(task!.error_code, 'ERR_CHARGE_PRICE_CODE_NOT_FOUND');
      assert.equal(task!.operation_no, 'OP-SAMPLE-001');
      assert.equal(task!.room_no, 'OR-01');
      assert.equal(
        readBindingStatus(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001', idempotency_key),
        'check_pending',
      );
    } finally {
      ledger.close();
    }
  });

  it('⑪ 需人工的对端拒收：转核查条目并在审计链留处置档位', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      rejectWith('INSURANCE_RULE_CONFLICT');

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      const result = await scheduler.submit(chargeItem());

      assert.equal(result.status, 'escalated');
      const task = findCheckTask(ledger.db, result.check_task_id!);
      assert.equal(task!.error_code, 'ERR_CHARGE_INSURANCE_RULE_CONFLICT');

      const escalated = queryAuditByType(ledger.db, 'charge_escalated');
      assert.equal(escalated.length, 1);
      const detail = JSON.parse(escalated[0]!.detail ?? '{}') as Record<string, unknown>;
      assert.equal(detail['disposition'], RECEIPT_DISPOSITIONS.NEEDS_HUMAN);
      assert.equal(detail['reason_code'], 'INSURANCE_RULE_CONFLICT');
    } finally {
      ledger.close();
    }
  });

  it('⑫ 未知码：原始码进审计链与错误码表待补项（不静默吞掉）', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      rejectWith('PEER_BRAND_NEW_REJECTION');

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      const result = await scheduler.submit(chargeItem());

      assert.equal(result.status, 'escalated', '未知码按需人工处理');
      assert.equal(result.receipt?.error_code, 'ERR_CHARGE_REASON_UNKNOWN');
      assert.equal(result.receipt?.reason_code, 'PEER_BRAND_NEW_REJECTION');

      // 审计链留痕：原始码不许丢
      const unknown = queryAuditByType(ledger.db, 'charge_reason_code_unknown');
      assert.equal(unknown.length, 1, '未知码应留一行审计');
      const detail = JSON.parse(unknown[0]!.detail ?? '{}') as Record<string, unknown>;
      assert.equal(detail['reason_code'], 'PEER_BRAND_NEW_REJECTION');
      assert.equal(detail['error_code'], 'ERR_CHARGE_REASON_UNKNOWN');

      // 错误码表待补项
      const pending = listPendingErrorCodes();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.code, 'PEER_BRAND_NEW_REJECTION');
      assert.equal(pending[0]!.seen_count, 1);
      assert.ok(pending[0]!.context?.includes('OP-SAMPLE-001'));

      // 核查条目也带上了原始码
      const task = findCheckTask(ledger.db, result.check_task_id!);
      assert.equal(task!.reason_code, 'PEER_BRAND_NEW_REJECTION');
      assert.equal(task!.error_code, 'ERR_CHARGE_REASON_UNKNOWN');
    } finally {
      ledger.close();
    }
  });

  it('⑬ 同一个未知码重复出现：待补项累计次数，不刷重复待办', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      rejectWith('PEER_BRAND_NEW_REJECTION');
      rejectWith('PEER_BRAND_NEW_REJECTION');

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      await scheduler.submit(chargeItem());
      await scheduler.submit(chargeItem());

      const pending = listPendingErrorCodes();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.seen_count, 2, '同一个未知码应累计计数');
      assert.equal(countAuditByType(ledger.db, 'charge_reason_code_unknown'), 2);
    } finally {
      ledger.close();
    }
  });
});

describe('test_charge_reason_codes · 落库与文档', () => {
  it('⑭ 回执行落库带处置档位列（迁移 v19），历史行留空', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      rejectWith('PEER_RATE_LIMITED');

      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: makeSubmit(),
        maxAttempts: 3,
        baseDelayMs: 0,
      });
      await scheduler.submit(chargeItem());

      const rows = ledger.db
        .prepare(
          'SELECT disposition FROM charge_receipt WHERE material_code = ? AND operation_no = ?',
        )
        .all('MAT-SAMPLE-01', 'OP-SAMPLE-001') as Array<{ disposition: string | null }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.disposition, RECEIPT_DISPOSITIONS.RETRYABLE);
    } finally {
      ledger.close();
    }
  });

  it('⑮ 判定表与 docs/api/errors.md 的回执码小节逐码对齐', () => {
    const doc = readFileSync(resolve(projectRoot, 'docs', 'api', 'errors.md'), 'utf8');
    assert.ok(doc.includes('## 计费回执 reason_code 处置判定表'), '错误码文档须有回执码小节');
    for (const entry of RECEIPT_REASON_CODES) {
      assert.ok(doc.includes(entry.code), `错误码文档的回执码小节缺少 ${entry.code}`);
      assert.ok(doc.includes(entry.meaning_zh), `错误码文档缺少 ${entry.code} 的中文含义`);
      assert.ok(doc.includes(entry.error_code), `错误码文档缺少 ${entry.code} 的统一错误码`);
    }
    // 三档口径在文档里写清楚
    assert.ok(doc.includes('可重投'));
    assert.ok(doc.includes('不可重投'));
    assert.ok(doc.includes('需人工'));
    assert.ok(doc.includes('是否常见'));
  });
});
