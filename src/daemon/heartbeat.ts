/**
 * 心跳：常驻进程每周期写一条自身状态，供 `doctor` 与容器 healthcheck 读取。
 *
 * 为什么要有心跳：手术室里没人盯着终端，进程「活着」这件事必须**可证**，
 * 而不是靠「重启计数没涨」这种间接推断。心跳记录回答六个问题：
 *
 *   ① 程序版本（跑的是哪一版）
 *   ② 运行时长（起来多久了）
 *   ③ 台账行数（这段时间处理了多少耗材）
 *   ④ 待核查条目数（有多少条等人工落定）
 *   ⑤ 末次收到事件的时间（多久没有新扫码了）
 *   ⑥ 三路凭据位齐否（哪一路断了）
 *
 * 心跳写进 `meta` 表（进程自身状态），**不写审计链** —— 审计链是只增不改的业务事实，
 * 心跳每周期覆盖写一行，混进去会把审计链污染。
 *
 * 数字全部从台账读（`COUNT(*)` 聚合），不靠内存计数器：
 * 进程重启后心跳里的数字照样跟台账对得上。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DatabaseSync } from 'node:sqlite';

import { getMeta, setMeta } from '../ledger/meta.js';
import { countBindings } from '../ledger/binding-repo.js';
import { lastEventAt } from '../ledger/event-log.js';

/** 心跳在 `meta` 表里的键 */
export const HEARTBEAT_KEY = 'heartbeat';

/** 心跳默认周期（毫秒）：30 秒一次 —— 够密到能看出卡死，又不至于把台账写得太频繁 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

let cachedVersion: string | null = null;

/**
 * 程序版本：从 package.json 读，读不到就退回 '0.0.0-unknown'。
 *
 * 源码直跑（src/daemon/heartbeat.ts）与编译后跑（dist/src/daemon/heartbeat.js）
 * 相对 package.json 的层数不同，两条路径都试一遍。
 */
export function appVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const relative of ['../../../package.json', '../../package.json', '../package.json']) {
    try {
      const raw = readFileSync(resolve(here, relative), 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
        cachedVersion = parsed.version.trim();
        return cachedVersion;
      }
    } catch {
      // 换下一个候选路径
    }
  }
  cachedVersion = '0.0.0-unknown';
  return cachedVersion;
}

/** 三路凭据位齐否（只报齐否，不报明文） */
export interface HeartbeatChannels {
  /** 入站扫码网关 */
  inbound: boolean;
  /** 出站 HIS 计费 */
  outbound: boolean;
  /** 企业微信推送 */
  notify: boolean;
}

/** 一条心跳记录 */
export interface HeartbeatRecord {
  /** 程序版本 */
  version: string;
  /** 运行时长（秒） */
  uptime_s: number;
  /** 台账行数 */
  ledger_rows: number;
  /** 待核查条目数 */
  pending_check: number;
  /** 末次收到扫码事件的时间 */
  last_event_at: string | null;
  /** 三路凭据位齐否 */
  channels: HeartbeatChannels;
  /** 心跳写入时刻 */
  written_at: string;
}

/** 组装一条心跳记录（数字全部现读台账） */
export function buildHeartbeat(options: {
  db: DatabaseSync;
  startedAtMs: number;
  nowMs: number;
  channels: HeartbeatChannels;
}): HeartbeatRecord {
  const db = options.db;
  const pendingRow = db
    .prepare("SELECT COUNT(*) AS n FROM check_task WHERE status = 'pending'")
    .get() as { n: number };
  return {
    version: appVersion(),
    uptime_s: Math.max(0, Math.round((options.nowMs - options.startedAtMs) / 1000)),
    ledger_rows: countBindings(db),
    pending_check: pendingRow.n ?? 0,
    last_event_at: lastEventAt(db),
    channels: { ...options.channels },
    written_at: new Date(options.nowMs).toISOString(),
  };
}

/** 写一条心跳（同键覆盖写） */
export function writeHeartbeat(db: DatabaseSync, record: HeartbeatRecord): void {
  setMeta(db, HEARTBEAT_KEY, JSON.stringify(record));
}

/** 读最近一条心跳（没有则返回 null） */
export function readHeartbeat(db: DatabaseSync): HeartbeatRecord | null {
  const row = getMeta(db, HEARTBEAT_KEY);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<HeartbeatRecord>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
      uptime_s: typeof parsed.uptime_s === 'number' ? parsed.uptime_s : 0,
      ledger_rows: typeof parsed.ledger_rows === 'number' ? parsed.ledger_rows : 0,
      pending_check: typeof parsed.pending_check === 'number' ? parsed.pending_check : 0,
      last_event_at: typeof parsed.last_event_at === 'string' ? parsed.last_event_at : null,
      channels: {
        inbound: parsed.channels?.inbound === true,
        outbound: parsed.channels?.outbound === true,
        notify: parsed.channels?.notify === true,
      },
      written_at: typeof parsed.written_at === 'string' ? parsed.written_at : row.updated_at,
    };
  } catch {
    // 心跳记录被写坏了：当作没有心跳（healthcheck 会判不新鲜），不静默当成健康
    return null;
  }
}

/** 心跳距今多少毫秒（毫秒精度不够时按秒兜底） */
export function heartbeatAgeMs(record: HeartbeatRecord, nowMs: number): number {
  const writtenAt = Date.parse(record.written_at);
  if (Number.isNaN(writtenAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - writtenAt);
}

/** 心跳是否还新鲜（超过上限即视为不健康） */
export function isHeartbeatFresh(
  record: HeartbeatRecord | null,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (!record) return false;
  return heartbeatAgeMs(record, nowMs) <= maxAgeMs;
}

/** 心跳读起来是什么样（doctor / healthcheck 共用同一份展示口径） */
export function formatHeartbeat(record: HeartbeatRecord | null): string {
  if (!record) return '（还没有心跳记录：进程可能刚起，或还没写过心跳）';
  const channels = [
    `入站${record.channels.inbound ? '齐' : '缺'}`,
    `出站${record.channels.outbound ? '齐' : '缺'}`,
    `推送${record.channels.notify ? '齐' : '缺'}`,
  ].join(' / ');
  return (
    `版本 ${record.version}　运行时长 ${record.uptime_s} 秒　台账 ${record.ledger_rows} 行　` +
    `待核查 ${record.pending_check} 条　末次事件 ${record.last_event_at ?? '（还没有）'}　` +
    `凭据位 ${channels}　写入于 ${record.written_at}`
  );
}
