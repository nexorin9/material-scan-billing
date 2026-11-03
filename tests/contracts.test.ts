/**
 * test_contracts：HIS 计费契约测试（请求 / 响应 schema 对齐与字段级断言）。
 *
 * 契约测试要解决的问题：
 *   出站对接最怕「文档写的和代码发的不一样」。字段改个名、对端不认，
 *   表现是**静默丢计费条目** —— 请求发出去、对端收了一部分、账上少几笔，
 *   要到月底对账才发现。对端回一个字段名拼错的响应更麻烦：
 *   本侧把「看不懂的响应」当成成功，这笔耗材就再也不会重投。
 *
 *   所以本文件把「字段规范」变成**可执行契约**（`src/api/contracts.ts`），
 *   并逐条验证四件事：
 *     ① 四类字段违规（缺必填 / 类型错 / 超长 / 枚举越界）都能被检出，
 *        且违规项带**字段名 + 期望 + 实际**（能直接贴给对端或设备厂商）；
 *     ② 合规载荷放行；
 *     ③ 出站载荷不合规 → **不外发**（对端收到 0 个请求），给独立错误码；
 *     ④ 联调文档的字段表 = 契约代码（文档与实现不会各写一份）。
 *
 * 替身说明：这里的「HIS 计费替身」是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走**同一条代码路径**，不 mock fetch。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_CONTRACTS,
  CONTRACT_TABLE_CLOSE,
  CONTRACT_TABLE_OPEN,
  MATERIAL_USES_REQUEST_CONTRACT,
  MATERIAL_USES_RESPONSE_CONTRACT,
  MATERIAL_USE_CONTRACT,
  SCAN_EVENT_CONTRACT,
  SCAN_EVENT_ENVELOPE_CONTRACT,
  SCAN_ITEM_CONTRACT,
  contractFieldNames,
  findContract,
  renderContractTable,
  validateAgainst,
  type Contract,
  type ContractViolation,
} from '../src/api/contracts.js';
import {
  MATERIAL_USES_REQUEST_FIELDS,
  MATERIAL_USE_FIELDS,
  submitMaterialUses,
  validateMaterialUsesContract,
  validateMaterialUsesResponseContract,
  type MaterialUse,
} from '../src/charge/submit.js';
import { CHARGE_ERROR_CODES, ChargeError, HisChargingClient } from '../src/charge/client.js';
import { writeBackOperationCharges } from '../src/charge/writeback.js';
import { bindOne } from '../src/engine/binding.js';
import { openLedger } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countReceipts, loadReceipts } from '../src/charge/receipt.js';
import { countCheckTasks } from '../src/check/task.js';
import { readBindingStatus } from '../src/ledger/binding-repo.js';
import { parseHttpScanBody } from '../src/ingest/adapters/scanner-http.js';
import { REASON_INVALID_SCAN_ITEM } from '../src/domain/scan-event.js';
import { startFakeHisServer, type FakeHisServer } from './support/fake-his-server.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

const TOKEN = 'his-charging-token-plaintext-c73d';
const ENDPOINT_PATH = '/api/v1/material-uses';
const OPERATION_NO = 'OP-CONTRACT-001';
const DEPT_CODE = 'SURG-01';

/** 一条合规的出站明细（改一个字段就能造出各类违规） */
function compliantUse(overrides: Partial<MaterialUse> = {}): MaterialUse {
  return {
    material_code: 'MAT-SAMPLE-01',
    quantity: 1,
    price_code: 'PRICE-001',
    use_time: '2026-01-15T09:12:00.000Z',
    fee_category: '卫生材料',
    medical_insurance_class: '甲类',
    idempotency_key: 'a'.repeat(64),
    key_profile: 'v1',
    ...overrides,
  };
}

/** 造一份出站请求体（顶层字段逐字对齐规范） */
function compliantRequest(uses: MaterialUse[] = [compliantUse()]): Record<string, unknown> {
  return {
    operation_no: OPERATION_NO,
    dept_code: DEPT_CODE,
    idempotency_key: 'b'.repeat(64),
    key_profile: 'v1',
    uses,
  };
}

/** 取某个字段名的违规项 */
function violationOf(
  violations: readonly ContractViolation[],
  field: string,
): ContractViolation | undefined {
  return violations.find((violation) => violation.field === field);
}

describe('字段契约 · 契约表自身', () => {
  it('每份契约的字段名唯一、含义非空', () => {
    for (const contract of ALL_CONTRACTS) {
      const names = contractFieldNames(contract);
      assert.equal(
        new Set(names).size,
        names.length,
        `契约 ${contract.id} 有重复字段名`,
      );
      assert.ok(names.length > 0, `契约 ${contract.id} 一个字段都没有`);
      for (const field of contract.fields) {
        assert.ok(
          field.meaning_zh.trim().length > 0,
          `契约 ${contract.id} 的字段 ${field.name} 缺中文含义`,
        );
      }
    }
  });

  it('出站契约字段名与 submit.ts 的字段常量逐字一致', () => {
    assert.deepEqual(
      contractFieldNames(MATERIAL_USES_REQUEST_CONTRACT),
      [...MATERIAL_USES_REQUEST_FIELDS],
    );
    assert.deepEqual(
      contractFieldNames(MATERIAL_USE_CONTRACT),
      [...MATERIAL_USE_FIELDS],
    );
  });

  it('入站契约字段名与 spec「最小数据格式」逐字一致', () => {
    assert.deepEqual(contractFieldNames(SCAN_EVENT_ENVELOPE_CONTRACT), [
      'operation_no',
      'room_no',
      'scanner_id',
    ]);
    assert.deepEqual(contractFieldNames(SCAN_ITEM_CONTRACT), [
      'material_code',
      'quantity',
      'scan_time',
      'batch_no',
    ]);
    assert.deepEqual(contractFieldNames(SCAN_EVENT_CONTRACT), [
      'operation_no',
      'room_no',
      'scanner_id',
      'scans',
    ]);
  });

  it('按契约 id 能查到契约（文档生成器靠它定位）', () => {
    assert.equal(findContract('material-uses-request')?.id, 'material-uses-request');
    assert.equal(findContract('scan-item')?.id, 'scan-item');
    assert.equal(findContract('no-such-contract'), undefined);
  });
});

describe('字段契约 · 四类违规各被检出', () => {
  it('缺必填字段 → missing_required，带字段名与期望 / 实际', () => {
    const request = compliantRequest();
    delete request['operation_no'];
    const violations = validateMaterialUsesContract(request);
    const violation = violationOf(violations, 'operation_no');
    assert.ok(violation, '缺 operation_no 应被检出');
    assert.equal(violation.kind, 'missing_required');
    assert.equal(violation.path, 'operation_no');
    assert.ok(violation.expected.includes('字符串'), `期望应说明类型：${violation.expected}`);
    assert.equal(violation.actual, '未提供');
    assert.ok(violation.message_zh.length > 0);
  });

  it('类型错误 → type_mismatch（逐条定位到 uses[] 下标）', () => {
    const request = compliantRequest([
      compliantUse(),
      compliantUse({ quantity: '2' as unknown as number }),
    ]);
    const violations = validateMaterialUsesContract(request);
    const violation = violationOf(violations, 'quantity');
    assert.ok(violation, 'quantity 类型错应被检出');
    assert.equal(violation.kind, 'type_mismatch');
    assert.equal(violation.path, 'uses[1].quantity');
    assert.ok(violation.expected.includes('整数'), `期望应说明类型：${violation.expected}`);
    assert.ok(violation.actual.includes('字符串'), `实际应描述真实值：${violation.actual}`);
  });

  it('超长字段 → too_long（出站 material_code 上限 32）', () => {
    const request = compliantRequest([compliantUse({ material_code: 'X'.repeat(33) })]);
    const violations = validateMaterialUsesContract(request);
    const violation = violationOf(violations, 'material_code');
    assert.ok(violation, '超长 material_code 应被检出');
    assert.equal(violation.kind, 'too_long');
    assert.equal(violation.path, 'uses[0].material_code');
    assert.ok(violation.expected.includes('长度 ≤ 32'), `期望应写明上限：${violation.expected}`);
    assert.ok(violation.actual.includes('长度 33'), `实际应写明实际长度：${violation.actual}`);
  });

  it('枚举越界 → enum_violation（费用类别不在院内 14 类内）', () => {
    const request = compliantRequest([compliantUse({ fee_category: '器材费' })]);
    const violations = validateMaterialUsesContract(request);
    const violation = violationOf(violations, 'fee_category');
    assert.ok(violation, '枚举越界应被检出');
    assert.equal(violation.kind, 'enum_violation');
    assert.equal(violation.path, 'uses[0].fee_category');
    assert.ok(violation.expected.includes('卫生材料'), `期望应列出允许集：${violation.expected}`);
    assert.ok(violation.actual.includes('器材费'), `实际应回显取值：${violation.actual}`);
  });

  it('医保分类越界同样被检出（甲 / 乙 / 丙之外）', () => {
    const request = compliantRequest([
      compliantUse({ medical_insurance_class: '丁类' }),
    ]);
    const violations = validateMaterialUsesContract(request);
    const violation = violationOf(violations, 'medical_insurance_class');
    assert.ok(violation);
    assert.equal(violation.kind, 'enum_violation');
  });

  it('一次给全全部违规项（不是只报第一个）', () => {
    const request = compliantRequest([
      compliantUse({
        material_code: 'X'.repeat(33),
        fee_category: '器材费',
        medical_insurance_class: '丁类',
      }),
    ]);
    const violations = validateMaterialUsesContract(request);
    const kinds = new Set(violations.map((violation) => violation.kind));
    assert.ok(kinds.has('too_long'), '超长应被检出');
    assert.ok(kinds.has('enum_violation'), '枚举越界应被检出');
    assert.ok(violations.length >= 3, `应一次给出全部违规项，实际 ${violations.length} 项`);
  });
});

describe('字段契约 · 合规载荷放行', () => {
  it('合规的出站请求零违规', () => {
    const violations = validateMaterialUsesContract(compliantRequest());
    assert.deepEqual(violations, []);
  });

  it('合规的入站事件零违规（抬头 + 明细）', () => {
    const envelope = validateAgainst(SCAN_EVENT_ENVELOPE_CONTRACT, {
      operation_no: OPERATION_NO,
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-01',
    });
    assert.deepEqual(envelope, []);
    const item = validateAgainst(SCAN_ITEM_CONTRACT, {
      material_code: 'MAT-SAMPLE-01',
      quantity: 2,
      scan_time: '2026-01-15T09:12:00.000Z',
      batch_no: 'LOT-A',
    });
    assert.deepEqual(item, []);
  });

  it('合规的回执零违规', () => {
    const violations = validateMaterialUsesResponseContract({
      accepted: [{ material_code: 'MAT-SAMPLE-01' }],
      rejected: [{ material_code: 'MAT-SAMPLE-02', reason_code: 'PRICE_CODE_NOT_FOUND' }],
    });
    assert.deepEqual(violations, []);
  });

  it('响应缺字段 / 元素缺原因码都被检出', () => {
    const missingArrays = validateMaterialUsesResponseContract({ accepted: [] });
    const rejected = violationOf(missingArrays, 'rejected');
    assert.ok(rejected, '缺 rejected 数组应被检出');
    assert.equal(rejected.kind, 'missing_required');

    const missingReason = validateMaterialUsesResponseContract({
      accepted: [],
      rejected: [{ material_code: 'MAT-SAMPLE-02' }],
    });
    const reason = violationOf(missingReason, 'reason_code');
    assert.ok(reason, '缺 reason_code 应被检出');
    assert.equal(reason.kind, 'missing_required');
    assert.equal(reason.path, 'rejected[0].reason_code');
  });
});

describe('字段契约 · 出站闸门（不合规不外发）', () => {
  let server: FakeHisServer;
  let client: HisChargingClient;

  before(async () => {
    server = await startFakeHisServer();
    client = new HisChargingClient({ baseUrl: server.baseUrl, token: TOKEN });
  });

  after(async () => {
    client.destroy();
    await server.close();
  });

  it('出站载荷不合规 → 不发请求，且给独立错误码', async () => {
    const before = server.requests.length;
    await assert.rejects(
      () =>
        submitMaterialUses(
          client,
          OPERATION_NO,
          DEPT_CODE,
          [compliantUse({ fee_category: '器材费' })],
          { path: ENDPOINT_PATH },
        ),
      (error: unknown) => {
        assert.ok(error instanceof ChargeError);
        assert.equal(error.code, CHARGE_ERROR_CODES.contractViolation);
        assert.equal(error.retryable, false, '本侧取值问题重投多少次还是不合规');
        assert.ok(error.detail && error.detail.includes('fee_category'));
        return true;
      },
    );
    assert.equal(server.requests.length, before, '不合规载荷一个请求都不该发出去');
  });

  it('合规载荷 → 请求真的发出去，对端收到字段逐字对齐', async () => {
    const before = server.requests.length;
    const response = await submitMaterialUses(
      client,
      OPERATION_NO,
      DEPT_CODE,
      [compliantUse()],
      { path: ENDPOINT_PATH },
    );
    assert.equal(server.requests.length, before + 1);
    const received = server.requests[server.requests.length - 1]!;
    assert.deepEqual(Object.keys(received.uses[0]!).sort(), [
      'fee_category',
      'idempotency_key',
      'key_profile',
      'material_code',
      'medical_insurance_class',
      'price_code',
      'quantity',
      'use_time',
    ]);
    assert.equal(response.accepted.length, 1);
    assert.equal(response.accepted[0]!.material_code, 'MAT-SAMPLE-01');
  });
});

describe('字段契约 · 响应不符按「对端协议不符」进重投', () => {
  it('对端回执缺 accepted / rejected → 可重投的错误码', async () => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ message: '对端没给逐条回执' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const client = new HisChargingClient({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN });
    try {
      await assert.rejects(
        () =>
          submitMaterialUses(client, OPERATION_NO, DEPT_CODE, [compliantUse()], {
            path: ENDPOINT_PATH,
          }),
        (error: unknown) => {
          assert.ok(error instanceof ChargeError);
          assert.equal(error.code, CHARGE_ERROR_CODES.responseInvalid);
          assert.equal(error.retryable, true, '对端协议不符要进重投队列');
          return true;
        },
      );
    } finally {
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('字段契约 · 出站逐条隔离（一条取值越界不拖垮同批其余）', () => {
  const OP_NO = 'OP-CONTRACT-ISO-001';
  const GOOD = 'MAT-CONTRACT-A';
  const BAD = 'MAT-CONTRACT-B';

  /** 台账：两个耗材都绑上台次，其中一个的键档位是产品不认识的取值 */
  function ledgerWithOneBadRow(): ReturnType<typeof openLedger> {
    const ledger = openLedger(':memory:');
    importMasterData(ledger.db, {
      operationsCsv: [
        'operation_no,room_no,dept_code,status,closed_at',
        `${OP_NO},OR-01,SURG-01,open,`,
      ].join('\n'),
      materialsCsv: [
        'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio',
        `${GOOD},高值耗材甲,PR-CONTRACT-01,卫生材料,甲类,true,LOT-01,包,支,支,1`,
        `${BAD},高值耗材乙,PR-CONTRACT-02,卫生材料,甲类,true,LOT-02,包,支,支,1`,
      ].join('\n'),
    });
    for (const material_code of [GOOD, BAD]) {
      const outcome = bindOne(ledger.db, {
        db: ledger.db,
        operation_no: OP_NO,
        room_no: 'OR-01',
        scanner_id: 'SCAN-GUN-01',
        material_code,
        raw_code: material_code,
        quantity: 1,
      });
      assert.equal(outcome.bound, true, `前置条件：${material_code} 应绑上台次`);
    }
    // 把其中一行的键档位改成产品不认识的取值 —— 出站契约会判它枚举越界
    ledger.db
      .prepare('UPDATE material_binding SET key_profile = ? WHERE material_code = ?')
      .run('unknown-profile', BAD);
    return ledger;
  }

  it('不合规的那条本地拒收（回执 + 核查条目 + 台账转人工），合规的照常计费', async () => {
    const ledger = ledgerWithOneBadRow();
    const server = await startFakeHisServer();
    const client = new HisChargingClient({
      baseUrl: server.baseUrl,
      token: TOKEN,
      logger: () => {
        // 契约用例不刷屏
      },
    });
    try {
      const result = await writeBackOperationCharges(ledger.db, OP_NO, {
        client,
        path: ENDPOINT_PATH,
        dept_code: DEPT_CODE,
      });

      // ① 出站只发了合规的那一条
      assert.equal(server.requests.length, 1, '不合规的条目不该进请求');
      assert.equal(server.requests[0]!.uses.length, 1);
      assert.equal(server.requests[0]!.uses[0]!.material_code, GOOD);
      assert.equal(result.submitted, 1);
      assert.equal(result.rejected_locally, 1);

      // ② 不合规的那条：回执带契约错误码，台账转人工，核查条目已生成
      const badReceipts = loadReceipts(ledger.db, BAD, OP_NO);
      assert.equal(badReceipts.length, 1, '不合规条目也要留回执（条数守恒）');
      assert.equal(badReceipts[0]!.error_code, CHARGE_ERROR_CODES.contractViolation);
      assert.equal(badReceipts[0]!.accepted, false);
      assert.equal(readBindingStatus(ledger.db, BAD, OP_NO), 'check_pending');
      assert.equal(countCheckTasks(ledger.db), 1, '不合规条目要转人工核查');

      // ③ 合规的那条：对端接收，台账推进到 charged
      const goodReceipts = loadReceipts(ledger.db, GOOD, OP_NO);
      assert.equal(goodReceipts.length, 1);
      assert.equal(goodReceipts[0]!.accepted, true);
      assert.equal(readBindingStatus(ledger.db, GOOD, OP_NO), 'charged');
      assert.equal(countReceipts(ledger.db), 2, '两条台账各一条回执');
    } finally {
      client.destroy();
      await server.close();
      ledger.close();
    }
  });
});

describe('字段契约 · 入站逐条隔离（一条坏数据不拖累整台手术）', () => {  it('明细字段缺失 / 类型错 → 只拒那一条，同批其余照常', () => {
    const body = JSON.stringify({
      operation_no: OPERATION_NO,
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-01',
      scans: [
        { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00.000Z' },
        { material_code: 'MAT-SAMPLE-02', quantity: '1', scan_time: '2026-01-15T09:13:00.000Z' },
        { material_code: 'MAT-SAMPLE-03', scan_time: '2026-01-15T09:14:00.000Z' },
        { material_code: 'MAT-SAMPLE-04', quantity: 2, scan_time: '2026-01-15T09:15:00.000Z' },
      ],
    });
    const outcome = parseHttpScanBody(body);
    assert.ok(outcome.ok, '抬头合规 → 整批不该被拒');
    assert.equal(outcome.batch.items.length, 2, '合规的两条照常入台账');
    assert.equal(outcome.batch.rejects.length, 2, '不合规的两条各给一条原因码');
    for (const reject of outcome.batch.rejects) {
      assert.equal(reject.reason_code, REASON_INVALID_SCAN_ITEM);
      assert.ok(reject.detail.includes('quantity'), `说明应点名字段：${reject.detail}`);
    }
    assert.deepEqual(
      outcome.batch.items.map((item) => item.material_code),
      ['MAT-SAMPLE-01', 'MAT-SAMPLE-04'],
    );
  });

  it('抬头缺台次号 → 整批拒（没有归属，条目无处可落）', () => {
    const body = JSON.stringify({
      room_no: 'OR-01',
      scanner_id: 'SCAN-GUN-01',
      scans: [
        { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00.000Z' },
      ],
    });
    const outcome = parseHttpScanBody(body);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, 'ERR_INVALID_SCAN_EVENT');
    assert.ok(
      (outcome.issues ?? []).some((issue) => issue.field.includes('operation_no')),
      '问题清单应点名 operation_no',
    );
  });
});

describe('字段契约 · 联调文档与契约代码同源', () => {
  /** 取文档里某一处契约表的内容（标记之间） */
  function extractTable(doc: string, contractId: string): string {
    const open = CONTRACT_TABLE_OPEN(contractId);
    const openAt = doc.indexOf(open);
    assert.ok(openAt >= 0, `${doc} 里缺少契约表标记 ${open}`);
    const bodyAt = openAt + open.length;
    const closeAt = doc.indexOf(CONTRACT_TABLE_CLOSE, bodyAt);
    assert.ok(closeAt >= 0, `${doc} 里缺少契约表结束标记`);
    return doc.slice(bodyAt, closeAt).trim();
  }

  const bindings: Array<{ doc: string; contract: Contract }> = [
    { doc: 'docs/api/his-charging.md', contract: MATERIAL_USES_REQUEST_CONTRACT },
    { doc: 'docs/api/his-charging.md', contract: MATERIAL_USE_CONTRACT },
    { doc: 'docs/api/his-charging.md', contract: MATERIAL_USES_RESPONSE_CONTRACT },
    { doc: 'docs/api/scan-event.md', contract: SCAN_EVENT_ENVELOPE_CONTRACT },
    { doc: 'docs/api/scan-event.md', contract: SCAN_ITEM_CONTRACT },
  ];

  it('两张联调文档都落盘了', () => {
    for (const binding of bindings) {
      const content = readFileSync(resolve(projectRoot, binding.doc), 'utf8');
      assert.ok(content.length > 0, `${binding.doc} 是空的`);
    }
  });

  it('文档里的字段表 = 契约渲染结果（条目数与字段名逐字一致）', () => {
    for (const binding of bindings) {
      const content = readFileSync(resolve(projectRoot, binding.doc), 'utf8');
      const table = extractTable(content, binding.contract.id);
      assert.equal(
        table,
        renderContractTable(binding.contract),
        `${binding.doc} 的 ${binding.contract.id} 表与契约代码不一致`,
      );
      // 条目数：表里的数据行数 = 契约里的字段数
      const rows = table.split('\n').slice(2).filter((line) => line.trim().length > 0);
      assert.equal(
        rows.length,
        binding.contract.fields.length,
        `${binding.doc} 的 ${binding.contract.id} 表行数与契约字段数不一致`,
      );
      // 字段名逐字一致
      const docFields = rows.map((row) => row.split('|')[1]!.trim().replace(/`/g, ''));
      assert.deepEqual(docFields, contractFieldNames(binding.contract));
    }
  });

  it('联调文档写明了契约相关的错误码与处置口径', () => {
    const charging = readFileSync(resolve(projectRoot, 'docs/api/his-charging.md'), 'utf8');
    assert.ok(charging.includes('ERR_CHARGE_CONTRACT_VIOLATION'));
    assert.ok(charging.includes('ERR_CHARGE_RESPONSE_INVALID'));
    const scanEvent = readFileSync(resolve(projectRoot, 'docs/api/scan-event.md'), 'utf8');
    assert.ok(scanEvent.includes('INVALID_SCAN_ITEM'), '入站原因码应写进联调文档');
  });
});
