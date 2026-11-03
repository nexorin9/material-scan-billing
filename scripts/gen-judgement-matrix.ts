/**
 * 判定矩阵文档生成器 —— 把 `tests/boundary/boundary-cases.csv` 渲染成 `docs/api/judgement-matrix.md`。
 *
 * 落盘位置：`docs/api/`（与其他脚本生成的接口文档同列：state-matrix.md 等）。
 * `docs/architecture.md` 是**手写的架构文档**，它引用本文件的全表，但两者不会互相覆盖。
 *
 * 为什么要有这份文档：五种绑定结论（BOUND / NOT_REGISTERED / CROSS_OP_DUP / CLOSED /
 * CHARGE_REJECTED）是本产品**判定语义的核心**，护士长与信息科要能逐行核对
 * 「这个维度组合为什么落这个结论、要不要转人工」，而不是只看到一句「处理失败」。
 *
 * 文档**从 fixture 生成**，不手写 —— 手写一份矩阵 inevitably 会与代码走偏；
 * 生成一份则永远与属性测试断言的是同一份期望表。
 *
 * 跑法：npm run docs:judgement
 * 产物是确定的（无随机数），重复执行逐字节一致。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../src/ledger/import-master-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const boundaryDir = resolve(projectRoot, 'tests', 'boundary');
const docPath = resolve(projectRoot, 'docs', 'api', 'judgement-matrix.md');

interface CaseRow {
  case_id: string;
  template_id: string;
  code_form: string;
  operation_state: string;
  ownership: string;
  material_state: string;
  charge_outcome: string;
  quantity: string;
  raw_code: string;
  material_code: string;
  operation_no: string;
  expected_conclusion: string;
  expected_reason_code: string;
  expected_needs_manual: string;
}

/** 维度取值的中文说明（给人看的） */
const DIMENSION_LABELS: Record<string, string> = {
  code_form: '码制形态',
  operation_state: '台次状态',
  ownership: '耗材归属',
  material_state: '主数据状态',
  charge_outcome: '计费结果',
  quantity: '数量',
};

const VALUE_LABELS: Record<string, string> = {
  // 码制
  internal: '院内码',
  internal_dotted: '院内码（点号分隔）',
  internal_underscore: '院内码（下划线分隔）',
  gtin_bare: '裸 GTIN-14',
  udi: 'UDI（只有器械标识）',
  udi_batch: 'UDI（含生产标识批号）',
  gs1_ai01: 'GS1 AI(01) 包装码',
  udi_bad_check: 'UDI（校验位错）',
  gtin_bad_check: '裸 GTIN-14（校验位错）',
  empty: '空码',
  too_long: '超长码',
  illegal_charset: '非法字符集',
  form_unrecognized: '形态识别不出',
  // 台次状态
  open: '开台',
  closed: '已关台',
  unknown: '排台里查不到',
  // 归属
  first: '首次扫到',
  duplicate_other_op: '已绑在别的台次',
  batch_diff: '同台次同码但批号不同',
  // 主数据状态
  registered: '在册且口径齐',
  unregistered: '主数据查不到',
  inactive: '已停用',
  ratio_missing: '缺换算系数',
  fee_invalid: '费用口径不合规',
  // 计费结果
  none: '计费通道无业务拒绝',
  business_rejected: '计费通道业务拒绝',
};

/** 结论的中文说明 */
const CONCLUSION_LABELS: Record<string, string> = {
  BOUND: '绑上本台次',
  NOT_REGISTERED: '绑不上（耗材码 / 台次 / 口径问题）',
  CROSS_OP_DUP: '同一耗材已绑在别的台次（后到者拒）',
  CLOSED: '台次已关台（走人工计费补录）',
  CHARGE_REJECTED: '绑定成立但计费通道业务拒绝',
};

function label(dimension: string, value: string): string {
  const text = VALUE_LABELS[value] ?? value;
  return `${text}（\`${value}\`）`;
}

function main(): void {
  const parsed = parseCsv(readFileSync(resolve(boundaryDir, 'boundary-cases.csv'), 'utf8'));
  const cases = parsed.rows as unknown as CaseRow[];

  const byConclusion = new Map<string, number>();
  const byReason = new Map<string, number>();
  const byDimension = new Map<string, Map<string, number>>();
  for (const row of cases) {
    byConclusion.set(row.expected_conclusion, (byConclusion.get(row.expected_conclusion) ?? 0) + 1);
    const reason = row.expected_reason_code || '—（绑上，无原因码）';
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    for (const dimension of Object.keys(DIMENSION_LABELS)) {
      const value = (row as unknown as Record<string, string>)[dimension] ?? '';
      const bucket = byDimension.get(dimension) ?? new Map<string, number>();
      bucket.set(value, (bucket.get(value) ?? 0) + 1);
      byDimension.set(dimension, bucket);
    }
  }

  const lines: string[] = [];
  lines.push('# 判定矩阵（边界矩阵用例逐条对照）');
  lines.push('');
  lines.push(
    '> 一条扫码进来，判定引擎给出**唯一**一条结论：BOUND（绑上本台次）/ NOT_REGISTERED（绑不上）/ ' +
      'CROSS_OP_DUP（跨台次重复）/ CLOSED（台次已关台）/ CHARGE_REJECTED（计费通道业务拒绝）。' +
      `本表把 ${cases.length} 条维度组合逐行列出来，供科室与信息科逐行核对「为什么落这个结论、要不要转人工」。`,
  );
  lines.push('');
  lines.push('## 这份文档是什么');
  lines.push('');
  lines.push(
    '五种结论是本产品**判定语义的核心**。护士长关台核对时看到的是结论，信息科排障时看到的是原因码与错误码；' +
      '两者必须能对上，所以这份矩阵表**从 fixture 生成**（`npm run docs:judgement`），' +
      '而 fixture 又是属性测试（`node --test dist/tests/boundary-matrix.test.js`）逐条断言的期望表 —— ' +
      '**文档、测试、产品代码三者对同一份期望，不会各说各话**。',
  );
  lines.push('');
  lines.push(
    '矩阵里的用例**不是**院内真实数据，是脚本生成的边界样例（码制 × 台次状态 × 归属 × 主数据 × 计费 × 数量）；' +
      '真实院内数据由主数据导入器进镜像表，判定口径与本表一致。',
  );
  lines.push('');
  lines.push('## 判定顺序（逐层短路）');
  lines.push('');
  lines.push('一条输入**只落一种结论**，按下面顺序逐层短路，先命中先返回：');
  lines.push('');
  lines.push('| 序 | 判定层 | 不通过时的结论 | 不通过时的原因码 |');
  lines.push('|---|---|---|---|');
  lines.push('| ① | 排台台次查得到吗 | `NOT_REGISTERED` | `OPERATION_NOT_FOUND` |');
  lines.push('| ② | 台次已关台了吗 | `CLOSED` | `OPERATION_CLOSED` |');
  lines.push('| ③ | 耗材码结构 / 码制层过了吗 | `NOT_REGISTERED` | `CODE_EMPTY` / `CODE_TOO_LONG` / `CODE_ILLEGAL_CHARSET` / `CODE_FORM_UNRECOGNIZED` / `CODE_GTIN_CHECK_DIGIT_INVALID` |');
  lines.push('| ④ | 主数据查得到这一行吗 | `NOT_REGISTERED` | `MATERIAL_NOT_REGISTERED` |');
  lines.push('| ⑤ | 耗材启用吗 | `NOT_REGISTERED` | `MATERIAL_INACTIVE` |');
  lines.push('| ⑥ | 费用类别 / 医保分类口径合规吗 | `NOT_REGISTERED` | `FEE_CATEGORY_NOT_ALLOWED` / `INSURANCE_CLASS_INVALID` / `FEE_CATEGORY_INSURANCE_MISMATCH` / `FEE_CATEGORY_NOT_CONSUMABLE` |');
  lines.push('| ⑦ | 单位口径自洽吗 | `NOT_REGISTERED` | `UNIT_UNIT_MISSING` / `UNIT_RATIO_MISSING` / `UNIT_RATIO_INVALID` / `UNIT_MAPPING_INCONSISTENT` |');
  lines.push('| ⑧ | 数量按包装换算成计价单位是整数吗 | `NOT_REGISTERED` | `QUANTITY_NOT_DIVISIBLE` / `UNIT_QUANTITY_NOT_POSITIVE` |');
  lines.push('| ⑨ | 同一耗材已绑在**别的**台次吗 | `CROSS_OP_DUP` | `CROSS_OP_DUPLICATE_MATERIAL` |');
  lines.push('| ⑩ | 计费通道给了业务拒绝吗 | `CHARGE_REJECTED` | 对端码（如 `PRICE_CODE_NOT_FOUND`） |');
  lines.push('| ⑪ | 其余 | `BOUND` | — |');
  lines.push('');
  lines.push(
    '**绝不猜绑**：只要存在歧义（台次缺失 / 主数据缺失 / 耗材停用 / 口径不合规 / 归属冲突 / 数量换不出来 / ' +
      '计费被拒），结果一定落在异常结论上，**绝不**落到 `BOUND`；异常条目一律升成带台次上下文的核查条目交人工，' +
      '不自动补录、不自动冲正。',
  );
  lines.push('');
  lines.push(
    '**批号维度的位置**：`同台次同码但批号不同`在**结论层**仍是 `BOUND` —— 批号属于幂等档位（`v1` 判重复、' +
      '`v2` 各算一次），由结算层处理，不改变绑定结论本身。',
  );
  lines.push('');
  lines.push('## 维度取值与覆盖');
  lines.push('');
  lines.push('| 维度 | 取值（括号内为 fixture 里的原始取值） | 用例条数 |');
  lines.push('|---|---|---|');
  for (const [dimension, bucket] of byDimension) {
    const values = [...bucket.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => `${label(dimension, value)} · ${count}`)
      .join('<br>');
    lines.push(`| ${DIMENSION_LABELS[dimension]} | ${values} | ${[...bucket.values()].reduce((a, b) => a + b, 0)} |`);
  }
  lines.push('');
  lines.push('## 结论分布');
  lines.push('');
  lines.push('| 结论 | 中文说明 | 用例条数 |');
  lines.push('|---|---|---|');
  for (const [conclusion, count] of [...byConclusion.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${conclusion}\` | ${CONCLUSION_LABELS[conclusion] ?? ''} | ${count} |`);
  }
  lines.push('');
  lines.push('## 原因码分布');
  lines.push('');
  lines.push('| 原因码 | 用例条数 |');
  lines.push('|---|---|');
  for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${reason}\` | ${count} |`);
  }
  lines.push('');
  lines.push(
    `原因码与统一错误码（\`ERR_*\`）的映射见 [\`docs/api/errors.md\`](api/errors.md) —— ` +
      '同一个问题在**判定结果 / 核查条目 / 结构化日志 / 计费回执行**里显示的是**同一个码**。',
  );
  lines.push('');
  lines.push('## 判定矩阵总表');
  lines.push('');
  lines.push(
    `下表 **${cases.length} 行**，与边界矩阵用例**一一对应**（每行一条用例，含预期结论、原因码、是否需人工）。` +
      '「需人工」= 异常条目会升成带台次上下文的核查条目，等护士长 / 耗材管理岗落定结论。',
  );
  lines.push('');
  lines.push(
    '| 用例 | 模板 | 码制 | 台次状态 | 主数据状态 | 归属 | 计费结果 | 数量 | 预期结论 | 原因码 | 需人工 |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of cases) {
    lines.push(
      `| \`${row.case_id}\` | ${row.template_id} | ${label('code_form', row.code_form)} | ` +
        `${label('operation_state', row.operation_state)} | ${label('material_state', row.material_state)} | ` +
        `${label('ownership', row.ownership)} | ${label('charge_outcome', row.charge_outcome)} | ${row.quantity} | ` +
        `\`${row.expected_conclusion}\` | ${row.expected_reason_code ? `\`${row.expected_reason_code}\`` : '—'} | ` +
        `${row.expected_needs_manual === 'true' ? '是' : '否'} |`,
    );
  }
  lines.push('');
  lines.push('## 怎么重跑这份矩阵');
  lines.push('');
  lines.push('```bash');
  lines.push('# ① 重新生成边界矩阵用例（确定性：同一份输入产出逐字节一致的三份 CSV）');
  lines.push('npm run fixtures:boundary');
  lines.push('');
  lines.push('# ② 逐条断言：结论 / 原因码 / 是否需人工 与本表的期望逐字一致');
  lines.push('node --test dist/tests/boundary-matrix.test.js');
  lines.push('');
  lines.push('# ③ 重新生成本文档（表格行数与用例条数始终一致）');
  lines.push('npm run docs:judgement');
  lines.push('```');
  lines.push('');
  lines.push(
    '用例落在 `tests/boundary/`（三份 CSV：`boundary-cases.csv` 用例、`boundary-operations.csv` 台次主数据、' +
      '`boundary-materials.csv` 耗材主数据），由 `scripts/gen-boundary-fixtures.ts` 生成；' +
      '属性测试落在 `tests/boundary-matrix.test.ts`。',
  );
  lines.push('');

  writeFileSync(docPath, lines.join('\n'), 'utf8');
  console.log(
    `判定矩阵文档已生成 → docs/api/judgement-matrix.md（${cases.length} 行用例，五种结论：` +
      `${[...byConclusion.keys()].sort().join(' / ')}）`,
  );
}

main();
