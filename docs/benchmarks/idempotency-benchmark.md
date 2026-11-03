# 幂等层对照基线：零重复计费 vs 朴素重发

> 同一批 1000 条扫码事件、同一套判定规则、同一个出站客户端、同一个计费替身 ——
> **只差一层幂等**：幂等版按「耗材码 + 台次」去重，朴素版每次扫码都写台账、都会计费。
> 实测对端收到的重复计费条目：幂等版 **0 条**，朴素版 **30 条**。

## 跑法

```bash
# ① 幂等版规模跑测（产物：data/bench/idempotent-scale.json）
node dist/scripts/load-1000.js --events 1000 --seed 20260101

# ② 朴素重发基线 + 写出本文档（产物：data/bench/naive-baseline.json）
node dist/scripts/baseline-naive-resend.js --events 1000 --seed 20260101

# 一次跑完（等价）
npm run bench:idempotency

# 只跑阈值断言（CI 用小样本）
node --test dist/tests/load-1000.test.js
```

## 事件流构成（确定性生成，种子 20260101）

| 类别 | 条数 | 预期结论 | 说明 |
|------|------|----------|------|
| 正常扫码 | 920 | BOUND | 全新耗材码，绑上本台次 |
| 耗材未建档 | 15 | NOT_REGISTERED / MATERIAL_NOT_REGISTERED | 码不在院内耗材主数据 |
| 台次已关台 | 20 | CLOSED / OPERATION_CLOSED | 扫到已关台台次 |
| 跨台次重复 | 15 | CROSS_OP_DUP / CROSS_OP_DUPLICATE_MATERIAL | 同一耗材已绑在别的台次 |
| 重复扫码 | 30 | NOT_REGISTERED / DUPLICATE_SCAN | 同一耗材同一台次被再扫一次 |
| **合计** | **1000** | — | 异常占比 5%，重复占比 3% |

## 对照结果

| 指标 | 幂等版（本产品） | 朴素重发基线 | 差 |
|------|------------------|--------------|----|
| 投递事件条数 | 1000 | 1000 | 0 |
| 耗材使用台账行数 | 920 | 950 | 30 |
| 出站计费请求次数 | 66 | 66 | 0 |
| 出站计费明细条数 | 920 | 950 | 30 |
| 对端去重后计费条目 | 920 | 920 | 0 |
| **对端收到的重复计费条目** | **0** | **30** | **30** |
| 结论正确率 | 100.0000% | — | — |
| 处理耗时 | 489.49 ms | 213.74 ms | — |

读法：**幂等版对端重复计费 0 条**（零重复计费），
朴素版 **30 条** —— 差的 30 条正是「重复扫码」那一类
（30 条）在没有幂等层时会被重复计掉的账。

## 幂等版实测明细

```text
批次 200 批（每批 5 条）
入站处理耗时 489.49 ms，吞吐 2042.95 条/秒
单条均摊耗时 p50=0.485 ms / p95=0.564 ms / p99=0.928 ms（批次 p95=2.818 ms）
结论正确率 100.0000%（1000/1000）
结论分布：BOUND=920  NOT_REGISTERED=45  CROSS_OP_DUP=15  CLOSED=20
耗材使用台账 920 行 / 核查条目 50 条
出站计费：请求 66 次 / 明细 920 条（对端接收 920 / 拒收 0）
对端收到的计费明细：920 条去重后 / 重复计费 0 条
```

## 阈值断言

| 断言 | 阈值 | 实测 | 结论 |
|------|------|------|------|
| 结论正确率 | = 100% | 100.0000% | 达标 |
| 出站计费明细条数（同键只计一次） | = 去重后条目数（920） | 920 | 达标 |
| 对端重复计费条目 | = 0 | 0 | 达标 |
| 入站 HTTP 非 200 | = 0 | 0 | 达标 |
| 朴素基线重复计费 | > 0 | 30 | 达标 |

## 判定边界矩阵（同一批任务的另一半）

绑定结论的正确性不只看规模，还要看**边界**：码制形态 × 台次状态 × 耗材归属 ×
主数据状态 × 计费结果 × 数量 的场景矩阵逐条比对（预期结论写在 fixture 里，独立于产品代码）。
矩阵已从 486 条扩到 **637 条**，并新增「计费结果」维度与五种结论的完备性断言。

| 维度 | 取值 |
|------|------|
| 码制形态 | internal / internal_dotted / internal_underscore / gtin_bare / udi / udi_batch / gs1_ai01 / udi_bad_check / gtin_bad_check / empty / too_long / illegal_charset / form_unrecognized |
| 台次状态 | open / closed / unknown |
| 耗材归属 | first / duplicate_other_op / batch_diff |
| 主数据状态 | registered / unregistered / inactive / ratio_missing / fee_invalid |
| 计费结果 | none / business_rejected |
| 数量 | 1 / 2 / 3 / 4 / 5 / 6 / 0.5 |

```bash
# 重新生成 fixture（确定性，重复执行逐字节一致）
npm run fixtures:boundary

# 逐条断言（637 条用例全绿）
node --test dist/tests/boundary-matrix.test.js

# 重新生成判定矩阵文档（docs/api/judgement-matrix.md，行数与用例条数一致）
npm run docs:judgement
```

用例文件（可读 CSV）：

- `tests/boundary/boundary-cases.csv` —— 每条用例带预期结论与原因码
- `tests/boundary/boundary-operations.csv` / `tests/boundary/boundary-materials.csv` —— 对应的主数据
- `docs/api/judgement-matrix.md` —— 判定矩阵文档（判定顺序 + 六维度覆盖 + 637 行逐条对照）

## 口径与局限（务必一起看）

- **出站对端是测试替身**：`tests/support/fake-his-server.ts` 里的真实 HTTP 服务
  （生产客户端与替身走同一条 `fetch` 代码路径），它额外逐条记账以统计重复计费。
  它是**测试数据层**，不是产品的最终对接方式；真实对接形态见 `docs/api/his-charging.md`。
- **台账跑在内存 SQLite**（`:memory:`）：跑测量的是判定与幂等逻辑，不是磁盘吞吐；
  磁盘上的持久化行为由 `npm test -- test_db_migrations` 一类用例覆盖。
- **单机单进程**：吞吐与 p95 是本机开发机上的数字，不代表院内服务器；
  「单条均摊耗时」= 批次往返耗时 ÷ 批次条目数，是均摊值而非单条独占耗时。
- **两个版本跑的是同一条事件流**：事件流由固定种子确定性生成
  （`buildScaleStream`），因此两次运行的差异只来自幂等层本身。
- **耗时两列不可直接相比**：幂等版走完整入站 HTTP 路径（验签、归一、占位、台账），
  朴素基线直接调用判定函数与出站客户端（少一层 HTTP 与占位），
  所以朴素基线更快。**本对比的看点是重复计费条数，不是耗时。**
- **朴素基线不是产品代码**：它是本目录下的一段参照实现（`runNaiveBaseline`），
  用来说明「少了幂等层会发生什么」；它不参与产品运行路径。
- **幂等层是三层，朴素基线三层都没有**：① 入站占位（claim / lease / confirm）——
  同一把键并发时只有一个人拿到；② 台账唯一索引（幂等键唯一、（耗材码 + 台次）唯一）——
  绕开占位直接写台账也写不进第二行；③ 出站键透传 —— 对端据此去重。
  朴素基线跑在一张**摘掉了这三张唯一索引**的内存表上（`dropIdempotencyDefenses`），
  键的派生口径仍用与产品**同一把尺子**（v1 = 耗材码 + 台次）——
  差的是没人拿它去重，于是同一把键写进两行、对端收到两笔计费。
  **产品自己的台账永远带着这三张索引**，只在基准台账上摘掉。
