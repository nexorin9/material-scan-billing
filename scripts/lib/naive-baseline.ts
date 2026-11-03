/**
 * 朴素基线共用的两件工具：把幂等层的台账级防线摘掉 + 给出朴素行的键。
 *
 * 为什么要有这两个工具：
 *   幂等层不是一个函数，是**三层**东西：
 *     ① 入站侧的**幂等占位**（claim / lease / confirm）—— 同一把键并发时只有一个人拿到；
 *     ② 台账侧的**唯一索引**（幂等键唯一、（耗材码 + 台次）唯一）——
 *        绕开占位直接写台账也写不进第二行；
 *     ③ 出站侧的**键透传**（行级键 + 请求级键随请求发给对端，对端据此去重）。
 *
 *   朴素基线要模拟的是「**这三层都没有**」的那张台账 —— 只有这样，
 *   「幂等层省下了多少重复计费」这个差值才是真的：
 *     - 占位层没有 → 并发投递时多个人同时通过「查不到就写」；
 *     - 唯一索引没有 → 同一把键能写进第二行；
 *     - 键透传没有 → 对端收到的是一笔没有身份的消费。
 *
 *   注意基线**不是**另一套产品：判定规则、码制归一、出站 HTTP 客户端、
 *   计费替身、回写路径（`writeBackOperationCharges`）都与幂等版**同一条**，
 *   差的就是上面这三层。键的派生口径也用**同一把尺子**（v1）——
 *   朴素实现照样会算出这把键，只是算完没人拿它去重。
 */

import type { DatabaseSync } from 'node:sqlite';

import { deriveIdempotencyKeyForProfile } from '../../src/domain/idempotency.js';

/**
 * 摘掉幂等层的台账级防线（三张唯一索引）。
 *
 * 这模拟的是「朴素实现的表没有唯一约束」—— 它不是产品的配置，
 * 只在基准台账（内存库）上执行，产品自己的台账**永远带着这三张索引**。
 */
export function dropIdempotencyDefenses(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX IF EXISTS ux_material_binding_idem;
    DROP INDEX IF EXISTS ux_material_binding_code_op;
    DROP INDEX IF EXISTS ux_material_binding_code_op_batch;
  `);
}

/**
 * 朴素行的键：与产品**同一把尺子**（v1 档位 = 耗材码 + 台次）。
 *
 * 朴素实现照样会算出这把键（键的派生口径不是幂等层），
 * 差的是**没人拿它去重** —— 于是同一把键写进两行台账、对端收到两笔计费。
 * 这正是幂等层要挡掉的场景。
 */
export function naiveRowKey(
  material_code: string,
  operation_no: string,
): { idempotency_key: string; key_profile: string } {
  const derived = deriveIdempotencyKeyForProfile({ material_code, operation_no }, 'v1');
  return { idempotency_key: derived.key, key_profile: derived.profile };
}
