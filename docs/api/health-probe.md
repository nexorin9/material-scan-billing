# 通道体检与主动探测口径

> `doctor` 子命令的体检单分两层：
> **本地体检**（默认，只读台账与配置，不连接任何外部系统）与
> **主动探测**（`--probe`，此刻这一路通不通）。
> 本文件是这两层的**唯一口径依据**，字段名与结论档位逐字对齐实现代码
> （`src/health/probe.ts`、`src/health/channel-health.ts`、`src/cli/commands.ts`）。

## 1. 为什么要分两层

只读体检回答的是「**过去**发生过什么」：凭据位齐否、末次收到事件是什么时候、
末次计费回写是什么时候、熔断在不在。这些数字全部从台账读，但有一个前提 ——
**这一路最近有业务流过**。手术室连着两小时没有扫码时，「末次成功时间」只能说明
「停着」，说明不了「通不通」。

主动探测回答的是「**此刻**通不通」。它要真的敲一次对端，所以**默认不开** ——
`doctor` 平时是只读运维面，不该在没人要求的时候去碰外部系统。

| 模式 | 命令 | 碰外部系统吗 | 什么时候用 |
|---|---|---|---|
| 本地体检 | `node dist/cli.js doctor` | **不碰** | 日常巡检、接监控、查台账 |
| 主动探测 | `node dist/cli.js doctor --probe` | 碰（见 §3） | 报障时：判断「到底哪一路不通」 |
| 机器可读 | `node dist/cli.js doctor --json` | 随 `--probe` 而定 | 监控采集 |

## 2. 本地体检输出

### 2.1 通道体检（凭据位齐否）

三路各一行，**只报齐否与变量名，绝不报值**：

| 路 | 必填变量 | 端点展示 |
|---|---|---|
| 入站扫码网关 | `OR_SCANNER_BASE_URL` / `OR_SCANNER_TOKEN` / `OR_SCANNER_SECRET` | 协议 + 主机 + 路径（去掉 query） |
| 出站 HIS 计费 | `HIS_CHARGING_BASE_URL` / `HIS_CHARGING_TOKEN` | 同上 |
| 企业微信推送 | `WECOM_WEBHOOK_URL` / `WECOM_SECRET` | 同上（webhook 的 key 不出现） |

### 2.2 各路近况（最近成功 / 最近失败 / 最近错误码）

三样一起给。只看「末次成功时间」会把三个月前成功过一次的死路当成活的；
只看「末次失败时间」又会把已经自愈的路当成坏的。

| 路 | 最近一次成功 | 最近一次失败 | 数据来源 |
|---|---|---|---|
| 入站扫码 | 事件日志 `scan_event.received_at` 的最大值 | 归属「入站 / 绑定」环节的核查条目，外加目录投递坏行（`audit_chain` 的 `ingest_bad_line`） | 台账 |
| 出站计费 | 回执 `charge_receipt` 中 `accepted = 1` 的 `responded_at` | `charge_receipt` 中带 `error_code` 的最后一条 | 台账 |
| 企微推送 | `notify_delivery` 中 `status = 'sent'` 的 `created_at` | `notify_delivery` 中 `status = 'failed'` 的最后一条 | 台账 |

> **口径说明**：入站请求**验签失败返回 401 且不落库**（这是硬约束：验签失败不许在台账里留痕）。
> 所以「入站最近一次失败」反映的是**落过痕**的入站问题（绑不上的耗材、投递坏行），
> 401 本身不留痕 —— 要看 401 得看网关侧日志。

## 3. 主动探测（`--probe`）

### 3.1 出站 HIS 计费

| 项 | 口径 |
|---|---|
| 请求 | `POST {HIS_CHANNING_BASE_URL}{HIS_CHANNING_MATERIAL_USES_PATH}`（路径与真实计费**同一个**） |
| 请求体 | `{operation_no: "", dept_code: "", uses: []}` —— **空批次** |
| 请求头 | `Authorization: Bearer $HIS_CHARGING_TOKEN`（与真实计费**同一条代码路径**） |
| 计费条目 | **0 条** —— 空批次不产生任何计费明细（对端计费台账里仍然一条耗材都没有） |
| 客户端 | **独立实例**（自带熔断器）—— 探测失败**不会**把守护进程在跑的熔断档位打乱 |
| 超时 | 默认 3000 毫秒（`--probe-timeout <ms>` 可调） |

### 3.2 入站扫码

三个检查项各给一个结论（都是本机检查，**不依赖凭据位**，缺位也照样探）：

| 检查项 | 怎么判 | 不通过时的错误码 |
|---|---|---|
| 凭据位齐否 | 三个入站变量是否都有值（只报变量名） | `ERR_MISSING_CREDENTIAL` |
| 验签密钥已配置 | `OR_SCANNER_SECRET` 非空（只报齐否） | `ERR_MISSING_SIGNATURE` |
| 监听端口在监听 | TCP 连 `DAEMON_HTTP_HOST`（默认回环）：`HTTP_PORT` | `ERR_INBOUND_PORT_NOT_LISTENING` |
| 目录投递箱可读可写 | `SCAN_INBOX_DIR` 的读 + 写权限 | `ERR_SCAN_INBOX_NOT_WRITABLE` |

### 3.3 企业微信推送

| 检查项 | 怎么判 | 不通过时的错误码 |
|---|---|---|
| webhook 地址格式 | 必须是 `https`（回环地址放宽到 `http`），且带 `key` 参数 | `ERR_NOTIFY_CONFIG` |
| 域名解析 | DNS 解析 webhook 主机名 | `ERR_NOTIFY_NETWORK` |
| 端口连通 | TCP 连 webhook 主机端口，**连上就断开** | `ERR_NOTIFY_NETWORK` |

> **不发业务消息**：推送侧的探测只做 DNS 解析与 TCP 握手，
> **一个字节的业务消息都不发** —— 手术室的群里不会多出一条「测试」。

### 3.4 结论档位

| 档位 | 含义 | 什么时候出现 |
|---|---|---|
| `ok` | 探测通过 | 对端 2xx / 本机检查项全过 |
| `unreachable` | 通道不通 | 对端 5xx、连不上、超时、熔断打开；本机检查项不通过 |
| `rejected` | 通道是通的，但对端把这次探测拒了 | 对端 4xx；响应结构不符 |
| `skipped` | **未探测** | 该路凭据位不齐（出站 / 推送两路） |

`unreachable` 与 `rejected` 分开是有意的：「连不上」和「连上了但不收」在信息科
那里是两件完全不同的事 —— 前者查网络与地址，后者查载荷与对端策略。

## 4. 机器可读输出（`--json`）

`doctor --json` 把整份体检单打成一份 JSON，字段与上面的口径一一对应：

| 字段 | 内容 |
|---|---|
| `generated_at` | 体检时刻 |
| `channels[]` | 三路凭据位齐否 + 脱敏端点 |
| `channel_health[]` | 各路最近成功 / 最近失败 / 最近错误码 |
| `probes[]` | 主动探测结论（`--probe` 才有内容，默认空数组） |
| `sources[]` | 两路事件来源的收到条数与末次时间 |
| `counters` | 台账行数 / 回执行 / 待核查 / 审计行 / 事件 |
| `outbound_circuit` | 熔断档位、连续失败次数、下次探测时刻 |
| `heartbeat` | 最近一条心跳（版本 / 运行时长 / 三路凭据位齐否） |
| `master_data` | 主数据当前版本、最近导入时间、镜像行数与导入履历 |
| `audit_integrity` / `chain_integrity` | 审计链与哈希链校验结论（断链给断点行号） |
| `pending_by_error_code` / `pending_by_assignee` | 待核查条目按错误码 / 责任岗位分组 |

**凭据明文在两种输出模式下都不出现** —— 只报齐否、变量名与脱敏端点。

## 5. 相关文档

- 错误码全表（含义 / 可重投 / 处置 / 排查顺序）：`docs/api/errors.md`
- 出站计费字段规范：`docs/api/his-charging.md`
- 企业微信推送字段规范：`docs/api/wecom-notify.md`
