# 样例：真实的输入与输出

> 这份文档把**产品主路径上真实跑出来的报文、台账行、核查条目、清单与对账包**原样摊开，
> 让科室与信息科在看文档时就知道「到时候长什么样」，不用先装一套环境试。

## 脱敏声明

| 口径 | 说明 |
|---|---|
| **不落患者标识** | 本产品只把耗材码绑到手术台次，**不采集、不落库、不导出任何患者标识**（姓名 / 身份证 / 住院号 / 床号均无对应字段）。导出走固定字段白名单 |
| **样例标识是占位符** | 下面的 `OP-SAMPLE-001` / `OR-01` / `MAT-SAMPLE-01` / `SCAN-GUN-07` / `SURG-01` 都是**样例台次号与样例耗材码**，不是真实病历号或真实收费单号 |
| **批号与时间** | 批号写作 `LOT-SAMPLE-A` / `LOT-SYN-000263`（合成数据的占位批号）；时间戳取自实际运行时刻 |
| **真实产物** | 本文所有片段都是**真实运行产物**（`npm run demo:pipe` 的输出、`node dist/cli.js …` 的输出、月度对账跑测的落盘文件），不是手写的示意 |
| **合成数据说明** | 月度对账包用的是 `data/synthetic/` 下**脚本化合成**的院内主数据（固定随机种子、可重跑），不是真实医院数据 |

---

## 1. 入站：扫码事件报文

### 1.1 请求

设备侧（扫码枪 / RFID 网关）投递一批耗材扫码：

```http
POST /api/v1/scan-events HTTP/1.1
Host: {OR_SCANNER_BASE_URL}
Authorization: Bearer {OR_SCANNER_TOKEN}
Content-Type: application/json
X-Scan-Timestamp: 1768469735
X-Scan-Nonce: 6f1c0a4e8b7d2f39a1c05e8b7d2f3a90
X-Scan-Signature: v1={HMAC-SHA256("{timestamp}.{nonce}.{raw_body}", OR_SCANNER_SECRET)}
```

```json
{
  "operation_no": "OP-SAMPLE-001",
  "room_no": "OR-01",
  "scanner_id": "SCAN-GUN-07",
  "scans": [
    { "material_code": "MAT-SAMPLE-01",    "quantity": 1, "scan_time": "2026-01-15T09:12:00+08:00", "batch_no": "LOT-SAMPLE-A" },
    { "material_code": "MAT-SAMPLE-02",    "quantity": 2, "scan_time": "2026-01-15T09:13:10+08:00", "batch_no": "LOT-SAMPLE-B" },
    { "material_code": "(01)06912345678902(10)LOT-A1", "quantity": 1, "scan_time": "2026-01-15T09:14:22+08:00" },
    { "material_code": "0106987654321092", "quantity": 1, "scan_time": "2026-01-15T09:15:40+08:00" },
    { "material_code": "MAT-SAMPLE-05",    "quantity": 1, "scan_time": "2026-01-15T09:16:05+08:00", "batch_no": "LOT-SAMPLE-E" },
    { "material_code": "MAT-UNKNOWN-99",   "quantity": 1, "scan_time": "2026-01-15T09:17:31+08:00" }
  ]
}
```

> 这批 6 条里：3 条是院内码、1 条是 UDI（含生产标识批号）、1 条是 GS1 AI(01) 包装码、1 条是**耗材码未建档**。
> 三种码制在归一层统一成规范耗材码，UDI 与 GS1 的那两条仍能绑上（主数据里登记了对应的 GTIN）。

### 1.2 响应（`HTTP 200`）

同批逐条给结论 —— **一条失败不丢同批其余**：

```json
{
  "accepted": [
    { "material_code": "MAT-SAMPLE-01",    "operation_no": "OP-SAMPLE-001", "bound": true, "conclusion": "BOUND", "charge_state": "not_submitted" },
    { "material_code": "MAT-SAMPLE-02",    "operation_no": "OP-SAMPLE-001", "bound": true, "conclusion": "BOUND", "charge_state": "not_submitted" },
    { "material_code": "06912345678902",   "operation_no": "OP-SAMPLE-001", "bound": true, "conclusion": "BOUND", "charge_state": "not_submitted" },
    { "material_code": "06987654321092",   "operation_no": "OP-SAMPLE-001", "bound": true, "conclusion": "BOUND", "charge_state": "not_submitted" },
    { "material_code": "MAT-SAMPLE-05",    "operation_no": "OP-SAMPLE-001", "bound": true, "conclusion": "BOUND", "charge_state": "not_submitted" }
  ],
  "rejected": [
    { "material_code": "MAT-UNKNOWN-99", "reason_code": "MATERIAL_NOT_REGISTERED" }
  ]
}
```

### 1.3 验签失败（`HTTP 401`）

同一批换成错误签名再投一次 —— **401 且台账不落行**：

```json
{
  "error": {
    "code": "ERR_INVALID_SIGNATURE",
    "message": "入站请求被拒：签名校验未通过"
  }
}
```

---

## 2. 逐条结论行（`npm run demo:pipe` 真实输出）

```
== 扫码事件投递（正确签名）==
HTTP 200
  MAT-SAMPLE-01                BOUND            台次=OP-SAMPLE-001 计费状态=not_submitted
  MAT-SAMPLE-02                BOUND            台次=OP-SAMPLE-001 计费状态=not_submitted
  06912345678902               BOUND            台次=OP-SAMPLE-001 计费状态=not_submitted
  06987654321092               BOUND            台次=OP-SAMPLE-001 计费状态=not_submitted
  MAT-SAMPLE-05                BOUND            台次=OP-SAMPLE-001 计费状态=not_submitted
  MAT-UNKNOWN-99               REJECTED         原因=MATERIAL_NOT_REGISTERED

逐条结论 6 条（绑定 5 / 异常 1）
耗材使用台账新增行数：5（表内累计 5 行）

== 同一批换错误签名再投一次 ==
HTTP 401
耗材使用台账新增行数：0（表内累计 5 行）
```

---

## 3. 结构化日志（每行一条 JSON）

日志走 stderr，字段固定；**凭据明文一律不出现**。

```json
{"timestamp":"2026-11-03T10:27:15.270Z","level":"info","service":"material-scan-billing","message":"耗材已绑定本台次","request_id":"ac5aff2c-b6ce-4e6c-a478-02a601b429f1","channel":"binding","operation_no":"OP-SAMPLE-001","material_code":"MAT-SAMPLE-01","conclusion":"BOUND","error_code":null,"duration_ms":1,"reason_code":null,"scanner_id":"SCAN-GUN-07","room_no":"OR-01"}
{"timestamp":"2026-11-03T10:27:15.271Z","level":"warn","service":"material-scan-billing","message":"耗材未绑定，已转人工核查","request_id":"ac5aff2c-b6ce-4e6c-a478-02a601b429f1","channel":"binding","operation_no":"OP-SAMPLE-001","material_code":"MAT-UNKNOWN-99","conclusion":"NOT_REGISTERED","error_code":"ERR_MATERIAL_NOT_REGISTERED","duration_ms":0,"reason_code":"MATERIAL_NOT_REGISTERED","scanner_id":"SCAN-GUN-07","room_no":"OR-01"}
{"timestamp":"2026-11-03T10:27:15.273Z","level":"info","service":"material-scan-billing","message":"扫码批次已处理","request_id":"ac5aff2c-b6ce-4e6c-a478-02a601b429f1","channel":"inbound","operation_no":"OP-SAMPLE-001","material_code":null,"conclusion":null,"error_code":null,"duration_ms":5,"total":6,"accepted":5,"rejected":1,"duplicate_in_batch":0}
{"timestamp":"2026-11-03T10:27:15.276Z","level":"warn","service":"material-scan-billing","message":"入站请求被拒：签名校验未通过","request_id":"5d67b2a5-af2b-4eec-a5fd-ce924afce27f","channel":"inbound","operation_no":null,"material_code":null,"conclusion":null,"error_code":"ERR_INVALID_SIGNATURE","duration_ms":0}
```

> 同一个问题在**日志 / 核查条目 / 计费回执行**里显示的是**同一个码**：
> 这里 `ERR_MATERIAL_NOT_REGISTERED` 与第 5 节核查条目的 `error_code` 逐字相同。

---

## 4. 耗材使用台账

### 4.1 终端表格（`node dist/cli.js ledger --db data/demo-ledger.db`）

```
台次             手术间    耗材码             数量  结论     条目状态   计费状态           落账时间
-------------  -----  --------------  --  -----  -----  -------------  ------------------------
OP-SAMPLE-001  OR-01  MAT-SAMPLE-01   1   BOUND  bound  not_submitted  2026-11-03T10:27:15.270Z
OP-SAMPLE-001  OR-01  MAT-SAMPLE-02   2   BOUND  bound  not_submitted  2026-11-03T10:27:15.270Z
OP-SAMPLE-001  OR-01  06912345678902  1   BOUND  bound  not_submitted  2026-11-03T10:27:15.271Z
OP-SAMPLE-001  OR-01  06987654321092  1   BOUND  bound  not_submitted  2026-11-03T10:27:15.271Z
OP-SAMPLE-001  OR-01  MAT-SAMPLE-05   1   BOUND  bound  not_submitted  2026-11-03T10:27:15.271Z

共 5 行（命中 5 行）
```

### 4.2 CSV 导出（表头逐字）

```csv
operation_no,room_no,dept_code,material_code,quantity,price_code,fee_category,medical_insurance_class,conclusion,status,check_task_id,charge_state,created_at
OP-SAMPLE-001,OR-01,SURG-01,MAT-SAMPLE-01,1,PR-SAMPLE-01,卫生材料,甲类,BOUND,bound,,not_submitted,2026-11-03T10:27:15.270Z
OP-SAMPLE-001,OR-01,SURG-01,MAT-SAMPLE-02,2,PR-SAMPLE-02,卫生材料,乙类,BOUND,bound,,not_submitted,2026-11-03T10:27:15.270Z
OP-SAMPLE-001,OR-01,SURG-01,06912345678902,1,PR-DEMO-UDI,卫生材料,甲类,BOUND,bound,,not_submitted,2026-11-03T10:27:15.271Z
OP-SAMPLE-001,OR-01,SURG-01,06987654321092,1,PR-DEMO-GS1,卫生材料,乙类,BOUND,bound,,not_submitted,2026-11-03T10:27:15.271Z
OP-SAMPLE-001,OR-01,SURG-01,MAT-SAMPLE-05,1,PR-SAMPLE-05,卫生材料,乙类,BOUND,bound,,not_submitted,2026-11-03T10:27:15.271Z
```

---

## 5. 核查条目（`check_task` 行）

异常条目自动升成带**台次上下文**的核查任务，等护士长 / 高值耗材管理岗落定结论：

```json
{
  "id": 1,
  "operation_no": "OP-SAMPLE-001",
  "room_no": "OR-01",
  "dept_code": "SURG-01",
  "scanner_id": "SCAN-GUN-07",
  "material_code": "MAT-UNKNOWN-99",
  "quantity": 1,
  "conclusion": "NOT_REGISTERED",
  "reason_code": "MATERIAL_NOT_REGISTERED",
  "status": "pending",
  "assignee_role": "高值耗材管理岗",
  "assigned_at": "2026-11-03T10:27:15.271Z",
  "reminded_at": null,
  "escalated_at": null,
  "timeout_level": 0,
  "detected_at": "2026-11-03T10:27:15.271Z",
  "confirmed_at": null,
  "confirmed_by": null,
  "confirmed_conclusion": null,
  "source_operation_no": null,
  "source_room_no": null,
  "binding_id": null,
  "revoked_at": null,
  "revoked_by": null,
  "error_code": "ERR_MATERIAL_NOT_REGISTERED",
  "reconcile_diff_id": null,
  "event_room_no": "OR-01",
  "master_room_no": "OR-01",
  "event_dept_code": null,
  "master_dept_code": "SURG-01"
}
```

> `assignee_role` 是**路由出来的责任岗位**，不是猜的：责任岗位路由口径见
> [`api/check-routing.md`](api/check-routing.md)。
> `event_room_no` / `master_room_no` / `event_dept_code` / `master_dept_code` 是**归属双因子交叉核对**的
> 两侧取值 —— 事件里带的与主数据里查到的，不一致时一眼能看出是哪边错了。

### 5.1 核查包 CSV（`node dist/cli.js pack --db data/demo-ledger.db --format csv`）

```
check_task_id,operation_no,room_no,dept_code,scanner_id,material_code,quantity,conclusion,reason_code,check_status,assignee_role,detected_at,binding_status,charge_state,receipt_attempt,receipt_delivery_count,receipt_kind,receipt_reason_code,receipt_error_code,receipt_channel_reachable,receipt_responded_at,confirmed_by,confirmed_conclusion,confirmed_at,revoked_at,revoked_by,source_operation_no,source_room_no,master_room_no,event_dept_code
1,OP-SAMPLE-001,OR-01,SURG-01,SCAN-GUN-07,MAT-UNKNOWN-99,1,NOT_REGISTERED,MATERIAL_NOT_REGISTERED,pending,高值耗材管理岗,2026-11-03T10:27:15.271Z,,not_submitted,0,0,,,,,,,,,,,,,OR-01,
审计链校验：完整（覆盖 7 行，校验时间 2026-11-03T10:28:04.572Z）
```

> 最后一行是**审计链校验结论** —— 内审 / 飞检要连「这份台账没被动过」一起交。

---

## 6. 关台核对清单（`node dist/cli.js closing --db data/demo-ledger.db --operation OP-SAMPLE-001`）

护士长关台时要签字的那一份：

```
== 关台核对清单 ==
  台次 1 个 / 耗材条目 6 条 / 已计费 0 条 / 待核查 1 条 / 待计费 5 条 / 可关台 0 个

-- 台次 OP-SAMPLE-001 ｜ 手术间 OR-01 ｜ 科室 SURG-01 ｜ 排台状态 open
  耗材 6 条 ｜ 绑定成功 5 条 ｜ 已计费 0 条 ｜ 待核查 1 条 ｜ 待计费 5 条
  汇总：待核查 1 条 · 待计费 5 条
  待核查条目：
    - MAT-UNKNOWN-99　数量 1　结论 NOT_REGISTERED　原因 MATERIAL_NOT_REGISTERED　错误码 ERR_MATERIAL_NOT_REGISTERED　责任岗位 高值耗材管理岗
  待计费条目（没人跟的静默缺口）：
    - MAT-SAMPLE-01（药物洗脱支架）　数量 1　结论 BOUND
    - MAT-SAMPLE-02（可吸收止血膜）　数量 2　结论 BOUND
    - 06912345678902（药物洗脱支架（UDI 码登记））　数量 1　结论 BOUND
    - 06987654321092（可吸收止血膜（GS1 包装码登记））　数量 1　结论 BOUND
    - MAT-SAMPLE-05（骨科锁定接骨板）　数量 1　结论 BOUND
  条目明细：
耗材码             数量  结论              计费状态  核查状态   人工结论
--------------  --  --------------  ----  -----  ----
MAT-SAMPLE-01   1   BOUND           未提交   不涉及核查  —
MAT-SAMPLE-02   2   BOUND           未提交   不涉及核查  —
06912345678902  1   BOUND           未提交   不涉及核查  —
06987654321092  1   BOUND           未提交   不涉及核查  —
MAT-SAMPLE-05   1   BOUND           未提交   不涉及核查  —
MAT-UNKNOWN-99  1   NOT_REGISTERED  未提交   待核查    —
```

> 「待计费」是**没人跟的静默缺口** —— 绑上了但没生成计费，最容易在关台时被漏掉。
> 清单口径见 [`api/closing-report.md`](api/closing-report.md)。

---

## 7. 计费回执（`charge_receipt` 行）

出站回写成功后的回执行（每次 attempt 一行，重投次数可见）：

```json
{
  "id": 1,
  "material_code": "06900000002636",
  "operation_no": "OP-SYN-000145",
  "idempotency_key": "defaa95b705b370f303eecd5351cadab1e8fc9bb848146e203d632857d467fef",
  "key_profile": "v1",
  "attempt": 1,
  "accepted": 1,
  "reason_code": null,
  "error_code": null,
  "channel_reachable": 1,
  "requested_at": "2026-11-03T10:15:34.162Z",
  "responded_at": "2026-11-03T10:15:34.162Z",
  "response_summary": "对端已接收",
  "delivery_count": 1,
  "kind": "ACCEPTED",
  "retryable": 0,
  "submitted_quantity": 2,
  "submitted_price_code": "PR-SYN-000263",
  "submitted_fee_category": "卫生材料",
  "submitted_medical_insurance_class": "丙类",
  "request_idempotency_key": "7109a6f5d9e416eac09badfe779a8448a41ce843bb5cb3b301195d8889bba560",
  "peer_idempotency_status": "NOT_ECHOED",
  "disposition": null,
  "attempt_source": "native",
  "history_note": null
}
```

> `attempt` 是第几次投递，`delivery_count` 是投递总次数 —— 重投了几次一眼能看出来。
> `peer_idempotency_status` 说明对端**有没有回显**我们透传的请求级幂等键。

### 7.1 对应台账行（`material_binding` 行）

```json
{
  "id": 1,
  "idempotency_key": "defaa95b705b370f303eecd5351cadab1e8fc9bb848146e203d632857d467fef",
  "operation_no": "OP-SYN-000145",
  "room_no": "OR-09",
  "dept_code": "SURG-URO",
  "material_code": "06900000002636",
  "quantity": 2,
  "price_code": "PR-SYN-000263",
  "fee_category": "卫生材料",
  "medical_insurance_class": "丙类",
  "conclusion": "BOUND",
  "status": "charged",
  "check_task_id": null,
  "raw_code": "0106900000002636",
  "key_profile": "v1",
  "batch_no": "LOT-SYN-000263",
  "code_form": "GS1_AI01",
  "charge_quantity": 2,
  "event_room_no": "OR-09",
  "master_room_no": "OR-09",
  "use_time": "2026-01-20T00:29:34.000Z"
}
```

> `raw_code` 是设备扫上来的原始包装码，`material_code` 是归一后的规范码 ——
> 码制改造后回查「这批到底扫的是什么」靠这两列。
> `code_parse_trace` / `quantity_trace` 是更细的解析与换算轨迹（JSON 字符串，存在列里）。

---

## 8. 事件日志溯源（`node dist/cli.js events --db data/demo-ledger.db --material MAT-UNKNOWN-99`）

```
== 事件日志溯源（回查方式：material）==
  命中 1 条 / 事件日志共 1 条
  2026-11-03T10:27:15.272Z　scanner_http　台次 OP-SAMPLE-001　手术间 OR-01　扫码枪 SCAN-GUN-07
    投递标识 ac5aff2c-b6ce-4e6c-a478-02a601b429f1　结论 accepted=5;rejected=1　签名 已验
    原始报文 {"operation_no":"OP-SAMPLE-001","room_no":"OR-01","scanner_id":"SCAN-GUN-07","scans":[{"material_code":"MAT-SAMPLE-01",…
```

---

## 9. 台账 ↔ 计费回执对账（`node dist/cli.js reconcile --db data/demo-ledger.db`）

```
== 台账 ↔ 计费回执对账 ==
  台账条目 5 条 / 计费条目 0 条 / 差异 5 条（新增 5，自动闭环 0）
  台账有计费无 5 / 计费有台账无 0 / 字段口径不一致 0
    NOT_SUBMITTED                       5 条
台次             耗材码             差异类型             归因             不一致字段  状态       核查条目
-------------  --------------  ---------------  -------------  -----  -------  ----
OP-SAMPLE-001  MAT-SAMPLE-01   MISSING_RECEIPT  NOT_SUBMITTED         pending
OP-SAMPLE-001  MAT-SAMPLE-02   MISSING_RECEIPT  NOT_SUBMITTED         pending
OP-SAMPLE-001  06912345678902  MISSING_RECEIPT  NOT_SUBMITTED         pending
OP-SAMPLE-001  06987654321092  MISSING_RECEIPT  NOT_SUBMITTED         pending
OP-SAMPLE-001  MAT-SAMPLE-05   MISSING_RECEIPT  NOT_SUBMITTED         pending

  差异类型说明：
    MISSING_RECEIPT      台账有、计费侧无成功回执
    UNKNOWN_RECEIPT      计费侧有、台账无对应条目
    FIELD_MISMATCH       两边都有但字段口径不一致
```

> 三类差异：台账有回执无（`MISSING_RECEIPT`）、回执有台账无（`UNKNOWN_RECEIPT`）、
> 两边都有但字段口径不一致（`FIELD_MISMATCH`）。归因口径见 [`api/reconcile.md`](api/reconcile.md)。

---

## 10. 月度对账包（`npm run monthly:run` 落盘产物）

### 10.1 汇总表 `data/monthly/monthly-reconcile-summary.csv`

按**科室 × 业务月**聚合：

```csv
dept_code,month,usage_count,quantity,charge_success,charge_rejected,charge_pending_retry,charge_not_submitted,pending_check,diff_count,operations,materials
SURG-CTS,2026-01,482,1952,480,0,2,0,0,2,93,482
SURG-CVS,2026-01,493,2041,491,0,2,0,0,2,92,493
SURG-ENT,2026-01,499,2111,494,0,5,0,0,5,94,499
SURG-GS,2026-01,479,1977,466,0,13,0,0,13,96,479
SURG-IVR,2026-01,458,1883,458,0,0,0,0,0,92,458
```

### 10.2 明细表 `data/monthly/monthly-reconcile-detail.csv`

台账行粒度，一行一条耗材：

```csv
operation_no,room_no,dept_code,month,material_code,quantity,charge_quantity,conclusion,reason_code,use_time,charge_state,receipt_attempt,delivery_count,receipt_reason_code,error_code,check_task_id,check_status,diff_type,diff_attribution
OP-SYN-000145,OR-09,SURG-URO,2026-01,06900000002636,2,2,BOUND,,2026-01-20T00:29:34.000Z,accepted,1,1,,,,,,
OP-SYN-000145,OR-09,SURG-URO,2026-01,06900000018149,3,3,BOUND,,2026-01-20T00:29:35.000Z,accepted,1,1,,,,,,
OP-SYN-000145,OR-09,SURG-URO,2026-01,06900000019986,3,3,BOUND,,2026-01-20T00:29:36.000Z,accepted,1,1,,,,,,
```

> `quantity` 是扫码数量，`charge_quantity` 是按包装换算后的**计价数量**（两者不同时说明口径换算起作用了）。
> `diff_type` / `diff_attribution` 有值时，这一行就是一条待核查的差异。

### 10.3 对账包 JSON `data/monthly/monthly-reconcile-pack.json`

包含汇总、按月下钻索引、抽样回查结论与字段清单，供耗材管理岗做月度对账。
实测数字见 [`benchmarks/monthly-reconcile.md`](benchmarks/monthly-reconcile.md)。

---

## 11. 审计链行（`audit_chain` 行，哈希链）

```json
{
  "id": 1,
  "event_type": "check_task_assigned",
  "binding_key": null,
  "operation_no": "OP-SYN-000001",
  "scanner_id": "SCAN-OR-01-01",
  "actor": "check_router",
  "detail": "{\"task_id\":1,\"assignee_role\":\"手术室护士长\",\"assignee_display\":\"手术室护士长（SURG-CVS）\",\"dept_code\":\"SURG-CVS\",\"conclusion\":\"CLOSED\",\"reason_code\":\"OPERATION_CLOSED\",\"error_code\":\"ERR_OPERATION_CLOSED\",\"matched_by\":\"reason_code\",\"matched_key\":\"OPERATION_CLOSED\",\"basis_zh\":\"台次已关台，这条耗材不能自动计费，请手术室护士长确认是否走人工补录\",\"material_code\":\"06900000014349\"}",
  "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "row_hash": "f2a7304075b16dca95a50d661bbfd930c73afcc852e98072b9b1b178ce160425",
  "created_at": "2026-11-03T10:15:23.163Z",
  "request_id": null
}
```

> 第一行的 `prev_hash` 是**创世哈希**（64 个 0），第二行的 `prev_hash` 精确等于第一行的 `row_hash` ——
> 任何一行被改或被删，校验立即失败并指出**第一个断点行号**。
> `detail` 里的 `basis_zh` 是给护士长看的**人话判据**（「台次已关台，这条耗材不能自动计费…」）。

---

## 12. 企业微信批次摘要

按台次聚合的 markdown 消息（同一时间窗内多批合并成一条，不刷屏）：

```
**高值耗材扫码待核（台次 `OP-SAMPLE-001`）**
> 手术间 `OR-01` · 科室 `SURG-01` · 时间窗 09:12 ~ 09:17（5 秒内合并 1 批）
> 本窗口共 6 条耗材：已绑定 5 条，待核 1 条

**待核明细（1 条）**
> 1. `MAT-UNKNOWN-99` —— 耗材未建档（`MATERIAL_NOT_REGISTERED`） 数量 1
> 该谁处理：高值耗材管理岗 ｜建议处置：补建耗材档案后重新扫码计费

> 处理入口：高值耗材扫码计费闭环系统 · 核查清单（落定结论后自动闭环）
```

推送体（`POST $WECOM_WEBHOOK_URL`）：

```json
{ "msgtype": "markdown", "markdown": { "content": "**高值耗材扫码待核（台次 `OP-SAMPLE-001`）**\n> 手术间 `OR-01` …" } }
```

> 推送失败**不阻塞台账落库** —— 失败计数写审计链，由 `doctor` 暴露。
> 签名与字段规范见 [`api/wecom-notify.md`](api/wecom-notify.md)。

---

## 13. 运维体检（`node dist/cli.js doctor --db data/demo-ledger.db`）

```
== 通道体检 ==
  入站扫码网关           缺 OR_SCANNER_BASE_URL、OR_SCANNER_TOKEN、OR_SCANNER_SECRET 端点=未配置
  出站 HIS 计费        缺 HIS_CHARGING_BASE_URL、HIS_CHARGING_TOKEN 端点=未配置
  企业微信推送           缺 WECOM_WEBHOOK_URL、WECOM_SECRET 端点=未配置

== 事件来源 ==
  扫码枪 HTTP 接入      不可用      收到    1 条  末次=2026-11-03T10:27:15.272Z  入站凭据位不齐（见通道体检）
  RFID 网关目录投递      不可用      收到    0 条  末次=—  投递目录不可读：scan-inbox

== 运行状态 ==
  台账行数=5 回执行=0 待核查=1 审计行=7 事件=1
  入站拒绝=1 次（其中重放挡下 0 次）　nonce 记录=1 条（已过期待清理 0 条）
  时间戳窗口=300s　nonce 有效期=600s　最近一次 nonce 过期=2026-11-03T10:37:15.268Z
  审计链完整性：通过
  审计链校验：完整（覆盖 7 行，校验时间 2026-11-03T10:27:35.642Z）

== 待核查条目按错误码 ==
  ERR_MATERIAL_NOT_REGISTERED         1 条  耗材未建档（主数据查不到这个耗材码）
  处置口径见 docs/api/errors.md

== 待核查条目按责任岗位 ==
  高值耗材管理岗         1 条  已催 0　已升级 0  科室 SURG-01
  路由口径见 docs/api/check-routing.md
```

> 体检单只报「齐否 + 缺哪个变量名 + 脱敏端点」，**从不打印令牌明文**。

---

## 14. 怎么自己跑一遍

```bash
# 主干最窄路径：6 条扫码 → 5 条绑上 + 1 条未建档 → 台账 5 行 → 错误签名 401 且不落行
npm run demo:pipe

# 建一份带样例主数据的台账库
node dist/cli.js import-master \
  --operations tests/fixtures/operations.csv \
  --materials tests/fixtures/materials.csv

# 查台账 / 导清单 / 跑对账
node dist/cli.js ledger --db data/ledger.db
node dist/cli.js closing --db data/ledger.db --operation OP-SAMPLE-001
node dist/cli.js reconcile --db data/ledger.db
```

完整参数见 [`cli.md`](cli.md)。
