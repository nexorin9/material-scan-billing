/**
 * demo:pipe —— 主干最窄端到端的一条命令演示。
 *
 *   扫码枪投递一批 6 条扫码事件（带正确签名）
 *     → 入站 HTTP 服务验签
 *     → 字段标准化（UDI / GS1 / 院内码 → 规范耗材码）
 *     → 绑定判定（查台次 + 查耗材主数据）
 *     → 耗材使用台账落行
 *     → 逐条回执（5 条绑上 + 1 条耗材码未建档）
 *
 * 演示用的是**每跑一次随机生成**的本地令牌与签名密钥（不硬编码任何凭据、不连真实系统），
 * 并在结束时再打一次错误签名，证明「验签失败 → 401 且台账不落行」。
 *
 * 运行：npm run demo:pipe
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openLedger } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { countBindings } from '../src/ledger/binding-repo.js';
import { startIngestServer } from '../src/ingest/http-server.js';
import { formatSignatureHeader } from '../src/ingest/signature.js';
import { newNonce } from '../src/ingest/replay-guard.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');
const demoDbPath = resolve(projectRoot, 'data', 'demo-ledger.db');

/** 演示令牌与密钥：每次运行随机生成，绝不写死在代码里 */
const demoToken = `demo-token-${randomBytes(12).toString('hex')}`;
const demoSecret = `demo-secret-${randomBytes(16).toString('hex')}`;

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

/**
 * 演示主数据里额外登记两条非院内码：UDI 的 DI 与 GS1 AI(01) 的 GTIN。
 *
 * 单位口径四列（unit_pack / unit_min / charge_unit / ratio）与耗材 CSV 表头逐字对齐 ——
 * 缺这几列的耗材**算不出计价数量**，会被判「单位口径不可用」转人工（宁可不计费，也不猜）。
 * 这里按 1:1 登记（1 包 = 1 支），与既有 fixture 的口径一致。
 */
const EXTRA_MATERIALS = [
  {
    material_code: '06912345678902',
    name: '药物洗脱支架（UDI 码登记）',
    price_code: 'PR-DEMO-UDI',
    fee_category: '卫生材料',
    medical_insurance_class: '甲类',
    active: 'true',
    batch_no: 'LOT-A1',
    unit_pack: '包',
    unit_min: '支',
    charge_unit: '支',
    ratio: '1',
  },
  {
    material_code: '06987654321092',
    name: '可吸收止血膜（GS1 包装码登记）',
    price_code: 'PR-DEMO-GS1',
    fee_category: '卫生材料',
    medical_insurance_class: '乙类',
    active: 'true',
    batch_no: 'LOT-B1',
    unit_pack: '包',
    unit_min: '支',
    charge_unit: '支',
    ratio: '1',
  },
];

function escapeCsvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 追加到既有耗材 CSV 末尾的**数据行**（表头已在既有 CSV 里，不重复写） */
function extraMaterialsCsv(): string {
  return EXTRA_MATERIALS.map((row) => Object.values(row).map(escapeCsvCell).join(',')).join('\n');
}

/** 一批 6 条扫码：4 条院内码 + 1 条 UDI + 1 条 GS1 + 1 条未建档 */
function demoBatch() {
  const base = {
    operation_no: 'OP-SAMPLE-001',
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
  };
  return {
    ...base,
    scans: [
      { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00+08:00', batch_no: 'LOT-SAMPLE-A' },
      { material_code: 'MAT-SAMPLE-02', quantity: 2, scan_time: '2026-01-15T09:13:10+08:00', batch_no: 'LOT-SAMPLE-B' },
      { material_code: '(01)06912345678902(10)LOT-A1', quantity: 1, scan_time: '2026-01-15T09:14:22+08:00' },
      { material_code: '0106987654321092', quantity: 1, scan_time: '2026-01-15T09:15:40+08:00' },
      { material_code: 'MAT-SAMPLE-05', quantity: 1, scan_time: '2026-01-15T09:16:05+08:00', batch_no: 'LOT-SAMPLE-E' },
      { material_code: 'MAT-UNKNOWN-99', quantity: 1, scan_time: '2026-01-15T09:17:31+08:00' },
    ],
  };
}

interface BatchResponse {
  accepted: Array<{ material_code: string; operation_no: string; bound: boolean; conclusion: string; charge_state: string }>;
  rejected: Array<{ material_code: string; reason_code: string }>;
}

async function postBatch(port: number, body: unknown, secret: string): Promise<{ status: number; json: BatchResponse | null }> {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = newNonce();
  const signature = formatSignatureHeader(timestamp, nonce, rawBody, secret);
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/scan-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${demoToken}`,
      'x-scan-timestamp': timestamp,
      'x-scan-nonce': nonce,
      'x-scan-signature': signature,
    },
    body: rawBody,
  });
  const text = await response.text();
  let json: BatchResponse | null = null;
  try {
    json = JSON.parse(text) as BatchResponse;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function main(): Promise<void> {
  rmSync(demoDbPath, { force: true });
  const ledger = openLedger(demoDbPath);
  const imported = importMasterData(ledger.db, {
    operationsCsv,
    materialsCsv: `${materialsCsv.trimEnd()}\n${extraMaterialsCsv()}`,
  });

  console.log('== 主数据导入 ==');
  console.log(
    `台次 ${imported.operations.inserted} 条 / 耗材 ${imported.materials.inserted} 条（跳过 ${imported.operations.skipped + imported.materials.skipped} 条）`,
  );

  const before = countBindings(ledger.db);
  const handle = await startIngestServer({ db: ledger.db, token: demoToken, secret: demoSecret });

  try {
    console.log('\n== 扫码事件投递（正确签名）==');
    const batch = demoBatch();
    const ok = await postBatch(handle.port, batch, demoSecret);
    console.log(`HTTP ${ok.status}`);
    const json = ok.json;
    if (!json) {
      console.log('响应不是合法 JSON');
      process.exitCode = 1;
      return;
    }

    const lines: string[] = [];
    for (const item of json.accepted) {
      lines.push(
        `  ${item.material_code.padEnd(28)} ${item.conclusion.padEnd(16)} 台次=${item.operation_no} 计费状态=${item.charge_state}`,
      );
    }
    for (const item of json.rejected) {
      lines.push(`  ${item.material_code.padEnd(28)} ${'REJECTED'.padEnd(16)} 原因=${item.reason_code}`);
    }
    console.log(lines.join('\n'));

    const after = countBindings(ledger.db);
    console.log(`\n逐条结论 ${json.accepted.length + json.rejected.length} 条（绑定 ${json.accepted.length} / 异常 ${json.rejected.length}）`);
    console.log(`耗材使用台账新增行数：${after - before}（表内累计 ${after} 行）`);

    console.log('\n== 同一批换错误签名再投一次 ==');
    const bad = await postBatch(handle.port, demoBatch(), 'wrong-secret');
    const afterBad = countBindings(ledger.db);
    console.log(`HTTP ${bad.status}`);
    console.log(`耗材使用台账新增行数：${afterBad - after}（表内累计 ${afterBad} 行）`);
    if (bad.status !== 401) {
      console.log('错误签名未被拒绝');
      process.exitCode = 1;
    }
  } finally {
    await handle.close();
    ledger.close();
  }
}

await main();
