/**
 * 各路通道的**最近一次成功 / 最近一次失败 / 最近一个错误码**。
 *
 * 为什么单独一个模块：doctor 要回答「这一路最近是在正常干活，还是在出问题」。
 * 只看「末次成功时间」不够 —— 一条路三个月前成功过一次、之后一直失败，
 * 光看成功时间会以为它还活着；只看「末次失败时间」也不够 —— 一条路刚失败过、
 * 之后又好了，那条失败记录已经不代表现状。所以三样一起给：
 *
 *   last_success_at  最近一次**正常处理完一件事**的时间
 *   last_failure_at  最近一次**出过事**的时间
 *   last_error_code  最近那次失败的原因码（与统一错误码表同源）
 *
 * 数字全部从台账读（SQL 聚合），不靠内存计数器 —— 进程重启后照样对得上，
 * doctor 跑在另一台机器上也照样对得上（台账库是共享的那一个）。
 *
 * 各路的「成功」与「失败」分别落在哪张表：
 *
 *   入站扫码  成功 = 事件日志里收到过批次；失败 = 落过痕的入站异常
 *             （核查条目里归属「入站 / 绑定」环节的，外加目录投递的坏行）
 *   出站计费  成功 = 回执里被对端收了；失败 = 回执行里带着错误码的那些
 *   企微推送  成功 = 推送台账里 status=sent；失败 = status=failed
 *
 * 硬约束：**只读** —— 这个模块一个字都不写台账。
 */

import type { DatabaseSync } from 'node:sqlite';

import { channelStatus, CHANNEL_LABELS, type Channel, type EnvSnapshot } from '../config/env.js';
import {
  errorCodeForReason,
  lookupErrorCode,
  type ErrorStage,
} from '../log/error-codes.js';

/** 一路通道的近况 */
export interface ChannelHealthRow {
  /** 通道标识 */
  channel: Channel;
  /** 中文业务标签 */
  label: string;
  /** 凭据位齐否 */
  credentials_ready: boolean;
  /** 缺哪些变量名（**只报名字，不报值**） */
  missing: string[];
  /** 最近一次成功处理的时间 */
  last_success_at: string | null;
  /** 最近一次失败的时间 */
  last_failure_at: string | null;
  /** 最近一次失败的错误码 */
  last_error_code: string | null;
  /** 错误码的中文含义 */
  last_error_code_zh: string;
  /** 一句人话：这一路现在看着怎么样 */
  note: string;
}

/** 一次失败：时间 + 错误码 */
interface FailurePoint {
  at: string | null;
  error_code: string | null;
}

/** 入站侧的失败归属环节（入站报文本身的问题 + 绑定判定的问题） */
const INBOUND_FAILURE_STAGES: readonly ErrorStage[] = ['inbound', 'binding'];

/** 查最近一次失败里落在指定环节的错误码 */
function latestFailureByStage(
  db: DatabaseSync,
  stages: readonly ErrorStage[],
  limit: number,
): FailurePoint {
  const rows = db
    .prepare(
      `SELECT error_code, reason_code, detected_at, created_at
         FROM check_task ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<{
    error_code: string | null;
    reason_code: string | null;
    detected_at: string | null;
    created_at: string;
  }>;

  for (const row of rows) {
    const code = row.error_code ?? errorCodeForReason(row.reason_code);
    if (!code) continue;
    const entry = lookupErrorCode(code);
    if (!entry) continue;
    if (!stages.includes(entry.stage)) continue;
    return { at: row.detected_at ?? row.created_at, error_code: code };
  }
  return { at: null, error_code: null };
}

/** 目录投递的坏行（入站侧的失败也要算进去） */
function latestBadLine(db: DatabaseSync): FailurePoint {
  const rows = db
    .prepare(
      `SELECT created_at, detail FROM audit_chain
        WHERE event_type = 'ingest_bad_line' ORDER BY id DESC LIMIT 20`,
    )
    .all() as unknown as Array<{ created_at: string; detail: string | null }>;

  for (const row of rows) {
    let reasonCode: string | null = null;
    try {
      const parsed = JSON.parse(row.detail ?? '{}') as { reason_code?: unknown };
      reasonCode = typeof parsed.reason_code === 'string' ? parsed.reason_code : null;
    } catch {
      reasonCode = null;
    }
    const code = errorCodeForReason(reasonCode);
    if (!code) continue;
    return { at: row.created_at, error_code: code };
  }
  return { at: null, error_code: null };
}

/** 取两个失败时间点里较晚的那个 */
function laterFailure(a: FailurePoint, b: FailurePoint): FailurePoint {
  if (a.at === null) return b;
  if (b.at === null) return a;
  return Date.parse(a.at) >= Date.parse(b.at) ? a : b;
}

/** 单值查询：取一列的最大值 */
function scalarMax(db: DatabaseSync, sql: string): string | null {
  const row = db.prepare(sql).get() as { value: string | null } | undefined;
  return row?.value ?? null;
}

/** 单行查询：取一行 */
function scalarRow(
  db: DatabaseSync,
  sql: string,
): { at: string | null; error_code: string | null } | null {
  const row = db.prepare(sql).get() as
    | { at: string | null; error_code: string | null }
    | undefined;
  return row ?? null;
}

/**
 * 三路近况一次算齐。
 *
 * 数字全部从台账读；凭据位从环境变量读（**只报齐否与变量名**）。
 */
export function runChannelHealth(
  db: DatabaseSync,
  env: EnvSnapshot = process.env,
): ChannelHealthRow[] {
  const inboundSuccess = scalarMax(db, 'SELECT MAX(received_at) AS value FROM scan_event');
  const inboundFailure = laterFailure(
    latestFailureByStage(db, INBOUND_FAILURE_STAGES, 200),
    latestBadLine(db),
  );

  const outboundSuccess = scalarMax(
    db,
    'SELECT MAX(responded_at) AS value FROM charge_receipt WHERE accepted = 1',
  );
  const outboundFailure = scalarRow(
    db,
    `SELECT created_at AS at, error_code FROM charge_receipt
      WHERE error_code IS NOT NULL ORDER BY id DESC LIMIT 1`,
  );

  const notifySuccess = scalarMax(
    db,
    "SELECT MAX(created_at) AS value FROM notify_delivery WHERE status = 'sent'",
  );
  const notifyFailure = scalarRow(
    db,
    `SELECT created_at AS at, error_code FROM notify_delivery
      WHERE status = 'failed' ORDER BY created_at DESC LIMIT 1`,
  );

  const build = (
    channel: Channel,
    success: string | null,
    failure: { at: string | null; error_code: string | null },
  ): ChannelHealthRow => {
    const status = channelStatus(channel, env);
    const code = failure.error_code;
    const meaning = code ? lookupErrorCode(code)?.meaning_zh ?? '' : '';
    const note = !status.ready
      ? `凭据位不齐（缺 ${status.missing.join('、')}），这一路现在没在干活`
      : failure.at !== null && (success === null || Date.parse(failure.at) > Date.parse(success))
        ? `最近一次出错：${failure.at}${code ? `（${code} ${meaning}）` : ''}`
        : success !== null
          ? failure.at !== null
            ? `最近一次正常处理：${success}（此前 ${failure.at} 出过错：${code ?? '原因码未登记'} ${meaning}）`
            : `最近一次正常处理：${success}`
          : '还没有这一路的业务记录';
    return {
      channel,
      label: CHANNEL_LABELS[channel],
      credentials_ready: status.ready,
      missing: [...status.missing],
      last_success_at: success,
      last_failure_at: failure.at,
      last_error_code: code,
      last_error_code_zh: meaning,
      note,
    };
  };

  return [
    build('inbound', inboundSuccess, inboundFailure),
    build('outbound', outboundSuccess, outboundFailure ?? { at: null, error_code: null }),
    build('notify', notifySuccess, notifyFailure ?? { at: null, error_code: null }),
  ];
}
