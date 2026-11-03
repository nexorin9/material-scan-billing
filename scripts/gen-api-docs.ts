/**
 * 文档成文器：把**字段契约表**渲染进联调文档。
 *
 * 为什么要有这个脚本：
 *   出站对接最怕「文档写的和代码发的不一样」。字段改个名、对端不认，
 *   表现是**静默丢计费条目** —— 要到月底对账才发现。
 *   手工维护两份（代码里一份契约、文档里一张表）必然会走偏：
 *   改了代码忘了改文档，联调时按文档对字段，永远对不上。
 *
 *   所以口径是：**表格由契约渲染，叙述由人写**。
 *   本脚本只替换文档里两个标记之间的内容：
 *     `<!-- contract-table:<契约 id> -->` … `<!-- /contract-table -->`
 *   标记之外的正文（说明、示例、错误码约定）仍由人维护。
 *
 * 用法：
 *   npm run docs:api              # 重新渲染两张联调文档的契约表
 *   npm run docs:api -- --check   # 只校验不写盘（文档与契约不一致时退出码非 0）
 *
 * 幂等：连续跑两次，第二次没有变化（脚本会报「无变化」）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT_TABLE_CLOSE,
  CONTRACT_TABLE_OPEN,
  findContract,
  renderContractTable,
  type Contract,
} from '../src/api/contracts.js';

const here = dirname(fileURLToPath(import.meta.url));
/** 脚本编译后在 dist/scripts/ 下，项目根是两级上 */
const projectRoot = resolve(here, '..', '..');

/** 要渲染的契约表：文档相对路径 + 契约 id */
interface DocBinding {
  /** 文档相对项目根的路径 */
  doc: string;
  /** 契约 id（`src/api/contracts.ts` 的 `ALL_CONTRACTS`） */
  contractId: string;
}

const DOC_BINDINGS: readonly DocBinding[] = [
  { doc: 'docs/api/his-charging.md', contractId: 'material-uses-request' },
  { doc: 'docs/api/his-charging.md', contractId: 'material-use' },
  { doc: 'docs/api/his-charging.md', contractId: 'material-uses-response' },
  { doc: 'docs/api/scan-event.md', contractId: 'scan-event-envelope' },
  { doc: 'docs/api/scan-event.md', contractId: 'scan-item' },
];

/** 一个文档里的渲染结果 */
interface RenderOutcome {
  doc: string;
  contractId: string;
  /** 契约里的字段数 */
  field_count: number;
  /** 渲染后文档是否与原文不同（不同 = 文档与契约走偏了） */
  changed: boolean;
}

/** 取契约；取不到直接抛（契约 id 写错时不能静默跳过） */
function requireContract(id: string): Contract {
  const contract = findContract(id);
  if (!contract) {
    throw new Error(`契约 id 不存在：${id}（检查 src/api/contracts.ts 的 ALL_CONTRACTS）`);
  }
  return contract;
}

/**
 * 把文档里某一处契约表替换成渲染结果。
 *
 * 找不到开始标记 → 抛错（文档漏了标记 = 联调文档缺表，不能装作没事）。
 * 找不到结束标记 → 抛错（标记写坏了）。
 */
function renderIntoDoc(content: string, contract: Contract): { text: string; rendered: boolean } {
  const open = CONTRACT_TABLE_OPEN(contract.id);
  const openAt = content.indexOf(open);
  if (openAt < 0) {
    throw new Error(
      `文档里找不到契约表标记 ${open}（该文档需要放一行锚点标记，供本脚本渲染）`,
    );
  }
  const bodyAt = openAt + open.length;
  const closeAt = content.indexOf(CONTRACT_TABLE_CLOSE, bodyAt);
  if (closeAt < 0) {
    throw new Error(`文档里找不到契约表结束标记 ${CONTRACT_TABLE_CLOSE}（标记写坏了）`);
  }
  const table = renderContractTable(contract);
  const next = `${content.slice(0, bodyAt)}\n${table}\n${content.slice(closeAt)}`;
  return { text: next, rendered: next !== content };
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  /** 文档相对路径 → 渲染后的全文 */
  const rendered = new Map<string, string>();
  const outcomes: RenderOutcome[] = [];

  for (const binding of DOC_BINDINGS) {
    const contract = requireContract(binding.contractId);
    const current = rendered.get(binding.doc) ?? readFileSync(resolve(projectRoot, binding.doc), 'utf8');
    const { text, rendered: changed } = renderIntoDoc(current, contract);
    rendered.set(binding.doc, text);
    outcomes.push({
      doc: binding.doc,
      contractId: contract.id,
      field_count: contract.fields.length,
      changed,
    });
  }

  /** 与契约走偏的表格数（渲染后会变 = 文档里的表不是这份契约渲染出来的） */
  let drift = 0;
  for (const outcome of outcomes) {
    if (outcome.changed) drift += 1;
  }

  for (const outcome of outcomes) {
    console.log(
      `${outcome.changed ? '需更新' : '无变化'} ${outcome.doc} · ${outcome.contractId} · ${outcome.field_count} 个字段`,
    );
  }

  if (checkOnly) {
    if (drift > 0) {
      console.error(
        `契约表与文档不一致（${drift} 处）：请运行 npm run docs:api 重新渲染后再提交`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('契约表与文档一致（无需渲染）');
    return;
  }

  for (const [doc, text] of rendered) {
    writeFileSync(resolve(projectRoot, doc), text, 'utf8');
  }
  console.log(`契约表渲染完成：${rendered.size} 份文档`);
}

main();
