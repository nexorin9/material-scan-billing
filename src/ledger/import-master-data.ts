/**
 * 院内主数据导入器：手术排台台次 + 耗材主数据 CSV → 本地镜像表。
 *
 * 这两张表是**院内主数据的本地镜像**（不是替身、不是 mock）：
 * 台次权威 = 手术排台，耗材权威 = 院内耗材主数据。判定引擎每次绑定都读这里的当前值，
 * 不缓存快照 —— 主数据改了下一次判定立刻按新值判（导入即生效、不重启）。
 *
 * 导入是「upsert + 逐条跳过原因」的：坏行不拖垮整份文件，跳过原因逐条报出来，
 * 供耗材管理岗与信息科核对。停用耗材用 active=false 标记，不物理删除历史行。
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  decodeWithFallback,
  type EncodingStrategy,
} from '../charge/sanitize.js';
import {
  checkFeeCategoryPolicy,
  FEE_CATEGORY_GAP_TYPES,
} from '../engine/fee-category.js';
import {
  evaluateUnitMapping,
  UNIT_GAP_TYPES,
  type UnitMapping,
} from '../engine/units.js';
import { appendAudit } from './audit.js';
import { withTransaction } from './db.js';
import {
  masterDataRowCounts,
  recordMasterDataImport,
  type MasterDataImportSkip,
} from './master-data-version.js';
import { recordMasterDataGap, resolveMasterDataGaps } from './master-data-gaps.js';

export interface CsvRow {
  /** 列名 → 取值 */
  [column: string]: string;
}

export interface CsvTable {
  header: string[];
  rows: CsvRow[];
  /** 每行在原始文本中的行号（1 基，含表头行），报错时能指到具体那一行 */
  lineNumbers: number[];
}

/** 解析 CSV（支持引号包裹、字段内逗号与转义双引号） */
export function parseCsv(text: string): CsvTable {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  const recordLines: number[] = [];

  const pushField = (): void => {
    record.push(field);
    field = '';
  };
  const pushRecord = (): void => {
    pushField();
    rows.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRecord();
      recordLines.push(line);
      line += 1;
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || record.length > 0) {
    pushRecord();
    recordLines.push(line);
  }

  const header = (rows.shift() ?? []).map((h) => h.trim());
  const tableRows: CsvRow[] = [];
  const lineNumbers: number[] = [];
  rows.forEach((cells, index) => {
    if (cells.length === 1 && (cells[0] ?? '').trim() === '') return;
    const row: CsvRow = {};
    header.forEach((name, col) => {
      row[name] = (cells[col] ?? '').trim();
    });
    tableRows.push(row);
    lineNumbers.push(recordLines[index + 1] ?? index + 2);
  });
  return { header, rows: tableRows, lineNumbers };
}

export interface ImportSkip {
  /** 原始 CSV 行号 */
  line: number;
  /** 主键（台次号 / 耗材码），缺失时为空串 */
  key: string;
  /** 中文跳过原因 */
  reason: string;
}

export interface ImportResult {
  table: 'operation' | 'material';
  /** 新增行数 */
  inserted: number;
  /** 覆盖更新行数 */
  updated: number;
  /** 跳过行数 */
  skipped: number;
  /** 文件里一共多少数据行 */
  total: number;
  skips: ImportSkip[];
  /**
   * 单位口径待补录条目（只有 material 表有）。
   *
   * 主数据里「包装单位 / 最小单位 / 计价单位 / 换算系数」不齐或不自洽的耗材，
   * **照常导入**（不替耗材管理岗删数据），但会登记到这里 —— 导入期就暴露，
   * 不留到运行期才炸。
   */
  unit_gaps: ImportUnitGap[];
  /**
   * 费用 / 医保口径待补录条目（只有 material 表有）。
   *
   * 费用类别不在院内 14 类允许集内、医保分类取值非法、费用类别与医保分类组合错配、
   * 或耗材落在了非材料类（药品类 / 诊疗床位类）—— 四种口径问题各有独立缺口类型，
   * **照常导入**，登记到待补录清单，由耗材管理岗修正主数据。
   */
  fee_gaps: ImportFeeGap[];
}

/** 一条待补录条目（单位口径与费用口径共用同一形状） */
export interface ImportUnitGap {
  /** 耗材码 */
  material_code: string;
  /** 缺口类型（与单位口径原因码同源） */
  gap_type: string;
  /** 中文说明 */
  detail: string;
}

/** 一条费用 / 医保口径待补录 */
export interface ImportFeeGap {
  /** 耗材码 */
  material_code: string;
  /** 缺口类型（费用口径原因码：FEE_CATEGORY_NOT_ALLOWED 等） */
  gap_type: string;
  /** 中文说明 */
  detail: string;
}

export interface MasterDataImportResult {
  operations: ImportResult;
  materials: ImportResult;
}

const OPERATION_STATUSES = new Set(['open', 'closed']);

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 解析换算系数列。
 *
 * 空值 → null（未登记）；非数值文本 → 也按 null 处理，但把原文带进待补录说明 ——
 * 主数据里写了「五支一包」这种中文，导入器**不猜**它等于 5，只登记待补录。
 */
function parseRatio(raw: string | undefined): { ratio: number | null; raw_text: string } {
  const text = (raw ?? '').trim();
  if (text.length === 0) return { ratio: null, raw_text: '' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ratio: null, raw_text: text };
  return { ratio: value, raw_text: text };
}

function parseBool(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', '是'].includes(v)) return true;
  if (['false', '0', 'no', 'n', '否'].includes(v)) return false;
  return null;
}

/** 导入手术排台台次 */
export function importOperations(db: DatabaseSync, csvText: string): ImportResult {
  const table = parseCsv(csvText);
  const result: ImportResult = {
    table: 'operation',
    inserted: 0,
    updated: 0,
    skipped: 0,
    total: table.rows.length,
    skips: [],
    unit_gaps: [],
    fee_gaps: [],
  };

  const exists = db.prepare('SELECT 1 AS hit FROM operation WHERE operation_no = ?');
  const upsert = db.prepare(
    `INSERT INTO operation (operation_no, room_no, dept_code, status, closed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(operation_no) DO UPDATE SET
       room_no = excluded.room_no,
       dept_code = excluded.dept_code,
       status = excluded.status,
       closed_at = excluded.closed_at,
       updated_at = excluded.updated_at`,
  );

  table.rows.forEach((row, index) => {
    const line = table.lineNumbers[index] ?? index + 2;
    const operation_no = row['operation_no'] ?? '';
    const room_no = row['room_no'] ?? '';
    const dept_code = row['dept_code'] ?? '';
    const status = (row['status'] ?? 'open').toLowerCase();
    const closed_at = row['closed_at'] ?? '';

    if (!operation_no) return skip(result, line, '', '台次号为空');
    if (!room_no) return skip(result, line, operation_no, '手术间号为空');
    if (!dept_code) return skip(result, line, operation_no, '科室编码为空');
    if (!OPERATION_STATUSES.has(status)) return skip(result, line, operation_no, `台次状态非法（${status || '空'}），只接受 open / closed`);

    const isUpdate = exists.get(operation_no) !== undefined;
    upsert.run(operation_no, room_no, dept_code, status, closed_at || null, nowIso());
    if (isUpdate) result.updated += 1;
    else result.inserted += 1;
    return undefined;
  });

  return result;
}

/**
 * 导入院内耗材主数据。
 *
 * 单位口径四列（`unit_pack` / `unit_min` / `charge_unit` / `ratio`）随行导入，
 * 并在导入期做**自洽性检查**：
 *   口径不齐或不自洽的耗材 → **照常导入**（主数据是院内权威，导入器不替耗材管理岗删行），
 *   但登记到**主数据待补录清单**（`master_data_gap`），由耗材管理岗补录；
 *   补录后再次导入且口径已自洽 → 该耗材的待补录条目自动销项。
 *
 * **费用口径**（`fee_category` / `medical_insurance_class`）同样在导入期检查：
 *   费用类别不在院内 14 类允许集内、医保分类取值非法、两者组合错配、
 *   或耗材落在了非材料类 —— 四种口径问题各有独立缺口类型，
 *   同样**照常导入 + 登记待补录**，由耗材管理岗修正主数据。
 *
 * 两类缺口**按类型分别销项**：补好了单位口径不会把还没修的费用口径那条一起销掉。
 */
export function importMaterials(db: DatabaseSync, csvText: string): ImportResult {
  const table = parseCsv(csvText);
  const result: ImportResult = {
    table: 'material',
    inserted: 0,
    updated: 0,
    skipped: 0,
    total: table.rows.length,
    skips: [],
    unit_gaps: [],
    fee_gaps: [],
  };

  const exists = db.prepare('SELECT 1 AS hit FROM material WHERE material_code = ?');
  const upsert = db.prepare(
    `INSERT INTO material (material_code, name, price_code, fee_category, medical_insurance_class, active, batch_no,
                           unit_pack, unit_min, charge_unit, ratio, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(material_code) DO UPDATE SET
       name = excluded.name,
       price_code = excluded.price_code,
       fee_category = excluded.fee_category,
       medical_insurance_class = excluded.medical_insurance_class,
       active = excluded.active,
       batch_no = excluded.batch_no,
       unit_pack = excluded.unit_pack,
       unit_min = excluded.unit_min,
       charge_unit = excluded.charge_unit,
       ratio = excluded.ratio,
       updated_at = excluded.updated_at`,
  );

  table.rows.forEach((row, index) => {
    const line = table.lineNumbers[index] ?? index + 2;
    const material_code = row['material_code'] ?? '';
    const name = row['name'] ?? '';
    const price_code = row['price_code'] ?? '';
    const fee_category = row['fee_category'] ?? '';
    const medical_insurance_class = row['medical_insurance_class'] ?? '';
    const batch_no = row['batch_no'] ?? '';
    const unit_pack = (row['unit_pack'] ?? '').trim();
    const unit_min = (row['unit_min'] ?? '').trim();
    const charge_unit = (row['charge_unit'] ?? '').trim();
    const { ratio, raw_text: ratioRaw } = parseRatio(row['ratio']);

    if (!material_code) return skip(result, line, '', '耗材码为空');
    if (!name) return skip(result, line, material_code, '耗材名称为空');
    if (!price_code) return skip(result, line, material_code, '价码为空');
    if (!fee_category) return skip(result, line, material_code, '费用类别为空');
    if (!medical_insurance_class) return skip(result, line, material_code, '医保分类为空');

    const activeRaw = row['active'] ?? '';
    const active = activeRaw === '' ? true : parseBool(activeRaw);
    if (active === null) return skip(result, line, material_code, `启用状态非法（${activeRaw}），只接受 true / false / 1 / 0`);

    const isUpdate = exists.get(material_code) !== undefined;
    upsert.run(
      material_code,
      name,
      price_code,
      fee_category,
      medical_insurance_class,
      active ? 1 : 0,
      batch_no || null,
      unit_pack || null,
      unit_min || null,
      charge_unit || null,
      ratio,
      nowIso(),
    );
    if (isUpdate) result.updated += 1;
    else result.inserted += 1;

    // 单位口径自洽性检查 → 待补录清单（导入期暴露，不留到运行期）
    const mapping: UnitMapping = {
      unit_pack: unit_pack || null,
      unit_min: unit_min || null,
      charge_unit: charge_unit || null,
      ratio,
    };
    const verdict = evaluateUnitMapping(mapping);
    if (!verdict.ok) {
      const detail =
        verdict.reason_code === 'UNIT_RATIO_MISSING' && ratioRaw.length > 0
          ? `${verdict.message}（ratio 列的值「${ratioRaw}」不是数值，已按未登记处理）`
          : (verdict.message ?? '单位口径不自洽');
      recordMasterDataGap(db, { material_code, gap_type: verdict.reason_code ?? 'UNIT_MAPPING_INCONSISTENT', detail });
      result.unit_gaps.push({
        material_code,
        gap_type: verdict.reason_code ?? 'UNIT_MAPPING_INCONSISTENT',
        detail,
      });
    } else {
      // 单位口径已自洽 → 该耗材**单位口径这一类**的待补录条目自动销项
      // （费用口径的缺口不受影响：两类问题各修各的）
      resolveMasterDataGaps(db, material_code, UNIT_GAP_TYPES);
    }

    // 费用类别 / 医保分类口径检查 → 待补录清单（导入期暴露，不留到运行期）
    //
    // 口径不合规的耗材**照常导入**（主数据是院内权威，导入器不替耗材管理岗改行），
    // 但要登记到待补录清单，并在运行期由绑定引擎拒掉（不按错口径计费）。
    const feeVerdict = checkFeeCategoryPolicy({
      fee_category,
      medical_insurance_class,
    });
    if (!feeVerdict.ok) {
      const gapType = feeVerdict.reason_code ?? 'FEE_CATEGORY_NOT_ALLOWED';
      const detail = feeVerdict.message ?? '费用 / 医保口径不合规';
      recordMasterDataGap(db, { material_code, gap_type: gapType, detail });
      result.fee_gaps.push({ material_code, gap_type: gapType, detail });
    } else {
      // 费用口径已合规 → 该耗材**费用口径这一类**的待补录条目自动销项
      resolveMasterDataGaps(db, material_code, FEE_CATEGORY_GAP_TYPES);
    }

    return undefined;
  });

  return result;
}

function skip(result: ImportResult, line: number, key: string, reason: string): undefined {
  result.skipped += 1;
  result.skips.push({ line, key, reason });
  return undefined;
}

/** 一次导入两份主数据 */
export function importMasterData(
  db: DatabaseSync,
  input: { operationsCsv: string; materialsCsv: string },
): MasterDataImportResult {
  return {
    operations: importOperations(db, input.operationsCsv),
    materials: importMaterials(db, input.materialsCsv),
  };
}

/* ── 字节读入 · 编码归一（老系统导出常是 GBK） ────────────────────────────── */

/** 主数据 CSV 的字节内容 */
export interface MasterDataBytes {
  /** 排台台次 CSV 的原始字节 */
  operations: Uint8Array;
  /** 耗材主数据 CSV 的原始字节 */
  materials: Uint8Array;
}

/** 字节解码结果（记录各自实际采用的编码，供事后核对） */
export interface MasterDataDecoded {
  /** 排台台次 CSV 文本 */
  operations: string;
  /** 耗材主数据 CSV 文本 */
  materials: string;
  /** 排台台次 CSV 实际采用的编码 */
  operations_encoding: string | null;
  /** 耗材主数据 CSV 实际采用的编码 */
  materials_encoding: string | null;
}

/**
 * 主数据编码解不出来时抛的异常（带错误码 + 原始字节）。
 *
 * 为什么不用替换字符糊过去：解不出来的字节一旦被拼成「看起来像文本」，
 * 就会以**乱码的耗材名 / 价码**进到判定与计费里 —— 那是错账，不是脏数据。
 * 保留原始字节 + 指名文件，人才能去问导出方「这份文件到底是什么编码」。
 */
export class MasterDataDecodeError extends Error {
  readonly code = 'ERR_CHARGE_ENCODING_UNDECODABLE';

  constructor(
    /** 哪一份文件（排台 / 耗材） */
    readonly which: 'operations' | 'materials',
    /** 中文说明 */
    readonly detail_zh: string,
    /** 原始字节（原样保留，便于人工核对） */
    readonly raw: Uint8Array,
  ) {
    super(`${which === 'operations' ? '排台台次' : '耗材主数据'} CSV 编码不可解码：${detail_zh}`);
    this.name = 'MasterDataDecodeError';
  }
}

/**
 * 把主数据 CSV 的字节解成文本（UTF-8 / GBK 择优）。
 *
 * 老系统（用友 / 金蝶一类的老 HIS）导出的耗材主数据多半是 GBK，
 * 新系统导出的多半是 UTF-8 —— 同一台机器上两份文件编码不一样是常态。
 * 解不出来就**抛错并保留原始字节**，不做替换字符糊弄。
 *
 * @param bytes 两份 CSV 的原始字节
 * @param options.strategy 编码策略（默认 auto：UTF-8 与 GBK 择优）
 */
export function decodeMasterDataBytes(
  bytes: MasterDataBytes,
  options: { strategy?: EncodingStrategy } = {},
): MasterDataDecoded {
  const operations = decodeWithFallback(bytes.operations, { strategy: options.strategy });
  if (!operations.ok) {
    throw new MasterDataDecodeError('operations', operations.message ?? '编码不可解码', operations.raw);
  }
  const materials = decodeWithFallback(bytes.materials, { strategy: options.strategy });
  if (!materials.ok) {
    throw new MasterDataDecodeError('materials', materials.message ?? '编码不可解码', materials.raw);
  }
  return {
    operations: operations.text ?? '',
    materials: materials.text ?? '',
    operations_encoding: operations.encoding,
    materials_encoding: materials.encoding,
  };
}

/**
 * 从**字节**导入两份主数据（编码自动归一）。
 *
 * 与 `importMasterData` 的差别只在读入方式：这里先按编码策略把字节解成文本，
 * 之后的解析、逐条跳过原因、缺口登记口径完全一致。
 */
export function importMasterDataFromBytes(
  db: DatabaseSync,
  bytes: MasterDataBytes,
  options: { strategy?: EncodingStrategy } = {},
): MasterDataImportResult & { encodings: { operations: string | null; materials: string | null } } {
  const decoded = decodeMasterDataBytes(bytes, options);
  const result = importMasterData(db, {
    operationsCsv: decoded.operations,
    materialsCsv: decoded.materials,
  });
  return {
    ...result,
    encodings: {
      operations: decoded.operations_encoding,
      materials: decoded.materials_encoding,
    },
  };
}

/* ── 带版本号的导入（导入即生效 · 可回溯） ─────────────────────────────── */

/** 一次带版本号的导入结果 */
export interface MasterDataImportOutcome {
  /** 本次导入后的主数据版本号（每次成功导入 +1） */
  version: number;
  /** 导入时刻 */
  imported_at: string;
  /** 导入来源：cli / daemon_watch / demo */
  source: string;
  /** 台次表导入结果（含导入前后行数） */
  operations: ImportResult & { before: number; after: number };
  /** 耗材表导入结果（含导入前后行数） */
  materials: ImportResult & { before: number; after: number };
  /** 逐条跳过原因（两张表合并，按文件行号） */
  skips: MasterDataImportSkip[];
}

/** 导入来源标识 */
export type MasterDataImportSource = 'cli' | 'daemon_watch' | 'demo' | string;

/**
 * **带版本号的增量导入**（导入即生效 · 不重启不中断）。
 *
 * 与 `importMasterData` 的差别有三点，都是为「天天在变的主数据」服务的：
 *   ① **upsert + 失效标记** —— 台次按 `operation_no`、耗材按 `material_code` 覆盖更新；
 *      耗材停用写 `active=false`、台次关台写 `status=closed`，**不物理删除历史行**
 *      （历史台账要能对账，删了就没法说「上个月用的是哪支耗材」）；
 *   ② **版本号 +1 并落履历** —— 导入前后行数、逐条跳过原因都进 `master_data_import`，
 *      doctor 与运行摘要都报当前版本与最近导入时间；
 *   ③ **整段一个事务** —— 中途失败 → 全部回滚 → **版本号不前移**（失败不静默改数据）。
 *
 * 「即时生效」靠的是判定引擎**每次现读**主数据（`src/engine/` 不缓存快照），
 * 本函数只负责把新值写进镜像表；导入一提交，下一次扫码立刻按新值判。
 */
export function importMasterDataVersioned(
  db: DatabaseSync,
  input: { operationsCsv: string; materialsCsv: string },
  options: { source?: MasterDataImportSource } = {},
): MasterDataImportOutcome {
  const source = options.source ?? 'cli';
  const before = masterDataRowCounts(db);

  const outcome = withTransaction(db, () => {
    const operations = importOperations(db, input.operationsCsv);
    const materials = importMaterials(db, input.materialsCsv);
    const after = masterDataRowCounts(db);

    const skips: MasterDataImportSkip[] = [
      ...operations.skips.map((item) => ({ ...item, table: 'operation' as const })),
      ...materials.skips.map((item) => ({ ...item, table: 'material' as const })),
    ];

    const importedAt = new Date().toISOString();
    const version = recordMasterDataImport(db, {
      imported_at: importedAt,
      source,
      operation_rows: operations.total,
      operation_inserted: operations.inserted,
      operation_updated: operations.updated,
      operation_skipped: operations.skipped,
      operations_before: before.operations,
      operations_after: after.operations,
      material_rows: materials.total,
      material_inserted: materials.inserted,
      material_updated: materials.updated,
      material_skipped: materials.skipped,
      materials_before: before.materials,
      materials_after: after.materials,
      skips,
    });

    // 审计链：主数据变更留一行（操作类型 / 影响行数 / 版本号 / 时间）——
    // 「这批耗材的价码是哪一版主数据判的」要能从审计链直接回答。
    appendAudit(db, {
      event_type: 'master_data_imported',
      actor: 'master_data_import',
      operation_no: null,
      scanner_id: null,
      detail: JSON.stringify({
        version,
        source,
        operations: {
          rows: operations.total,
          inserted: operations.inserted,
          updated: operations.updated,
          skipped: operations.skipped,
          before: before.operations,
          after: after.operations,
        },
        materials: {
          rows: materials.total,
          inserted: materials.inserted,
          updated: materials.updated,
          skipped: materials.skipped,
          before: before.materials,
          after: after.materials,
        },
      }),
    });

    return {
      version,
      imported_at: importedAt,
      source,
      operations: { ...operations, before: before.operations, after: after.operations },
      materials: { ...materials, before: before.materials, after: after.materials },
      skips,
    };
  });

  return outcome;
}
