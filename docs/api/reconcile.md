# 对账差异台账（台账 ↔ 计费回执）

> 关台后护士长与高值耗材管理岗最想知道的不是「扫了多少」，而是「**哪些耗材没有生成计费**」。这份文档说清楚：怎么对、差异怎么分类、归因怎么判、差异台账长什么样、怎么导出。

## 一句话口径

**按（耗材码 + 台次号）把耗材使用台账与计费回执两侧逐条对齐**，多出来的一侧就是差异；每条差异给出**归因**（自动可判的 / 需人工复核的分开）与**建议处置**，落成可导出的差异台账。

## 三类差异

| 差异类型 | 含义 | 归因（按最近一次回执的 attempt 与 error_code 判定） |
|----------|------|--------------------------------------------|
| `MISSING_RECEIPT` | 台账有这笔耗材，计费侧**没有成功回执** | 无回执行 → `NOT_SUBMITTED`；通道不可达（超时 / 连接失败 / 5xx）→ `CHARGE_TIMEOUT_PENDING_RETRY`；对端业务拒绝 → `CHARGE_BUSINESS_REJECTED`；回执结构不符 → `CHARGE_PROTOCOL_ERROR`；判不出来 → `MANUAL_REVIEW` |
| `UNKNOWN_RECEIPT` | 计费侧有成功回执，台账里**查不到**这笔耗材 | `UNEXPECTED_CHARGE` |
| `FIELD_MISMATCH` | 两边都有，但**字段口径不一致** | `FIELD_MISMATCH`（列出不一致的具体字段名与两侧取值） |

三类互斥且穷尽：对上的条目不进差异台账。

## 字段级比对口径

比对四个口径字段（台账侧 vs **计费侧实际收到的载荷快照**）：

| 字段 | 中文 | 台账侧取值 | 计费侧取值 |
|------|------|-----------|-----------|
| `quantity` | 数量 | `material_binding.quantity` | 回执行 `submitted_quantity` |
| `price_code` | 计价口径（价码） | `material_binding.price_code` | 回执行 `submitted_price_code` |
| `fee_category` | 费用类别 | `material_binding.fee_category` | 回执行 `submitted_fee_category` |
| `medical_insurance_class` | 医保分类 | `material_binding.medical_insurance_class` | 回执行 `submitted_medical_insurance_class` |

- **计价单位的换算口径落在 `quantity` 上**（支 / 包 / 套 → 计费数量，由耗材主数据的换算关系给出）：因此「计价口径」这一项由 `price_code` 与 `quantity` 联合表达。
- **载荷快照是回执行上的列**（`charge_receipt.submitted_*`，按**每次尝试**记）：重投过几次，每次发出去的载荷都留痕，事后能追「第 2 次重投时口径改没改」。
- 升级前写下的回执行**没有快照**（`submitted_*` 全空）→ 这一条**不做字段级判定**：判不了不硬凑一个「一致」。

## 差异台账（`reconcile_diff` 表）

| 字段 | 说明 |
|------|------|
| `diff_key` | 差异键 = `sha256(差异类型\|耗材码\|台次)`；与时间戳、重跑次数、扫码枪编号无关 —— 同一条差异反复对账只留一行 |
| `diff_type` | 三类差异之一（见上表） |
| `attribution` | 归因码 |
| `attribution_detail` | 归因依据（最近一次尝试的 kind / error_code / 通道可达性） |
| `operation_no` / `room_no` / `dept_code` | 台次上下文（**只到台次，不到患者**） |
| `material_code` | 耗材码（归一后的规范码） |
| `ledger_*` / `receipt_*` | 两侧取值（数量 / 价码 / 费用类别 / 医保分类） |
| `mismatched_fields` | 不一致字段的 JSON 数组：`[{"field":"quantity","label_zh":"数量","ledger_value":1,"receipt_value":3}]` |
| `suggested_action` | 建议处置（一句话，给科室看） |
| `error_code` | 统一错误码（与日志、核查条目同一个码，见 `docs/api/errors.md`） |
| `status` | `pending`（待处理）/ `resolved`（已处理） |
| `binding_id` / `receipt_id` / `check_task_id` | 与台账行、回执行、核查条目的挂接 |
| `attempt` / `delivery_count` | 归因所依据的那次尝试的序号与累计投递次数 |
| `detected_at` / `resolved_at` / `resolved_by` | 检出时间 / 处置时间 / 处置人（`auto_reconcile` = 差异消失自动闭环） |

## 与核查任务的双向挂接

```
差异行 (reconcile_diff)  ──check_task_id──▶  核查条目 (check_task)
        ▲                                            │
        └─────────reconcile_diff_id──────────────────┘
```

- `node dist/cli.js reconcile --create-check` 把待处理差异逐条转成核查条目（**同一条差异不刷重复待办**）。
- 核查条目带台次上下文（台次 / 手术间 / 科室 / 耗材码 / 数量）与统一错误码，护士长可直接在核查清单上处置。
- **对账不改台账、不改计费侧数据**：只新增差异台账行；已回写计费的条目**不自动冲正**（冲正属人工在 HIS 侧处理）。

## 导出字段白名单

导出只有台次上下文、差异类型与归因、两侧取值、建议处置与处置状态 —— **没有任何患者标识字段**（耗材码只绑手术台次，不落患者可识别明细）。字段清单见 `RECONCILE_EXPORT_FIELDS`（`src/ledger/reconcile.ts`）。

## 命令

```bash
# 对账并打印差异台账（表格）
node dist/cli.js reconcile

# 只对某个台次对账，导出 CSV
node dist/cli.js reconcile --operation OP-SAMPLE-001 --format csv --out /tmp/diffs.csv

# 只读盘点：不把差异落进差异台账
node dist/cli.js reconcile --dry-run

# 把待处理差异转成核查任务（双向挂接）
node dist/cli.js reconcile --create-check
```

## 与源产品的对应

源产品的投递是**逐目标**的：一份回执对应一个被投递对象（回执带投递次数与通道当时是否可达），投递清单与回执清单成对返回，多的一条少的一条都能看出来。本模块照此语义改写成耗材计费场景：**台账清单 ↔ 回执清单**双向对齐，多出来的一侧指向谁，一目了然。
