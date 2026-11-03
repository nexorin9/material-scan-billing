# 扫码事件入站对接规范

> 入站读路径：手术室扫码枪 / RFID 网关把一批耗材扫码事件推给本系统，
> 本系统逐条给绑定结论与计费状态。
> 本文件是**对端（设备侧 / 网关厂商）联调的唯一依据**：字段名与
> `src/api/contracts.ts` 的入站契约**逐字一致**，代码按同一份契约校验。

## 1. 端点与方法

| 项 | 值 |
|---|---|
| 协议 | HTTP/1.1 + JSON（`application/json; charset=utf-8`） |
| 方法 | `POST` |
| 完整 URL | `{OR_SCANNER_BASE_URL}/api/v1/scan-events` |
| 端点路径 | `/api/v1/scan-events`（按 `/api/v1/*` 前缀路由） |
| 方向 | **读**（设备侧 → 本系统） |
| 单请求体上限 | 512 KB（超出即 413） |

## 2. 请求头

| 请求头 | 值 | 说明 |
|---|---|---|
| `Authorization` | `Bearer $OR_SCANNER_TOKEN` | 入站令牌（设备侧调用时携带） |
| `X-Scan-Timestamp` | epoch 秒 | 参与签名；超出时间窗口即 401 |
| `X-Scan-Nonce` | 8–128 字符唯一串 | 本次投递的唯一标识；**参与签名**；TTL 内重复出现即 401 |
| `X-Scan-Signature` | `v1=<hex>` | `HMAC-SHA256("{timestamp}.{nonce}.{raw_body}", OR_SCANNER_SECRET)`，十六进制 |
| `content-type` | `application/json` | 固定 |

> 验签不通过一律 **401 且不落台账**；密钥为空时 fail closed（不是放行）。

### 2.1 三层重放防护（设备侧联调必读）

扫码事件一旦被抓包就可能被重放，制造假计费。本侧叠了三层，逐层收紧：

| 层 | 判据 | 命中时的表现 | 对端该怎么做 |
|---|---|---|---|
| ① 时间戳窗口 | `X-Scan-Timestamp` 与本侧时钟相差 ≤ `SCANNER_TIMESTAMP_TOLERANCE_SEC`（默认 300 秒） | 401 `ERR_STALE_TIMESTAMP` | 校正网关设备时钟后重发 |
| ② nonce 去重 | 同一 `X-Scan-Nonce` 在 `SCANNER_NONCE_TTL_SEC`（默认 600 秒）内第二次出现 | 401 `ERR_REPLAY_NONCE_REPLAY` | **每次投递（含重试）都换一个新 nonce** |
| ③ 幂等键 | 同一 `(material_code, operation_no)` | 200，但该条结论为 `DUPLICATE_SCAN`，不产生第二行台账 | 无需处置（不会重复计费） |

**nonce 为什么进了签名内容**：签名原文是 `{timestamp}.{nonce}.{raw_body}`。
只把 nonce 放请求头的话，抓包的人改个时间戳重算签名就能换一个 nonce 混进来；
nonce 进了签名内容，改时间戳就必须重算签名，而重算之后 **nonce 还是原来那个** ——
第二层照样把它拦下。

**对端联调口径**：

- 每次 HTTP 投递生成一个新 nonce（推荐 16 字节随机数的十六进制串，或 UUID）；
- 字符集限 `[A-Za-z0-9._~:+=@-]`，长度 8–128；
- **重试必须换新 nonce** —— 同一个 nonce 再来一次会被按重放拒（这是设计，不是故障）；
- 签名原文里的 nonce 与请求头里的 nonce **必须是同一个**，否则验签不通过。

> 拒绝路径都会在审计链留一行（`inbound_rejected` / `inbound_replay_rejected`），
> 原因码可查；**任何一层拒绝都不落台账、不触发计费**。

## 3. 请求体字段契约

字段形状写成**契约表**（`src/api/contracts.ts` 的 `SCAN_EVENT_CONTRACT`），
代码按契约逐字段校验，本节表格由同一份契约渲染 —— 文档与实现不会各写一份。

> 表格由 `npm run docs:api` 从契约代码渲染（`npm run docs:api -- --check` 只校验不写盘，
> 文档与契约走偏时退出码非 0）。入站与出站共用同一套命名口径：台次号 `operation_no`、
> 手术间 `room_no`、扫码枪 `scanner_id`、耗材码 `material_code` 两边逐字一致。

**两级闸门**（与出站层同一套口径）：

| 闸门 | 查什么 | 不通过时 |
|---|---|---|
| 抬头级 | `operation_no` / `room_no` / `scanner_id` + `scans` 数组 | **整批拒**（HTTP 400，不落台账）—— 没有台次号就没有归属，这批条目无处可落 |
| 明细级 | 每条扫码的字段名 / 类型 / 必填 / 长度上限 | **只拒那一条**（进 `rejected`，给原因码），同批其余照常入台账 |

> 抬头级与明细级分开处置的理由和计费侧一样：**一条坏数据不该拖累整台手术的计费**。
> 但抬头没有台次号时，条目连归属都没有 —— 那种情况只能整批退回给设备侧改。

### 3.1 批次抬头字段

<!-- contract-table:scan-event-envelope -->
| 字段 | 类型 | 必填 | 长度上限 | 允许取值 | 说明 |
|---|---|---|---|---|---|
| `operation_no` | string | 是 | 64 | — | 手术台次号 |
| `room_no` | string | 是 | 32 | — | 手术间号 |
| `scanner_id` | string | 是 | 64 | — | 扫码枪 / 网关编号（追溯是谁扫的） |
<!-- /contract-table -->

### 3.2 `scans[]` 明细字段

<!-- contract-table:scan-item -->
| 字段 | 类型 | 必填 | 长度上限 | 允许取值 | 说明 |
|---|---|---|---|---|---|
| `material_code` | string | 是 | 64 | — | 扫码枪读到的耗材码（UDI / GS1 / 院内码均可） |
| `quantity` | integer | 是 | ≥ 1 | — | 使用数量（正整数） |
| `scan_time` | string（ISO 8601） | 是 | — | — | 扫描时间（ISO 8601） |
| `batch_no` | string | 否 | 64 | — | 耗材批号（选填；用于键档位 v2 的去重维度） |
<!-- /contract-table -->

示例请求体（脱敏）：

```json
{
  "operation_no": "OP-2026-0115-007",
  "room_no": "OR-07",
  "scanner_id": "SCAN-GUN-07",
  "scans": [
    {
      "material_code": "MAT-SAMPLE-01",
      "quantity": 1,
      "scan_time": "2026-01-15T09:12:00.000Z",
      "batch_no": "LOT-SAMPLE-A"
    },
    {
      "material_code": "(01)06912345678902(10)LOT-A1",
      "quantity": 1,
      "scan_time": "2026-01-15T09:14:05.000Z"
    }
  ]
}
```

> 码制三选一（UDI / GS1 AI(01) / 院内自编码）都能收 —— 归一在解析层做，
> 原始码会保留在台账里，事后能逐条复核「这个码当时是怎么被解析成主数据键的」。

## 4. 响应体字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `accepted` | array | 绑定成功（或已判异常但已落台账）的条目 |
| `rejected` | array | 没绑上的条目（含字段没过契约的坏条目） |

| 字段 | 类型 | 说明 |
|---|---|---|
| `accepted[].material_code` | string | 耗材码 |
| `accepted[].operation_no` | string | 台次号 |
| `accepted[].bound` | 0/1 | 是否绑上台次 |
| `accepted[].conclusion` | string | 绑定结论（`BOUND` 等） |
| `accepted[].charge_state` | string | 计费状态（`not_submitted` / `submitted` / `charged` 等） |
| `rejected[].material_code` | string | 耗材码（坏条目可能为空串） |
| `rejected[].reason_code` | string | 原因码，见 §5 |

示例响应体（脱敏）：

```json
{
  "accepted": [
    {
      "material_code": "MAT-SAMPLE-01",
      "operation_no": "OP-2026-0115-007",
      "bound": true,
      "conclusion": "BOUND",
      "charge_state": "submitted"
    }
  ],
  "rejected": [
    { "material_code": "MAT-UNKNOWN-99", "reason_code": "MATERIAL_NOT_REGISTERED" }
  ]
}
```

> **结论条数守恒**：一批推 N 条，回执就有 N 条（`accepted.length + rejected.length === N`），
> 一条都不丢。字段没过契约的那几条也进 `rejected`，并写进审计链（可回看设备侧到底报了什么）。

## 5. 错误码与原因码

### 5.1 批次级（HTTP 状态码）

| 状态码 | 错误码 | 含义 | 处置 |
|---|---|---|---|
| 400 | `ERR_MALFORMED_JSON` | 请求体不是合法 JSON | 让网关重发一次；持续出现查报文拼接是否截断 |
| 400 | `ERR_INVALID_SCAN_EVENT` | **抬头级**字段校验未通过 | 按响应 `issues` 逐字段补齐后重发 |
| 401 | `ERR_BAD_AUTHORIZATION` | 令牌缺失或不匹配 | 核对 `OR_SCANNER_TOKEN` 与网关配置 |
| 401 | `ERR_INVALID_SIGNATURE` | 签名校验不通过 | 核对两端签名密钥是否一致 |
| 401 | `ERR_STALE_TIMESTAMP` | 时间戳超出窗口 | 校正网关设备时钟后重发 |
| 401 | `ERR_MISSING_NONCE` | 缺 `X-Scan-Nonce` 请求头 | 让网关每次投递都带唯一串 |
| 401 | `ERR_REPLAY_NONCE_REPLAY` | 同一 nonce 在有效期内第二次投递 | 每次投递（含重试）都换新 nonce |
| 413 | `ERR_REQUEST_BODY_TOO_LARGE` | 请求体超上限 | 按批拆分后重发 |
| 405 | `ERR_METHOD_NOT_ALLOWED` | 方法不是 POST | 核对网关调用方式 |
| 404 | `ERR_UNKNOWN_ROUTE` | 路径不在 `/api/v1/*` 下 | 核对网关配置的接口地址 |

### 5.2 条目级（进 `rejected[].reason_code`）

| 原因码 | 中文含义 | 处置 |
|---|---|---|
| `INVALID_SCAN_ITEM` | 这一条的字段没过入站契约（缺字段 / 类型不对 / 超长） | 按回执 detail 里的「字段 + 期望 + 实际」改；其余条目照常处理 |
| `MALFORMED_JSON_LINE` | 这一行不是合法 JSON（目录投递路） | 同上；其余行照常处理 |
| `ROOM_NO_MISSING` / `SCANNER_ID_MISSING` | 缺手术间号 / 缺扫码枪编号 | 让网关在每行里带上 |
| `ROOM_MISMATCH` / `SCANNER_MISMATCH` | 行里的手术间 / 扫码枪与批次不一致 | 核对网关配置与实际摆放 |
| `OPERATION_NOT_FOUND` | 排台主数据里查不到这个台次 | 核对手术排台是否已导入该台次号 |
| `OPERATION_CLOSED` | 台次已关台 | 走人工计费补录流程，本系统不自动补录 |
| `MATERIAL_NOT_REGISTERED` | 耗材未建档 | 由耗材管理岗补建档，导入后无需重启即生效 |
| `CROSS_OP_DUPLICATE_MATERIAL` | 同一耗材已绑在另一个台次 | 核对是否串台次；先到者保留，后到者转人工 |
| `DUPLICATE_SCAN` | 同一耗材同一台次重复投递 | 幂等层已去重，不会产生第二行台账 |
| `DUPLICATE_IN_BATCH` | 同一批里同一耗材重复出现 | 本批只结算一次 |

> 原因码 → 统一错误码（`ERR_*`）的映射见 [错误码对照表](errors.md)。

## 6. 第二路接入：RFID 网关目录投递

网关也可以把批次投递到目录，由常驻进程轮询处理：

```
scan-inbox/<operation_no>/<batch>.jsonl     每行一条扫码（JSON 对象）
scan-inbox/<operation_no>/<batch>.meta.json  批次元信息（可选）：{"room_no","scanner_id"}
scan-inbox/processed/<operation_no>/<batch>.jsonl   已处理归档（不再重复处理）
```

两路**共用同一份字段契约与码制归一**，只换「事件从哪来」这一段：
同一个 `(material_code, operation_no)` 分别经 HTTP 与目录投递，只产生一条台账行。

## 7. 凭据与脱敏约定

| 项 | 约定 |
|---|---|
| 令牌来源 | 只从环境变量 `OR_SCANNER_TOKEN` 读取，不落配置文件、不硬编码 |
| 签名密钥 | 只从环境变量 `OR_SCANNER_SECRET` 读取；为空时 fail closed |
| 日志 | `Authorization` / `X-Scan-Signature` 一律打码；端点去掉 query；`X-Scan-Nonce` 只在拒绝原因里出现 |
| 重放防护参数 | `SCANNER_TIMESTAMP_TOLERANCE_SEC`（默认 300）/ `SCANNER_NONCE_TTL_SEC`（默认 600）/ `SCANNER_NONCE_CLEANUP_INTERVAL_MS`（默认 60000）|
| 缺位行为 | 缺 `OR_SCANNER_BASE_URL` / `OR_SCANNER_TOKEN` / `OR_SCANNER_SECRET` → 该路拒绝启动并指名变量名，**其余路不受影响** |

## 8. 相关文档

| 文档 | 用途 |
|---|---|
| [his-charging.md](his-charging.md) | 出站计费对接规范（请求 / 响应字段契约） |
| [errors.md](errors.md) | 统一错误码对照表与排查顺序 |
| [idempotency.md](idempotency.md) | 幂等键派生口径与键透传约定 |
| [code-forms.md](code-forms.md) | 三种码制（UDI / GS1 / 院内码）的归一规则 |
