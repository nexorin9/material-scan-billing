# 核查任务责任岗位路由与超时升级口径

> 核查任务建出来只是「有人要管」——本文件说清**谁该管**、**多久没人管要催**、**催了还没人管往哪升**。
> 路由表与时限口径与实现代码逐字对齐（`src/check/route.ts`），科室交办时按本文件对名单。

## 1. 一句话说清这条链路

```
扫码异常 → 核查任务（自动派给责任岗位）
        → 超过岗位响应时限 → 企微提醒一次（不重复刷屏）
        → 再过一个时限 → 升级到上一级岗位（条目仍待核查，系统不自动闭环）
```

**系统只做三件事**：派给谁、催一次、往上升一级。
**落定结论始终由人来做**（核查清单上人工确认），系统不代劳、不自动关闭条目。

## 2. 路由表：异常类型 → 责任岗位

命中顺序：**原因码 → 统一错误码 → 绑定结论 → 兜底**（原因码最细，同一结论下原因不同、找的人不同）。

### 2.1 耗材主数据类 —— 高值耗材管理岗

| 原因码 / 错误码 | 场景 | 分派依据（给岗位看） |
|---|---|---|
| `MATERIAL_NOT_REGISTERED` / `ERR_MATERIAL_NOT_REGISTERED` | 耗材码不在院内耗材主数据里 | 补建档后导入即生效，无需重启 |
| `MATERIAL_INACTIVE` / `ERR_MATERIAL_INACTIVE` | 耗材已停用 | 确认是停用过期还是误停 |
| `FEE_CATEGORY_MISSING` / `INSURANCE_CLASS_MISSING` | 缺费用类别 / 医保分类 | 补登记后重新导入 |
| `CODE_EMPTY` / `CODE_TOO_LONG` / `CODE_ILLEGAL_CHARSET` / `CODE_FORM_UNRECOGNIZED` | 耗材码形态不对 | 核对主数据码制与设备上报格式 |
| `CODE_GTIN_CHECK_DIGIT_INVALID` / `CODE_DI_MISSING` | 条码本身有问题 | 核对主数据条码 |
| `QUANTITY_NOT_DIVISIBLE` / `UNIT_RATIO_MISSING` / `UNIT_RATIO_INVALID` | 包装数换算不成计价数 | 核对主数据换算系数 |

### 2.2 台次与归属类 —— 手术室护士长

| 原因码 / 错误码 | 场景 | 分派依据 |
|---|---|---|
| `OPERATION_CLOSED` / `ERR_OPERATION_CLOSED` | 台次已关台 | 这笔耗材不能自动计费，确认是否走人工补录 |
| `OPERATION_NOT_FOUND` / `ERR_OPERATION_NOT_FOUND` | 排台里没这台手术 | 核对台次号与排台 |
| `CROSS_OP_DUPLICATE_MATERIAL` / `ERR_CROSS_OP_DUPLICATE` | 同一耗材已记在另一台次 | 核对到底算在哪台手术 |
| `OPERATION_ATTRIBUTION_CONFLICT` / `ERR_OPERATION_CONFLICT` | 扫码枪登记与排台对不上 | 核对台次（必要时转信息科改扫码枪位置登记） |

### 2.3 计费业务拒绝 —— 收费员

| 原因码 / 错误码 | 场景 | 分派依据 |
|---|---|---|
| `PRICE_CODE_NOT_FOUND` / `ERR_CHARGE_PRICE_CODE_NOT_FOUND` | 价码在 HIS 侧查不到 | 核对价码与计费项目 |
| `INSUFFICIENT_STOCK` / `ERR_CHARGE_INSUFFICIENT_STOCK` / `STOCK_LOCKED` | 库存不足或被锁定 | 核对出库与计费口径 |
| `QUANTITY_EXCEEDED` / `DUPLICATE_ON_PEER` / `MANUAL_REQUIRED` | 数量超限 / 对端判重 / 要人工处理 | 收费员在 HIS 侧逐条确认 |
| `ERR_CHARGE_BUSINESS_REJECTED` | 对端业务拒绝（未细分） | 先看具体原因码，再定处置 |

### 2.4 医保口径类 —— 医保办

| 原因码 / 错误码 | 场景 | 分派依据 |
|---|---|---|
| `INSURANCE_CLASS_MISMATCH` / `ERR_CHARGE_INSURANCE_CLASS_MISMATCH` | 医保分类与 HIS 口径对不上 | 核对医保结算口径 |
| `INSURANCE_RULE_CONFLICT` / `ERR_CHARGE_INSURANCE_RULE_CONFLICT` | 触发医保规则冲突 | 核对医保结算口径 |
| `SPECIAL_MATERIAL_APPROVAL` / `ERR_CHARGE_SPECIAL_MATERIAL_APPROVAL` | 耗材需特殊审批才能计费 | 核对审批口径 |

### 2.5 通道类（联调问题，不是业务问题）—— 信息科接口工程师

| 错误码 | 场景 | 分派依据 |
|---|---|---|
| `ERR_CHARGE_TIMEOUT` / `ERR_CHARGE_CONNECT_TIMEOUT` / `ERR_CHARGE_PEER_TIMEOUT` | HIS 计费侧连不上或不回应 | 查通道与对端负载 |
| `ERR_CHARGE_CIRCUIT_OPEN` | 通道连续失败已熔断 | 处理对端故障 |
| `ERR_CHARGE_NETWORK` / `ERR_CHARGE_HTTP_5XX` / `ERR_CHARGE_RESPONSE_INVALID` | 网络 / 对端 5xx / 回执结构不符 | 查网络与联调文档 |
| `ERR_CHARGE_CONFIG` / `ERR_CHARGE_INTERNAL` | 配置缺失 / 回写内部异常 | 核对环境变量与日志 |

### 2.6 兜底

未匹配到具体异常类型时，先按**高值耗材管理岗**分派（多数待办是数据问题），并在审计链里记明「未匹配具体类型」。

## 3. 科室决定落到哪个科室的岗位

路由表定的是**岗位类别**，台次所属**科室**决定落到**哪个科室的岗位**：

- `assignee_role` 存基础岗位名（如「手术室护士长」），升级链按它查；
- 面向人的说法是「岗位（科室）」，如「手术室护士长（SURG-ORT）」；
- 科室在核查条目的 `dept_code` 字段里，提醒消息与 `doctor` 分组视图都带上它。

这样科室交办时不用互相甩：骨科手术间的待办和心外科手术间的待办，一眼分得开。

## 4. 响应时限与升级链

| 责任岗位 | 响应时限 | 升级链（逐级） |
|---|---|---|
| 手术室护士长 | 2 小时 | 手术室护士长 → 手术室科护士长 → 医务科 |
| 高值耗材管理岗 | 4 小时 | 高值耗材管理岗 → 耗材科主任 → 医务科 |
| 信息科接口工程师 | 4 小时 | 信息科接口工程师 → 信息科科长 → 医务科 |
| 收费员 | 8 小时 | 收费员 → 收费处主管 → 财务科主任 |
| 医保办 | 8 小时 | 医保办 → 医保科主任 → 医务科 |

**时限怎么算**：

- 提醒阈值 = 该岗位的响应时限；**同一条待办只提醒一次**（`reminded_at` 有值就不再推）；
- 升级阈值 = 响应时限 × 2^处置档位（第 0 档 1 倍、第 1 档 2 倍、第 2 档 4 倍）；
- 升到链上最后一档后**不再往上升**（再往上没有处置岗位）。

时限从**分派时点**算起（不是从检出时点算）：条目建出来到被分派之间的时间不算岗位的责任。

## 5. 台账字段

`check_task` 表上与路由相关的五列：

| 列 | 含义 |
|---|---|
| `assignee_role` | 责任岗位（基础岗位名，进升级链） |
| `assigned_at` | 分派时点（时限从这儿算起） |
| `reminded_at` | 提醒时点（非空 = 已催过，不再重复催） |
| `escalated_at` | 最近一次升级时点 |
| `timeout_level` | 处置档位（0 = 本岗位，1 = 上一级，2 = 再上一级） |

索引 `ix_check_task_routing (status, assignee_role, reminded_at, timeout_level)` 服务周期扫描与按岗位分组统计。

## 6. 审计留痕

三个动作各写一行审计链（只增不改），按 `task_id` 可回放处置轨迹：

| 事件类型 | 什么时候写 | 关键字段 |
|---|---|---|
| `check_task_assigned` | 条目建出来派给岗位时 / 补分派老条目时 | `assignee_role`、`assignee_display`、`dept_code`、`matched_by`、`matched_key`、`basis_zh` |
| `check_task_reminded` | 超时提醒发出去后 | `assignee_display`、`overdue_ms`、`window_ms`、`timeout_level` |
| `check_task_remind_failed` | 提醒推送失败（台账不受影响，下轮还能再催） | `error_code`、`message` |
| `check_task_escalated` | 超时升级时 | `from_role`、`to_role`、`timeout_level`、`overdue_ms`、`top_level` |
| `check_task_escalation_notify_failed` | 升级通知推不动（升级本身已生效） | `from_role`、`to_role`、`timeout_level` |

## 7. 运维

| 项 | 值 |
|---|---|
| 扫描周期 | `CHECK_ROUTING_SWEEP_INTERVAL_MS`，默认 60000 毫秒 |
| 扫描内容 | 补分派 → 超时提醒 → 逐级升级 |
| 查当前分派情况 | `node dist/cli.js doctor` → 「待核查条目按责任岗位」 |
| 推送通道 | 复用既有企业微信群机器人（`WECOM_WEBHOOK_URL` / `WECOM_SECRET`），不新造消息中心 |
| 失败口径 | 提醒推不动不影响台账；升级通知推不动不影响升级本身 |
