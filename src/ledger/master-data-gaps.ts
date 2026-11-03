/**
 * 主数据待补录清单（master_data_gap）。
 *
 * 为什么要有这张清单：**耗材主数据的问题要在导入时暴露，而不是运行期才炸**。
 * 院内耗材主数据里「包装单位 / 最小单位 / 计价单位 / 换算系数」四列是耗材管理岗维护的，
 * 录错、漏录都很常见（换行时把「1 包 = 5 支」录成空，或把系数写成 2.5）。
 * 「费用类别 / 医保分类」两列同理（把耗材录成西药、医保分类写成「甲」而不是「甲类」）。
 *
 * 口径：
 *   ① **导入时判定** —— 主数据导入器逐行做单位口径与费用口径的自洽性检查，
 *      问题行**照常导入**（不丢数据 —— 主数据是院内权威，导入器不该替耗材管理岗做删除），
 *      同时在清单里登记一条待补录；
 *   ② **运行期兜底** —— 主数据缺换算系数、口径不自洽或费用 / 医保口径不合规的耗材，
 *      扫码绑定时直接判异常转人工核查条目，**绝不按猜的系数或错口径计费**；
 *   ③ **补录后自动销项** —— 再次导入且口径已自洽时，该耗材该类型的待补录条目自动标记为已处理。
 *
 * **同一条耗材可以同时有多条不同类型的缺口**（单位口径一条 + 费用口径一条），
 * 因此唯一键是 **(material_code, gap_type)** 而不是单看 material_code：
 * 补好了单位口径不该把还没修的费用口径那条一起销掉。
 *
 * 这张清单是**工作台账**（要能落「已处理」状态），所以不进只增不改的哈希审计链；
 * 它与核查任务台账（check_task）是两件事：check_task 是**某一台手术的某一条耗材**，
 * master_data_gap 是**某一条耗材主数据**。
 */

import type { DatabaseSync } from 'node:sqlite';

/** 待补录条目 */
export interface MasterDataGap {
  id: number;
  material_code: string;
  /** 缺口类型（与单位口径的原因码同源，如 UNIT_RATIO_MISSING） */
  gap_type: string;
  /** 中文说明（现场信息） */
  detail: string | null;
  /** 处理状态：pending（待补录）/ resolved（已补录销项） */
  status: 'pending' | 'resolved';
  detected_at: string;
  resolved_at: string | null;
  created_at: string;
}

/** 待补录清单统计（doctor / 导入结果用） */
export interface MasterDataGapSummary {
  /** 待补录条数 */
  pending: number;
  /** 已销项条数 */
  resolved: number;
  /** 待补录条目（按耗材码升序） */
  items: MasterDataGap[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 登记一条待补录（同一耗材 + 同一缺口类型只留一条，重复导入只更新现场信息）。
 *
 * 幂等：按 (material_code, gap_type) 唯一；已销项的条目再次被判不合格 → 重新置为 pending
 * （耗材管理岗可能改完又改坏了，清单要如实反映当前状态）。
 */
export function recordMasterDataGap(
  db: DatabaseSync,
  gap: { material_code: string; gap_type: string; detail?: string | null },
): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO master_data_gap (material_code, gap_type, detail, status, detected_at, resolved_at, created_at)
     VALUES (?, ?, ?, 'pending', ?, NULL, ?)
     ON CONFLICT(material_code, gap_type) DO UPDATE SET
       detail = excluded.detail,
       status = 'pending',
       detected_at = excluded.detected_at,
       resolved_at = NULL`,
  ).run(gap.material_code, gap.gap_type, gap.detail ?? null, now, now);
}

/**
 * 销项：该耗材的**某一种**口径缺口已修好，待补录条目标记为已处理。
 *
 * 只销这一种缺口类型 —— 补好了单位口径不该把还没修的费用口径那条一起销掉。
 * 没有对应待补录条目时什么都不做（幂等）。
 */
export function resolveMasterDataGap(
  db: DatabaseSync,
  material_code: string,
  gap_type: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE master_data_gap
          SET status = 'resolved', resolved_at = ?
        WHERE material_code = ? AND gap_type = ? AND status = 'pending'`,
    )
    .run(nowIso(), material_code, gap_type);
  return Number(result.changes) > 0;
}

/**
 * 按缺口类型组批量销项（单位口径一组、费用口径一组）。
 *
 * 返回被销项的条数；没有对应待补录条目时返回 0（幂等）。
 */
export function resolveMasterDataGaps(
  db: DatabaseSync,
  material_code: string,
  gap_types: readonly string[],
): number {
  let changed = 0;
  for (const gap_type of gap_types) {
    if (resolveMasterDataGap(db, material_code, gap_type)) changed += 1;
  }
  return changed;
}

/** 取某耗材的待补录条目（没给缺口类型时取该耗材任意一条） */
export function findMasterDataGap(
  db: DatabaseSync,
  material_code: string,
  gap_type?: string,
): MasterDataGap | undefined {
  const row = (
    gap_type
      ? db
          .prepare('SELECT * FROM master_data_gap WHERE material_code = ? AND gap_type = ?')
          .get(material_code, gap_type)
      : db.prepare('SELECT * FROM master_data_gap WHERE material_code = ?').get(material_code)
  ) as Record<string, unknown> | undefined;
  return row ? toGap(row) : undefined;
}

/** 列待补录条目（默认只列 pending，按耗材码升序） */
export function listMasterDataGaps(
  db: DatabaseSync,
  options: { status?: 'pending' | 'resolved' } = {},
): MasterDataGap[] {
  const status = options.status ?? 'pending';
  const rows = db
    .prepare('SELECT * FROM master_data_gap WHERE status = ? ORDER BY material_code ASC')
    .all(status) as unknown as Record<string, unknown>[];
  return rows.map(toGap);
}

/** 待补录清单汇总（doctor 用） */
export function masterDataGapSummary(db: DatabaseSync): MasterDataGapSummary {
  const pending = listMasterDataGaps(db, { status: 'pending' });
  const resolved = listMasterDataGaps(db, { status: 'resolved' });
  return { pending: pending.length, resolved: resolved.length, items: pending };
}

function toGap(row: Record<string, unknown>): MasterDataGap {
  return {
    id: Number(row['id']),
    material_code: String(row['material_code'] ?? ''),
    gap_type: String(row['gap_type'] ?? ''),
    detail: row['detail'] == null ? null : String(row['detail']),
    status: row['status'] === 'resolved' ? 'resolved' : 'pending',
    detected_at: String(row['detected_at'] ?? ''),
    resolved_at: row['resolved_at'] == null ? null : String(row['resolved_at']),
    created_at: String(row['created_at'] ?? ''),
  };
}
