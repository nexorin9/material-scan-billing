/**
 * 统一事件源接口：扫码枪 HTTP 与 RFID 网关目录投递两路共用同一套契约。
 *
 * 语义来源（源产品主路径）：源产品在一个服务入口用**前缀路由**把不同来源的请求
 * 分派到各自处理（`services/lexical-service/src/server.ts` 的 `GATEWAY_PREFIX`），
 * 且缺任一必需凭据位即拒绝启动（`requiredVars` 缺失即 `process.exit(1)`）。
 * 本模块把这条语义改写成**扫码事件的两条来源**：
 *
 *   - 两路来源产出**同一种批次信封** `EventBatch`（台次 + 手术间 + 扫码枪 + 归一后的耗材条目）；
 *   - 两路共用**同一份解析层**（`src/domain/scan-event.ts` 的字段校验 + `src/ingest/normalize.ts`
 *     的码制归一），不各写一套字段规则；
 *   - 两路共用**同一把幂等键**（`sha256(material_code|operation_no)`）与**同一个结算层**；
 *   - 差别只在「事件从哪来」与「处理完怎么确认」这两段，来源之间不复制业务逻辑。
 *
 * 换句话说：把「事件来源」抽成接口后，接入第三种设备只需要再写一个 `EventSource` 实现，
 * 绑定判定、计费回写、核查闭环、审计一视同仁。
 */

import { createHash } from 'node:crypto';

import type { ConclusionCode, FieldIssue } from '../../domain/scan-event.js';
import type { SettleItem } from '../../engine/settle.js';

/** 事件来源标识 */
export type EventSourceId = 'scanner_http' | 'rfid_dir';

/**
 * 解析层拒掉的条目（坏行）。
 *
 * 目录投递时一行坏数据（非法 JSON / 缺字段）只让**这一行**落 rejected，
 * 同文件其余行照常处理；坏行本身进审计链，供事后回看设备侧到底报了什么。
 */
export interface EventBatchReject {
  /** 耗材码（坏行可能连耗材码都没有，此时为 null） */
  material_code: string | null;
  /** 原因码（与结算层的原因码同一套命名，便于一起查） */
  reason_code: string;
  /** 中文说明（现场可读的排查依据） */
  detail: string;
  /** 文件内行号（从 1 起；HTTP 路没有文件概念，为 0） */
  line_no: number;
}

/** 统一批次信封：一路来源产出的一批扫码条目 */
export interface EventBatch {
  /** 来源标识 */
  source: EventSourceId;
  /** 台次号 */
  operation_no: string;
  /** 手术间 */
  room_no: string;
  /** 扫码枪 / 网关编号 */
  scanner_id: string;
  /** 归一后的可结算条目 */
  items: readonly SettleItem[];
  /** 解析层拒掉的条目 */
  rejects: readonly EventBatchReject[];
  /** 确认句柄：目录路 = 文件路径；HTTP 路 = 请求摘要 */
  handle: string;
  /** 载荷摘要（审计用） */
  digest: string;
  /** 本次投递的标识（事件日志用；两路各自生成，同一次投递内不变） */
  request_id?: string | null;
  /**
   * 批次号（**设备侧给的批次身份**，重放按批次选区间用）。
   *
   * - 扫码枪 HTTP 路 = 本次投递标识（一个 POST 就是一批）；
   * - RFID 目录投递路 = 投递文件名（设备侧给的批次号就是文件名）。
   *
   * 与 `request_id` 不是一回事：`request_id` 是本程序这次收件的回执号，
   * `batch_id` 是**设备侧那一批**的号 —— 同理，「这一批」在不同路都指设备侧的一批。
   */
  batch_id?: string | null;
  /** 原始报文（事件日志按原文保存；HTTP 路 = 请求体，目录路 = 文件内容） */
  raw_body?: string | null;
  /** 签名是否验过（目录投递没有签名，恒为 false） */
  signature_verified?: boolean;
}

/** 批次级元信息（RFID 网关侧写；HTTP 路来自请求体） */
export interface BatchMeta {
  /** 手术间 */
  room_no?: string | null;
  /** 扫码枪 / 网关编号 */
  scanner_id?: string | null;
}

/** 原始载荷：两路各一种形态 */
export type SourcePayload =
  | { kind: 'http'; rawBody: string }
  | {
      kind: 'file';
      /** 台次号（取自投递目录名 `scan-inbox/<operation_no>/`） */
      operation_no: string;
      /** 文件路径（确认时按它归档） */
      filePath: string;
      /** 文件内容（每行一条扫码） */
      content: string;
      /** 旁挂元信息文件（`<batch>.meta.json`） */
      meta?: BatchMeta | null;
    };

/** 解析结果 */
export type ParseOutcome =
  | { ok: true; batch: EventBatch }
  | { ok: false; code: string; message: string; issues?: FieldIssue[] };

/**
 * 统一事件源。
 *
 * 生命周期：`parse`（原始载荷 → 批次信封）→ 交给结算层逐条处理 → `ack`（确认处理完成）。
 */
export interface EventSource {
  /** 来源标识 */
  readonly id: EventSourceId;
  /** 中文业务标签（doctor / 日志展示用，不带工程黑话） */
  readonly label: string;
  /** 该路是否可用（凭据齐否 / 投递目录可读） */
  isReady(): boolean;
  /** 原始载荷 → 统一批次信封（两路共用同一套字段校验与码制归一） */
  parse(payload: SourcePayload): ParseOutcome;
  /** 批次处理完成后的确认动作（目录路：把文件移进 processed/；HTTP 路：空操作） */
  ack(batch: EventBatch): Promise<void>;
}

/** 载荷摘要：两路同一套算法，便于审计里对同一批内容做比对 */
export function digestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 批次级上下文（台次 / 手术间 / 扫码枪） */
export interface BatchContext {
  operation_no: string;
  room_no: string;
  scanner_id: string;
}

/** 结算层用得到的最小结论形状（解析层坏行也按同一形状汇报） */
export interface RouteConclusion {
  material_code: string | null;
  operation_no: string;
  bound: boolean;
  conclusion: ConclusionCode;
  reason_code: string;
  /** 统一错误码（ERR_*）：与日志、核查条目、回执行同一个码 */
  error_code: string | null;
  charge_state: string;
  detail?: string | null;
}
