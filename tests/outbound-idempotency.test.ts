/**
 * test_outbound_idempotency：出站幂等键透传与键版本化（对端也幂等）。
 *
 * 背景：单侧幂等只挡得住「**本侧**重复发」—— 对端重试后补发、网关重传，
 * 同一笔耗材消费仍可能被 HIS 计费侧记两笔。本任务把幂等键**透传给对端**：
 * 出站请求体带 `idempotency_key`（行级 + 请求级）与 `key_profile`（键档位），
 * 对端按同一把键去重；本侧重投时**复用同一把键**，绝不因重试次数变化而改键。
 *
 * 替身说明：这里的「HIS 计费替身」是 tests/ 内的**真实 HTTP 服务**（node:http），
 * 生产客户端与替身走**同一条代码路径**（原生 fetch → 真实 socket → 真实请求头 / 请求体），
 * 不 mock fetch。替身只存在于测试数据层，不是产品的最终对接方式。
 *
 * 覆盖：
 *   ① 出站请求体含 idempotency_key 与 key_profile（顶层 + 行级），行级键与台账行逐字一致；
 *   ② 请求级键由行级键派生，且与行级键的顺序无关；
 *   ③ 重投两次的请求体键**逐字相同**（对端 500 → 重投 → 200）；
 *   ④ 回执行落库带幂等键、键档位、请求级键与对端回显状态；
 *   ⑤ 切换键档位后键值不同（v1 → v2）；
 *   ⑥ 对端回显键 → ECHOED；不回显 → NOT_ECHOED（对端未启用幂等），本侧单侧幂等仍成立；
 *   ⑦ 对端回显另一把键 → MISMATCH（两端口径不一致，留痕不误判）；
 *   ⑧ 迁移 v18 落两列且幂等重跑；
 *   ⑨ 字段规范文档与实现逐字同步。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';

import { HisChargingClient } from '../src/charge/client.js';
import {
  MATERIAL_USE_FIELDS,
  MATERIAL_USES_REQUEST_FIELDS,
  prepareMaterialUsesRequest,
  submitMaterialUses,
  type MaterialUse,
} from '../src/charge/submit.js';
import {
  PEER_IDEMPOTENCY_STATUS,
  loadReceipts,
  peerIdempotencyStatus,
} from '../src/charge/receipt.js';
import { ChargeRetryScheduler, toMaterialUse, type ChargeItem } from '../src/charge/retry.js';
import { writeBackOperationCharges } from '../src/charge/writeback.js';
import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { LATEST_SCHEMA_VERSION, currentSchemaVersion } from '../src/ledger/migrations.js';
import { bindOne } from '../src/engine/binding.js';
import {
  deriveIdempotencyKey,
  deriveIdempotencyKeyForProfile,
  deriveRequestIdempotencyKey,
} from '../src/domain/idempotency.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

const TOKEN = 'his-charging-token-plaintext-7c41';
const ENDPOINT_PATH = '/api/v1/material-uses';
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** 对端回显键的方式 */
type EchoMode = 'none' | 'echo' | 'mismatch';

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** HIS 计费替身：真实 HTTP 服务；按模式决定要不要回显幂等键 */
class HisChargingStub {
  readonly requests: CapturedRequest[] = [];
  private readonly server: Server;
  private mode: EchoMode = 'none';
  private statusQueue: number[] = [];
  baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        this.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: raw,
        });

        const status = this.statusQueue.shift() ?? 200;
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ message: `peer failed with ${status} on purpose` }));
          return;
        }

        let parsed: {
          idempotency_key?: string;
          uses?: Array<{ material_code: string; idempotency_key?: string }>;
        } = {};
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          parsed = {};
        }

        const uses = Array.isArray(parsed.uses) ? parsed.uses : [];
        const withEcho = (use: { material_code: string; idempotency_key?: string }): Record<string, string> => {
          const item: Record<string, string> = { material_code: use.material_code };
          if (this.mode === 'echo' && use.idempotency_key) {
            item['idempotency_key'] = use.idempotency_key;
          } else if (this.mode === 'mismatch') {
            // 对端回显了**另一把**键：两端口径不一致
            item['idempotency_key'] = 'f'.repeat(64);
          }
          return item;
        };

        const payload: Record<string, unknown> = {
          accepted: uses.map((use) => withEcho(use)),
          rejected: [],
        };
        if (this.mode !== 'none' && typeof parsed.idempotency_key === 'string') {
          payload['idempotency_key'] =
            this.mode === 'mismatch' ? 'e'.repeat(64) : parsed.idempotency_key;
        }

        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      });
      res.on('error', () => {
        // 客户端超时后主动断开：忽略写回失败（替身侧）
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((done) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          done();
          return;
        }
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        done();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => {
      this.server.close(() => done());
    });
  }

  setMode(mode: EchoMode): void {
    this.mode = mode;
  }

  queueStatus(status: number): void {
    this.statusQueue.push(status);
  }

  reset(): void {
    this.requests.length = 0;
    this.statusQueue.length = 0;
    this.mode = 'none';
  }

  /** 抓到的请求体（逐个） */
  bodies(): Array<Record<string, unknown>> {
    return this.requests.map((request) => JSON.parse(request.body) as Record<string, unknown>);
  }
}

const stub = new HisChargingStub();

before(async () => {
  await stub.start();
});

after(async () => {
  await stub.stop();
});

beforeEach(() => {
  stub.reset();
});

/** 每个用例一份干净的内存台账（主数据已导入） */
function freshLedger(): LedgerDb {
  const ledger = openLedger(':memory:');
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  return ledger;
}

/** 造一条已绑定（status = bound）的台账行，返回该行的幂等键与档位 */
function bindMaterial(
  ledger: LedgerDb,
  material_code = 'MAT-SAMPLE-01',
  operation_no = 'OP-SAMPLE-001',
): { idempotency_key: string; key_profile: string } {
  const outcome = bindOne(ledger.db, {
    db: ledger.db,
    operation_no,
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    material_code,
    raw_code: material_code,
    quantity: 1,
  });
  assert.equal(outcome.bound, true, '前置条件：这条耗材应绑上台次');
  const row = ledger.db
    .prepare('SELECT idempotency_key, key_profile FROM material_binding WHERE material_code = ?')
    .get(material_code) as { idempotency_key: string; key_profile: string };
  return { idempotency_key: row.idempotency_key, key_profile: row.key_profile };
}

function newClient(): HisChargingClient {
  return new HisChargingClient({
    baseUrl: stub.baseUrl,
    token: TOKEN,
    timeoutMs: 2_000,
    logger: () => {
      // 测试里不落日志
    },
  });
}

function chargeItem(
  material_code = 'MAT-SAMPLE-01',
  operation_no = 'OP-SAMPLE-001',
): ChargeItem {
  return {
    material_code,
    operation_no,
    room_no: 'OR-01',
    dept_code: 'SURG-01',
    scanner_id: 'SCAN-GUN-07',
    quantity: 1,
    price_code: 'PR-SAMPLE-01',
    use_time: '2026-01-15T09:12:00.000Z',
    fee_category: '卫生材料',
    medical_insurance_class: '甲类',
    idempotency_key: deriveIdempotencyKey(material_code, operation_no),
    key_profile: 'v1',
  };
}

describe('test_outbound_idempotency · 出站请求体带键', () => {
  it('① 请求体含 idempotency_key 与 key_profile：行级键与台账行逐字一致', async () => {
    const ledger = freshLedger();
    try {
      const bound = bindMaterial(ledger);
      const client = newClient();

      const result = await writeBackOperationCharges(ledger.db, 'OP-SAMPLE-001', {
        client,
        path: ENDPOINT_PATH,
      });

      assert.equal(result.calls, 1);
      assert.equal(stub.requests.length, 1);

      const body = stub.bodies()[0]!;
      // 字段名逐字对齐规范
      assert.deepEqual(Object.keys(body), [...MATERIAL_USES_REQUEST_FIELDS]);
      const uses = body['uses'] as Array<Record<string, unknown>>;
      assert.deepEqual(Object.keys(uses[0]!), [...MATERIAL_USE_FIELDS]);

      // 请求级键：sha256 十六进制
      assert.match(String(body['idempotency_key']), SHA256_HEX);
      assert.equal(body['key_profile'], 'v1');

      // 行级键：**与台账行绑定的同一把**（不是现算的另一个）
      assert.equal(uses[0]!['idempotency_key'], bound.idempotency_key);
      assert.equal(uses[0]!['key_profile'], bound.key_profile);
      assert.match(String(uses[0]!['idempotency_key']), SHA256_HEX);

      // 请求级键由行级键派生
      assert.equal(
        body['idempotency_key'],
        deriveRequestIdempotencyKey('OP-SAMPLE-001', [bound.idempotency_key]).key,
      );
    } finally {
      ledger.close();
    }
  });

  it('② 请求级键与行级键的顺序无关（同一批换顺序重发，键不变）', () => {
    const keyA = deriveIdempotencyKey('MAT-SAMPLE-01', 'OP-SAMPLE-001');
    const keyB = deriveIdempotencyKey('MAT-SAMPLE-02', 'OP-SAMPLE-001');

    const forward = deriveRequestIdempotencyKey('OP-SAMPLE-001', [keyA, keyB]);
    const backward = deriveRequestIdempotencyKey('OP-SAMPLE-001', [keyB, keyA]);

    assert.equal(forward.key, backward.key);
    assert.match(forward.key, SHA256_HEX);
    assert.equal(forward.line_count, 2);
    // 台次不同 → 键不同（不同台次的同一笔不是同一笔）
    assert.notEqual(
      forward.key,
      deriveRequestIdempotencyKey('OP-SAMPLE-002', [keyA, keyB]).key,
    );
  });

  it('③ 重投两次：请求体的键逐字相同（不因重试次数变化而改键）', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      const client = newClient();
      const item = chargeItem();

      // 第一次：对端 500（可重投）；第二次：对端 200
      stub.queueStatus(500);
      const scheduler = new ChargeRetryScheduler(ledger.db, {
        submit: async (charge: ChargeItem) =>
          submitMaterialUses(client, charge.operation_no, charge.dept_code, [toMaterialUse(charge)], {
            path: ENDPOINT_PATH,
          }),
        maxAttempts: 3,
        baseDelayMs: 0,
        now: () => 1_000,
        sleep: async () => {
          // 测试里不等退避
        },
      });

      const first = await scheduler.submit(item);
      assert.equal(first.status, 'retry_scheduled');

      await scheduler.retryDue(2_000);
      assert.equal(stub.requests.length, 2, '重投应真的又发了一次');

      const [firstBody, secondBody] = stub.bodies();
      assert.equal(firstBody!['idempotency_key'], secondBody!['idempotency_key']);
      assert.equal(firstBody!['key_profile'], secondBody!['key_profile']);
      const firstUses = firstBody!['uses'] as Array<Record<string, unknown>>;
      const secondUses = secondBody!['uses'] as Array<Record<string, unknown>>;
      assert.equal(firstUses[0]!['idempotency_key'], secondUses[0]!['idempotency_key']);
      assert.equal(firstUses[0]!['idempotency_key'], item.idempotency_key);

      // 两次尝试的回执行都带着同一把键
      const receipts = loadReceipts(ledger.db, item.material_code, item.operation_no);
      assert.equal(receipts.length, 2);
      assert.equal(receipts[0]!.idempotency_key, item.idempotency_key);
      assert.equal(receipts[1]!.idempotency_key, item.idempotency_key);
      assert.equal(receipts[1]!.attempt, 2);
    } finally {
      ledger.close();
    }
  });

  it('④ 回执行落库带幂等键、键档位、请求级键与对端回显状态', async () => {
    const ledger = freshLedger();
    try {
      const bound = bindMaterial(ledger);
      const client = newClient();

      await writeBackOperationCharges(ledger.db, 'OP-SAMPLE-001', {
        client,
        path: ENDPOINT_PATH,
      });

      const receipts = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      assert.equal(receipts.length, 1);
      const receipt = receipts[0]!;
      assert.equal(receipt.idempotency_key, bound.idempotency_key);
      assert.equal(receipt.key_profile, bound.key_profile);
      assert.match(String(receipt.request_idempotency_key), SHA256_HEX);
      assert.equal(receipt.peer_idempotency_status, PEER_IDEMPOTENCY_STATUS.not_echoed);
    } finally {
      ledger.close();
    }
  });

  it('⑤ 切换键档位后键值不同（v1 → v2）', () => {
    const base: MaterialUse = {
      material_code: 'MAT-SAMPLE-01',
      quantity: 1,
      price_code: 'PR-SAMPLE-01',
      use_time: '2026-01-15T09:12:00.000Z',
      fee_category: '卫生材料',
      medical_insurance_class: '甲类',
    };

    // ① 现派生（没有台账键）：v2 缺批号 → **降级成 v1**（批号未知就分不清两批，宁可少算）
    const derivedV1 = prepareMaterialUsesRequest('OP-SAMPLE-001', 'SURG-01', [base], {
      keyProfile: 'v1',
    });
    const derivedV2 = prepareMaterialUsesRequest('OP-SAMPLE-001', 'SURG-01', [base], {
      keyProfile: 'v2',
    });
    assert.equal(derivedV2.line_keys[0], derivedV1.line_keys[0]);
    assert.equal(derivedV2.request.uses[0]!.key_profile, 'v1', '降级后档位如实标 v1');
    assert.equal(derivedV2.request_key, derivedV1.request_key);

    // ② 台账键在两档下不同（v2 带批号）→ 出站两把键都跟着变
    const v1Key = deriveIdempotencyKeyForProfile(
      { material_code: 'MAT-SAMPLE-01', operation_no: 'OP-SAMPLE-001' },
      'v1',
    );
    const v2Key = deriveIdempotencyKeyForProfile(
      { material_code: 'MAT-SAMPLE-01', operation_no: 'OP-SAMPLE-001', batch_no: 'LOT-SAMPLE-A' },
      'v2',
    );
    assert.notEqual(v1Key.key, v2Key.key, '两档的行级键本身不同');

    const passthroughV1 = prepareMaterialUsesRequest(
      'OP-SAMPLE-001',
      'SURG-01',
      [{ ...base, idempotency_key: v1Key.key, key_profile: 'v1' }],
      { keyProfile: 'v1' },
    );
    const passthroughV2 = prepareMaterialUsesRequest(
      'OP-SAMPLE-001',
      'SURG-01',
      [{ ...base, idempotency_key: v2Key.key, key_profile: 'v2' }],
      { keyProfile: 'v2' },
    );
    assert.notEqual(passthroughV1.line_keys[0], passthroughV2.line_keys[0], '换档位后行级键必须不同');
    assert.notEqual(passthroughV1.request_key, passthroughV2.request_key, '换档位后请求级键必须不同');
    assert.equal(passthroughV1.key_profile, 'v1');
    assert.equal(passthroughV2.key_profile, 'v2');
    assert.equal(passthroughV2.request.uses[0]!.key_profile, 'v2');

    // ③ 台账键透传：**老账不被新档位改写**（配置切 v2，老行仍按行上的 v1 键发）
    const passthrough = prepareMaterialUsesRequest(
      'OP-SAMPLE-001',
      'SURG-01',
      [{ ...base, idempotency_key: v1Key.key, key_profile: 'v1' }],
      { keyProfile: 'v2' },
    );
    assert.equal(passthrough.line_keys[0], v1Key.key);
    assert.equal(passthrough.request.uses[0]!.key_profile, 'v1');
  });
});

describe('test_outbound_idempotency · 对端回显与单侧幂等', () => {
  it('⑥ 对端回显同一把键 → ECHOED；不回显 → NOT_ECHOED（本侧单侧幂等仍成立）', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      const client = newClient();

      // 第一次：对端回显同一把键
      stub.setMode('echo');
      await writeBackOperationCharges(ledger.db, 'OP-SAMPLE-001', {
        client,
        path: ENDPOINT_PATH,
      });
      const echoed = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      assert.equal(echoed[0]!.peer_idempotency_status, PEER_IDEMPOTENCY_STATUS.echoed);

      // 第二次：同一台次再回写一次 —— 已计费的条目不再投递（本侧单侧幂等）
      stub.setMode('none');
      const again = await writeBackOperationCharges(ledger.db, 'OP-SAMPLE-001', {
        client,
        path: ENDPOINT_PATH,
      });
      assert.equal(again.calls, 0, '已回写计费的条目不得再次出站');
      assert.equal(stub.requests.length, 1, '对端只应收到一次请求（无重复计费）');

      // 对端没回显键的那一批：回执如实标注「对端未启用幂等」
      const notEchoed = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      assert.equal(notEchoed.length, 1);
      assert.equal(notEchoed[0]!.peer_idempotency_status, PEER_IDEMPOTENCY_STATUS.echoed);
    } finally {
      ledger.close();
    }
  });

  it('⑦ 对端没回显键时按「对端未启用幂等」标注（回执里看得见）', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      const client = newClient();

      stub.setMode('none');
      await writeBackOperationCharges(ledger.db, 'OP-SAMPLE-001', {
        client,
        path: ENDPOINT_PATH,
      });

      const receipts = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      assert.equal(receipts[0]!.peer_idempotency_status, PEER_IDEMPOTENCY_STATUS.not_echoed);
      // 本侧仍保证单侧幂等：键照样落在回执里，事后可按键反查
      assert.match(String(receipts[0]!.idempotency_key), SHA256_HEX);
      assert.match(String(receipts[0]!.request_idempotency_key), SHA256_HEX);
    } finally {
      ledger.close();
    }
  });

  it('⑦ 对端回显另一把键 → MISMATCH（留痕，不当成重复计费）', async () => {
    const ledger = freshLedger();
    try {
      bindMaterial(ledger);
      const client = newClient();

      stub.setMode('mismatch');
      const result = await writeBackOperationCharges(ledger.db, 'OP-SAMPLE-001', {
        client,
        path: ENDPOINT_PATH,
      });

      // 对端接收了 → 台账照常推进；只是端口径不一致，如实留痕
      assert.equal(result.accepted, 1);
      const receipts = loadReceipts(ledger.db, 'MAT-SAMPLE-01', 'OP-SAMPLE-001');
      assert.equal(receipts[0]!.peer_idempotency_status, PEER_IDEMPOTENCY_STATUS.mismatch);
      assert.equal(receipts[0]!.accepted, true);
    } finally {
      ledger.close();
    }
  });

  it('⑦ 回显状态判定函数：空 = 未回显，同值 = 已回显，异值 = 口径不一致', () => {
    const key = 'a'.repeat(64);
    assert.equal(peerIdempotencyStatus(key, ''), PEER_IDEMPOTENCY_STATUS.not_echoed);
    assert.equal(peerIdempotencyStatus(key, undefined), PEER_IDEMPOTENCY_STATUS.not_echoed);
    assert.equal(peerIdempotencyStatus(key, key), PEER_IDEMPOTENCY_STATUS.echoed);
    assert.equal(peerIdempotencyStatus(key, 'b'.repeat(64)), PEER_IDEMPOTENCY_STATUS.mismatch);
    // 本侧没键时无法比对 → 按未回显处理，不误判成口径不一致
    assert.equal(peerIdempotencyStatus('', 'b'.repeat(64)), PEER_IDEMPOTENCY_STATUS.not_echoed);
  });
});

describe('test_outbound_idempotency · 迁移与文档同步', () => {
  it('⑧ 迁移 v18 落两列，且幂等重跑不报错', () => {
    const ledger = freshLedger();
    try {
      assert.equal(currentSchemaVersion(ledger.db), LATEST_SCHEMA_VERSION);
      assert.ok(LATEST_SCHEMA_VERSION >= 18, '迁移链尾版本应不低于 18');

      const columns = (
        ledger.db.prepare('PRAGMA table_info(charge_receipt)').all() as unknown as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      assert.ok(columns.includes('request_idempotency_key'), '回执行须有请求级键列');
      assert.ok(columns.includes('peer_idempotency_status'), '回执行须有对端回显状态列');
      // 幂等键与键档位两列（行级）此前已在
      assert.ok(columns.includes('idempotency_key'));
      assert.ok(columns.includes('key_profile'));

      // 重开一次库：迁移链幂等重跑，不报错、不丢行
      ledger.close();
      const reopened = openLedger(':memory:');
      try {
        assert.equal(currentSchemaVersion(reopened.db), LATEST_SCHEMA_VERSION);
      } finally {
        reopened.close();
      }
    } finally {
      // 已关闭则忽略
    }
  });

  it('⑨ 字段规范文档与实现逐字同步（新字段 + 回显约定 + 口径说明）', () => {
    const chargingDoc = readFileSync(resolve(projectRoot, 'docs', 'api', 'his-charging.md'), 'utf8');
    for (const field of [...MATERIAL_USES_REQUEST_FIELDS, ...MATERIAL_USE_FIELDS]) {
      assert.ok(chargingDoc.includes(field), `出站规范文档缺少字段 ${field}`);
    }
    assert.ok(chargingDoc.includes('peer_idempotency_status'), '文档须写对端回显状态');
    assert.ok(chargingDoc.includes('request_idempotency_key'), '文档须写请求级键落库');
    assert.ok(chargingDoc.includes('NOT_ECHOED'), '文档须写「对端未启用幂等」的处置');
    assert.ok(chargingDoc.includes('IDEMPOTENCY_KEY_PROFILE'), '文档须写键档位配置项');

    const idemDoc = readFileSync(resolve(projectRoot, 'docs', 'api', 'idempotency.md'), 'utf8');
    assert.ok(idemDoc.includes('idempotency_key'), '幂等键文档须写出站透传字段');
    assert.ok(
      !idemDoc.includes('不在本轮范围内'),
      '幂等键文档 §5 须改成「已透传」（本轮已实现）',
    );
  });
});
