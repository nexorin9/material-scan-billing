# tests/fixtures —— 单测边界样例（**不参与规模验证**）

本目录**只保留**跨多个用例共用的最小主数据样例，以及单用例的尝试序列样例，
全部为 CSV，合计 **16 行数据**（单文件 ≤8 行、合计 ≤16 行 —— 这条约束由
`tests/data-pipeline.test.ts` 断言）：

| 文件 | 行数 | 用途 |
|---|---|---|
| `operations.csv` | 3 | 排台台次：`OP-SAMPLE-001`（开台）/ `OP-SAMPLE-002`（开台）/ `OP-SAMPLE-003`（已关台） |
| `materials.csv` | 6 | 耗材主数据：`MAT-SAMPLE-01`～`05` 启用、`MAT-SAMPLE-06` 停用（`active=false`） |
| `master-data-gbk.csv` | 3 | GBK 编码的主数据样例（生僻字 / 全角括号），用于编码择优解码用例 |
| `charge-attempt-history.csv` | 4 | 计费尝试史样例：**一条耗材被拒 3 次后成功**（限流拒收 → 通道超时 → 服务繁忙拒收 → 接收成功），用于「台账 ↔ 导出」逐行一致性断言 |

## 覆盖到的四种结论触发条件

| 结论 | 触发方式 | 断言落在 |
|---|---|---|
| `BOUND` | 主数据在册、启用、台次开台 | `tests/http-ingest.test.ts`、`tests/settle.test.ts` |
| `NOT_REGISTERED` | 扫到主数据里没有的码（`MAT-UNKNOWN-99`） | `tests/http-ingest.test.ts` |
| `CROSS_OP_DUP` | 同一耗材码先落在 `OP-SAMPLE-001`、再扫到 `OP-SAMPLE-002` | `tests/settle.test.ts`、`tests/check-task.test.ts` |
| `CLOSED` | 扫到已关台的 `OP-SAMPLE-003` | `tests/boundary-matrix.test.ts`、`tests/conclude.test.ts` |

## 覆盖到的三种码制

码制覆盖不在本目录的 CSV 里（主数据键必须是**归一后的规范码**），而在各测试用例的事件体中：

| 码制 | 上报样例 | 归一后的主数据键 |
|---|---|---|
| 院内码 `INTERNAL` | `MAT-SAMPLE-01` | `MAT-SAMPLE-01` |
| UDI（含生产标识） | `(01)06912345678902(10)LOT-A1` | `06912345678902` |
| GS1 AI(01) 包装码 | `0106987654321092` | `06987654321092` |

UDI 与 GS1 两种码制**指向同一把主数据键** —— 这正是归一层要保证的事
（见 `src/ingest/normalize.ts`）。

## 边界矩阵在哪

判定边界矩阵（637 条，码制形态 × 台次状态 × 归属 × 主数据 × 计费结果 × 数量）在
**`tests/boundary/`** 目录，由 `npm run fixtures:boundary` 确定性生成
（重复执行逐字节一致）。它属于**生成产物**，不与本目录的手写样例混放。
判定矩阵文档（637 行逐条对照：结论 / 原因码 / 是否需人工）由 `npm run docs:judgement`
生成到 `docs/api/judgement-matrix.md`。

## 为什么规模验证不放在这里

规模验证（≥1000 台次 / ≥5000 条耗材 / 批量扫码条目）走
**数据获取与合成层**的产物（`npm run data:prepare` → `data/`），
不写进本目录：手写 fixture 撑不起规模，也不该被当成主数据。
