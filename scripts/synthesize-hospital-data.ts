/**
 * 院内数据合成脚本 —— 按院内口径生成排台台次 / 耗材主数据 / 扫码批次三张表。
 *
 * 跑法：
 *   npm run data:synth
 *   npm run data:synth -- --seed 20260202 --operations 1200 --materials 5200
 *
 * 产物：
 *   data/synthetic/operations.csv      排台台次（列与产品导入器一致）
 *   data/synthetic/materials.csv       耗材主数据（列与产品导入器一致）
 *   data/synthetic/scan-items.csv      逐条扫码条目（带预期结论与原因码）
 *   data/synthetic/scan-events.jsonl   扫码批次（入站请求体，可直接投递事件接口）
 *   data/merged/materials.csv          公开来源 + 合成来源合并后的耗材主数据
 *   data/merged/operations.csv         合并后的排台台次
 *
 * **可重跑**：固定种子 → 逐字节一致。脚本末尾打印每个产物的 sha256，
 * 连续跑两次比对 sha256 即可验证。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  batchesToJsonl,
  materialsToCsv,
  operationsToCsv,
  scanItemsToCsv,
  synthesizeHospitalData,
  type SyntheticOperation,
} from '../src/data/synthesize.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const syntheticDir = resolve(projectRoot, 'data', 'synthetic');
const mergedDir = resolve(projectRoot, 'data', 'merged');
const externalDir = resolve(projectRoot, 'data', 'external');

function parseArgs(argv: readonly string[]): {
  seed: number;
  operations: number;
  materials: number;
} {
  let seed = 20260101;
  let operations = 1200;
  let materials = 5200;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--seed') {
      const parsed = Number.parseInt(next ?? '', 10);
      if (Number.isFinite(parsed)) seed = parsed;
      i += 1;
    } else if (arg === '--operations') {
      const parsed = Number.parseInt(next ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) operations = parsed;
      i += 1;
    } else if (arg === '--materials') {
      const parsed = Number.parseInt(next ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) materials = parsed;
      i += 1;
    }
  }
  return { seed, operations, materials };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function main(): void {
  const { seed, operations, materials } = parseArgs(process.argv.slice(2));
  mkdirSync(syntheticDir, { recursive: true });
  mkdirSync(mergedDir, { recursive: true });

  const dataset = synthesizeHospitalData({
    seed,
    operationCount: operations,
    materialCount: materials,
  });

  const operationsCsv = operationsToCsv(dataset.operations);
  const materialsCsv = materialsToCsv(dataset.materials);
  const scanItemsCsv = scanItemsToCsv(dataset.items);
  const scanEventsJsonl = batchesToJsonl(dataset.batches);

  writeFileSync(resolve(syntheticDir, 'operations.csv'), operationsCsv, 'utf8');
  writeFileSync(resolve(syntheticDir, 'materials.csv'), materialsCsv, 'utf8');
  writeFileSync(resolve(syntheticDir, 'scan-items.csv'), scanItemsCsv, 'utf8');
  writeFileSync(resolve(syntheticDir, 'scan-events.jsonl'), scanEventsJsonl, 'utf8');
  writeFileSync(
    resolve(syntheticDir, 'stats.json'),
    JSON.stringify(dataset.stats, null, 2) + '\n',
    'utf8',
  );

  // 合并主数据：公开来源优先（真实器械标识），合成来源补充规模
  const publicMaterialsPath = resolve(externalDir, 'materials.csv');
  const publicMaterialsCsv = existsSync(publicMaterialsPath)
    ? readFileSync(publicMaterialsPath, 'utf8')
    : '';
  const publicRows = publicMaterialsCsv.trim().length > 0
    ? publicMaterialsCsv.trimEnd().split('\n').slice(1).filter((line) => line.trim().length > 0)
    : [];
  const mergedMaterialsCsv =
    publicRows.length > 0
      ? publicMaterialsCsv.trimEnd() + '\n' + materialsCsv.trimEnd().split('\n').slice(1).join('\n') + '\n'
      : materialsCsv;
  writeFileSync(resolve(mergedDir, 'materials.csv'), mergedMaterialsCsv, 'utf8');
  writeFileSync(resolve(mergedDir, 'operations.csv'), operationsCsv, 'utf8');

  console.log(`院内数据合成完成（种子 ${seed}）`);
  console.log(`  台次 ${dataset.stats.operations} 条（开台 ${dataset.stats.operations_open} / 已关台 ${dataset.stats.operations_closed}）`);
  console.log(`  耗材 ${dataset.stats.materials} 条（启用 ${dataset.stats.active_materials} / 停用 ${dataset.stats.inactive_materials}）`);
  console.log(`  扫码批次 ${dataset.stats.batches} 批 / 条目 ${dataset.stats.scan_items} 条`);
  console.log(
    `  码制分布：UDI ${dataset.stats.code_forms.UDI} / GS1 ${dataset.stats.code_forms.GS1} / 院内码 ${dataset.stats.code_forms.INTERNAL}`,
  );
  console.log(
    `  异常条目：未建档 ${dataset.stats.anomalies.unregistered} / 跨台次重复 ${dataset.stats.anomalies.cross_op_dup} / 已关台 ${dataset.stats.anomalies.operation_closed} / 停用耗材 ${dataset.stats.anomalies.inactive_material} / 同台次重复 ${dataset.stats.anomalies.duplicate_scan}`,
  );
  console.log(`  合并主数据：公开 ${publicRows.length} 行 + 合成 ${dataset.stats.materials} 行 → data/merged/materials.csv`);
  console.log('  产物 sha256（同一份种子重复执行应完全一致）：');
  for (const [name, content] of [
    ['operations.csv', operationsCsv],
    ['materials.csv', materialsCsv],
    ['scan-items.csv', scanItemsCsv],
    ['scan-events.jsonl', scanEventsJsonl],
  ] as const) {
    console.log(`    ${name}  ${sha256(content)}`);
  }
}

main();
