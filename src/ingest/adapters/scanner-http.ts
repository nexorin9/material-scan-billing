/**
 * 扫码枪 HTTP 路适配器：把入站 HTTP 请求体解析成**统一批次信封**。
 *
 * 这一层是「两路共用解析层」的落点之一：扫码枪 HTTP 路与 RFID 目录投递路
 * 用的是**同一套字段契约**（`src/domain/scan-event.ts` 的 `validateScanItemContract`
 * → `src/api/contracts.ts` 的 `SCAN_ITEM_CONTRACT`）与**同一套码制归一**
 * （`src/ingest/normalize.ts`），谁都不另写一份字段规则。
 *
 * 语义来源（源产品主路径）：源产品在服务入口按前缀路由分派各路请求，
 * 且入站 webhook 凭据必填、验不过就不往下走（`services/bots/anthropic-status-bot/src/server.ts`）。
 * 本模块把这条语义改写成「HTTP 路的事件来源适配器」：验签在服务层做，
 * 本层只负责「已通过验签的请求体 → 统一批次信封」。
 *
 * 契约闸门分两级（与出站层同一套口径）：
 *   ① **抬头级**（台次号 / 手术间 / 扫码枪）—— 不合规就**整批拒**：
 *      没有台次号就没有归属，这批条目无处可落，只能退回给设备侧改；
 *   ② **明细级**（每条扫码）—— 不合规只拒**那一条**，同批其余照常入台账：
 *      一条坏数据不该拖累整台手术的计费（这是「分批独立结算」在入站侧的同一口径）。
 */

import {
  describeActual,
  SCAN_EVENT_ENVELOPE_CONTRACT,
  validateAgainst,
  type ContractViolation,
} from '../../api/contracts.js';
import { validateScanItemContract, REASON_INVALID_SCAN_ITEM } from '../../domain/scan-event.js';
import { normalizeScanItem } from '../normalize.js';
import { channelStatus, type EnvSnapshot } from '../../config/env.js';
import { newRequestId } from '../../ledger/event-log.js';
import {
  digestOf,
  type EventBatch,
  type EventBatchReject,
  type EventSource,
  type ParseOutcome,
  type SourcePayload,
} from './event-source.js';

/** 请求体不是合法 JSON */
export const ERR_MALFORMED_JSON = 'ERR_MALFORMED_JSON';
/** 扫码事件字段校验未通过 */
export const ERR_INVALID_SCAN_EVENT = 'ERR_INVALID_SCAN_EVENT';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 抬头级违规 → 老口径的 issues（字段 + 中文原因），供 400 响应体使用 */
function toIssues(violations: readonly ContractViolation[]): Array<{ field: string; reason: string }> {
  return violations.map((violation) => ({ field: violation.path, reason: violation.message_zh }));
}

/**
 * 解析扫码枪 HTTP 请求体 → 统一批次信封。
 *
 * 与目录投递路共用同一份字段契约与码制归一；只在这里做**整批**校验
 * （HTTP 是「一批一个请求」，抬头字段不合法就整批拒，响应 400 且不落台账）。
 */
export function parseHttpScanBody(
  rawBody: string,
  options: { requestId?: string | null } = {},
): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, code: ERR_MALFORMED_JSON, message: '请求体不是合法 JSON' };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      code: ERR_INVALID_SCAN_EVENT,
      message: '扫码事件字段校验未通过',
      issues: [{ field: 'body', reason: '请求体不是对象' }],
    };
  }

  // ① 抬头级契约校验：台次号 / 手术间 / 扫码枪 + scans 数组
  const envelopeViolations: ContractViolation[] = validateAgainst(
    SCAN_EVENT_ENVELOPE_CONTRACT,
    parsed,
  );
  const scans = parsed['scans'];
  if (!Array.isArray(scans)) {
    envelopeViolations.push({
      path: 'scans',
      field: 'scans',
      kind: 'type_mismatch',
      expected: '数组',
      actual: describeActual(scans),
      message_zh: '字段 scans 类型不对，应为数组',
    });
  } else if (scans.length === 0) {
    envelopeViolations.push({
      path: 'scans',
      field: 'scans',
      kind: 'value_out_of_range',
      expected: '长度 ≥ 1',
      actual: describeActual(scans),
      message_zh: '字段 scans 为空批次',
    });
  }
  if (envelopeViolations.length > 0) {
    return {
      ok: false,
      code: ERR_INVALID_SCAN_EVENT,
      message: '扫码事件字段校验未通过',
      issues: toIssues(envelopeViolations),
    };
  }

  // ② 明细级契约校验：不合规的条目只落 rejected，同批其余照常处理
  const items: EventBatch['items'][number][] = [];
  const rejects: EventBatchReject[] = [];
  (scans as unknown[]).forEach((raw, index) => {
    const result = validateScanItemContract(raw);
    if (!result.ok || !result.value) {
      const rawCode = isPlainObject(raw) && typeof raw['material_code'] === 'string'
        ? raw['material_code']
        : null;
      rejects.push({
        material_code: rawCode,
        reason_code: REASON_INVALID_SCAN_ITEM,
        detail:
          `第 ${index + 1} 条字段契约校验未通过：` +
          result.violations.map((violation) => violation.message_zh).join('；'),
        line_no: index + 1,
      });
      return;
    }
    const normalized = normalizeScanItem(result.value);
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
  });

  const digest = digestOf(rawBody);
  // 一个 POST 就是设备侧的一批：投递标识同时就是这一批的批次号。
  // 调用方给了标识就沿用它的（HTTP 服务端已经生成了一个）——
  // 同一次投递在日志、事件日志、台账、审计链四边必须是**同一个**标识，
  // 否则按 request_id 回查时会对不上。
  const requestId = options.requestId ?? newRequestId();

  return {
    ok: true,
    batch: {
      source: 'scanner_http',
      operation_no: String(parsed['operation_no']).trim(),
      room_no: String(parsed['room_no']).trim(),
      scanner_id: String(parsed['scanner_id']).trim(),
      items,
      rejects,
      handle: `http:${digest}`,
      digest,
      request_id: requestId,
      batch_id: requestId,
      raw_body: rawBody,
      signature_verified: true,
    },
  };
}

export interface ScannerHttpSourceOptions {
  /** 环境变量快照（体检用；默认读进程环境） */
  env?: EnvSnapshot;
}

/**
 * 扫码枪 HTTP 路事件源。
 *
 * `parse` 走共享解析层；`ack` 是空操作 —— HTTP 是「推过来就处理」的路，
 * 没有「文件要不要归档」这一步（目录路才有）。
 */
export function createScannerHttpSource(options: ScannerHttpSourceOptions = {}): EventSource {
  const env = options.env ?? process.env;
  return {
    id: 'scanner_http',
    label: '扫码枪 HTTP 接入',
    isReady(): boolean {
      return channelStatus('inbound', env).ready;
    },
    parse(payload: SourcePayload): ParseOutcome {
      if (payload.kind !== 'http') {
        return {
          ok: false,
          code: 'ERR_UNSUPPORTED_PAYLOAD',
          message: '扫码枪 HTTP 路只接受 HTTP 请求体载荷',
        };
      }
      return parseHttpScanBody(payload.rawBody);
    },
    async ack(): Promise<void> {
      // HTTP 路没有归档动作：请求体处理完即结束。
    },
  };
}
