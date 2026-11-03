/**
 * 运维 CLI 入口：`node dist/cli.js <子命令> [选项]`。
 *
 * 五个子命令（doctor / replay / ledger / pack / summary）见 `src/cli/commands.ts`。
 *
 * 硬约束：
 *   ① **凭据明文一律不出现在输出里** —— doctor 只报「齐否 + 缺哪个变量名 + 脱敏端点」；
 *   ② **默认不连接任何外部系统** —— 只有 replay --charge 才会打 HIS 计费，
 *      且必须有出站凭据位；其余子命令只读本地台账；
 *   ③ **导出的核查包不含患者标识字段** —— 字段来自固定白名单。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { openLedger } from '../ledger/db.js';
import { importMasterDataVersioned } from '../ledger/import-master-data.js';
import { readSettings, requireChannel, MissingCredentialError } from '../config/env.js';
import { HisChargingClient } from '../charge/client.js';
import { decodeWithFallback } from '../charge/sanitize.js';
import {
  formatChainConclusion,
  packToCsv,
  reconcileRowToCells,
  renderDoctorText,
  renderReplayDiffText,
  runAttemptQuery,
  runDoctor,
  runDoctorWithProbes,
  runEventTrace,
  renderEventTraceText,
  runLedgerQuery,
  runPack,
  runReconcile,
  runReplayWithDiff,
  runSummary,
  writeReplayDiff,
  type LedgerRowView,
  type PackExport,
  type PackRow,
} from './commands.js';
import {
  createCheckTaskFromDiff,
  diffsToCsv,
  RECONCILE_ATTRIBUTION_GUIDE,
  RECONCILE_DIFF_TYPE_LABELS,
  RECONCILE_EXPORT_FIELDS,
} from '../ledger/reconcile.js';
import {
  attemptHistoryToCsv,
  attemptHistoryToJson,
  ATTEMPT_DISPOSITION_LABELS,
  ATTEMPT_HISTORY_EXPORT_FIELDS,
  CHARGE_RECEIPT_KIND_LABELS,
  renderAttemptTimeline,
} from '../charge/attempt-history.js';
import {
  buildClosingChecklist,
  closingChecklistToCsv,
  closingChecklistToJson,
  ClosingReportError,
  renderClosingChecklist,
} from '../check/closing-report.js';
import {
  COMMAND_SPECS,
  EXIT_CODES,
  parseArgs,
  renderCommandHelp,
  renderGlobalHelp,
  validateArgs,
} from './args.js';
import { printError, printJson, printNote, printText, registerEnvSecrets, jsonDocument } from './output.js';

/**
 * 参数解析、退出码约定与子命令说明的真源在 `./args.js`。
 *
 * 这里原样再导出 —— 既有引用（`parseArgs` / `CLI_HELP`）路径不变。
 */
export {
  BOOLEAN_FLAGS,
  CLI_HELP,
  COMMAND_NAMES,
  COMMAND_SPECS,
  EXIT_CODES,
  EXIT_CODE_MEANINGS,
  parseArgs,
  renderCommandHelp,
  renderGlobalHelp,
  validateArgs,
  type CommandSpec,
  type OptionSpec,
  type ParsedArgs,
} from './args.js';

/** 把值转成正整数；不合法返回 null */
function intOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 渲染一张对齐的文本表 */
export function renderTable(headers: readonly string[], rows: readonly (string | number)[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => String(row[column] ?? '').length)),
  );
  const line = (cells: readonly (string | number)[]): string =>
    cells
      .map((cell, column) => String(cell ?? '').padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

/** 台账行 → 表格行 */
function ledgerRowToCells(row: LedgerRowView): (string | number)[] {
  return [
    row.operation_no,
    row.room_no,
    row.material_code,
    row.quantity,
    row.conclusion,
    row.status,
    row.charge_state,
    row.created_at,
  ];
}

/** 核查包行 → 表格行 */
function packRowToCells(row: PackRow): (string | number)[] {
  return [
    row.check_task_id,
    row.operation_no,
    row.material_code,
    row.conclusion,
    row.reason_code,
    row.check_status,
    row.charge_state,
    row.confirmed_by || '—',
  ].map((value) => (value === null ? '' : value));
}

/** 写文件（自动建目录） */
function writeOut(filePath: string, content: string): void {
  const target = resolve(filePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

/**
 * 审计链校验结论的一行中文摘要。
 *
 * 完整的时候说「覆盖多少行、什么时候校验的」；
 * 断链的时候直接给断点行号 —— 信息科照着这一行就能去查那一行。
 *
 * 实现已挪到 `commands.ts`（doctor 的渲染与核查包导出共用），这里原样再导出，
 * 引用路径不变。
 */
export { formatChainConclusion };

/**
 * 帮助文案（全局用法 + 每个子命令的完整参数）。
 *
 * 真源在 `./args.js`（子命令声明只写一份，帮助与参数校验都从那里来）。
 */

/** 主流程；返回进程退出码 */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  // 凭据登记在打码名单里 —— 后面所有输出（正文 / JSON / 错误）都过一遍脱敏
  registerEnvSecrets(process.env);

  // 全局用法（不带子命令 / `help`）
  if (args.command === '' || args.command === 'help') {
    printText(renderGlobalHelp());
    return EXIT_CODES.OK;
  }

  const spec = COMMAND_SPECS[args.command];
  if (!spec) {
    printError(`未知子命令：${args.command}`);
    printError('');
    printError(renderGlobalHelp());
    return EXIT_CODES.USAGE;
  }

  // 子命令用法（`<子命令> --help`）：用途 / 参数 / 默认值 / 示例四要素齐全
  if (args.flags.has('help')) {
    printText(renderCommandHelp(spec));
    return EXIT_CODES.OK;
  }

  // 参数合法性：先说清哪里不对，再把该子命令的用法贴出来（退出码 2）
  const problems = validateArgs(args, spec);
  if (problems.length > 0) {
    printError('参数有误：');
    for (const problem of problems) printError(`  - ${problem}`);
    printError('');
    printError(renderCommandHelp(spec));
    return EXIT_CODES.USAGE;
  }

  const env = process.env;
  const settings = readSettings(env);
  const dbPath = args.options['db'] ?? settings.ledgerDbPath;
  const asJson = args.flags.has('json');

  // 主数据导入是「建库」的那一步 —— 台账库还不存在时照样能导（开库即迁移）。
  if (args.command !== 'import-master' && !existsSync(resolve(dbPath))) {
    printError(`台账库不存在：${dbPath}`);
    printError('先用主数据导入生成台账库，或用 --db 指定路径');
    return EXIT_CODES.VALIDATION;
  }

  const ledger = openLedger(dbPath);

  try {
    switch (args.command) {
      case 'doctor': {
        const report = await runDoctorWithProbes(ledger.db, env, {
          ledger_db_path: dbPath,
          probe: args.flags.has('probe'),
          probeTimeoutMs: intOption(args.options['probe-timeout']),
        });
        if (asJson) {
          // 机器可读模式：stdout 上只有这一份 JSON（监控直接接这份输出）
          printJson(report);
          return EXIT_CODES.OK;
        }
        printText(renderDoctorText(report));
        return EXIT_CODES.OK;
      }

      case 'replay': {
        let chargeClient: HisChargingClient | null = null;
        let chargePath: string | undefined;
        if (args.flags.has('charge')) {
          try {
            const outbound = requireChannel('outbound', env);
            if (outbound.channel === 'outbound') {
              chargeClient = new HisChargingClient({
                baseUrl: outbound.baseUrl,
                token: outbound.token,
                timeoutMs: settings.chargeTimeoutMs,
                connectTimeoutMs: settings.chargeConnectTimeoutMs,
                maxResponseTimeoutMs: settings.chargeMaxResponseTimeoutMs,
                circuitFailureThreshold: settings.chargeCircuitFailureThreshold,
                circuitCooldownMs: settings.chargeCircuitCooldownMs,
                keepAliveMsecs: settings.chargeKeepAliveMs,
                maxSockets: settings.chargeMaxSockets,
              });
              chargePath = settings.chargeMaterialUsesPath;
            }
          } catch (error) {
            if (error instanceof MissingCredentialError) {
              // 外部通道不可达：命令要求的外部动作做不成 → 退出码 4，且**不动台账**
              printError(`出站计费通道不可用：${error.message}`);
              printError('未做任何重放（先修好出站凭据位，或去掉 --charge 只重放不回写计费）');
              return EXIT_CODES.CHANNEL;
            }
            throw error;
          }
        }
        const report = await runReplayWithDiff(ledger.db, {
          limit: intOption(args.options['limit']),
          operation_no: args.options['operation'] ?? null,
          source: args.options['source'] ?? null,
          batch_id: args.options['batch'] ?? null,
          from: args.options['from'] ?? null,
          to: args.options['to'] ?? null,
          eventsFile: args.options['file'] ?? null,
          charge: args.flags.has('charge'),
          chargeClient,
          chargePath,
          chargeMaxBatchSize: settings.chargeMaxBatchSize,
          chargeKeyProfile: settings.idempotencyKeyProfile,
          // 默认**验**不变式（连做第二遍重放并比对增量）；--no-verify 才跳过
          verify: !args.flags.has('no-verify'),
        });
        const diffPath = writeReplayDiff(report, args.options['diff-out'] ?? null);
        if (asJson) {
          // 机器可读模式：stdout 上只有这一份 JSON；差异表路径走 stderr
          printJson({ ...report, diff_path: diffPath });
          if (report.invariant && !report.invariant.held) {
            printError('幂等不变式不成立：重放产生了额外的台账行或计费调用，需要排查幂等层');
            return EXIT_CODES.VALIDATION;
          }
          return EXIT_CODES.OK;
        }
        printText('== 事件重放 ==');
        for (const batch of report.batches) {
          const reasons = batch.reason_codes
            .map((item) => `${item.reason_code}×${item.count}`)
            .join(' ');
          printText(
            `  ${batch.request_id} ${batch.source} 台次=${batch.operation_no} 条目=${batch.total} 绑定=${batch.accepted} 异常=${batch.rejected} 新增台账行=${batch.new_rows} ${reasons}`,
          );
        }
        printText(`  重放事件数：${report.replayed_events}（区间命中 ${report.matched_events} 条）`);
        printText(renderReplayDiffText(report));
        printText(`  差异表已落盘：${diffPath}`);
        if (report.invariant && !report.invariant.held) {
          // 不变式不成立是**要人看**的事：退出码非 0，监控能接住
          printError('  幂等不变式不成立：重放产生了额外的台账行或计费调用，需要排查幂等层');
          return EXIT_CODES.VALIDATION;
        }
        return EXIT_CODES.OK;
      }

      case 'ledger': {
        const result = runLedgerQuery(ledger.db, {
          operation_no: args.options['operation'] ?? null,
          status: args.options['status'] ?? null,
          material_code: args.options['material'] ?? null,
          limit: intOption(args.options['limit']),
        });
        const format = asJson ? 'json' : (args.options['format'] ?? 'table');
        if (format === 'json') {
          const content = jsonDocument(result);
          if (args.options['out']) {
            writeOut(args.options['out'], content);
            printNote(`已导出 ${result.rows.length} 行到 ${args.options['out']}`);
          }
          // stdout 上只有这一份 JSON —— 脚本 `JSON.parse(stdout)` 直接可用
          printText(content);
          return EXIT_CODES.OK;
        }
        if (format === 'csv') {
          const headers = [
            'operation_no',
            'room_no',
            'dept_code',
            'material_code',
            'quantity',
            'price_code',
            'fee_category',
            'medical_insurance_class',
            'conclusion',
            'status',
            'check_task_id',
            'charge_state',
            'created_at',
          ];
          const escape = (value: unknown): string => {
            const text = value === null || value === undefined ? '' : String(value);
            return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          };
          const content = [
            headers.join(','),
            ...result.rows.map((row) =>
              headers.map((header) => escape((row as unknown as Record<string, unknown>)[header])).join(','),
            ),
          ].join('\n');
          if (args.options['out']) {
            writeOut(args.options['out'], content);
            printText(`已导出 ${result.rows.length} 行到 ${args.options['out']}`);
          } else {
            printText(content);
          }
          return EXIT_CODES.OK;
        }
        printText(
          renderTable(
            ['台次', '手术间', '耗材码', '数量', '结论', '条目状态', '计费状态', '落账时间'],
            result.rows.map(ledgerRowToCells),
          ),
        );
        printText(`\n共 ${result.rows.length} 行（命中 ${result.total} 行）`);
        return EXIT_CODES.OK;
      }

      case 'pack': {
        const pack: PackExport = runPack(ledger.db, {
          operation_no: args.options['operation'] ?? null,
          status: args.options['status'] ?? null,
          limit: intOption(args.options['limit']),
        });
        const format = asJson ? 'json' : (args.options['format'] ?? 'csv');
        if (format === 'json') {
          const content = jsonDocument(pack);
          if (args.options['out']) {
            writeOut(args.options['out'], content);
            printNote(`已导出 ${pack.rows.length} 条核查条目到 ${args.options['out']}`);
          }
          printText(content);
          return EXIT_CODES.OK;
        }
        const content = packToCsv(pack);
        if (args.options['out']) {
          writeOut(args.options['out'], content);
          printText(`已导出 ${pack.rows.length} 条核查条目到 ${args.options['out']}`);
        } else {
          printText(content);
        }
        // 核查包附带的审计链校验结论：内审 / 飞检要连「这份台账没被动过」一起交
        printText(formatChainConclusion(pack.audit_chain));
        return EXIT_CODES.OK;
      }

      case 'summary': {
        const report = runSummary(ledger.db, { operation_no: args.options['operation'] ?? null });
        if (asJson) {
          printJson(report);
          return EXIT_CODES.OK;
        }
        printText('== 台账与核查 ==');
        printText(`  台账行数：${report.ledger_rows}`);
        for (const row of report.by_status) {
          printText(`    状态 ${row.status.padEnd(16)} ${row.count}`);
        }
        printText('== 绑定结论分布 ==');
        for (const row of report.by_conclusion) {
          printText(`    ${row.conclusion.padEnd(20)} ${row.count}`);
        }
        printText('== 各路收到事件数 ==');
        for (const row of report.events_by_source) {
          printText(`    ${row.source.padEnd(20)} ${row.events} 批　末次 ${row.last_event_at ?? '（还没有）'}`);
        }
        printText('== 计费 ==');
        printText(
          `  投递 ${report.charge.attempts} 次 / 接收 ${report.charge.accepted} / 拒收 ${report.charge.rejected} / 通道不可达 ${report.charge.unreachable}`,
        );
        printText(`  成功率 ${(report.charge.success_rate * 100).toFixed(1)}%　重投 ${report.charge.total_retries} 次`);
        for (const row of report.charge.retry_distribution) {
          printText(`    投递 ${row.delivery_count} 次的条目：${row.count}`);
        }
        printText('== 核查与推送 ==');
        printText(`  核查条目 ${report.check.total}（待核查 ${report.check.pending} / 已闭环 ${report.check.closed}）`);
        printText(`  企微推送 成功 ${report.notify.sent} / 失败 ${report.notify.failed} / 跳过 ${report.notify.skipped}`);
        printText(`  事件 ${report.events} 条 / 审计链 ${report.audit_rows} 行（完整性：${report.audit_integrity.intact ? '通过' : '有问题'}）`);
        return EXIT_CODES.OK;
      }

      case 'events': {
        // 事件日志溯源：按投递标识回查三边（事件 → 台账 → 审计链），或按耗材码回查事件序列
        const report = runEventTrace(ledger.db, {
          request_id: args.options['request'] ?? null,
          material_code: args.options['material'] ?? null,
          operation_no: args.options['operation'] ?? null,
          source: args.options['source'] ?? null,
          limit: intOption(args.options['limit']),
        });
        if (asJson) {
          printJson(report);
          return EXIT_CODES.OK;
        }
        printText(renderEventTraceText(report));
        return EXIT_CODES.OK;
      }

      case 'reconcile': {
        const report = runReconcile(ledger.db, {
          operation_no: args.options['operation'] ?? null,
          material_code: args.options['material'] ?? null,
          status: args.options['status'] ?? null,
          limit: intOption(args.options['limit']),
          dry_run: args.flags.has('dry-run'),
        });

        if (args.flags.has('create-check')) {
          const pending = report.diffs.filter((row) => row.status === 'pending');
          let created = 0;
          let reused = 0;
          for (const row of pending) {
            const result = createCheckTaskFromDiff(ledger.db, row.id, 'reconcile_cli');
            if (result.reused) reused += 1;
            else created += 1;
          }
          printNote(`已把待处理差异转成核查任务：新建 ${created} 条，复用已有待办 ${reused} 条`);
        }

        const format = asJson ? 'json' : (args.options['format'] ?? 'table');
        if (format === 'json') {
          const content = jsonDocument({
            generated_at: report.generated_at,
            scope: report.scope,
            ledger_items: report.ledger_items,
            receipt_items: report.receipt_items,
            by_type: report.by_type,
            by_attribution: report.by_attribution,
            new_diffs: report.new_diffs,
            auto_resolved: report.auto_resolved,
            pending_total: report.pending_total,
            fields: [...RECONCILE_EXPORT_FIELDS],
            attribution_guide: RECONCILE_ATTRIBUTION_GUIDE,
            diffs: report.diffs,
          });
          if (args.options['out']) {
            writeOut(args.options['out'], content);
            printNote(`已导出 ${report.diffs.length} 条差异到 ${args.options['out']}`);
          }
          printText(content);
          return EXIT_CODES.OK;
        }
        if (format === 'csv') {
          const content = diffsToCsv(report.diffs);
          if (args.options['out']) {
            writeOut(args.options['out'], content);
            printText(`已导出 ${report.diffs.length} 条差异到 ${args.options['out']}`);
          } else {
            printText(content);
          }
          return EXIT_CODES.OK;
        }
        printText('== 台账 ↔ 计费回执对账 ==');
        printText(
          `  台账条目 ${report.ledger_items} 条 / 计费条目 ${report.receipt_items} 条 / 差异 ${report.diffs.length} 条（新增 ${report.new_diffs}，自动闭环 ${report.auto_resolved}）`,
        );
        printText(
          `  台账有计费无 ${report.by_type.MISSING_RECEIPT} / 计费有台账无 ${report.by_type.UNKNOWN_RECEIPT} / 字段口径不一致 ${report.by_type.FIELD_MISMATCH}`,
        );
        for (const [attribution, count] of Object.entries(report.by_attribution)) {
          printText(`    ${attribution.padEnd(32)} ${String(count).padStart(4)} 条`);
        }
        if (report.diffs.length > 0) {
          printText(
            renderTable(
              ['台次', '耗材码', '差异类型', '归因', '不一致字段', '状态', '核查条目'],
              report.diffs.map(reconcileRowToCells),
            ),
          );
          printText('\n  差异类型说明：');
          for (const [type, label] of Object.entries(RECONCILE_DIFF_TYPE_LABELS)) {
            printText(`    ${type.padEnd(20)} ${label}`);
          }
        }
        return EXIT_CODES.OK;
      }

      case 'attempts': {
        const result = runAttemptQuery(ledger.db, {
          operation_no: args.options['operation'] ?? null,
          material_code: args.options['material'] ?? null,
          from: args.options['from'] ?? null,
          to: args.options['to'] ?? null,
          limit: intOption(args.options['limit']),
        });
        const format = asJson ? 'json' : (args.options['format'] ?? 'table');
        if (format === 'json') {
          const content = jsonDocument({
            generated_at: new Date().toISOString(),
            fields: [...ATTEMPT_HISTORY_EXPORT_FIELDS],
            kind_labels: CHARGE_RECEIPT_KIND_LABELS,
            disposition_labels: ATTEMPT_DISPOSITION_LABELS,
            total: result.total,
            limit: result.limit,
            rows: result.rows,
            summaries: result.summaries,
          });
          if (args.options['out']) {
            writeOut(args.options['out'], content);
            printNote(`已导出 ${result.rows.length} 次尝试到 ${args.options['out']}`);
          }
          printText(content);
          return EXIT_CODES.OK;
        }
        if (format === 'csv') {
          const content = attemptHistoryToCsv(result.rows);
          if (args.options['out']) {
            writeOut(args.options['out'], content);
            printText(`已导出 ${result.rows.length} 次尝试到 ${args.options['out']}`);
          } else {
            printText(content);
          }
          return EXIT_CODES.OK;
        }
        printText('== 计费尝试史 ==');
        printText(renderAttemptTimeline(result.rows));
        printText('\n== 按条目小结 ==');
        for (const summary of result.summaries) {
          printText(
            `  ${summary.material_code.padEnd(24)} ${summary.operation_no.padEnd(16)} ${summary.conclusion_zh}`,
          );
          if (summary.error_codes.length > 0) {
            printText(`    错误码：${summary.error_codes.join(' / ')}`);
          }
        }
        printText(`\n共 ${result.rows.length} 次尝试（命中 ${result.total} 次）`);
        return EXIT_CODES.OK;
      }

      case 'closing': {
        // 关台核对清单：护士长按台次签认的那一份
        // （逐条结论 + 待核查清单 + 「能不能关台」的一行结论）
        const operations = (args.options['operations'] ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);

        let report;
        try {
          report = buildClosingChecklist(ledger.db, {
            operation_no: args.options['operation'] ?? null,
            operations,
            from: args.options['from'] ?? null,
            to: args.options['to'] ?? null,
            limit: intOption(args.options['limit']),
          });
        } catch (error) {
          if (error instanceof ClosingReportError) {
            printError(`关台核对清单导出失败：${error.message}`);
            return EXIT_CODES.VALIDATION;
          }
          throw error;
        }

        const format = asJson ? 'json' : (args.options['format'] ?? 'table');
        if (format === 'json') {
          const content = closingChecklistToJson(report);
          if (args.options['out']) {
            writeOut(args.options['out'], content);
            printNote(`已导出 ${report.operations.length} 个台次的关台核对清单到 ${args.options['out']}`);
          }
          printText(content);
          return EXIT_CODES.OK;
        }
        if (format === 'csv') {
          const content = closingChecklistToCsv(report);
          if (args.options['out']) {
            writeOut(args.options['out'], content);
            printText(`已导出 ${report.items.length} 条耗材条目到 ${args.options['out']}`);
          } else {
            printText(content);
          }
          return EXIT_CODES.OK;
        }
        printText(renderClosingChecklist(report));
        return EXIT_CODES.OK;
      }

      case 'import-master': {
        // 主数据导入（导入即生效 · 不重启常驻进程）：
        // 判定引擎每次现读镜像表，所以这里导完，正在跑的守护进程下一次扫码立刻按新值判。
        const operationsPath = (args.options['operations'] ?? '').trim();
        const materialsPath = (args.options['materials'] ?? '').trim();
        if (operationsPath.length === 0 || materialsPath.length === 0) {
          printError('用法：node dist/cli.js import-master --operations <排台台次.csv> --materials <耗材主数据.csv>');
          return EXIT_CODES.USAGE;
        }
        const readCsvOrFail = (path: string, label: string): string | null => {
          let bytes: Buffer;
          try {
            bytes = readFileSync(path);
          } catch (error) {
            printError(`${label}读不到：${path}（${error instanceof Error ? error.message : String(error)}）`);
            return null;
          }
          // 按字节读、按编码策略解：老系统导出的 GBK 文件不会被读成乱码；
          // 解不出来就报错并保留原始字节，**不做替换字符糊弄**
          const decoded = decodeWithFallback(new Uint8Array(bytes), {
            strategy: settings.masterDataEncoding,
          });
          if (!decoded.ok) {
            printError(
              `${label}编码不可解码：${path}（${decoded.message ?? ''}）—— ` +
                '原始字节已保留，可核对导出方的编码；也可设置 MASTER_DATA_ENCODING 指定 utf-8 或 gbk',
            );
            return null;
          }
          return decoded.text ?? '';
        };
        const operationsCsv = readCsvOrFail(operationsPath, '排台台次文件');
        const materialsCsv = readCsvOrFail(materialsPath, '耗材主数据文件');
        if (operationsCsv === null || materialsCsv === null) return EXIT_CODES.VALIDATION;

        const result = importMasterDataVersioned(
          ledger.db,
          { operationsCsv, materialsCsv },
          { source: args.options['source'] ?? 'cli' },
        );
        if (asJson) {
          printJson(result);
          return EXIT_CODES.OK;
        }
        printText('== 主数据导入 ==');
        printText(`  主数据版本：第 ${result.version} 版　导入时间 ${result.imported_at}　来源 ${result.source}`);
        printText(
          `  排台台次：文件 ${result.operations.total} 行　新增 ${result.operations.inserted}　` +
            `更新 ${result.operations.updated}　跳过 ${result.operations.skipped}　` +
            `镜像行数 ${result.operations.before} → ${result.operations.after}`,
        );
        printText(
          `  耗材主数据：文件 ${result.materials.total} 行　新增 ${result.materials.inserted}　` +
            `更新 ${result.materials.updated}　跳过 ${result.materials.skipped}　` +
            `镜像行数 ${result.materials.before} → ${result.materials.after}`,
        );
        if (result.skips.length > 0) {
          printText(`  跳过明细（${result.skips.length} 条）：`);
          for (const skip of result.skips.slice(0, 50)) {
            printText(`    ${skip.table === 'operation' ? '排台' : '耗材'} 第 ${skip.line} 行　${skip.key || '（无主键）'}　${skip.reason}`);
          }
          if (result.skips.length > 50) printText(`    …… 其余 ${result.skips.length - 50} 条见 master_data_import 履历`);
        }
        printText('  导入即生效：正在跑的守护进程无需重启，下一次扫码按新值判定');
        return EXIT_CODES.OK;
      }

      default:
        // 走到这里说明子命令声明与实现脱节了 —— 属内部错误
        printError(`未知子命令：${args.command}`);
        printError(renderGlobalHelp());
        return EXIT_CODES.INTERNAL;
    }
  } finally {
    ledger.close();
  }
}
