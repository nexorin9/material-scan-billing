# 条目状态机全量迁移表

> 一条耗材条目从「扫到」到「闭环」会走过好几个状态。哪一步能走、哪一步不能走、
> 不走会怎样，在这里逐对写清楚 —— 评审时不必翻代码。

> 本表由 `npm run docs:matrix` 从 `src/domain/state.ts` 生成，**不要手改**。

## 状态含义

| 状态 | 含义 | 说明 |
|------|------|------|
| `scanned` | 已扫码 |  |
| `parsed` | 已解析 |  |
| `bound` | 已绑台次 |  |
| `rejected` | 判定异常 |  |
| `charged` | 已计费 |  |
| `confirmed` | 已确认 |  |
| `check_pending` | 待核查 |  |
| `closed` | 已闭环 | （终态，自动迁移无出边） |

## 全量迁移矩阵（8 × 8 = 64 对）

「触发方」列写的是**谁有权**执行这条迁移；角色不符一律拒绝（`ERR_ILLEGAL_STATE_TRANSITION`）。

| 起始状态 | 目标状态 | 判定 | 触发方 | 说明 |
|----------|----------|------|--------|------|
| `scanned` | `scanned` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `scanned` | `parsed` | 放行（推进） | `ingest` | 入站解析完成 |
| `scanned` | `bound` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `scanned` | `rejected` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `scanned` | `charged` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `scanned` | `confirmed` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `scanned` | `check_pending` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `scanned` | `closed` | 拒绝 | — | 当前状态到「已闭环」没有合法路径：需先按顺序推进或转人工核查 |
| `parsed` | `scanned` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `parsed` | `parsed` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `parsed` | `bound` | 放行（推进） | `binding_engine` | 绑定本台次成功 |
| `parsed` | `rejected` | 放行（推进） | `binding_engine` | 绑定判定为异常 |
| `parsed` | `charged` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `parsed` | `confirmed` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `parsed` | `check_pending` | 放行（推进） | `binding_engine` | 异常条目转核查 |
| `parsed` | `closed` | 拒绝 | — | 当前状态到「已闭环」没有合法路径：需先按顺序推进或转人工核查 |
| `bound` | `scanned` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `bound` | `parsed` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `bound` | `bound` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `bound` | `rejected` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `bound` | `charged` | 放行（推进） | `charge_writeback` | 计费回写成功 |
| `bound` | `confirmed` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `bound` | `check_pending` | 放行（推进） | `binding_engine` / `charge_writeback` | 计费业务拒绝，转人工 |
| `bound` | `closed` | 拒绝 | — | 当前状态到「已闭环」没有合法路径：需先按顺序推进或转人工核查 |
| `rejected` | `scanned` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `rejected` | `parsed` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `rejected` | `bound` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `rejected` | `rejected` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `rejected` | `charged` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `rejected` | `confirmed` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `rejected` | `check_pending` | 放行（推进） | `binding_engine` | 异常条目生成核查任务 |
| `rejected` | `closed` | 放行（推进） | `manual_confirm` | 人工判定无需处理，直接闭环 |
| `charged` | `scanned` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `charged` | `parsed` | 拒绝 | — | 已回写计费的条目不自动冲正：不能退回已计费前的状态 |
| `charged` | `bound` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `charged` | `rejected` | 拒绝 | — | 已回写计费的条目不自动冲正：不能退回已计费前的状态 |
| `charged` | `charged` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `charged` | `confirmed` | 放行（推进） | `manual_confirm` | 人工确认已计费 |
| `charged` | `check_pending` | 放行（推进） | `charge_writeback` / `manual_confirm` | 计费结果存疑，转人工 |
| `charged` | `closed` | 拒绝 | — | 当前状态到「已闭环」没有合法路径：需先按顺序推进或转人工核查 |
| `confirmed` | `scanned` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `confirmed` | `parsed` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `confirmed` | `bound` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `confirmed` | `rejected` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `confirmed` | `charged` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `confirmed` | `confirmed` | 放行（幂等自环，不推进） | `manual_confirm` | 重复确认：幂等自环，不推进 |
| `confirmed` | `check_pending` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `confirmed` | `closed` | 放行（推进） | `manual_confirm` | 确认后闭环 |
| `check_pending` | `scanned` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `check_pending` | `parsed` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `check_pending` | `bound` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `check_pending` | `rejected` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `check_pending` | `charged` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `check_pending` | `confirmed` | 拒绝 | — | 不在合法迁移表内：已拒绝且不改动台账 |
| `check_pending` | `check_pending` | 放行（幂等自环，不推进） | `manual_confirm` / `revoke` | 撤回 / 重复落结论：幂等自环，不推进 |
| `check_pending` | `closed` | 放行（推进） | `manual_confirm` | 核查结论落定，闭环 |
| `closed` | `scanned` | 拒绝 | — | closed 是终态：自动迁移表内没有任何出边，只能由人工撤回入口纠正 |
| `closed` | `parsed` | 拒绝 | — | closed 是终态：自动迁移表内没有任何出边，只能由人工撤回入口纠正 |
| `closed` | `bound` | 拒绝 | — | closed 是终态：自动迁移表内没有任何出边，只能由人工撤回入口纠正 |
| `closed` | `rejected` | 拒绝 | — | closed 是终态：自动迁移表内没有任何出边，只能由人工撤回入口纠正 |
| `closed` | `charged` | 拒绝 | — | closed 是终态：自动迁移表内没有任何出边，只能由人工撤回入口纠正 |
| `closed` | `confirmed` | 拒绝 | — | closed 是终态：自动迁移表内没有任何出边，只能由人工撤回入口纠正 |
| `closed` | `check_pending` | 自动迁移拒绝；仅人工撤回入口成立 | `revoke` | 人工撤回误确认：退回待核查；已回写计费的条目不自动冲正（自动迁移不放行，需走人工撤回断言） |
| `closed` | `closed` | 拒绝 | — | closed 是终态：自动迁移表内没有任何出边，只能由人工撤回入口纠正 |

## 三条硬约束

1. **终态保护** —— `closed` 在自动迁移表里没有任何出边；越界尝试一律拒绝并留拒绝痕迹。
2. **已计费不自动冲正** —— `charged` 不能回到 `rejected` / `parsed`；冲正属人工在 HIS 侧处理。
3. **幂等自环** —— `check_pending → check_pending`、`confirmed → confirmed` 放行，但**不推进状态**、不重写确认时间。

## 人工撤回（独立入口）

撤回是**人工纠正**，不是状态推进，因此单列一张表、单独一个断言函数，不并入自动迁移表。

| 起始状态 | 目标状态 | 触发方 | 说明 |
|----------|----------|--------|------|
| `closed` | `check_pending` | `revoke` | 人工撤回误确认：退回待核查；已回写计费的条目不自动冲正 |

## 幂等自环边

| 起始状态 | 目标状态 | 触发方 | 说明 |
|----------|----------|--------|------|
| `confirmed` | `confirmed` | `manual_confirm` | 重复确认：幂等自环，不推进 |
| `check_pending` | `check_pending` | `manual_confirm` / `revoke` | 撤回 / 重复落结论：幂等自环，不推进 |

## 迁移轨迹

每次成功迁移在审计链（`audit_chain`）追加一行 `state_transition`；
每次被拒的越界迁移追加一行 `state_transition_rejected`。
行内含 `from` / `to` / `actor` / `request_id` / `created_at`，按条目可原样回放状态序列。

