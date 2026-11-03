# 区间重放与幂等不变式验证

> 出故障后信息科要能回答一句话：**「那段时间的扫码，原样再跑一遍会不会多出一笔计费？」** 这份文档说清楚：怎么圈区间、重放走哪条路径、差异表长什么样、不变式怎么验。

## 一句话口径

**按区间把事件日志里的扫码事件原样再跑一遍**，走**生产同一条路径**（同一套装配、同一把幂等键、同一个结算层、同一个出站计费客户端），重放前后各取一份快照并出**差异表**；同一区间连续重放两次，**第二次**台账行数增量与计费调用增量**都必须是 0** —— 这一条就是幂等不变式，验不过就不许说「已通过」。

## 四种区间口径

| 口径 | 参数 | 筛什么 | 说明 |
|------|------|--------|------|
| 时间窗 | `--from` / `--to` | 事件的**收到时刻**（`scan_event.received_at`） | 含端点。筛的是「那段时间设备报了什么」，不是「那段时间账上有什么」 |
| 台次 | `--operation` | `scan_event.operation_no` | 一台手术的全部扫码 |
| 批次号 | `--batch` | `scan_event.batch_id` | 设备侧的**那一批**：扫码枪路 = 本次投递标识；目录投递路 = 批次文件名 |
| 来源 | `--source` | `scan_event.source` | `scanner_http` / `rfid_dir` |

四种口径**可组合**，同时给 = 取交集。`--limit` 只截取、不改区间口径 —— 报「命中多少条」时按区间算，不按取出来的条数算。

### 批次号是哪来的

事件日志原来只有 `request_id`（本程序这次收件的回执号），记不住「设备侧的第几批」。迁移 **v23** 补了 `scan_event.batch_id` 列：

| 来源路 | 批次号取什么 | 为什么 |
|--------|-------------|--------|
| 扫码枪 HTTP | 本次投递标识（一个 POST 就是一批） | HTTP 一次请求一批，没有更细的批次概念 |
| RFID 目录投递 | 投递文件名（去 `.jsonl` 后缀） | 设备侧给的批次号就是文件名 |

历史行留空 = 落库时还没有批次号这一说（**不猜**）。

## 重放走哪条路径

```
事件日志 scan_event
   │  按区间筛（时间窗 / 台次 / 批次号 / 来源）
   ▼
归一后的批次信封（operation_no / room_no / scanner_id / items）
   │  ★ 同一套装配 dispatchBatch（不另开旁路）
   ▼
结算层 settleEvent ──► 同一把幂等键 sha256(档位|耗材码|台次[|批号])
   │                     ├─ 命中 → DUPLICATE_SCAN，**不落台账、不打对端**
   │                     └─ 未命中 → 落台账 + 升核查条目
   ▼
计费回写 writeBackOperationCharges ──► 同一个 HisChargingClient（Bearer 单一出口）
   │
   ▼
台账 / 回执 / 核查条目 / 审计链（与生产同一批表）
```

三条硬约束：

1. **不另开旁路实现** —— 旁路重放证明不了生产的幂等，只证明得了旁路的幂等；
2. **重放不再写事件日志** —— 否则每重放一次日志就长一截，越重放越多没法核对；
3. **重放不代人工闭环** —— 异常条目照常升核查任务，等护士长 / 耗材管理岗落定。

## 前后快照

快照数字**全部现读台账**（SQL 聚合），没有内存计数器 —— 要能和 `summary` 子命令对得上，也要能被另一次进程读出来复现。

| 维度 | 中文 | 取数口径 |
|------|------|---------|
| `ledger_rows` | 耗材使用台账行数 | `material_binding` 行数 |
| `outbound_charge_calls` | 计费调用次数（出站请求） | `meta.charge_outbound_calls` 计数器（**真的打出去一次对端 +1**，跨进程留得住） |
| `charge_receipts` | 计费回执行数 | `charge_receipt` 行数（每条耗材每次尝试一行） |
| `check_pending` | 待核查条目数 | `check_task` 中 `status='pending'` 的行数 |
| `by_conclusion` | 五种绑定结论分布 | BOUND 取自台账，异常结论取自核查条目（与 `summary` 同一口径） |
| `by_status` | 条目状态分布 | `material_binding.status` |
| `retry_distribution` | 重投次数分布 | `charge_receipt.delivery_count` 分组 |

> **为什么计费调用次数要单独计一个数**：回执行记的是「**条目**维度投了几次」，出站请求次数是「**请求**维度打了几次」—— 一批 100 条明细只打 1 次请求，但留下 100 行回执。两个数不是一个数，所以另设一个只增不减的出站请求计数器，否则「第二次没再打对端」只能靠当次进程的内存数字作证。

## 差异表（replay-diff）

差异表分两层：

| 层 | 内容 | 字段 |
|----|------|------|
| 标量维度 | 台账行数 / 计费调用次数 / 计费回执行数 / 待核查条目数 | `dimension` / `label_zh` / `before` / `after` / `delta` / `changed` |
| 分布维度 | 五种结论 / 条目状态 / 重投次数**逐项**对比 | `dimension` / `key` / `label_zh` / `before` / `after` / `delta` |

分布**逐项**对比是必要的：总数没变但分布变了（一条从「待核查」挪到「已闭环」）是最容易被漏掉的一类变化。

### 落盘

差异表落 **`logs/replay-<区间>-diff.json`**（运行时目录，**不入库**）：

| 区间 | 文件名 |
|------|--------|
| 台次 `OP-SAMPLE-001` | `logs/replay-op-OP-SAMPLE-001-diff.json` |
| 批次 `BATCH-20260115-01` | `logs/replay-batch-BATCH-20260115-01-diff.json` |
| 时间窗 | `logs/replay-time-<起>-<止>-diff.json` |
| 全部 | `logs/replay-all-diff.json` |

可用 `--diff-out <path>` 改路径。

## 幂等不变式

```
第一遍重放 ──► 快照 A
第二遍重放 ──► 快照 B

不变式成立 ⟺ B.台账行数 − A.台账行数 = 0
          ∧ B.计费调用次数 − A.计费调用次数 = 0
          ∧ B.计费回执行数 − A.计费回执行数 = 0
```

- **默认要验**（CLI 除非加 `--no-verify`，否则连做两遍）；
- 不成立时**照实说「不成立」**，并把三处增量摆在报告里，CLI 退出码给 **4**（外部通道 / 不变式异常类），监控能接住；
- 一个会说「不成立」的重放工具，比一个永远说「已通过」的有用。

## 命令

```bash
# 按台次重放（默认连做两遍验不变式）
node dist/cli.js replay --operation OP-SAMPLE-001

# 按时间窗重放
node dist/cli.js replay --from 2026-01-15T00:00:00Z --to 2026-01-16T00:00:00Z

# 按批次号重放
node dist/cli.js replay --batch BATCH-20260115-01

# 顺带回写计费（需要出站凭据位 HIS_CHARGING_BASE_URL / HIS_CHARGING_TOKEN）
node dist/cli.js replay --operation OP-SAMPLE-001 --charge

# 差异表落到指定路径
node dist/cli.js replay --operation OP-SAMPLE-001 --diff-out /tmp/replay-diff.json
```

## 相关文档

- `docs/api/idempotency.md` —— 幂等键的档位与派生口径
- `docs/api/his-charging.md` —— 出站计费接口规范与错误码
- `docs/api/errors.md` —— 统一错误码表
- `docs/api/reconcile.md` —— 台账 ↔ 计费回执的逐条差异对账
