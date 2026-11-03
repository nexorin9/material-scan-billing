/**
 * test_masterdata_live：主数据热更新 —— **导入即生效 · 不重启不中断**。
 *
 * 覆盖：
 *   ① 主数据改完**无需重启**：下一次判定立即按新值命中（价码改了、台次关了、耗材停了）；
 *   ② 停用耗材不再被绑定（active=false 立即生效，生成核查条目）；
 *   ③ 关台即时生效：关闭台次后到达的扫码判 CLOSED 并生成核查条目；
 *   ④ 版本号随每次导入递增，doctor 与运行摘要都可见；
 *   ⑤ 增量导入是 upsert + 失效标记，**不物理删除历史行**，导入前后行数对得上；
 *   ⑥ 逐条跳过原因进履历 / 运行摘要 / doctor；
 *   ⑦ 主数据变更写审计链（操作类型 / 影响行数 / 版本号 / 时间），哈希链仍完整；
 *   ⑧ 导入失败**不递增版本号**（事务回滚，主数据仍是上一版）；
 *   ⑨ 热更新观察器：文件一变就重导（不重启），文件读不到时不删数据。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLedger } from '../src/ledger/db.js';
import { importMasterDataVersioned } from '../src/ledger/import-master-data.js';
import {
  currentMasterDataVersion,
  listMasterDataImports,
  masterDataState,
} from '../src/ledger/master-data-version.js';
import { createMasterDataWatcher } from '../src/ledger/master-data-watcher.js';
import { bindOne } from '../src/engine/binding.js';
import { concludeAndRecord } from '../src/engine/conclude.js';
import { countCheckTasks } from '../src/check/task.js';
import { countAuditByType, queryAuditByType, verifyChain } from '../src/ledger/audit.js';
import { collectRunSummary } from '../src/log/summary.js';
import { runDoctor } from '../src/cli/commands.js';

/* ── 主数据样例（判定引擎专用，与其他测试的 fixture 相互独立） ── */

const OP_OPEN = 'OP-LIVE-001';
const OP_SECOND = 'OP-LIVE-002';

const OPERATIONS_HEADER = 'operation_no,room_no,dept_code,status,closed_at';
const MATERIALS_HEADER =
  'material_code,name,price_code,fee_category,medical_insurance_class,active,batch_no,unit_pack,unit_min,charge_unit,ratio';

const OPERATIONS_V1 = [
  OPERATIONS_HEADER,
  `${OP_OPEN},OR-01,SURG-01,open,`,
  `${OP_SECOND},OR-02,SURG-01,open,`,
  '',
].join('\n');

/** v1：三条耗材全部启用 */
const MATERIALS_V1 = [
  MATERIALS_HEADER,
  'MAT-LIVE-01,样例高值耗材甲,PR-LIVE-01,卫生材料,甲类,true,LOT-LIVE-A,包,支,支,1',
  'MAT-LIVE-02,样例高值耗材乙,PR-LIVE-02,卫生材料,乙类,true,LOT-LIVE-B,包,片,片,1',
  'MAT-LIVE-03,样例高值耗材丙,PR-LIVE-03,卫生材料,甲类,true,LOT-LIVE-C,套,套,套,1',
  '',
].join('\n');

/** v2：甲改价码、乙停用、丙改价码 */
const MATERIALS_V2 = [
  MATERIALS_HEADER,
  'MAT-LIVE-01,样例高值耗材甲,PR-LIVE-01-NEW,卫生材料,甲类,true,LOT-LIVE-A,包,支,支,1',
  'MAT-LIVE-02,样例高值耗材乙,PR-LIVE-02,卫生材料,乙类,false,LOT-LIVE-B,包,片,片,1',
  'MAT-LIVE-03,样例高值耗材丙,PR-LIVE-03-NEW,卫生材料,甲类,true,LOT-LIVE-C,套,套,套,1',
  '',
].join('\n');

/** v3：把甲号台次关掉 */
const OPERATIONS_V3 = [
  OPERATIONS_HEADER,
  `${OP_OPEN},OR-01,SURG-01,closed,2026-11-03T10:00:00+08:00`,
  `${OP_SECOND},OR-02,SURG-01,open,`,
  '',
].join('\n');

/**
 * 台次自己的手术间。
 *
 * 归属双因子核对要核「事件说的手术间」与「排台说的手术间」——
 * 两者必须一致，所以事件侧要按台次取手术间，不能一律写死 OR-01。
 */
function roomOf(db: Parameters<typeof concludeAndRecord>[0], operation_no: string): string {
  const row = db
    .prepare('SELECT room_no FROM operation WHERE operation_no = ?')
    .get(operation_no) as { room_no: string } | undefined;
  return row?.room_no ?? 'OR-01';
}

/** 判一条（走完整判定主路，异常条目会升核查条目） */
function judge(db: Parameters<typeof concludeAndRecord>[0], material_code: string, operation_no: string) {
  return concludeAndRecord(db, {
    db,
    operation_no,
    room_no: roomOf(db, operation_no),
    scanner_id: 'SCAN-GUN-LIVE',
    material_code,
    quantity: 1,
  });
}

/** 绑一条（写台账行） */
function bind(db: Parameters<typeof bindOne>[0], material_code: string, operation_no: string) {
  return bindOne(db, {
    db,
    operation_no,
    room_no: roomOf(db, operation_no),
    scanner_id: 'SCAN-GUN-LIVE',
    material_code,
    raw_code: material_code,
    quantity: 1,
  });
}

/** 台账里某耗材某台次的价格码 */
function priceCodeOf(db: Parameters<typeof bindOne>[0], material_code: string, operation_no: string): string | null {
  const row = db
    .prepare('SELECT price_code FROM material_binding WHERE material_code = ? AND operation_no = ?')
    .get(material_code, operation_no) as { price_code: string | null } | undefined;
  return row?.price_code ?? null;
}

describe('test_masterdata_live · 主数据热更新（导入即生效 · 不重启不中断）', () => {
  it('① 主数据改完无需重启：下一次判定立即按新值命中（价码改动当场生效）', () => {
    const ledger = openLedger(':memory:');
    const first = importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V1 },
      { source: 'cli' },
    );
    assert.equal(first.version, 1);

    // v1 判定：绑得上，落台账的价码是当时的主数据
    const bound = bind(ledger.db, 'MAT-LIVE-01', OP_OPEN);
    assert.equal(bound.conclusion, 'BOUND');
    assert.equal(priceCodeOf(ledger.db, 'MAT-LIVE-01', OP_OPEN), 'PR-LIVE-01');

    // v2：价码改了（同一个进程、**没有重启**）
    const second = importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V2 },
      { source: 'cli' },
    );
    assert.equal(second.version, 2);

    // 下一次判定立刻按新值走 —— 不是旧快照
    // （用丙号耗材：甲号已绑在第一台次上，同一耗材跨台次会被判重复，不能拿来验价码）
    const boundAgain = bind(ledger.db, 'MAT-LIVE-03', OP_SECOND);
    assert.equal(boundAgain.conclusion, 'BOUND');
    assert.equal(
      priceCodeOf(ledger.db, 'MAT-LIVE-03', OP_SECOND),
      'PR-LIVE-03-NEW',
      '判定必须读当前主数据，不能读旧快照',
    );
    // 老台账行保持原样（历史不被改写）
    assert.equal(priceCodeOf(ledger.db, 'MAT-LIVE-01', OP_OPEN), 'PR-LIVE-01');

    ledger.close();
  });

  it('② 停用耗材不再被绑定：active=false 立即生效并生成核查条目', () => {
    const ledger = openLedger(':memory:');
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V1 },
      { source: 'cli' },
    );
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V2 },
      { source: 'cli' },
    );

    const result = judge(ledger.db, 'MAT-LIVE-02', OP_OPEN);
    assert.equal(result.conclusion, 'NOT_REGISTERED');
    assert.equal(result.reason_code, 'MATERIAL_INACTIVE');
    assert.equal(result.error_code, 'ERR_MATERIAL_INACTIVE');
    assert.ok(result.check_task_id, '停用耗材必须升成核查条目');
    assert.equal(result.needs_manual, true);

    // 不落台账（没绑上就不入账）
    const row = ledger.db
      .prepare('SELECT COUNT(*) AS n FROM material_binding WHERE material_code = ?')
      .get('MAT-LIVE-02') as { n: number };
    assert.equal(row.n, 0);

    ledger.close();
  });

  it('③ 关台即时生效：关闭台次后到达的扫码判 CLOSED 并生成核查条目', () => {
    const ledger = openLedger(':memory:');
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V1 },
      { source: 'cli' },
    );

    // 关台前：这一台还能绑
    const beforeClose = judge(ledger.db, 'MAT-LIVE-03', OP_OPEN);
    assert.equal(beforeClose.conclusion, 'BOUND');

    // 关台（不重启进程）
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V3, materialsCsv: MATERIALS_V1 },
      { source: 'cli' },
    );

    const afterClose = judge(ledger.db, 'MAT-LIVE-03', OP_OPEN);
    assert.equal(afterClose.conclusion, 'CLOSED');
    assert.equal(afterClose.reason_code, 'OPERATION_CLOSED');
    assert.equal(afterClose.error_code, 'ERR_OPERATION_CLOSED');
    assert.ok(afterClose.check_task_id, '关台后到达的扫码必须生成核查条目');
    assert.match(afterClose.message, /已关台/);

    // 核查条目带台次上下文，且**不自动补录**（没有新增台账行）
    const task = ledger.db
      .prepare('SELECT operation_no, room_no, conclusion, reason_code FROM check_task WHERE id = ?')
      .get(afterClose.check_task_id as number) as {
      operation_no: string;
      room_no: string;
      conclusion: string;
      reason_code: string;
    };
    assert.equal(task.operation_no, OP_OPEN);
    assert.equal(task.room_no, 'OR-01');
    assert.equal(task.conclusion, 'CLOSED');
    assert.equal(task.reason_code, 'OPERATION_CLOSED');

    const bound = ledger.db
      .prepare("SELECT COUNT(*) AS n FROM material_binding WHERE conclusion = 'BOUND'")
      .get() as { n: number };
    assert.equal(bound.n, 0, '关台后的扫码不得落台账（不自动补录）');

    ledger.close();
  });

  it('④ 版本号随每次导入递增，doctor 与运行摘要都可见', () => {
    const ledger = openLedger(':memory:');
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V1 },
      { source: 'cli' },
    );
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V2 },
      { source: 'cli' },
    );
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V3, materialsCsv: MATERIALS_V2 },
      { source: 'daemon_watch' },
    );

    assert.equal(currentMasterDataVersion(ledger.db), 3);
    const history = listMasterDataImports(ledger.db, 10);
    assert.equal(history.length, 3);
    assert.deepEqual(
      history.map((record) => record.version).sort((a, b) => a - b),
      [1, 2, 3],
    );
    assert.equal(history[0]?.source, 'daemon_watch', '最近的导入来源应可见');

    // doctor：当前版本 + 最近导入时间 + 导入前后行数
    const report = runDoctor(ledger.db, {}, { ledger_db_path: 'data/ledger.db' });
    assert.equal(report.master_data.version, 3);
    assert.ok(report.master_data.last_import_at, '最近导入时间应可见');
    assert.equal(report.master_data.last_import_source, 'daemon_watch');
    assert.equal(report.master_data.operations_rows, 2);
    assert.equal(report.master_data.materials_rows, 3);
    assert.equal(report.master_data.imports[0]?.version, 3);
    assert.equal(report.master_data.imports[0]?.operations.after, 2);
    assert.equal(report.master_data.imports[0]?.materials.after, 3);

    // 运行摘要：同一份数字（doctor 与 summary 不会自相矛盾）
    const summary = collectRunSummary(ledger.db);
    assert.equal(summary.master_data.version, 3);
    assert.equal(summary.master_data.operations_rows, 2);
    assert.equal(summary.master_data.materials_rows, 3);
    assert.ok(summary.master_data.last_import);
    assert.equal(summary.master_data.last_import?.operations.before, 2);
    assert.equal(summary.master_data.last_import?.materials.after, 3);

    ledger.close();
  });

  it('⑤ 增量导入是 upsert + 失效标记：不物理删除历史行，导入前后行数对得上', () => {
    const ledger = openLedger(':memory:');
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V1 },
      { source: 'cli' },
    );

    // 再导一次同样的文件：行数不变（upsert），更新计数增长
    const again = importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V1 },
      { source: 'cli' },
    );
    assert.equal(again.operations.inserted, 0);
    assert.equal(again.operations.updated, 2);
    assert.equal(again.operations.before, 2);
    assert.equal(again.operations.after, 2, '重复导入不得产生重复行');
    assert.equal(again.materials.after, 3);

    // 增量：加一个台次 → 镜像行数 +1
    const grown = importMasterDataVersioned(
      ledger.db,
      {
        operationsCsv: [
          OPERATIONS_HEADER,
          `${OP_OPEN},OR-01,SURG-01,open,`,
          `${OP_SECOND},OR-02,SURG-01,open,`,
          'OP-LIVE-003,OR-03,SURG-02,open,',
          '',
        ].join('\n'),
        materialsCsv: MATERIALS_V1,
      },
      { source: 'cli' },
    );
    assert.equal(grown.operations.inserted, 1);
    assert.equal(grown.operations.before, 2);
    assert.equal(grown.operations.after, 3);

    // 历史台账行一条都没少（失效标记不删行）
    const rows = ledger.db.prepare('SELECT COUNT(*) AS n FROM material_binding').get() as { n: number };
    assert.equal(rows.n, 0);

    ledger.close();
  });

  it('⑥ 逐条跳过原因进履历 / 运行摘要 / doctor（坏行不拖垮整份文件）', () => {
    const ledger = openLedger(':memory:');
    const result = importMasterDataVersioned(
      ledger.db,
      {
        operationsCsv: [OPERATIONS_HEADER, `${OP_OPEN},OR-01,SURG-01,open,`, ',OR-02,SURG-01,open,', ''].join(
          '\n',
        ),
        materialsCsv: [
          MATERIALS_HEADER,
          'MAT-LIVE-01,样例高值耗材甲,PR-LIVE-01,卫生材料,甲类,true,LOT-LIVE-A,包,支,支,1',
          'MAT-LIVE-BAD,样例耗材,,卫生材料,甲类,true,LOT-LIVE-Z,包,支,支,1',
          '',
        ].join('\n'),
      },
      { source: 'cli' },
    );

    assert.equal(result.skips.length, 2);
    assert.ok(result.skips.some((skip) => skip.reason.includes('台次号为空')));
    assert.ok(result.skips.some((skip) => skip.reason.includes('价码为空')));
    // 好行照常导入
    assert.equal(result.operations.inserted, 1);
    assert.equal(result.materials.inserted, 1);

    // 履历里留着跳过原因（含原始行号）
    const record = listMasterDataImports(ledger.db, 1)[0];
    assert.equal(record?.skips.length, 2);
    assert.ok((record?.skips[0]?.line ?? 0) > 0);

    // 运行摘要与 doctor 都带得出跳过原因
    const summary = collectRunSummary(ledger.db);
    assert.equal(summary.master_data.last_import?.skips.length, 2);
    const report = runDoctor(ledger.db, {}, {});
    assert.equal(report.master_data.imports[0]?.skips.length, 2);

    ledger.close();
  });

  it('⑦ 主数据变更写审计链（操作类型 / 影响行数 / 版本号 / 时间），哈希链仍完整', () => {
    const ledger = openLedger(':memory:');
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V1 },
      { source: 'cli' },
    );

    assert.equal(countAuditByType(ledger.db, 'master_data_imported'), 1);
    const rows = queryAuditByType(ledger.db, 'master_data_imported');
    const detail = JSON.parse(rows[0]?.detail ?? '{}') as {
      version?: number;
      source?: string;
      operations?: { inserted?: number; updated?: number; skipped?: number };
      materials?: { inserted?: number; updated?: number; skipped?: number };
    };
    assert.equal(detail.version, 1);
    assert.equal(detail.source, 'cli');
    assert.equal(detail.operations?.inserted, 2);
    assert.equal(detail.materials?.inserted, 3);
    assert.equal(rows[0]?.actor, 'master_data_import');
    assert.ok(rows[0]?.created_at);

    // 审计链哈希链仍然完整（主数据变更不破坏封印）
    const chain = verifyChain(ledger.db);
    assert.equal(chain.intact, true);

    ledger.close();
  });

  it('⑧ 导入失败不递增版本号：事务回滚，主数据仍是上一版', () => {
    const ledger = openLedger(':memory:');
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V1 },
      { source: 'cli' },
    );
    assert.equal(currentMasterDataVersion(ledger.db), 1);

    // 注入一次导入期失败
    ledger.db.exec(
      `CREATE TRIGGER trg_block_material BEFORE INSERT ON material
         BEGIN SELECT RAISE(ABORT, '模拟导入失败'); END;`,
    );
    assert.throws(
      () =>
        importMasterDataVersioned(
          ledger.db,
          { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V2 },
          { source: 'cli' },
        ),
      /模拟导入失败/,
    );

    // 版本号没有前移，主数据仍是上一版（乙还是启用的）
    assert.equal(currentMasterDataVersion(ledger.db), 1);
    const active = ledger.db
      .prepare('SELECT active FROM material WHERE material_code = ?')
      .get('MAT-LIVE-02') as { active: number };
    assert.equal(active.active, 1, '失败导入不得留下半写数据');
    assert.equal(countAuditByType(ledger.db, 'master_data_imported'), 1, '失败导入不留审计行');

    // 修好后重导：版本号接着走（1 → 2，不跳号）
    ledger.db.exec('DROP TRIGGER trg_block_material');
    const retry = importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V2 },
      { source: 'cli' },
    );
    assert.equal(retry.version, 2);

    ledger.close();
  });

  it('⑨ 热更新观察器：文件一变就重导（不重启），文件读不到时不删数据', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msb-live-'));
    const operationsPath = join(dir, 'operations.csv');
    const materialsPath = join(dir, 'materials.csv');
    writeFileSync(operationsPath, OPERATIONS_V1, 'utf8');
    writeFileSync(materialsPath, MATERIALS_V1, 'utf8');

    const ledger = openLedger(':memory:');
    const watcher = createMasterDataWatcher({
      db: ledger.db,
      operationsCsv: operationsPath,
      materialsCsv: materialsPath,
      source: 'daemon_watch',
    });
    assert.equal(watcher.enabled, true);

    // 文件没变 → 不导
    assert.equal(watcher.poll(), null);

    // 耗材主数据变了（停用乙）→ 自动重导
    writeFileSync(materialsPath, MATERIALS_V2, 'utf8');
    const reload = watcher.poll();
    assert.ok(reload, '文件变了应当触发一次热更新');
    assert.equal(reload?.reloaded, true);
    assert.equal(reload?.version, 1);
    assert.deepEqual(reload?.changed, ['materials']);

    // 重导后立刻按新值判（守护进程没重启）
    const result = judge(ledger.db, 'MAT-LIVE-02', OP_OPEN);
    assert.equal(result.conclusion, 'NOT_REGISTERED');
    assert.equal(result.reason_code, 'MATERIAL_INACTIVE');

    // 文件读不到时：不删数据、不推进版本
    rmSync(materialsPath);
    const missing = watcher.poll();
    assert.equal(missing?.reloaded, false);
    assert.equal(currentMasterDataVersion(ledger.db), 1, '读不到文件不得前移版本号');
    const rows = ledger.db.prepare('SELECT COUNT(*) AS n FROM material').get() as { n: number };
    assert.equal(rows.n, 3, '读不到文件不得删除已导入的主数据行');

    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('⑩ 判定引擎不缓存主数据快照：连改两次都按最新值判', () => {
    const ledger = openLedger(':memory:');
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V1 },
      { source: 'cli' },
    );

    // 第一次导入后停用丙
    importMasterDataVersioned(
      ledger.db,
      {
        operationsCsv: OPERATIONS_V1,
        materialsCsv: [
          MATERIALS_HEADER,
          'MAT-LIVE-01,样例高值耗材甲,PR-LIVE-01,卫生材料,甲类,true,LOT-LIVE-A,包,支,支,1',
          'MAT-LIVE-02,样例高值耗材乙,PR-LIVE-02,卫生材料,乙类,true,LOT-LIVE-B,包,片,片,1',
          'MAT-LIVE-03,样例高值耗材丙,PR-LIVE-03,卫生材料,甲类,false,LOT-LIVE-C,套,套,套,1',
          '',
        ].join('\n'),
      },
      { source: 'cli' },
    );
    assert.equal(judge(ledger.db, 'MAT-LIVE-03', OP_OPEN).reason_code, 'MATERIAL_INACTIVE');

    // 再启用丙（第二次改动）→ 立刻恢复可绑
    importMasterDataVersioned(
      ledger.db,
      { operationsCsv: OPERATIONS_V1, materialsCsv: MATERIALS_V1 },
      { source: 'cli' },
    );
    assert.equal(judge(ledger.db, 'MAT-LIVE-03', OP_OPEN).conclusion, 'BOUND');
    assert.equal(currentMasterDataVersion(ledger.db), 3);

    ledger.close();
  });
});
