/**
 * 审计链写入与校验：**只增不改 + 哈希链可自证**。
 *
 * 本层只暴露 append / query / verify，**不提供 update / delete 接口** —— 台账能被改就不可信，
 * 内审与飞检语境下「谁扫的、扫在哪台次、是否重复、回写结果」必须可回放。
 *
 * 哈希链（prev_hash / row_hash）：每行背上一行的行哈希与本行内容的哈希。
 * 改一行、删一行，链子在那一行断掉，断点行号当场指出（`verifyChain`）。
 * 库层的 UPDATE / DELETE 触发器在 `src/ledger/migrations.ts`（v10 迁移）。
 *
 * 与源产品的对应：源产品在共享网关上为每一条投递留一份逐目标回执
 * （`delivery_count` / `active`），凭据留在服务端、出问题能按目标逐条回看；
 * 本项目把这条「每次动作都留痕」的机制落到审计链上，并**加一道可自证的封印** ——
 * 留痕能回答「发生过什么」，哈希链还能回答「这份留痕有没有被人动过」。
 *
 * 查询面：按幂等键查、按事件类型查、分布统计、末次时间，
 * 以及 `verifyAuditIntegrity`（行号连续 / 时间不倒序 / 事件类型非空）
 * 与 `verifyChain`（哈希链逐行重算比对）。
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  GENESIS_HASH,
  computeRowHash,
  type AuditContent,
  type AuditContentRow,
} from './audit-hash.js';

export interface AuditEvent {
  /** 事件类型（claim_released / claim_confirmed / claim_lease_expired / ...） */
  event_type: string;
  /** 幂等键或台账行键（可回溯到具体条目） */
  binding_key?: string | null;
  operation_no?: string | null;
  scanner_id?: string | null;
  /** 谁做的：ingest / binding_engine / charge_writeback / manual_confirm / claim */
  actor?: string | null;
  /** 明细（JSON 字符串或中文短句） */
  detail?: string | null;
  /**
   * 本次投递 / 处置的请求标识。
   *
   * 状态迁移轨迹靠它把「哪一次扫码 → 哪一次计费回写 → 哪一次人工确认」串成一条线，
   * 排障时按 request_id 就能捞出整条处置轨迹。
   */
  request_id?: string | null;
}

export interface AuditRow {
  id: number;
  event_type: string;
  binding_key: string | null;
  operation_no: string | null;
  scanner_id: string | null;
  actor: string | null;
  detail: string | null;
  request_id: string | null;
  prev_hash: string | null;
  row_hash: string | null;
  created_at: string;
}

/** 审计链异常（链头未封印 / 链被并发写叉） */
export class AuditChainError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    /** 相关行 id（若有） */
    readonly rowId?: number | null,
  ) {
    super(message);
    this.name = 'AuditChainError';
    this.code = code;
  }
}

/**
 * 立即取写锁的事务包装（可重入）。
 *
 * 为什么要 BEGIN IMMEDIATE 而不是普通 BEGIN：哈希链的写入是
 * 「读链头 → 算哈希 → 插行」三步，三步之间不能有别人插进来 ——
 * 否则两行会背同一个 prev_hash，链子分叉。
 * BEGIN IMMEDIATE 在事务开始时就拿到写锁，别人的写入排队等着（busy_timeout 兜底）。
 *
 * 已经在事务里（外层已开）就复用外层事务，不重复 BEGIN。
 */
function withChainTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
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

/** 链头（最后一行）的 id 与行哈希 */
interface ChainHead {
  id: number;
  row_hash: string | null;
}

/** 读链头（最后一行） */
function readChainHead(db: DatabaseSync): ChainHead | null {
  const row = db
    .prepare('SELECT id, row_hash FROM audit_chain ORDER BY id DESC LIMIT 1')
    .get() as ChainHead | undefined;
  return row ?? null;
}

/**
 * 追加一行审计记录；返回新行 id。
 *
 * 写入即封印：新行的 prev_hash 取当前链头的 row_hash（空链取创世哈希），
 * row_hash = sha256(prev_hash | 规范化行内容)。链因此是**串行**的 ——
 * 改中间任意一行，后面所有行都验不过。
 */
export function appendAudit(db: DatabaseSync, event: AuditEvent): number {
  return withChainTransaction(db, () => {
    const head = readChainHead(db);
    if (head && !head.row_hash) {
      throw new AuditChainError(
        'ERR_AUDIT_CHAIN_UNSEALED_HEAD',
        `审计链头未封印（id=${head.id}）：请先升级台账到最新版本再继续写入`,
        head.id,
      );
    }
    const prevHash = head?.row_hash ?? GENESIS_HASH;

    const content: AuditContent = {
      event_type: event.event_type,
      binding_key: event.binding_key ?? null,
      operation_no: event.operation_no ?? null,
      scanner_id: event.scanner_id ?? null,
      actor: event.actor ?? null,
      detail: event.detail ?? null,
      request_id: event.request_id ?? null,
      created_at: new Date().toISOString(),
      prev_hash: prevHash,
    };
    const rowHash = computeRowHash(prevHash, content);

    const result = db
      .prepare(
        `INSERT INTO audit_chain
           (event_type, binding_key, operation_no, scanner_id, actor, detail, request_id,
            prev_hash, row_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        content.event_type,
        content.binding_key,
        content.operation_no,
        content.scanner_id,
        content.actor,
        content.detail,
        content.request_id,
        prevHash,
        rowHash,
        content.created_at,
      );

    const newId = Number(result.lastInsertRowid);
    assertChainNotForked(db, newId, prevHash);
    return newId;
  });
}

/**
 * 防叉校验：新行的上一行必须正是我们据以计算 prev_hash 的那一行。
 *
 * 正常路径下 BEGIN IMMEDIATE 已经保证不会分叉；这条是**兜底** ——
 * 万一链头在读与插之间被别人推进过（外层事务是延迟事务、别人先插了一行），
 * 宁可当场报错回滚，也不能悄悄写出一条背错前驱的行（失败不静默改数据）。
 */
function assertChainNotForked(db: DatabaseSync, newId: number, prevHash: string): void {
  const previous = db
    .prepare('SELECT id, row_hash FROM audit_chain WHERE id = ?')
    .get(newId - 1) as ChainHead | undefined;
  if (!previous) {
    // 新行是第一行：链头必须是创世哈希
    if (prevHash !== GENESIS_HASH) {
      throw new AuditChainError(
        'ERR_AUDIT_CHAIN_FORK',
        `审计链分叉：新行 id=${newId} 的前驱哈希不是创世哈希`,
        newId,
      );
    }
    return;
  }
  if (previous.row_hash !== prevHash) {
    throw new AuditChainError(
      'ERR_AUDIT_CHAIN_FORK',
      `审计链分叉：新行 id=${newId} 的前驱哈希与上一行不符（链头被并发推进）`,
      newId,
    );
  }
}


/** 按幂等键查审计记录（按时间序） */
export function queryAuditByKey(db: DatabaseSync, binding_key: string): AuditRow[] {
  return db
    .prepare('SELECT * FROM audit_chain WHERE binding_key = ? ORDER BY id ASC')
    .all(binding_key) as unknown as AuditRow[];
}

/** 审计链总行数 */
export function countAuditRows(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM audit_chain').get() as { n: number };
  return row.n;
}

/** 按事件类型查审计记录（按时间序；limit 给 0 表示不限） */
export function queryAuditByType(
  db: DatabaseSync,
  event_type: string,
  limit = 0,
): AuditRow[] {
  const sql =
    limit > 0
      ? 'SELECT * FROM audit_chain WHERE event_type = ? ORDER BY id ASC LIMIT ?'
      : 'SELECT * FROM audit_chain WHERE event_type = ? ORDER BY id ASC';
  const rows = (
    limit > 0
      ? db.prepare(sql).all(event_type, limit)
      : db.prepare(sql).all(event_type)
  ) as unknown as AuditRow[];
  return rows;
}

/** 某类事件的出现次数 */
export function countAuditByType(db: DatabaseSync, event_type: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM audit_chain WHERE event_type = ?')
    .get(event_type) as { n: number };
  return row.n;
}

/** 末次审计时间（没有记录时为 null） */
export function lastAuditAt(db: DatabaseSync): string | null {
  const row = db
    .prepare('SELECT created_at FROM audit_chain ORDER BY id DESC LIMIT 1')
    .get() as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

/** 审计链按事件类型的分布（供 doctor / summary 展示） */
export function auditSummary(db: DatabaseSync): Array<{ event_type: string; count: number }> {
  return db
    .prepare(
      'SELECT event_type, COUNT(*) AS count FROM audit_chain GROUP BY event_type ORDER BY count DESC, event_type ASC',
    )
    .all() as unknown as Array<{ event_type: string; count: number }>;
}

/** 审计链完整性校验结论 */
export interface AuditIntegrity {
  /** 是否完整（无缺口、无倒序、无空事件类型） */
  intact: boolean;
  /** 校验覆盖的行数 */
  rows: number;
  /** 发现的问题（每条一句话，指明行号与原因） */
  issues: string[];
  /** 校验时刻 */
  checked_at: string;
}

/**
 * 审计链完整性校验（只读，不改任何行）。
 *
 * 校验三件事：
 *   ① **行号连续** —— 只增不改的链不应出现缺口（有缺口说明有行被删过）；
 *   ② **时间不倒序** —— 后写入的行不应早于先写入的行；
 *   ③ **事件类型非空** —— 每一行都要能说清「发生了什么」。
 *
 * 哈希链（prev_hash / row_hash 的逐行重算）由审计链加固那一轮补上；
 * 本函数是加固前的基础体检 —— 缺口、倒序、空类型都能当场指出行号。
 */
export function verifyAuditIntegrity(db: DatabaseSync): AuditIntegrity {
  const rows = db
    .prepare('SELECT id, event_type, created_at FROM audit_chain ORDER BY id ASC')
    .all() as unknown as Array<{ id: number; event_type: string; created_at: string }>;

  const issues: string[] = [];
  let previousId: number | null = null;
  let previousAt: string | null = null;

  for (const row of rows) {
    if (previousId !== null && row.id !== previousId + 1) {
      issues.push(`第 ${previousId + 1} 行缺失（下一行 id = ${row.id}）：只增不改的链不应有缺口`);
    }
    if (!row.event_type || row.event_type.trim().length === 0) {
      issues.push(`第 ${row.id} 行事件类型为空：这一行说不清发生了什么`);
    }
    if (previousAt !== null && row.created_at < previousAt) {
      issues.push(`第 ${row.id} 行时间倒序（${row.created_at} 早于上一行 ${previousAt}）`);
    }
    previousId = row.id;
    previousAt = row.created_at;
  }

  return {
    intact: issues.length === 0,
    rows: rows.length,
    issues,
    checked_at: new Date().toISOString(),
  };
}

/* ── 哈希链校验 ────────────────────────────────────────────────────────── */

/** 断链类型 */
export type ChainBreakReason =
  /** 本行内容被改（重算的行哈希与存的对不上） */
  | 'content_mismatch'
  /** 本行的前驱哈希与上一行对不上（链被接错 / 中间有行被删） */
  | 'link_mismatch'
  /** 行号不连续（有行被删过） */
  | 'missing_row'
  /** 本行没有封印哈希（绕开写入面直接塞进来的行） */
  | 'unsealed_row';

/** 一个断点 */
export interface ChainBreak {
  /** 断点行的 id（audit_chain.id） */
  row_id: number;
  /** 该行在所校验区间中的序号（从 1 开始） */
  row_no: number;
  /** 断链类型 */
  reason: ChainBreakReason;
  /** 中文说明（可直接贴给信息科） */
  message: string;
  /** 期望值（重算出的行哈希 / 前驱哈希 / 应有的行号） */
  expected: string | null;
  /** 实际值（库里存的值） */
  actual: string | null;
}

/** 哈希链校验结论 */
export interface ChainVerification {
  /** 是否完整（无断点） */
  intact: boolean;
  /** 校验覆盖的行数 */
  rows: number;
  /** 校验的行号区间（含端点；null 表示不限） */
  from_id: number | null;
  to_id: number | null;
  /** 第一个断点（无断点为 null） */
  first_break: ChainBreak | null;
  /** 全部问题（中文，可直接展示） */
  issues: string[];
  /** 校验时刻 */
  checked_at: string;
}

/**
 * 哈希链校验：逐行重算 + 逐行接续比对。
 *
 * 四条判据（任一不成立即断链）：
 *   ① **封印** —— 本行必须有 row_hash（绕开写入面塞进来的行没有）；
 *   ② **内容** —— 用本行存储的字段重算 row_hash，必须与存储值一致
 *      （内容被改 → 重算值与存储值对不上）；
 *   ③ **接续** —— 本行的 prev_hash 必须等于上一行的 row_hash
 *      （第一行则必须等于创世哈希；链尾被换过也会在这里露出来）；
 *   ④ **连续** —— 相邻两行的 id 必须差 1（有行被删过）。
 *
 * 与触发器的关系：触发器拦住「在库内动手的」，本函数兜住
 * 「绕过触发器的」（直接改库文件、从备份恢复旧数据）—— 断点行号当场指出。
 *
 * `from` / `to` 限定校验区间（按 id）；给了 `from` 时，
 * 区间第一行的前驱哈希以「from 之前那一行」为锚点校验，区间本身不用重算。
 */
export function verifyChain(
  db: DatabaseSync,
  from?: number | null,
  to?: number | null,
): ChainVerification {
  const fromId = Number.isInteger(from) && (from as number) > 0 ? (from as number) : null;
  const toId = Number.isInteger(to) && (to as number) > 0 ? (to as number) : null;

  // 区间起点的前驱锚点：from 之前那一行的 row_hash
  const anchor =
    fromId === null
      ? null
      : (db
          .prepare('SELECT id, row_hash FROM audit_chain WHERE id < ? ORDER BY id DESC LIMIT 1')
          .get(fromId) as ChainHead | undefined) ?? null;

  const conditions: string[] = [];
  const params: Array<number> = [];
  if (fromId !== null) {
    conditions.push('id >= ?');
    params.push(fromId);
  }
  if (toId !== null) {
    conditions.push('id <= ?');
    params.push(toId);
  }
  const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT id, event_type, binding_key, operation_no, scanner_id, actor, detail,
              request_id, created_at, prev_hash, row_hash
         FROM audit_chain ${clause}
        ORDER BY id ASC`,
    )
    .all(...params) as unknown as AuditContentRow[];

  const issues: string[] = [];
  let firstBreak: ChainBreak | null = null;

  let expectedPrev = anchor ? anchor.row_hash : GENESIS_HASH;
  let previousId: number | null = null;

  for (const [index, row] of rows.entries()) {
    const rowNo = index + 1;

    const push = (reason: ChainBreakReason, message: string, expected: string | null, actual: string | null): void => {
      issues.push(message);
      if (!firstBreak) {
        firstBreak = { row_id: row.id, row_no: rowNo, reason, message, expected, actual };
      }
    };

    // ① 封印
    if (!row.row_hash) {
      push(
        'unsealed_row',
        `第 ${rowNo} 行（id=${row.id}）没有封印哈希：这行不是经写入面追加的，内容无从校验`,
        null,
        null,
      );
      break;
    }

    // ④ 连续（先判行号缺口：被删的行会让后面所有行的接续一起断，先指出「少了一行」）
    if (previousId !== null && row.id !== previousId + 1) {
      push(
        'missing_row',
        `第 ${rowNo} 行（id=${row.id}）与上一行 id=${previousId} 之间不连续：中间有行被删过`,
        String(previousId + 1),
        String(row.id),
      );
      break;
    }

    // ② 内容
    const content: AuditContent = {
      event_type: row.event_type,
      binding_key: row.binding_key ?? null,
      operation_no: row.operation_no ?? null,
      scanner_id: row.scanner_id ?? null,
      actor: row.actor ?? null,
      detail: row.detail ?? null,
      request_id: row.request_id ?? null,
      created_at: row.created_at,
      prev_hash: row.prev_hash ?? null,
    };
    const recomputed = computeRowHash(row.prev_hash ?? '', content);
    if (recomputed !== row.row_hash) {
      push(
        'content_mismatch',
        `第 ${rowNo} 行（id=${row.id}）内容被改：重算行哈希 ${recomputed.slice(0, 12)}… 与库中 ${String(row.row_hash).slice(0, 12)}… 不符`,
        recomputed,
        row.row_hash,
      );
      break;
    }

    // ③ 接续
    if ((row.prev_hash ?? '') !== (expectedPrev ?? '')) {
      push(
        'link_mismatch',
        `第 ${rowNo} 行（id=${row.id}）的前驱哈希与上一行对不上：期望 ${String(expectedPrev).slice(0, 12)}…，实际 ${String(row.prev_hash ?? '').slice(0, 12)}…`,
        expectedPrev ?? null,
        row.prev_hash ?? null,
      );
      break;
    }

    expectedPrev = row.row_hash;
    previousId = row.id;
  }

  return {
    intact: issues.length === 0,
    rows: rows.length,
    from_id: fromId,
    to_id: toId,
    first_break: firstBreak,
    issues,
    checked_at: new Date().toISOString(),
  };
}

/** 审计链当前链头的行哈希（空链返回创世哈希） */
export function auditChainHead(db: DatabaseSync): string {
  const head = readChainHead(db);
  return head?.row_hash ?? GENESIS_HASH;
}

