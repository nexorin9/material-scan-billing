/**
 * test_units：数量与计价单位换算（扫码计数单位 → 计价单位）。
 *
 * 覆盖：
 *   ① 换算内核：1 包 = 5 支换算正确；换算轨迹四字段齐全；
 *   ② 边界：除不尽（3 支 / 2 包）判异常且**无四舍五入痕迹**；数量非正判异常；
 *      缺 ratio / 系数非正 / 口径不自洽各给**独立原因码**；
 *   ③ 绑定阶段：缺 ratio 与除不尽的条目都转人工（升核查条目），正常条目 BOUND
 *      且台账同时留原始数量与换算轨迹；
 *   ④ 导入期：缺 ratio 的耗材**照常导入**但进待补录清单；补录后重新导入自动销项；
 *   ⑤ 计费回写：提交给 HIS 的是**换算后的计价数量**（真实 HTTP 替身核对载荷）；
 *   ⑥ 老库升级：老耗材行按 1:1 补齐并登记待补录（假定值不静默）。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { HisChargingClient } from '../src/charge/client.js';
import { writeBackOperationCharges } from '../src/charge/writeback.js';
import { bindOne } from '../src/engine/binding.js';
import { classify } from '../src/engine/conclude.js';
import {
  convertQuantity,
  evaluateUnitMapping,
  REASON_UNIT_MAPPING_INCONSISTENT,
  REASON_UNIT_QUANTITY_NOT_INTEGER,
  REASON_UNIT_QUANTITY_NOT_POSITIVE,
  REASON_UNIT_RATIO_INVALID,
  REASON_UNIT_RATIO_MISSING,
  REASON_UNIT_UNIT_MISSING,
} from '../src/engine/units.js';
import { countBindings, findMaterial } from '../src/ledger/binding-repo.js';
import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMaterials, importMasterData } from '../src/ledger/import-master-data.js';
import {
  listMasterDataGaps,
  masterDataGapSummary,
} from '../src/ledger/master-data-gaps.js';
import { applyMigrations, MIGRATIONS } from '../src/ledger/migrations.js';
import { countCheckTasks, findCheckTask } from '../src/check/task.js';
import { runDoctor } from '../src/cli/commands.js';
import { startFakeHisServer, type FakeHisServer } from './support/fake-his-server.js';

const TOKEN = 'his-charging-token-units-9f21';
const CHARGE_PATH = '/api/v1/material-uses';

const OPERATIONS_CSV = [
  'operation_no,room_no,dept_code,status,closed_at',
  'OP-UNIT-001,OR-01,SURG-01,open,',
  'OP-UNIT-002,OR-02,SURG-01,open,',
].join('\n');

/** 1 包 = 5 支（包装计费，拆零按支计） */
const MATERIAL_PACK5_CSV = [
  'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio',
  'MAT-UNIT-PACK5,五支一包耗材,PR-UNIT-01,卫生材料,甲类,true,LOT-U1,包,支,支,5',
].join('\n');

/** 拆零到单件扫、按包计费（2 支 = 1 包 → 1 支 = 0.5 包） */
const MATERIAL_PACK2_CSV = [
  'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio',
  'MAT-UNIT-PACK2,两支一包耗材,PR-UNIT-02,卫生材料,甲类,true,LOT-U2,支,支,包,0.5',
].join('\n');

/** 缺换算系数（主数据没补录） */
const MATERIAL_NO_RATIO_CSV = [
  'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio',
  'MAT-UNIT-NORATIO,缺系数耗材,PR-UNIT-03,卫生材料,甲类,true,LOT-U3,包,支,支,',
].join('\n');

function newLedger(): LedgerDb {
  return openLedger(':memory:');
}

function seed(ledger: LedgerDb, materialsCsv: string): void {
  importMasterData(ledger.db, { operationsCsv: OPERATIONS_CSV, materialsCsv });
}

describe('test_units · 数量与计价单位换算', () => {
  describe('① 换算内核', () => {
    it('1 包 = 5 支：换算结果为 5，轨迹四字段齐全', () => {
      const result = convertQuantity(
        1,
        { unit_pack: '包', unit_min: '支', charge_unit: '支', ratio: 5 },
        'MAT-UNIT-PACK5',
      );
      assert.equal(result.ok, true);
      assert.equal(result.reason_code, null);
      assert.equal(result.trace.charge_quantity, 5);
      // 轨迹四字段：原始数量 / 包装单位 / 系数 / 计价数量
      assert.equal(result.trace.raw_quantity, 1);
      assert.equal(result.trace.pack_unit, '包');
      assert.equal(result.trace.ratio, 5);
      assert.equal(result.trace.charge_quantity, 5);
      // 附加字段：耗材码与计价单位（便于事后核对）
      assert.equal(result.trace.material_code, 'MAT-UNIT-PACK5');
      assert.equal(result.trace.charge_unit, '支');

      // 两包就是十支
      const two = convertQuantity(
        2,
        { unit_pack: '包', unit_min: '支', charge_unit: '支', ratio: 5 },
        'MAT-UNIT-PACK5',
      );
      assert.equal(two.trace.charge_quantity, 10);
    });

    it('包装即计价（1:1）：换算结果与原始数量一致', () => {
      const result = convertQuantity(
        3,
        { unit_pack: '包', unit_min: '支', charge_unit: '包', ratio: 1 },
        'MAT-UNIT-1TO1',
      );
      assert.equal(result.ok, true);
      assert.equal(result.trace.charge_quantity, 3);
    });

    it('除不尽（3 支 / 2 包 = 1.5 包）：判异常且无四舍五入痕迹', () => {
      const result = convertQuantity(
        3,
        { unit_pack: '支', unit_min: '支', charge_unit: '包', ratio: 0.5 },
        'MAT-UNIT-PACK2',
      );
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, REASON_UNIT_QUANTITY_NOT_INTEGER);
      assert.equal(result.trace.charge_quantity, null);
      // 不得出现「四舍五入成 X」「向上取整」「约等于 X」这类取整痕迹
      assert.doesNotMatch(result.message ?? '', /四舍五入成|向上取整|向下取整|约等于|≈/);
      assert.match(result.message ?? '', /除不尽/);
      // 换算轨迹里也没有被悄悄取整的计价数量
      assert.equal(result.trace.charge_quantity, null);
    });

    it('拆零用的分数包装换算不整时同样判异常（0.5 包 × 5 = 2.5 支）', () => {
      const result = convertQuantity(
        0.5,
        { unit_pack: '包', unit_min: '支', charge_unit: '支', ratio: 5 },
        'MAT-UNIT-PACK5',
      );
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, REASON_UNIT_QUANTITY_NOT_INTEGER);
      assert.equal(result.trace.charge_quantity, null);
    });

    it('数量不是正数：判异常（独立原因码）', () => {
      for (const quantity of [0, -1]) {
        const result = convertQuantity(
          quantity,
          { unit_pack: '包', unit_min: '支', charge_unit: '支', ratio: 5 },
          'MAT-UNIT-PACK5',
        );
        assert.equal(result.ok, false);
        assert.equal(result.reason_code, REASON_UNIT_QUANTITY_NOT_POSITIVE);
      }
    });

    it('主数据缺 ratio：判异常（独立原因码，不与「耗材未建档」混同）', () => {
      const result = convertQuantity(
        1,
        { unit_pack: '包', unit_min: '支', charge_unit: '支', ratio: null },
        'MAT-UNIT-NORATIO',
      );
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, REASON_UNIT_RATIO_MISSING);
    });

    it('系数不是正数：判异常（独立原因码）', () => {
      const result = convertQuantity(
        1,
        { unit_pack: '包', unit_min: '支', charge_unit: '支', ratio: 0 },
        'MAT-UNIT-PACK5',
      );
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, REASON_UNIT_RATIO_INVALID);
    });

    it('单位口径不自洽：各给独立原因码', () => {
      // 单位名缺一
      assert.equal(
        evaluateUnitMapping({ unit_pack: '包', unit_min: null, charge_unit: '支', ratio: 5 }).reason_code,
        REASON_UNIT_UNIT_MISSING,
      );
      // 缺系数
      assert.equal(
        evaluateUnitMapping({ unit_pack: '包', unit_min: '支', charge_unit: '支', ratio: null }).reason_code,
        REASON_UNIT_RATIO_MISSING,
      );
      // 系数非正
      assert.equal(
        evaluateUnitMapping({ unit_pack: '包', unit_min: '支', charge_unit: '支', ratio: -2 }).reason_code,
        REASON_UNIT_RATIO_INVALID,
      );
      // ratio = 1 时计价单位既不是包装单位也不是最小单位
      assert.equal(
        evaluateUnitMapping({ unit_pack: '包', unit_min: '支', charge_unit: '套', ratio: 1 }).reason_code,
        REASON_UNIT_MAPPING_INCONSISTENT,
      );
      // 按包装计价但系数不是 1
      assert.equal(
        evaluateUnitMapping({ unit_pack: '包', unit_min: '支', charge_unit: '包', ratio: 2 }).reason_code,
        REASON_UNIT_MAPPING_INCONSISTENT,
      );
      // 按最小单位计价但系数小于 1
      assert.equal(
        evaluateUnitMapping({ unit_pack: '包', unit_min: '支', charge_unit: '支', ratio: 0.5 }).reason_code,
        REASON_UNIT_MAPPING_INCONSISTENT,
      );
    });

    it('自洽的三种口径都放行', () => {
      assert.equal(
        evaluateUnitMapping({ unit_pack: '包', unit_min: '支', charge_unit: '支', ratio: 5 }).ok,
        true,
      );
      assert.equal(
        evaluateUnitMapping({ unit_pack: '包', unit_min: '支', charge_unit: '包', ratio: 1 }).ok,
        true,
      );
      assert.equal(
        evaluateUnitMapping({ unit_pack: '支', unit_min: '支', charge_unit: '包', ratio: 0.5 }).ok,
        true,
      );
    });
  });

  describe('② 绑定阶段：转人工与台账留痕', () => {
    let ledger: LedgerDb;

    beforeEach(() => {
      ledger = newLedger();
    });

    after(() => {
      ledger?.close();
    });

    it('正常条目 BOUND：台账同时留原始数量与换算轨迹', () => {
      seed(ledger, MATERIAL_PACK5_CSV);
      const outcome = bindOne(ledger.db, {
        db: ledger.db,
        operation_no: 'OP-UNIT-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-UNIT-01',
        material_code: 'MAT-UNIT-PACK5',
        raw_code: 'MAT-UNIT-PACK5',
        quantity: 2,
      });
      assert.equal(outcome.bound, true);
      assert.equal(outcome.conclusion, 'BOUND');

      const row = ledger.db
        .prepare(
          `SELECT quantity, charge_quantity, quantity_trace FROM material_binding
            WHERE material_code = 'MAT-UNIT-PACK5'`,
        )
        .get() as { quantity: number; charge_quantity: number; quantity_trace: string };
      // 原始数量（包装数）与计价数量（换算后）**两列都在**
      assert.equal(row.quantity, 2);
      assert.equal(row.charge_quantity, 10);
      const trace = JSON.parse(row.quantity_trace) as Record<string, unknown>;
      assert.equal(trace['raw_quantity'], 2);
      assert.equal(trace['pack_unit'], '包');
      assert.equal(trace['ratio'], 5);
      assert.equal(trace['charge_quantity'], 10);
    });

    it('除不尽的条目：判异常 + 转人工（升核查条目），不落台账、不计费', () => {
      seed(ledger, MATERIAL_PACK2_CSV);
      const outcome = bindOne(ledger.db, {
        db: ledger.db,
        operation_no: 'OP-UNIT-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-UNIT-01',
        material_code: 'MAT-UNIT-PACK2',
        raw_code: 'MAT-UNIT-PACK2',
        quantity: 3,
      });
      assert.equal(outcome.bound, false);
      assert.equal(outcome.conclusion, 'NOT_REGISTERED');
      assert.equal(outcome.reason_code, REASON_UNIT_QUANTITY_NOT_INTEGER);
      assert.equal(outcome.error_code, 'ERR_QUANTITY_NOT_DIVISIBLE');
      // 不落台账（失败不静默改数据）
      assert.equal(countBindings(ledger.db), 0);
      // 转人工：核查条目带台次上下文
      assert.equal(countCheckTasks(ledger.db), 1);
      const task = findCheckTask(ledger.db, 1);
      assert.equal(task?.operation_no, 'OP-UNIT-001');
      assert.equal(task?.material_code, 'MAT-UNIT-PACK2');
      assert.equal(task?.reason_code, REASON_UNIT_QUANTITY_NOT_INTEGER);
      assert.equal(task?.error_code, 'ERR_QUANTITY_NOT_DIVISIBLE');
    });

    it('主数据缺 ratio 的条目：判异常 + 转人工（导入期已登记待补录）', () => {
      seed(ledger, MATERIAL_NO_RATIO_CSV);
      const outcome = bindOne(ledger.db, {
        db: ledger.db,
        operation_no: 'OP-UNIT-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-UNIT-01',
        material_code: 'MAT-UNIT-NORATIO',
        raw_code: 'MAT-UNIT-NORATIO',
        quantity: 1,
      });
      assert.equal(outcome.bound, false);
      assert.equal(outcome.conclusion, 'NOT_REGISTERED');
      assert.equal(outcome.reason_code, REASON_UNIT_RATIO_MISSING);
      assert.equal(outcome.error_code, 'ERR_UNIT_RATIO_MISSING');
      assert.equal(countBindings(ledger.db), 0);
      assert.equal(countCheckTasks(ledger.db), 1);
    });

    it('判定层直接给出换算轨迹（不落台账也能看到算的是什么）', () => {
      seed(ledger, MATERIAL_PACK5_CSV);
      const judged = classify({
        db: ledger.db,
        operation_no: 'OP-UNIT-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-UNIT-01',
        material_code: 'MAT-UNIT-PACK5',
        raw_code: 'MAT-UNIT-PACK5',
        quantity: 3,
      });
      assert.equal(judged.conclusion, 'BOUND');
      assert.equal(judged.quantity_conversion?.trace.charge_quantity, 15);
    });
  });

  describe('③ 导入期：主数据待补录清单', () => {
    it('缺 ratio 的耗材照常导入，但登记待补录', () => {
      const ledger = newLedger();
      const result = importMaterials(ledger.db, MATERIAL_NO_RATIO_CSV);
      // 照常导入（主数据是院内权威，导入器不替耗材管理岗删行）
      assert.equal(result.inserted, 1);
      assert.equal(result.skipped, 0);
      // 但登记待补录
      assert.equal(result.unit_gaps.length, 1);
      assert.equal(result.unit_gaps[0]?.material_code, 'MAT-UNIT-NORATIO');
      assert.equal(result.unit_gaps[0]?.gap_type, REASON_UNIT_RATIO_MISSING);

      const gaps = listMasterDataGaps(ledger.db);
      assert.equal(gaps.length, 1);
      assert.equal(gaps[0]?.status, 'pending');
      assert.match(gaps[0]?.detail ?? '', /换算系数/);

      // 运行期读到的是「没有系数」
      const material = findMaterial(ledger.db, 'MAT-UNIT-NORATIO');
      assert.equal(material?.ratio, null);
      ledger.close();
    });

    it('口径不自洽的耗材也进待补录清单（导入期暴露，不留到运行期）', () => {
      const ledger = newLedger();
      const badCsv = [
        'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio',
        'MAT-UNIT-BAD,口径不自洽耗材,PR-UNIT-09,卫生材料,甲类,true,LOT-U9,包,支,包,2',
      ].join('\n');
      const result = importMaterials(ledger.db, badCsv);
      assert.equal(result.inserted, 1);
      assert.equal(result.unit_gaps.length, 1);
      assert.equal(result.unit_gaps[0]?.gap_type, REASON_UNIT_MAPPING_INCONSISTENT);
      assert.equal(masterDataGapSummary(ledger.db).pending, 1);
      ledger.close();
    });

    it('补录后重新导入：待补录条目自动销项', () => {
      const ledger = newLedger();
      importMaterials(ledger.db, MATERIAL_NO_RATIO_CSV);
      assert.equal(masterDataGapSummary(ledger.db).pending, 1);

      // 耗材管理岗补录系数后重新导入
      const fixedCsv = [
        'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio',
        'MAT-UNIT-NORATIO,缺系数耗材,PR-UNIT-03,卫生材料,甲类,true,LOT-U3,包,支,支,5',
      ].join('\n');
      const result = importMaterials(ledger.db, fixedCsv);
      assert.equal(result.unit_gaps.length, 0);
      assert.equal(masterDataGapSummary(ledger.db).pending, 0);
      assert.equal(masterDataGapSummary(ledger.db).resolved, 1);
      // 主数据已生效（导入即生效，不重启）
      assert.equal(findMaterial(ledger.db, 'MAT-UNIT-NORATIO')?.ratio, 5);
      ledger.close();
    });

    it('ratio 列写成非数值：按未登记处理并登记待补录（不猜它等于几）', () => {
      const ledger = newLedger();
      const csv = [
        'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio',
        'MAT-UNIT-TEXT,中文系数耗材,PR-UNIT-10,卫生材料,甲类,true,LOT-UT,包,支,支,五支一包',
      ].join('\n');
      const result = importMaterials(ledger.db, csv);
      assert.equal(result.inserted, 1);
      assert.equal(result.unit_gaps.length, 1);
      assert.equal(result.unit_gaps[0]?.gap_type, REASON_UNIT_RATIO_MISSING);
      assert.match(result.unit_gaps[0]?.detail ?? '', /五支一包/);
      assert.equal(findMaterial(ledger.db, 'MAT-UNIT-TEXT')?.ratio, null);
      ledger.close();
    });
  });

  describe('④ 计费回写：用换算后的计价数量', () => {
    let server: FakeHisServer;
    let ledger: LedgerDb;

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

    it('提交给 HIS 的是计价数量（2 包 × 5 = 10 支），原始包装数不进载荷', async () => {
      seed(ledger, MATERIAL_PACK5_CSV);
      bindOne(ledger.db, {
        db: ledger.db,
        operation_no: 'OP-UNIT-001',
        room_no: 'OR-01',
        scanner_id: 'SCAN-UNIT-01',
        material_code: 'MAT-UNIT-PACK5',
        raw_code: 'MAT-UNIT-PACK5',
        quantity: 2,
      });

      const client = new HisChargingClient({ baseUrl: server.baseUrl, token: TOKEN });
      const result = await writeBackOperationCharges(ledger.db, 'OP-UNIT-001', {
        client,
        path: CHARGE_PATH,
      });
      assert.equal(result.submitted, 1);
      assert.equal(result.accepted, 1);
      assert.equal(server.requests.length, 1);
      const use = server.requests[0]?.uses[0];
      assert.equal(use?.quantity, 10, '提交的必须是换算后的计价数量');
      assert.equal(use?.material_code, 'MAT-UNIT-PACK5');
      // 回执行里的载荷快照也是计价数量（事后核对用）
      const receipt = ledger.db
        .prepare('SELECT submitted_quantity FROM charge_receipt ORDER BY id ASC LIMIT 1')
        .get() as { submitted_quantity: number };
      assert.equal(receipt.submitted_quantity, 10);
    });
  });

  describe('⑤ 老库升级：1:1 补齐并登记待补录', () => {
    it('v13 老库升级到 v14：老耗材行按 1:1 补齐，假定值登记待补录', () => {
      const dir = mkdtempSync(join(tmpdir(), 'msb-units-'));
      const path = join(dir, 'ledger.db');
      try {
        // 造一个 v13 的老库（停在单位换算这一版之前）：迁移链截断到 13
        const legacyDb = new DatabaseSync(path);
        applyMigrations(legacyDb, { chain: MIGRATIONS.slice(0, 13) });
        legacyDb
          .prepare(
            `INSERT INTO material (material_code, name, price_code, fee_category, medical_insurance_class,
                                   active, batch_no, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run('MAT-LEGACY-01', '老库耗材', 'PR-LEGACY-01', '卫生材料', '甲类', 'LOT-LEGACY', '2026-01-01T00:00:00Z');
        legacyDb.close();

        // 重新开库 → 升到链尾（v14）
        const upgraded = openLedger(path);
        const material = findMaterial(upgraded.db, 'MAT-LEGACY-01');
        assert.equal(material?.ratio, 1, '老库按 1:1 补齐（保持升级前计费行为不变）');
        assert.equal(material?.unit_pack, '支');
        assert.equal(material?.unit_min, '支');
        assert.equal(material?.charge_unit, '支');

        // 假定值不静默：登记待补录
        const gaps = listMasterDataGaps(upgraded.db);
        assert.equal(gaps.length, 1);
        assert.equal(gaps[0]?.gap_type, 'UNIT_RATIO_ASSUMED');
        assert.match(gaps[0]?.detail ?? '', /1:1/);
        upgraded.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('老库补齐后 1:1 换算照常成立（升级不改变计费口径）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'msb-units-'));
      const path = join(dir, 'ledger.db');
      try {
        const legacyDb = new DatabaseSync(path);
        applyMigrations(legacyDb, { chain: MIGRATIONS.slice(0, 13) });
        legacyDb
          .prepare(
            `INSERT INTO material (material_code, name, price_code, fee_category, medical_insurance_class,
                                   active, batch_no, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run('MAT-LEGACY-01', '老库耗材', 'PR-LEGACY-01', '卫生材料', '甲类', 'LOT-LEGACY', '2026-01-01T00:00:00Z');
        legacyDb.close();

        const upgraded = openLedger(path);
        const material = findMaterial(upgraded.db, 'MAT-LEGACY-01');
        const result = convertQuantity(3, {
          unit_pack: material?.unit_pack ?? null,
          unit_min: material?.unit_min ?? null,
          charge_unit: material?.charge_unit ?? null,
          ratio: material?.ratio ?? null,
        }, 'MAT-LEGACY-01');
        assert.equal(result.ok, true);
        assert.equal(result.trace.charge_quantity, 3, '1:1 补齐后计费数量与升级前一致');
        upgraded.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('⑥ 待补录清单在 doctor 里能直接看到', () => {
    it('doctor 报出待补录条目（耗材码 / 缺口类型 / 说明）与已销项条数', () => {
      const ledger = newLedger();
      try {
        seed(ledger, `${MATERIAL_NO_RATIO_CSV}\n${MATERIAL_PACK5_CSV}`);

        const report = runDoctor(ledger.db, process.env, { ledger_db_path: ':memory:' });
        assert.equal(report.master_data_gaps.pending, 1);
        assert.equal(report.master_data_gaps.resolved, 0);
        assert.equal(report.master_data_gaps.items.length, 1);
        assert.equal(report.master_data_gaps.items[0]?.material_code, 'MAT-UNIT-NORATIO');
        assert.equal(report.master_data_gaps.items[0]?.gap_type, 'UNIT_RATIO_MISSING');
        assert.ok((report.master_data_gaps.items[0]?.detail ?? '').length > 0, '待补录条目要带中文说明');

        // 补录后重新导入 → 自动销项 → doctor 报 pending 0 / resolved 1
        const fixed = MATERIAL_NO_RATIO_CSV.replace(',包,支,支,', ',包,支,支,5');
        importMaterials(ledger.db, fixed);
        const after = runDoctor(ledger.db, process.env, { ledger_db_path: ':memory:' });
        assert.equal(after.master_data_gaps.pending, 0);
        assert.equal(after.master_data_gaps.resolved, 1);
      } finally {
        ledger.close();
      }
    });

    it('CLI doctor 子命令把待补录清单打出来（耗材管理岗能直接看到）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'msb-units-doctor-'));
      const path = join(dir, 'ledger.db');
      try {
        const ledger = openLedger(path);
        seed(ledger, MATERIAL_NO_RATIO_CSV);
        ledger.close();

        const out = execFileSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'doctor', '--db', path], {
          encoding: 'utf8',
          env: { ...process.env },
        });
        assert.match(out, /耗材主数据待补录/);
        assert.match(out, /MAT-UNIT-NORATIO/);
        assert.match(out, /UNIT_RATIO_MISSING/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
