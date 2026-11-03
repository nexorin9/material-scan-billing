/**
 * 审计链哈希链的**纯计算**部分：规范化行内容 + 行哈希。
 *
 * 为什么要有哈希链：审计链「只增不改」是**约定**，约定挡不住有库文件权限的人。
 * 内审与飞检语境下要能当场证明「这串记录没被动过」——
 * 每行自带上一行的哈希与本行内容的哈希，改一行或删一行，
 * 链子立刻在那一行断掉，断点行号可当场指出。
 *
 * 口径（与源产品的「逐条回执留痕」同一思路的院内改写）：
 *   源产品在共享网关上为每一条投递留一份逐目标回执（`delivery_count` / `active`），
 *   凭据留在服务端、出问题能按目标逐条回看；本项目把这条「每次动作都留痕」的机制
 *   落到审计链上 —— 但只留痕还不够，内审要的是**能自证没被改过**，所以再加一道哈希串联。
 *
 * 三条硬约束：
 *   ① **规范化内容是纯函数** —— 同样的字段值必须算出同样的哈希（字段顺序固定、
 *      null 与空串可区分、用 JSON 数组编码而不是字符串拼接，避免分隔符歧义）；
 *   ② **链头锚点是固定创世值** —— 第一行的 prev_hash 是全零创世哈希，
 *      链子因此有唯一确定的起点（重算时能验证「起点没被挪过」）；
 *   ③ **id 不进哈希** —— 行号是 SQLite 分配的，插入前拿不到；
 *      顺序由 prev_hash 串联保证，不靠 id。
 */

import { createHash } from 'node:crypto';

/** 创世哈希：链上第一行的 prev_hash（64 个 0，十六进制定长） */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * 一行审计记录的**内容**（哈希覆盖的全部字段）。
 *
 * 刻意**不含 id**：id 由 SQLite 在插入时分配，插入前拿不到；
 * 也**不含 row_hash** 本身（自己不能算进自己）。
 */
export interface AuditContent {
  event_type: string;
  binding_key: string | null;
  operation_no: string | null;
  scanner_id: string | null;
  actor: string | null;
  detail: string | null;
  request_id: string | null;
  created_at: string;
  /** 上一行的行哈希（第一行为创世哈希） */
  prev_hash: string | null;
}

/** 参与哈希的字段顺序（固定；改顺序等于换哈希口径，必须同步迁移与文档） */
const CONTENT_FIELDS = [
  'event_type',
  'binding_key',
  'operation_no',
  'scanner_id',
  'actor',
  'detail',
  'request_id',
  'created_at',
  'prev_hash',
] as const;

/**
 * 规范化行内容：定长字段顺序 + JSON 数组编码。
 *
 * 为什么用 JSON 数组而不是 `join('|')`：
 *   ① null 与空串必须可区分（`detail` 为空和 `detail` 为 null 是两回事）；
 *   ② 字段值里出现分隔符不会造成歧义（detail 是自由文本，可能带 | 和换行）。
 */
export function canonicalAuditPayload(content: AuditContent): string {
  const values = CONTENT_FIELDS.map((field) => content[field] ?? null);
  return JSON.stringify(values);
}

/**
 * 一行审计记录的**存储形态**（内容 + 行哈希 + 行号）。
 *
 * 与 AuditContent 的差别：多了 row_hash（行自身的封印）与 id（库里的行号）。
 */
export interface AuditContentRow extends AuditContent {
  id: number;
  /** 本行的封印哈希；未封印的行是 null */
  row_hash: string | null;
}

/** sha256 十六进制摘要 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 行哈希 = sha256(prev_hash + '|' + 规范化行内容)。
 *
 * 前置的 prev_hash 让每一行都「背着」前面所有行的内容 ——
 * 改中间任何一行，后面所有行的哈希都对不上。
 */
export function computeRowHash(prevHash: string, content: AuditContent): string {
  return sha256Hex(`${prevHash}|${canonicalAuditPayload(content)}`);
}
