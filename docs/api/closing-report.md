# 关台核对清单口径

> 护士长在关台那一刻要的是**一份能签字的清单** —— 这一台扫了哪些耗材、哪些绑上了、
> 哪些已经生成计费、哪些还挂在核查待办里。本文件说清这份清单**怎么算出来**、
> **导出哪些字段**、**批量导出怎么圈范围**，口径与实现代码逐字对齐
> （`src/check/closing-report.ts`），科室签认时按本文件对单。

## 1. 一句话说清这条链路

```
扫码事件 → 台账行（绑上的）／核查条目（没绑上的）
        → 按台次聚合 → 逐条结论（绑定 / 计费 / 核查 / 人工结论）
        → 一行关台结论：可关台 ｜ 待核查 N 条 ｜ 待计费 N 条
        → CSV / JSON / 终端清单（护士长按台次逐台签认）
```

**系统只做三件事**：把该台的条目收齐、把每条的状态讲清、给出一行关台结论。
**闭环始终由人来做**（核查清单上人工确认），系统不代劳、不自动关闭条目、不自动冲正计费。

## 2. 关台判定口径（三档，互斥）

| 档位 | 判定条件 | 含义 |
|---|---|---|
| **待核查 N 条** | 该台有 N 条**待处理核查条目** | 有人正在跟（责任岗位见 `docs/api/check-routing.md`）；清单逐条列出耗材码、原因码、统一错误码与责任岗位 |
| **待计费 N 条** | 没有待核查条目，但有 N 条**还没生成成功计费** | 静默缺口：没人跟、也没计上，最容易在关台时被漏掉 |
| **可关台** | 上述两类都不存在 | 这一台的耗材条目都已闭环，可以签字 |

两条补充口径：

- **人工处置过的不重复催** —— 条目状态为 `closed` / `confirmed`，或核查条目已被人工落定
  （`closed`）的，**不再计入待计费**。人已经拍过板了，系统不重复催。
- **两档同时存在时**标签写成 `待核查 N 条 · 待计费 M 条`，优先级是**待核查 > 待计费**
  （有人在跟的先说）。

## 3. 条目集合从哪来（**一条不漏**）

清单的条目集合是 **台账行 ∪ 独立核查条目**：

| 条目来源 | 落在哪张表 | 什么时候有 |
|---|---|---|
| 绑上台次的耗材 | `material_binding` | 绑定结论为 `BOUND`，已落台账行 |
| 被拒绝的耗材 | `check_task`（**没有台账行**） | 耗材码未建档 / 耗材停用 / 台次已关台 / 归属冲突 / 数量换算不成等异常结论 |

**只查台账会漏掉被拒绝的耗材** —— 而它们恰恰是要签字的那一部分。
所以清单用一条 `NOT EXISTS` 把「已经有台账行的核查条目」去掉，剩下的独立核查条目
单独并进条目集合，条目状态记 `rejected`、计费状态记 `not_submitted`。

计费状态按回执行推导（与 `ledger` 子命令同一口径）：

| 计费状态 | 判据 |
|---|---|
| `accepted` 已计费 | 该耗材在本次台次有成功回执 |
| `pending_retry` 待重投 | 有回执但全部不可重投失败（通道不可达） |
| `rejected` 计费被拒 | 有回执但对端业务拒绝 |
| `not_submitted` 未提交 | 该耗材一条回执都没有 |

## 4. 导出字段（白名单，25 列）

`closing` 子命令 `--format csv` 的表头**逐字**等于下表顺序：

| 字段 | 含义 |
|---|---|
| `operation_no` | 台次号 |
| `room_no` | 手术间（**事件侧**：扫码发生地） |
| `master_room_no` | 手术间（**排台侧**：归属双因子核对的另一侧） |
| `dept_code` | 科室编码 |
| `operation_status` | 排台台次状态（`open` / `closed` / `unknown`） |
| `material_code` | 耗材码（归一后） |
| `material_name` | 耗材名（院内主数据） |
| `quantity` | 数量（原始包装数） |
| `charge_quantity` | 计价数量（换算后；口径见 `docs/api/units.md`） |
| `price_code` | 计价口径（价码） |
| `fee_category` | 费用类别（院内 14 类口径，见 `docs/api/fee-category.md`） |
| `medical_insurance_class` | 医保分类（甲 / 乙 / 丙） |
| `conclusion` | 绑定结论（`BOUND` / `NOT_REGISTERED` / `CROSS_OP_DUP` / `CLOSED` / `CHARGE_REJECTED`） |
| `binding_status` | 条目状态（台账状态机：`bound` / `charged` / `check_pending` / `closed` …） |
| `charge_state` | 计费状态（`accepted` / `pending_retry` / `rejected` / `not_submitted`） |
| `check_status` | 核查状态（`none` 不涉及核查 / `pending` 待核查 / `closed` 已落定） |
| `manual_conclusion` | 人工结论（护士长 / 耗材管理岗落定的） |
| `reason_code` | 原因码 |
| `error_code` | 统一错误码（与日志、核查条目同一个码，见 `docs/api/errors.md`） |
| `assignee_role` | 责任岗位 |
| `check_task_id` | 关联的核查条目 id |
| `confirmed_by` | 人工确认人 |
| `confirmed_at` | 人工确认时间 |
| `created_at` | 落账时间 |
| `summary_label` | 该台次的关台结论标签（同一台次的每一行都带同一句结论） |

**脱敏**：字段里只有台次上下文与耗材码，**没有任何患者标识字段**
（耗材码只绑手术台次，不落患者可识别明细）。导出的字段名与取值都经正则断言不含
`patient` / 患者 / 姓名 / 身份证 / 住院号 / 就诊号 / 病案号。

JSON 导出在上述字段之外，额外给出逐台次的结构化结论：

```json
{
  "generated_at": "…",
  "scope": { "operation_no": null, "operations": [], "from": null, "to": null },
  "fields": ["operation_no", "…"],
  "totals": { "operations": 3, "items": 8, "bound": 5, "charged": 4, "pending_check": 2, "pending_charge": 1, "can_close_operations": 1 },
  "operations": [
    {
      "operation_no": "OP-SAMPLE-001",
      "room_no": "OR-01",
      "dept_code": "SURG-01",
      "operation_status": "open",
      "item_count": 3,
      "bound_count": 1,
      "charged_count": 1,
      "pending_check_count": 2,
      "pending_charge_count": 0,
      "summary_label": "待核查 2 条",
      "can_close": false,
      "pending_items": [
        {
          "material_code": "MAT-UNKNOWN-01",
          "material_name": "",
          "quantity": 1,
          "conclusion": "NOT_REGISTERED",
          "reason_code": "MATERIAL_NOT_REGISTERED",
          "error_code": "ERR_MATERIAL_NOT_REGISTERED",
          "assignee_role": "高值耗材管理岗",
          "check_task_id": 1
        }
      ],
      "pending_charge_items": [],
      "items": ["…逐条明细，字段同上…"]
    }
  ]
}
```

## 5. 批量导出（手术室周度核对）

| 圈范围的方式 | 参数 | 口径 |
|---|---|---|
| 单台次 | `--operation <台次号>` | 只出这一台 |
| 台次列表 | `--operations <a,b,c>` | 出这几台（逗号分隔，顺序去重） |
| 日期范围 | `--from <ISO 时间>` / `--to <ISO 时间>` | 按**落账时间**圈（`created_at`，含两端）；时间可写 `2026-01-15` 或 `2026-01-15T00:00:00.000Z` |
| 条数上限 | `--limit <n>` | 最多返回多少个台次（默认 200），台次按台次号升序 |

两种补充口径：

- **指定了台次但一条都没扫 → 也要出现在清单里**（标签 `无扫码记录`）。
  不出现的话，「这一台本来就没有耗材」和「这一台漏扫了」分不清。
- **时间范围不合法直接报错并指名是哪个参数**（`ERR_CLOSING_INVALID_RANGE`），
  退出码 2 —— 不静默当成「没有数据」。

## 6. 终端可读版本

```
== 关台核对清单 ==
  台次 3 个 / 耗材条目 8 条 / 已计费 4 条 / 待核查 2 条 / 待计费 1 条 / 可关台 1 个

-- 台次 OP-SAMPLE-001 ｜ 手术间 OR-01 ｜ 科室 SURG-01 ｜ 排台状态 open
  耗材 3 条 ｜ 绑定成功 1 条 ｜ 已计费 1 条 ｜ 待核查 2 条 ｜ 待计费 0 条
  汇总：待核查 2 条
  待核查条目：
    - MAT-UNKNOWN-01　数量 1　结论 NOT_REGISTERED　原因 MATERIAL_NOT_REGISTERED　错误码 ERR_MATERIAL_NOT_REGISTERED　责任岗位 高值耗材管理岗
  条目明细：
  耗材码        数量  结论             计费状态  核查状态  人工结论
  ------------  ----  ---------------  --------  --------  --------
  MAT-SAMPLE-01     1  BOUND             已计费    不涉及核查  —
  MAT-UNKNOWN-01    1  NOT_REGISTERED    未提交    待核查      —
  MAT-UNKNOWN-02    1  NOT_REGISTERED    未提交    待核查      —
```

## 7. 运维要点

- **只读**：清单模块只**读**台账、回执与核查条目，一个字都不改 ——
  清单是盘点，不是纠正。纠正走核查任务的人工确认 / 撤回（`src/check/task.ts`），
  已回写计费的条目撤回时**不自动冲正**。
- **与 `pack` 的分工**：`pack` 导的是「**待核查**的条目」（异常视角），
  `closing` 导的是「**这一台**的全部条目 + 关台结论」（台次视角）。
  关台签认看 `closing`，交办给责任岗位看 `pack`。
- **与 `reconcile` 的分工**：`reconcile` 查的是「哪些耗材没有生成计费」（台账 ↔ 回执
  逐条对齐的差异台账）；`closing` 里的「待计费」是**台次视角**的简化口径 ——
  只看有没有成功回执，不做字段级比对。要追「口径差在哪」看 `reconcile`。
