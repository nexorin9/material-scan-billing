/**
 * 生成条目状态机全量迁移表文档：`docs/api/state-matrix.md`。
 *
 * 为什么要有这个脚本：迁移表是**判定真源**（src/domain/state.ts），
 * 手抄一份文档迟早对不上。这里的表格直接由实现生成，改了状态机重跑一次即可。
 *
 *   npm run docs:matrix
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_STATES,
  FULL_TRANSITION_MATRIX,
  MANUAL_REVOKE_EDGES,
  SELF_LOOP_EDGES,
  TERMINAL_STATES,
  type BindingState,
} from '../src/domain/state.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const outPath = resolve(projectRoot, 'docs', 'api', 'state-matrix.md');

const STATE_ZH: Record<BindingState, string> = {
  scanned: '已扫码',
  parsed: '已解析',
  bound: '已绑台次',
  rejected: '判定异常',
  charged: '已计费',
  confirmed: '已确认',
  check_pending: '待核查',
  closed: '已闭环',
};

const KIND_ZH: Record<string, string> = {
  advance: '放行（推进）',
  self_loop: '放行（幂等自环，不推进）',
  forbidden: '拒绝',
  manual_retract: '自动迁移拒绝；仅人工撤回入口成立',
};

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

const lines: string[] = [];

lines.push('# 条目状态机全量迁移表');
lines.push('');
lines.push('> 一条耗材条目从「扫到」到「闭环」会走过好几个状态。哪一步能走、哪一步不能走、');
lines.push('> 不走会怎样，在这里逐对写清楚 —— 评审时不必翻代码。');
lines.push('');
lines.push('> 本表由 `npm run docs:matrix` 从 `src/domain/state.ts` 生成，**不要手改**。');
lines.push('');

lines.push('## 状态含义');
lines.push('');
lines.push('| 状态 | 含义 | 说明 |');
lines.push('|------|------|------|');
for (const state of ALL_STATES) {
  const terminal = TERMINAL_STATES.includes(state) ? '（终态，自动迁移无出边）' : '';
  lines.push(`| \`${state}\` | ${STATE_ZH[state]} | ${terminal} |`);
}
lines.push('');

lines.push('## 全量迁移矩阵（8 × 8 = 64 对）');
lines.push('');
lines.push('「触发方」列写的是**谁有权**执行这条迁移；角色不符一律拒绝（`ERR_ILLEGAL_STATE_TRANSITION`）。');
lines.push('');
lines.push('| 起始状态 | 目标状态 | 判定 | 触发方 | 说明 |');
lines.push('|----------|----------|------|--------|------|');
for (const decision of FULL_TRANSITION_MATRIX) {
  const actors = decision.actors.length > 0 ? decision.actors.map((a) => `\`${a}\``).join(' / ') : '—';
  lines.push(
    `| \`${decision.from}\` | \`${decision.to}\` | ${KIND_ZH[decision.kind] ?? decision.kind} | ${actors} | ${escapeCell(decision.note)} |`,
  );
}
lines.push('');

lines.push('## 三条硬约束');
lines.push('');
lines.push('1. **终态保护** —— `closed` 在自动迁移表里没有任何出边；越界尝试一律拒绝并留拒绝痕迹。');
lines.push('2. **已计费不自动冲正** —— `charged` 不能回到 `rejected` / `parsed`；冲正属人工在 HIS 侧处理。');
lines.push('3. **幂等自环** —— `check_pending → check_pending`、`confirmed → confirmed` 放行，但**不推进状态**、不重写确认时间。');
lines.push('');

lines.push('## 人工撤回（独立入口）');
lines.push('');
lines.push('撤回是**人工纠正**，不是状态推进，因此单列一张表、单独一个断言函数，不并入自动迁移表。');
lines.push('');
lines.push('| 起始状态 | 目标状态 | 触发方 | 说明 |');
lines.push('|----------|----------|--------|------|');
for (const edge of MANUAL_REVOKE_EDGES) {
  lines.push(
    `| \`${edge.from}\` | \`${edge.to}\` | ${edge.actors.map((a) => `\`${a}\``).join(' / ')} | ${escapeCell(edge.note)} |`,
  );
}
lines.push('');

lines.push('## 幂等自环边');
lines.push('');
lines.push('| 起始状态 | 目标状态 | 触发方 | 说明 |');
lines.push('|----------|----------|--------|------|');
for (const edge of SELF_LOOP_EDGES) {
  lines.push(
    `| \`${edge.from}\` | \`${edge.to}\` | ${edge.actors.map((a) => `\`${a}\``).join(' / ')} | ${escapeCell(edge.note)} |`,
  );
}
lines.push('');

lines.push('## 迁移轨迹');
lines.push('');
lines.push('每次成功迁移在审计链（`audit_chain`）追加一行 `state_transition`；');
lines.push('每次被拒的越界迁移追加一行 `state_transition_rejected`。');
lines.push('行内含 `from` / `to` / `actor` / `request_id` / `created_at`，按条目可原样回放状态序列。');
lines.push('');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');

console.log(`已生成 ${outPath}（${FULL_TRANSITION_MATRIX.length} 对）`);
