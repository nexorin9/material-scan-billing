# 视觉目标卡 · 高值耗材扫码计费闭环系统

> 交付形态为**事件驱动守护**（常驻进程 + CLI 运维面），故视觉目标以**服务运行日志（终端会话）**与**既有通道推送消息（企业微信机器人消息卡）**为准。
> 本卡为**结构化目标**（本环境无图像生成能力），**不含**任何伪造图片；真实运行截图采集见 `docs/screenshots/`。

## 画面类型

- 终端会话（常驻进程 stdout / stderr）
- 企业微信机器人 Markdown 消息卡（既有推送通道）
- **不画**：浏览器控制台 / 大屏 / 仪表盘 / WebGL / 3D 场景 / 任何需要前端框架才成立的效果

## 三个状态

### 起始态（刚启动守护进程）

画面上有什么：

```
[boot]   material-scan-billing v0.1.0 · node v26.4.0
[boot]   ledger: data/ledger.db · schema v1 · writable
[boot]   adapter[scanner-http] listening on 0.0.0.0:8100
[boot]   adapter[rfid-dir]    watching scan-inbox/
[boot]   outbound[HIS]        ready (base_url configured, token present)
[boot]   notify[wecom]        ready (webhook configured)
[boot]   heartbeat every 30s · awaiting scan events
```

- 只有启动自检行，**没有任何耗材事件**
- 缺任一路凭据时该行替换为指名变量的失败行，例如 `adapter[scanner-http] missing OR_SCANNER_TOKEN → refusing to start`

### 首个可用瞬间（一批 6 条扫码事件到达）

```
[scan]   batch op-20261102-0131 room=OR-07 scanner=SCN-12 items=6
[scan]   [已绑定]     material=MAT-000231 qty=1  operation=op-20261102-0131
[scan]   [已绑定]     material=MAT-000244 qty=2  operation=op-20261102-0131
[scan]   [码未建档]   material=MAT-009999 qty=1  operation=op-20261102-0131
[scan]   [跨台次重复] material=MAT-000231 qty=1  operation=op-20261102-0131
[scan]     └ 已绑定到 op-20261102-0128，本次不重复计费
[scan]   [台次已关台] material=MAT-000250 qty=1  operation=op-20261102-0131
[scan]     └ 台次已关台，需人工走计费补录，系统不自动补录
[charge] posted operation=op-20261102-0131 uses=2 accepted=2 rejected=0
[check]  task#1041 NOT_REGISTERED  material=MAT-009999 room=OR-07 dept=SC-203
[check]  task#1042 CROSS_OP_DUP    material=MAT-000231 room=OR-07 dept=SC-203
[batch]  op-20261102-0131 accepted=2 rejected=4 duplicate_in_batch=1
```

### 成形态（常驻安静运行 + 可回查台账）

- 进程安静下来，**只在有事件时输出**
- 终端内可回查整批流水与每条回执：

```
$ node dist/cli.js ledger --operation op-20261102-0131
$ node dist/cli.js summary --since 2026-11-01
$ node dist/cli.js pack --operation op-20261102-0131 --format csv
```

- `docs/screenshots/` 里出现的是这段真实终端会话与真实推送消息

## 视觉语言

| 项 | 取值 |
|---|---|
| 底色 | 终端深底 `#0F1115` |
| 字体 | 等宽 `ui-monospace / SFMono-Regular / Menlo`，数字 `tabular-nums` 等宽对齐 |
| 成功色 | 已绑定 / 计费成功 `#3FB950` |
| 警示色 | 异常待处理（待核查、待重投）`#D29922` |
| 失败色 | 拒绝 / 失败（码未建档、跨台次重复、已关台、计费被拒）`#F85149` |
| 辅助色 | 分隔线 / 次要说明 `#6E7681` |

**信息层级**（第一眼看到什么）：

1. **第一眼 = 这一批的汇总行**：`[batch] op-… accepted=2 rejected=4 duplicate_in_batch=1`
2. **第二层 = 逐条回执行**：`[scan] [已绑定] material=… qty=… operation=…`
3. **第三层 = 原因说明**：异常行后紧跟一行缩进 `└` 原因
4. **第四层 = 重投与审计细节**：仅在重投 / 人工处置时出现

**留白密度**：每条回执**单行**，行间**不空行**；异常行后紧跟一行缩进原因说明，不另起空段落。

## 必须可达的约束（只画当前依赖真能做出来的东西）

- ✅ 终端逐条回执行、批次汇总行、启动自检行、心跳行 —— `node:http` + 原生 `console` 即可
- ✅ 企业微信 Markdown 消息卡 —— `fetch` POST webhook
- ✅ SQLite 状态表 —— `node:sqlite`
- ❌ 任何需要前端框架 / 图形渲染才成立的效果（仪表盘、图表、动画、大屏）
