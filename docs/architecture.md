# 架构与数据流

> 这份文档回答四个问题：**一条扫码从设备到台账中间经过了哪几道关口**、
> **耗材条目的状态怎么流转、哪些流转被禁止**、**幂等键是怎么算出来的**、
> **台账的表结构与索引长什么样**。
> 写给两类人看：信息科要排障时照着数据流找卡点，评审时要逐条核对口径。

本文档是**手写**的架构说明；由脚本生成的对照表（判定矩阵全表、状态机全量迁移表）
放在 `docs/api/` 下，本文档引用它们而不是复制它们 —— 复制就会走偏。

## 文档地图

| 文档 | 内容 | 谁维护 |
|---|---|---|
| 本文件 | 数据流 / 状态机 / 幂等键 / 表结构与索引 | 手写，随代码演进 |
| [`api/judgement-matrix.md`](api/judgement-matrix.md) | 637 行判定矩阵（码制 × 台次 × 归属 × 主数据 × 计费 × 数量） | `npm run docs:judgement` 生成 |
| [`api/state-matrix.md`](api/state-matrix.md) | 条目状态机 64 对全量迁移表 | `npm run docs:matrix` 生成 |
| [`api/errors.md`](api/errors.md) | 统一错误码表（码 / 含义 / 可重投 / 处置 / 排查顺序） | `npm run docs:api` 生成 |
| [`cli.md`](cli.md) | 运维命令行手册（十个子命令的完整参数） | 手写，随代码演进 |
| [`examples.md`](examples.md) | 脱敏的真实输入输出样例 | 手写，随代码演进 |

---

## 1. 主数据流

```
        ┌──────────────────────────┐         ┌──────────────────────────┐
        │  扫码枪 HTTP 接入         │         │  RFID 网关目录投递        │
        │  POST /api/v1/scan-events │         │  scan-inbox/<台次>/<批次>  │
        └────────────┬─────────────┘         └────────────┬─────────────┘
                     │  Authorization + HMAC 签名             │  文件轮询
                     │  ┌────────────────────────────────────┐ │
                     └─▶│ ① 验签 + 三层重放防护                │◀┘
                        │  签名不通过 → 401，不落台账           │
                        └───────────────┬────────────────────┘
                                        ▼
                        ┌───────────────────────────────────────┐
                        │ ② 字段标准化                           │
                        │  UDI / GS1 AI(01) / 院内码 → 规范耗材码 │
                        │  纯字段映射，无临床判断                 │
                        └───────────────┬───────────────────────┘
                                        ▼
                        ┌───────────────────────────────────────┐
                        │ ③ 幂等占位（claim / confirm / release）│
                        │  键 = sha256(档位|耗材码|台次[|批号])   │
                        │  占位 + 租约；重复投递判 DUPLICATE_SCAN  │
                        └───────────────┬───────────────────────┘
                                        ▼
                        ┌───────────────────────────────────────┐
                        │ ④ 绑定判定引擎                         │
                        │  三层校验 → 台次状态 → 归属 → 单位口径   │
                        │  → 数量换算 → 跨台次重复 → 五种结论      │
                        └───────┬───────────────────────┬───────┘
                                │ BOUND                │ 异常结论
                                ▼                       ▼
              ┌──────────────────────────┐   ┌──────────────────────────┐
              │ ⑤ 耗材使用台账落行        │   │ ⑤′ 核查条目（带台次上下文）│
              │  material_binding         │   │  check_task               │
              │  + audit_chain（只增不改）  │   │  责任岗位路由 + 超时升级   │
              └────────────┬─────────────┘   └────────────┬─────────────┘
                           │                                 │
                           ▼                                 │
              ┌──────────────────────────┐                  │
              │ ⑥ 出站计费回写             │◀─────────────────┘
              │  POST {HIS}/api/v1/       │
              │       material-uses       │
              │  Bearer 单一出口盖章        │
              └────────────┬─────────────┘
                           ▼
              ┌──────────────────────────────────────────────┐
              │ ⑦ 逐条回执归类 + 指数退避重投                  │
              │  charge_receipt（每次 attempt 一行）           │
              │  通道不可达 → 重投；业务拒绝 → 直接转人工       │
              └────────────┬─────────────────────────────────┘
                           ▼
              ┌──────────────────────────────────────────────┐
              │ ⑧ 批次摘要推送（企业微信机器人）                │
              │  失败不阻塞台账落库，失败计数写审计链            │
              └──────────────────────────────────────────────┘

  全程留痕：scan_event（原始报文 + 归一结果）→ material_binding（台账）
          → charge_receipt（回执）→ check_task（核查）→ audit_chain（哈希链，只增不改）
```

### 三条主路径一句话

| 路径 | 干什么 | 失败时落在哪 |
|---|---|---|
| **入站** | 收扫码事件 → 归一 → 幂等 → 判定 → 落台账 → 出站计费 → 回执归类 → 推送 | 异常条目升核查条目，人工闭环 |
| **运维** | `cli.js` 查状态、导清单、重放验证幂等、跑月度对账 | 退出码 + 审计链 |
| **数据** | 合成 / 公开数据 → 主数据导入（导入即生效）→ 判定引擎现读镜像表 | 缺列的主数据升 `master_data_gap` |

---

## 2. 模块地图

| 目录 / 文件 | 职责 | 在主路径上的位置 |
|---|---|---|
| `src/config/env.ts` | 三路凭据位解析（入站 / 出站 / 推送），缺哪一路只让哪一路不可用 | 全局前置 |
| `src/config/scanner-registry.ts` | 扫码枪注册表（多台设备的台次归属） | 入站 ① |
| `src/ingest/http-server.ts` | 入站 HTTP 服务、抬头级 / 明细级两级闸门、逐条回执组装 | 入站 ① |
| `src/ingest/signature.ts` | HMAC-SHA256 验签（常量时间比较，空密钥 fail closed） | 入站 ① |
| `src/ingest/replay-guard.ts` | 三层重放防护（时间戳窗口 / nonce / 幂等键） | 入站 ① |
| `src/ingest/codes.ts` | 码制解析：UDI / GS1 AI(01) / 院内码 / GTIN 校验位 | 入站 ② |
| `src/ingest/normalize.ts` | 字段标准化（原始码 → 规范耗材码 + 规范化数量与时间） | 入站 ② |
| `src/ingest/adapters/` | 事件源接口与两种实现（HTTP / 目录），共用解析层与幂等键 | 入站 ① |
| `src/domain/idempotency.ts` | 幂等键派生（三档位）+ 请求级键 + 租约语义 | 入站 ③ |
| `src/domain/state.ts` | 条目状态机全量迁移矩阵（8 × 8 = 64 对）与角色校验 | 全局 |
| `src/domain/scan-event.ts` | 扫码事件类型与运行时字段校验 | 入站 ② |
| `src/engine/validate-code.ts` | 三层校验：结构 → 字典映射 → 业务 | 判定 ④ |
| `src/engine/operation.ts` | 台次状态判定（open / closed / unknown）与科室归属 | 判定 ④ |
| `src/engine/units.ts` | 单位口径与数量换算（包 / 支 / 套 → 计价数量） | 判定 ④ |
| `src/engine/fee-category.ts` | 费用类别与医保分类口径校验（院内 14 类口径） | 判定 ④ |
| `src/engine/conclude.ts` | 五种结论归类器（BOUND / NOT_REGISTERED / CROSS_OP_DUP / CLOSED / CHARGE_REJECTED） | 判定 ④ |
| `src/engine/binding.ts` | 归属双因子交叉核对（手术间 × 科室） | 判定 ④ |
| `src/engine/settle.ts` | 批量结算：逐条独立，单条失败不丢同批其余 | 入站 ⑤ |
| `src/ledger/db.ts` | 连接、事务边界、按批切分 | 全局 |
| `src/ledger/migrations.ts` | 迁移版本链（26 版，逐版幂等，失败不前移版本号） | 全局 |
| `src/ledger/claim.ts` | 幂等占位（claim / confirm / release）与过期接管 | 入站 ③ |
| `src/ledger/audit.ts` | 审计链只增不改（接口层不提供 update / delete） | 全程 |
| `src/ledger/audit-hash.ts` | 审计链哈希链（prev_hash / row_hash）与断链定位 | 全程 |
| `src/ledger/binding-repo.ts` | 台账行读写与状态推进 | 入站 ⑤ |
| `src/ledger/reconcile.ts` | 台账 ↔ 计费回执逐条对账与差异归因 | 运维 |
| `src/ledger/monthly.ts` | 月度对账聚合（科室 × 业务月）与对账包 | 运维 |
| `src/ledger/import-master-data.ts` | 主数据导入（导入即生效） | 数据 |
| `src/ledger/master-data-watcher.ts` | 主数据热更新监听（导入即生效，不重启） | 数据 |
| `src/ledger/event-log.ts` | 事件日志落盘（原始报文 + 归一结果 + 请求标识） | 入站 ① |
| `src/charge/client.ts` | 出站 HTTP 客户端（Bearer 单一出口盖章、日志脱敏） | 出站 ⑥ |
| `src/charge/submit.ts` | 计费请求组装与字段规范 | 出站 ⑥ |
| `src/charge/receipt.ts` | 回执逐条归类落库 | 出站 ⑦ |
| `src/charge/retry.ts` | 指数退避重投调度（base × 2ⁿ，间隔与上限可配） | 出站 ⑦ |
| `src/charge/writeback.ts` | 台次级批量回写（按对端限批切分） | 出站 ⑥ |
| `src/charge/circuit.ts` | 连续失败熔断与恢复探测 | 出站 ⑥ |
| `src/charge/sanitize.ts` | 载荷清洗（GBK / UTF-8 混编、生僻字、超长、空值） | 出站 ⑥ |
| `src/charge/quantity.ts` | 计价数量换算与换算轨迹 | 出站 ⑥ |
| `src/check/task.ts` | 核查条目生成、人工确认回写、撤回 | 入站 ⑤′ |
| `src/check/route.ts` | 核查责任岗位路由与超时升级 | 入站 ⑤′ |
| `src/check/closing-report.ts` | 关台核对清单（可关台 / 待核查 / 待计费 三档） | 运维 |
| `src/check/message-template.ts` | 企微批次消息模板（按台次聚合、去重节流） | 出站 ⑧ |
| `src/check/notify.ts` | 企微推送（失败不阻塞台账落库） | 出站 ⑧ |
| `src/log/logger.ts` | 结构化 JSON 日志（凭据零明文） | 全程 |
| `src/log/error-codes.ts` | 统一错误码表与原因码 → 错误码映射 | 全程 |
| `src/log/summary.ts` | 运行摘要聚合（从台账与审计链读，不靠内存计数） | 运维 |
| `src/daemon/runner.ts` | 常驻主循环（两路事件源 + 结算 + 推送） | 主路径 |
| `src/daemon/startup-check.ts` | 启动自检（凭据位 / 目录可写 / schema 版本） | 启动 |
| `src/daemon/heartbeat.ts` | 心跳记录（版本 / 时长 / 台账行数 / 凭据位齐否） | 运维 |
| `src/daemon/shutdown.ts` | 优雅停机（停收新事件 → 等在途结算 → 落盘退出） | 停机 |
| `src/cli/` | 运维命令行（十个子命令，参数契约在 `args.ts`） | 运维 |

---

## 3. 条目状态机

### 3.1 八个状态

| 状态 | 含义 | 谁推进 |
|---|---|---|
| `scanned` | 已扫码（收到原始事件） | 入站 |
| `parsed` | 已解析（码制归一完成） | 入站 |
| `bound` | 已绑台次（判定结论为 BOUND，台账已落行） | 绑定引擎 |
| `rejected` | 判定异常（异常结论，还没升核查条目） | 绑定引擎 |
| `charged` | 已计费（出站回写成功，回执已落库） | 计费回写 |
| `confirmed` | 已确认（人工确认过计费） | 人工确认 |
| `check_pending` | 待核查（异常条目已生成核查任务，等人落定结论） | 绑定引擎 / 计费回写 / 人工撤回 |
| `closed` | 已闭环（终态，自动迁移表内没有任何出边） | 人工确认 |

### 3.2 状态图

```
   ┌────────┐   ┌────────┐         ┌──────────┐
   │scanned │──▶│ parsed │────────▶│  bound   │─────┐
   └────────┘   └────────┘         └──────────┘     │ 计费回写成功
        ▲          │   │                 │           ▼
        │          │   │ 异常结论         │ 异常    ┌─────────┐
        │          │   ▼                 ▼         │ charged │
        │          │ ┌──────────┐   ┌──────────────┐└─────────┘
        │          │ │ rejected │──▶│ check_pending │   │
        │          │ └──────────┘   └──────────────┘   │ 人工确认
        │          │        │             ▲   │        ▼
        │          │        │ 人工确认    │   └──▶┌───────────┐
        │          │        └─────────────┴──────┤ confirmed │
        │          │                              └───────────┘
        │          │ 人工判定无需处理                    │ 人工确认
        │          └──────────────────────────────────▶┌────────┐
        │                                             │ closed │ ← 终态
        │                                             └────────┘
        │                                                  ▲
        └───────────── 人工撤回（独立入口，不走自动迁移）──────┘
                              closed ──▶ check_pending
```

### 3.3 迁移表（白名单）

**状态推进边（12 条）** —— 同一对 `(from, to)` 只认表里列出的角色，角色不符即拒。

| 起始 | 目标 | 触发方 | 说明 |
|---|---|---|---|
| `scanned` | `parsed` | `ingest` | 入站解析完成 |
| `parsed` | `bound` | `binding_engine` | 绑定本台次成功 |
| `parsed` | `rejected` | `binding_engine` | 绑定判定为异常 |
| `parsed` | `check_pending` | `binding_engine` | 异常条目转核查 |
| `bound` | `charged` | `charge_writeback` | 计费回写成功 |
| `bound` | `check_pending` | `binding_engine` / `charge_writeback` | 计费业务拒绝，转人工 |
| `rejected` | `check_pending` | `binding_engine` | 异常条目生成核查任务 |
| `rejected` | `closed` | `manual_confirm` | 人工判定无需处理，直接闭环 |
| `charged` | `confirmed` | `manual_confirm` | 人工确认已计费 |
| `charged` | `check_pending` | `charge_writeback` / `manual_confirm` | 计费结果存疑，转人工 |
| `confirmed` | `closed` | `manual_confirm` | 确认后闭环 |
| `check_pending` | `closed` | `manual_confirm` | 核查结论落定，闭环 |

**幂等自环边（2 条）** —— 放行，但**不推进状态**、不重写确认时间。

| 起始 | 目标 | 触发方 | 说明 |
|---|---|---|---|
| `confirmed` | `confirmed` | `manual_confirm` | 重复确认：幂等自环，不推进 |
| `check_pending` | `check_pending` | `manual_confirm` / `revoke` | 撤回 / 重复落结论：幂等自环，不推进 |

**人工撤回边（1 条）** —— 独立于自动迁移表，单独断言。

| 起始 | 目标 | 触发方 | 说明 |
|---|---|---|---|
| `closed` | `check_pending` | `revoke` | 人工撤回误确认；**已回写计费的条目不自动冲正** |

### 3.4 三条硬约束

| 约束 | 表现 |
|---|---|
| **终态保护** | `closed` 在自动迁移表里**没有任何出边**（`allowedTargets('closed')` 为空）。任何自动路径都不能把终态条目改回去。 |
| **不自动冲正** | 不存在 `charged → rejected` / `charged → parsed`。已回写计费的条目不能退回计费前的状态；退回只能由人工撤回入口发起，且**不冲正计费**。 |
| **拒绝即不改数据** | 白名单外的迁移抛 `StateTransitionError`（`code=ERR_ILLEGAL_STATE_TRANSITION`，带 `from` / `to` / `actor`），**不写任何台账行**，并在审计链留一行 `state_transition_rejected`。 |

> 全量 64 对的逐对判定表（含每对的拒绝文案）见
> [`api/state-matrix.md`](api/state-matrix.md)，由 `npm run docs:matrix` 从 `src/domain/state.ts` 生成。
> 每次成功迁移往审计链追加一行 `state_transition`（`from` / `to` / `actor` / `request_id` / `created_at`），状态序列可回放。

---

## 4. 幂等键派生

### 4.1 三档键

| 档位 | 参与哈希的原文 | 语义 | 可配置 |
|---|---|---|---|
| `legacy` | `material_code\|operation_no` | 历史格式，**只读**：升级前的台账行与占位行仍是这个格式，程序不再新写，但认得它 —— 保证升级后老行不会被当成新事件 | 否（只读） |
| `v1` | `v1\|material_code\|operation_no` | **默认档位**：同一耗材同一台次只算一次，批号不参与 | 是 |
| `v2` | `v2\|material_code\|operation_no\|batch_no` | 批号参与去重：同一耗材同一台次的**不同批号各算一次**（各产生一行台账与一次计费） | 是 |

档位由配置项 `IDEMPOTENCY_KEY_PROFILE` 控制，默认 `v1`；取值只接受 `v1` / `v2`，非法值**启动即报错**（`ERR_INVALID_CONFIG`，指名变量名）。

档位写在原文**最前面**，键里因此自带版本号 —— 迁移期新旧两代键可以并存，旧键不会被新口径误判成同一笔。

### 4.2 派生示例（真实值）

| 输入 | 参与哈希的原文 | 派生结果 |
|---|---|---|
| `MAT-SAMPLE-01` / `OP-SAMPLE-001` / v1 | `v1\|MAT-SAMPLE-01\|OP-SAMPLE-001` | `eefc8904df9fd37a5009143a85fd5fe195219df5bb5cc96657ed21fcb865a434` |
| `MAT-SAMPLE-01` / `OP-SAMPLE-001` / v2 / `LOT-SAMPLE-A` | `v2\|MAT-SAMPLE-01\|OP-SAMPLE-001\|LOT-SAMPLE-A` | `aa2c5d1e0e429d6af1e2244fb3285a7fc3d28fdbf6807ed900e0f471bd40327e` |
| `MAT-SAMPLE-01` / `OP-SAMPLE-001` / legacy | `MAT-SAMPLE-01\|OP-SAMPLE-001` | `5054ce5ad1366e8c81a070be72d242fd87ccb3ee4236512bda6ed1dd76e29bfb` |
| `06900000002636` / `OP-SYN-000145` / v1 | `v1\|06900000002636\|OP-SYN-000145` | `defaa95b705b370f303eecd5351cadab1e8fc9bb848146e203d632857d467fef` |

> 上表第 4 行是月度对账跑测里真实落库的那一行 —— 台账行的 `idempotency_key` 与这里逐字相同。

### 4.3 请求级键

除行级键外，还有一把**请求级键**（整批提交的去重键），与行级键一起**透传给对端**，
让 HIS 计费侧也能按键去重 —— 本侧幂等只挡得住「自己重复发」，挡不住对端重试。

| 项 | 值 |
|---|---|
| 原文 | `req\|<台次号>\|<行级键1>\|<行级键2>…` |
| 行级键排序 | **升序入哈希** —— 同一批条目无论以什么顺序提交，请求级键都一样 |
| 档位前缀 | 不掺入 —— 行级键本身已带档位，档位变了行级键就变 |
| 透传字段 | 请求头 `Idempotency-Key`；对端未回显时台账记 `peer_idempotency_status = NOT_ECHOED` |

### 4.4 幂等不变量

| 不变量 | 证明方式 |
|---|---|
| **键与时间戳、重试次数、扫码枪编号无关** | 只有「哪个耗材 + 哪台手术（+ 哪一档键口径）」决定一次计费；否则重投会被当成新事件，重复计费 |
| 同键重复投递只产生**一行台账、一次计费** | `material_binding.idempotency_key` 唯一索引 + `idempotency_claim` 租约占位，两道防线 |
| v2 缺批号时**降级成 v1** | 批号未知就分不清「同一批重扫」与「另一批的同款耗材」；宁可按 v1 只算一次，也不冒重复计费的风险。降级事实由 `batch_missing` 标出 |
| 租约到期可被接管，**接管不产生重复计费** | `claim_count` 递增但台账仍一行（见 [`benchmarks/concurrency-benchmark.md`](benchmarks/concurrency-benchmark.md)） |

---

## 5. 判定矩阵（承接边界矩阵文档化）

五种结论是产品**判定语义的核心**。判定按下面顺序逐层短路，**先命中先返回**：

| 序 | 判定层 | 不通过时的结论 | 不通过时的原因码 |
|---|---|---|---|
| ① | 排台台次查得到吗 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` |
| ② | 台次已关台了吗 | `CLOSED` | `OPERATION_CLOSED` |
| ③ | 耗材码结构 / 码制层过了吗 | `NOT_REGISTERED` | `CODE_EMPTY` / `CODE_TOO_LONG` / `CODE_ILLEGAL_CHARSET` / `CODE_FORM_UNRECOGNIZED` / `CODE_GTIN_CHECK_DIGIT_INVALID` |
| ④ | 主数据查得到这一行吗 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` |
| ⑤ | 耗材启用吗 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` |
| ⑥ | 费用类别 / 医保分类口径合规吗 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_ALLOWED` / `INSURANCE_CLASS_INVALID` / `FEE_CATEGORY_INSURANCE_MISMATCH` / `FEE_CATEGORY_NOT_CONSUMABLE` |
| ⑦ | 单位口径自洽吗 | `NOT_REGISTERED` | `UNIT_UNIT_MISSING` / `UNIT_RATIO_MISSING` / `UNIT_RATIO_INVALID` / `UNIT_MAPPING_INCONSISTENT` |
| ⑧ | 数量按包装换算成计价单位是整数吗 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` / `UNIT_QUANTITY_NOT_POSITIVE` |
| ⑨ | 同一耗材已绑在**别的**台次吗 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` |
| ⑩ | 计费通道给了业务拒绝吗 | `CHARGE_REJECTED` | 对端码（如 `PRICE_CODE_NOT_FOUND`） |
| ⑪ | 其余 | `BOUND` | — |

**绝不猜绑**：只要存在歧义（台次缺失 / 主数据缺失 / 耗材停用 / 口径不合规 / 归属冲突 /
数量换不出来 / 计费被拒），结果一定落在异常结论上，**绝不**落到 `BOUND`；
异常条目一律升成带台次上下文的核查条目交人工，不自动补录、不自动冲正。

**批号维度的位置**：`同台次同码但批号不同`在**结论层**仍是 `BOUND` ——
批号属于幂等档位（`v1` 判重复、`v2` 各算一次），由结算层处理，不改变绑定结论本身。

### 5.1 六个维度的取值覆盖（637 条用例）

| 维度 | 取值（括号内为 fixture 原始取值）与条数 | 合计 |
|---|---|---|
| 码制形态 | 院内码 `internal` · 49<br>院内码（点号分隔）`internal_dotted` · 49<br>院内码（下划线分隔）`internal_underscore` · 49<br>裸 GTIN-14 `gtin_bare` · 49<br>UDI（只有器械标识）`udi` · 49<br>UDI（含生产标识批号）`udi_batch` · 49<br>GS1 AI(01) 包装码 `gs1_ai01` · 49<br>UDI（校验位错）`udi_bad_check` · 49<br>裸 GTIN-14（校验位错）`gtin_bad_check` · 49<br>空码 `empty` · 49<br>超长码 `too_long` · 49<br>非法字符集 `illegal_charset` · 49<br>形态识别不出 `form_unrecognized` · 49 | 637 |
| 台次状态 | 开台 `open` · 455<br>已关台 `closed` · 91<br>排台里查不到 `unknown` · 91 | 637 |
| 耗材归属 | 首次扫到 `first` · 403<br>已绑在别的台次 `duplicate_other_op` · 117<br>同台次同码但批号不同 `batch_diff` · 117 | 637 |
| 主数据状态 | 在册且口径齐 `registered` · 455<br>主数据查不到 `unregistered` · 52<br>已停用 `inactive` · 52<br>缺换算系数 `ratio_missing` · 39<br>费用口径不合规 `fee_invalid` · 39 | 637 |
| 计费结果 | 无业务拒绝 `none` · 507<br>业务拒绝 `business_rejected` · 130 | 637 |
| 数量 | `1` · 208　`2` · 182　`3` · 182　`0.5` · 26　`4` · 13　`5` · 13　`6` · 13 | 637 |

### 5.2 结论分布与原因码分布

| 结论 | 中文说明 | 用例条数 |
|---|---|---|
| `NOT_REGISTERED` | 绑不上（耗材码 / 台次 / 口径问题） | 399 |
| `CLOSED` | 台次已关台（走人工计费补录） | 91 |
| `BOUND` | 绑上本台次 | 63 |
| `CROSS_OP_DUP` | 同一耗材已绑在别的台次（后到者拒） | 42 |
| `CHARGE_REJECTED` | 绑定成立但计费通道业务拒绝 | 42 |

| 原因码 | 条数 |
|---|---|
| `OPERATION_CLOSED` | 91 |
| `OPERATION_NOT_FOUND` | 91 |
| `CODE_GTIN_CHECK_DIGIT_INVALID` | 70 |
| —（绑上，无原因码） | 63 |
| `CROSS_OP_DUPLICATE_MATERIAL` | 42 |
| `PRICE_CODE_NOT_FOUND` | 42 |
| `CODE_EMPTY` / `CODE_TOO_LONG` / `CODE_ILLEGAL_CHARSET` / `CODE_FORM_UNRECOGNIZED` | 各 35 |
| `MATERIAL_NOT_REGISTERED` / `MATERIAL_INACTIVE` / `UNIT_RATIO_MISSING` / `FEE_CATEGORY_NOT_CONSUMABLE` | 各 21 |
| `QUANTITY_NOT_DIVISIBLE` | 14 |

**全表（637 行逐条对照）在 [`api/judgement-matrix.md`](api/judgement-matrix.md)**，
由 `npm run docs:judgement` 从 `tests/boundary/boundary-cases.csv` 生成 ——
文档、属性测试、产品代码对的是**同一份期望表**，不会各说各话。

原因码 → 统一错误码（`ERR_*`）的映射见 [`api/errors.md`](api/errors.md)：
同一个问题在**判定结果 / 核查条目 / 结构化日志 / 计费回执行**里显示的是**同一个码**。

---

## 6. 数据库表结构与索引

台账库是单文件 SQLite（`node:sqlite`），默认 `journal_mode = wal`、
`busy_timeout = 5000` 毫秒、外键约束开启。**本产品只把耗材码绑到手术台次，不落患者可识别明细。**

### 6.1 四类业务表

| 表 | 作用 | 关键字段 |
|---|---|---|
| `material_binding` | 耗材使用台账（绑在哪台手术、用了几支） | `idempotency_key`、`operation_no`、`room_no`、`dept_code`、`material_code`、`quantity`、`price_code`、`fee_category`、`medical_insurance_class`、`conclusion`、`status`、`check_task_id`、`raw_code`、`key_profile`、`batch_no`、`code_form`、`code_parse_trace`、`charge_quantity`、`quantity_trace`、`event_room_no` / `master_room_no`、`event_dept_code` / `master_dept_code`、`use_time` |
| `charge_receipt` | 计费回执台账（每条耗材每次尝试一行） | `material_code`、`operation_no`、`idempotency_key`、`key_profile`、`attempt`、`accepted`、`reason_code`、`error_code`、`channel_reachable`、`delivery_count`、`kind`、`retryable`、`submitted_quantity` / `submitted_price_code` / `submitted_fee_category` / `submitted_medical_insurance_class`、`request_idempotency_key`、`peer_idempotency_status`、`disposition`、`attempt_source` |
| `check_task` | 核查任务台账（异常条目 + 台次上下文 + 人工结论） | `operation_no`、`room_no`、`dept_code`、`scanner_id`、`material_code`、`quantity`、`conclusion`、`reason_code`、`status`、`assignee_role`、`assigned_at`、`reminded_at`、`escalated_at`、`timeout_level`、`detected_at`、`confirmed_at` / `confirmed_by` / `confirmed_conclusion`、`revoked_at` / `revoked_by`、`source_operation_no` / `source_room_no`、`binding_id`、`error_code`、`reconcile_diff_id`、`event_room_no` / `master_room_no`、`event_dept_code` / `master_dept_code` |
| `audit_chain` | 只增不改的审计链（哈希链） | `event_type`、`binding_key`、`operation_no`、`scanner_id`、`actor`、`detail`、`prev_hash`、`row_hash`、`created_at`、`request_id` |

### 6.2 支撑表

| 表 | 作用 | 关键字段 |
|---|---|---|
| `operation` | 手术排台台次的本地镜像 | `operation_no`、`room_no`、`dept_code`、`status`、`closed_at`、`updated_at` |
| `material` | 院内耗材主数据的本地镜像 | `material_code`、`name`、`price_code`、`fee_category`、`medical_insurance_class`、`active`、`batch_no`、`unit_pack`、`unit_min`、`charge_unit`、`ratio` |
| `idempotency_claim` | 幂等占位（claim / confirm / release 三段租约的落点） | `key`、`token`、`state`、`claim_count`、`operation_no`、`material_code`、`scanner_id`、`claimed_at`、`expires_at_ms`、`confirmed_at`、`released_at`、`release_reason` |
| `scan_event` | 事件日志（原始报文 + 归一结果） | `request_id`、`received_at`、`source`、`operation_no`、`room_no`、`scanner_id`、`raw_body`、`normalized_json`、`signature_verified`、`idempotency_key`、`conclusion`、`batch_id` |
| `notify_delivery` | 企微推送台账 | `batch_key`、`operation_no`、`status`、`error_code`、`detail` |
| `reconcile_diff` | 台账 ↔ 计费回执差异台账 | `diff_key`、`diff_type`、`attribution`、`attribution_detail`、`operation_no`、`room_no`、`dept_code`、`material_code`、`quantity` / `ledger_quantity` / `receipt_quantity`、`ledger_*` / `receipt_*` 对照列、`mismatched_fields`、`suggested_action`、`error_code`、`status`、`binding_id`、`receipt_id`、`check_task_id` |
| `master_data_gap` | 主数据缺口（缺列 / 停用 / 口径不合规） | `material_code`、`gap_type`、`detail`、`status`、`detected_at`、`resolved_at` |
| `master_data_import` | 主数据导入履历（版本化） | `version`、`imported_at`、`source`、台次与耗材的新增 / 更新 / 跳过 / 前后镜像行数 |
| `meta` | 进程元信息（心跳、停机记录、熔断状态） | `key`、`value`、`updated_at` |
| `migrations` | 迁移履历 | `version`、`name`、`applied_at`、`source`（`chain` / `legacy_backfill`） |

### 6.3 索引

| 索引 | 表 | 服务的查询 |
|---|---|---|
| `ux_material_binding_idem` | `material_binding` | 幂等键唯一（`idempotency_key`）—— 第二道防线 |
| `ux_material_binding_code_op` | `material_binding` | `(material_code, operation_no)` 唯一，**部分索引** `WHERE key_profile IN ('legacy','v1')` |
| `ux_material_binding_code_op_batch` | `material_binding` | `(material_code, operation_no, batch_no)` 唯一，`WHERE key_profile = 'v2'` |
| `ix_material_binding_op_code` | `material_binding` | 按台次查（台次 → 耗材） |
| `ix_material_binding_code_created` | `material_binding` | 按耗材码 + 时间窗查 |
| `ix_material_binding_status_created` | `material_binding` | 按状态查待核查 / 待计费 |
| `ix_material_binding_op_created` | `material_binding` | 按台次 + 时间窗查（关台核对、月度对账） |
| `ix_material_binding_code_form` | `material_binding` | 按码制形态查（码制改造后回查） |
| `ix_material_binding_code_op` | `material_binding` | 按耗材码 + 台次查（跨台次重复判定） |
| `ix_material_binding_operation` | `material_binding` | 按台次查 |
| `ix_charge_receipt_item` | `charge_receipt` | 按耗材码 + 台次查（对账对齐） |
| `ix_check_task_status` | `check_task` | 按状态 + 时间查待办 |
| `ix_check_task_routing` | `check_task` | `(status, assignee_role, reminded_at, timeout_level)` —— 责任岗位路由与超时升级 |
| `ix_audit_chain_operation` | `audit_chain` | 按台次 + 时间查审计轨迹 |
| `ix_claim_state_expires` | `idempotency_claim` | `(state, expires_at_ms)` —— 租约到期扫描与接管 |
| `ix_scan_event_received_at` / `ix_scan_event_operation` / `ix_scan_event_batch` | `scan_event` | 按时间 / 台次 / 批次回查事件 |
| `ix_notify_delivery_status` | `notify_delivery` | 按状态查推送成败 |
| `ix_reconcile_diff_status` / `ix_reconcile_diff_op` | `reconcile_diff` | 按状态 / 台次查差异 |
| `ux_reconcile_diff_key` | `reconcile_diff` | 差异去重键唯一 |
| `ux_master_data_gap_material_type` | `master_data_gap` | `(material_code, gap_type)` 唯一 |
| `ux_master_data_import_version` | `master_data_import` | 导入版本唯一 |

> 四类真实查询（按台次 / 按耗材码 / 按状态 / 按时间窗）用 `EXPLAIN QUERY PLAN` 验证过，
> 全部 `USING INDEX`，不退化为全表扫描。

### 6.4 触发器（只增不改的数据库级护栏）

| 触发器 | 作用 |
|---|---|
| `trg_audit_chain_no_update` | `BEFORE UPDATE ON audit_chain` → 拒绝，报错信息含「audit_chain 只增不改」 |
| `trg_audit_chain_no_delete` | `BEFORE DELETE ON audit_chain` → 拒绝（删行会打断哈希链） |

接口层同样不导出任何 `update` / `delete` 方法 —— **护栏是双层的**。

### 6.5 迁移版本链

`user_version` + `migrations` 履历表，逐版本幂等执行。**任一版本迁移失败时回滚该版本事务、
版本号不前移、进程非零退出**（打印失败版本号与原因）—— 半新半旧的表结构不许开跑。

| 版本 | 名称 | 做了什么 |
|---|---|---|
| 1 | `base_ledger_schema` | 六张基础表与首批索引 |
| 2 | `idempotency_claim` | 幂等占位表 |
| 3 | `binding_key_profile` | 台账行记键档位 |
| 4 | `check_task_context` | 核查条目带台次上下文 |
| 5 | `receipt_delivery_tracking` | 回执行记投递次数与通道可达性 |
| 6 | `check_task_error_code` | 核查条目记统一错误码 |
| 7 | `audit_request_id` | 审计行记请求标识 |
| 8 | `event_notify_meta` | 事件日志、推送台账、进程元信息表 |
| 9 | `composite_query_indexes` | 四类复合索引 |
| 10 | `audit_chain_hash_chain` | 审计链补算封印（`prev_hash` / `row_hash`） |
| 11 | `binding_key_versioning` | 键档位并存：历史行认领为 `legacy`，部分唯一索引按档位拆分 |
| 12 | `reconcile_diff_ledger` | 差异台账 |
| 13 | `code_parse_trace` | 码制解析轨迹 |
| 14 | `unit_conversion` | 单位口径与换算轨迹 |
| 15 | `fee_category_policy` | 费用类别 / 医保分类口径 |
| 16 | `master_data_import_log` | 主数据导入履历 |
| 17 | `attribution_cross_check` | 归属双因子交叉核对 |
| 18 | `outbound_idempotency_passthrough` | 出站幂等键透传 |
| 19 | `receipt_disposition` | 回执处置结论 |
| 20 | `charge_payload_sanitize` | 载荷清洗轨迹 |
| 21 | `receipt_attempt_history` | 计费尝试史 |
| 22 | `check_task_routing` | 核查责任岗位路由与超时升级 |
| 23 | `replay_interval_selection` | 重放区间选择 |
| 24 | `replay_nonce_guard` | nonce 防重放记录 |
| 25 | `event_log_traceability` | 事件日志溯源索引 |
| 26 | `binding_use_time` | 台账行记使用时刻 |

---

## 7. 事务边界与并发

| 场景 | 口径 |
|---|---|
| **事务包装** | `withTransaction(fn)` **可重入**：已在事务里就复用外层事务，不重复 `BEGIN`。最外层那一次 `COMMIT` / `ROLLBACK` 说了算 |
| **同事务三写** | 台账行 + 审计行 + 回执行**同事务提交或同事务回滚** —— 不允许半写。中途抛错时三张表行数均与抛错前一致 |
| **批量切分** | 一批一个事务，超过阈值（`LEDGER_BATCH_SIZE`，默认 **200** 条）按批切分。一批失败不影响别的批，**条目条数始终守恒**（失败那批逐条补 `rejected`） |
| **幂等占位** | `claim` 是原子 `INSERT OR IGNORE`：已存在且租约未过期 → `busy`（不重复处理）；租约到期 → 接管，`claim_count` 递增 |
| **第二道防线** | `material_binding` 上有幂等键唯一索引 —— 就算绕开幂等键直接插第二行，也会被 `UNIQUE constraint failed` 挡住 |
| **写锁竞争** | WAL + `busy_timeout`（默认 5000 毫秒）：并发写撞上时等一会儿再报错，而不是立刻失败 |

---

## 8. 关键不变量

| # | 不变量 | 违反时的表现 |
|---|---|---|
| 1 | **幂等键与时间戳、重试次数、扫码枪编号无关** | 同一笔消费会被算成多笔 → 重复计费 |
| 2 | **同键只产生一行台账、一次计费** | 重复占位 → 重复计费 |
| 3 | **绝不猜绑**：有歧义一律落异常结论 | 台次串了 → 计到别的手术上 |
| 4 | **单条失败不丢同批其余** | 一条坏数据拖累整台手术的计费 |
| 5 | **状态迁移白名单外一律拒绝，且不改数据** | 已计费的条目被静默退回 → 账实不符 |
| 6 | **失败不静默改数据**：异常一律抛错或落异常结论 | 异常被吞掉 → 缺口看不见 |
| 7 | **凭据单一出口**：Bearer 只在出站客户端层盖章 | 令牌出现在日志或异常信息里 |
| 8 | **审计链只增不改**（接口 + 触发器双层护栏） | 台账被动过却查不出来 → 内审 / 飞检不可信 |
| 9 | **已回写计费的条目不自动冲正** | 自动冲正会改掉已经落账的收费 |
| 10 | **绝不自动补录**：台次已关台等异常一律转人工 | 替人做临床 / 收费决定 |

---

## 9. 失败与降级路径

| 失败点 | 检测方式 | 处置 | 台账影响 |
|---|---|---|---|
| 入站验签不通过 | 签名比对失败 | 401，不落台账，审计链记 `inbound_rejected` | 无 |
| 时间戳超窗 / nonce 重放 | 重放防护 | 401，审计链记 `inbound_replay_rejected` | 无 |
| 抬头缺台次号 | 抬头级闸门 | **整批 400** | 无（该批全部退回设备侧改） |
| 明细字段缺失 / 类型不对 | 明细级闸门 | **只拒那一条**，其余照常入台账 | 该条进 `rejected` |
| 目录路某行是坏 JSON | 逐行解析 | **只拒那一行**，审计链记 `ingest_bad_line` | 该行进 `rejected` |
| 主数据缺失 / 停用 / 口径不合规 | 判定层 ④⑤⑥ | 升核查条目 | 该条进 `rejected` |
| 数量换算不成整数 | 判定层 ⑧ | 升核查条目 | 该条进 `rejected` |
| 同一耗材已绑别的台次 | 判定层 ⑨ | 后到者拒（**先到者台账行原样保留**），升核查条目 | 该条进 `rejected` |
| 出站超时 / 连接失败 | 通道不可达 | 指数退避重投（base × 2ⁿ），达上限转人工 | 台账行保留，状态停在待重投 |
| 出站业务拒绝（4xx） | 通道可达但拒收 | **不重投**，直接转人工核查 | 台账行保留，`charge_receipt` 留回执 |
| 对端返回非 JSON / 结构不符 | 响应校验 | `ERR_CHARGE_RESPONSE_INVALID`，按不可重投处理 | 不写计费成功状态 |
| 企微推送失败 | webhook 非 2xx | 捕获后计数写审计链，**不抛出到主流程** | 无（台账已落） |
| 进程崩溃（占位未确认） | 租约到期 | `requeueExpired()` 重新入队续跑 | 台账仍一行，不重复计费 |
| 数据库迁移失败 | 版本链 | 回滚该版本、版本号不前移、进程非零退出 | 不动业务行 |
| 审计链被改 / 被删 | 哈希链校验 | 校验失败，指出**第一个断点行号**与期望 / 实际哈希 | 触发的 UPDATE / DELETE 被触发器拒绝 |

---

## 10. 相关文档

| 想了解 | 看这里 |
|---|---|
| 命令行怎么用 | [`cli.md`](cli.md) |
| 输入输出长什么样 | [`examples.md`](examples.md) |
| 判定矩阵全表（637 行） | [`api/judgement-matrix.md`](api/judgement-matrix.md) |
| 状态机 64 对全量迁移表 | [`api/state-matrix.md`](api/state-matrix.md) |
| 错误码与排查顺序 | [`api/errors.md`](api/errors.md) |
| 入站接口规范（设备侧联调） | [`api/scan-event.md`](api/scan-event.md) |
| 出站接口规范（HIS 侧联调） | [`api/his-charging.md`](api/his-charging.md) |
| 企微推送规范 | [`api/wecom-notify.md`](api/wecom-notify.md) |
| 关台核对清单口径 | [`api/closing-report.md`](api/closing-report.md) |
| 对账差异归因口径 | [`api/reconcile.md`](api/reconcile.md) |
| 幂等与并发的实测数字 | [`benchmarks/idempotency-benchmark.md`](benchmarks/idempotency-benchmark.md)、[`benchmarks/concurrency-benchmark.md`](benchmarks/concurrency-benchmark.md) |
| 月度对账跑测数字 | [`benchmarks/monthly-reconcile.md`](benchmarks/monthly-reconcile.md) |
