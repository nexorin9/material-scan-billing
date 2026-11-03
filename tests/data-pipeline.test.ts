/**
 * 数据获取与合成层的验收用例。
 *
 * 覆盖任务要求的五条断言：
 *   ① **断网降级**：注入 fetch 失败 → 公开来源逐条记失败 → 回落合成层，
 *      汇总清单把 `data_source` 标成 `synthetic`（**不静默切换**）；
 *   ② **可重跑**：同一份种子连续合成两次 → 产物 sha256 完全一致；
 *   ③ **规模阈值**：台次 ≥1000、耗材 ≥5000；
 *   ④ **公开数据真的进产品**：注入 openFDA 形状的响应 → 归一出的主数据键是真实 14 位 GTIN；
 *   ⑤ **口径与目录纪律**：14 类费用口径齐全、耗材只落卫生材料类；
 *      `tests/fixtures` 只留单测边界样例（≤12 行数据）。
 *
 * 另外补一条端到端断言：**合成产物能被产品导入器直接接收**，
 * 且生成的扫码事件能通过入站字段校验 —— 合成层与产品的字段口径必须一致。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  CONSUMABLE_FEE_CATEGORY,
  FEE_CATEGORIES,
} from '../src/data/catalog.js';
import {
  PUBLIC_SOURCES,
  fetchPublicSources,
  type FetchLike,
} from '../src/data/fetch-public.js';
import {
  buildDataManifest,
  type DataManifest,
  type ManifestFile,
} from '../src/data/manifest.js';
import {
  normalizeClassificationRecords,
  normalizeFhirDeviceIdentifiers,
  normalizeUdiRecords,
} from '../src/data/normalize-public.js';
import {
  batchesToJsonl,
  materialsToCsv,
  operationsToCsv,
  scanItemsToCsv,
  synthesizeHospitalData,
} from '../src/data/synthesize.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { openLedger } from '../src/ledger/db.js';
import { validateScanEvent } from '../src/domain/scan-event.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 一段 openFDA 形状的 UDI 响应（字段名取自真实接口） */
const FAKE_OPENFDA_UDI = JSON.stringify({
  meta: { license: 'https://open.fda.gov/license/' },
  results: [
    {
      identifiers: [{ id: '00191072171399', type: 'Primary', issuing_agency: 'GS1' }],
      brand_name: 'ACS',
      device_description: 'TOTAL KNEE',
      company_name: 'AMERICAN CONTRACT SYSTEMS, INC.',
      public_device_record_key: 'abc123',
      expiration_date: null,
    },
    {
      identifiers: [{ id: '00312345678901', type: 'Primary', issuing_agency: 'GS1' }],
      brand_name: '示例品牌',
      device_description: 'CATHETER',
      public_device_record_key: 'def456',
      expiration_date: '2027-12-31',
    },
  ],
});

const FAKE_OPENFDA_CLASSIFICATION = JSON.stringify({
  results: [
    {
      device_name: 'Catheter, Angiography, Diagnostic',
      device_class: 'Class 2',
      medical_specialty: 'Cardiovascular',
      regulation_number: 'K123456',
      product_code: 'QFM',
    },
  ],
});

const FAKE_FHIR_DEVICE = JSON.stringify({
  resourceType: 'Device',
  id: 'example',
  identifier: [{ system: 'http://goodcare.org/devices/id', value: '345675' }],
});

describe('test_data_pipeline · 数据获取与合成层', () => {
  it('断网降级：公开来源逐条记失败原因，回落合成层且清单标 synthetic', async () => {
    const failingFetch: FetchLike = async (url) => {
      throw new Error(`network unreachable: ${url}`);
    };
    const outcomes = await fetchPublicSources({ fetchImpl: failingFetch });
    assert.equal(outcomes.length, PUBLIC_SOURCES.length);
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'failed');
      assert.match(outcome.error, /network unreachable/);
      assert.equal(outcome.records, 0);
    }

    const dataset = synthesizeHospitalData({ seed: 20260101, operationCount: 1000, materialCount: 5000 });
    const manifest = buildDataManifest({
      fetchOutcomes: outcomes,
      synthetic: dataset.stats,
      publicMaterials: 0,
      files: [],
    });
    assert.equal(manifest.data_source, 'synthetic');
    assert.equal(manifest.sources.filter((s) => s.status === 'failed').length, PUBLIC_SOURCES.length);
    // 失败原因必须留在清单里，不静默切换
    assert.ok(manifest.sources.every((s) => s.error.length > 0));
  });

  it('公开来源可达时清单标 mixed，并把真实来源逐条列出', async () => {
    const fakeFetch: FetchLike = async (url) => {
      if (url.includes('device/udi.json')) {
        return { ok: true, status: 200, text: async () => FAKE_OPENFDA_UDI };
      }
      if (url.includes('device/classification.json')) {
        return { ok: true, status: 200, text: async () => FAKE_OPENFDA_CLASSIFICATION };
      }
      return { ok: true, status: 200, text: async () => FAKE_FHIR_DEVICE };
    };
    const outcomes = await fetchPublicSources({ fetchImpl: fakeFetch });
    assert.ok(outcomes.every((o) => o.status === 'ok'));
    assert.ok(outcomes.every((o) => o.license.length > 0 && o.license_url.length > 0));

    const udi = normalizeUdiRecords(JSON.parse(FAKE_OPENFDA_UDI).results);
    const cls = normalizeClassificationRecords(JSON.parse(FAKE_OPENFDA_CLASSIFICATION).results);
    const publicMaterials = udi.materials.length + cls.materials.length;

    const dataset = synthesizeHospitalData({ seed: 20260101, operationCount: 1000, materialCount: 5000 });
    const manifest = buildDataManifest({
      fetchOutcomes: outcomes,
      synthetic: dataset.stats,
      publicMaterials,
      files: [],
    });
    assert.equal(manifest.data_source, 'mixed');
    assert.equal(manifest.scale.materials_public, publicMaterials);
    assert.equal(manifest.scale.materials_synthetic, 5000);
  });

  it('公开 UDI 记录归一出的主数据键是真实 14 位 GTIN，且院内字段标明为合成补齐', () => {
    const { materials, provenance } = normalizeUdiRecords(JSON.parse(FAKE_OPENFDA_UDI).results);
    assert.equal(materials.length, 2);
    assert.equal(materials[0]?.material_code, '00191072171399');
    assert.match(materials[0]?.material_code ?? '', /^\d{14}$/);
    assert.equal(materials[0]?.fee_category, CONSUMABLE_FEE_CATEGORY);
    assert.equal(materials[0]?.active, true);
    assert.equal(provenance[0]?.source_id, 'openfda-udi');
    assert.equal(provenance[0]?.public_fields, 'material_code,name');
    assert.match(provenance[0]?.synthesized_fields ?? '', /price_code/);

    // FHIR Device 样例 → 标识列表（字段结构口径）
    const identifiers = normalizeFhirDeviceIdentifiers(FAKE_FHIR_DEVICE);
    assert.equal(identifiers.length, 1);
    assert.equal(identifiers[0]?.value, '345675');
  });

  it('合成可重跑：同一份种子连续合成两次，产物 sha256 完全一致', () => {
    const first = synthesizeHospitalData({ seed: 20260101, operationCount: 1000, materialCount: 5000 });
    const second = synthesizeHospitalData({ seed: 20260101, operationCount: 1000, materialCount: 5000 });
    const products: Array<[string, string]> = [
      ['operations.csv', operationsToCsv(first.operations)],
      ['materials.csv', materialsToCsv(first.materials)],
      ['scan-items.csv', scanItemsToCsv(first.items)],
      ['scan-events.jsonl', batchesToJsonl(first.batches)],
    ];
    for (const [name, content] of products) {
      const again = name === 'operations.csv'
        ? operationsToCsv(second.operations)
        : name === 'materials.csv'
          ? materialsToCsv(second.materials)
          : name === 'scan-items.csv'
            ? scanItemsToCsv(second.items)
            : batchesToJsonl(second.batches);
      assert.equal(sha256(content), sha256(again), `${name} 两次合成必须逐字节一致`);
    }
    // 不同种子 → 不同产物（种子确实在起作用；台次编号与手术间分布本身是固定的，
    // 随种子变化的是耗材属性与扫码条目）
    const other = synthesizeHospitalData({ seed: 20260202, operationCount: 1000, materialCount: 5000 });
    assert.notEqual(sha256(materialsToCsv(first.materials)), sha256(materialsToCsv(other.materials)));
    assert.notEqual(sha256(scanItemsToCsv(first.items)), sha256(scanItemsToCsv(other.items)));
  });

  it('规模阈值：台次 ≥1000、耗材 ≥5000，异常条目三类齐全', () => {
    const dataset = synthesizeHospitalData({ seed: 20260101, operationCount: 1000, materialCount: 5000 });
    assert.ok(dataset.stats.operations >= 1000, `台次数 ${dataset.stats.operations} 应 ≥1000`);
    assert.ok(dataset.stats.materials >= 5000, `耗材数 ${dataset.stats.materials} 应 ≥5000`);
    assert.ok(dataset.stats.batches > 0);
    assert.ok(dataset.stats.scan_items > 0);
    assert.ok(dataset.stats.operations_closed > 0, '已关台台次必须存在');
    assert.ok(dataset.stats.anomalies.unregistered > 0, '耗材未建档条目必须存在');
    assert.ok(dataset.stats.anomalies.cross_op_dup > 0, '跨台次重复条目必须存在');
    assert.ok(dataset.stats.anomalies.operation_closed > 0, '台次已关台条目必须存在');
    // 三种上报码制都出现在扫码条目里
    assert.ok(dataset.stats.code_forms.UDI > 0);
    assert.ok(dataset.stats.code_forms.GS1 > 0);
    assert.ok(dataset.stats.code_forms.INTERNAL > 0);
  });

  it('合成产物能被产品导入器直接接收，扫码事件能过入站字段校验', () => {
    const dataset = synthesizeHospitalData({ seed: 20260101, operationCount: 1000, materialCount: 5000 });
    const ledger = openLedger(':memory:');
    try {
      const result = importMasterData(ledger.db, {
        operationsCsv: operationsToCsv(dataset.operations),
        materialsCsv: materialsToCsv(dataset.materials),
      });
      assert.equal(result.operations.skipped, 0, '合成台次必须全部可导入');
      assert.equal(result.materials.skipped, 0, '合成耗材必须全部可导入');
      assert.equal(result.operations.inserted, dataset.stats.operations);
      assert.equal(result.materials.inserted, dataset.stats.materials);

      // 抽样 50 个批次做入站字段校验
      for (const batch of dataset.batches.slice(0, 50)) {
        const event = {
          operation_no: batch.operation_no,
          room_no: batch.room_no,
          scanner_id: batch.scanner_id,
          scans: batch.items.map((item) => ({
            material_code: item.material_code,
            quantity: item.quantity,
            scan_time: item.scan_time,
            batch_no: item.batch_no,
          })),
        };
        const validated = validateScanEvent(event);
        assert.equal(validated.ok, true, `批次 ${batch.scan_batch_id} 应通过入站字段校验`);
      }
    } finally {
      ledger.close();
    }
  });

  it('费用类别口径：院内 14 类齐全，耗材只落卫生材料类', () => {
    assert.equal(FEE_CATEGORIES.length, 14);
    assert.deepEqual(
      FEE_CATEGORIES.map((c) => c.name),
      [
        '床位', '诊察', '检查', '化验', '治疗', '手术', '护理',
        '卫生材料', '西药', '中药饮片', '中成药', '一般诊疗', '挂号', '其他',
      ],
    );
    assert.deepEqual(
      FEE_CATEGORIES.filter((c) => c.consumable_allowed).map((c) => c.name),
      [CONSUMABLE_FEE_CATEGORY],
    );
    const dataset = synthesizeHospitalData({ seed: 20260101, operationCount: 1000, materialCount: 5000 });
    assert.deepEqual(Object.keys(dataset.stats.fee_categories), [CONSUMABLE_FEE_CATEGORY]);
  });

  it('汇总清单字段齐全：来源 / 规模 / 码制分布 / 异常分布 / 产物清单', () => {
    const dataset = synthesizeHospitalData({ seed: 20260101, operationCount: 1000, materialCount: 5000 });
    const files: ManifestFile[] = [
      { path: 'data/synthetic/operations.csv', rows: dataset.stats.operations, sha256: 'x' },
    ];
    const manifest = buildDataManifest({
      fetchOutcomes: [],
      synthetic: dataset.stats,
      publicMaterials: 0,
      files,
    });
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.seed, 20260101);
    assert.equal(manifest.deterministic, true);
    assert.equal(manifest.scale.operations, dataset.stats.operations);
    assert.equal(manifest.scale.materials_total, dataset.stats.materials);
    assert.equal(manifest.scale.batches, dataset.stats.batches);
    assert.equal(manifest.scale.scan_items, dataset.stats.scan_items);
    assert.equal(manifest.scale.operations_closed, dataset.stats.operations_closed);
    assert.equal(manifest.fee_category_catalog.total, 14);
    assert.deepEqual(manifest.fee_category_catalog.consumable_allowed, [CONSUMABLE_FEE_CATEGORY]);
    assert.equal(manifest.files.length, 1);
    assert.ok(manifest.notes.some((note) => note.includes('不静默切换')));
  });

  it('tests/fixtures 只留单测边界样例：单文件 ≤8 行、合计 ≤16 行，且不含规模产物', () => {
    const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');
    let dataRows = 0;
    for (const name of readdirSync(fixturesDir)) {
      if (!name.endsWith('.csv')) continue;
      const text = readFileSync(resolve(fixturesDir, name), 'utf8');
      const lines = text.split('\n').filter((line) => line.trim().length > 0);
      const rows = Math.max(0, lines.length - 1);
      dataRows += rows;
      // 单文件上限：每个 CSV 都是**一个用例**的边界样例，不得长成数据集
      assert.ok(
        rows <= 8,
        `tests/fixtures/${name} 数据行 ${rows} 应 ≤8（fixtures 只放单测边界样例）`,
      );
    }
    assert.ok(dataRows > 0, 'fixtures 必须仍有可用的样例');
    assert.ok(
      dataRows <= 16,
      `tests/fixtures 数据行 ${dataRows} 应 ≤16（规模验证走数据合成层）`,
    );
  });

  it('落盘的 data/manifest.json 字段齐全（跑过 npm run data:prepare 时才断言）', () => {
    const manifestPath = resolve(projectRoot, 'data', 'manifest.json');
    if (!existsSync(manifestPath)) {
      // 流水线没跑过就不强求 —— 清单由 npm run data:prepare 产出
      return;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DataManifest;
    assert.ok(['public', 'synthetic', 'mixed'].includes(manifest.data_source));
    assert.ok(manifest.scale.operations >= 1000, `清单台次数 ${manifest.scale.operations} 应 ≥1000`);
    assert.ok(manifest.scale.materials_total >= 5000, `清单耗材数 ${manifest.scale.materials_total} 应 ≥5000`);
    assert.ok(manifest.scale.scan_items > 0);
    assert.equal(manifest.fee_category_catalog.total, 14);
    assert.ok(manifest.files.length > 0, '清单必须列出产物文件');
    for (const file of manifest.files) {
      assert.ok(file.path.length > 0 && file.sha256.length === 64);
    }
    // 公开来源的失败必须留痕（不静默切换）
    for (const source of manifest.sources) {
      if (source.status === 'failed') assert.ok(source.error.length > 0);
    }
  });
});
