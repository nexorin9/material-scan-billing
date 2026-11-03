/**
 * 台账 schema 迁移版本链（user_version 版本指针 + migrations 履历表）。
 *
 * 为什么必须有这条链：常驻守护进程会在同一台机器上跑很久，schema 跟着业务口径演进
 * （新增列、加复合索引、改约束）。没有版本链的话，升级只能靠「重建库」——
 * 手术室的历史台账一重建就全没了，内审与飞检要核对的「上个月用了哪些耗材」也就没了。
 *
 * 三条口径：
 *   ① **user_version 是版本指针**（SQLite 自带的 schema 版本位）——
 *      库当前在第几版一眼可见，外部工具（sqlite3 CLI、运维脚本）也能直接读；
 *   ② **migrations 表是履历**（每版叫什么、什么时候应用的、是本链应用还是老库补记）——
 *      升级历史可查，出问题时知道「这台机器的台账是怎么长成这样的」；
 *   ③ **每一版的 up 都幂等可重入**（CREATE TABLE IF NOT EXISTS / 补列前先查列在不在）——
 *      重跑一遍不会炸，迁移失败后重试也不会把库改坏。
 *
 * 失败口径（硬要求）：
 *   任一版本迁移抛错 → **该版本事务回滚** → **版本号不前移** → 抛 MigrationError
 *   （带版本号 / 版本名 / 原因）→ 启动自检打印后**非零退出**。
 *   失败时不改任何业务行（台账行数不变）—— 失败不静默改数据。
 *
 * 与源产品的对应：源产品（多服务 + 共享网关）在服务入口做「缺位拒绝启动」的
 * 自检；本链是同一套思路落到存储层 —— **版本对不上就拒绝启动**，
 * 而不是带着半新半旧的表结构继续跑（降级跑会把新表结构写坏）。
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  LEGACY_IDEMPOTENCY_KEY_PROFILE,
  deriveLegacyIdempotencyKey,
} from '../domain/idempotency.js';
import {
  GENESIS_HASH,
  computeRowHash,
  type AuditContent,
  type AuditContentRow,
} from './audit-hash.js';

/* ── 幂等小工具 ────────────────────────────────────────────────────────── */

/** 表是否存在 */
export function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return row?.name != null;
}

/** 索引是否存在 */
export function indexExists(db: DatabaseSync, index: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(index) as { name?: string } | undefined;
  return row?.name != null;
}

/** 表的列名清单 */
export function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

/**
 * 补列（幂等）：列已存在就什么都不做。
 *
 * 迁移链里的「加列」全部走这里 —— 同一个版本重跑两遍不会报「duplicate column name」。
 */
export function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  if (!tableExists(db, table)) return;
  if (columnNames(db, table).includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/* ── 迁移链定义 ────────────────────────────────────────────────────────── */

/** 一条迁移：版本号 + 版本名 + 中文说明 + 执行体 */
export interface Migration {
  /** 版本号（从 1 开始，连续递增） */
  readonly version: number;
  /** 版本名（机器可比的短标识，进 migrations 表） */
  readonly name: string;
  /** 中文说明（给 doctor / 运维看的一句话） */
  readonly description_zh: string;
  /** 执行体：**必须幂等可重入** */
  up(db: DatabaseSync): void;
}

/**
 * 基线台账（v1）：台次与耗材主数据镜像 + 耗材使用台账 + 计费回执 + 核查任务 + 审计链。
 *
 * 五张表对应四个业务闭环 + 两张院内主数据镜像：
 *   operation       —— 手术排台台次镜像（权威：手术排台）
 *   material        —— 院内耗材主数据镜像（权威：耗材主数据）
 *   material_binding—— 耗材使用台账（绑定了哪台手术、用了几支）
 *   charge_receipt  —— 计费回执台账（每条耗材每次尝试的回执）
 *   check_task      —— 核查任务台账（异常条目 + 台次上下文 + 人工结论）
 *   audit_chain     —— 只增不改的审计链（谁扫的、扫在哪台次、是否重复）
 *
 * 本项目只把耗材码绑到手术台次，**不落患者可识别明细**。
 */
const M1_BASE_LEDGER: Migration = {
  version: 1,
  name: 'base_ledger_schema',
  description_zh: '基线台账：台次与耗材主数据镜像、耗材使用台账、计费回执、核查任务、审计链',
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS operation (
  operation_no TEXT PRIMARY KEY,
  room_no      TEXT NOT NULL,
  dept_code    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  closed_at    TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS material (
  material_code           TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  price_code              TEXT NOT NULL,
  fee_category            TEXT NOT NULL,
  medical_insurance_class TEXT NOT NULL,
  active                  INTEGER NOT NULL DEFAULT 1,
  batch_no                TEXT,
  updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS material_binding (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key         TEXT NOT NULL,
  operation_no            TEXT NOT NULL,
  room_no                 TEXT NOT NULL,
  dept_code               TEXT NOT NULL,
  material_code           TEXT NOT NULL,
  quantity                REAL NOT NULL,
  price_code              TEXT,
  fee_category            TEXT,
  medical_insurance_class TEXT,
  conclusion              TEXT NOT NULL,
  status                  TEXT NOT NULL,
  check_task_id           INTEGER,
  raw_code                TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

-- 第一道去重防线：幂等键就是 sha256(material_code|operation_no)，
-- 与 (material_code, operation_no) 一一对应；用哈希列做唯一索引。
CREATE UNIQUE INDEX IF NOT EXISTS ux_material_binding_idem ON material_binding(idempotency_key);
CREATE INDEX IF NOT EXISTS ix_material_binding_code_op ON material_binding(material_code, operation_no);
CREATE INDEX IF NOT EXISTS ix_material_binding_operation ON material_binding(operation_no);

CREATE TABLE IF NOT EXISTS charge_receipt (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  material_code     TEXT NOT NULL,
  operation_no      TEXT NOT NULL,
  idempotency_key   TEXT,
  key_profile       TEXT,
  attempt           INTEGER NOT NULL DEFAULT 1,
  accepted          INTEGER NOT NULL DEFAULT 0,
  reason_code       TEXT,
  error_code        TEXT,
  channel_reachable INTEGER,
  requested_at      TEXT,
  responded_at      TEXT,
  response_summary  TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_charge_receipt_item ON charge_receipt(material_code, operation_no);

CREATE TABLE IF NOT EXISTS check_task (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_no         TEXT NOT NULL,
  room_no              TEXT NOT NULL,
  dept_code            TEXT,
  scanner_id           TEXT,
  material_code        TEXT NOT NULL,
  quantity             REAL,
  conclusion           TEXT NOT NULL,
  reason_code          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  assignee_role        TEXT,
  assigned_at          TEXT,
  reminded_at          TEXT,
  escalated_at         TEXT,
  timeout_level        INTEGER NOT NULL DEFAULT 0,
  detected_at          TEXT NOT NULL,
  confirmed_at         TEXT,
  confirmed_by         TEXT,
  confirmed_conclusion TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_check_task_status ON check_task(status, created_at);

CREATE TABLE IF NOT EXISTS audit_chain (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL,
  binding_key  TEXT,
  operation_no TEXT,
  scanner_id   TEXT,
  actor        TEXT,
  detail       TEXT,
  prev_hash    TEXT,
  row_hash     TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_chain_operation ON audit_chain(operation_no, created_at);
`);
  },
};

/** v2：幂等占位表（claim / confirm / release 三段租约的落点）。 */
const M2_IDEMPOTENCY_CLAIM: Migration = {
  version: 2,
  name: 'idempotency_claim',
  description_zh: '幂等占位表：同一把键只允许一个处理者占用，租约到期可接管续跑',
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS idempotency_claim (
  key             TEXT PRIMARY KEY,
  token           TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'claimed',
  claim_count     INTEGER NOT NULL DEFAULT 1,
  operation_no    TEXT,
  material_code   TEXT,
  scanner_id      TEXT,
  claimed_at      TEXT NOT NULL,
  expires_at_ms   INTEGER NOT NULL,
  confirmed_at    TEXT,
  released_at     TEXT,
  release_reason  TEXT,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_claim_state_expires ON idempotency_claim(state, expires_at_ms);
`);
  },
};

/**
 * v3：幂等键版本化（key_profile 列 + 第二道去重防线）。
 *
 * 第二道防线是 (material_code, operation_no) 唯一 —— 与幂等键哈希无关，
 * 即便有人绕开幂等键派生直接写台账，同一耗材同一台次也写不进第二行。
 * 只约束 v1 键（码 + 台次）：键版本化到 v2（码 + 台次 + 批号）后同码不同批各记一行，
 * 那时由 ux_material_binding_idem 按完整键兜底。
 */
const M3_BINDING_KEY_PROFILE: Migration = {
  version: 3,
  name: 'binding_key_profile',
  description_zh: '幂等键版本化：台账行带键档位，并按（耗材码 + 台次）建唯一防线',
  up(db) {
    ensureColumn(db, 'material_binding', 'key_profile', "TEXT NOT NULL DEFAULT 'v1'");
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_material_binding_code_op
         ON material_binding(material_code, operation_no) WHERE key_profile = 'v1'`,
    );
  },
};

/** v4：核查条目的台次上下文与人工撤回痕迹。 */
const M4_CHECK_TASK_CONTEXT: Migration = {
  version: 4,
  name: 'check_task_context',
  description_zh: '核查条目补齐台次上下文、先到者归属与人工撤回痕迹',
  up(db) {
    // 跨台次重复时：先到者的台次与手术间（保留原始归属，供事后核对）
    ensureColumn(db, 'check_task', 'source_operation_no', 'TEXT');
    ensureColumn(db, 'check_task', 'source_room_no', 'TEXT');
    // 核查条目 ↔ 台账行双向挂接 + 人工撤回痕迹
    ensureColumn(db, 'check_task', 'binding_id', 'INTEGER');
    ensureColumn(db, 'check_task', 'revoked_at', 'TEXT');
    ensureColumn(db, 'check_task', 'revoked_by', 'TEXT');
  },
};

/** v5：计费回执的累计投递次数、归类档位与可重投标记。 */
const M5_RECEIPT_DELIVERY_TRACKING: Migration = {
  version: 5,
  name: 'receipt_delivery_tracking',
  description_zh: '计费回执补齐累计投递次数、归类档位与可重投标记（重投次数可见）',
  up(db) {
    ensureColumn(db, 'charge_receipt', 'delivery_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'charge_receipt', 'kind', 'TEXT');
    ensureColumn(db, 'charge_receipt', 'retryable', 'INTEGER');
  },
};

/** v6：核查条目的统一错误码（与日志、回执行展示同一个码）。 */
const M6_CHECK_TASK_ERROR_CODE: Migration = {
  version: 6,
  name: 'check_task_error_code',
  description_zh: '核查条目补齐统一错误码：日志、核查条目、回执行展示同一个码',
  up(db) {
    ensureColumn(db, 'check_task', 'error_code', 'TEXT');
  },
};

/** v7：审计链的请求标识（状态迁移轨迹按 request_id 可回放）。 */
const M7_AUDIT_REQUEST_ID: Migration = {
  version: 7,
  name: 'audit_request_id',
  description_zh: '审计链补齐请求标识：扫码 → 计费回写 → 人工确认串成一条可回放轨迹',
  up(db) {
    ensureColumn(db, 'audit_chain', 'request_id', 'TEXT');
  },
};

/**
 * v8：事件日志、推送台账与进程元信息表。
 *
 * 事件日志是排障的一手材料，也是 replay 子命令重放事件的数据源；
 * 推送台账用批次键唯一，「同一批次最多推一条」靠它兜住；
 * meta 表放心跳与停机记录 —— 与审计链刻意分开（心跳覆盖写，不能污染只增不改的审计链）。
 */
const M8_EVENT_NOTIFY_META: Migration = {
  version: 8,
  name: 'event_notify_meta',
  description_zh: '补齐事件日志、推送台账与进程元信息三张表',
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS scan_event (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id         TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  source             TEXT NOT NULL,
  operation_no       TEXT,
  room_no            TEXT,
  scanner_id         TEXT,
  raw_body           TEXT,
  normalized_json    TEXT,
  signature_verified INTEGER NOT NULL DEFAULT 0,
  idempotency_key    TEXT,
  conclusion         TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_scan_event_received_at ON scan_event(received_at);
CREATE INDEX IF NOT EXISTS ix_scan_event_operation ON scan_event(operation_no, received_at);

CREATE TABLE IF NOT EXISTS notify_delivery (
  batch_key    TEXT PRIMARY KEY,
  operation_no TEXT,
  status       TEXT NOT NULL,
  error_code   TEXT,
  detail       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notify_delivery_status ON notify_delivery(status, created_at);

CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
  },
};

/**
 * v9：按真实查询路径补齐复合索引。
 *
 * 台账最常被问的四件事，各走一条查询路径：
 *   ① 按台次 + 耗材码查一条（关台核对、重复扫码定位）→ (operation_no, material_code)
 *   ② 按耗材码查这条耗材的全部历史（耗材管理岗对账）→ (material_code, created_at)
 *   ③ 按状态查待核查条目（护士长看待办）→ (status, created_at)
 *   ④ 按台次 + 时间窗查（关台后按时间段核对该台次用了什么）→ (operation_no, created_at)
 *
 * 四个索引都建成复合索引而不是单列索引：查询条件与排序都能被索引覆盖，
 * EXPLAIN QUERY PLAN 命中的是索引扫描而不是全表扫描 + 临时排序。
 */
const M9_COMPOSITE_QUERY_INDEXES: Migration = {
  version: 9,
  name: 'composite_query_indexes',
  description_zh: '按真实查询路径补齐四个复合索引：台次+耗材、耗材+时间、状态+时间、台次+时间',
  up(db) {
    db.exec(`
CREATE INDEX IF NOT EXISTS ix_material_binding_op_code
  ON material_binding(operation_no, material_code);
CREATE INDEX IF NOT EXISTS ix_material_binding_code_created
  ON material_binding(material_code, created_at);
CREATE INDEX IF NOT EXISTS ix_material_binding_status_created
  ON material_binding(status, created_at);
CREATE INDEX IF NOT EXISTS ix_material_binding_op_created
  ON material_binding(operation_no, created_at);
`);
  },
};

/**
 * 审计链「只增不改」的**库层护栏**：两条 BEFORE 触发器。
 *
 * 「只增不改」光靠接口层不导出 update / delete 是不够的 ——
 * 有库文件权限的人可以直接开 sqlite3 改行。触发器把这条约定落到数据库层：
 * 任何 UPDATE / DELETE 都被 RAISE(ABORT) 拒绝，报错信息里带表名，便于定位。
 *
 * 触发器是**第一道防线**，哈希链校验是**第二道防线**：
 *   第一道拦住在库内动手的（99% 的场景，直接报错）；
 *   第二道兜住绕过触发器的（有人拿 sqlite3 打开库文件改字节、
 *   或者从备份里恢复了一段旧数据）—— 这时链子在断点行号处当场断掉。
 *
 * 单独导出这条 SQL：单测里需要临时摘掉护栏来**模拟**绕过护栏的篡改，
 * 验证第二道防线确实能抓到（测完立刻装回去）。
 */
export const AUDIT_IMMUTABILITY_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_audit_chain_no_update
BEFORE UPDATE ON audit_chain
BEGIN
  SELECT RAISE(ABORT, 'audit_chain 只增不改：禁止 UPDATE（会打断哈希链）');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_chain_no_delete
BEFORE DELETE ON audit_chain
BEGIN
  SELECT RAISE(ABORT, 'audit_chain 只增不改：禁止 DELETE（会打断哈希链）');
END;
`;

/**
 * v10：审计链封印 —— 逐行哈希串联 + 库层只增不改护栏。
 *
 * 顺序很重要：**先封印（补算存量行的哈希），再上护栏**。
 * 反过来做的话，补算本身要 UPDATE 行，会被自己的触发器拦下。
 *
 * 封印口径：按 id 升序，第一行的 prev_hash 是创世哈希，其后每行背上一行的行哈希。
 * 存量行（升级前写下的）在这一步一次性补算成链 —— 手术室的历史台账不能因为
 * 升级就「变成不可验证的旧账」，补算后照样能自证没被动过。
 */
const M10_AUDIT_HASH_CHAIN: Migration = {
  version: 10,
  name: 'audit_chain_hash_chain',
  description_zh: '审计链封印：逐行哈希串联、存量行补算、库层触发器禁止 UPDATE / DELETE',
  up(db) {
    // 老库补记（legacy_backfill）只记履历、不重跑历史版本的 DDL，
    // 所以老库可能缺 v1–v7 加过的列 —— 本版要用到的列先补齐（幂等）。
    ensureColumn(db, 'audit_chain', 'prev_hash', 'TEXT');
    ensureColumn(db, 'audit_chain', 'row_hash', 'TEXT');
    ensureColumn(db, 'audit_chain', 'request_id', 'TEXT');

    // ① 先补算存量行（这一步要 UPDATE，所以必须在装触发器之前）
    sealAuditChain(db);

    // ② 再上护栏：此后任何 UPDATE / DELETE 都被拒绝
    db.exec(AUDIT_IMMUTABILITY_TRIGGER_SQL);
  },
};

/**
 * 给存量审计行补算哈希链（幂等：已封印的行不动）。
 *
 * 按 id 升序遍历：每一行的 prev_hash 取**上一行的 row_hash**（第一行取创世哈希）。
 * 存量行里已有 row_hash 的（新版程序写下的）直接跳过，但仍然要用它的 row_hash
 * 作为后继行的 prev_hash —— 链不能因为「跳过」而断。
 */
function sealAuditChain(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT id, event_type, binding_key, operation_no, scanner_id, actor, detail,
              request_id, created_at, prev_hash, row_hash
         FROM audit_chain ORDER BY id ASC`,
    )
    .all() as unknown as AuditContentRow[];

  const update = db.prepare('UPDATE audit_chain SET prev_hash = ?, row_hash = ? WHERE id = ?');
  let prevHash = GENESIS_HASH;

  for (const row of rows) {
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

    if (row.row_hash) {
      // 已封印的行：拿它的 row_hash 当后继的锚点（链不断）
      prevHash = row.row_hash;
      continue;
    }

    const sealed: AuditContent = { ...content, prev_hash: prevHash };
    const rowHash = computeRowHash(prevHash, sealed);
    update.run(prevHash, rowHash, row.id);
    prevHash = rowHash;
  }
}

/**
 * v11：幂等键版本化落到台账 —— 批号维度 + 历史行认领。
 *
 * 三件事：
 *
 *   ① 台账行补 `batch_no` 列 —— v2 档位的去重维度要落在行上，
 *      事后核对「这一笔用的是哪一批」才有据可查。
 *
 *   ② **历史行认领**：升级前写下的行键是 legacy 格式（`sha256(耗材码|台次)`），
 *      而新程序的 v1 档位键是 `sha256("v1|耗材码|台次")` —— 两者字节不同。
 *      迁移时按 legacy 原文把每行的键重算一遍，对得上的行标成 `legacy` 档位。
 *      这样「v1 / v2 两版键并存」时，老行仍然被同一把尺子（耗材码 + 台次）罩住：
 *      老行不会被当成新事件再计一笔（**旧行不被误判为新事件**）。
 *
 *   ③ 唯一防线跟着改口径：
 *      legacy + v1 仍是「同码同台次只一行」（老行与新行互相挡住）；
 *      v2 改为「同码同台次同批号只一行」（不同批号允许各记一行、各计一笔）。
 */
const M11_BINDING_KEY_VERSIONING: Migration = {
  version: 11,
  name: 'binding_key_versioning',
  description_zh: '幂等键版本化：台账行补批号维度，历史行认领为 legacy 档位，唯一防线按档位分口径',
  up(db) {
    // ① 批号维度落到行上
    ensureColumn(db, 'material_binding', 'batch_no', 'TEXT');

    // ② 历史行认领：键字节对得上 legacy 原文的行，标成 legacy 档位
    const rows = db
      .prepare(
        `SELECT id, idempotency_key, material_code, operation_no, key_profile
           FROM material_binding ORDER BY id ASC`,
      )
      .all() as unknown as Array<{
      id: number;
      idempotency_key: string;
      material_code: string;
      operation_no: string;
      key_profile: string | null;
    }>;

    const relabel = db.prepare('UPDATE material_binding SET key_profile = ? WHERE id = ?');
    for (const row of rows) {
      if (row.key_profile === LEGACY_IDEMPOTENCY_KEY_PROFILE) continue;
      const legacyKey = deriveLegacyIdempotencyKey(row.material_code, row.operation_no);
      if (row.idempotency_key === legacyKey) {
        relabel.run(LEGACY_IDEMPOTENCY_KEY_PROFILE, row.id);
      }
    }

    // ③ 唯一防线按档位分口径（索引名沿用，谓词换成新口径）
    db.exec('DROP INDEX IF EXISTS ux_material_binding_code_op');
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_material_binding_code_op
         ON material_binding(material_code, operation_no)
        WHERE key_profile IN ('legacy', 'v1')`,
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_material_binding_code_op_batch
         ON material_binding(material_code, operation_no, batch_no)
        WHERE key_profile = 'v2'`,
    );
  },
};

/**
 * v12：对账差异台账 + 计费载荷快照。
 *
 * 两件事一起落，因为它们是同一个业务问题（**关台核对时哪些耗材没有生成计费**）的两面：
 *
 *   ① **计费回执补载荷快照** —— 回执行只记「对端收没收」，不记「当时发出去的是什么」。
 *      没有快照就没法做字段级比对（台账现在写的数量 / 价码 / 费用口径，
 *      与计费侧实际收到的那一份是不是同一口径）。快照按**每次尝试**记 ——
 *      重投过几次，每次发出去的载荷都留痕，事后能追「第 2 次重投时口径改没改」。
 *
 *   ② **差异台账**（`reconcile_diff`）—— 台账 ↔ 计费回执逐条对齐后的差异落点：
 *      三类差异（台账有回执无 / 回执有台账无 / 两边都有但字段不一致）、
 *      每条的归因与建议处置、处置状态（待处理 / 已处理）、与核查任务的双向挂接。
 *      差异台账**不是**审计链：审计链只增不改，差异台账要能落「已处理」状态，
 *      所以它是工作台账，不进哈希链。
 *
 * 唯一索引 `ux_reconcile_diff_key` 保证同一条差异反复对账只留一行 ——
 * 差异键 = sha256(差异类型|耗材码|台次)，与时间戳、重跑次数无关。
 */
const M12_RECONCILE_DIFF: Migration = {
  version: 12,
  name: 'reconcile_diff_ledger',
  description_zh: '对账差异台账：台账 ↔ 计费回执三类差异落库；计费回执补载荷快照供字段级比对',
  up(db) {
    // ① 计费回执补载荷快照（当时实际发出去的那一份）
    ensureColumn(db, 'charge_receipt', 'submitted_quantity', 'REAL');
    ensureColumn(db, 'charge_receipt', 'submitted_price_code', 'TEXT');
    ensureColumn(db, 'charge_receipt', 'submitted_fee_category', 'TEXT');
    ensureColumn(db, 'charge_receipt', 'submitted_medical_insurance_class', 'TEXT');

    // ② 差异台账
    db.exec(`
CREATE TABLE IF NOT EXISTS reconcile_diff (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  diff_key                TEXT NOT NULL,
  diff_type               TEXT NOT NULL,
  attribution             TEXT NOT NULL,
  attribution_detail      TEXT,
  operation_no            TEXT NOT NULL,
  room_no                 TEXT,
  dept_code               TEXT,
  material_code           TEXT NOT NULL,
  quantity                REAL,
  ledger_quantity         REAL,
  receipt_quantity        REAL,
  ledger_price_code       TEXT,
  receipt_price_code      TEXT,
  ledger_fee_category     TEXT,
  receipt_fee_category    TEXT,
  ledger_insurance_class  TEXT,
  receipt_insurance_class TEXT,
  mismatched_fields       TEXT,
  suggested_action        TEXT NOT NULL,
  error_code              TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending',
  binding_id              INTEGER,
  receipt_id              INTEGER,
  check_task_id           INTEGER,
  attempt                 INTEGER,
  delivery_count          INTEGER,
  detected_at             TEXT NOT NULL,
  resolved_at             TEXT,
  resolved_by             TEXT,
  created_at              TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reconcile_diff_key ON reconcile_diff(diff_key);
CREATE INDEX IF NOT EXISTS ix_reconcile_diff_status ON reconcile_diff(status, detected_at);
CREATE INDEX IF NOT EXISTS ix_reconcile_diff_op ON reconcile_diff(operation_no, material_code);
`);

    // ③ 核查条目 ↔ 差异台账双向挂接（差异可直接生成核查任务）
    ensureColumn(db, 'check_task', 'reconcile_diff_id', 'INTEGER');
  },
};

/**
 * v13：码制解析轨迹落台账。
 *
 * 耗材码可能是 UDI / GS1 AI(01) / 院内码三种形态，归一后主数据键长得一样，
 * 但**「这个键是怎么来的」不一样** —— 是从 (01) 器械标识里取的 DI，还是院内码原样？
 * 校验位核对过没有？批次号从哪一段提取？
 *
 * 没有这些轨迹，事后核对只能靠回忆：「这条耗材到底扫的是哪个包装」。
 * 补两列：
 *   ① `code_form` —— 码制（UDI / GS1_AI01 / INTERNAL），可按码制查「哪类码扫得最多」；
 *   ② `code_parse_trace` —— 解析轨迹 JSON（DI / 批号 / 序列号 / 失效期**类别** /
 *      GTIN 校验位核对结论 / 码段清单 / 解析问题）。
 *
 * **轨迹里不落具体失效期日期**，只落类别（长期有效 / 有失效期 / 已过期 / 未知）。
 */
const M13_CODE_PARSE_TRACE: Migration = {
  version: 13,
  name: 'code_parse_trace',
  description_zh: '码制解析轨迹落台账：补码制列与解析轨迹列（失效期只落类别，不落具体日期）',
  up(db) {
    ensureColumn(db, 'material_binding', 'code_form', 'TEXT');
    ensureColumn(db, 'material_binding', 'code_parse_trace', 'TEXT');
    db.exec(
      `CREATE INDEX IF NOT EXISTS ix_material_binding_code_form
         ON material_binding(code_form, created_at)`,
    );
  },
};

/**
 * v14：数量与计价单位换算。
 *
 * 四件事一起落，因为它们是同一个业务问题（**扫码扫的是包装，HIS 收的是计价单位**）的四面：
 *
 *   ① **耗材主数据补四列** —— `unit_pack`（包装单位）/ `unit_min`（最小单位）/
 *      `charge_unit`（计价单位）/ `ratio`（1 个包装 = ratio 个计价单位）。
 *      这四列由院内耗材主数据维护，导入器逐行做自洽性检查（见 `src/engine/units.ts`）。
 *
 *   ② **台账补两列** —— `charge_quantity`（计价数量，计费回写用这个数）
 *      与 `quantity_trace`（换算轨迹 JSON：原始数量 / 包装单位 / 系数 / 计价数量）。
 *      **原始数量与换算轨迹都留着** —— 关台核对与月度对账时要能回答
 *      「这一笔到底按几支算的、凭什么」。
 *
 *   ③ **主数据待补录清单** —— `master_data_gap` 表：单位口径缺项 / 系数非整数 /
 *      口径不自洽的耗材在**导入时**就登记在这里，不留到运行期才炸。
 *
 *   ④ **老库按 1:1 补齐** —— 升级前写下的耗材行没有单位列。**按 1:1 补齐**而不是留空：
 *      升级前的计费口径本来就是「扫几个就计几个」（数量原样传给 HIS），
 *      1:1 补齐**逐条保持升级前的计费行为不变**（不制造新的错账）；
 *      同时给每条补齐行登记一条 `UNIT_RATIO_ASSUMED` 待补录 ——
 *      **假定值不是静默的**：耗材管理岗在清单上能逐条看到「这行是按 1:1 假定的，
 *      要核对实际包装规格」。
 */
const M14_UNIT_CONVERSION: Migration = {
  version: 14,
  name: 'unit_conversion',
  description_zh:
    '单位换算：耗材主数据补包装/最小/计价单位与换算系数；台账补计价数量与换算轨迹；主数据待补录清单；老库按 1:1 补齐并登记待补录',
  up(db) {
    // ① 耗材主数据补四列
    ensureColumn(db, 'material', 'unit_pack', 'TEXT');
    ensureColumn(db, 'material', 'unit_min', 'TEXT');
    ensureColumn(db, 'material', 'charge_unit', 'TEXT');
    ensureColumn(db, 'material', 'ratio', 'REAL');

    // ② 台账补两列
    ensureColumn(db, 'material_binding', 'charge_quantity', 'REAL');
    ensureColumn(db, 'material_binding', 'quantity_trace', 'TEXT');

    // ③ 主数据待补录清单
    db.exec(`
CREATE TABLE IF NOT EXISTS master_data_gap (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  material_code TEXT NOT NULL,
  gap_type      TEXT NOT NULL,
  detail        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  detected_at   TEXT NOT NULL,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_master_data_gap_material ON master_data_gap(material_code);
`);

    // ④ 老库按 1:1 补齐（保持升级前的计费口径不变），并登记待补录
    backfillLegacyUnitMapping(db);
  },
};

/**
 * v15：费用类别与医保分类口径。
 *
 * 待补录清单的唯一键从 **material_code** 改成 **(material_code, gap_type)**：
 *
 * 原来一条耗材只能留一条缺口，于是「单位口径缺换算系数」与「费用类别落在药品类」
 * 这两类问题**互相顶掉**—— 先记下的那条把后记的那条覆盖了，耗材管理岗在清单上
 * 只能看到一半问题，改完一半另一半又冒出来。
 *
 * 改成按 (material_code, gap_type) 唯一后：
 *   - 同一条耗材可以同时挂「单位口径」与「费用口径」两类缺口；
 *   - 销项也按类型销 —— 补好了单位口径**不会**把还没修的费用口径那条一起销掉；
 *   - 老库的行一条都不丢（只换索引，不动数据）。
 */
const M15_FEE_CATEGORY_POLICY: Migration = {
  version: 15,
  name: 'fee_category_policy',
  description_zh:
    '费用类别与医保分类口径：待补录清单唯一键改为「耗材码 + 缺口类型」，单位口径与费用口径的缺口可并存',
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS master_data_gap (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  material_code TEXT NOT NULL,
  gap_type      TEXT NOT NULL,
  detail        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  detected_at   TEXT NOT NULL,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL
);
DROP INDEX IF EXISTS ux_master_data_gap_material;
CREATE UNIQUE INDEX IF NOT EXISTS ux_master_data_gap_material_type
  ON master_data_gap(material_code, gap_type);
`);
  },
};

/**
 * 老库耗材行按 1:1 补齐单位口径（幂等）。
 *
 * 只补**完全没有单位信息**的行（ratio 为空）：已登记过口径的行一个都不动。
 * 补齐的行会登记 `UNIT_RATIO_ASSUMED` 待补录 —— 假定值必须出现在清单上，
 * 不能悄悄按 1:1 计费了事。
 */
function backfillLegacyUnitMapping(db: DatabaseSync): void {
  if (!tableExists(db, 'material')) return;

  const rows = db
    .prepare(
      `SELECT material_code FROM material
        WHERE ratio IS NULL
          AND (unit_pack IS NULL OR TRIM(unit_pack) = '')
          AND (unit_min IS NULL OR TRIM(unit_min) = '')
          AND (charge_unit IS NULL OR TRIM(charge_unit) = '')`,
    )
    .all() as unknown as Array<{ material_code: string }>;

  if (rows.length === 0) return;

  const update = db.prepare(
    `UPDATE material
        SET unit_pack = ?, unit_min = ?, charge_unit = ?, ratio = ?
      WHERE material_code = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO master_data_gap (material_code, gap_type, detail, status, detected_at, resolved_at, created_at)
     VALUES (?, 'UNIT_RATIO_ASSUMED', ?, 'pending', ?, NULL, ?)
     ON CONFLICT(material_code) DO UPDATE SET
       gap_type = excluded.gap_type,
       detail = excluded.detail,
       status = 'pending',
       detected_at = excluded.detected_at,
       resolved_at = NULL`,
  );

  const now = new Date().toISOString();
  for (const row of rows) {
    update.run('支', '支', '支', 1, row.material_code);
    insert.run(
      row.material_code,
      '老库升级按 1:1 假定补齐单位口径（保持升级前计费行为不变）；请耗材管理岗核对实际包装规格与换算系数',
      now,
      now,
    );
  }
}

/**
 * 主数据导入履历（v16）：**每次导入一行**，含版本号、导入前后行数与逐条跳过原因。
 *
 * 为什么要有这张表：耗材主数据与手术排台**天天在变**（新耗材建档、耗材停用、临时加台、
 * 提前关台）。变更是「导入即生效、不重启」的 —— 这就带来一个必然的问题：
 * **现在台账里用的是哪一版主数据？上一次导入是什么时候？跳过了哪些行、为什么？**
 * 没有这张表，出了「这台手术的耗材价码不对」的问题没人说得清是哪一版数据判的。
 *
 * 口径：
 *   ① **版本号每次成功导入 +1** —— 版本号就是「主数据的代际」，判定结果可回溯到代际；
 *   ② **导入前后行数都记** —— 一眼看出这次导入是「新增了一批」还是「改了几条」；
 *   ③ **逐条跳过原因进 detail（JSON）** —— 坏行不拖垮整份文件，但原因要留下来给耗材管理岗；
 *   ④ **历史行不删** —— 导入是 upsert + 失效标记（active=false / status=closed），
 *      不物理删除，履历只增不改。
 */
const M16_MASTER_DATA_IMPORT_LOG: Migration = {
  version: 16,
  name: 'master_data_import_log',
  description_zh:
    '主数据导入履历：版本号、导入前后行数、逐条跳过原因（导入即生效，版本可回溯）',
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS master_data_import (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  version            INTEGER NOT NULL,
  imported_at        TEXT NOT NULL,
  source             TEXT NOT NULL,
  operation_rows     INTEGER NOT NULL DEFAULT 0,
  operation_inserted INTEGER NOT NULL DEFAULT 0,
  operation_updated  INTEGER NOT NULL DEFAULT 0,
  operation_skipped  INTEGER NOT NULL DEFAULT 0,
  operations_before  INTEGER NOT NULL DEFAULT 0,
  operations_after   INTEGER NOT NULL DEFAULT 0,
  material_rows      INTEGER NOT NULL DEFAULT 0,
  material_inserted  INTEGER NOT NULL DEFAULT 0,
  material_updated   INTEGER NOT NULL DEFAULT 0,
  material_skipped   INTEGER NOT NULL DEFAULT 0,
  materials_before   INTEGER NOT NULL DEFAULT 0,
  materials_after    INTEGER NOT NULL DEFAULT 0,
  detail             TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_master_data_import_version
  ON master_data_import(version);
`);
  },
};

/**
 * 台次归属双因子留痕（v17）：台账与核查条目都存**核对的两侧**。
 *
 * 归属核对要判的是「事件说的手术间 / 科室」与「排台说的手术间 / 科室」是否一致。
 * 只留一句「归属冲突」是不够的 —— 事后复盘时要看的是**对的是哪两个值**：
 * 事件说 OR-05、排台说 OR-01，到底是台次挂错了还是枪挪了间，看得见才查得动。
 *
 * 口径：
 *   ① `material_binding` 增 `event_room_no` / `master_room_no` / `event_dept_code` ——
 *      绑上的行留痕「当时核过的那两个手术间」；
 *   ② `check_task` 增同样四列 —— 冲突条目进核查清单时带着两侧值，
 *      护士长不用回头翻日志就知道差在哪；
 *   ③ **历史行不补值**：老行是升级前写的，当时没做过归属核对，
 *      补一个「看起来核对过」的值等于伪造事实 —— 留空即「未核对」。
 */
const M17_ATTRIBUTION_CROSS_CHECK: Migration = {
  version: 17,
  name: 'attribution_cross_check',
  description_zh:
    '台次归属双因子留痕：台账与核查条目都存事件侧与排台侧的手术间 / 科室（历史行留空 = 未核对）',
  up(db) {
    ensureColumn(db, 'material_binding', 'event_room_no', 'TEXT');
    ensureColumn(db, 'material_binding', 'master_room_no', 'TEXT');
    ensureColumn(db, 'material_binding', 'event_dept_code', 'TEXT');
    ensureColumn(db, 'check_task', 'event_room_no', 'TEXT');
    ensureColumn(db, 'check_task', 'master_room_no', 'TEXT');
    ensureColumn(db, 'check_task', 'event_dept_code', 'TEXT');
    ensureColumn(db, 'check_task', 'master_dept_code', 'TEXT');
  },
};

/**
 * 出站幂等键透传留痕（v18）：回执行记下**请求级键**与**对端回显状态**。
 *
 * 本侧把幂等键透传给 HIS 计费侧后，事后要能回答两个问题：
 *   ① 「这条计费是哪一次提交带来的」→ `request_idempotency_key`（整批提交的去重键）；
 *   ② 「对端到底认没认这把键」→ `peer_idempotency_status`
 *      （ECHOED 已启用幂等 / NOT_ECHOED 对端未启用幂等 / MISMATCH 两端口径不一致）。
 *
 * 口径：**历史行留空 = 未透传**。升级前的回执行没有这两列的事实，
 * 补一个「看起来对端确认过」的值等于伪造事实 —— 留空即「当时没这项信息」。
 */
const M18_OUTBOUND_IDEMPOTENCY_PASSTHROUGH: Migration = {
  version: 18,
  name: 'outbound_idempotency_passthrough',
  description_zh:
    '出站幂等键透传留痕：回执行记请求级键与对端回显状态（历史行留空 = 未透传）',
  up(db) {
    ensureColumn(db, 'charge_receipt', 'request_idempotency_key', 'TEXT');
    ensureColumn(db, 'charge_receipt', 'peer_idempotency_status', 'TEXT');
  },
};

/**
 * 迁移 v19：回执落**处置档位**。
 *
 * 回执行原来只有 `retryable`（能不能重投）这一个布尔位，事后回看分不出
 * 「直接转人工的价码缺失」与「进过退避队列的临时拒收」—— 两者的处置完全不同，
 * 护士长看到的待办也不该混在一起。本列把三档判定（可重投 / 不可重投 / 需人工）
 * 原样落库：历史行留空 = 落库时还没有档位这一说。
 */
const M19_RECEIPT_DISPOSITION: Migration = {
  version: 19,
  name: 'receipt_disposition',
  description_zh: '计费回执落处置档位（可重投 / 不可重投 / 需人工；历史行留空）',
  up(db) {
    ensureColumn(db, 'charge_receipt', 'disposition', 'TEXT');
  },
};

/**
 * 迁移 v20：出站载荷清洗留痕。
 *
 * 台账行记一份「归一前后对照」JSON（哪个字段改了什么）：全角转半角、去零宽字符、
 * 折叠空白都会写进去。为什么要留痕 —— 出站载荷被清洗过这件事，
 * 事后必须能查得到「发出去的那一笔和台账里那一笔差在哪」，
 * 否则对账差异归因时就没法说清是主数据改了还是清洗改了。
 * 历史行留空 = 落库时还没有这一层清洗。
 */
const M20_CHARGE_PAYLOAD_SANITIZE: Migration = {
  version: 20,
  name: 'charge_payload_sanitize',
  description_zh: '出站载荷清洗留痕：台账行记归一前后对照（历史行留空）',
  up(db) {
    ensureColumn(db, 'material_binding', 'sanitize_trace', 'TEXT');
  },
};

/**
 * 迁移 v21：计费尝试史留痕（补齐五要素 + 历史行回填并标注）。
 *
 * 回执行要能回答「这条耗材到底试了几次、每次错在哪」，
 * 靠的是五个字段：**尝试序号 / 请求时间 / 响应时间 / 错误码 / 通道可达性**。
 * 老库里有几行是早期写的 —— 尝试序号一律 1（列的默认值），请求与响应时间没记，
 * 错误码与通道可达性也可能是空的。直接看这些行会得出错误结论
 * （比如「只投过 1 次」其实投过 3 次），所以这一版做**回填**：
 *
 *   - 尝试序号：按（耗材码 + 台次）内的**落账顺序**重算 —— 与现行口径一致；
 *   - 请求 / 响应时间：缺则按落账时间补记（注明是补记，不是当时真记的）；
 *   - 通道可达性：按归类档位推导（对端给了结论 = 当时通道是通的）；
 *   - 错误码：**回填不了就不填**（不编造错误码），留空并在备注里说清。
 *
 * 回填过的行标 `attempt_source = 'recovered'`，并留一句中文备注
 * （`history_note`）；**原生记录**的行标 `'native'`、备注留空。
 * 迁移幂等：只处理 `attempt_source IS NULL` 的行（老行），跑第二遍不重复改。
 */
const M21_RECEIPT_ATTEMPT_HISTORY: Migration = {
  version: 21,
  name: 'receipt_attempt_history',
  description_zh: '计费尝试史五要素补齐：历史行回填尝试序号与时间并标注（回填不了就留空）',
  up(db) {
    ensureColumn(db, 'charge_receipt', 'attempt_source', 'TEXT');
    ensureColumn(db, 'charge_receipt', 'history_note', 'TEXT');
    if (!tableExists(db, 'charge_receipt')) return;

    // 只处理「没被本迁移碰过」的行：跑第二遍时这些行已有 attempt_source，直接跳过
    const rows = db
      .prepare(
        `SELECT id, material_code, operation_no, attempt, requested_at, responded_at,
                error_code, channel_reachable, kind, created_at
           FROM charge_receipt
          WHERE attempt_source IS NULL
          ORDER BY id ASC`,
      )
      .all() as unknown as Array<{
      id: number;
      material_code: string;
      operation_no: string;
      attempt: number | null;
      requested_at: string | null;
      responded_at: string | null;
      error_code: string | null;
      channel_reachable: number | null;
      kind: string | null;
      created_at: string;
    }>;
    if (rows.length === 0) return;

    // 归类档位 → 通道当时可达否（与 `src/charge/receipt.ts` 的定性口径一致）
    const reachableByKind: Record<string, 0 | 1> = {
      ACCEPTED: 1,
      BUSINESS_REJECTED: 1,
      CHANNEL_ERROR: 1,
      CHANNEL_UNREACHABLE: 0,
      PROTOCOL_ERROR: 0,
      LOCAL_ERROR: 0,
    };

    // 按（耗材码 + 台次）分组，组内按落账顺序重算尝试序号
    const seqByItem = new Map<string, number>();
    const update = db.prepare(
      `UPDATE charge_receipt
          SET attempt = ?, requested_at = ?, responded_at = ?, channel_reachable = ?,
              attempt_source = 'recovered', history_note = ?
        WHERE id = ?`,
    );

    for (const row of rows) {
      const itemKey = `${row.material_code} ${row.operation_no}`;
      const seq = (seqByItem.get(itemKey) ?? 0) + 1;
      seqByItem.set(itemKey, seq);

      const notes: string[] = [];
      // 尝试序号：与落账顺序不一致 = 老行没记准（老库一律是列默认值 1），按顺序重算
      const attempt = row.attempt === seq ? row.attempt : seq;
      if (row.attempt !== seq) notes.push('尝试序号按落账顺序回填');

      // 请求 / 响应时间：缺则按落账时间补记
      const requestedAt = row.requested_at ?? row.created_at;
      if (!row.requested_at) notes.push('请求时间按落账时间补记');
      const respondedAt = row.responded_at ?? row.created_at;
      if (!row.responded_at) notes.push('响应时间按落账时间补记');

      // 通道可达性：能按归类档位推导就推导；推导不了就留空（不猜）
      let channelReachable = row.channel_reachable;
      if (channelReachable === null || channelReachable === undefined) {
        const derived = row.kind ? reachableByKind[row.kind] : undefined;
        if (derived === undefined) {
          channelReachable = null;
          notes.push('通道可达性无法回填（留空）');
        } else {
          channelReachable = derived;
          notes.push('通道可达性按归类档位推导');
        }
      }

      // 错误码：**回填不了就留空** —— 不编造一个错误码出来
      if (!row.kind) {
        notes.push('历史行未记录归类档位');
      } else if (!row.error_code && row.kind !== 'ACCEPTED') {
        notes.push('历史行缺错误码（留空）');
      }

      update.run(
        attempt,
        requestedAt,
        respondedAt,
        channelReachable,
        notes.length > 0 ? notes.join('；') : '历史回执：按落账顺序与落账时间补记',
        row.id,
      );
    }
  },
};

/**
 * 核查任务责任岗位路由（v22）：补齐五列 + 建路由扫描索引。
 *
 * 五列（assignee_role / assigned_at / reminded_at / escalated_at / timeout_level）
 * 在 v1 基线里就有 —— 本迁移用 `ensureColumn` **再补一遍**：
 * 万一有更早的台账库是从别处导过来的（缺列），补上即可，不必重建库。
 *
 * 索引 `ix_check_task_routing` 服务两件事：
 *   ① 周期扫描「待处理 + 已分派 + 未提醒」的条目（提醒扫描）；
 *   ② 按责任岗位分组统计待办（doctor 视图）。
 */
const M22_CHECK_TASK_ROUTING: Migration = {
  version: 22,
  name: 'check_task_routing',
  description_zh: '核查任务责任岗位路由：补齐分派/提醒/升级五列并建路由扫描索引',
  up(db) {
    ensureColumn(db, 'check_task', 'assignee_role', 'TEXT');
    ensureColumn(db, 'check_task', 'assigned_at', 'TEXT');
    ensureColumn(db, 'check_task', 'reminded_at', 'TEXT');
    ensureColumn(db, 'check_task', 'escalated_at', 'TEXT');
    ensureColumn(db, 'check_task', 'timeout_level', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`
CREATE INDEX IF NOT EXISTS ix_check_task_routing
  ON check_task(status, assignee_role, reminded_at, timeout_level);
`);
  },
};

/**
 * 迁移 v23：事件日志补「批次号」列 + 区间重放索引。
 *
 * 重放要能按三种口径选区间 —— **时间窗 / 台次 / 批次号**。
 * 前两种靠已有列就能筛，批次号没有：事件日志原来只记 request_id 与来源，
 * 记不住「这一批是设备侧的第几批」。补一列 `batch_id`：
 *   - 扫码枪 HTTP 路 = 本次投递标识（一个 POST 就是一批）；
 *   - RFID 目录投递路 = 投递文件名（设备侧给的批次号就是文件名）。
 *
 * 历史行留空 = 落库时还没有批次号这一说，**不猜**。
 */
const M23_REPLAY_INTERVAL_SELECTION: Migration = {
  version: 23,
  name: 'replay_interval_selection',
  description_zh: '事件日志补批次号列并建区间重放索引（按批次 / 时间窗选重放区间）',
  up(db) {
    ensureColumn(db, 'scan_event', 'batch_id', 'TEXT');
    db.exec(`
CREATE INDEX IF NOT EXISTS ix_scan_event_batch
  ON scan_event(batch_id, received_at);
`);
  },
};

/**
 * 迁移 v24：入站重放防护的 nonce 去重表。
 *
 * 为什么要落盘而不是放内存：常驻守护进程重启后内存里的 nonce 记录会清零，
 * 抓包重放正好趁重启混进来；落盘则**重启不丢**，TTL 到了由清理周期回收。
 *
 * 表里只留 nonce 本身与时间，不留报文内容 —— 这张表回答的是
 * 「这个 nonce 见过没有、什么时候过期」，不回答「这个批次扫了什么」。
 */
const M24_REPLAY_NONCE_GUARD: Migration = {
  version: 24,
  name: 'replay_nonce_guard',
  description_zh: '入站重放防护的 nonce 去重表（TTL 内同一 nonce 只放行一次）',
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS replay_nonce (
  nonce         TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  source        TEXT
);

CREATE INDEX IF NOT EXISTS ix_replay_nonce_expires
  ON replay_nonce(expires_at);
`);
  },
};

/**
 * v25：事件日志的溯源索引与耗材码关联表。
 *
 * 事件日志原来只有「按台次 / 按批次 / 按时间窗」三条查询路径，缺两条排障时最先问的：
 *
 *   ① **「这一批到底发生了什么」** —— 按 request_id 查。request_id 是本次投递的标识，
 *      事件日志、台账行、审计行三边都带它，缺了索引就只能全表扫；
 *   ② **「这个耗材码都出过什么事」** —— 按耗材码查全部事件序列。
 *      事件日志一行是**一批**（一批 5–8 条耗材），一个码落在哪一批要能反查，
 *      所以另立 `scan_event_material` 关联表（事件行 ↔ 耗材码），
 *      而不是把码塞进 JSON 里再 LIKE 扫。
 *
 * 另外给台账行补 `request_id` 列：台账行原先不知道自己是被哪一次投递带进来的，
 * 「扫码 → 台账 → 计费 → 人工确认」这条线因此接不上。
 *
 * 口径：
 *   - 补列一律走 `ensureColumn`（幂等）；老库升级**不丢历史行**，历史行 request_id 为空；
 *   - 关联表只存耗材码与事件行 id，**不落患者可识别明细**（与事件日志同口径）。
 */
const M25_EVENT_LOG_TRACEABILITY: Migration = {
  version: 25,
  name: 'event_log_traceability',
  description_zh: '事件日志溯源：request_id 索引 + 耗材码关联表 + 台账行补 request_id',
  up(db) {
    // ① 按投递标识查事件（一次投递 = 一行事件）
    db.exec(`
CREATE INDEX IF NOT EXISTS ix_scan_event_request
  ON scan_event(request_id, received_at);
`);
    // ② 事件行 ↔ 耗材码关联表（一个码可落在多个批次里）
    db.exec(`
CREATE TABLE IF NOT EXISTS scan_event_material (
  event_id      INTEGER NOT NULL,
  material_code TEXT NOT NULL,
  code_kind     TEXT NOT NULL DEFAULT 'canonical',
  PRIMARY KEY (event_id, material_code, code_kind)
);

CREATE INDEX IF NOT EXISTS ix_scan_event_material_code
  ON scan_event_material(material_code, event_id);
`);
    // ③ 台账行记住「是哪一次投递带进来的」
    ensureColumn(db, 'material_binding', 'request_id', 'TEXT');
    db.exec(`
CREATE INDEX IF NOT EXISTS ix_material_binding_request
  ON material_binding(request_id, created_at);
`);
    // ④ 审计链按投递标识查（处置轨迹回放）
    //    先确保列在：老库从 v7 补记上来时可能压根没有 request_id 列（M7 的 DDL 不会重跑），
    //    列不在就先补列再建索引 —— 索引建在缺列的表上会直接失败。
    ensureColumn(db, 'audit_chain', 'request_id', 'TEXT');
    db.exec(`
CREATE INDEX IF NOT EXISTS ix_audit_chain_request
  ON audit_chain(request_id, created_at);
`);
  },
};

/**
 * 迁移 v26：台账行补**业务使用时间**（`use_time`）。
 *
 * 为什么要有这一列：
 *   月度对账要按「耗材实际使用的月份」切账期，而不是按「台账落账的月份」——
 *   3 月 31 日 23:59 扫的耗材，4 月 1 日 00:05 才落进台账，
 *   按落账月切就会把它算进 4 月，账期对不上。
 *
 * 口径：
 *   - `use_time` 取设备上报的扫码时间（归一后落库），老行没有这一列的值时为空；
 *   - 账期月份按 **Asia/Shanghai** 计算（见 `src/ledger/monthly.ts`）；
 *   - 补列走 `ensureColumn`（幂等），老库升级**不丢历史行**。
 */
const M26_BINDING_USE_TIME: Migration = {
  version: 26,
  name: 'binding_use_time',
  description_zh: '台账行补业务使用时间（use_time）+ 按科室与账期聚合的索引',
  up(db) {
    ensureColumn(db, 'material_binding', 'use_time', 'TEXT');
    db.exec(`
CREATE INDEX IF NOT EXISTS ix_material_binding_dept_use_time
  ON material_binding(dept_code, use_time);
`);
    // 老库回填：历史行没有业务时间时，用落账时间兜底（账期口径不倒退）
    db.exec(`
UPDATE material_binding
   SET use_time = created_at
 WHERE use_time IS NULL
   AND created_at IS NOT NULL;
`);
  },
};

/** 迁移链（按版本号升序；追加新版本时只往后加，不改老版本） */
export const MIGRATIONS: readonly Migration[] = [
  M1_BASE_LEDGER,
  M2_IDEMPOTENCY_CLAIM,
  M3_BINDING_KEY_PROFILE,
  M4_CHECK_TASK_CONTEXT,
  M5_RECEIPT_DELIVERY_TRACKING,
  M6_CHECK_TASK_ERROR_CODE,
  M7_AUDIT_REQUEST_ID,
  M8_EVENT_NOTIFY_META,
  M9_COMPOSITE_QUERY_INDEXES,
  M10_AUDIT_HASH_CHAIN,
  M11_BINDING_KEY_VERSIONING,
  M12_RECONCILE_DIFF,
  M13_CODE_PARSE_TRACE,
  M14_UNIT_CONVERSION,
  M15_FEE_CATEGORY_POLICY,
  M16_MASTER_DATA_IMPORT_LOG,
  M17_ATTRIBUTION_CROSS_CHECK,
  M18_OUTBOUND_IDEMPOTENCY_PASSTHROUGH,
  M19_RECEIPT_DISPOSITION,
  M20_CHARGE_PAYLOAD_SANITIZE,
  M21_RECEIPT_ATTEMPT_HISTORY,
  M22_CHECK_TASK_ROUTING,
  M23_REPLAY_INTERVAL_SELECTION,
  M24_REPLAY_NONCE_GUARD,
  M25_EVENT_LOG_TRACEABILITY,
  M26_BINDING_USE_TIME,
];

/** 链尾版本号（本程序支持的台账 schema 版本） */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/* ── 履历表 ────────────────────────────────────────────────────────────── */

/** 迁移履历的一行 */
export interface MigrationHistoryRow {
  version: number;
  name: string;
  applied_at: string;
  /** 应用来源：本链执行 / 老库按 user_version 补记 */
  source: 'chain' | 'legacy_backfill';
}

const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'chain'
);`;

/** 建履历表（幂等） */
export function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(MIGRATIONS_TABLE_SQL);
}

/** 读台账当前版本（user_version 版本指针） */
export function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/** 读迁移履历（按版本升序） */
export function migrationHistory(db: DatabaseSync): MigrationHistoryRow[] {
  ensureMigrationsTable(db);
  return db
    .prepare('SELECT version, name, applied_at, source FROM migrations ORDER BY version ASC')
    .all() as unknown as MigrationHistoryRow[];
}

/* ── 错误 ──────────────────────────────────────────────────────────────── */

/** 迁移失败（该版本已回滚，版本号未前移） */
export class MigrationError extends Error {
  readonly code = 'ERR_MIGRATION_FAILED';

  constructor(
    /** 失败的那一版版本号 */
    readonly version: number,
    /** 失败的那一版版本名 */
    readonly migrationName: string,
    /** 失败原因（原始异常消息） */
    readonly reason: string,
  ) {
    super(`台账迁移失败：版本 ${version}（${migrationName}）—— ${reason}`);
    this.name = 'MigrationError';
  }
}

/** 台账版本比程序新（降级跑会写坏新表结构，拒绝启动） */
export class SchemaVersionError extends Error {
  readonly code = 'ERR_SCHEMA_TOO_NEW';

  constructor(
    /** 库上的版本 */
    readonly onDisk: number,
    /** 本程序支持的版本 */
    readonly supported: number,
  ) {
    super(`台账库版本 ${onDisk} 高于本程序支持的 ${supported}，请升级程序后再启动`);
    this.name = 'SchemaVersionError';
  }
}

/* ── 执行 ──────────────────────────────────────────────────────────────── */

/** 一次迁移的结果 */
export interface MigrationResult {
  /** 升级前的版本号 */
  from: number;
  /** 升级后的版本号 */
  to: number;
  /** 本次真正执行的版本 */
  applied: MigrationHistoryRow[];
  /** 已是最新而跳过的版本数 */
  skipped: number;
  /** 履历表总行数 */
  history_rows: number;
}

/** 迁移选项 */
export interface MigrationOptions {
  /** 只升到该版本为止（默认升到链尾；测试用） */
  targetVersion?: number;
  /** 注入自定义迁移链（测试用：造一个必失败的版本） */
  chain?: readonly Migration[];
}

/**
 * 把台账升到链尾版本。
 *
 * 逐版本升级：**每一版各自一个事务**，成功一版提交一版；
 * 某一版失败 → 该版回滚 → 版本号不前移 → 抛 MigrationError（带版本号与原因）。
 * 已是最新则一个版本都不动（`applied` 为空，版本号不变）。
 */
export function applyMigrations(
  db: DatabaseSync,
  options: MigrationOptions = {},
): MigrationResult {
  const chain = [...(options.chain ?? MIGRATIONS)].sort((a, b) => a.version - b.version);
  const latest = chain.length > 0 ? chain[chain.length - 1]!.version : 0;
  const target = options.targetVersion ?? latest;

  ensureMigrationsTable(db);

  const from = currentSchemaVersion(db);
  if (from > latest) {
    // 库比程序新：降级跑会把新表结构写坏，拒绝启动
    throw new SchemaVersionError(from, latest);
  }

  // 老库补记：迁移链建立之前创建的台账，履历表是空的 ——
  // 按 user_version 把「已经应用的版本」补记进履历，别把老版本当成没做过。
  backfillHistory(db, chain, from);

  const applied: MigrationHistoryRow[] = [];
  for (const migration of chain) {
    if (migration.version <= from) continue;
    if (migration.version > target) break;
    applied.push(runMigration(db, migration));
  }

  const to = currentSchemaVersion(db);
  return {
    from,
    to,
    applied,
    skipped: chain.filter((m) => m.version <= from && m.version <= target).length,
    history_rows: migrationHistory(db).length,
  };
}

/**
 * 跑一版迁移：事务内执行 + 记履历 + 推版本号；失败则回滚并抛 MigrationError。
 *
 * 版本号（user_version）在**事务内**推进 —— SQLite 的 user_version 写在库文件头里，
 * 随事务一起回滚，所以失败后版本号一定停在原来那一版（不前移）。
 */
function runMigration(db: DatabaseSync, migration: Migration): MigrationHistoryRow {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN');
  try {
    migration.up(db);
    db.prepare(
      `INSERT OR IGNORE INTO migrations (version, name, applied_at, source)
       VALUES (?, ?, ?, 'chain')`,
    ).run(migration.version, migration.name, new Date().toISOString());
    db.exec(`PRAGMA user_version = ${migration.version}`);
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败时保留原始异常：失败不静默改数据
      }
    }
    throw new MigrationError(
      migration.version,
      migration.name,
      error instanceof Error ? error.message : String(error),
    );
  }

  const row = db
    .prepare('SELECT version, name, applied_at, source FROM migrations WHERE version = ?')
    .get(migration.version) as unknown as MigrationHistoryRow | undefined;
  return (
    row ?? {
      version: migration.version,
      name: migration.name,
      applied_at: new Date().toISOString(),
      source: 'chain',
    }
  );
}

/** 老库补记：把 user_version 已覆盖、但履历表里没有的版本补上（source = legacy_backfill） */
function backfillHistory(db: DatabaseSync, chain: readonly Migration[], from: number): void {
  const now = new Date().toISOString();
  for (const migration of chain) {
    if (migration.version > from) break;
    db.prepare(
      `INSERT OR IGNORE INTO migrations (version, name, applied_at, source)
       VALUES (?, ?, ?, 'legacy_backfill')`,
    ).run(migration.version, migration.name, now);
  }
}
