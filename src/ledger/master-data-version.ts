/**
 * 主数据**版本号**与导入履历（`master_data_import` 表）。
 *
 * 背景：耗材主数据与手术排台**天天在变** —— 新耗材建档、耗材停用、临时加台、提前关台。
 * 本项目的主数据是**院内权威的本地镜像**（手术排台 / 院内耗材主数据），
 * 判定引擎每次绑定都**现读**当前值（不缓存快照），所以主数据改完下一次扫码立刻按新值判。
 *
 * 「导入即生效」必然带来一个问题：**现在台账里用的是哪一版主数据？**
 * 这一版就是**版本号**。它有三个用途：
 *   ① **可回溯** —— 「这台手术的耗材价码不对」时，能说出那是第几版主数据判的；
 *   ② **可对照** —— doctor 与运行摘要都报当前版本号与最近一次导入时间，
 *      避免出现「医生说改了、程序说没改」各说各话；
 *   ③ **可审计** —— 每次导入在只增不改的审计链里留一行（操作类型 / 影响行数 / 版本号 / 时间）。
 *
 * 口径：
 *   ① **只有成功的导入才 +1** —— 导入中途失败 → 事务回滚 → 版本号不前移（失败不静默改数据）；
 *   ② **upsert + 失效标记**，不物理删除历史行 —— 停用耗材是 `active=false`，
 *      关台是 `status=closed`，历史台账行一律保留；
 *   ③ **逐条跳过原因进 `detail`（JSON）** —— 坏行不拖垮整份文件，但原因要留下来；
 *   ④ **本表只增不改** —— 履历是历史事实，不提供 update / delete 接口。
 */

import type { DatabaseSync } from 'node:sqlite';

/** 一条主数据导入履历 */
export interface MasterDataImportRecord {
  /** 主数据版本号（每次成功导入 +1） */
  version: number;
  /** 导入时刻 */
  imported_at: string;
  /** 导入来源：cli（运维命令）/ daemon_watch（守护进程热更新）/ demo（演示脚本） */
  source: string;
  /** 台次表：文件里多少行 */
  operation_rows: number;
  operation_inserted: number;
  operation_updated: number;
  operation_skipped: number;
  /** 导入前的台次行数 */
  operations_before: number;
  /** 导入后的台次行数 */
  operations_after: number;
  /** 耗材表：文件里多少行 */
  material_rows: number;
  material_inserted: number;
  material_updated: number;
  material_skipped: number;
  /** 导入前的耗材行数 */
  materials_before: number;
  /** 导入后的耗材行数 */
  materials_after: number;
  /** 逐条跳过原因（坏行不拖垮整份文件，但原因要留下来） */
  skips: MasterDataImportSkip[];
}

/** 一条跳过原因 */
export interface MasterDataImportSkip {
  /** 哪张表：operation（排台台次）/ material（耗材主数据） */
  table: 'operation' | 'material';
  /** 原始文件行号 */
  line: number;
  /** 主键（台次号 / 耗材码），缺失时为空串 */
  key: string;
  /** 中文原因 */
  reason: string;
}

/** 主数据当前状态（doctor / 运行摘要用） */
export interface MasterDataState {
  /** 当前主数据版本号（从未导入过时为 0） */
  version: number;
  /** 最近一次导入时间 */
  last_import_at: string | null;
  /** 最近一次导入来源 */
  last_import_source: string | null;
  /** 当前台次镜像行数 */
  operations_rows: number;
  /** 当前耗材主数据镜像行数 */
  materials_rows: number;
  /** 最近一次导入的完整履历（没有则 null） */
  last_import: MasterDataImportRecord | null;
}

/** detail 列里存的 JSON 结构 */
interface ImportDetail {
  skips: MasterDataImportSkip[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 台次与耗材两张镜像表的当前行数 */
export function masterDataRowCounts(db: DatabaseSync): { operations: number; materials: number } {
  const operations = db.prepare('SELECT COUNT(*) AS n FROM operation').get() as { n: number };
  const materials = db.prepare('SELECT COUNT(*) AS n FROM material').get() as { n: number };
  return { operations: operations.n, materials: materials.n };
}

/** 当前主数据版本号（从未导入过时为 0） */
export function currentMasterDataVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM master_data_import').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

/**
 * 登记一次导入，返回**本次的版本号**。
 *
 * 版本号由表内最大值 +1 得出（不另设计数器，避免两处真源对不上）。
 * 唯一索引 `ux_master_data_import_version` 兜底：同一版本号写两次会直接被拒。
 */
export function recordMasterDataImport(
  db: DatabaseSync,
  record: Omit<MasterDataImportRecord, 'version' | 'imported_at'> & { imported_at?: string },
): number {
  const version = currentMasterDataVersion(db) + 1;
  const importedAt = record.imported_at ?? nowIso();
  const detail: ImportDetail = { skips: record.skips ?? [] };
  db.prepare(
    `INSERT INTO master_data_import
       (version, imported_at, source,
        operation_rows, operation_inserted, operation_updated, operation_skipped,
        operations_before, operations_after,
        material_rows, material_inserted, material_updated, material_skipped,
        materials_before, materials_after, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    version,
    importedAt,
    record.source,
    record.operation_rows,
    record.operation_inserted,
    record.operation_updated,
    record.operation_skipped,
    record.operations_before,
    record.operations_after,
    record.material_rows,
    record.material_inserted,
    record.material_updated,
    record.material_skipped,
    record.materials_before,
    record.materials_after,
    JSON.stringify(detail),
  );
  return version;
}

/** 把库里的一行还原成履历对象 */
function toRecord(row: Record<string, unknown>): MasterDataImportRecord {
  let skips: MasterDataImportSkip[] = [];
  const raw = row['detail'];
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as Partial<ImportDetail>;
      if (Array.isArray(parsed.skips)) skips = parsed.skips;
    } catch {
      // detail 坏了不该拖垮读履历：跳过原因读不出来就当没有（导入行本身还在）
      skips = [];
    }
  }
  const num = (key: string): number => Number(row[key] ?? 0);
  return {
    version: num('version'),
    imported_at: String(row['imported_at'] ?? ''),
    source: String(row['source'] ?? ''),
    operation_rows: num('operation_rows'),
    operation_inserted: num('operation_inserted'),
    operation_updated: num('operation_updated'),
    operation_skipped: num('operation_skipped'),
    operations_before: num('operations_before'),
    operations_after: num('operations_after'),
    material_rows: num('material_rows'),
    material_inserted: num('material_inserted'),
    material_updated: num('material_updated'),
    material_skipped: num('material_skipped'),
    materials_before: num('materials_before'),
    materials_after: num('materials_after'),
    skips,
  };
}

/** 列导入履历（按版本倒序，默认最近 10 次） */
export function listMasterDataImports(db: DatabaseSync, limit = 10): MasterDataImportRecord[] {
  const rows = db
    .prepare('SELECT * FROM master_data_import ORDER BY version DESC LIMIT ?')
    .all(limit) as unknown as Record<string, unknown>[];
  return rows.map(toRecord);
}

/** 最近一次导入的履历（没有则 null） */
export function latestMasterDataImport(db: DatabaseSync): MasterDataImportRecord | null {
  const row = db
    .prepare('SELECT * FROM master_data_import ORDER BY version DESC LIMIT 1')
    .get() as Record<string, unknown> | undefined;
  return row ? toRecord(row) : null;
}

/** 主数据当前状态（doctor / 运行摘要共用同一份实现） */
export function masterDataState(db: DatabaseSync): MasterDataState {
  const counts = masterDataRowCounts(db);
  const latest = latestMasterDataImport(db);
  return {
    version: currentMasterDataVersion(db),
    last_import_at: latest?.imported_at ?? null,
    last_import_source: latest?.source ?? null,
    operations_rows: counts.operations,
    materials_rows: counts.materials,
    last_import: latest,
  };
}
