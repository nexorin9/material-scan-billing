# 审计链哈希链口径（audit-chain）

> 审计链不只是「记了些什么」，还要能当场证明「这份记录没被人动过」。

## 一句话口径

每一行审计记录都背着一枚哈希：**本行哈希 = sha256(上一行哈希 | 规范化行内容)**。
改一行、删一行，链子在那一行断掉，断点行号当场指出。

## 为什么两道防线

| 防线 | 位置 | 拦什么 | 表现 |
|---|---|---|---|
| 第一道：库层护栏 | SQLite 触发器（`trg_audit_chain_no_update` / `trg_audit_chain_no_delete`） | 在库里动手的（直接 `UPDATE` / `DELETE`） | 操作被 `RAISE(ABORT)` 拒绝，报错信息含 `audit_chain 只增不改` |
| 第二道：哈希链校验 | `verifyChain()`（`src/ledger/audit.ts`） | 绕过护栏的（直接改库文件、从备份恢复旧数据） | 校验不通过，给出**断点行号**与期望 / 实际哈希 |

第一道拦不住「有库文件权限的人直接改字节」——所以必须有第二道。
反过来也一样：只靠第二道，库里改行会留下一堆无痕改动，运维看不出发生过什么。

## 表结构

`audit_chain` 在 v10 迁移（`audit_chain_hash_chain`）里补齐两列：

| 列 | 含义 |
|---|---|
| `prev_hash` | 上一行的 `row_hash`；链上第一行为**创世哈希**（64 个 `0`） |
| `row_hash` | 本行封印哈希（十六进制 sha256，64 位） |

其余列（`event_type` / `binding_key` / `operation_no` / `scanner_id` / `actor` /
`detail` / `request_id` / `created_at`）参与哈希计算。

## 规范化行内容

参与哈希的字段**顺序固定**，用 JSON 数组编码（不是字符串拼接）：

```json
["<event_type>","<binding_key>","<operation_no>","<scanner_id>","<actor>","<detail>","<request_id>","<created_at>","<prev_hash>"]
```

- 字段值为空时写 `null`（**与空串可区分**：`detail` 为空和 `detail` 为 null 是两回事）；
- `id` **不参与**哈希 —— 行号由 SQLite 在插入时分配，插入前拿不到；
- 顺序即口径：改字段顺序等于换哈希口径，必须同步迁移与本文档。

## 校验的四条判据

`verifyChain(db, from?, to?)` 逐行检查，任一不成立即断链：

| 判据 | 不成立时的断链类型 | 含义 |
|---|---|---|
| 封印 | `unsealed_row` | 本行没有 `row_hash` —— 不是经写入面追加的行，内容无从校验 |
| 内容 | `content_mismatch` | 用存储字段重算的行哈希与存储值对不上 —— **内容被改过** |
| 接续 | `link_mismatch` | 本行 `prev_hash` 与上一行 `row_hash` 对不上 —— 链被接错或中间有行被删 |
| 连续 | `missing_row` | 相邻两行 id 不连续 —— **中间有行被删过** |

返回结论：

```ts
{
  intact: boolean,        // 是否完整
  rows: number,           // 校验覆盖的行数
  from_id: number | null, // 校验区间（按 id）
  to_id: number | null,
  first_break: {          // 第一个断点（无断点为 null）
    row_id: number,       // 断点行的 id
    row_no: number,       // 断点行在所校验区间中的序号
    reason: ChainBreakReason,
    message: string,      // 中文说明，可直接贴给信息科
    expected: string | null, // 期望值（重算哈希 / 前驱哈希 / 应有行号）
    actual: string | null,   // 实际值（库里存的）
  } | null,
  issues: string[],       // 全部问题（中文）
  checked_at: string,
}
```

## 存量行怎么办

老库（v9 及以前）里的审计行没有哈希。v10 迁移**一次性补算**：

1. 按 id 升序遍历；
2. 第一行的 `prev_hash` 取创世哈希，其后每行取上一行的 `row_hash`；
3. 补算完再装护栏（顺序不能反 —— 补算本身要 `UPDATE` 行）。

所以升级后，手术室的历史台账**照样能自证没被动过**，不会变成「不可验证的旧账」。

## 谁在写

只有一处写：`appendAudit()`（`src/ledger/audit.ts`）。

- 审计层**不导出**任何 `update` / `delete` / `clear` 接口；
- 写入走 `BEGIN IMMEDIATE` 事务（读链头 → 算哈希 → 插行三步不与别人交错），插完再核对一次前驱，防并发写叉；
- 链头未封印时拒绝写入（`ERR_AUDIT_CHAIN_UNSEALED_HEAD`）；
- 检出分叉时抛 `ERR_AUDIT_CHAIN_FORK` 并回滚（失败不静默改数据）。

## 怎么看

```bash
# 体检：连哈希链结论一起看
node dist/cli.js doctor --db data/ledger.db
#   审计链完整性：通过
#   审计链校验：完整（覆盖 5 行，校验时间 2026-11-02T16:57:16.158Z）

# 核查包导出：结论随包一起交（JSON 格式在 audit_chain 字段里）
node dist/cli.js pack --db data/ledger.db --format json --out /tmp/pack.json
```

断链时输出形如：

```
审计链校验：发现 1 处问题 —— 断点在第 17 行（id=17）：第 17 行（id=17）内容被改：重算行哈希 a713694ccbca… 与库中 e76a777b1519… 不符
```

## 自检

```bash
node --test dist/tests/audit-chain.test.js
```

覆盖：追加 100 行校验通过、改一行指出断链行号、删一行指出行号缺口、
库内 UPDATE / DELETE 被触发器拒绝、审计层不导出改写接口、存量行补算封印、
核查包附带校验结论。
