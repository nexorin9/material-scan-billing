/**
 * 公开数据拉取脚本 —— 把真实公开来源的耗材 / 器械数据拉到本地并留清单。
 *
 * 跑法：
 *   npm run data:fetch            # 联网拉取
 *   npm run data:fetch -- --offline   # 断网演练：不发请求，直接走回落路径
 *
 * 产物：
 *   data/external/raw/<source>.json     原始响应体
 *   data/external/fetch-manifest.json    来源 URL / 获取时间 / 字节数 / sha256 / 许可 / 失败原因
 *   data/external/materials.csv          归一后的耗材主数据行（列与产品导入器一致）
 *   data/external/materials-provenance.csv  逐行标明哪些字段来自公开数据、哪些是院内合成补齐
 *
 * **断网不静默**：任一来源失败都逐条写进 fetch-manifest.json（含失败原因），
 * 由上层汇总脚本决定回落合成；本脚本自身不抛错、不假装成功。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PUBLIC_SOURCES,
  fetchPublicSources,
  failedOutcomes,
  okOutcomes,
  type PublicFetchOutcome,
} from '../src/data/fetch-public.js';
import {
  normalizeClassificationRecords,
  normalizeFhirDeviceIdentifiers,
  normalizeUdiRecords,
  provenanceToCsv,
  materialsToCsv,
  type PublicMaterialRow,
  type PublicProvenanceRow,
} from '../src/data/normalize-public.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const externalDir = resolve(projectRoot, 'data', 'external');
const rawDir = resolve(externalDir, 'raw');

/** 简单参数解析：--offline / --limit N */
function parseArgs(argv: readonly string[]): { offline: boolean; limit: number } {
  let offline = false;
  let limit = 200;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offline') offline = true;
    else if (arg === '--limit') {
      const next = argv[i + 1];
      const parsed = Number.parseInt(next ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
      i += 1;
    }
  }
  return { offline, limit };
}

function readJsonRecords(body: string): unknown[] {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results)) {
      return (parsed as { results: unknown[] }).results;
    }
    return [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const { offline, limit } = parseArgs(process.argv.slice(2));
  mkdirSync(rawDir, { recursive: true });

  let outcomes: PublicFetchOutcome[];

  if (offline) {
    // 断网演练：不发任何请求，逐条记失败原因（与真实不可达同一条回落路径）
    outcomes = PUBLIC_SOURCES.map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      status: 'failed' as const,
      http_status: null,
      bytes: 0,
      sha256: '',
      fetched_at: new Date().toISOString(),
      license: source.license,
      license_url: source.license_url,
      usage: source.usage,
      error: '断网演练（--offline）：未发起请求',
      body: null,
      records: 0,
    }));
  } else {
    const sources = PUBLIC_SOURCES.map((source) => ({
      ...source,
      url: source.url.replace(/limit=\d+/, `limit=${limit}`),
    }));
    outcomes = await fetchPublicSources({ sources, timeoutMs: 30_000 });
  }

  // 原始响应体落盘（保留证据，可复核 sha256）
  for (const outcome of okOutcomes(outcomes)) {
    writeFileSync(resolve(rawDir, `${outcome.id}.json`), outcome.body ?? '', 'utf8');
  }

  // 归一：公开 UDI / 分类记录 → 耗材主数据行
  const materials: PublicMaterialRow[] = [];
  const provenance: PublicProvenanceRow[] = [];
  const fhirIdentifiers: Array<{ system: string; value: string }> = [];

  for (const outcome of okOutcomes(outcomes)) {
    const body = outcome.body ?? '';
    if (outcome.id === 'openfda-udi') {
      const normalized = normalizeUdiRecords(readJsonRecords(body) as never[]);
      materials.push(...normalized.materials);
      provenance.push(...normalized.provenance);
    } else if (outcome.id === 'openfda-classification') {
      const normalized = normalizeClassificationRecords(readJsonRecords(body) as never[]);
      materials.push(...normalized.materials);
      provenance.push(...normalized.provenance);
    } else if (outcome.id === 'hl7-fhir-device-example') {
      fhirIdentifiers.push(...normalizeFhirDeviceIdentifiers(body));
    }
  }

  writeFileSync(resolve(externalDir, 'materials.csv'), materialsToCsv(materials), 'utf8');
  writeFileSync(resolve(externalDir, 'materials-provenance.csv'), provenanceToCsv(provenance), 'utf8');
  writeFileSync(
    resolve(externalDir, 'fhir-device-identifiers.csv'),
    ['system,value', ...fhirIdentifiers.map((i) => `${i.system},${i.value}`)].join('\n') + '\n',
    'utf8',
  );

  // 获取清单：来源、状态、许可、sha256、失败原因（不含数据内容本身）
  const fetchManifest = {
    schema_version: 1,
    fetched_at: new Date().toISOString(),
    offline_drills: offline,
    sources: outcomes.map((outcome) => ({
      id: outcome.id,
      title: outcome.title,
      url: outcome.url,
      status: outcome.status,
      http_status: outcome.http_status,
      bytes: outcome.bytes,
      sha256: outcome.sha256,
      license: outcome.license,
      license_url: outcome.license_url,
      usage: outcome.usage,
      records: outcome.records,
      error: outcome.error,
      raw_file: outcome.status === 'ok' ? `data/external/raw/${outcome.id}.json` : null,
    })),
    normalized: {
      material_rows: materials.length,
      provenance_rows: provenance.length,
      fhir_identifier_rows: fhirIdentifiers.length,
    },
  };
  writeFileSync(
    resolve(externalDir, 'fetch-manifest.json'),
    JSON.stringify(fetchManifest, null, 2) + '\n',
    'utf8',
  );

  console.log('公开数据拉取完成');
  for (const outcome of outcomes) {
    const mark = outcome.status === 'ok' ? '成功' : '失败';
    console.log(
      `  [${mark}] ${outcome.id}：记录 ${outcome.records} 条 / 字节 ${outcome.bytes}` +
        (outcome.status === 'ok' ? '' : ` / 原因：${outcome.error}`),
    );
  }
  console.log(`  归一后耗材主数据 ${materials.length} 行 → data/external/materials.csv`);
  if (failedOutcomes(outcomes).length > 0) {
    console.log('  提示：公开来源未全部取到，汇总清单会把 data_source 标为 synthetic 或 mixed（不静默切换）');
  }
}

main().catch((error: unknown) => {
  console.error(`公开数据拉取失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
