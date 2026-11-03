# 判定矩阵（边界矩阵用例逐条对照）

> 一条扫码进来，判定引擎给出**唯一**一条结论：BOUND（绑上本台次）/ NOT_REGISTERED（绑不上）/ CROSS_OP_DUP（跨台次重复）/ CLOSED（台次已关台）/ CHARGE_REJECTED（计费通道业务拒绝）。本表把 637 条维度组合逐行列出来，供科室与信息科逐行核对「为什么落这个结论、要不要转人工」。

## 这份文档是什么

五种结论是本产品**判定语义的核心**。护士长关台核对时看到的是结论，信息科排障时看到的是原因码与错误码；两者必须能对上，所以这份矩阵表**从 fixture 生成**（`npm run docs:judgement`），而 fixture 又是属性测试（`node --test dist/tests/boundary-matrix.test.js`）逐条断言的期望表 —— **文档、测试、产品代码三者对同一份期望，不会各说各话**。

矩阵里的用例**不是**院内真实数据，是脚本生成的边界样例（码制 × 台次状态 × 归属 × 主数据 × 计费 × 数量）；真实院内数据由主数据导入器进镜像表，判定口径与本表一致。

## 判定顺序（逐层短路）

一条输入**只落一种结论**，按下面顺序逐层短路，先命中先返回：

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

**绝不猜绑**：只要存在歧义（台次缺失 / 主数据缺失 / 耗材停用 / 口径不合规 / 归属冲突 / 数量换不出来 / 计费被拒），结果一定落在异常结论上，**绝不**落到 `BOUND`；异常条目一律升成带台次上下文的核查条目交人工，不自动补录、不自动冲正。

**批号维度的位置**：`同台次同码但批号不同`在**结论层**仍是 `BOUND` —— 批号属于幂等档位（`v1` 判重复、`v2` 各算一次），由结算层处理，不改变绑定结论本身。

## 维度取值与覆盖

| 维度 | 取值（括号内为 fixture 里的原始取值） | 用例条数 |
|---|---|---|
| 码制形态 | 院内码（`internal`） · 49<br>院内码（点号分隔）（`internal_dotted`） · 49<br>院内码（下划线分隔）（`internal_underscore`） · 49<br>裸 GTIN-14（`gtin_bare`） · 49<br>UDI（只有器械标识）（`udi`） · 49<br>UDI（含生产标识批号）（`udi_batch`） · 49<br>GS1 AI(01) 包装码（`gs1_ai01`） · 49<br>UDI（校验位错）（`udi_bad_check`） · 49<br>裸 GTIN-14（校验位错）（`gtin_bad_check`） · 49<br>空码（`empty`） · 49<br>超长码（`too_long`） · 49<br>非法字符集（`illegal_charset`） · 49<br>形态识别不出（`form_unrecognized`） · 49 | 637 |
| 台次状态 | 开台（`open`） · 455<br>已关台（`closed`） · 91<br>排台里查不到（`unknown`） · 91 | 637 |
| 耗材归属 | 首次扫到（`first`） · 403<br>已绑在别的台次（`duplicate_other_op`） · 117<br>同台次同码但批号不同（`batch_diff`） · 117 | 637 |
| 主数据状态 | 在册且口径齐（`registered`） · 455<br>主数据查不到（`unregistered`） · 52<br>已停用（`inactive`） · 52<br>缺换算系数（`ratio_missing`） · 39<br>费用口径不合规（`fee_invalid`） · 39 | 637 |
| 计费结果 | 计费通道无业务拒绝（`none`） · 507<br>计费通道业务拒绝（`business_rejected`） · 130 | 637 |
| 数量 | 1（`1`） · 208<br>2（`2`） · 182<br>3（`3`） · 182<br>0.5（`0.5`） · 26<br>4（`4`） · 13<br>5（`5`） · 13<br>6（`6`） · 13 | 637 |

## 结论分布

| 结论 | 中文说明 | 用例条数 |
|---|---|---|
| `NOT_REGISTERED` | 绑不上（耗材码 / 台次 / 口径问题） | 399 |
| `CLOSED` | 台次已关台（走人工计费补录） | 91 |
| `BOUND` | 绑上本台次 | 63 |
| `CROSS_OP_DUP` | 同一耗材已绑在别的台次（后到者拒） | 42 |
| `CHARGE_REJECTED` | 绑定成立但计费通道业务拒绝 | 42 |

## 原因码分布

| 原因码 | 用例条数 |
|---|---|
| `OPERATION_CLOSED` | 91 |
| `OPERATION_NOT_FOUND` | 91 |
| `CODE_GTIN_CHECK_DIGIT_INVALID` | 70 |
| `—（绑上，无原因码）` | 63 |
| `CROSS_OP_DUPLICATE_MATERIAL` | 42 |
| `PRICE_CODE_NOT_FOUND` | 42 |
| `CODE_EMPTY` | 35 |
| `CODE_TOO_LONG` | 35 |
| `CODE_ILLEGAL_CHARSET` | 35 |
| `CODE_FORM_UNRECOGNIZED` | 35 |
| `MATERIAL_NOT_REGISTERED` | 21 |
| `MATERIAL_INACTIVE` | 21 |
| `UNIT_RATIO_MISSING` | 21 |
| `FEE_CATEGORY_NOT_CONSUMABLE` | 21 |
| `QUANTITY_NOT_DIVISIBLE` | 14 |

原因码与统一错误码（`ERR_*`）的映射见 [`docs/api/errors.md`](api/errors.md) —— 同一个问题在**判定结果 / 核查条目 / 结构化日志 / 计费回执行**里显示的是**同一个码**。

## 判定矩阵总表

下表 **637 行**，与边界矩阵用例**一一对应**（每行一条用例，含预期结论、原因码、是否需人工）。「需人工」= 异常条目会升成带台次上下文的核查条目，等护士长 / 耗材管理岗落定结论。

| 用例 | 模板 | 码制 | 台次状态 | 主数据状态 | 归属 | 计费结果 | 数量 | 预期结论 | 原因码 | 需人工 |
|---|---|---|---|---|---|---|---|---|---|---|
| `BC-001` | T01 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-002` | T01 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-003` | T01 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-004` | T02 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-005` | T02 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-006` | T02 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-007` | T03 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-008` | T03 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-009` | T03 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-010` | T04 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-011` | T04 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-012` | T04 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-013` | T05 | 院内码（`internal`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-014` | T05 | 院内码（`internal`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-015` | T05 | 院内码（`internal`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-016` | T06 | 院内码（`internal`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-017` | T06 | 院内码（`internal`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-018` | T06 | 院内码（`internal`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-019` | T07 | 院内码（`internal`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-020` | T07 | 院内码（`internal`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-021` | T07 | 院内码（`internal`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-022` | T08 | 院内码（`internal`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-023` | T08 | 院内码（`internal`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-024` | T08 | 院内码（`internal`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-025` | T09 | 院内码（`internal`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-026` | T09 | 院内码（`internal`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-027` | T09 | 院内码（`internal`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-028` | T10 | 院内码（`internal`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-029` | T10 | 院内码（`internal`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-030` | T10 | 院内码（`internal`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-031` | T11 | 院内码（`internal`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-032` | T11 | 院内码（`internal`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-033` | T11 | 院内码（`internal`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-034` | T12 | 院内码（`internal`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-035` | T12 | 院内码（`internal`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-036` | T12 | 院内码（`internal`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-037` | T13 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-038` | T14 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-039` | T15 | 院内码（`internal`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-040` | T16 | 院内码（`internal`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-041` | T17 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-042` | T17 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-043` | T17 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-044` | T18 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-045` | T18 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-046` | T18 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-047` | T19 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `BOUND` | — | 否 |
| `BC-048` | T19 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `BOUND` | — | 否 |
| `BC-049` | T19 | 院内码（`internal`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `BOUND` | — | 否 |
| `BC-050` | T01 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-051` | T01 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-052` | T01 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-053` | T02 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-054` | T02 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-055` | T02 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-056` | T03 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-057` | T03 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-058` | T03 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-059` | T04 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-060` | T04 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-061` | T04 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-062` | T05 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-063` | T05 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-064` | T05 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-065` | T06 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-066` | T06 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-067` | T06 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-068` | T07 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-069` | T07 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-070` | T07 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-071` | T08 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-072` | T08 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-073` | T08 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-074` | T09 | 院内码（点号分隔）（`internal_dotted`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-075` | T09 | 院内码（点号分隔）（`internal_dotted`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-076` | T09 | 院内码（点号分隔）（`internal_dotted`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-077` | T10 | 院内码（点号分隔）（`internal_dotted`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-078` | T10 | 院内码（点号分隔）（`internal_dotted`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-079` | T10 | 院内码（点号分隔）（`internal_dotted`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-080` | T11 | 院内码（点号分隔）（`internal_dotted`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-081` | T11 | 院内码（点号分隔）（`internal_dotted`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-082` | T11 | 院内码（点号分隔）（`internal_dotted`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-083` | T12 | 院内码（点号分隔）（`internal_dotted`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-084` | T12 | 院内码（点号分隔）（`internal_dotted`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-085` | T12 | 院内码（点号分隔）（`internal_dotted`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-086` | T13 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-087` | T14 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-088` | T15 | 院内码（点号分隔）（`internal_dotted`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-089` | T16 | 院内码（点号分隔）（`internal_dotted`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-090` | T17 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-091` | T17 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-092` | T17 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-093` | T18 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-094` | T18 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-095` | T18 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-096` | T19 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `BOUND` | — | 否 |
| `BC-097` | T19 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `BOUND` | — | 否 |
| `BC-098` | T19 | 院内码（点号分隔）（`internal_dotted`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `BOUND` | — | 否 |
| `BC-099` | T01 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-100` | T01 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-101` | T01 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-102` | T02 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-103` | T02 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-104` | T02 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-105` | T03 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-106` | T03 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-107` | T03 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-108` | T04 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-109` | T04 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-110` | T04 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-111` | T05 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-112` | T05 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-113` | T05 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-114` | T06 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-115` | T06 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-116` | T06 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-117` | T07 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-118` | T07 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-119` | T07 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-120` | T08 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-121` | T08 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-122` | T08 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-123` | T09 | 院内码（下划线分隔）（`internal_underscore`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-124` | T09 | 院内码（下划线分隔）（`internal_underscore`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-125` | T09 | 院内码（下划线分隔）（`internal_underscore`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-126` | T10 | 院内码（下划线分隔）（`internal_underscore`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-127` | T10 | 院内码（下划线分隔）（`internal_underscore`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-128` | T10 | 院内码（下划线分隔）（`internal_underscore`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-129` | T11 | 院内码（下划线分隔）（`internal_underscore`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-130` | T11 | 院内码（下划线分隔）（`internal_underscore`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-131` | T11 | 院内码（下划线分隔）（`internal_underscore`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-132` | T12 | 院内码（下划线分隔）（`internal_underscore`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-133` | T12 | 院内码（下划线分隔）（`internal_underscore`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-134` | T12 | 院内码（下划线分隔）（`internal_underscore`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-135` | T13 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-136` | T14 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-137` | T15 | 院内码（下划线分隔）（`internal_underscore`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-138` | T16 | 院内码（下划线分隔）（`internal_underscore`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-139` | T17 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-140` | T17 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-141` | T17 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-142` | T18 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-143` | T18 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-144` | T18 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-145` | T19 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `BOUND` | — | 否 |
| `BC-146` | T19 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `BOUND` | — | 否 |
| `BC-147` | T19 | 院内码（下划线分隔）（`internal_underscore`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `BOUND` | — | 否 |
| `BC-148` | T01 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-149` | T01 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-150` | T01 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-151` | T02 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-152` | T02 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-153` | T02 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-154` | T03 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-155` | T03 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-156` | T03 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-157` | T04 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-158` | T04 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-159` | T04 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-160` | T05 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-161` | T05 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-162` | T05 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-163` | T06 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-164` | T06 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-165` | T06 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-166` | T07 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-167` | T07 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-168` | T07 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-169` | T08 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-170` | T08 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-171` | T08 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-172` | T09 | 裸 GTIN-14（`gtin_bare`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-173` | T09 | 裸 GTIN-14（`gtin_bare`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-174` | T09 | 裸 GTIN-14（`gtin_bare`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-175` | T10 | 裸 GTIN-14（`gtin_bare`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-176` | T10 | 裸 GTIN-14（`gtin_bare`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-177` | T10 | 裸 GTIN-14（`gtin_bare`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-178` | T11 | 裸 GTIN-14（`gtin_bare`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-179` | T11 | 裸 GTIN-14（`gtin_bare`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-180` | T11 | 裸 GTIN-14（`gtin_bare`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-181` | T12 | 裸 GTIN-14（`gtin_bare`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-182` | T12 | 裸 GTIN-14（`gtin_bare`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-183` | T12 | 裸 GTIN-14（`gtin_bare`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-184` | T13 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-185` | T14 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-186` | T15 | 裸 GTIN-14（`gtin_bare`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-187` | T16 | 裸 GTIN-14（`gtin_bare`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-188` | T17 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-189` | T17 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-190` | T17 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-191` | T18 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-192` | T18 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-193` | T18 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-194` | T19 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `BOUND` | — | 否 |
| `BC-195` | T19 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `BOUND` | — | 否 |
| `BC-196` | T19 | 裸 GTIN-14（`gtin_bare`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `BOUND` | — | 否 |
| `BC-197` | T01 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-198` | T01 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-199` | T01 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-200` | T02 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-201` | T02 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-202` | T02 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-203` | T03 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-204` | T03 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-205` | T03 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-206` | T04 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-207` | T04 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-208` | T04 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-209` | T05 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-210` | T05 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-211` | T05 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-212` | T06 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-213` | T06 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-214` | T06 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-215` | T07 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-216` | T07 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-217` | T07 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-218` | T08 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-219` | T08 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-220` | T08 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-221` | T09 | UDI（只有器械标识）（`udi`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-222` | T09 | UDI（只有器械标识）（`udi`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-223` | T09 | UDI（只有器械标识）（`udi`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-224` | T10 | UDI（只有器械标识）（`udi`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-225` | T10 | UDI（只有器械标识）（`udi`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-226` | T10 | UDI（只有器械标识）（`udi`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-227` | T11 | UDI（只有器械标识）（`udi`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-228` | T11 | UDI（只有器械标识）（`udi`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-229` | T11 | UDI（只有器械标识）（`udi`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-230` | T12 | UDI（只有器械标识）（`udi`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-231` | T12 | UDI（只有器械标识）（`udi`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-232` | T12 | UDI（只有器械标识）（`udi`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-233` | T13 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-234` | T14 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-235` | T15 | UDI（只有器械标识）（`udi`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-236` | T16 | UDI（只有器械标识）（`udi`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-237` | T17 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-238` | T17 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-239` | T17 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-240` | T18 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-241` | T18 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-242` | T18 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-243` | T19 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `BOUND` | — | 否 |
| `BC-244` | T19 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `BOUND` | — | 否 |
| `BC-245` | T19 | UDI（只有器械标识）（`udi`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `BOUND` | — | 否 |
| `BC-246` | T01 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-247` | T01 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-248` | T01 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-249` | T02 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-250` | T02 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-251` | T02 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-252` | T03 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-253` | T03 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-254` | T03 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-255` | T04 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-256` | T04 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-257` | T04 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-258` | T05 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-259` | T05 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-260` | T05 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-261` | T06 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-262` | T06 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-263` | T06 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-264` | T07 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-265` | T07 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-266` | T07 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-267` | T08 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-268` | T08 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-269` | T08 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-270` | T09 | UDI（含生产标识批号）（`udi_batch`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-271` | T09 | UDI（含生产标识批号）（`udi_batch`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-272` | T09 | UDI（含生产标识批号）（`udi_batch`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-273` | T10 | UDI（含生产标识批号）（`udi_batch`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-274` | T10 | UDI（含生产标识批号）（`udi_batch`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-275` | T10 | UDI（含生产标识批号）（`udi_batch`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-276` | T11 | UDI（含生产标识批号）（`udi_batch`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-277` | T11 | UDI（含生产标识批号）（`udi_batch`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-278` | T11 | UDI（含生产标识批号）（`udi_batch`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-279` | T12 | UDI（含生产标识批号）（`udi_batch`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-280` | T12 | UDI（含生产标识批号）（`udi_batch`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-281` | T12 | UDI（含生产标识批号）（`udi_batch`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-282` | T13 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-283` | T14 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-284` | T15 | UDI（含生产标识批号）（`udi_batch`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-285` | T16 | UDI（含生产标识批号）（`udi_batch`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-286` | T17 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-287` | T17 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-288` | T17 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-289` | T18 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-290` | T18 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-291` | T18 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-292` | T19 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `BOUND` | — | 否 |
| `BC-293` | T19 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `BOUND` | — | 否 |
| `BC-294` | T19 | UDI（含生产标识批号）（`udi_batch`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `BOUND` | — | 否 |
| `BC-295` | T01 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-296` | T01 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-297` | T01 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-298` | T02 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-299` | T02 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-300` | T02 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-301` | T03 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `BOUND` | — | 否 |
| `BC-302` | T03 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `BOUND` | — | 否 |
| `BC-303` | T03 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `BOUND` | — | 否 |
| `BC-304` | T04 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-305` | T04 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-306` | T04 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-307` | T05 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-308` | T05 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-309` | T05 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` | 是 |
| `BC-310` | T06 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-311` | T06 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-312` | T06 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` | 是 |
| `BC-313` | T07 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-314` | T07 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-315` | T07 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `UNIT_RATIO_MISSING` | 是 |
| `BC-316` | T08 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-317` | T08 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-318` | T08 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_CONSUMABLE` | 是 |
| `BC-319` | T09 | GS1 AI(01) 包装码（`gs1_ai01`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-320` | T09 | GS1 AI(01) 包装码（`gs1_ai01`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-321` | T09 | GS1 AI(01) 包装码（`gs1_ai01`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-322` | T10 | GS1 AI(01) 包装码（`gs1_ai01`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-323` | T10 | GS1 AI(01) 包装码（`gs1_ai01`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-324` | T10 | GS1 AI(01) 包装码（`gs1_ai01`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-325` | T11 | GS1 AI(01) 包装码（`gs1_ai01`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-326` | T11 | GS1 AI(01) 包装码（`gs1_ai01`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-327` | T11 | GS1 AI(01) 包装码（`gs1_ai01`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-328` | T12 | GS1 AI(01) 包装码（`gs1_ai01`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-329` | T12 | GS1 AI(01) 包装码（`gs1_ai01`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-330` | T12 | GS1 AI(01) 包装码（`gs1_ai01`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-331` | T13 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-332` | T14 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` | 是 |
| `BC-333` | T15 | GS1 AI(01) 包装码（`gs1_ai01`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-334` | T16 | GS1 AI(01) 包装码（`gs1_ai01`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-335` | T17 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-336` | T17 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-337` | T17 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` | 是 |
| `BC-338` | T18 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-339` | T18 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-340` | T18 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `CHARGE_REJECTED` | `PRICE_CODE_NOT_FOUND` | 是 |
| `BC-341` | T19 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `BOUND` | — | 否 |
| `BC-342` | T19 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `BOUND` | — | 否 |
| `BC-343` | T19 | GS1 AI(01) 包装码（`gs1_ai01`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `BOUND` | — | 否 |
| `BC-344` | T01 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-345` | T01 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-346` | T01 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-347` | T02 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-348` | T02 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-349` | T02 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-350` | T03 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-351` | T03 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-352` | T03 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-353` | T04 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-354` | T04 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-355` | T04 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-356` | T05 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-357` | T05 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-358` | T05 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-359` | T06 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-360` | T06 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-361` | T06 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-362` | T07 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-363` | T07 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-364` | T07 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-365` | T08 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-366` | T08 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-367` | T08 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-368` | T09 | UDI（校验位错）（`udi_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-369` | T09 | UDI（校验位错）（`udi_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-370` | T09 | UDI（校验位错）（`udi_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-371` | T10 | UDI（校验位错）（`udi_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-372` | T10 | UDI（校验位错）（`udi_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-373` | T10 | UDI（校验位错）（`udi_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-374` | T11 | UDI（校验位错）（`udi_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-375` | T11 | UDI（校验位错）（`udi_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-376` | T11 | UDI（校验位错）（`udi_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-377` | T12 | UDI（校验位错）（`udi_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-378` | T12 | UDI（校验位错）（`udi_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-379` | T12 | UDI（校验位错）（`udi_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-380` | T13 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-381` | T14 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-382` | T15 | UDI（校验位错）（`udi_bad_check`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-383` | T16 | UDI（校验位错）（`udi_bad_check`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-384` | T17 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-385` | T17 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-386` | T17 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-387` | T18 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-388` | T18 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-389` | T18 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-390` | T19 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-391` | T19 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-392` | T19 | UDI（校验位错）（`udi_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-393` | T01 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-394` | T01 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-395` | T01 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-396` | T02 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-397` | T02 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-398` | T02 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-399` | T03 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-400` | T03 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-401` | T03 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-402` | T04 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-403` | T04 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-404` | T04 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-405` | T05 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-406` | T05 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-407` | T05 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-408` | T06 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-409` | T06 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-410` | T06 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-411` | T07 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-412` | T07 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-413` | T07 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-414` | T08 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-415` | T08 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-416` | T08 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-417` | T09 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-418` | T09 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-419` | T09 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-420` | T10 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-421` | T10 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-422` | T10 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-423` | T11 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-424` | T11 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-425` | T11 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-426` | T12 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-427` | T12 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-428` | T12 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-429` | T13 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-430` | T14 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-431` | T15 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-432` | T16 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-433` | T17 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-434` | T17 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-435` | T17 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-436` | T18 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-437` | T18 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-438` | T18 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-439` | T19 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-440` | T19 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-441` | T19 | 裸 GTIN-14（校验位错）（`gtin_bad_check`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `NOT_REGISTERED` | `CODE_GTIN_CHECK_DIGIT_INVALID` | 是 |
| `BC-442` | T01 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-443` | T01 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-444` | T01 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-445` | T02 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-446` | T02 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-447` | T02 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-448` | T03 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-449` | T03 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-450` | T03 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-451` | T04 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-452` | T04 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-453` | T04 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-454` | T05 | 空码（`empty`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-455` | T05 | 空码（`empty`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-456` | T05 | 空码（`empty`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-457` | T06 | 空码（`empty`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-458` | T06 | 空码（`empty`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-459` | T06 | 空码（`empty`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-460` | T07 | 空码（`empty`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-461` | T07 | 空码（`empty`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-462` | T07 | 空码（`empty`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-463` | T08 | 空码（`empty`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-464` | T08 | 空码（`empty`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-465` | T08 | 空码（`empty`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-466` | T09 | 空码（`empty`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-467` | T09 | 空码（`empty`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-468` | T09 | 空码（`empty`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-469` | T10 | 空码（`empty`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-470` | T10 | 空码（`empty`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-471` | T10 | 空码（`empty`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-472` | T11 | 空码（`empty`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-473` | T11 | 空码（`empty`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-474` | T11 | 空码（`empty`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-475` | T12 | 空码（`empty`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-476` | T12 | 空码（`empty`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-477` | T12 | 空码（`empty`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-478` | T13 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-479` | T14 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-480` | T15 | 空码（`empty`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-481` | T16 | 空码（`empty`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-482` | T17 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-483` | T17 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-484` | T17 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-485` | T18 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-486` | T18 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-487` | T18 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-488` | T19 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-489` | T19 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-490` | T19 | 空码（`empty`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `NOT_REGISTERED` | `CODE_EMPTY` | 是 |
| `BC-491` | T01 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-492` | T01 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-493` | T01 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-494` | T02 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-495` | T02 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-496` | T02 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-497` | T03 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-498` | T03 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-499` | T03 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-500` | T04 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-501` | T04 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-502` | T04 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-503` | T05 | 超长码（`too_long`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-504` | T05 | 超长码（`too_long`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-505` | T05 | 超长码（`too_long`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-506` | T06 | 超长码（`too_long`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-507` | T06 | 超长码（`too_long`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-508` | T06 | 超长码（`too_long`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-509` | T07 | 超长码（`too_long`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-510` | T07 | 超长码（`too_long`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-511` | T07 | 超长码（`too_long`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-512` | T08 | 超长码（`too_long`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-513` | T08 | 超长码（`too_long`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-514` | T08 | 超长码（`too_long`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-515` | T09 | 超长码（`too_long`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-516` | T09 | 超长码（`too_long`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-517` | T09 | 超长码（`too_long`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-518` | T10 | 超长码（`too_long`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-519` | T10 | 超长码（`too_long`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-520` | T10 | 超长码（`too_long`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-521` | T11 | 超长码（`too_long`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-522` | T11 | 超长码（`too_long`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-523` | T11 | 超长码（`too_long`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-524` | T12 | 超长码（`too_long`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-525` | T12 | 超长码（`too_long`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-526` | T12 | 超长码（`too_long`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-527` | T13 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-528` | T14 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-529` | T15 | 超长码（`too_long`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-530` | T16 | 超长码（`too_long`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-531` | T17 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-532` | T17 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-533` | T17 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-534` | T18 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-535` | T18 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-536` | T18 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-537` | T19 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-538` | T19 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-539` | T19 | 超长码（`too_long`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `NOT_REGISTERED` | `CODE_TOO_LONG` | 是 |
| `BC-540` | T01 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-541` | T01 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-542` | T01 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-543` | T02 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-544` | T02 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-545` | T02 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-546` | T03 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-547` | T03 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-548` | T03 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-549` | T04 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-550` | T04 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-551` | T04 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-552` | T05 | 非法字符集（`illegal_charset`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-553` | T05 | 非法字符集（`illegal_charset`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-554` | T05 | 非法字符集（`illegal_charset`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-555` | T06 | 非法字符集（`illegal_charset`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-556` | T06 | 非法字符集（`illegal_charset`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-557` | T06 | 非法字符集（`illegal_charset`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-558` | T07 | 非法字符集（`illegal_charset`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-559` | T07 | 非法字符集（`illegal_charset`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-560` | T07 | 非法字符集（`illegal_charset`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-561` | T08 | 非法字符集（`illegal_charset`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-562` | T08 | 非法字符集（`illegal_charset`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-563` | T08 | 非法字符集（`illegal_charset`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-564` | T09 | 非法字符集（`illegal_charset`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-565` | T09 | 非法字符集（`illegal_charset`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-566` | T09 | 非法字符集（`illegal_charset`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-567` | T10 | 非法字符集（`illegal_charset`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-568` | T10 | 非法字符集（`illegal_charset`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-569` | T10 | 非法字符集（`illegal_charset`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-570` | T11 | 非法字符集（`illegal_charset`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-571` | T11 | 非法字符集（`illegal_charset`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-572` | T11 | 非法字符集（`illegal_charset`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-573` | T12 | 非法字符集（`illegal_charset`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-574` | T12 | 非法字符集（`illegal_charset`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-575` | T12 | 非法字符集（`illegal_charset`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-576` | T13 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-577` | T14 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-578` | T15 | 非法字符集（`illegal_charset`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-579` | T16 | 非法字符集（`illegal_charset`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-580` | T17 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-581` | T17 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-582` | T17 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-583` | T18 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-584` | T18 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-585` | T18 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-586` | T19 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-587` | T19 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-588` | T19 | 非法字符集（`illegal_charset`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `NOT_REGISTERED` | `CODE_ILLEGAL_CHARSET` | 是 |
| `BC-589` | T01 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-590` | T01 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-591` | T01 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-592` | T02 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-593` | T02 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-594` | T02 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-595` | T03 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-596` | T03 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-597` | T03 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-598` | T04 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-599` | T04 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-600` | T04 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-601` | T05 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-602` | T05 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-603` | T05 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-604` | T06 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-605` | T06 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-606` | T06 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-607` | T07 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-608` | T07 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-609` | T07 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 缺换算系数（`ratio_missing`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-610` | T08 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-611` | T08 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-612` | T08 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 费用口径不合规（`fee_invalid`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-613` | T09 | 形态识别不出（`form_unrecognized`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-614` | T09 | 形态识别不出（`form_unrecognized`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-615` | T09 | 形态识别不出（`form_unrecognized`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-616` | T10 | 形态识别不出（`form_unrecognized`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-617` | T10 | 形态识别不出（`form_unrecognized`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 2 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-618` | T10 | 形态识别不出（`form_unrecognized`） | 已关台（`closed`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道无业务拒绝（`none`） | 3 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-619` | T11 | 形态识别不出（`form_unrecognized`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-620` | T11 | 形态识别不出（`form_unrecognized`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-621` | T11 | 形态识别不出（`form_unrecognized`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-622` | T12 | 形态识别不出（`form_unrecognized`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-623` | T12 | 形态识别不出（`form_unrecognized`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 2 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-624` | T12 | 形态识别不出（`form_unrecognized`） | 排台里查不到（`unknown`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道无业务拒绝（`none`） | 3 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-625` | T13 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 0.5 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-626` | T14 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道业务拒绝（`business_rejected`） | 0.5 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-627` | T15 | 形态识别不出（`form_unrecognized`） | 已关台（`closed`） | 已停用（`inactive`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `CLOSED` | `OPERATION_CLOSED` | 是 |
| `BC-628` | T16 | 形态识别不出（`form_unrecognized`） | 排台里查不到（`unknown`） | 主数据查不到（`unregistered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 1 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` | 是 |
| `BC-629` | T17 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-630` | T17 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-631` | T17 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 已绑在别的台次（`duplicate_other_op`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-632` | T18 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 1 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-633` | T18 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 2 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-634` | T18 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 同台次同码但批号不同（`batch_diff`） | 计费通道业务拒绝（`business_rejected`） | 3 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-635` | T19 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 4 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-636` | T19 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 5 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |
| `BC-637` | T19 | 形态识别不出（`form_unrecognized`） | 开台（`open`） | 在册且口径齐（`registered`） | 首次扫到（`first`） | 计费通道无业务拒绝（`none`） | 6 | `NOT_REGISTERED` | `CODE_FORM_UNRECOGNIZED` | 是 |

## 怎么重跑这份矩阵

```bash
# ① 重新生成边界矩阵用例（确定性：同一份输入产出逐字节一致的三份 CSV）
npm run fixtures:boundary

# ② 逐条断言：结论 / 原因码 / 是否需人工 与本表的期望逐字一致
node --test dist/tests/boundary-matrix.test.js

# ③ 重新生成本文档（表格行数与用例条数始终一致）
npm run docs:judgement
```

用例落在 `tests/boundary/`（三份 CSV：`boundary-cases.csv` 用例、`boundary-operations.csv` 台次主数据、`boundary-materials.csv` 耗材主数据），由 `scripts/gen-boundary-fixtures.ts` 生成；属性测试落在 `tests/boundary-matrix.test.ts`。
