/**
 * 台账存储层：node:sqlite 连接、schema 迁移版本链、事务边界、批量提交切分。
 *
 * 表结构与索引的**真源在 `src/ledger/migrations.ts`**（迁移版本链）——
 * 本文件只负责「怎么连、怎么开事务、怎么切批」，不管表长什么样。
 *
 * 表分四类（业务闭环）+ 三张支撑表：
 *   material_binding   —— 耗材使用台账（绑定了哪台手术、用了几支）
 *   charge_receipt    —— 计费回执台账（每条耗材每次尝试的回执）
 *   check_task        —— 核查任务台账（异常条目 + 台次上下文 + 人工结论）
 *   audit_chain       —— 只增不改的审计链（谁扫的、扫在哪台次、是否重复）
 *   operation / material —— 手术排台台次与耗材主数据的本地镜像
 *   idempotency_claim —— 幂等占位表（claim / confirm / release 三段租约的落点）
 *   scan_event / notify_delivery / meta —— 事件日志、推送台账、进程元信息
 *
 * 本项目只把耗材码绑到手术台次，**不落患者可识别明细**。
 *
 * 三条硬约束：
 *   ① **迁移失败不前移版本号** —— 该版事务回滚，抛 MigrationError，进程非零退出；
 *   ② **台账行 + 审计行 + 回执行同事务提交或同事务回滚** —— 不允许半写；
 *   ③ **批量事件单事务批量提交** —— 一批一个事务，超过阈值按批切分（背压）。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  applyMigrations,
  currentSchemaVersion,
  LATEST_SCHEMA_VERSION,
  type MigrationResult,
} from './migrations.js';

/** 本程序支持的台账 schema 版本（= 迁移链链尾版本） */
export const LEDGER_SCHEMA_VERSION = LATEST_SCHEMA_VERSION;

/** 默认忙等超时（毫秒）：并发写撞上时等一会儿再报错，而不是立刻失败 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** 默认批量提交阈值（条）：单批超过就按批切分，逐批各开一个事务 */
export const DEFAULT_BATCH_COMMIT_SIZE = 200;

/** 台账连接选项 */
export interface OpenLedgerOptions {
  /** 忙等超时（毫秒）；默认 5000 */
  busyTimeoutMs?: number;
  /** 日志模式；默认 WAL（常驻进程读写并发更稳） */
  journalMode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY';
  /** 外键约束；默认开 */
  foreignKeys?: boolean;
}

export interface LedgerDb {
  readonly db: DatabaseSync;
  readonly path: string;
  /** 台账行 + 审计行 + 回执行同事务提交或同事务回滚，不允许半写 */
  withTransaction<T>(fn: () => T): T;
  /** 本次连接上执行的迁移结果（开了库就已升到最新版本） */
  readonly migrations: MigrationResult;
  close(): void;
}

/**
 * 事务包装：**可重入**。
 *
 * 已经在事务里（外层已开）就复用外层事务，不重复 BEGIN ——
 * 这样「批量结算开一个事务 → 逐条落台账 → 异常条目升核查条目」能各层各写各的，
 * 但最终只由最外层那一次 COMMIT / ROLLBACK 说了算（不留半写）。
 *
 * 失败口径：抛错 → ROLLBACK → 原样抛出（失败不静默改数据）。
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始异常：失败不静默改数据
    }
    throw error;
  }
}

/**
 * 按批切分：把一批条目切成若干批，每批不超过阈值。
 *
 * 为什么要切：手术室一次扫码可能带来几百条耗材，一次开一个大事务会把
 * SQLite 的写锁占很久（别的进程写不进来）；一次开一个大事务又怕中途失败
 * 全丢。折中：**一批一个事务**，一批失败不影响别的批，账目条数始终守恒。
 *
 * 阈值 ≤ 0 时不切分（整批一个事务）。
 */
export function splitIntoBatches<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items.slice()];
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/** 读台账当前 schema 版本（user_version 版本指针） */
export function schemaVersion(db: DatabaseSync): number {
  return currentSchemaVersion(db);
}

/**
 * 打开台账库；路径为 :memory: 时不落盘（单测用）。
 *
 * 开库即迁移：连接建立后**当场把 schema 升到链尾版本**，
 * 升不动就抛错（版本号与原因都带在异常里）—— 半新半旧的表结构不许开跑。
 */
export function openLedger(path: string, options: OpenLedgerOptions = {}): LedgerDb {
  const resolved = path === ':memory:' ? path : resolve(path);
  if (resolved !== ':memory:') {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const db = new DatabaseSync(resolved);
  db.exec(`PRAGMA journal_mode = ${options.journalMode ?? 'WAL'}`);
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
  db.exec(`PRAGMA foreign_keys = ${options.foreignKeys === false ? 'OFF' : 'ON'}`);

  // 迁移失败在这里就炸：抛 MigrationError（带版本号 / 版本名 / 原因），
  // 调用方据此打印并以非零码退出，版本号停在失败前那一版。
  const migrations = applyMigrations(db);

  return {
    db,
    path: resolved,
    migrations,
    withTransaction<T>(fn: () => T): T {
      return withTransaction(db, fn);
    },
    close(): void {
      db.close();
    },
  };
}
