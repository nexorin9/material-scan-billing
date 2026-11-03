/**
 * test_charge_sanitize：出站载荷真实数据形态清洗（GBK / UTF-8 混编 · 生僻字 · 超长 · 空值）。
 *
 * 这一组用例拿的是**真脏数据**，不是构造出来的假象：
 *   - `tests/fixtures/master-data-gbk.csv` 是一份**真的 GBK 编码**的耗材主数据
 *     （老系统导出的那种），里面有生僻字「髋」「钛」与全角括号；
 *   - 乱码字节是既不是 UTF-8 也不是 GBK 的真实字节序列；
 *   - 超长价码与空科室编码走的是真实主数据 → 真实绑定 → 真实出站的链路。
 *
 * 覆盖：
 *   ① GBK 字节解出正确中文（不走替换字符糊弄）；
 *   ② 乱码字节解不出来 → 保留原始字节 + 独立错误码；
 *   ③ 含生僻字的耗材名往返无损（导入台账的名字与原文逐字一致）；
 *   ④ 必填字段为空 → 拒该条 / 整批，**不填默认值、不发请求**；
 *   ⑤ 字段超长 → 出站前拒，**不截断后照发、不发请求**；
 *   ⑥ 字符归一（全角转半角 / 去零宽 / 折叠空白）+ 归一前后对照落台账；
 *   ⑦ 身份性字段（耗材码 / 价码）写法不规范 → 不静默改写，转人工；
 *   ⑧ 编码策略可配 + 错误码表与文档同步。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { HisChargingClient } from '../src/charge/client.js';
import {
  decodeWithFallback,
  normalizeText,
  renderSanitizeTrace,
  sanitizeEnvelope,
  sanitizeMaterialUse,
  scoreDecodedText,
  SANITIZE_ERROR_CODES,
} from '../src/charge/sanitize.js';
import { countReceipts, loadReceipts } from '../src/charge/receipt.js';
import { writeBackOperationCharges } from '../src/charge/writeback.js';
import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import {
  importMasterData,
  importMasterDataFromBytes,
  MasterDataDecodeError,
} from '../src/ledger/import-master-data.js';
import { readBindingStatus } from '../src/ledger/binding-repo.js';
import { createMasterDataWatcher } from '../src/ledger/master-data-watcher.js';
import { runStartupChecks } from '../src/daemon/startup-check.js';
import { countCheckTasks } from '../src/check/task.js';
import { bindOne } from '../src/engine/binding.js';
import { ERROR_CODES } from '../src/log/error-codes.js';
import { InvalidConfigError, readMasterDataEncoding } from '../src/config/env.js';
import { startFakeHisServer, type FakeHisServer } from './support/fake-his-server.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

const TOKEN = 'his-charging-token-plaintext-c41d';
const ENDPOINT_PATH = '/api/v1/material-uses';
const OPERATION_NO = 'OP-SANITIZE-001';

/** 真的 GBK 字节（老系统导出的耗材主数据） */
const GBK_FIXTURE = readFileSync(
  resolve(projectRoot, 'tests', 'fixtures', 'master-data-gbk.csv'),
);

/** fixture 里那几行耗材名（逐字写死，用来断言「解出来的是原文」） */
const GBK_NAMES = ['可吸收缝合线', '髋关节假体（钛合金）', '聚维酮碘微球'];

/** 排台台次 CSV（ASCII） */
function operationsCsv(): string {
  return [
    'operation_no,room_no,dept_code,status,closed_at',
    `${OPERATION_NO},OR-01,SURG-01,open,`,
  ].join('\n');
}

/** 耗材主数据 CSV（ASCII；价码等字段可由用例注入脏值） */
function materialsCsv(rows: Array<Record<string, string>>): string {
  const header =
    'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio';
  const lines = rows.map((row) =>
    [
      row['material_code'] ?? '',
      row['name'] ?? '高值耗材',
      row['price_code'] ?? 'PR-SANITIZE-01',
      row['fee_category'] ?? '卫生材料',
      row['medical_insurance_class'] ?? '甲类',
      'true',
      'LOT-SANITIZE',
      '包',
      '支',
      '支',
      row['ratio'] ?? '1',
    ].join(','),
  );
  return [header, ...lines].join('\n');
}

/** 一份干净台账 + 已绑定的耗材行 */
function freshLedger(rows: Array<Record<string, string>>): LedgerDb {
  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, {
    operationsCsv: operationsCsv(),
    materialsCsv: materialsCsv(rows),
  });
  for (const row of rows) {
    const material_code = row['material_code'] ?? '';
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

function clientFor(server: FakeHisServer): HisChargingClient {
  return new HisChargingClient({
    baseUrl: server.baseUrl,
    token: TOKEN,
    timeoutMs: 5_000,
    logger: () => {},
  });
}

describe('① 编码归一：GBK 字节解出正确中文（不做替换字符糊弄）', () => {
  it('GBK 主数据字节解出原文，编码判定为 gbk', () => {
    const decoded = decodeWithFallback(new Uint8Array(GBK_FIXTURE));
    assert.equal(decoded.ok, true);
    assert.equal(decoded.encoding, 'gbk');
    assert.equal(decoded.error_code, null);
    assert.ok(decoded.text, '解码结果应有文本');
    for (const name of GBK_NAMES) {
      assert.ok(decoded.text.includes(name), `解码结果应含「${name}」`);
    }
    // 绝不出现替换字符（U+FFFD）—— 出现就说明是糊弄出来的
    assert.ok(!decoded.text.includes('�'), '解码结果不得含替换字符');
  });

  it('同一份字节按 gbk 锁定策略解，结果一致', () => {
    const auto = decodeWithFallback(new Uint8Array(GBK_FIXTURE));
    const locked = decodeWithFallback(new Uint8Array(GBK_FIXTURE), { strategy: 'gbk' });
    assert.equal(locked.ok, true);
    assert.equal(locked.encoding, 'gbk');
    assert.equal(locked.text, auto.text);
  });

  it('UTF-8 编码的同一份内容按 utf-8 策略解，编码判定为 utf-8', () => {
    const utf8Bytes = new TextEncoder().encode(
      operationsCsv() + '\n' + 'material_code,name\nMAT-UTF8-01,可吸收缝合线\n',
    );
    const decoded = decodeWithFallback(utf8Bytes);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.encoding, 'utf-8');
    assert.ok(decoded.text?.includes('可吸收缝合线'));
  });

  it('中文候选的评分高于「解错」的候选（择优口径可复核）', () => {
    const right = scoreDecodedText('可吸收缝合线');
    const wrong = scoreDecodedText('ȳǢ'); // 把 GBK 当 UTF-8 解出来的典型产物
    assert.ok(right > wrong, `中文评分 ${right} 应高于解错评分 ${wrong}`);
  });
});

describe('② 乱码字节：解不出来就拒，原始字节原样返回', () => {
  it('既不是 UTF-8 也不是 GBK 的字节 → 报错 + 返回原始字节', () => {
    const garbage = new Uint8Array([0xff, 0xfe, 0xfd, 0x80, 0x81]);
    const decoded = decodeWithFallback(garbage);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.text, null);
    assert.equal(decoded.encoding, null);
    assert.equal(decoded.error_code, SANITIZE_ERROR_CODES.encodingUndecodable);
    assert.ok(decoded.message && decoded.message.length > 0);
    // 原始字节原样返回 —— 人要靠它去问导出方「这份文件到底是什么编码」
    assert.deepEqual(Array.from(decoded.raw), Array.from(garbage));
  });

  it('主数据字节解不出来时抛错并保留原始字节', () => {
    const ledger = openLedger(':memory:');
    assert.throws(
      () =>
        importMasterDataFromBytes(ledger.db, {
          operations: new TextEncoder().encode(operationsCsv()),
          materials: new Uint8Array([0xff, 0xfe, 0xfd]),
        }),
      (error: unknown) => {
        assert.ok(error instanceof MasterDataDecodeError);
        assert.equal(error.code, SANITIZE_ERROR_CODES.encodingUndecodable);
        assert.equal(error.which, 'materials');
        assert.deepEqual(Array.from(error.raw), [0xff, 0xfe, 0xfd]);
        return true;
      },
    );
  });
});

describe('③ 含生僻字的耗材名往返无损（导入台账的名字与原文逐字一致）', () => {
  it('GBK 主数据字节导入后，耗材名逐字还原', () => {
    const ledger = openLedger(':memory:');
    const result = importMasterDataFromBytes(ledger.db, {
      operations: new TextEncoder().encode(operationsCsv()),
      materials: new Uint8Array(GBK_FIXTURE),
    });
    assert.equal(result.materials.inserted, 3);
    assert.equal(result.materials.skipped, 0);
    assert.equal(result.encodings.materials, 'gbk');

    const names = ledger.db
      .prepare('SELECT material_code, name FROM material ORDER BY material_code')
      .all() as unknown as Array<{ material_code: string; name: string }>;
    assert.equal(names.length, 3);
    assert.deepEqual(
      names.map((row) => row.name),
      GBK_NAMES,
      '生僻字与全角括号必须逐字还原',
    );
    // 生僻字「髋」「钛」不能被替换成别的字
    assert.ok(names[1]?.name.includes('髋'));
    assert.ok(names[1]?.name.includes('钛'));
  });
});

describe('④ 必填字段为空 → 拒该条 / 整批，不填默认值、不发请求', () => {
  it('科室编码为空 → 整批本地拒收，一个请求都不发', async () => {
    const server = await startFakeHisServer();
    try {
      const ledger = freshLedger([{ material_code: 'MAT-SAN-EMPTY-01' }]);
      const result = await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client: clientFor(server),
        path: ENDPOINT_PATH,
        dept_code: '',
      });

      assert.equal(server.requests.length, 0, '不合规请求不得发出');
      assert.equal(result.rejected_locally, 1);
      assert.equal(result.submitted, 0);
      assert.equal(result.error_code, SANITIZE_ERROR_CODES.fieldMissing);
      assert.equal(result.channel_reachable, false);

      const receipts = loadReceipts(ledger.db, 'MAT-SAN-EMPTY-01', OPERATION_NO);
      assert.equal(receipts.length, 1, '被拒的条目也要有回执（条数守恒）');
      assert.equal(receipts[0]?.error_code, SANITIZE_ERROR_CODES.fieldMissing);
      assert.equal(receipts[0]?.accepted, false);
      assert.equal(receipts[0]?.retryable, false, '缺字段重投没有意义');

      // 转人工核查 + 台账转 check_pending
      assert.equal(countCheckTasks(ledger.db), 1);
      assert.equal(readBindingStatus(ledger.db, 'MAT-SAN-EMPTY-01', OPERATION_NO), 'check_pending');
    } finally {
      await server.close();
    }
  });

  it('价码为空 → 拒该条，同批其余照常提交', async () => {
    const server = await startFakeHisServer();
    try {
      const ledger = openLedger(':memory:');
      importMasterData(ledger.db, {
        operationsCsv: operationsCsv(),
        // 价码为空的那行导入时会被跳过（主数据导入要求价码非空），
        // 所以这里直接改台账里的价码，模拟「台账行缺价码」的脏状态
        materialsCsv: materialsCsv([{ material_code: 'MAT-SAN-NOPRICE-01' }]),
      });
      const outcome = bindOne(ledger.db, {
        db: ledger.db,
        operation_no: OPERATION_NO,
        room_no: 'OR-01',
        scanner_id: 'SCAN-GUN-07',
        material_code: 'MAT-SAN-NOPRICE-01',
        raw_code: 'MAT-SAN-NOPRICE-01',
        quantity: 1,
      });
      assert.equal(outcome.bound, true);
      ledger.db
        .prepare('UPDATE material_binding SET price_code = NULL WHERE material_code = ?')
        .run('MAT-SAN-NOPRICE-01');

      const result = await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client: clientFor(server),
        path: ENDPOINT_PATH,
      });
      assert.equal(server.requests.length, 0, '缺价码不得发请求');
      assert.equal(result.rejected_locally, 1);
      assert.equal(result.error_code, SANITIZE_ERROR_CODES.fieldMissing);
      assert.equal(countReceipts(ledger.db), 1);
    } finally {
      await server.close();
    }
  });

  it('明细级必填字段为空 → 清洗层给出独立错误码', () => {
    const sanitized = sanitizeMaterialUse({
      material_code: '',
      quantity: 1,
      price_code: 'PR-01',
      use_time: '2026-01-01T00:00:00.000Z',
      fee_category: '卫生材料',
      medical_insurance_class: '甲类',
    });
    const codes = sanitized.issues.map((issue) => issue.error_code);
    assert.ok(codes.includes(SANITIZE_ERROR_CODES.fieldMissing));
    assert.ok(sanitized.issues.some((issue) => issue.field === 'material_code'));
  });
});

describe('⑤ 字段超长 → 出站前拒，不截断后照发、不发请求', () => {
  it('价码超长 → 本地拒收并转人工，请求里不出现该耗材码', async () => {
    const server = await startFakeHisServer();
    try {
      const longPrice = 'PR-' + 'X'.repeat(40);
      const ledger = freshLedger([
        { material_code: 'MAT-SAN-LONG-01', price_code: longPrice },
      ]);
      const result = await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client: clientFor(server),
        path: ENDPOINT_PATH,
      });

      assert.equal(server.requests.length, 0, '超长字段不得发出请求');
      const sentCodes = server.requests.flatMap((request) =>
        request.uses.map((use) => use.material_code),
      );
      assert.ok(!sentCodes.includes('MAT-SAN-LONG-01'));
      assert.equal(result.rejected_locally, 1);
      assert.equal(result.error_code, 'ERR_CHARGE_FIELD_TOO_LONG');
      const receipts = loadReceipts(ledger.db, 'MAT-SAN-LONG-01', OPERATION_NO);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.error_code, 'ERR_CHARGE_FIELD_TOO_LONG');
    } finally {
      await server.close();
    }
  });
});

describe('⑥ 字符归一：全角转半角 / 去零宽 / 折叠空白，对照落台账', () => {
  it('全角转半角、零宽字符去除、连续空白折叠', () => {
    // 全角字 + 零宽空格（U+200B）+ 连续空白 + 制表符
    const dirty = '　ＭＡＴ－０\u200B1  A\t\tB  ';
    const normalized = normalizeText(dirty);
    assert.equal(normalized.text, 'MAT-01 A B');
    assert.equal(normalized.changed, true);
    const kinds = normalized.actions.map((action) => action.kind);
    assert.ok(kinds.includes('fullwidth_to_halfwidth'));
    assert.ok(kinds.includes('strip_invisible'));
    assert.ok(kinds.includes('collapse_whitespace'));
    // 归一前后的对照一并带出
    assert.equal(normalized.before, dirty);
  });

  it('描述性字段（费用类别）归一后照发，并把归一前后对照写进台账', async () => {
    const server = await startFakeHisServer();
    try {
      const ledger = freshLedger([
        { material_code: 'MAT-SAN-NORM-01', fee_category: '卫生材料' },
      ]);
      // 台账行的费用类别带零宽字符（描述性字段：归一后语义不变）
      ledger.db
        .prepare('UPDATE material_binding SET fee_category = ? WHERE material_code = ?')
        .run('卫生材料​', 'MAT-SAN-NORM-01');

      const result = await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client: clientFor(server),
        path: ENDPOINT_PATH,
      });
      assert.equal(result.submitted, 1);
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0]?.uses[0]?.fee_category, '卫生材料');

      // 台账里留痕：归一前后对照可查
      const row = ledger.db
        .prepare('SELECT sanitize_trace FROM material_binding WHERE material_code = ?')
        .get('MAT-SAN-NORM-01') as { sanitize_trace: string | null };
      assert.ok(row.sanitize_trace, '台账应记归一前后对照');
      const trace = JSON.parse(row.sanitize_trace) as {
        changed: boolean;
        fields: Array<{ field: string; before: string; after: string; normalized: string }>;
      };
      assert.equal(trace.changed, true);
      const feeField = trace.fields.find((field) => field.field === 'fee_category');
      assert.equal(feeField?.before, '卫生材料​');
      assert.equal(feeField?.after, '卫生材料');
      assert.equal(feeField?.normalized, '卫生材料');
    } finally {
      await server.close();
    }
  });
});

describe('⑦ 身份性字段写法不规范 → 不静默改写，转人工', () => {
  it('耗材码含全角字符 → 本地拒收（不照发一个变形后的码）', async () => {
    const server = await startFakeHisServer();
    try {
      const ledger = freshLedger([{ material_code: 'MAT-SAN-CANON-01' }]);
      // 台账里的耗材码被写成了全角（正常链路不会这样，这里模拟脏状态）
      ledger.db
        .prepare('UPDATE material_binding SET material_code = ? WHERE material_code = ?')
        .run('ＭＡＴ－ＳＡＮ－０１', 'MAT-SAN-CANON-01');

      const result = await writeBackOperationCharges(ledger.db, OPERATION_NO, {
        client: clientFor(server),
        path: ENDPOINT_PATH,
      });
      assert.equal(server.requests.length, 0, '身份性字段不规范不得发请求');
      assert.equal(result.rejected_locally, 1);
      assert.equal(result.error_code, SANITIZE_ERROR_CODES.codeNotCanonical);
      const receipts = loadReceipts(ledger.db, 'ＭＡＴ－ＳＡＮ－０１', OPERATION_NO);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.error_code, SANITIZE_ERROR_CODES.codeNotCanonical);
    } finally {
      await server.close();
    }
  });

  it('归一前后对照写进台账：告诉人「规范写法应该是什么」', () => {
    const sanitized = sanitizeMaterialUse({
      material_code: 'ＭＡＴ－０１',
      quantity: 1,
      price_code: 'PR-01',
      use_time: '2026-01-01T00:00:00.000Z',
      fee_category: '卫生材料',
      medical_insurance_class: '甲类',
    });
    assert.equal(sanitized.issues.length, 1);
    assert.equal(sanitized.issues[0]?.error_code, SANITIZE_ERROR_CODES.codeNotCanonical);
    // 身份性字段：照发的是原值（不静默改写），但留痕给出规范写法
    assert.equal(sanitized.use.material_code, 'ＭＡＴ－０１');
    const trace = JSON.parse(renderSanitizeTrace(sanitized.trace)) as {
      fields: Array<{ field: string; before: string; after: string; normalized: string }>;
    };
    const codeField = trace.fields.find((field) => field.field === 'material_code');
    assert.equal(codeField?.before, 'ＭＡＴ－０１');
    assert.equal(codeField?.after, 'ＭＡＴ－０１');
    assert.equal(codeField?.normalized, 'MAT-01');
  });

  it('请求级字段（台次号 / 科室编码）归一会改写它 → 整批拒收', () => {
    const envelope = sanitizeEnvelope('OP-1', 'SURG-01​');
    assert.equal(envelope.issues.length, 1);
    assert.equal(envelope.issues[0]?.error_code, SANITIZE_ERROR_CODES.codeNotCanonical);
    assert.equal(envelope.issues[0]?.field, 'dept_code');
  });
});

describe('⑧ 编码策略可配 + 错误码表与文档同步', () => {
  it('MASTER_DATA_ENCODING 读得出、非法值启动即报错', () => {
    assert.equal(readMasterDataEncoding({}), 'auto');
    assert.equal(readMasterDataEncoding({ MASTER_DATA_ENCODING: 'GBK' }), 'gbk');
    assert.throws(
      () => readMasterDataEncoding({ MASTER_DATA_ENCODING: 'big5' }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidConfigError);
        assert.equal(error.variable, 'MASTER_DATA_ENCODING');
        return true;
      },
    );
  });

  it('启动自检：编码策略这项在，配错时判不通过并指名变量名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msb-sanitize-startup-'));
    try {
      const ledgerPath = join(dir, 'ledger.db');
      const ok = runStartupChecks({
        env: {},
        ledgerDbPath: ledgerPath,
        scanInboxDir: join(dir, 'scan-inbox'),
      });
      const item = ok.items.find((entry) => entry.name === '主数据编码策略');
      assert.ok(item, '启动自检应有「主数据编码策略」这一项');
      assert.equal(item.ok, true);
      assert.ok(item.detail.includes('auto'));

      const bad = runStartupChecks({
        env: { MASTER_DATA_ENCODING: 'big5' },
        ledgerDbPath: ledgerPath,
        scanInboxDir: join(dir, 'scan-inbox'),
      });
      const badItem = bad.items.find((entry) => entry.name === '主数据编码策略');
      assert.equal(badItem?.ok, false);
      assert.deepEqual(badItem?.missing_vars, ['MASTER_DATA_ENCODING']);
      assert.equal(bad.ok, false, '配错编码策略应拒绝启动');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('三个新错误码都在统一错误码表里，且含义与处置齐全', () => {
    for (const code of [
      SANITIZE_ERROR_CODES.encodingUndecodable,
      SANITIZE_ERROR_CODES.fieldMissing,
      SANITIZE_ERROR_CODES.codeNotCanonical,
    ]) {
      const entry = ERROR_CODES.find((item) => item.code === code);
      assert.ok(entry, `错误码表缺少 ${code}`);
      assert.ok(entry.meaning_zh.length > 0);
      assert.ok(entry.action_zh.length > 0);
      assert.equal(entry.retryable, false, `${code} 不可重投`);
      assert.equal(entry.needs_manual, true);
    }
  });

  it('错误码文档与清洗口径文档同步', () => {
    const errors = readFileSync(resolve(projectRoot, 'docs', 'api', 'errors.md'), 'utf8');
    assert.ok(errors.includes(SANITIZE_ERROR_CODES.encodingUndecodable));
    assert.ok(errors.includes(SANITIZE_ERROR_CODES.fieldMissing));
    assert.ok(errors.includes(SANITIZE_ERROR_CODES.codeNotCanonical));

    const doc = readFileSync(resolve(projectRoot, 'docs', 'api', 'sanitization.md'), 'utf8');
    assert.ok(doc.includes('GBK'));
    assert.ok(doc.includes('ERR_CHARGE_FIELD_MISSING'));
    assert.ok(doc.includes('ERR_CHARGE_CODE_NOT_CANONICAL'));
    assert.ok(doc.includes('ERR_CHARGE_ENCODING_UNDECODABLE'));
  });
});

describe('⑨ 运维入口：CLI 与热更新观察器走同一条编码口径', () => {
  it('CLI import-master 导入 GBK 主数据，耗材名逐字还原', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msb-sanitize-cli-'));
    const dbPath = join(dir, 'ledger.db');
    try {
      const out = execFileSync(
        process.execPath,
        [
          join(process.cwd(), 'dist', 'cli.js'),
          'import-master',
          '--db',
          dbPath,
          '--operations',
          resolve(projectRoot, 'tests', 'fixtures', 'operations.csv'),
          '--materials',
          resolve(projectRoot, 'tests', 'fixtures', 'master-data-gbk.csv'),
        ],
        { encoding: 'utf8', env: { ...process.env } },
      );
      assert.match(out, /耗材主数据：文件 3 行　新增 3/);

      const db = new DatabaseSync(dbPath);
      const names = (
        db.prepare('SELECT name FROM material ORDER BY material_code').all() as unknown as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      db.close();
      assert.deepEqual(names, GBK_NAMES, 'GBK 主数据经 CLI 导入后名字逐字还原');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('热更新观察器重导 GBK 主数据，耗材名逐字还原', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msb-sanitize-watch-'));
    try {
      const materialsPath = join(dir, 'materials.csv');
      writeFileSync(materialsPath, GBK_FIXTURE);
      const ledger = openLedger(':memory:');
      const watcher = createMasterDataWatcher({
        db: ledger.db,
        operationsCsv: '',
        materialsCsv: materialsPath,
        encoding: 'auto',
      });
      // 第一次轮询：文件指纹与启动时一致 → 不导；再写一次（内容不变但 mtime 变）触发一次重导
      writeFileSync(materialsPath, GBK_FIXTURE);
      const outcome = watcher.poll();
      assert.ok(outcome, '文件变化后应有一次热更新');
      assert.equal(outcome.reloaded, true);
      assert.equal(outcome.error_code, null);

      const names = (
        ledger.db.prepare('SELECT name FROM material ORDER BY material_code').all() as unknown as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      assert.deepEqual(names, GBK_NAMES, '热更新重导 GBK 主数据后名字逐字还原');
      ledger.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('观察器遇到解不出的编码 → 不导入、不推进版本，报独立错误码', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msb-sanitize-watch-bad-'));
    try {
      const materialsPath = join(dir, 'materials.csv');
      writeFileSync(materialsPath, new Uint8Array([0xff, 0xfe, 0xfd]));
      const ledger = openLedger(':memory:');
      const watcher = createMasterDataWatcher({
        db: ledger.db,
        operationsCsv: '',
        materialsCsv: materialsPath,
        encoding: 'auto',
      });
      writeFileSync(materialsPath, new Uint8Array([0xff, 0xfe, 0xfd, 0x80]));
      const outcome = watcher.poll();
      assert.ok(outcome);
      assert.equal(outcome.reloaded, false);
      assert.equal(outcome.error_code, SANITIZE_ERROR_CODES.encodingUndecodable);
      const count = ledger.db.prepare('SELECT COUNT(*) AS n FROM material').get() as { n: number };
      assert.equal(count.n, 0, '解不出编码时不得导入半份主数据');
      ledger.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
