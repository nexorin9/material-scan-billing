/**
 * RFID 网关目录投递路适配器：网关把扫码批次写进 `scan-inbox/<台次号>/<批次号>.jsonl`，
 * 常驻进程扫目录取批次，逐行解析成统一批次信封，走**与扫码枪 HTTP 路完全相同**的
 * 归一层、幂等键与结算层 —— 只换「事件从哪来」这一段，不另起一条代码路径。
 *
 * 目录约定：
 *   scan-inbox/<operation_no>/<batch>.jsonl     每行一条扫码（JSON 对象）
 *   scan-inbox/<operation_no>/<batch>.meta.json  批次元信息（可选）：{"room_no","scanner_id"}
 *   scan-inbox/processed/<operation_no>/<batch>.jsonl   已处理归档（不再重复处理）
 *
 * 坏行处理：一行坏数据（非法 JSON / 缺字段 / 手术间对不上）**只让这一行**落 rejected，
 * 同文件其余行照常入台账；坏行进审计链，不静默丢弃。
 *
 * 语义来源（源产品主路径）：源产品在服务入口按前缀路由分派各路请求
 * （`services/lexical-service/src/server.ts` 的 `GATEWAY_PREFIX`），
 * 缺任一必需凭据位即拒绝启动（`requiredVars` 缺失即 `process.exit(1)`）。
 * 本模块把这条语义改写成「目录投递这一路来源」：投递目录不可读时该路不可用，
 * 但不影响扫码枪 HTTP 路；两路各自体检、各自启停。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { validateScanItemContract, REASON_INVALID_SCAN_ITEM } from '../../domain/scan-event.js';
import { normalizeScanItem } from '../normalize.js';
import { newRequestId } from '../../ledger/event-log.js';
import {
  digestOf,
  type BatchMeta,
  type EventBatch,
  type EventBatchReject,
  type EventSource,
  type ParseOutcome,
  type SourcePayload,
} from './event-source.js';

/** 投递文件后缀 */
export const BATCH_FILE_SUFFIX = '.jsonl';
/** 批次元信息文件后缀 */
export const META_FILE_SUFFIX = '.meta.json';
/** 已处理归档目录名（放在投递根下，扫目录时跳过） */
export const PROCESSED_DIR_NAME = 'processed';

/** 单个投递文件的大小上限（字节）：防止异常文件把内存吃满 */
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 坏行原因码 */
export const REASON_MALFORMED_JSON_LINE = 'MALFORMED_JSON_LINE';
/** 明细字段不合规的原因码（与扫码枪 HTTP 路共用同一份定义） */
export { REASON_INVALID_SCAN_ITEM } from '../../domain/scan-event.js';
export const REASON_ROOM_NO_MISSING = 'ROOM_NO_MISSING';
export const REASON_SCANNER_ID_MISSING = 'SCANNER_ID_MISSING';
export const REASON_ROOM_MISMATCH = 'ROOM_MISMATCH';
export const REASON_SCANNER_MISMATCH = 'SCANNER_MISMATCH';

export interface RfidDirOptions {
  /** 投递根目录（默认 `scan-inbox`） */
  inboxDir: string;
  /** 已处理归档目录名（默认 `processed`） */
  processedDirName?: string;
  /** 单文件大小上限 */
  maxFileBytes?: number;
  /** 解析失败的回调（文件级错误：读不到 / 太大 / 台次号为空） */
  onError?: (error: { filePath: string; code: string; message: string }) => void;
}

/** 目录投递路事件源（在 EventSource 之外多两个目录专用方法） */
export interface RfidDirSource extends EventSource {
  readonly inboxDir: string;
  readonly processedDir: string;
  /** 扫一遍投递目录，返回待处理批次 */
  poll(): Promise<EventBatch[]>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** 读批次元信息旁挂文件（`<batch>.meta.json`）；没有或读不了就当没有 */
function readMetaFile(metaPath: string): BatchMeta | null {
  try {
    const raw = readFileSync(metaPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    return {
      room_no: trimmedString(parsed['room_no']),
      scanner_id: trimmedString(parsed['scanner_id']),
    };
  } catch {
    return null;
  }
}

/**
 * 解析一个投递文件 → 统一批次信封。
 *
 * 两遍处理：先把每行读成对象（读不动的直接判坏行），再定批次级的
 * 手术间 / 扫码枪（旁挂元信息优先，其次第一条带得上的行），最后逐行做字段校验。
 * 这样「同批里混了别的手术间的码」会被逐条判出来，而不是被静默归到同一台次。
 */
export function parseRfidBatchFile(payload: {
  operation_no: string;
  filePath: string;
  content: string;
  meta?: BatchMeta | null;
}): ParseOutcome {
  const { operation_no, filePath, content } = payload;
  const meta = payload.meta ?? null;

  if (!operation_no.trim()) {
    return {
      ok: false,
      code: 'ERR_RFID_OPERATION_UNKNOWN',
      message: `投递目录名不是台次号，无法归属批次：${filePath}`,
    };
  }

  const lines = content.split(/\r?\n/);
  const parsedLines: Array<{ line_no: number; raw: Record<string, unknown> | null; error: string | null }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNo = index + 1;
    const trimmed = line.trim();
    if (!trimmed) continue; // 空行不算坏行
    try {
      const value: unknown = JSON.parse(trimmed);
      if (!isPlainObject(value)) {
        parsedLines.push({ line_no: lineNo, raw: null, error: '这一行不是 JSON 对象' });
        continue;
      }
      parsedLines.push({ line_no: lineNo, raw: value, error: null });
    } catch {
      parsedLines.push({ line_no: lineNo, raw: null, error: '这一行不是合法 JSON' });
    }
  }

  // 批次级上下文：旁挂元信息优先，其次第一条带得上的行
  let batchRoomNo = trimmedString(meta?.room_no);
  let batchScannerId = trimmedString(meta?.scanner_id);
  if (!batchRoomNo || !batchScannerId) {
    for (const entry of parsedLines) {
      if (!entry.raw) continue;
      if (!batchRoomNo) batchRoomNo = trimmedString(entry.raw['room_no']);
      if (!batchScannerId) batchScannerId = trimmedString(entry.raw['scanner_id']);
      if (batchRoomNo && batchScannerId) break;
    }
  }

  const items: EventBatch['items'][number][] = [];
  const rejects: EventBatchReject[] = [];

  for (const entry of parsedLines) {
    if (!entry.raw) {
      rejects.push({
        material_code: null,
        reason_code: REASON_MALFORMED_JSON_LINE,
        detail: `第 ${entry.line_no} 行${entry.error ?? '解析失败'}`,
        line_no: entry.line_no,
      });
      continue;
    }

    const raw = entry.raw;
    const materialCode = trimmedString(raw['material_code']);
    const lineRoomNo = trimmedString(raw['room_no']);
    const lineScannerId = trimmedString(raw['scanner_id']);

    if (!batchRoomNo) {
      rejects.push({
        material_code: materialCode,
        reason_code: REASON_ROOM_NO_MISSING,
        detail: `第 ${entry.line_no} 行没有手术间号，批次元信息里也没有，无法归属到手术间`,
        line_no: entry.line_no,
      });
      continue;
    }
    if (!batchScannerId) {
      rejects.push({
        material_code: materialCode,
        reason_code: REASON_SCANNER_ID_MISSING,
        detail: `第 ${entry.line_no} 行没有扫码枪编号，批次元信息里也没有，无法追溯是谁扫的`,
        line_no: entry.line_no,
      });
      continue;
    }
    // 同批混了别的手术间 / 别的扫码枪：一律拒这一行，不静默归到本台次
    if (lineRoomNo && lineRoomNo !== batchRoomNo) {
      rejects.push({
        material_code: materialCode,
        reason_code: REASON_ROOM_MISMATCH,
        detail: `第 ${entry.line_no} 行手术间 ${lineRoomNo} 与批次手术间 ${batchRoomNo} 不一致`,
        line_no: entry.line_no,
      });
      continue;
    }
    if (lineScannerId && lineScannerId !== batchScannerId) {
      rejects.push({
        material_code: materialCode,
        reason_code: REASON_SCANNER_MISMATCH,
        detail: `第 ${entry.line_no} 行扫码枪 ${lineScannerId} 与批次扫码枪 ${batchScannerId} 不一致`,
        line_no: entry.line_no,
      });
      continue;
    }

    // 字段契约校验：与扫码枪 HTTP 路共用同一份契约（`SCAN_ITEM_CONTRACT`）——
    // 违规项带字段名 + 期望 + 实际，可直接贴给网关厂商看
    const validation = validateScanItemContract(raw);
    if (!validation.ok || !validation.value) {
      rejects.push({
        material_code: materialCode,
        reason_code: REASON_INVALID_SCAN_ITEM,
        detail: `第 ${entry.line_no} 行字段契约校验未通过：${validation.violations
          .map((violation) => `${violation.path} ${violation.message_zh}`)
          .join('；')}`,
        line_no: entry.line_no,
      });
      continue;
    }

    // 码制归一：与 HTTP 路共用同一份归一规则（UDI / GS1 / 院内码 → 规范耗材码）
    const normalized = normalizeScanItem(validation.value);
    items.push({
      material_code: normalized.material_code,
      raw_code: normalized.raw_code,
      quantity: normalized.quantity,
      batch_no: normalized.batch_no,
      code_form: normalized.code_form,
      code_parse_trace: normalized.parse_trace ? JSON.stringify(normalized.parse_trace) : null,
      // 业务使用时间：月度对账按业务月切账期用它
      use_time: normalized.scan_time,
    });
  }

  return {
    ok: true,
    batch: {
      source: 'rfid_dir',
      operation_no: operation_no.trim(),
      room_no: batchRoomNo ?? '',
      scanner_id: batchScannerId ?? '',
      items,
      rejects,
      handle: filePath,
      digest: digestOf(content),
      request_id: newRequestId(),
      // 目录投递路的批次号就是设备侧给的批次文件名（去掉 .jsonl 后缀）
      batch_id: basename(filePath, BATCH_FILE_SUFFIX),
      raw_body: content,
      signature_verified: false,
    },
  };
}

/**
 * 创建目录投递路事件源。
 *
 * `poll()` 扫一遍投递目录（跳过归档目录与已处理文件），把每个投递文件解析成批次；
 * `ack()` 把处理完的文件移进 `processed/`（已处理文件不再重复处理）。
 */
export function createRfidDirSource(options: RfidDirOptions): RfidDirSource {
  const inboxDir = resolve(options.inboxDir);
  const processedDirName = options.processedDirName ?? PROCESSED_DIR_NAME;
  const processedDir = join(inboxDir, processedDirName);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const onError = options.onError;

  // 进程内记住处理过的文件：归档动作失败时也不会在本次运行里重复处理
  const handledFiles = new Set<string>();

  const reportError = (filePath: string, code: string, message: string): void => {
    onError?.({ filePath, code, message });
  };

  const source: RfidDirSource = {
    id: 'rfid_dir',
    label: 'RFID 网关目录投递',
    inboxDir,
    processedDir,

    isReady(): boolean {
      try {
        return existsSync(inboxDir) && statSync(inboxDir).isDirectory();
      } catch {
        return false;
      }
    },

    parse(payload: SourcePayload): ParseOutcome {
      if (payload.kind !== 'file') {
        return {
          ok: false,
          code: 'ERR_UNSUPPORTED_PAYLOAD',
          message: '目录投递路只接受投递文件载荷',
        };
      }
      return parseRfidBatchFile({
        operation_no: payload.operation_no,
        filePath: payload.filePath,
        content: payload.content,
        meta: payload.meta ?? null,
      });
    },

    async poll(): Promise<EventBatch[]> {
      const batches: EventBatch[] = [];
      if (!source.isReady()) return batches;

      let operationDirs: string[] = [];
      try {
        operationDirs = readdirSync(inboxDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== processedDirName)
          .map((entry) => entry.name);
      } catch {
        return batches;
      }

      for (const operationDir of operationDirs) {
        const dirPath = join(inboxDir, operationDir);
        let fileNames: string[] = [];
        try {
          fileNames = readdirSync(dirPath)
            .filter((name) => name.endsWith(BATCH_FILE_SUFFIX))
            .sort();
        } catch {
          continue;
        }

        for (const fileName of fileNames) {
          const filePath = join(dirPath, fileName);
          if (handledFiles.has(filePath)) continue;

          let content: string;
          try {
            const stat = statSync(filePath);
            if (stat.size > maxFileBytes) {
              reportError(filePath, 'ERR_RFID_FILE_TOO_LARGE', `投递文件超过 ${maxFileBytes} 字节上限`);
              continue;
            }
            content = readFileSync(filePath, 'utf8');
          } catch (error) {
            reportError(
              filePath,
              'ERR_RFID_FILE_UNREADABLE',
              error instanceof Error ? error.message : String(error),
            );
            continue;
          }

          const batchName = basename(fileName, BATCH_FILE_SUFFIX);
          const meta = readMetaFile(join(dirPath, `${batchName}${META_FILE_SUFFIX}`));
          const outcome = source.parse({ kind: 'file', operation_no: operationDir, filePath, content, meta });
          if (!outcome.ok) {
            reportError(filePath, outcome.code, outcome.message);
            continue;
          }
          batches.push(outcome.batch);
        }
      }

      return batches;
    },

    async ack(batch: EventBatch): Promise<void> {
      const source_path = batch.handle;
      handledFiles.add(source_path);

      const targetPath = join(processedDir, batch.operation_no, basename(source_path));
      mkdirSync(dirname(targetPath), { recursive: true });
      try {
        renameSync(source_path, targetPath);
      } catch {
        // 跨设备等情况下改名失败：退化成复制后删原文件
        copyFileSync(source_path, targetPath);
        unlinkSync(source_path);
      }
    },
  };

  return source;
}
