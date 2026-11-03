/**
 * test_fee_category：费用类别与医保分类口径校验（对齐院内 14 类费用口径）。
 *
 * 覆盖：
 *   ① 口径真源：14 类允许集（顺序与院内口径逐字一致）、耗材允许子集、医保分类取值；
 *   ② 四条判定规则：合法组合放行；费用类别不在允许集 / 医保分类取值非法 /
 *      组合错配 / 耗材落在非材料类 —— 四类不合规各给**独立原因码**；
 *   ③ 绑定阶段：不合规耗材在业务层即被拒 → 转人工核查条目，**不落台账、不计费**；
 *   ④ 导入期差异清单：不合规行**照常导入**，差异清单行数与不合规数据行数相等；
 *   ⑤ 销项：补录后自动销项；单位口径与费用口径两类缺口**并存互不顶掉**；
 *   ⑥ 错误码：四个原因码都映射到已登记的 ERR_* 且有中文含义与建议处置；
 *   ⑦ 老库升级：v14 → v15 待补录清单唯一键换法，老行一条不丢。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { HisChargingClient } from '../src/charge/client.js';
import { writeBackOperationCharges } from '../src/charge/writeback.js';
import { bindOne } from '../src/engine/binding.js';
import {
  allowedInsuranceClasses,
  checkFeeCategoryPolicy,
  CONSUMABLE_FEE_CATEGORY,
  FEE_CATEGORIES,
  isAllowedFeeCategory,
  isConsumableFeeCategory,
  isValidInsuranceClass,
  MEDICAL_INSURANCE_CLASSES,
  REASON_FEE_CATEGORY_INSURANCE_MISMATCH,
  REASON_FEE_CATEGORY_NOT_ALLOWED,
  REASON_FEE_CATEGORY_NOT_CONSUMABLE,
  REASON_INSURANCE_CLASS_INVALID,
} from '../src/engine/fee-category.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMaterials, importMasterData } from '../src/ledger/import-master-data.js';
import {
  listMasterDataGaps,
  masterDataGapSummary,
} from '../src/ledger/master-data-gaps.js';
import { applyMigrations, MIGRATIONS } from '../src/ledger/migrations.js';
import { countCheckTasks, findCheckTask } from '../src/check/task.js';
import { ERROR_CODES, errorCodeForReason } from '../src/log/error-codes.js';
import { startFakeHisServer, type FakeHisServer } from './support/fake-his-server.js';

const TOKEN = 'his-charging-token-fee-4c17';
const CHARGE_PATH = '/api/v1/material-uses';
const projectRoot = resolve(import.meta.dirname, '..', '..');

const OPERATIONS_CSV = [
  'operation_no,room_no,dept_code,status,closed_at',
  'OP-FEE-001,OR-01,SURG-01,open,',
].join('\n');

/** 耗材主数据表头（字段名与 spec.md 最小数据格式逐字一致） */
const MATERIAL_HEADER =
  'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio';

/** 合规耗材：卫生材料 + 甲类 */
const ROW_OK = 'MAT-FEE-OK,合规耗材,PR-FEE-01,卫生材料,甲类,true,LOT-F1,包,支,支,1';
/** 费用类别不在院内 14 类允许集内 */
const ROW_BAD_CATEGORY = 'MAT-FEE-UNKNOWN,不在允许集的耗材,PR-FEE-02,医疗器械,甲类,true,LOT-F2,包,支,支,1';
/** 医保分类取值非法（写成「甲」而不是「甲类」） */
const ROW_BAD_CLASS = 'MAT-FEE-BADCLASS,医保分类写错的耗材,PR-FEE-03,卫生材料,甲,true,LOT-F3,包,支,支,1';
/** 组合错配：基本诊疗项目（床位）标成丙类（全自费） */
const ROW_MISMATCH = 'MAT-FEE-MISMATCH,组合错配的耗材,PR-FEE-04,床位,丙类,true,LOT-F4,包,支,支,1';
/** 耗材落在药品类（西药） */
const ROW_DRUG = 'MAT-FEE-DRUG,落进药品类的耗材,PR-FEE-05,西药,甲类,true,LOT-F5,包,支,支,1';
/** 同时缺换算系数、又落在药品类 */
const ROW_BOTH = 'MAT-FEE-BOTH,两类问题一起的耗材,PR-FEE-06,西药,甲类,true,LOT-F6,包,支,支,';

/** 拼一份耗材主数据 CSV（一张表头 + 多行数据） */
function materialsCsv(...rows: string[]): string {
  return [MATERIAL_HEADER, ...rows].join('\n');
}

/** 合规耗材：卫生材料 + 甲类 */
const MATERIAL_OK_CSV = materialsCsv(ROW_OK);
/** 费用类别不在院内 14 类允许集内 */
const MATERIAL_BAD_CATEGORY_CSV = materialsCsv(ROW_BAD_CATEGORY);
/** 医保分类取值非法（写成「甲」而不是「甲类」） */
const MATERIAL_BAD_CLASS_CSV = materialsCsv(ROW_BAD_CLASS);
/** 组合错配：基本诊疗项目（床位）标成丙类（全自费） */
const MATERIAL_MISMATCH_CSV = materialsCsv(ROW_MISMATCH);
/** 耗材落在药品类（西药） */
const MATERIAL_DRUG_CSV = materialsCsv(ROW_DRUG);
/** 两类问题一起（缺换算系数 + 落在药品类） */
const MATERIAL_BOTH_CSV = materialsCsv(ROW_BOTH);

function newLedger(): LedgerDb {
  return openLedger(':memory:');
}

describe('test_fee_category · 费用类别与医保分类口径', () => {
  describe('① 口径真源：14 类允许集 / 耗材允许子集 / 医保分类取值', () => {
    it('14 类费用口径齐全，顺序与院内「医疗收费信息」口径逐字一致', () => {
      assert.equal(FEE_CATEGORIES.length, 14);
      assert.deepEqual(
        FEE_CATEGORIES.map((c) => c.name),
        [
          '床位', '诊察', '检查', '化验', '治疗', '手术', '护理',
          '卫生材料', '西药', '中药饮片', '中成药', '一般诊疗', '挂号', '其他',
        ],
      );
    });

    it('耗材只允许落在「卫生材料」类', () => {
      assert.equal(CONSUMABLE_FEE_CATEGORY, '卫生材料');
      assert.deepEqual(
        FEE_CATEGORIES.filter((c) => c.consumable_allowed).map((c) => c.name),
        [CONSUMABLE_FEE_CATEGORY],
      );
      assert.equal(isConsumableFeeCategory('卫生材料'), true);
      assert.equal(isConsumableFeeCategory('西药'), false);
      assert.equal(isConsumableFeeCategory('床位'), false);
    });

    it('医保分类只接受 甲类 / 乙类 / 丙类', () => {
      assert.deepEqual([...MEDICAL_INSURANCE_CLASSES], ['甲类', '乙类', '丙类']);
      for (const ok of ['甲类', '乙类', '丙类']) {
        assert.equal(isValidInsuranceClass(ok), true, `${ok} 应合法`);
      }
      for (const bad of ['甲', 'A类', '自费', '甲乙丙', '', null]) {
        assert.equal(isValidInsuranceClass(bad), false, `${String(bad)} 应非法`);
      }
    });

    it('允许集判定：14 类之内为真，之外为假', () => {
      assert.equal(isAllowedFeeCategory('卫生材料'), true);
      assert.equal(isAllowedFeeCategory('西药'), true);
      assert.equal(isAllowedFeeCategory('医疗器械'), false);
      assert.equal(isAllowedFeeCategory(''), false);
      assert.deepEqual([...(allowedInsuranceClasses('卫生材料') ?? [])], ['甲类', '乙类', '丙类']);
      assert.deepEqual([...(allowedInsuranceClasses('床位') ?? [])], ['甲类', '乙类']);
      assert.equal(allowedInsuranceClasses('医疗器械'), null);
    });
  });

  describe('② 四条判定规则：合法放行，四类不合规各给独立原因码', () => {
    it('合法组合放行（卫生材料 × 甲/乙/丙 都合法）', () => {
      for (const insuranceClass of MEDICAL_INSURANCE_CLASSES) {
        const verdict = checkFeeCategoryPolicy({
          fee_category: '卫生材料',
          medical_insurance_class: insuranceClass,
        });
        assert.equal(verdict.ok, true, `卫生材料 × ${insuranceClass} 应放行`);
        assert.equal(verdict.reason_code, null);
        assert.equal(verdict.issue, null);
      }
    });

    it('费用类别不在允许集内 → FEE_CATEGORY_NOT_ALLOWED', () => {
      const verdict = checkFeeCategoryPolicy({
        fee_category: '医疗器械',
        medical_insurance_class: '甲类',
      });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason_code, REASON_FEE_CATEGORY_NOT_ALLOWED);
      assert.equal(verdict.issue, 'fee_category_not_allowed');
      assert.match(verdict.message ?? '', /14 类/);
    });

    it('医保分类取值非法 → INSURANCE_CLASS_INVALID', () => {
      for (const bad of ['甲', 'A类', '自费']) {
        const verdict = checkFeeCategoryPolicy({
          fee_category: '卫生材料',
          medical_insurance_class: bad,
        });
        assert.equal(verdict.ok, false);
        assert.equal(verdict.reason_code, REASON_INSURANCE_CLASS_INVALID);
        assert.equal(verdict.issue, 'insurance_class_invalid');
      }
    });

    it('组合错配（基本诊疗项目标成丙类）→ FEE_CATEGORY_INSURANCE_MISMATCH', () => {
      const verdict = checkFeeCategoryPolicy({
        fee_category: '床位',
        medical_insurance_class: '丙类',
      });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason_code, REASON_FEE_CATEGORY_INSURANCE_MISMATCH);
      assert.equal(verdict.issue, 'fee_category_insurance_mismatch');
      assert.match(verdict.message ?? '', /错配/);
      // 允许矩阵在结果里可见（便于核查条目展示）
      assert.deepEqual([...(verdict.allowed_insurance_classes ?? [])], ['甲类', '乙类']);
    });

    it('耗材落在非材料类 → FEE_CATEGORY_NOT_CONSUMABLE（与前三条各有独立码）', () => {
      const verdict = checkFeeCategoryPolicy({
        fee_category: '西药',
        medical_insurance_class: '甲类',
      });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason_code, REASON_FEE_CATEGORY_NOT_CONSUMABLE);
      assert.equal(verdict.issue, 'fee_category_not_consumable');
      assert.match(verdict.message ?? '', /卫生材料/);

      // 四条原因码互不相同
      const codes = new Set([
        REASON_FEE_CATEGORY_NOT_ALLOWED,
        REASON_INSURANCE_CLASS_INVALID,
        REASON_FEE_CATEGORY_INSURANCE_MISMATCH,
        REASON_FEE_CATEGORY_NOT_CONSUMABLE,
      ]);
      assert.equal(codes.size, 4);
    });
  });

  describe('③ 绑定阶段：不合规耗材被拒、转人工、不落台账不计费', () => {
    let ledger: LedgerDb;
    let server: FakeHisServer;

    before(async () => {
      server = await startFakeHisServer();
    });

    after(async () => {
      await server.close();
    });

    beforeEach(() => {
      ledger = newLedger();
    });

    after(() => {
      ledger?.close();
    });

    it('费用口径不合规的耗材：判异常 + 转人工核查条目（带台次上下文）', () => {
      importMasterData(ledger.db, { operationsCsv: OPERATIONS_CSV, materialsCsv: MATERIAL_DRUG_CSV });
      const outcome = bindOne(ledger.db, {
        db: ledger.db,
        operation_no: 'OP-FEE-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-FEE-01',
        material_code: 'MAT-FEE-DRUG',
        raw_code: 'MAT-FEE-DRUG',
        quantity: 1,
      });
      assert.equal(outcome.bound, false);
      assert.equal(outcome.conclusion, 'NOT_REGISTERED');
      assert.equal(outcome.reason_code, REASON_FEE_CATEGORY_NOT_CONSUMABLE);
      assert.equal(outcome.error_code, 'ERR_FEE_CATEGORY_NOT_CONSUMABLE');
      // 不落台账（失败不静默改数据）
      assert.equal(countBindings(ledger.db), 0);
      // 转人工：核查条目带台次上下文
      assert.equal(countCheckTasks(ledger.db), 1);
      const task = findCheckTask(ledger.db, 1);
      assert.equal(task?.operation_no, 'OP-FEE-001');
      assert.equal(task?.material_code, 'MAT-FEE-DRUG');
      assert.equal(task?.reason_code, REASON_FEE_CATEGORY_NOT_CONSUMABLE);
      assert.equal(task?.error_code, 'ERR_FEE_CATEGORY_NOT_CONSUMABLE');
    });

    it('不合规的耗材不会走到计费侧（对端一条明细都没收到）', async () => {
      importMasterData(ledger.db, { operationsCsv: OPERATIONS_CSV, materialsCsv: MATERIAL_MISMATCH_CSV });
      bindOne(ledger.db, {
        db: ledger.db,
        operation_no: 'OP-FEE-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-FEE-01',
        material_code: 'MAT-FEE-MISMATCH',
        raw_code: 'MAT-FEE-MISMATCH',
        quantity: 1,
      });
      const client = new HisChargingClient({ baseUrl: server.baseUrl, token: TOKEN });
      const result = await writeBackOperationCharges(ledger.db, 'OP-FEE-001', {
        client,
        path: CHARGE_PATH,
      });
      assert.equal(result.submitted, 0, '不合规耗材不提交计费');
      assert.equal(server.requests.length, 0, '对端一条明细都没收到');
    });

    it('合规耗材照常绑上并计费（口径校验不误伤正常耗材）', async () => {
      importMasterData(ledger.db, { operationsCsv: OPERATIONS_CSV, materialsCsv: MATERIAL_OK_CSV });
      const outcome = bindOne(ledger.db, {
        db: ledger.db,
        operation_no: 'OP-FEE-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-FEE-01',
        material_code: 'MAT-FEE-OK',
        raw_code: 'MAT-FEE-OK',
        quantity: 1,
      });
      assert.equal(outcome.bound, true);
      assert.equal(outcome.conclusion, 'BOUND');
      assert.equal(countBindings(ledger.db), 1);

      const client = new HisChargingClient({ baseUrl: server.baseUrl, token: TOKEN });
      const result = await writeBackOperationCharges(ledger.db, 'OP-FEE-001', {
        client,
        path: CHARGE_PATH,
      });
      assert.equal(result.submitted, 1);
      const use = server.requests[0]?.uses[0];
      assert.equal(use?.fee_category, '卫生材料');
      assert.equal(use?.medical_insurance_class, '甲类');
    });
  });

  describe('④ 导入期差异清单：不合规行照常导入，差异行数与不合规数据行数相等', () => {
    it('四类不合规耗材照常导入，各登记一条差异', () => {
      const ledger = newLedger();
      const csv = materialsCsv(ROW_OK, ROW_BAD_CATEGORY, ROW_BAD_CLASS, ROW_MISMATCH, ROW_DRUG);
      const result = importMaterials(ledger.db, csv);

      // 5 行全部照常导入（主数据是院内权威，导入器不替耗材管理岗删行）
      assert.equal(result.inserted, 5);
      assert.equal(result.skipped, 0);

      // 不合规数据行 = 4 行 → 差异清单 4 条（行数逐项相等）
      const nonCompliantRows = 4;
      assert.equal(result.fee_gaps.length, nonCompliantRows);

      const byType = new Map<string, string>();
      for (const gap of result.fee_gaps) {
        byType.set(gap.material_code, gap.gap_type);
        assert.ok(gap.detail.length > 0, '每条差异都要有中文说明');
      }
      assert.equal(byType.get('MAT-FEE-UNKNOWN'), REASON_FEE_CATEGORY_NOT_ALLOWED);
      assert.equal(byType.get('MAT-FEE-BADCLASS'), REASON_INSURANCE_CLASS_INVALID);
      assert.equal(byType.get('MAT-FEE-MISMATCH'), REASON_FEE_CATEGORY_INSURANCE_MISMATCH);
      assert.equal(byType.get('MAT-FEE-DRUG'), REASON_FEE_CATEGORY_NOT_CONSUMABLE);
      // 合规耗材不进差异清单
      assert.equal(result.fee_gaps.some((g) => g.material_code === 'MAT-FEE-OK'), false);

      // 待补录清单里也各有一条
      const gaps = listMasterDataGaps(ledger.db);
      assert.equal(gaps.length, nonCompliantRows);
      assert.equal(gaps.every((g) => g.status === 'pending'), true);
      ledger.close();
    });

    it('单位口径与费用口径两类缺口可并存（互不顶掉）', () => {
      const ledger = newLedger();
      // 这一条同时缺换算系数、又落在药品类
      const result = importMaterials(ledger.db, MATERIAL_BOTH_CSV);
      assert.equal(result.unit_gaps.length, 1);
      assert.equal(result.unit_gaps[0]?.gap_type, 'UNIT_RATIO_MISSING');
      assert.equal(result.fee_gaps.length, 1);
      assert.equal(result.fee_gaps[0]?.gap_type, REASON_FEE_CATEGORY_NOT_CONSUMABLE);

      // 清单里两条都在（唯一键是「耗材码 + 缺口类型」）
      const gaps = listMasterDataGaps(ledger.db);
      assert.equal(gaps.length, 2);
      assert.deepEqual(
        gaps.map((g) => g.gap_type).sort(),
        ['FEE_CATEGORY_NOT_CONSUMABLE', 'UNIT_RATIO_MISSING'],
      );
      ledger.close();
    });

    it('补录后重新导入：费用口径的待补录条目自动销项（且不动单位口径那条）', () => {
      const ledger = newLedger();
      importMaterials(ledger.db, MATERIAL_BOTH_CSV);
      assert.equal(masterDataGapSummary(ledger.db).pending, 2);

      // 耗材管理岗把费用类别改回卫生材料（单位口径还没补）
      const fixed = MATERIAL_BOTH_CSV.replace(',西药,甲类,', ',卫生材料,甲类,');
      const result = importMaterials(ledger.db, fixed);
      assert.equal(result.fee_gaps.length, 0);
      assert.equal(result.unit_gaps.length, 1, '单位口径的问题还在');

      const summary = masterDataGapSummary(ledger.db);
      assert.equal(summary.pending, 1, '只剩单位口径那一条待补录');
      assert.equal(summary.resolved, 1, '费用口径那条已销项');
      const pending = listMasterDataGaps(ledger.db);
      assert.equal(pending[0]?.gap_type, 'UNIT_RATIO_MISSING');
      ledger.close();
    });
  });

  describe('⑤ 错误码：四个原因码都映射到已登记的 ERR_*', () => {
    it('原因码 → 错误码映射到位，且每码有中文含义与建议处置', () => {
      const pairs: Array<[string, string]> = [
        [REASON_FEE_CATEGORY_NOT_ALLOWED, 'ERR_FEE_CATEGORY_NOT_ALLOWED'],
        [REASON_INSURANCE_CLASS_INVALID, 'ERR_INSURANCE_CLASS_INVALID'],
        [REASON_FEE_CATEGORY_INSURANCE_MISMATCH, 'ERR_FEE_CATEGORY_INSURANCE_MISMATCH'],
        [REASON_FEE_CATEGORY_NOT_CONSUMABLE, 'ERR_FEE_CATEGORY_NOT_CONSUMABLE'],
      ];
      for (const [reason, code] of pairs) {
        assert.equal(errorCodeForReason(reason), code);
        const entry = ERROR_CODES.find((e) => e.code === code);
        assert.ok(entry, `错误码 ${code} 未登记`);
        assert.equal(entry?.stage, 'binding');
        assert.equal(entry?.retryable, false, '口径不合规不可重投，转人工');
        assert.equal(entry?.needs_manual, true);
        assert.ok((entry?.meaning_zh ?? '').length > 0);
        assert.ok((entry?.action_zh ?? '').length > 0);
      }
    });

    it('口径对照表落盘 docs/api/fee-category.md，且与代码里的矩阵逐行对齐', () => {
      const doc = readFileSync(resolve(projectRoot, 'docs', 'api', 'fee-category.md'), 'utf8');
      assert.ok(doc.length > 2000, '口径文档内容过短');
      // 14 类费用类别逐个出现在文档里
      for (const category of FEE_CATEGORIES) {
        assert.ok(doc.includes(category.name), `口径文档缺少费用类别 ${category.name}`);
      }
      // 医保分类三类都在
      for (const insuranceClass of MEDICAL_INSURANCE_CLASSES) {
        assert.ok(doc.includes(insuranceClass), `口径文档缺少医保分类 ${insuranceClass}`);
      }
      // 四个原因码都在
      for (const reason of [
        REASON_FEE_CATEGORY_NOT_ALLOWED,
        REASON_INSURANCE_CLASS_INVALID,
        REASON_FEE_CATEGORY_INSURANCE_MISMATCH,
        REASON_FEE_CATEGORY_NOT_CONSUMABLE,
      ]) {
        assert.ok(doc.includes(reason), `口径文档缺少原因码 ${reason}`);
      }
      // 来源与口径说明
      assert.ok(doc.includes('医疗收费信息'));
      assert.ok(doc.includes('口径说明'));
    });
  });

  describe('⑥ 老库升级：v14 → v15 待补录清单唯一键换法，老行不丢', () => {
    it('v14 老库升级到 v15：既有待补录行一条不丢，且两类缺口可并存', () => {
      const dir = mkdtempSync(join(tmpdir(), 'msb-fee-'));
      const path = join(dir, 'ledger.db');
      try {
        // 造一个 v14 的老库：迁移链截断到 14
        const legacyDb = new DatabaseSync(path);
        applyMigrations(legacyDb, { chain: MIGRATIONS.slice(0, 14) });
        legacyDb
          .prepare(
            `INSERT INTO master_data_gap (material_code, gap_type, detail, status, detected_at, resolved_at, created_at)
             VALUES (?, ?, ?, 'pending', ?, NULL, ?)`,
          )
          .run('MAT-LEGACY-FEE', 'UNIT_RATIO_MISSING', '老库遗留的单位口径缺口', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        legacyDb.close();

        // 重新开库 → 升到链尾（v15）
        const upgraded = openLedger(path);
        const gaps = listMasterDataGaps(upgraded.db);
        assert.equal(gaps.length, 1, '老库待补录行一条不丢');
        assert.equal(gaps[0]?.material_code, 'MAT-LEGACY-FEE');
        assert.equal(gaps[0]?.gap_type, 'UNIT_RATIO_MISSING');
        assert.equal(gaps[0]?.status, 'pending');

        // 新索引生效：同一条耗材可以再挂一条费用口径的缺口
        importMaterials(upgraded.db, [
          'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio',
          'MAT-LEGACY-FEE,老库耗材,PR-FEE-07,西药,甲类,true,LOT-F7,包,支,支,1',
        ].join('\n'));
        const after = [
          ...listMasterDataGaps(upgraded.db, { status: 'pending' }),
          ...listMasterDataGaps(upgraded.db, { status: 'resolved' }),
        ];
        assert.equal(after.length, 2, '升级后两类缺口并存');
        assert.ok(
          after.some((g) => g.material_code === 'MAT-LEGACY-FEE' && g.gap_type === 'UNIT_RATIO_MISSING'),
          '老库遗留的待补录行一条不丢',
        );
        assert.ok(
          after.some((g) => g.gap_type === 'FEE_CATEGORY_NOT_CONSUMABLE'),
          '新导入的费用口径缺口与老行并存',
        );
        upgraded.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
