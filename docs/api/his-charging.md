# HIS 耗材计费出站对接规范

> 出站写路径：手术室扫码绑定成功的耗材条目，按台次批量回写 HIS 计费，取回逐条回执。
> 本文件是**对端联调的唯一依据**：字段名逐字对齐实现代码（`src/charge/client.ts`、`src/charge/submit.ts`）。

## 1. 端点与方法

| 项 | 值 |
|---|---|
| 协议 | HTTP/1.1 + JSON（`application/json; charset=utf-8`） |
| 方法 | `POST` |
| 完整 URL | `{HIS_CHANGING_BASE_URL}{HIS_CHARGING_MATERIAL_USES_PATH}` |
| 端点路径默认值 | `/api/v1/material-uses`（由 `HIS_CHANGING_MATERIAL_USES_PATH` 覆盖，产品代码不硬编码） |
| 方向 | **写**（本系统 → HIS 计费） |
| 请求超时 | 默认 10000 毫秒（`HIS_CHARGING_TIMEOUT_MS`） |

## 2. 请求头

| 请求头 | 值 | 说明 |
|---|---|---|
| `Authorization` | `Bearer $HIS_CHARGING_TOKEN` | **凭据单一出口**：令牌只在出站客户端盖章，业务层与日志都拿不到明文 |
| `content-type` | `application/json; charset=utf-8` | 固定 |
| `accept` | `application/json` | 固定 |

## 3. 请求体字段

请求体字段名与《最小数据格式与字段要求》**逐字一致**（键字段为「对端也幂等」补齐），
改名会静默丢计费条目。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `operation_no` | string | 是 | 手术台次号（台账 `material_binding.operation_no`） |
| `dept_code` | string | 是 | 台次所属科室编码（台账 `material_binding.dept_code`） |
| `idempotency_key` | string | 是 | **请求级幂等键**：整批提交的去重键（sha256 十六进制，见 §3.4） |
| `key_profile` | string | 是 | **键档位**：`v1` / `v2`（由配置项 `IDEMPOTENCY_KEY_PROFILE` 决定） |
| `uses` | array | 是 | 耗材使用明细数组；元素字段见下表 |

### 3.1 `uses[]` 元素字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `material_code` | string | 是 | 院内耗材码（归一后的规范码） |
| `quantity` | integer | 是 | 使用数量（**正整数**，计价单位口径；换算后数量） |
| `price_code` | string | 是 | 价码（院内耗材主数据的价格编码） |
| `use_time` | string | 是 | 使用时间，ISO 8601（如 `2026-01-15T09:12:00.000Z`） |
| `fee_category` | string | 是 | 费用类别（耗材落「卫生材料」类，见 §5） |
| `medical_insurance_class` | string | 是 | 医保分类（甲类 / 乙类 / 自费 / 其他，见 §5） |
| `idempotency_key` | string | 是 | **行级幂等键**：这一笔耗材消费的去重键（与台账行绑定，见 §3.4） |
| `key_profile` | string | 是 | **该行键档位**（跟随台账行；历史台账行为 `legacy`） |

示例请求体（脱敏）：

```json
{
  "operation_no": "OP-2026-0115-007",
  "dept_code": "DEPT-0301",
  "idempotency_key": "3f2a1c9d0b8e7a6f5c4d3e2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d",
  "key_profile": "v1",
  "uses": [
    {
      "material_code": "MAT-SAMPLE-01",
      "quantity": 1,
      "price_code": "PR-SAMPLE-01",
      "use_time": "2026-01-15T09:12:00.000Z",
      "fee_category": "卫生材料",
      "medical_insurance_class": "甲类",
      "idempotency_key": "9b8a7f6e5d4c3b2a1908172635445362718293a4b5c6d7e8f90a1b2c3d4e5f607",
      "key_profile": "v1"
    }
  ]
}
```

### 3.2 关于批号（当前接口没有批号字段）

本接口的明细**没有批号维度**：一行台账对应一行明细（逐条回执按行对齐）。
当幂等键档位切到 `v2`（同码同台次的不同批号各算一次）时，
同一台次里同款耗材的两个批次会发出**两行同码明细**（各数量 1）——
对端按项目合并成数量 2 是对端的事。

批次信息落在台账行与核查包里（台账 `material_binding.batch_no`），
对账时按「台次 + 耗材码 + 数量」与明细行对齐即可；
出站侧透传键与档位（对端也幂等）见本文 §3.4 与 `docs/api/idempotency.md` §5。

### 3.3 请求约定：分批与字段长度上限

对端对**单次请求的条目数**与**单字段长度**都有上限。本侧据此把一台次的耗材明细
**按批切分**提交，并**在本地就拒掉超长字段**。

#### 3.3.1 分批切分（按对端限批）

| 项 | 约定 |
|---|---|
| 单批条目数上限 | 默认 **100** 条 / 批（由环境变量 `HIS_CHARGING_MAX_BATCH_SIZE` 覆盖） |
| 切分方式 | 按台账行顺序等分切分，**条数守恒**：提交 N 条就有 N 条结论 |
| 逐批独立结算 | 某批整体失败（超时 / 连接失败 / 5xx）**只让该批**进退避重投，其余批的结论照常落库 |
| 失败批的条目 | 留在台账里（状态停在「待回写计费」），等退避重投；**不静默丢弃** |
| 本地拒收的条目 | 字段超长的条目**根本不进请求**，但照样有回执与核查条目（见 3.3.2） |
| 台次号 / 科室编码 | 每批都带同一组抬头（抬头是台次的属性，不是明细的属性） |

> 一台复杂手术下来高值耗材过百条很常见：不限批就整台手术的计费一起丢，
> 限批之后「一批失败」只影响那一批。

#### 3.3.2 字段长度上限（超长即拒，不截断后照发）

| 字段 | 长度上限 | 中文含义 |
|---|---|---|
| `operation_no` | 64 | 手术台次号 |
| `dept_code` | 32 | 科室编码 |
| `material_code` | 32 | 院内耗材码（归一后的规范码） |
| `price_code` | 32 | 价码（耗材主数据的价格编码） |
| `idempotency_key` | 64 | 幂等键（sha256 十六进制；请求级与行级同上限） |
| `key_profile` | 16 | 键档位（`v1` / `v2` / 历史行 `legacy`） |

> **出站的耗材码上限比入站更紧**：扫码枪能扫出来的码空间（入站允许 64 位）比
> HIS 计费表的列宽宽。放不下就**拒**，不截断 —— 截断后的码就是另一个耗材。

处置口径（**请求级**与**明细级**分开）：

| 情形 | 处置 | 错误码 |
|---|---|---|
| `operation_no` / `dept_code` 超长 | **整个请求发不出去**（抬头定的是这批记到哪台手术，没有「截半截抬头」）；全部条目落本地拒收 + 核查条目 | `ERR_CHARGE_FIELD_TOO_LONG` |
| `material_code` / `price_code` 超长 | **只拒这一条**，同批其余条目照常提交；被拒条目落回执 + 核查条目 | `ERR_CHARGE_FIELD_TOO_LONG` |
| `idempotency_key` / `key_profile` 超长或为空 | 同上（键超长即格式非法，**不截断后照发** —— 截断过的键就是另一把键） | `ERR_CHARGE_FIELD_TOO_LONG` / `ERR_CHARGE_REQUEST_INVALID` |

> **为什么不能截断后照发**：被截断的耗材码就是**另一个耗材**，计费会记到别的耗材头上，
> 要到月底对账才发现。所以本侧一律**拒**，由人改主数据或改扫码枪配置后重投。

### 3.4 幂等键透传（对端也幂等）

**为什么透传**：本侧幂等只挡得住「**本侧**重复发」。对端重试后补发、网关重传、
中间链路重投，都可能让同一笔耗材消费在对端记两笔。把键一并发给对端，
对端按同一把键去重，这一笔就只会落一次账。

| 层 | 字段 | 派生口径 | 对端用途 |
|---|---|---|---|
| 行级 | `uses[].idempotency_key` | `sha256("<档位>\|<耗材码>\|<台次>[\|<批号>]")` | 逐条去重：同一笔耗材消费只记一次 |
| 请求级 | `idempotency_key` | `sha256("req\|<台次号>\|<行级键1>\|<行级键2>…")`（行级键**升序**入哈希） | 整单去重：同一个请求送两遍只落一次 |

三条约定：

| 项 | 约定 |
|---|---|
| 键与重试次数无关 | **重投复用同一把键**（绝不因第几次尝试而改键）——对端据此认得「这是同一笔」 |
| 键与时间戳 / 扫码枪编号无关 | 同一条耗材在同台次被重扫、重投、换枪重扫，键都一样 |
| 键档位可灰度 | `key_profile` 随请求下发；对端可按 `v1` / `v2` 分别处理，两代键并存互不误判 |

> 行级键**优先取台账行带来的那把**（`material_binding.idempotency_key`）——
> 它是这条消费在台账里的身份，重投时复用同一把。没有台账键时才现派生，
> 此时按 `v1` 口径（批号未知就分不清「同一批重扫」与「另一批的同款耗材」，宁可少算）。

**对端回显（强烈建议）**：响应里逐条回显收到的行级键
（`accepted[].idempotency_key` / `rejected[].idempotency_key`），
顶层可回显请求级键（`idempotency_key`）。本侧据此在回执里标注对端是否启用幂等：

| 回执字段 `peer_idempotency_status` | 中文含义 | 本侧处置 |
|---|---|---|
| `ECHOED` | 对端回显了同一把键（对端已启用幂等去重） | 照常推进台账状态 |
| `NOT_ECHOED` | 对端没回显（**对端未启用幂等**） | 本侧仍保证单侧幂等（台账唯一键 + 幂等占位层），但重复投递的去重责任不在对端，须在核查时留意 |
| `MISMATCH` | 对端回显了**另一把**键（两端口径不一致） | 如实留痕（回执 + 日志），交信息科与对端确认口径；不误判成重复计费 |

**对端不回显不是错误**：老版本 HIS 计费接口没有这两个字段，此时按 `NOT_ECHOED` 处理，
本侧幂等照常生效，不影响计费闭环。

### 3.5 字段契约（可执行 · 代码与文档同源）

出站请求与响应的字段形状写成**契约表**（`src/api/contracts.ts`），
代码按契约逐字段校验，本节表格由同一份契约渲染 —— 文档与实现不会各写一份、也不会走偏。

> 表格由 `npm run docs:api` 从契约代码渲染（`npm run docs:api -- --check` 只校验不写盘，
> 文档与契约走偏时退出码非 0）。改契约字段 → 跑一次 `npm run docs:api` → 文档自动跟上。

**两层闸门**（顺序固定）：

| 闸门 | 查什么 | 不通过时 |
|---|---|---|
| 形状层 | 必填缺失 / 数量非正整数 / 关键字段超长 | **不外发**；`ERR_CHARGE_REQUEST_INVALID` / `ERR_CHARGE_FIELD_TOO_LONG` |
| 契约层 | 字段名、类型、必填、**枚举**、长度上限（一次给出**全部**违规项） | **不外发**；`ERR_CHARGE_CONTRACT_VIOLATION`（回执里带「字段名 + 期望 + 实际」逐项清单） |

契约层能抓住形状层抓不到的一类问题：**取值越界**。字段名和类型都对，
但费用类别不在院内 14 类内、医保分类不是甲/乙/丙、键档位不是 v1/v2/legacy ——
这类报文发过去对端多半照收，然后**记到错误的分区**，比直接拒收更难查。

**逐条判，不整批判**：契约层在出站回写路径上是**逐条明细**判的 ——
不合规的那一条**本地拒收**（落一条回执 + 生成核查条目 + 台账转人工），
同批其余字段全对的条目**照常提交**。整批一起判会把那批里字段全对的耗材也判死：
它们既没计上费、也没升核查条目，就停在 `bound` 等重投，而重投多少次还是不合规，
最后只能人工逐条重投 —— 一次字段错误拖垮一台手术的计费。
只有**请求级**字段（台次号 / 科室编码 / 请求级键）不合规时才是整批发不出去。

响应回来后同样过一遍契约：形状不符（缺 `accepted` / `rejected`、元素缺 `reason_code`、
类型不对）按「对端协议不符」处理，抛 `ERR_CHARGE_RESPONSE_INVALID` 进重投队列，
**不静默当成成功**。

#### 3.5.1 请求体字段契约

<!-- contract-table:material-uses-request -->
| 字段 | 类型 | 必填 | 长度上限 | 允许取值 | 说明 |
|---|---|---|---|---|---|
| `operation_no` | string | 是 | 64 | — | 手术台次号（这一批计费记到哪台手术） |
| `dept_code` | string | 是 | 32 | — | 台次所属科室编码 |
| `idempotency_key` | string | 是 | 64 | — | 请求级幂等键（整批提交的去重键） |
| `key_profile` | string | 是 | 16 | v1 / v2 / legacy | 请求级键档位（对端按版本灰度） |
| `uses` | array | 是 | — | — | 耗材使用明细数组 |
<!-- /contract-table -->

#### 3.5.2 `uses[]` 明细契约

<!-- contract-table:material-use -->
| 字段 | 类型 | 必填 | 长度上限 | 允许取值 | 说明 |
|---|---|---|---|---|---|
| `material_code` | string | 是 | 32 | — | 院内耗材码（归一后的规范码） |
| `quantity` | integer | 是 | ≥ 1 | — | 使用数量（正整数，计价单位口径） |
| `price_code` | string | 是 | 32 | — | 价码（耗材主数据的价格编码） |
| `use_time` | string（ISO 8601） | 是 | — | — | 使用时间（ISO 8601） |
| `fee_category` | string | 是 | — | 床位 / 诊察 / 检查 / 化验 / 治疗 / 手术 / 护理 / 卫生材料 / 西药 / 中药饮片 / 中成药 / 一般诊疗 / 挂号 / 其他 | 费用类别（院内 14 类口径；耗材只落卫生材料类） |
| `medical_insurance_class` | string | 是 | — | 甲类 / 乙类 / 丙类 | 医保分类（甲类 / 乙类 / 丙类） |
| `idempotency_key` | string | 是 | 64 | — | 行级幂等键（这一笔耗材消费的去重键，重投复用同一把） |
| `key_profile` | string | 是 | 16 | v1 / v2 / legacy | 行级键档位（v1 / v2 / 历史行 legacy） |
<!-- /contract-table -->

#### 3.5.3 响应体契约

<!-- contract-table:material-uses-response -->
| 字段 | 类型 | 必填 | 长度上限 | 允许取值 | 说明 |
|---|---|---|---|---|---|
| `accepted` | array | 是 | — | — | 对端已接收的条目数组 |
| `rejected` | array | 是 | — | — | 对端拒绝的条目数组 |
| `idempotency_key` | string | 否 | 64 | — | 对端回显的请求级键（对端未启用幂等时无此字段） |
<!-- /contract-table -->

`accepted[]` 元素：`material_code`（string，必填）、`idempotency_key`（string，选填）。
`rejected[]` 元素：`material_code`（string，必填）、`reason_code`（string，必填）、`idempotency_key`（string，选填）。

> `rejected[].reason_code` 是**必填**的：没有原因码就没法定处置档位
> （可重投 / 不可重投 / 需人工），只能靠猜 —— 缺了就当「对端协议不符」整批进重投。

## 4. 响应体字段
| 字段 | 类型 | 说明 |
|---|---|---|
| `accepted` | array | 对端已接收的条目数组，元素含 `material_code` |
| `rejected` | array | 对端拒绝的条目数组，元素含 `material_code` 与 `reason_code` |
| `idempotency_key` | string | **可选**：对端回显的请求级键（对端未启用幂等时无此字段） |

| 字段 | 类型 | 说明 |
|---|---|---|
| `accepted[].material_code` | string | 被接收的耗材码 |
| `accepted[].idempotency_key` | string | **可选**：对端回显的行级键（收到的是哪把键） |
| `rejected[].material_code` | string | 被拒的耗材码 |
| `rejected[].reason_code` | string | 拒绝原因码（回执码 → 可重投 / 不可重投 / 需人工 三档处置见 §6） |
| `rejected[].idempotency_key` | string | **可选**：对端回显的行级键（收到的是哪把键） |

示例响应体（脱敏）：

```json
{
  "accepted": [{ "material_code": "MAT-SAMPLE-01", "idempotency_key": "9b8a7f6e…e5f607" }],
  "rejected": [{ "material_code": "MAT-SAMPLE-99", "reason_code": "PRICE_CODE_NOT_FOUND" }],
  "idempotency_key": "3f2a1c9d…c1b0a9f8e7d"
}
```

> 回显字段**全部可选**：对端没实现幂等去重时直接不返回这些字段即可，
> 本侧按 `NOT_ECHOED` 处理（见 §3.4），不影响计费闭环。

**响应结构不符**（缺 `accepted` / `rejected`、非 JSON、空体）一律按「对端协议不符」处理：抛
`ERR_CHARGE_RESPONSE_INVALID` 并进重投队列，**不静默当成成功**。

## 5. 费用类别与医保分类口径

口径来源：院内《医保结算清单字段规范》**「医疗收费信息」分区**（与住院收费票据口径一致，
医疗收费信息共 98 项，为清单 193 项中的收费分区）。

### 5.1 费用类别（`fee_category`）

允许集为 14 类费用：床位、诊察、检查、化验、治疗、手术、护理、**卫生材料**、西药、
中药饮片、中成药、一般诊疗、挂号、其他。

- 耗材条目一律落在 **「卫生材料」** 类；
- 不在允许集内的取值由主数据导入环节列出差异清单，**运行期不自动改主数据**。

### 5.2 医保分类（`medical_insurance_class`）

取值档位沿用「医疗收费信息」分区的 **甲类 / 乙类 / 自费 / 其他** 四档。

- 主数据里的 `fee_category` 与 `medical_insurance_class` 必须自洽，组合落在允许矩阵内；
- 不自洽组合在绑定阶段即被拒并给独立原因码，不静默改写。

> 本轮只做**口径一致性校验**，不做任何医学判断，也不生成任何临床文书。

## 6. 错误码与重试约定

出站失败的错误码与「通道当时可达否 / 是否值得重投」是**同一张表**的四个字段，
上层回执台账据此分流（可重投 → 指数退避；不可重投 → 直接转人工核查）。

| 错误码 | 中文含义 | 通道可达 | 可重投 | 处置 |
|---|---|---|---|---|
| `ERR_CHARGE_CONFIG` | 出站端点配置缺失或非法 | 否 | 否 | 不发请求；指名环境变量，交信息科修配置 |
| `ERR_CHARGE_REQUEST_INVALID` | 请求体字段不合法 | 否 | 否 | 不发请求；该条拒，不拖累同批其余条目 |
| `ERR_CHARGE_CONTRACT_VIOLATION` | 请求体与**字段契约**不符（取值越界：费用类别 / 医保分类 / 键档位不在允许集内等） | 否 | 否 | 不发请求；回执里带「字段名 + 期望 + 实际」逐项清单，修正取值后由人工重投 |
| `ERR_CHARGE_FIELD_TOO_LONG` | 关键字段超出长度上限（台次号 / 科室编码 / 耗材码 / 价码） | 否 | 否 | 不发请求；**不截断后照发**，被拒条目转核查条目，修正主数据后由人工重投 |
| `ERR_CHARGE_TIMEOUT` | **响应**超时（已建连，对端迟迟不给结论） | 否 | 是 | 指数退避重投，重投次数在回执中可见 |
| `ERR_CHARGE_CONNECT_TIMEOUT` | **连接**超时（连接没建起来） | 否 | 是 | 指数退避重投；核对地址、端口与院内网络策略 |
| `ERR_CHARGE_CIRCUIT_OPEN` | 通道已熔断（连续失败达阈值），本次请求未发出 | 否 | 是 | 不外发；条目照常进退避重投队列，通道恢复后自动探测回写 |
| `ERR_CHARGE_NETWORK` | 连接失败 / DNS 失败 | 否 | 是 | 指数退避重投 |
| `ERR_CHARGE_HTTP_5XX` | 对端 5xx | 是 | 是 | 指数退避重投 |
| `ERR_CHARGE_HTTP_4XX` | 对端 4xx | 是 | 否 | 不重投，直接转人工核查 |
| `ERR_CHARGE_RESPONSE_INVALID` | 响应结构不符 | 是 | 是 | 按不可达处理进重投，不静默当成成功 |

### 6.1 超时分级与连接复用

出站请求的等待时间分**两段**预算，各配各的（都是环境变量，不硬编码）：

| 阶段 | 环境变量 | 默认值 | 覆盖范围 | 触发错误码 |
|------|----------|--------|----------|------------|
| 连接（TCP 建连 + TLS 握手） | `HIS_CHARGING_CONNECT_TIMEOUT_MS` | 5 秒 | 一次请求 | `ERR_CHARGE_CONNECT_TIMEOUT` |
| 响应（请求发出 → 拿到结论） | `HIS_CHARGING_TIMEOUT_MS` | 10 秒 | **基数**：按本批条目数线性放大 | `ERR_CHARGE_TIMEOUT` |
| 响应放大上限 | `HIS_CHARGING_MAX_RESPONSE_TIMEOUT_MS` | 60 秒 | 封顶，再大的批次也不无限等 | — |

> 响应超时按**条目数**放大：一条耗材等 10 秒合理，一百条还等 10 秒就不合理（对端在批量处理）。
> 放大后仍受上限约束 —— 不能让守护进程吊在一个永远不回的请求上。

连接**复用**（keep-alive）：同一进程内多批提交走同一个连接池，不为每条耗材新建一次
TCP + TLS。连接池参数：`HIS_CHARGING_KEEP_ALIVE_MS`（保活时长，默认 30 秒）、
`HIS_CHARGING_MAX_SOCKETS`（最大并发连接，默认 16）。

### 6.2 连续失败熔断

HIS 计费侧在忙时会很慢甚至挂掉。守护进程是**常驻**的，如果每条扫码都傻等超时，
一台手术十几条耗材就会把整批拖住 —— 所以通道不健康时会自动**短路**：

| 项 | 约定 |
|---|---|
| 触发 | 连续 N 次**通道级**失败（连接失败 / 连接超时 / 响应超时 / 5xx / 响应结构不符）达阈值 |
| 阈值 | `HIS_CHARGING_CIRCUIT_FAILURE_THRESHOLD`，默认 5 次 |
| 打开后 | 请求**直接短路、不外发**，抛 `ERR_CHARGE_CIRCUIT_OPEN`（通道不可达、可重投） |
| 恢复 | 冷却 `HIS_CHARGING_CIRCUIT_COOLDOWN_MS`（默认 30 秒）后放**一次**探测；探测成功即恢复，失败则重新计时 |
| 对端 4xx | **不计入**熔断（通道是通的，是对端不收这条） |
| 数据不丢 | 短路期间的条目**照常进退避重投队列**并留在台账里（计费状态 = 待重投），**不静默丢弃** |
| 可查 | 熔断状态落在台账 `meta` 表；`doctor` 显示当前是否熔断、连续失败次数与下次探测时间 |

**重试约定**

| 项 | 约定 |
|---|---|
| 重投间隔 | 指数退避（base × 2^n），间隔与上限可配 |
| 重投上限 | 达上限条目生成核查任务并转人工，**不静默丢弃** |
| 单批失败 | 某一批整体失败只让该批进重投，其余批的结论照常落库 |
| 冲正 | 本轮**不做**自动冲正；已回写计费的条目不自动回退 |
| 幂等 | 重投复用**同一把幂等键**（不因重试次数变化而改键） |

### 6.1 回执台账字段（逐条 · 只增不改）

每条耗材**每次投递**写一行回执（表 `charge_receipt`）。回执台账只追加、不覆盖，
`attempt` 序号连续 —— 护士长问「这条被拒了几次、每次错在哪」时可直接回放。

| 字段 | 类型 | 说明 |
|---|---|---|
| `material_code` / `operation_no` | string | 耗材码与台次号（耗材码只绑台次，不落患者可识别明细） |
| `idempotency_key` / `key_profile` | string | 本次投递用的**行级**幂等键与键档位（v1 / v2），重投复用同一把键 |
| `request_idempotency_key` | string | 带来这一行的**请求级**键（整批提交的去重键；事后按键反查整批用） |
| `peer_idempotency_status` | string | 对端回显状态：`ECHOED` / `NOT_ECHOED`（对端未启用幂等）/ `MISMATCH` |
| `attempt` | int | 本行是该条目的第几次尝试（连续序号） |
| `delivery_count` | int | 累计投递次数 = `attempt`；**重投次数在回执里可见** |
| `accepted` | 0/1 | 对端是否接收 |
| `kind` | string | 归类档位，见下表 |
| `reason_code` | string | 原因码：对端给的业务码，或本侧 `ERR_CHARGE_*` |
| `error_code` | string | 本侧错误码（`ERR_CHARGE_*`） |
| `channel_reachable` | 0/1 | 通道当时是否可达（源回执 `active` 语义） |
| `retryable` | 0/1 | 值不值得重投 |
| `disposition` | string | 处置档位：`RETRYABLE` / `NOT_RETRYABLE` / `NEEDS_HUMAN`（对端已接收时为空） |
| `requested_at` / `responded_at` | string | 请求发出 / 回执到手时间（ISO 8601） |
| `response_summary` | string | 对端回执摘要（脱敏短句） |

**归类档位 `kind` 与处置**

| `kind` | 中文含义 | 通道可达 | 可重投 | 处置 |
|---|---|---|---|---|
| `ACCEPTED` | 对端已接收 | 是 | 否 | 台账状态推进到「已回写计费」 |
| `BUSINESS_REJECTED` | 通道可达但对端业务拒绝 | 是 | 视回执码 | 按回执码的处置档位分流（见 6.3） |
| `CHANNEL_UNREACHABLE` | 超时 / 连接失败 | 否 | 是 | 指数退避重投 |
| `CHANNEL_ERROR` | 对端 5xx | 是 | 是 | 指数退避重投 |
| `PROTOCOL_ERROR` | 响应结构不符 / 对端没给这条的结论 | 否 / 是 | 是 | 指数退避重投，**不静默当成成功**（回执整体为空时按通道不可达处理） |
| `LOCAL_ERROR` | 本侧配置或请求体问题（未发出请求） | 否 | 否 | 不重投，转核查任务 |

### 6.3 对端回执 `reason_code` 契约

对端在 `rejected[].reason_code` 里回的业务码，决定这条**要不要重投、重投有没有意义**。
本侧与对端的约定码如下（真源：`src/charge/reason-codes.ts`；处置三档见
[错误码对照表](errors.md) 的「计费回执 reason_code 处置判定表」）：

| 回执码 | 中文含义 | 处置档位 |
|---|---|---|
| `PEER_RATE_LIMITED` | 对端计费侧限流（同一时刻提交过多） | 可重投 |
| `PEER_SERVICE_BUSY` | 对端计费服务繁忙（临时不可用） | 可重投 |
| `PEER_UPSTREAM_TIMEOUT` | 对端内部调用计费上游超时 | 可重投 |
| `PEER_STOCK_LOCKED` | 耗材库存临时锁定（出入库作业占用中） | 可重投 |
| `PRICE_CODE_NOT_FOUND` | 价码在计费侧不存在 | 不可重投 |
| `MATERIAL_NOT_CHARGEABLE` | 耗材在计费侧未建档 | 不可重投 |
| `INSURANCE_CLASS_MISMATCH` | 医保分类与计费侧目录不一致 | 不可重投 |
| `FEE_CATEGORY_MISMATCH` | 费用类别与计费侧归类口径不一致 | 不可重投 |
| `QUANTITY_EXCEEDED` | 数量超出计费侧上限 | 不可重投 |
| `QUANTITY_NOT_POSITIVE` | 数量不是正数 | 不可重投 |
| `INSUFFICIENT_STOCK` | 高值耗材库存不足 | 不可重投 |
| `PEER_OPERATION_NOT_FOUND` | 计费侧查不到这个台次 | 不可重投 |
| `PEER_OPERATION_CLOSED` | 计费侧台次已关台 | 不可重投 |
| `INSURANCE_RULE_CONFLICT` | 医保规则冲突 | 需人工 |
| `SPECIAL_MATERIAL_APPROVAL` | 特殊耗材需审批 | 需人工 |
| `OPERATOR_NOT_AUTHORIZED` | 收费员权限不足 | 需人工 |
| `MANUAL_CHARGE_REQUIRED` | 对端要求人工补录 | 需人工 |
| `DUPLICATE_CHARGE` | 对端判本笔为重复计费 | 需人工 |
| `IDEMPOTENCY_KEY_CONFLICT` | 幂等键冲突（对端见过这把键但内容不同） | 需人工 |

**未登记的码**：一律按「不可重投 + 需人工」处理（fail safe）—— 先转人工核查，
并把原始码登记进错误码表待补项与审计链（`charge_reason_code_unknown`），
**不默认当作可重投**；与对端确认口径后补进上表即可。

### 6.2 重投调度参数

| 项 | 默认值 | 说明 |
|---|---|---|
| 投递次数上限（含首次） | 3 | 达上限即生成核查任务并转人工 |
| 退避基数 `base` | 1000 ms | 第 n 次重投的间隔 = `base × 2^(n-1)`，封顶 `max` |
| 单次间隔上限 `max` | 30000 ms | 退避封顶，避免夜里把对端打爆 |
| 台账状态（可重投时） | 停在「待重投」 | 失败不静默改数据：条目留在台账里等重投 |

## 7. 联调示例

```bash
# 端点基址与令牌来自环境变量；这里只演示请求形状
curl -sS -X POST \
  -H "Authorization: Bearer $HIS_CHARGING_TOKEN" \
  -H "content-type: application/json" \
  -d '{"operation_no":"OP-2026-0115-007","dept_code":"DEPT-0301","idempotency_key":"3f2a1c9d0b8e7a6f5c4d3e2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d","key_profile":"v1","uses":[{"material_code":"MAT-SAMPLE-01","quantity":1,"price_code":"PR-SAMPLE-01","use_time":"2026-01-15T09:12:00.000Z","fee_category":"卫生材料","medical_insurance_class":"甲类","idempotency_key":"9b8a7f6e5d4c3b2a1908172635445362718293a4b5c6d7e8f90a1b2c3d4e5f607","key_profile":"v1"}]}' \
  "${HIS_CHARGING_BASE_URL}/api/v1/material-uses"
```

## 8. 凭据与脱敏约定

| 项 | 约定 |
|---|---|
| 令牌来源 | 只从环境变量 `HIS_CHARGING_TOKEN` 读取，不落配置文件、不硬编码 |
| 盖章位置 | 只在出站客户端一层盖章；业务层只拿得到「能发请求的端口」 |
| 日志 | `Authorization` 一律打码为 `Bearer ***`；端点去掉 query |
| 异常 | 异常信息与堆栈中不出现令牌明文（出站客户端内做兜底替换） |
| 缺位行为 | 缺 `HIS_CHANGING_BASE_URL` / `HIS_CHARGING_TOKEN` → 该路拒绝启动并指名变量名，其余路不受影响 |
