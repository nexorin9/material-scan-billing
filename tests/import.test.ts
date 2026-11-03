/**
 * test_import：院内主数据导入 + 台账 schema。
 *
 * 覆盖：CSV 解析 → operation / material 镜像表落库 → 逐条跳过原因 →
 * 重复导入为 upsert → 事务边界（中途失败不留半写）→ 七张表齐备。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEDGER_SCHEMA_VERSION, openLedger, schemaVersion } from '../src/ledger/db.js';
import { importMasterData, importMaterials, importOperations, parseCsv } from '../src/ledger/import-master-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

function newLedger() {
  return openLedger(':memory:');
}

describe('test_import · 主数据导入与台账 schema', () => {
  it('CSV 解析：表头 + 行号 + 引号内逗号', () => {
    const table = parseCsv(['a,b', '1,"x,y"', '2,z'].join('\n'));
    assert.deepEqual(table.header, ['a', 'b']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0]?.['b'], 'x,y');
    assert.deepEqual(table.lineNumbers, [2, 3]);
  });

  it('导入后 operation 3 条、material 6 条可查表命中', () => {
    const ledger = newLedger();
    const result = importMasterData(ledger.db, { operationsCsv, materialsCsv });

    assert.equal(result.operations.inserted, 3);
    assert.equal(result.operations.skipped, 0);
    assert.equal(result.materials.inserted, 6);
    assert.equal(result.materials.skipped, 0);

    const opCount = ledger.db.prepare('SELECT COUNT(*) AS n FROM operation').get() as { n: number };
    const matCount = ledger.db.prepare('SELECT COUNT(*) AS n FROM material').get() as { n: number };
    assert.equal(opCount.n, 3);
    assert.equal(matCount.n, 6);

    const row = ledger.db
      .prepare('SELECT operation_no, room_no, dept_code, status FROM operation WHERE operation_no = ?')
      .get('OP-SAMPLE-003') as { operation_no: string; room_no: string; dept_code: string; status: string };
    assert.equal(row.room_no, 'OR-03');
    assert.equal(row.dept_code, 'SURG-02');
    assert.equal(row.status, 'closed');

    ledger.close();
  });

  it('active=false 落库为 0；卫生材料与甲类口径在主数据里命中', () => {
    const ledger = newLedger();
    importMasterData(ledger.db, { operationsCsv, materialsCsv });

    const inactive = ledger.db
      .prepare('SELECT active FROM material WHERE material_code = ?')
      .get('MAT-SAMPLE-06') as { active: number };
    assert.equal(inactive.active, 0);

    const active = ledger.db
      .prepare('SELECT active FROM material WHERE material_code = ?')
      .get('MAT-SAMPLE-01') as { active: number };
    assert.equal(active.active, 1);

    const hygiene = ledger.db
      .prepare("SELECT COUNT(*) AS n FROM material WHERE fee_category = '卫生材料'")
      .get() as { n: number };
    assert.ok(hygiene.n >= 1, '耗材必须落在卫生材料口径内');

    const classA = ledger.db
      .prepare("SELECT COUNT(*) AS n FROM material WHERE medical_insurance_class = '甲类'")
      .get() as { n: number };
    assert.ok(classA.n >= 1, '医保分类必须覆盖甲类');

    ledger.close();
  });

  it('坏行被跳过并逐条报出原因，其余行照常导入', () => {
    const ledger = newLedger();
    const badCsv = [
      'operation_no,room_no,dept_code,status,closed_at',
      'OP-OK-1,OR-01,SURG-01,open,',
      ',OR-02,SURG-01,open,',
      'OP-BAD-STATUS,OR-03,SURG-01,paused,',
      'OP-NO-ROOM, ,SURG-01,open,',
    ].join('\n');

    const result = importOperations(ledger.db, badCsv);
    assert.equal(result.total, 4);
    assert.equal(result.inserted, 1);
    assert.equal(result.skipped, 3);
    assert.match(result.skips[0]?.reason ?? '', /台次号为空/);
    assert.match(result.skips[1]?.reason ?? '', /台次状态非法/);
    assert.match(result.skips[2]?.reason ?? '', /手术间号为空/);
    assert.ok((result.skips[0]?.line ?? 0) > 0, '跳过原因须指到原始行号');

    ledger.close();
  });

  it('耗材主数据坏行同样被跳过', () => {
    const ledger = newLedger();
    const badCsv = [
      'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no',
      'MAT-OK,样例耗材,PR-1,卫生材料,甲类,true,LOT-X',
      'MAT-NO-PRICE,样例耗材,,卫生材料,甲类,true,LOT-Y',
      'MAT-BAD-ACTIVE,样例耗材,PR-3,卫生材料,甲类,maybe,LOT-Z',
    ].join('\n');

    const result = importMaterials(ledger.db, badCsv);
    assert.equal(result.inserted, 1);
    assert.equal(result.skipped, 2);
    assert.match(result.skips[0]?.reason ?? '', /价码为空/);
    assert.match(result.skips[1]?.reason ?? '', /启用状态非法/);

    ledger.close();
  });

  it('重复导入是 upsert：行数不变，updated 计数增长', () => {
    const ledger = newLedger();
    importMasterData(ledger.db, { operationsCsv, materialsCsv });
    const second = importMasterData(ledger.db, { operationsCsv, materialsCsv });

    assert.equal(second.operations.inserted, 0);
    assert.equal(second.operations.updated, 3);
    assert.equal(second.materials.inserted, 0);
    assert.equal(second.materials.updated, 6);

    const opCount = ledger.db.prepare('SELECT COUNT(*) AS n FROM operation').get() as { n: number };
    assert.equal(opCount.n, 3);

    ledger.close();
  });

  it('事务边界：中途抛错不留半写', () => {
    const ledger = newLedger();
    assert.throws(() =>
      ledger.withTransaction(() => {
        ledger.db
          .prepare(
            'INSERT INTO material_binding (idempotency_key, operation_no, room_no, dept_code, material_code, quantity, conclusion, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          )
          .run('k1', 'OP-SAMPLE-001', 'OR-01', 'SURG-01', 'MAT-SAMPLE-01', 1, 'BOUND', 'bound', '2026-01-15T09:00:00Z', '2026-01-15T09:00:00Z');
        throw new Error('模拟中途失败');
      }),
    );

    const count = ledger.db.prepare('SELECT COUNT(*) AS n FROM material_binding').get() as { n: number };
    assert.equal(count.n, 0, '回滚后台账行数必须与失败前一致');

    ledger.close();
  });

  it('schema：七张表齐备且版本号已写入', () => {
    const ledger = newLedger();
    const tables = ledger.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    for (const expected of [
      'material_binding',
      'charge_receipt',
      'check_task',
      'audit_chain',
      'operation',
      'material',
      'idempotency_claim',
    ]) {
      assert.ok(names.includes(expected), `缺表 ${expected}`);
    }
    assert.equal(schemaVersion(ledger.db), LEDGER_SCHEMA_VERSION);

    ledger.close();
  });
});
