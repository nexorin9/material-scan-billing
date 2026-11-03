/**
 * 数据清单汇总脚本 —— 把「公开来源 + 合成产物」汇成一份机器可读的账：data/manifest.json。
 *
 * 跑法：npm run data:manifest
 *
 * 清单回答三件事：
 *   ① 来源：哪些是公开数据、哪些是院内口径合成、断网时回落到哪儿（data_source 字段）；
 *   ② 规模：台次 / 耗材 / 批次 / 扫码条目各多少，异常条目怎么分布；
 *   ③ 可重跑：种子是多少、每个产物的 sha256 是多少。
 *
 * 清单里**不写墙上时间**（获取时间在 data/external/fetch-manifest.json），
 * 所以同一份输入两次跑出来的 manifest 也是逐字节一致的。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDataManifest, type ManifestFile } from '../src/data/manifest.js';
import type { SyntheticStats } from '../src/data/synthesize.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const dataDir = resolve(projectRoot, 'data');

interface FetchManifestSource {
  id: string;
  title: string;
  url: string;
  status: 'ok' | 'failed';
  http_status: number | null;
  bytes: number;
  sha256: string;
  license: string;
  license_url: string;
  usage: string;
  records: number;
  error: string;
}

interface FetchManifest {
  sources: FetchManifestSource[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function countRows(text: string, hasHeader: boolean): number {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  return hasHeader ? Math.max(0, lines.length - 1) : lines.length;
}

function describe(path: string): ManifestFile | null {
  const absolute = resolve(projectRoot, path);
  if (!existsSync(absolute)) return null;
  const content = readFileSync(absolute, 'utf8');
  // CSV 首行是表头；JSONL 每行都是一条记录
  const hasHeader = path.endsWith('.csv');
  return { path, rows: countRows(content, hasHeader), sha256: sha256(content) };
}

function main(): void {
  const fetchManifestPath = resolve(dataDir, 'external', 'fetch-manifest.json');
  const statsPath = resolve(dataDir, 'synthetic', 'stats.json');
  const publicMaterialsPath = resolve(dataDir, 'external', 'materials.csv');

  if (!existsSync(statsPath)) {
    console.error('缺少 data/synthetic/stats.json：请先跑 npm run data:synth');
    process.exitCode = 1;
    return;
  }

  const stats = JSON.parse(readFileSync(statsPath, 'utf8')) as SyntheticStats;
  const fetchManifest = existsSync(fetchManifestPath)
    ? (JSON.parse(readFileSync(fetchManifestPath, 'utf8')) as FetchManifest)
    : { sources: [] };

  const publicMaterials = existsSync(publicMaterialsPath)
    ? countRows(readFileSync(publicMaterialsPath, 'utf8'), true)
    : 0;

  const files: ManifestFile[] = [];
  for (const path of [
    'data/synthetic/operations.csv',
    'data/synthetic/materials.csv',
    'data/synthetic/scan-items.csv',
    'data/synthetic/scan-events.jsonl',
    'data/external/materials.csv',
    'data/external/materials-provenance.csv',
    'data/merged/materials.csv',
    'data/merged/operations.csv',
  ]) {
    const described = describe(path);
    if (described) files.push(described);
  }

  const manifest = buildDataManifest({
    fetchOutcomes: fetchManifest.sources.map((source) => ({
      ...source,
      fetched_at: '',
      body: null,
    })),
    synthetic: stats,
    publicMaterials,
    files,
  });

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(resolve(dataDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log('数据清单已写入 data/manifest.json');
  console.log(`  数据来源：${manifest.data_source}（公开 ${manifest.scale.materials_public} 行 / 合成 ${manifest.scale.materials_synthetic} 行）`);
  console.log(
    `  规模：台次 ${manifest.scale.operations}（开台 ${manifest.scale.operations_open} / 已关台 ${manifest.scale.operations_closed}）、耗材 ${manifest.scale.materials_total}、批次 ${manifest.scale.batches}、扫码条目 ${manifest.scale.scan_items}`,
  );
  console.log(
    `  码制分布：UDI ${manifest.code_forms['UDI'] ?? 0} / GS1 ${manifest.code_forms['GS1'] ?? 0} / 院内码 ${manifest.code_forms['INTERNAL'] ?? 0}`,
  );
  console.log(
    `  异常条目：未建档 ${manifest.anomalies['unregistered'] ?? 0} / 跨台次重复 ${manifest.anomalies['cross_op_dup'] ?? 0} / 已关台 ${manifest.anomalies['operation_closed'] ?? 0}`,
  );
  console.log(`  费用类别口径：院内 ${manifest.fee_category_catalog.total} 类，耗材可落 ${manifest.fee_category_catalog.consumable_allowed.join(' / ')}`);
  const failed = manifest.sources.filter((source) => source.status === 'failed');
  if (failed.length > 0) {
    console.log(`  断网回落：${failed.length} 个公开来源未取到（${failed.map((s) => s.id).join('、')}），已回落合成层`);
  }
}

main();
