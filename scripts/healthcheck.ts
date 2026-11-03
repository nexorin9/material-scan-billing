/**
 * 心跳探针：容器 healthcheck 与 systemd 的 ExecStartPost 都用它回答「进程还活着吗」。
 *
 * 判据只有一条：**台账里的心跳记录是不是新鲜**。
 *
 *   - 心跳新鲜 → 退出码 0（进程还在按周期写心跳，说明它没卡死）；
 *   - 心跳缺失 / 过期 → 退出码 1（要么进程没起来，要么卡住了）。
 *
 * 为什么不用「进程在不在」判活：进程在但卡死（事件循环堵住、数据库锁死），
 * 对容器编排来说跟死了没区别。心跳是**进程自己写的**，写不出来就说明它真出问题了。
 *
 * 用法：
 *   node dist/scripts/healthcheck.js [--db <台账路径>] [--max-age <毫秒>]
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { openLedger } from '../src/ledger/db.js';
import {
  formatHeartbeat,
  heartbeatAgeMs,
  isHeartbeatFresh,
  readHeartbeat,
} from '../src/daemon/heartbeat.js';

/** 心跳超过这个时长没更新就判不健康（毫秒） */
export const DEFAULT_MAX_AGE_MS = 90_000;

function parseArgs(argv: readonly string[]): { dbPath: string; maxAgeMs: number } {
  let dbPath = (process.env['LEDGER_DB_PATH'] ?? '').trim() || 'data/ledger.db';
  let maxAgeMs = DEFAULT_MAX_AGE_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--db') {
      dbPath = argv[index + 1] ?? dbPath;
      index += 1;
      continue;
    }
    if (token.startsWith('--db=')) {
      dbPath = token.slice('--db='.length);
      continue;
    }
    if (token === '--max-age') {
      maxAgeMs = Number.parseInt(argv[index + 1] ?? '', 10) || maxAgeMs;
      index += 1;
      continue;
    }
    if (token.startsWith('--max-age=')) {
      maxAgeMs = Number.parseInt(token.slice('--max-age='.length), 10) || maxAgeMs;
    }
  }
  return { dbPath, maxAgeMs };
}

function main(): number {
  const { dbPath, maxAgeMs } = parseArgs(process.argv.slice(2));
  const resolved = resolve(dbPath);
  if (!existsSync(resolved)) {
    console.error(`不健康：台账库不存在（${resolved}）`);
    return 1;
  }

  let ledger;
  try {
    ledger = openLedger(resolved);
  } catch (error) {
    console.error(`不健康：台账库打不开（${error instanceof Error ? error.message : String(error)}）`);
    return 1;
  }

  try {
    const record = readHeartbeat(ledger.db);
    if (!record) {
      console.error('不健康：还没有心跳记录（进程可能刚起，或还没写过心跳）');
      return 1;
    }
    if (!isHeartbeatFresh(record, Date.now(), maxAgeMs)) {
      const age = heartbeatAgeMs(record, Date.now());
      console.error(`不健康：心跳已过期（${Math.round(age / 1000)} 秒未更新，上限 ${Math.round(maxAgeMs / 1000)} 秒）`);
      console.error(formatHeartbeat(record));
      return 1;
    }
    console.log(`健康：${formatHeartbeat(record)}`);
    return 0;
  } finally {
    ledger.close();
  }
}

process.exitCode = main();
