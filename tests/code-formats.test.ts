/**
 * test_code_formats：耗材码制归一深化 —— UDI / GS1 AI(01) / 院内码 · GTIN 校验位 · 码段判定。
 *
 * 覆盖：
 *   ① 三类码制各 ≥3 条样例解析正确（码制、码段、DI / PI 分离、归一后的主数据键）；
 *   ② GTIN-13 / GTIN-14 校验位按 GS1 mod-10 算得对，**校验位错误的样例被拒**，
 *      且给的是**独立错误码**（不是「耗材未建档」）；
 *   ③ UDI 里的批号进入 **v2 幂等键维度**（同码不同批各算一次）；
 *   ④ 归一结果接入字典映射层：归一后仍需在主数据命中才算有效；
 *   ⑤ 台账同时保留 **原始码**与**解析轨迹**（含码制、DI、批号、校验位核对结论），
 *      轨迹里**不落具体失效期日期**，只落类别。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import {
  buildParseTrace,
  checkGtin,
  classifyExpiry,
  computeGtinCheckDigit,
  detectCodeForm,
  parseCode,
  toCanonicalMaterialCode,
} from '../src/ingest/codes.js';
import { normalizeMaterialCode, normalizeScanItem } from '../src/ingest/normalize.js';
import { deriveIdempotencyKeyForProfile } from '../src/domain/idempotency.js';
import { validateMaterialCode } from '../src/engine/validate-code.js';
import { settleBatch } from '../src/engine/settle.js';
import { errorCodeForReason } from '../src/log/error-codes.js';
import { LATEST_SCHEMA_VERSION } from '../src/ledger/migrations.js';

/* ── 主数据 ── */

/** 真 GTIN-14（校验位合法）：06912345678902 */
const GTIN_A = '06912345678902';
/** 真 GTIN-14（校验位合法）：06987654321092 */
const GTIN_B = '06987654321092';
/** 校验位**不合法**的 14 位码（末位被改过） */
const GTIN_BAD = '06912345678905';
/** GS1 分隔符（FNC1 / ASCII 29） */
const GS_SEPARATOR = '\u001D';

const OPERATIONS_CSV = [
  'operation_no,room_no,dept_code,status,closed_at',
  'OP-CODE-001,OR-01,SURG-01,open,',
  'OP-CODE-002,OR-02,SURG-01,open,',
].join('\n');

const MATERIALS_CSV = [
  'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio',
  `${GTIN_A},UDI 形态耗材,PR-CODE-A,卫生材料,甲类,true,LOT-A-01,包,支,支,1`,
  `${GTIN_B},GS1 形态耗材,PR-CODE-B,卫生材料,乙类,true,LOT-B-01,包,支,支,1`,
  'MAT-CODE-01,院内自编码耗材,PR-CODE-C,卫生材料,甲类,true,LOT-C-01,包,支,支,1',
].join('\n');

let ledger: LedgerDb;

before(() => {
  ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv: OPERATIONS_CSV, materialsCsv: MATERIALS_CSV });
});

after(() => {
  ledger.close();
});

describe('码制识别与深解析', () => {
  it('三类码制各 ≥3 条样例：码制判定正确', () => {
    // UDI ≥3 条
    assert.equal(detectCodeForm('(01)06912345678902(10)LOT-A1'), 'UDI');
    assert.equal(detectCodeForm('(01)06912345678902'), 'UDI');
    assert.equal(detectCodeForm('(01)06987654321092(10)LOT-B2(17)260630)'), 'UDI');
    // GS1 AI(01) ≥3 条
    assert.equal(detectCodeForm('0106987654321092'), 'GS1_AI01');
    assert.equal(detectCodeForm('0106912345678902'), 'GS1_AI01');
    assert.equal(detectCodeForm('0106987654321092010LOT-B2'), 'GS1_AI01');
    // 院内码 ≥3 条
    assert.equal(detectCodeForm('MAT-CODE-01'), 'INTERNAL');
    assert.equal(detectCodeForm('MAT.CODE.02'), 'INTERNAL');
    assert.equal(detectCodeForm('MAT_CODE_03'), 'INTERNAL');
  });

  it('UDI：DI 与 PI 分离，批号取到、序列号取到、失效期只落类别', () => {
    const parsed = parseCode('(01)06912345678902(10)LOT-A1(21)SN-0007)(17)260630)');
    assert.equal(parsed.code_form, 'UDI');
    assert.equal(parsed.di, GTIN_A);
    assert.equal(parsed.batch_no, 'LOT-A1');
    assert.equal(parsed.serial_no, 'SN-0007');
    assert.equal(parsed.canonical_source, 'DI');
    assert.equal(parsed.canonical_code, GTIN_A);
    // 失效期只给类别，不给具体日期（原始码按设计原样保留，轨迹里才不许出现日期）
    assert.ok(['has_expiry', 'expired'].includes(parsed.expiry_category));
    const trace = buildParseTrace(parsed);
    assert.equal(JSON.stringify(trace).includes('260630'), false, '解析轨迹里不得出现具体失效期日期');
    assert.equal(trace.expiry_category, parsed.expiry_category);
  });

  it('UDI：码段清单按应用标识符拆开，DI / 批号 / 失效期各归各类', () => {
    const parsed = parseCode('(01)06912345678902(10)LOT-A1(17)260630)');
    const kinds = parsed.segments.map((segment) => `${segment.ai}:${segment.kind}`);
    assert.deepEqual(kinds, ['01:device_identifier', '10:batch', '17:expiry']);
    assert.equal(parsed.segments[0]?.length, 14);
    assert.equal(parsed.segments[1]?.length, 6);
  });

  it('UDI：无 (17) 段判长期有效，(17) 读不出来判未知', () => {
    assert.equal(parseCode('(01)06912345678902(10)LOT-A1)').expiry_category, 'long_term');
    assert.equal(parseCode('(01)06912345678902(17)XX)').expiry_category, 'unknown');
    assert.equal(classifyExpiry(null), 'long_term');
    assert.equal(classifyExpiry('991331'), 'unknown');
  });

  it('GS1 AI(01)：包装码归一到同一条主数据键，裸码没有批号', () => {
    const parsed = parseCode('0106987654321092');
    assert.equal(parsed.code_form, 'GS1_AI01');
    assert.equal(parsed.di, GTIN_B);
    assert.equal(parsed.canonical_code, GTIN_B);
    assert.equal(parsed.batch_no, null);
    assert.equal(parsed.gtin?.valid, true);
  });

  it('GS1 AI(01)：带 FNC1 分隔符的元素串也能拆出 DI 与批号', () => {
    const parsed = parseCode(`010698765432109210LOT-B2${GS_SEPARATOR}`);
    assert.equal(parsed.code_form, 'UDI');
    assert.equal(parsed.di, GTIN_B);
    assert.equal(parsed.batch_no, 'LOT-B2');
  });

  it('院内码：原样作为主数据键，不做 GTIN 校验位判定', () => {
    const parsed = parseCode('MAT-CODE-01');
    assert.equal(parsed.code_form, 'INTERNAL');
    assert.equal(parsed.canonical_code, 'MAT-CODE-01');
    assert.equal(parsed.canonical_source, 'INTERNAL_RAW');
    assert.equal(parsed.di, null);
    assert.equal(parsed.gtin, null);
    assert.deepEqual(parsed.issues, []);
  });

  it('归一时保留原始码与解析轨迹（轨迹里没有具体日期）', () => {
    const canonical = toCanonicalMaterialCode(parseCode('(01)06912345678902(10)LOT-A1(17)260630)'));
    assert.equal(canonical.material_code, GTIN_A);
    assert.equal(canonical.raw_code, '(01)06912345678902(10)LOT-A1(17)260630)');
    assert.equal(canonical.batch_no, 'LOT-A1');
    assert.equal(canonical.trace.code_form, 'UDI');
    assert.equal(canonical.trace.di, GTIN_A);
    assert.equal(canonical.trace.gtin?.valid, true);
    assert.equal(JSON.stringify(canonical.trace).includes('260630'), false);
  });
});

describe('GTIN 校验位', () => {
  it('GS1 mod-10 加权：标准例算得对', () => {
    // GTIN-13 教材例：5901234123457
    assert.equal(computeGtinCheckDigit('590123412345'), '7');
    // GTIN-14 教材例：00012345600012
    assert.equal(computeGtinCheckDigit('0001234560001'), '2');
    // 真码 06912345678902
    assert.equal(computeGtinCheckDigit('0691234567890'), '2');
  });

  it('13 位与 14 位都能核对，校验位错的一律判否', () => {
    assert.equal(checkGtin(GTIN_A)?.valid, true);
    assert.equal(checkGtin(GTIN_A)?.length, 14);
    assert.equal(checkGtin('5901234123457')?.valid, true);
    assert.equal(checkGtin('5901234123457')?.length, 13);
    const bad = checkGtin(GTIN_BAD);
    assert.equal(bad?.valid, false);
    assert.equal(bad?.expected_check_digit, '2');
    assert.equal(bad?.actual_check_digit, '5');
    // 不是 GTIN 候选（位数不对 / 非纯数字）返回 null
    assert.equal(checkGtin('MAT-CODE-01'), null);
    assert.equal(checkGtin('12345'), null);
  });
});

describe('校验位错误样例被拒（独立错误码，不与「未建档」混同）', () => {
  it('UDI 里的 DI 校验位不符 → 结构层拒，给独立原因码', () => {
    const validation = validateMaterialCode(ledger.db, '06912345678905', {
      raw_code: '(01)06912345678905(10)LOT-X1)',
    });
    assert.equal(validation.ok, false);
    assert.equal(validation.failed_layer, 'structure');
    assert.equal(validation.reason_code, 'CODE_GTIN_CHECK_DIGIT_INVALID');
    assert.equal(errorCodeForReason(validation.reason_code), 'ERR_GTIN_CHECK_DIGIT_INVALID');
    assert.notEqual(validation.reason_code, 'MATERIAL_NOT_REGISTERED');
  });

  it('裸 14 位码校验位不符且未建档 → 也给独立原因码（不是「未建档」）', () => {
    const validation = validateMaterialCode(ledger.db, GTIN_BAD);
    assert.equal(validation.ok, false);
    assert.equal(validation.reason_code, 'CODE_GTIN_CHECK_DIGIT_INVALID');
    assert.equal(validation.failed_layer, 'structure');
  });

  it('校验位对的 14 位码但没建档 → 仍然是「耗材未建档」', () => {
    const validation = validateMaterialCode(ledger.db, '06911111111117');
    assert.equal(validation.ok, false);
    assert.equal(validation.failed_layer, 'dictionary');
    assert.equal(validation.reason_code, 'MATERIAL_NOT_REGISTERED');
  });

  it('GS1 码里取不到 DI → 独立原因码', () => {
    const validation = validateMaterialCode(ledger.db, '(10)LOT-A1)', {
      raw_code: '(10)LOT-A1)',
    });
    assert.equal(validation.ok, false);
    assert.equal(validation.reason_code, 'CODE_DI_MISSING');
  });
});

describe('归一结果接入字典映射层', () => {
  it('归一后的主数据键才拿去查主数据：命中才算有效', () => {
    const hit = validateMaterialCode(ledger.db, GTIN_A, {
      raw_code: `(01)${GTIN_A}(10)LOT-A1)`,
    });
    assert.equal(hit.ok, true);
    assert.equal(hit.material?.material_code, GTIN_A);
    assert.equal(hit.raw_code_form, 'UDI');

    // 同一个 DI 但主数据里没有 → 未建档（不是校验位问题）
    const miss = validateMaterialCode(ledger.db, '06911111111117', {
      raw_code: '(01)06911111111117(10)LOT-Z9)',
    });
    assert.equal(miss.ok, false);
    assert.equal(miss.failed_layer, 'dictionary');
    assert.equal(miss.reason_code, 'MATERIAL_NOT_REGISTERED');
  });
});

describe('UDI 批号进入 v2 幂等键维度', () => {
  it('解析出的批号参与 v2 键派生，同码不同批各算一次', () => {
    const item = normalizeScanItem({
      material_code: '(01)06912345678902(10)LOT-A1)',
      quantity: 1,
      scan_time: '2026-01-15T09:14:22+08:00',
    });
    assert.equal(item.material_code, GTIN_A);
    assert.equal(item.batch_no, 'LOT-A1');

    const v1 = deriveIdempotencyKeyForProfile(
      { material_code: item.material_code, operation_no: 'OP-CODE-001' },
      'v1',
    );
    const v2 = deriveIdempotencyKeyForProfile(
      { material_code: item.material_code, operation_no: 'OP-CODE-001', batch_no: item.batch_no },
      'v2',
    );
    const v2Other = deriveIdempotencyKeyForProfile(
      { material_code: item.material_code, operation_no: 'OP-CODE-001', batch_no: 'LOT-A2' },
      'v2',
    );
    assert.equal(v1.batch_scoped, false);
    assert.equal(v2.batch_scoped, true);
    assert.notEqual(v1.key, v2.key);
    assert.notEqual(v2.key, v2Other.key);
  });

  it('同码不同批在 v2 档位下各算一次（台账两行、键不同）', () => {
    const result = settleBatch(
      ledger.db,
      [
        {
          operation_no: 'OP-CODE-001',
          room_no: 'OR-01',
          scanner_id: 'SC-01',
          items: [
            {
              material_code: GTIN_A,
              raw_code: `(01)${GTIN_A}(10)LOT-A1)`,
              quantity: 1,
              batch_no: 'LOT-A1',
            },
            {
              material_code: GTIN_A,
              raw_code: `(01)${GTIN_A}(10)LOT-A2)`,
              quantity: 1,
              batch_no: 'LOT-A2',
            },
          ],
        },
      ],
      { keyProfile: 'v2' },
    );
    assert.equal(result.accepted.length, 2);
    const rows = ledger.db
      .prepare(
        `SELECT idempotency_key, key_profile, batch_no, raw_code, code_form, code_parse_trace
           FROM material_binding WHERE material_code = ? AND operation_no = ? ORDER BY id ASC`,
      )
      .all(GTIN_A, 'OP-CODE-001') as unknown as Array<Record<string, string>>;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]?.idempotency_key, rows[1]?.idempotency_key);
    assert.equal(rows[0]?.key_profile, 'v2');
    assert.deepEqual(rows.map((row) => row.batch_no), ['LOT-A1', 'LOT-A2']);
    // 台账同时保留原始码与解析轨迹
    assert.equal(rows[0]?.raw_code, `(01)${GTIN_A}(10)LOT-A1)`);
    assert.equal(rows[0]?.code_form, 'UDI');
    const trace = JSON.parse(rows[0]?.code_parse_trace ?? '{}') as {
      code_form: string;
      di: string | null;
      batch_no: string | null;
      gtin: { valid: boolean } | null;
    };
    assert.equal(trace.code_form, 'UDI');
    assert.equal(trace.di, GTIN_A);
    assert.equal(trace.batch_no, 'LOT-A1');
    assert.equal(trace.gtin?.valid, true);
  });

  it('台账解析轨迹里没有具体失效期日期（只落类别）', () => {
    const result = settleBatch(
      ledger.db,
      [
        {
          operation_no: 'OP-CODE-002',
          room_no: 'OR-02',
          scanner_id: 'SC-02',
          items: [
            {
              material_code: GTIN_B,
              raw_code: `(01)${GTIN_B}(10)LOT-B2)(17)260630)`,
              quantity: 1,
              batch_no: 'LOT-B2',
            },
          ],
        },
      ],
      { keyProfile: 'v2' },
    );
    assert.equal(result.accepted.length, 1);
    const row = ledger.db
      .prepare(
        `SELECT code_parse_trace FROM material_binding
          WHERE material_code = ? AND operation_no = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(GTIN_B, 'OP-CODE-002') as { code_parse_trace: string } | undefined;
    assert.ok(row);
    assert.equal(row.code_parse_trace.includes('260630'), false, '台账轨迹里不得出现具体失效期日期');
    assert.ok(JSON.parse(row.code_parse_trace).expiry_category.length > 0);
  });
});

describe('归一层与台账 schema 的落地', () => {
  it('normalize 层与深解析层同源（不另写一份解析规则）', () => {
    const parsed = normalizeMaterialCode(`(01)${GTIN_A}(10)LOT-A1)`);
    assert.equal(parsed.code_form, 'UDI');
    assert.equal(parsed.canonical_code, GTIN_A);
    assert.equal(parsed.batch_no, 'LOT-A1');
    assert.equal(parsed.trace.di, GTIN_A);
    assert.equal(parsed.trace.gtin?.valid, true);
  });

  it('台账 schema 已升到含解析轨迹的版本', () => {
    const version = ledger.db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, LATEST_SCHEMA_VERSION);
    const columns = ledger.db
      .prepare('PRAGMA table_info(material_binding)')
      .all() as unknown as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    assert.ok(names.includes('code_form'));
    assert.ok(names.includes('code_parse_trace'));
  });
});
