# 运维命令行手册（CLI）

> 常驻进程跑在手术室里没人盯着终端，出问题时信息科要能在**一条命令**里看清
> 「**哪一路不通、哪个台次、哪些耗材没闭环**」，而且输出既能给人看、也能被脚本和监控接走。

本文件是 `node dist/cli.js <子命令>` 的**完整参数手册**：每个子命令的用途、参数表、
默认值、可照抄的示例、真实输出片段、常见错误与退出码。参数契约的真源是
`src/cli/args.ts`（`COMMAND_SPECS`），本文件与它逐字对齐 —— 改参数先改那里。

## 文档地图

| 文档 | 什么时候看 |
|---|---|
| 本文件 | 要在命令行里查状态、导出清单、排查通道 |
| [`architecture.md`](architecture.md) | 要 understand 主路径怎么跑、状态机与幂等键怎么定义、表结构长什么样 |
| [`examples.md`](examples.md) | 要看一份真实的入站报文 / 回执 / 核查条目 / 对账包长什么样 |
| [`api/errors.md`](api/errors.md) | 日志或核查清单上看到 `ERR_*` 码，要查含义与排查顺序 |
| [`api/scan-event.md`](api/scan-event.md) | 设备侧（扫码枪厂商 / RFID 网关）要联调入站接口 |
| [`api/his-charging.md`](api/his-charging.md) | HIS 计费侧要联调出站接口 |

## 快速上手

```bash
# ① 体检：哪一路凭据位齐否、末次收到事件 / 末次计费回写、推送失败计数
node dist/cli.js doctor

# ② 看台账：这一台扫了哪些耗材、绑上没绑上、计费状态如何
node dist/cli.js ledger --operation OP-SAMPLE-001

# ③ 导清单：护士长要签字的那一份（按台次聚合未闭环条目）
node dist/cli.js closing --operation OP-SAMPLE-001 --format csv --out /tmp/closing.csv
```

## 全局约定

### 通用选项

每个子命令都接受这三个参数。

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--db <路径>` | 字符串 | `data/ledger.db`（取自环境变量 `LEDGER_DB_PATH`） | 台账库路径 |
| `--json` | 开关 | 关 | 输出机器可读的 JSON（监控 / 脚本直接 `JSON.parse`）；不加这个开关时输出给人看的文本 |
| `--help` | 开关 | 关 | 显示本子命令的用法（用途 / 参数 / 默认值 / 示例 / 退出码） |

参数写法有三种：`--key value`、`--key=value`、`--flag`。开关型参数单独登记，
所以 `replay --charge 20` 里的 `20` 不会被当成 `--charge` 的值 —— 它会被当作多余的位置参数并报错。

### 退出码

监控接这个 CLI 时，判定依据是**退出码**，不是输出文本 —— 输出文本会改版，退出码不会。

| 退出码 | 含义 | 什么时候出现 |
|---|---|---|
| `0` | 成功 | 命令正常跑完 |
| `2` | 参数错误 | 未知子命令 / 未知参数 / 参数取值不合法 / 缺少必填参数 / 多余的位置参数 |
| `3` | 业务校验失败 | 台账库不存在 / 主数据文件读不到 / 编码不可解码 / 幂等不变式不成立 |
| `4` | 外部通道不可达 | `replay --charge` 时出站计费凭据缺失或通道连不上（**未做任何重放**） |
| `5` | 内部错误 | 未预期的异常（程序自己的问题） |

### `--json` 输出模式

- stdout 上**只有一份 JSON**，不带任何其他文字 —— `JSON.parse(stdout)` 直接可用。
- 需要落盘时用 `--out <路径>`，导出提示走 stderr，不污染 stdout。
- `--json` 与 `--format csv` 同时给时，`--json` 优先。
- **凭据明文在任何模式下都不出现**：JSON 里只有「凭据位齐否」和脱敏后的端点。

### 凭据与脱敏

| 通道 | 需要的凭据位 | 缺了会怎样 |
|---|---|---|
| 入站扫码网关 | `OR_SCANNER_BASE_URL`、`OR_SCANNER_TOKEN`、`OR_SCANNER_SECRET` | 这一路不可用；**其余两路不受影响**（不是整个进程拒绝启动） |
| 出站 HIS 计费 | `HIS_CHARGING_BASE_URL`、`HIS_CHARGING_TOKEN` | 只有需要回写计费的命令（`replay --charge`）会因此退出码 4 |
| 企业微信推送 | `WECOM_WEBHOOK_URL`、`WECOM_SECRET` | 推送失败**不阻塞台账落库**，失败计数写审计链，由 `doctor` 暴露 |

`doctor` 只报「齐否 + 缺哪个变量名 + 脱敏端点（协议 + 主机 + 路径）」，
**从不打印令牌明文**；异常信息与 JSON 输出同样过一遍打码。

---

## 五个核心子命令

### `doctor` — 常驻进程体检单

体检三路通道（入站扫码 / 出站计费 / 企微推送）的凭据位齐否、各路近况、事件来源可用性、
运行状态、心跳、熔断状态、主数据版本与待核查条目分布。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--probe` | 开关 | 关（只读本地台账，不连接任何外部系统） | 加一次主动探测：出站发**空批次**健康检查（不产生计费明细）、入站连一下监听端口与投递目录、推送侧解析域名并连端口（不发业务消息） |
| `--probe-timeout <n>` | 正整数 | `3000` | 主动探测的超时预算（毫秒） |

#### 示例

```bash
node dist/cli.js doctor
node dist/cli.js doctor --json
node dist/cli.js doctor --probe --probe-timeout 5000
```

#### 输出片段（真实运行）

```
== 通道体检 ==
  入站扫码网关           缺 OR_SCANNER_BASE_URL、OR_SCANNER_TOKEN、OR_SCANNER_SECRET 端点=未配置
  出站 HIS 计费        缺 HIS_CHARGING_BASE_URL、HIS_CHARGING_TOKEN 端点=未配置
  企业微信推送           缺 WECOM_WEBHOOK_URL、WECOM_SECRET 端点=未配置

== 运行状态 ==
  末次收到扫码事件：2026-11-03T10:27:15.272Z
  末次计费回写：    （还没有回写过）
  企微推送失败次数：0
  台账行数=5 回执行=0 待核查=1 审计行=7 事件=1
  审计链完整性：通过
```

#### 常见错误

| 现象 | 原因 | 处置 |
|---|---|---|
| `台账库不存在`（退出码 3） | 没导过主数据，或 `--db` 指错 | 先跑 `import-master`，或用 `--db` 指定正确路径 |
| `缺 HIS_CHARGING_TOKEN` | 出站凭据位没配 | 补环境变量；只想看台账的话不需要出站凭据 |
| `投递目录不可读：scan-inbox` | `SCAN_INBOX_DIR` 指的目录不存在或没权限 | 建目录或改 `SCAN_INBOX_DIR` |

### `replay` — 事件重放与幂等不变式验证

从事件日志重放事件，输出「新增台账行数 / 触发计费次数」，并**验证幂等不变式**
（默认同一区间连重放两遍，第二次增量必须为 0）。这是「同键不会重复计费」的可复核证据。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--limit <n>` | 正整数 | `50` | 最多重放多少条事件 |
| `--operation <台次号>` | 字符串 | 无 | 只重放某个台次的事件 |
| `--batch <批次号>` | 字符串 | 无 | 只重放某个批次号的事件（扫码枪路 = 投递标识，目录路 = 批次文件名） |
| `--from <ISO 时间>` | 字符串 | 无 | 时间窗起点（含，按事件**收到时刻**） |
| `--to <ISO 时间>` | 字符串 | 无 | 时间窗终点（含） |
| `--source <来源>` | 字符串 | 无 | 只重放某个来源的事件（`scanner_http` / `rfid_dir`） |
| `--file <路径>` | 字符串 | 无 | 从事件日志文件重放（每行一个批次信封） |
| `--charge` | 开关 | 关（只重放，不回写计费） | 顺带回写计费（需要出站凭据位） |
| `--no-verify` | 开关 | 关（默认**要验**不变式） | 跳过幂等不变式验证 |
| `--diff-out <路径>` | 字符串 | `logs/replay-<区间>-diff.json`（该目录不入库） | 差异表落盘路径 |

#### 示例

```bash
# 只重放，不回写计费（默认安全，不碰外部系统）
node dist/cli.js replay --limit 20

# 顺带回写计费（需要 HIS_CHARGING_BASE_URL / HIS_CHARGING_TOKEN）
node dist/cli.js replay --limit 20 --charge

# 按台次重放并输出机器可读结果
node dist/cli.js replay --operation OP-SAMPLE-001 --json

# 按时间窗重放
node dist/cli.js replay --from 2026-01-15T00:00:00Z --to 2026-01-16T00:00:00Z
```

#### 输出片段（真实运行）

```
== 事件重放 ==
  ac5aff2c-b6ce-4e6c-a478-02a601b429f1 scanner_http 台次=OP-SAMPLE-001 条目=6 绑定=5 异常=1 新增台账行=0 DUPLICATE_SCAN×6
  重放事件数：6（区间命中 6 条）
  新增台账行数：0　触发计费次数：0
  幂等不变式：成立（第二次重放新增台账行 0 / 触发计费 0）
```

#### 常见错误

| 现象 | 退出码 | 原因 | 处置 |
|---|---|---|---|
| `出站计费通道不可用：Missing required environment variable: HIS_CHARGING_TOKEN` | 4 | 带 `--charge` 但出站凭据位缺失 | 补凭据位，或去掉 `--charge` 只重放不回写 |
| `幂等不变式不成立：重放产生了额外的台账行或计费调用` | 3 | 幂等层被绕过或台账被改过 | 查审计链与幂等键档位配置（`IDEMPOTENCY_KEY_PROFILE`） |
| `未知参数 --charge 20` 之类的位置参数报错 | 2 | 开关后面多跟了值 | 写成 `--charge`（不带值） |

### `ledger` — 耗材使用台账查询与导出

查耗材使用台账（绑在哪台手术、用了几支、结论与状态）。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--operation <台次号>` | 字符串 | 无 | 按台次过滤 |
| `--status <状态>` | 字符串 | 无 | 按条目状态过滤（`bound` / `charged` / `check_pending` / `closed`） |
| `--material <耗材码>` | 字符串 | 无 | 按耗材码过滤 |
| `--limit <n>` | 正整数 | `100` | 最多取多少行 |
| `--format <格式>` | 枚举 | `table` | 输出格式：`table` / `csv` / `json` |
| `--out <路径>` | 字符串 | 无 | 把结果写到文件（csv / json 时可用） |

#### 示例

```bash
node dist/cli.js ledger --operation OP-SAMPLE-001
node dist/cli.js ledger --format csv --out /tmp/ledger.csv
node dist/cli.js ledger --json
```

#### 输出片段（真实运行）

```
台次             手术间    耗材码             数量  结论     条目状态   计费状态           落账时间
-------------  -----  --------------  --  -----  -----  -------------  ------------------------
OP-SAMPLE-001  OR-01  MAT-SAMPLE-01   1   BOUND  bound  not_submitted  2026-11-03T10:27:15.270Z
OP-SAMPLE-001  OR-01  MAT-SAMPLE-02   2   BOUND  bound  not_submitted  2026-11-03T10:27:15.270Z
OP-SAMPLE-001  OR-01  06912345678902  1   BOUND  bound  not_submitted  2026-11-03T10:27:15.271Z
OP-SAMPLE-001  OR-01  06987654321092  1   BOUND  bound  not_submitted  2026-11-03T10:27:15.271Z
OP-SAMPLE-001  OR-01  MAT-SAMPLE-05   1   BOUND  bound  not_submitted  2026-11-03T10:27:15.271Z

共 5 行（命中 5 行）
```

#### CSV 表头（逐字）

```
operation_no,room_no,dept_code,material_code,quantity,price_code,fee_category,medical_insurance_class,conclusion,status,check_task_id,charge_state,created_at
```

#### 常见错误

| 现象 | 退出码 | 原因 | 处置 |
|---|---|---|---|
| `参数 --limit 需要一个正整数（当前值：0）` | 2 | `--limit` 只接受正整数 | 改成 `--limit 100` |
| `参数 --format 只接受 table / csv / json（当前值：xml）` | 2 | 取值不在白名单 | 换枚举值 |
| `多余的位置参数：xxx` | 2 | 子命令不接位置参数 | 改成具名参数形式（双横线开头） |

### `pack` — 核查包导出

导出**核查包**：每条待核查耗材的台次上下文、结论、`reason_code`、计费回执与人工结论。
**导出字段来自固定白名单，不含患者标识字段**（无姓名 / 身份证 / 住院号）。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--operation <台次号>` | 字符串 | 无 | 按台次过滤 |
| `--status <状态>` | 字符串 | 无 | 按核查状态过滤（`pending` / `closed`） |
| `--limit <n>` | 正整数 | `500` | 最多导出多少条 |
| `--format <格式>` | 枚举 | `csv` | 输出格式：`csv` / `json` |
| `--out <路径>` | 字符串 | 无 | 导出文件路径 |

#### 示例

```bash
node dist/cli.js pack --status pending
node dist/cli.js pack --format json --out /tmp/pack.json
node dist/cli.js pack --json
```

#### 输出片段（真实运行）

```
check_task_id,operation_no,room_no,dept_code,scanner_id,material_code,quantity,conclusion,reason_code,check_status,assignee_role,detected_at,binding_status,charge_state,receipt_attempt,receipt_delivery_count,receipt_kind,receipt_reason_code,receipt_error_code,receipt_channel_reachable,receipt_responded_at,confirmed_by,confirmed_conclusion,confirmed_at,revoked_at,revoked_by,source_operation_no,source_room_no,master_room_no,event_dept_code
1,OP-SAMPLE-001,OR-01,SURG-01,SCAN-GUN-07,MAT-UNKNOWN-99,1,NOT_REGISTERED,MATERIAL_NOT_REGISTERED,pending,高值耗材管理岗,2026-11-03T10:27:15.271Z,,not_submitted,0,0,,,,,,,,,,,,,OR-01,
审计链校验：完整（覆盖 7 行，校验时间 2026-11-03T10:28:04.572Z）
```

> 最后一行是**审计链校验结论** —— 内审 / 飞检要连「这份台账没被动过」一起交。
> 台账被改过时会转成不完整并指出第一个断点行号。

#### 常见错误

| 现象 | 退出码 | 原因 | 处置 |
|---|---|---|---|
| `审计链校验：不完整（断点 id=4）` | 0（但内容告警） | 审计链被改过或行被删 | 查 `doctor` 的审计链段；定位断点行后人工核对 |
| 输出里出现姓名 / 身份证字段 | — | 不可能：字段来自白名单 | 若真出现即为缺陷，请反馈 |

### `summary` — 批次与台次统计

给出结论分布、计费成功率、重投次数分布、待核查条目数与审计链完整性。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--operation <台次号>` | 字符串 | 无 | 只统计某个台次 |

#### 示例

```bash
node dist/cli.js summary
node dist/cli.js summary --operation OP-SAMPLE-001
node dist/cli.js summary --json
```

#### 输出片段（真实运行）

```
== 台账与核查 ==
  台账行数：5
    状态 bound            5
== 绑定结论分布 ==
    BOUND                5
    NOT_REGISTERED       1
    CROSS_OP_DUP         0
    CLOSED               0
    CHARGE_REJECTED      0
== 各路收到事件数 ==
    scanner_http         1 批　末次 2026-11-03T10:27:15.272Z
    rfid_dir             0 批　末次 （还没有）
== 计费 ==
  投递 0 次 / 接收 0 / 拒收 0 / 通道不可达 0
  成功率 0.0%　重投 0 次
== 核查与推送 ==
  核查条目 1（待核查 1 / 已闭环 0）
  企微推送 成功 0 / 失败 0 / 跳过 0
  事件 1 条 / 审计链 7 行（完整性：通过）
```

#### 常见错误

| 现象 | 退出码 | 原因 | 处置 |
|---|---|---|---|
| `台账库不存在` | 3 | 还没建库 | 先 `import-master` |

---

## 五个扩展子命令

### `events` — 事件日志溯源

按投递标识回查「设备报了什么 → 落了哪几行台账 → 怎么处置」，或按耗材码回查全部事件序列。
这是「这条耗材到底怎么变成这笔计费的」的单点回查入口。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--request <投递标识>` | 字符串 | 无 | 按投递标识回查（一次扫码投递 = 一个标识） |
| `--material <耗材码>` | 字符串 | 无 | 按耗材码回查（原始码与院内码都能查） |
| `--operation <台次号>` | 字符串 | 无 | 按台次回查该台次的事件 |
| `--source <来源>` | 字符串 | 无 | 按来源过滤（`scanner_http` / `rfid_dir`） |
| `--limit <n>` | 正整数 | `50` | 最多回查多少条事件 |

#### 示例

```bash
node dist/cli.js events --request 8a3f-...
node dist/cli.js events --material MAT-SAMPLE-01
node dist/cli.js events --operation OP-SAMPLE-001 --json
```

#### 输出片段（真实运行）

```
== 事件日志溯源（回查方式：material）==
  命中 1 条 / 事件日志共 1 条
  2026-11-03T10:27:15.272Z　scanner_http　台次 OP-SAMPLE-001　手术间 OR-01　扫码枪 SCAN-GUN-07
    投递标识 ac5aff2c-b6ce-4e6c-a478-02a601b429f1　结论 accepted=5;rejected=1　签名 已验
    原始报文 {"operation_no":"OP-SAMPLE-001","room_no":"OR-01","scanner_id":"SCAN-GUN-07","scans":[…
```

#### 常见错误

| 现象 | 退出码 | 原因 | 处置 |
|---|---|---|---|
| `命中 0 条` | 0 | 该耗材 / 该标识没有事件记录 | 确认设备侧是否真的投递过；看 `doctor` 的「各路近况」 |

### `reconcile` — 台账 ↔ 计费回执逐条对账

把耗材使用台账与计费回执按 `(material_code, operation_no)` 对齐，产出**三类差异**：
台账有回执无（计费未提交 / 提交未回执 / 被业务拒绝）、回执有台账无（对端出现未知条目）、
两边都有但字段口径不一致（数量 / 计价单位 / 费用类别 / 医保分类）。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--operation <台次号>` | 字符串 | 无 | 只对某个台次对账 |
| `--material <耗材码>` | 字符串 | 无 | 只对某个耗材码对账 |
| `--status <状态>` | 字符串 | 无 | 只看某类处置状态（`pending` / `resolved`） |
| `--limit <n>` | 正整数 | `20000` | 最多扫描多少条台账行 |
| `--format <格式>` | 枚举 | `table` | 输出格式：`table` / `csv` / `json` |
| `--out <路径>` | 字符串 | 无 | 导出文件路径 |
| `--dry-run` | 开关 | 关 | 只读盘点：不把差异落进差异台账 |
| `--create-check` | 开关 | 关 | 把待处理差异转成核查任务（双向挂接） |

#### 示例

```bash
node dist/cli.js reconcile --operation OP-SAMPLE-001
node dist/cli.js reconcile --format csv --out /tmp/diffs.csv
node dist/cli.js reconcile --create-check --json
```

#### 输出片段（真实运行）

```
== 台账 ↔ 计费回执对账 ==
  台账条目 5 条 / 计费条目 0 条 / 差异 5 条（新增 5，自动闭环 0）
  台账有计费无 5 / 计费有台账无 0 / 字段口径不一致 0
    NOT_SUBMITTED                       5 条
台次             耗材码             差异类型             归因             不一致字段  状态       核查条目
-------------  --------------  ---------------  -------------  -----  -------  ----
OP-SAMPLE-001  MAT-SAMPLE-01   MISSING_RECEIPT  NOT_SUBMITTED         pending
OP-SAMPLE-001  MAT-SAMPLE-02   MISSING_RECEIPT  NOT_SUBMITTED         pending
```

#### 常见错误

| 现象 | 退出码 | 原因 | 处置 |
|---|---|---|---|
| 差异全是 `MISSING_RECEIPT` / 归因 `NOT_SUBMITTED` | 0 | 这些条目还没回写过计费（`charge_state = not_submitted`） | 正常状态：等守护进程回写；也可以用 `replay` 子命令的「顺带回写计费」模式补 |
| 归因是 `CHANNEL_UNREACHABLE` | 0 | 出站通道当时不可达 | 查 `doctor` 的出站段与熔断状态 |
| 归因是 `BUSINESS_REJECTED` | 0 | 对端业务拒收 | 查回执 `reason_code`，见 [`api/errors.md`](api/errors.md) 的计费回执处置表 |

### `attempts` — 计费尝试史

每一次投递尝试一行（时间 / attempt / 结果 / 错误码 / 通道可达性）。用于回答
「这条耗材被投了几次、每次对端怎么说的」。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--operation <台次号>` | 字符串 | 无 | 只看某个台次的尝试 |
| `--material <耗材码>` | 字符串 | 无 | 只看某条耗材的尝试 |
| `--from <ISO 时间>` | 字符串 | 无 | 时间窗起点（含） |
| `--to <ISO 时间>` | 字符串 | 无 | 时间窗终点（含） |
| `--limit <n>` | 正整数 | `500` | 最多取多少行 |
| `--format <格式>` | 枚举 | `table` | 输出格式：`table` / `csv` / `json` |
| `--out <路径>` | 字符串 | 无 | 导出文件路径（csv / json 时可用） |

#### 示例

```bash
node dist/cli.js attempts --operation OP-SAMPLE-001
node dist/cli.js attempts --format csv --out /tmp/attempts.csv
node dist/cli.js attempts --json
```

#### 输出片段（真实运行）

```
== 计费尝试史 ==
（该台次还没有任何计费尝试 —— 条目尚未回写过计费）

== 按条目小结 ==

共 0 次尝试（命中 0 次）
```

#### 常见错误

| 现象 | 退出码 | 原因 | 处置 |
|---|---|---|---|
| `共 0 次尝试` | 0 | 还没回写过计费 | 正常；先跑 `doctor` 看末次计费回写时间 |

### `closing` — 关台核对清单导出

护士长关台时要的那一份清单：这一台扫了哪些耗材、哪些绑上了、哪些已生成计费、
哪些还挂在核查待办里，并给出一行关台结论（可关台 / 待核查 N 条 / 待计费 N 条）。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--operation <台次号>` | 字符串 | 无 | 只导某个台次的关台核对清单 |
| `--operations <台次号列表>` | 字符串 | 无 | 指定台次列表（逗号分隔），用于手术室周度批量核对 |
| `--from <ISO 时间>` | 字符串 | 无 | 落账时间起点（含） |
| `--to <ISO 时间>` | 字符串 | 无 | 落账时间终点（含） |
| `--limit <n>` | 正整数 | `200` | 最多返回多少个台次 |
| `--format <格式>` | 枚举 | `table` | 输出格式：`table` / `csv` / `json` |
| `--out <路径>` | 字符串 | 无 | 导出文件路径 |

#### 示例

```bash
node dist/cli.js closing --operation OP-SAMPLE-001
node dist/cli.js closing --operations OP-SAMPLE-001,OP-SAMPLE-002 --format csv --out /tmp/closing.csv
node dist/cli.js closing --json
```

#### 输出片段（真实运行）

```
== 关台核对清单 ==
  台次 1 个 / 耗材条目 6 条 / 已计费 0 条 / 待核查 1 条 / 待计费 5 条 / 可关台 0 个

-- 台次 OP-SAMPLE-001 ｜ 手术间 OR-01 ｜ 科室 SURG-01 ｜ 排台状态 open
  耗材 6 条 ｜ 绑定成功 5 条 ｜ 已计费 0 条 ｜ 待核查 1 条 ｜ 待计费 5 条
  汇总：待核查 1 条 · 待计费 5 条
  待核查条目：
    - MAT-UNKNOWN-99　数量 1　结论 NOT_REGISTERED　原因 MATERIAL_NOT_REGISTERED　错误码 ERR_MATERIAL_NOT_REGISTERED　责任岗位 高值耗材管理岗
  待计费条目（没人跟的静默缺口）：
    - MAT-SAMPLE-01（药物洗脱支架）　数量 1　结论 BOUND
```

#### 常见错误

| 现象 | 退出码 | 原因 | 处置 |
|---|---|---|---|
| `关台核对清单导出失败：…` | 3 | 范围参数非法（如 `--from` 晚于 `--to`） | 核对时间窗 |
| `台次 0 个` | 0 | 该范围内没有条目 | 放宽 `--from` / `--to` 或去掉过滤 |

### `import-master` — 主数据导入

导入手术排台台次与耗材主数据到台账镜像表。**导入即生效，不重启常驻进程** ——
判定引擎每次现读镜像表，导完正在跑的守护进程下一次扫码立刻按新值判。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `--operations <路径>` | 字符串 | **必填** | 手术排台台次 CSV 路径（字段：`operation_no` / `room_no` / `dept_code` / `status` / `closed_at`） |
| `--materials <路径>` | 字符串 | **必填** | 院内耗材主数据 CSV 路径（字段：`material_code` / `name` / `price_code` / `fee_category` / `medical_insurance_class` / `active` / `batch_no` 等） |
| `--source <标识>` | 字符串 | `cli` | 导入来源标识（写进导入履历与审计链） |

#### 示例

```bash
node dist/cli.js import-master --operations data/operations.csv --materials data/materials.csv
node dist/cli.js import-master --operations ops.csv --materials mats.csv --source nurse-station --json
```

#### 输出片段（真实运行）

```
== 主数据导入 ==
  主数据版本：第 1 版　导入时间 2026-11-03T10:27:15.000Z　来源 cli
  排台台次：文件 3 行　新增 3　更新 0　跳过 0　镜像行数 0 → 3
  耗材主数据：文件 8 行　新增 8　更新 0　跳过 0　镜像行数 0 → 8
  导入即生效：正在跑的守护进程无需重启，下一次扫码按新值判定
```

#### 常见错误

| 现象 | 退出码 | 原因 | 处置 |
|---|---|---|---|
| `缺少必填参数 --operations` | 2 | 两个 CSV 路径都得给 | 补参数 |
| `排台台次文件读不到：ops.csv` | 3 | 路径不对 | 核对路径 |
| `耗材主数据文件编码不可解码：mats.csv` | 3 | 老系统导出的 GBK 文件 | 用 `MASTER_DATA_ENCODING=gbk` 指定编码；原始字节已保留，可核对导出方编码 |
| 跳过明细里有行 | 0 | 该行缺必填字段或主键重复 | 按 `master_data_import` 履历逐条核对 |

---

## 排障剧本

| 现象 | 第一条命令 | 看什么 |
|---|---|---|
| 扫码枪扫了没反应 | `node dist/cli.js doctor` | 入站段「末次收到事件时间」；凭据位齐否 |
| 设备报签名不对 | `node dist/cli.js doctor` + `docs/api/scan-event.md` | 时间戳窗口 / nonce 规则 |
| 耗材没生成计费 | `node dist/cli.js ledger --material <耗材码>` | `charge_state` 列 |
| 计费一直失败 | `node dist/cli.js attempts --material <耗材码>` | 每次尝试的 `error_code` 与通道可达性 |
| 台账有、计费侧没有 | `node dist/cli.js reconcile` | 差异类型与归因 |
| 关台时还有条目没闭环 | `node dist/cli.js closing --operation <台次号>` | 待核查 / 待计费两档 |
| 企微没收到消息 | `node dist/cli.js doctor` | 推送段「企微推送失败次数」与失败错误码 |
| 怀疑台账被动过 | `node dist/cli.js pack --format json` | `audit_chain.intact` 与 `first_break` |

## 与其他文档的关系

- 本文件讲**怎么用命令行**；主路径、状态机、幂等键、表结构见 [`architecture.md`](architecture.md)。
- 本文件里的输出片段是**真实运行产物**，完整样例见 [`examples.md`](examples.md)。
- `ERR_*` 码的含义与排查顺序见 [`api/errors.md`](api/errors.md)。
- 入站 / 出站对接规范见 [`api/scan-event.md`](api/scan-event.md) 与 [`api/his-charging.md`](api/his-charging.md)。
