# 计费尝试史（每次 attempt 全量留痕）

> 一条耗材被拒了三次，第四次才成功。护士长问「到底试了几次、每次错在哪」时，
> 台账必须答得上来 —— 而不是只留最后那一行「成功」。这份文档说清：
> 每次尝试留什么行、按哪几个口径查、怎么导出、以及升级前的老账怎么认。

## 一、为什么不能只记成功

计费回写是**会重试**的动作：对端限流、5xx、网络抖动都会让一次投递失败，
退避重投后再投一次。三种结局都不是「结束」：

| 结局 | 归类档位 | 值不值得重投 | 台账状态 |
|------|----------|--------------|----------|
| 对端接收 | `ACCEPTED` | —— | `charged` |
| 对端业务拒绝（通道可达） | `BUSINESS_REJECTED` | 看判定表 | `check_pending`（转人工） |
| 对端 5xx（通道可达） | `CHANNEL_ERROR` | 可重投 | `bound`（留着重投） |
| 通道当时不可达（超时 / 连接失败） | `CHANNEL_UNREACHABLE` | 可重投 | `bound`（留着重投） |
| 回执结构不符 | `PROTOCOL_ERROR` | 可重投 | `bound`（留着重投） |
| 本侧校验未发出请求 | `LOCAL_ERROR` | 不可重投 | `check_pending`（转人工） |

**每一次尝试都留一行**，包括失败的那些。只记成功 = 事后查不出「这笔为什么计了这么久」，
也无法证明重投次数。

## 二、一次尝试留哪些字段（五要素）

| 字段 | 含义 | 缺了会怎样 |
|------|------|-----------|
| `attempt` | 这条耗材的第几次尝试（从 1 起连续） | 答不出「试了几次」 |
| `requested_at` | 请求发出时间 | 算不出单次耗时 |
| `responded_at` | 回执到手时间 | 同上 |
| `error_code` | 统一错误码（`ERR_CHARGE_*`） | 只看得到对端原因码，对不上日志与核查条目 |
| `channel_reachable` | 通道当时可达否 | 分不清「对端不收」与「对端没收到」 |

另外随行留：归类档位 `kind`、对端原因码 `reason_code`、处置档位 `disposition`、
回执摘要 `response_summary`、以及本次**实际发出去的载荷快照**
（`submitted_quantity` / `submitted_price_code` / `submitted_fee_category` /
`submitted_medical_insurance_class`）。

### 尝试序号按条目取，不按批次取

同一台次里 A 条重投过两次、B 条第一次投 —— 两者的序号不能共用一个。
序号从回执台账**现读**（该条目已投递次数 + 1），所以：

- 同一耗材的序号连续、不重号、不跳号；
- 重投**复用同一把幂等键**（键不因重试次数变化而改），序号变、键不变。

## 三、三种查询口径

| 口径 | 接口 | 排序 | 典型用途 |
|------|------|------|----------|
| 按条目 | `loadReceipts(db, material_code, operation_no)` | 尝试序号升序 | 「这一条耗材试了几次」 |
| 按台次 | `listOperationAttempts(db, operation_no)` | 耗材码 → 尝试序号 | 关台核对：「这一台每条耗材各试了几次」 |
| 按时间窗 | `listAttemptsInWindow(db, from, to)` | 落账时间升序 | 事后复盘：「昨晚八点到九点发生了什么」 |

时间窗口径取**落账时间**（`created_at`）—— 历史行的请求 / 响应时间可能缺失，
拿落账时间做窗更稳；落在窗外的按 `responded_at` 补判一次，两头都不落才算窗外。

## 四、导出

### 运维 CLI（用户侧出口）

```bash
# 终端可读版：逐次尝试 + 按条目小结
node dist/cli.js attempts --operation OP-SAMPLE-001

# CSV 导出（可核对，字段走白名单）
node dist/cli.js attempts --operation OP-SAMPLE-001 --format csv --out /tmp/attempts.csv

# 时间窗（ISO 时间，含端点）
node dist/cli.js attempts --from 2026-01-15T00:00:00.000Z --to 2026-01-15T23:59:59.999Z
```

| 选项 | 说明 |
|------|------|
| `--operation <台次号>` | 只看某个台次的尝试 |
| `--material <耗材码>` | 只看某条耗材的尝试 |
| `--from <ISO 时间>` / `--to <ISO 时间>` | 时间窗（含端点） |
| `--limit <n>` | 最多取多少行（默认 500） |
| `--format table\|csv\|json` | 输出形态（默认 table） |
| `--out <文件>` | 导出文件路径（csv / json 时可用） |

该子命令**只读**：不改任何业务状态、不外发任何请求。

### 模块接口

```ts
import {
  attemptHistoryToCsv,
  attemptHistoryToJson,
  toAttemptExportRows,
  summarizeAttemptHistory,
  renderAttemptTimeline,
} from '../src/charge/attempt-history.js';
```

| 产物 | 内容 |
|------|------|
| `attemptHistoryToCsv(rows)` | 表头 = 字段白名单顺序；数据行数 = 尝试数 |
| `attemptHistoryToJson(rows)` | 白名单 + 档位中文说明（`kind_labels` / `disposition_labels`） |
| `summarizeAttemptHistory(rows)` | 按条目小结：试了几次、每次结果、最后有没有计上、错过哪几个码 |
| `renderAttemptTimeline(rows)` | 终端可读版：一条耗材一段，逐次列出结果与错误码 |

导出字段白名单见 `ATTEMPT_HISTORY_EXPORT_FIELDS`（22 列）。**不含任何患者标识字段**
（无姓名 / 身份证 / 住院号 / 病案号 / patient 等）—— 耗材码只绑手术台次。
`tests/receipt-history.test.ts` 对字段名与导出内容都做了正则断言。

导出里有两个字段如实留空，不糊：

- `channel_reachable` 为空 = **老行没记录**（迁移回填不了），不是「不可达」；
- `error_code` 为空 = 当时就没有错误码（对端已接收的行本就没有）。

## 五、升级前的老账怎么认（迁移 v21）

老库里有几行是早期写的：尝试序号一律 `1`（列的默认值）、请求与响应时间没记、
归类档位与通道可达性也可能是空的。直接看这些行会得出错误结论
（比如「只投过 1 次」其实投过 3 次）。迁移 `receipt_attempt_history`（v21）做**回填**：

| 字段 | 回填口径 |
|------|----------|
| `attempt` | 按（耗材码 + 台次）内的**落账顺序**重算 |
| `requested_at` / `responded_at` | 缺则按落账时间补记 |
| `channel_reachable` | 按归类档位推导（对端给了结论 = 当时通道是通的）；**推不出来就留空** |
| `error_code` | **回填不了就留空** —— 不编造一个错误码出来 |

回填过的行标 `attempt_source = 'recovered'` 并留一句中文备注（`history_note`，
写清补记了什么、为什么补不了）；**原生记录**的行标 `'native'`、备注留空。
迁移幂等：只处理 `attempt_source IS NULL` 的行，跑第二遍不重复改。

## 六、验收

```bash
npm run build && node --test dist/tests/receipt-history.test.js
```

覆盖：三类结局各留一行 / 三次尝试序号连续 / 三种查询口径条数一致 /
导出 CSV 行数等于尝试数且字段白名单无患者标识 / fixture 样例台账与导出逐字一致 /
迁移 v21 回填并标注、幂等重跑不改动已有行。
