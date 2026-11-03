/**
 * 主数据**热更新**观察器：文件一变就重导一次，**不重启常驻进程**。
 *
 * 为什么需要它：手术室里的耗材主数据与排台台次不是一次性导入就完事的 ——
 * 临时加一台手术要补排台台次、术中用了一支新耗材要补建档、某支耗材被停用要立刻拒绑。
 * 这些变更都发生在**守护进程正在跑**的时候。让它「改完要重启」是不现实的：
 * 重启窗口正好压在下一台手术上。
 *
 * 生效链路（三段，缺一不可）：
 *   ① **观察到变化** —— 按「修改时间 + 文件大小」给文件取指纹（不读全文，不猜内容）；
 *   ② **重导一次** —— 走的是与运维命令**同一条**导入路径（`importMasterDataVersioned`），
 *      版本号 +1、履历落库、审计链留一行；
 *   ③ **判定现读** —— 绑定引擎每次都现读镜像表（不缓存快照），
 *      所以导入一提交，下一次扫码立刻按新值判 —— **无需重启**。
 *
 * 口径：
 *   ① **文件被删不算变更** —— 网关正在写文件时可能短暂不可见，
 *      缺文件时跳过这一侧（**不删镜像里的历史行**），下个周期文件回来再导；
 *   ② **导入失败不吞** —— 失败时**不更新指纹**（下个周期重试），
 *      并把错误码 `ERR_MASTER_DATA_IMPORT_FAILED` 写进结构化日志；
 *   ③ **同一次变更只导一次** —— 指纹在导入成功后才推进，重复轮询不会重复导。
 */

import { readFileSync, statSync } from 'node:fs';

import type { DatabaseSync } from 'node:sqlite';

import { defaultLogger, type Logger } from '../log/logger.js';
import { decodeWithFallback, type EncodingStrategy } from '../charge/sanitize.js';
import {
  importMasterDataVersioned,
  type MasterDataImportOutcome,
  type MasterDataImportSource,
} from './import-master-data.js';

/** 主数据导入失败时用的错误码（登记在统一错误码表里） */
export const ERR_MASTER_DATA_IMPORT_FAILED = 'ERR_MASTER_DATA_IMPORT_FAILED';

/** 观察器输入 */
export interface MasterDataWatcherOptions {
  /** 台账连接 */
  db: DatabaseSync;
  /** 排台台次 CSV 路径（空串 = 不看这一侧） */
  operationsCsv: string;
  /** 耗材主数据 CSV 路径（空串 = 不看这一侧） */
  materialsCsv: string;
  /** 导入来源标识（写进履历与审计链） */
  source?: MasterDataImportSource;
  /**
   * 主数据 CSV 的编码策略（默认 auto：UTF-8 与 GBK 里择优）。
   *
   * 老系统导出的耗材主数据常是 GBK —— 这一项决定怎么解；
   * 解不出来时**保留原始字节并报错**，不做替换字符糊弄。
   */
  encoding?: EncodingStrategy;
  /** 结构化日志器 */
  logger?: Logger;
}

/** 一次热更新的结果 */
export interface MasterDataReloadOutcome {
  /** 是否真的重导了（false = 这一轮没有变化，或导入失败） */
  reloaded: boolean;
  /** 变化的两侧：operations（排台台次）/ materials（耗材主数据） */
  changed: Array<'operations' | 'materials'>;
  /** 本次导入后的主数据版本号 */
  version: number;
  /** 导入时刻 */
  imported_at: string;
  /** 导入结果明细（未导入时为 null） */
  import_result: MasterDataImportOutcome | null;
  /** 这一轮不可读的文件（缺文件 / 读失败）；这些侧本次没导 */
  unreadable: Array<'operations' | 'materials'>;
  /** 失败原因（导入失败时给一句话） */
  error: string | null;
  /** 失败时的错误码 */
  error_code: string | null;
}

/** 主数据观察器 */
export interface MasterDataWatcher {
  /** 是否配置了至少一侧的主数据文件 */
  readonly enabled: boolean;
  /** 当前文件指纹（两行：operations / materials） */
  fingerprint(): string;
  /** 轮询一次：文件变了就重导，没变返回 null */
  poll(): MasterDataReloadOutcome | null;
}

/** 一个文件的指纹：修改时间 + 大小（不读全文） */
function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

/** 读一个 CSV 的结果 */
interface CsvReadResult {
  /** 读到的文本（读不到 / 解不出时为 null） */
  text: string | null;
  /** 失败原因（读不到时为 null；解不出时给一句中文） */
  error: string | null;
  /** 失败错误码（读不到时为 null；解不出时为 ERR_CHARGE_ENCODING_UNDECODABLE） */
  error_code: string | null;
}

/**
 * 读一个 CSV（**按字节读，再按编码策略解**）。
 *
 * 老系统导出的主数据是 GBK、新系统是 UTF-8 —— 读的时候不先定编码，
 * 直接按 UTF-8 读会把中文读成乱码，而乱码进到判定里就成了「耗材未建档」，
 * 现场根本看不出是编码问题。所以这里按字节读、按策略解；
 * **解不出来就报错**（保留原始字节），不做替换字符糊弄。
 */
function readCsv(path: string, encoding: EncodingStrategy): CsvReadResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    // 读不到（文件被删 / 网关正在写）：不是编码问题，交给上层按「读不到」处置
    return { text: null, error: null, error_code: null };
  }
  const decoded = decodeWithFallback(new Uint8Array(bytes), { strategy: encoding });
  if (!decoded.ok) {
    return {
      text: null,
      error: decoded.message ?? '编码不可解码',
      error_code: decoded.error_code,
    };
  }
  return { text: decoded.text ?? '', error: null, error_code: null };
}

/**
 * 建一个主数据观察器。
 *
 * 未配置任何一侧文件时 `enabled=false` —— 调用方（守护进程）可以直接跳过轮询。
 */
export function createMasterDataWatcher(options: MasterDataWatcherOptions): MasterDataWatcher {
  const logger = options.logger ?? defaultLogger;
  const source = options.source ?? 'daemon_watch';
  const operationsPath = options.operationsCsv.trim();
  const materialsPath = options.materialsCsv.trim();

  // 初始指纹：第一次 poll 只做「与启动时对比」，避免启动瞬间把同一份文件重导一遍
  let lastOperationsSig = fileSignature(operationsPath);
  let lastMaterialsSig = fileSignature(materialsPath);

  const fingerprint = (): string =>
    `${fileSignature(operationsPath)}|${fileSignature(materialsPath)}`;

  const poll = (): MasterDataReloadOutcome | null => {
    if (operationsPath.length === 0 && materialsPath.length === 0) return null;

    const operationsSig = fileSignature(operationsPath);
    const materialsSig = fileSignature(materialsPath);

    // 哪一侧变了（按修改时间 + 大小判定，不读全文）
    const changed: Array<'operations' | 'materials'> = [];
    if (operationsPath.length > 0 && operationsSig !== lastOperationsSig) changed.push('operations');
    if (materialsPath.length > 0 && materialsSig !== lastMaterialsSig) changed.push('materials');
    if (changed.length === 0) return null;

    const unreadable: Array<'operations' | 'materials'> = [];
    const encoding = options.encoding ?? 'auto';
    const operationsRead =
      operationsPath.length > 0
        ? readCsv(operationsPath, encoding)
        : { text: '', error: null, error_code: null };
    const materialsRead =
      materialsPath.length > 0
        ? readCsv(materialsPath, encoding)
        : { text: '', error: null, error_code: null };

    if (operationsPath.length > 0 && operationsRead.text === null) unreadable.push('operations');
    if (materialsPath.length > 0 && materialsRead.text === null) unreadable.push('materials');

    // 变了却读不到（文件被删 / 网关正在写）或解不出编码：这一轮**不动数据**，也不推进指纹 ——
    // 下一轮文件回来（或内容稳定）再导。绝不因为读不到就把已导入的主数据删掉。
    if (unreadable.length > 0) {
      // 解不出编码 ≠ 读不到：两者的错误码与提示语要分开，信息科才分得清
      const decodeErrorCode = operationsRead.error_code ?? materialsRead.error_code;
      const errorCode = decodeErrorCode ?? ERR_MASTER_DATA_IMPORT_FAILED;
      const errorText = decodeErrorCode
        ? `主数据文件编码不可解码（${operationsRead.error ?? materialsRead.error ?? ''}），本轮未导入，主数据仍是上一版`
        : '主数据文件读不到（可能是网关正在写或文件被移除），本轮未导入，主数据仍是上一版';
      logger.warn('主数据文件读不到或解不出编码，本轮跳过热更新（主数据仍是上一版）', {
        channel: 'runtime',
        error_code: errorCode,
        duration_ms: null,
        unreadable: unreadable.join(','),
      });
      return {
        reloaded: false,
        changed,
        version: 0,
        imported_at: new Date().toISOString(),
        import_result: null,
        unreadable,
        error: errorText,
        error_code: errorCode,
      };
    }

    try {
      const result = importMasterDataVersioned(
        options.db,
        { operationsCsv: operationsRead.text ?? '', materialsCsv: materialsRead.text ?? '' },
        { source },
      );
      // 导入成功才推进指纹 —— 失败会在下面被抛出，指纹不动，下个周期重试
      lastOperationsSig = operationsSig;
      lastMaterialsSig = materialsSig;
      logger.info('主数据已热更新（无需重启）', {
        channel: 'runtime',
        error_code: null,
        duration_ms: null,
        version: result.version,
        operations: result.operations.after,
        materials: result.materials.after,
        skipped: result.skips.length,
      });
      return {
        reloaded: true,
        changed,
        version: result.version,
        imported_at: result.imported_at,
        import_result: result,
        unreadable,
        error: null,
        error_code: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('主数据热更新失败，本轮未导入（版本号未前移）', {
        channel: 'runtime',
        error_code: ERR_MASTER_DATA_IMPORT_FAILED,
        duration_ms: null,
        error_message: message,
      });
      return {
        reloaded: false,
        changed: [],
        version: 0,
        imported_at: new Date().toISOString(),
        import_result: null,
        unreadable,
        error: message,
        error_code: ERR_MASTER_DATA_IMPORT_FAILED,
      };
    }
  };

  return {
    enabled: operationsPath.length > 0 || materialsPath.length > 0,
    fingerprint,
    poll,
  };
}
