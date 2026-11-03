/**
 * 运维 CLI 的**参数契约层**：参数解析 + 退出码约定 + 子命令说明 + 用法提示。
 *
 * CLI 是常驻进程唯一的运维面 —— 信息科要能在一条命令里看到「哪一路不通、
 * 哪些耗材还没闭环」，而且**能被脚本和监控接走**（`--json` + 稳定退出码）。
 *
 * 四件事：
 *   ① **统一参数解析** —— `--key value` / `--key=value` / `--flag` 三种写法，
 *      子命令 + 位置参数 + 具名参数；开关参数单独登记，避免 `--charge 20` 里的
 *      `20` 被当成 `--charge` 的值；
 *   ② **退出码约定** —— 0 成功 / 2 参数错误 / 3 业务校验失败 / 4 外部通道不可达 /
 *      5 内部错误。监控按退出码判定，**不用去解析输出文本**；
 *   ③ **子命令说明** —— 每个子命令的用途、参数、默认值、示例四要素齐全，
 *      `<子命令> --help` 直接可照抄；
 *   ④ **用法提示** —— 参数不合法时先说清楚哪里不对，再把该子命令的用法贴出来。
 *
 * 硬约束：**凭据明文一律不出现在任何输出里**（含错误信息与 `--json`）——
 * 脱敏在 `src/cli/output.ts` 里统一做，这里不碰凭据。
 */

/* ------------------------------------------------------------------ 退出码 */

/**
 * 退出码约定。
 *
 * 监控接这个 CLI 时，判定依据是**退出码**，不是输出文本 ——
 * 输出文本会改版，退出码不会。
 */
export const EXIT_CODES = {
  /** 成功 */
  OK: 0,
  /** 参数错误：未知子命令 / 未知参数 / 参数取值不合法 / 缺少必填参数 */
  USAGE: 2,
  /** 业务校验失败：台账库不存在、主数据文件读不到、幂等不变式不成立 */
  VALIDATION: 3,
  /** 外部通道不可达：出站计费通道连不上 / 凭据缺失，命令要求的外部动作没做成 */
  CHANNEL: 4,
  /** 内部错误：未预期的异常（程序自己的问题） */
  INTERNAL: 5,
} as const;

/** 退出码的中文说明（`--help` 与文档共用一份） */
export const EXIT_CODE_MEANINGS: Readonly<Record<number, string>> = {
  [EXIT_CODES.OK]: '成功',
  [EXIT_CODES.USAGE]: '参数错误（未知子命令 / 未知参数 / 参数不合法）',
  [EXIT_CODES.VALIDATION]: '业务校验失败（台账库不存在 / 文件读不到 / 幂等不变式不成立）',
  [EXIT_CODES.CHANNEL]: '外部通道不可达（出站计费通道连不上或凭据缺失）',
  [EXIT_CODES.INTERNAL]: '内部错误（未预期的异常）',
};

/** 参数错误：CLI 自身的用法问题（对应退出码 2） */
export class CliUsageError extends Error {
  /** 固定 2 —— 参数错误就是参数错误，不因调用方而变 */
  readonly exitCode: number = EXIT_CODES.USAGE;

  constructor(
    message: string,
    /** 出错时该贴出来的用法提示（子命令用法或全局用法） */
    readonly usage: string = '',
  ) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/* -------------------------------------------------------------- 参数解析 */

/** 解析好的命令行参数 */
export interface ParsedArgs {
  /** 子命令名（空表示只看帮助） */
  command: string;
  /** 具名参数（--key value 或 --key=value） */
  options: Record<string, string>;
  /** 开关参数（--flag） */
  flags: Set<string>;
  /** 位置参数 */
  positional: string[];
}

/**
 * 开关型参数（本身不带值）。
 *
 * 单独列出来是为了避免歧义：`replay --charge 20` 里的 `20` 不能被当成
 * `--charge` 的值 —— 开关后面跟的下一个参数一律是别的参数。
 */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'charge',
  'help',
  'json',
  'probe',
  'verbose',
  'reconcile',
  'dry-run',
  'create-check',
  'no-verify',
  'diff',
]);

/**
 * 解析命令行参数。
 *
 * 支持 `--key value`、`--key=value`、`--flag` 三种写法；其余一律当位置参数。
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  let command = '';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) {
      if (command === '') command = token;
      else positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      options[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--') && !BOOLEAN_FLAGS.has(body)) {
      options[body] = next;
      index += 1;
    } else {
      flags.add(body);
    }
  }

  return { command, options, flags, positional };
}

/* ---------------------------------------------------------- 子命令参数声明 */

/** 一个具名参数的声明 */
export interface OptionSpec {
  /** 参数名（不含 `--`） */
  name: string;
  /** 参数类型：字符串 / 正整数 / 开关 */
  kind: 'string' | 'number' | 'boolean';
  /** 默认值（写进 `--help` 的「默认值」一栏；没写就是无默认值） */
  default?: string;
  /** 参数说明 */
  description: string;
  /** 取值白名单（给了就只接受这几个值） */
  choices?: readonly string[];
  /** 必填参数（缺了就报参数错误） */
  required?: boolean;
}

/** 一个子命令的声明 */
export interface CommandSpec {
  /** 子命令名 */
  name: string;
  /** 一句话用途 */
  summary: string;
  /** 该子命令支持的具名参数 */
  options: readonly OptionSpec[];
  /** 可直接照抄的示例 */
  examples: readonly string[];
}

/** 通用参数（每个子命令都有） */
const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'db',
    kind: 'string',
    default: 'data/ledger.db（取自环境变量 LEDGER_DB_PATH）',
    description: '台账库路径',
  },
  {
    name: 'json',
    kind: 'boolean',
    default: '关',
    description: '输出机器可读的 JSON（监控 / 脚本直接 JSON.parse）；不加这个开关时输出给人看的文本',
  },
  {
    name: 'help',
    kind: 'boolean',
    default: '关',
    description: '显示本帮助',
  },
];

/** 全部子命令的声明（一份真源 —— 帮助文案与参数校验都从这里来） */
export const COMMAND_SPECS: Readonly<Record<string, CommandSpec>> = {
  doctor: {
    name: 'doctor',
    summary: '常驻进程体检单：三路凭据位齐否、末次收到事件 / 末次计费回写、推送失败计数、主数据版本',
    options: [
      {
        name: 'probe',
        kind: 'boolean',
        default: '关（只读本地台账，不连接任何外部系统）',
        description:
          '加一次主动探测：出站发**空批次**健康检查（不产生计费明细）、入站连一下监听端口与投递目录、推送侧解析域名并连端口（不发业务消息）',
      },
      {
        name: 'probe-timeout',
        kind: 'number',
        default: '3000',
        description: '主动探测的超时预算（毫秒）',
      },
    ],
    examples: [
      'node dist/cli.js doctor',
      'node dist/cli.js doctor --json',
      'node dist/cli.js doctor --probe --probe-timeout 5000',
    ],
  },

  replay: {
    name: 'replay',
    summary: '从事件日志重放事件，输出「新增台账行数 / 触发计费次数」，并验证幂等不变式',
    options: [
      { name: 'limit', kind: 'number', default: '50', description: '最多重放多少条事件' },
      { name: 'operation', kind: 'string', description: '只重放某个台次的事件' },
      { name: 'batch', kind: 'string', description: '只重放某个批次号的事件（扫码枪路=投递标识，目录路=批次文件名）' },
      { name: 'from', kind: 'string', description: '时间窗起点（含，按事件**收到时刻**，ISO 时间）' },
      { name: 'to', kind: 'string', description: '时间窗终点（含，ISO 时间）' },
      { name: 'source', kind: 'string', description: '只重放某个来源的事件（scanner_http / rfid_dir）' },
      { name: 'file', kind: 'string', description: '从事件日志文件重放（每行一个批次信封）' },
      {
        name: 'charge',
        kind: 'boolean',
        default: '关（只重放，不回写计费）',
        description: '顺带回写计费（需要出站凭据位 HIS_CHARGING_BASE_URL / HIS_CHARGING_TOKEN）',
      },
      {
        name: 'no-verify',
        kind: 'boolean',
        default: '关（默认**要验**不变式）',
        description: '跳过幂等不变式验证（默认同一区间连重放两遍，第二次增量必须为 0）',
      },
      {
        name: 'diff-out',
        kind: 'string',
        default: 'logs/replay-<区间>-diff.json（该目录不入库）',
        description: '差异表落盘路径',
      },
    ],
    examples: [
      'node dist/cli.js replay --limit 20',
      'node dist/cli.js replay --limit 20 --charge',
      'node dist/cli.js replay --operation OP-SAMPLE-001 --json',
      'node dist/cli.js replay --from 2026-01-15T00:00:00Z --to 2026-01-16T00:00:00Z',
    ],
  },

  ledger: {
    name: 'ledger',
    summary: '耗材使用台账查询与导出',
    options: [
      { name: 'operation', kind: 'string', description: '按台次过滤' },
      {
        name: 'status',
        kind: 'string',
        description: '按条目状态过滤（bound / charged / check_pending / closed）',
      },
      { name: 'material', kind: 'string', description: '按耗材码过滤' },
      { name: 'limit', kind: 'number', default: '100', description: '最多取多少行' },
      {
        name: 'format',
        kind: 'string',
        default: 'table',
        choices: ['table', 'csv', 'json'],
        description: '输出格式',
      },
      { name: 'out', kind: 'string', description: '把结果写到文件（csv / json 时可用）' },
    ],
    examples: [
      'node dist/cli.js ledger --operation OP-SAMPLE-001',
      'node dist/cli.js ledger --format csv --out /tmp/ledger.csv',
      'node dist/cli.js ledger --json',
    ],
  },

  pack: {
    name: 'pack',
    summary: '核查包导出（含台次上下文、结论、reason_code、回执与人工结论；不含患者标识字段）',
    options: [
      { name: 'operation', kind: 'string', description: '按台次过滤' },
      { name: 'status', kind: 'string', description: '按核查状态过滤（pending / closed）' },
      { name: 'limit', kind: 'number', default: '500', description: '最多导出多少条' },
      {
        name: 'format',
        kind: 'string',
        default: 'csv',
        choices: ['csv', 'json'],
        description: '输出格式',
      },
      { name: 'out', kind: 'string', description: '导出文件路径' },
    ],
    examples: [
      'node dist/cli.js pack --status pending',
      'node dist/cli.js pack --format json --out /tmp/pack.json',
      'node dist/cli.js pack --json',
    ],
  },

  summary: {
    name: 'summary',
    summary: '批次与台次统计（结论分布、计费成功率、待核查条目数）',
    options: [{ name: 'operation', kind: 'string', description: '只统计某个台次' }],
    examples: [
      'node dist/cli.js summary',
      'node dist/cli.js summary --operation OP-SAMPLE-001',
      'node dist/cli.js summary --json',
    ],
  },

  events: {
    name: 'events',
    summary: '事件日志溯源：按投递标识回查「设备报了什么 → 落了哪几行台账 → 怎么处置」，或按耗材码回查全部事件序列',
    options: [
      { name: 'request', kind: 'string', description: '按投递标识回查（一次扫码投递 = 一个标识）' },
      { name: 'material', kind: 'string', description: '按耗材码回查（原始码与院内码都能查）' },
      { name: 'operation', kind: 'string', description: '按台次回查该台次的事件' },
      { name: 'source', kind: 'string', description: '按来源过滤（scanner_http / rfid_dir）' },
      { name: 'limit', kind: 'number', default: '50', description: '最多回查多少条事件' },
    ],
    examples: [
      'node dist/cli.js events --request 8a3f-...',
      'node dist/cli.js events --material MAT-SAMPLE-01',
      'node dist/cli.js events --operation OP-SAMPLE-001 --json',
    ],
  },

  reconcile: {
    name: 'reconcile',
    summary: '台账 ↔ 计费回执逐条对账，输出「哪些耗材没有生成计费」的差异台账',
    options: [
      { name: 'operation', kind: 'string', description: '只对某个台次对账' },
      { name: 'material', kind: 'string', description: '只对某个耗材码对账' },
      { name: 'status', kind: 'string', description: '只看某类处置状态（pending / resolved）' },
      { name: 'limit', kind: 'number', default: '20000', description: '最多扫描多少条台账行' },
      {
        name: 'format',
        kind: 'string',
        default: 'table',
        choices: ['table', 'csv', 'json'],
        description: '输出格式',
      },
      { name: 'out', kind: 'string', description: '导出文件路径' },
      { name: 'dry-run', kind: 'boolean', default: '关', description: '只读盘点：不把差异落进差异台账' },
      { name: 'create-check', kind: 'boolean', default: '关', description: '把待处理差异转成核查任务（双向挂接）' },
    ],
    examples: [
      'node dist/cli.js reconcile --operation OP-SAMPLE-001',
      'node dist/cli.js reconcile --format csv --out /tmp/diffs.csv',
      'node dist/cli.js reconcile --create-check --json',
    ],
  },

  closing: {
    name: 'closing',
    summary: '关台核对清单导出（按台次聚合未闭环条目：可关台 / 待核查 N 条 / 待计费 N 条）',
    options: [
      { name: 'operation', kind: 'string', description: '只导某个台次的关台核对清单' },
      { name: 'operations', kind: 'string', description: '指定台次列表（逗号分隔），用于手术室周度批量核对' },
      { name: 'from', kind: 'string', description: '落账时间起点（含，ISO 时间）' },
      { name: 'to', kind: 'string', description: '落账时间终点（含，ISO 时间）' },
      { name: 'limit', kind: 'number', default: '200', description: '最多返回多少个台次' },
      {
        name: 'format',
        kind: 'string',
        default: 'table',
        choices: ['table', 'csv', 'json'],
        description: '输出格式',
      },
      { name: 'out', kind: 'string', description: '导出文件路径' },
    ],
    examples: [
      'node dist/cli.js closing --operation OP-SAMPLE-001',
      'node dist/cli.js closing --operations OP-SAMPLE-001,OP-SAMPLE-002 --format csv --out /tmp/closing.csv',
      'node dist/cli.js closing --json',
    ],
  },

  attempts: {
    name: 'attempts',
    summary: '计费尝试史：每一次投递尝试一行（时间 / attempt / 结果 / 错误码 / 通道可达性）',
    options: [
      { name: 'operation', kind: 'string', description: '只看某个台次的尝试' },
      { name: 'material', kind: 'string', description: '只看某条耗材的尝试' },
      { name: 'from', kind: 'string', description: '时间窗起点（含，ISO 时间）' },
      { name: 'to', kind: 'string', description: '时间窗终点（含，ISO 时间）' },
      { name: 'limit', kind: 'number', default: '500', description: '最多取多少行' },
      {
        name: 'format',
        kind: 'string',
        default: 'table',
        choices: ['table', 'csv', 'json'],
        description: '输出格式',
      },
      { name: 'out', kind: 'string', description: '导出文件路径（csv / json 时可用）' },
    ],
    examples: [
      'node dist/cli.js attempts --operation OP-SAMPLE-001',
      'node dist/cli.js attempts --format csv --out /tmp/attempts.csv',
      'node dist/cli.js attempts --json',
    ],
  },

  'import-master': {
    name: 'import-master',
    summary: '导入手术排台与耗材主数据（导入即生效，不重启常驻进程）',
    options: [
      {
        name: 'operations',
        kind: 'string',
        required: true,
        description: '手术排台台次 CSV 路径（字段：operation_no / room_no / dept_code / status / closed_at）',
      },
      {
        name: 'materials',
        kind: 'string',
        required: true,
        description: '院内耗材主数据 CSV 路径（字段：material_code / name / price_code / fee_category / medical_insurance_class / active / batch_no 等）',
      },
      { name: 'source', kind: 'string', default: 'cli', description: '导入来源标识（写进导入履历与审计链）' },
    ],
    examples: [
      'node dist/cli.js import-master --operations data/operations.csv --materials data/materials.csv',
      'node dist/cli.js import-master --operations ops.csv --materials mats.csv --source nurse-station --json',
    ],
  },
};

/** 子命令名清单（按声明顺序） */
export const COMMAND_NAMES: readonly string[] = Object.keys(COMMAND_SPECS);

/* -------------------------------------------------------------- 参数校验 */

/** 某个子命令允许的全部参数（通用参数 + 自己的参数） */
export function allowedOptions(spec: CommandSpec): ReadonlyMap<string, OptionSpec> {
  const map = new Map<string, OptionSpec>();
  for (const option of [...GLOBAL_OPTIONS, ...spec.options]) map.set(option.name, option);
  return map;
}

/**
 * 校验参数是否合法。
 *
 * 返回**问题清单**（空数组 = 合法）—— 调用方拿到问题就去报退出码 2，
 * 不用在这里抛异常（抛异常的话「哪几条不对」就说不清了）。
 */
export function validateArgs(args: ParsedArgs, spec: CommandSpec): string[] {
  const problems: string[] = [];
  const allowed = allowedOptions(spec);

  for (const [key, value] of Object.entries(args.options)) {
    const option = allowed.get(key);
    if (!option) {
      problems.push(`未知参数 --${key}`);
      continue;
    }
    if (option.kind === 'number') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
        problems.push(`参数 --${key} 需要一个正整数（当前值：${value}）`);
      }
    }
    if (option.choices && !option.choices.includes(value)) {
      problems.push(`参数 --${key} 只接受 ${option.choices.join(' / ')}（当前值：${value}）`);
    }
    if (option.kind === 'boolean') {
      problems.push(`参数 --${key} 是开关，不带值（请写成 --${key} 而不是 --${key}=${value}）`);
    }
  }

  for (const flag of args.flags) {
    if (flag === 'help') continue;
    const option = allowed.get(flag);
    if (!option) {
      problems.push(`未知参数 --${flag}`);
      continue;
    }
    if (option.kind !== 'boolean') {
      problems.push(`参数 --${flag} 需要一个值（写成 --${flag} <值> 或 --${flag}=<值>）`);
    }
  }

  for (const option of spec.options) {
    if (option.required !== true) continue;
    const given = args.options[option.name] !== undefined || args.flags.has(option.name);
    if (!given) problems.push(`缺少必填参数 --${option.name}（${option.description}）`);
  }

  if (args.positional.length > 0) {
    problems.push(`多余的位置参数：${args.positional.join(' ')}（本子命令不接位置参数）`);
  }

  return problems;
}

/* ------------------------------------------------------------------ 帮助 */

/** 渲染一张对齐的文本表（宽度按显示宽度算，中文占两格） */
function padDisplay(text: string, width: number): string {
  const displayWidth = (value: string): number =>
    [...value].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** 渲染子命令用法（用途 / 参数 / 默认值 / 示例 四要素齐全） */
export function renderCommandHelp(spec: CommandSpec): string {
  const lines: string[] = [];
  const allowed = allowedOptions(spec);

  lines.push(`高值耗材扫码计费闭环系统 · ${spec.name}`);
  lines.push('');
  lines.push('用途：');
  lines.push(`  ${spec.summary}`);
  lines.push('');
  lines.push('参数：');
  const optionRows = [...allowed.values()].map((option) => {
    const label =
      option.kind === 'boolean' ? `--${option.name}` : `--${option.name} <${option.kind === 'number' ? 'n' : '值'}>`;
    return [label, option.description] as const;
  });
  const labelWidth = Math.max(...optionRows.map((row) => row[0].length));
  for (const [label, description] of optionRows) {
    lines.push(`  ${padDisplay(label, labelWidth)}  ${description}`);
  }
  lines.push('');
  lines.push('默认值：');
  const defaultRows = [...allowed.values()].filter((option) => option.default !== undefined);
  if (defaultRows.length === 0) {
    lines.push('  （本子命令没有带默认值的参数）');
  } else {
    for (const option of defaultRows) {
      lines.push(`  --${option.name} = ${option.default}`);
    }
  }
  lines.push('');
  lines.push('示例：');
  for (const example of spec.examples) lines.push(`  ${example}`);
  lines.push('');
  lines.push('退出码：');
  for (const code of [EXIT_CODES.OK, EXIT_CODES.USAGE, EXIT_CODES.VALIDATION, EXIT_CODES.CHANNEL, EXIT_CODES.INTERNAL]) {
    lines.push(`  ${code}  ${EXIT_CODE_MEANINGS[code] ?? ''}`);
  }
  return lines.join('\n');
}

/** 渲染全局用法（子命令一览 + 通用参数 + 退出码） */
export function renderGlobalHelp(): string {
  const lines: string[] = [];
  lines.push('高值耗材扫码计费闭环系统 · 运维命令行');
  lines.push('');
  lines.push('用法：');
  lines.push('  node dist/cli.js <子命令> [选项]');
  lines.push('');
  lines.push('子命令：');
  const nameWidth = Math.max(...COMMAND_NAMES.map((name) => name.length));
  for (const name of COMMAND_NAMES) {
    const spec = COMMAND_SPECS[name];
    if (!spec) continue;
    lines.push(`  ${padDisplay(name, nameWidth)}  ${spec.summary}`);
  }
  lines.push('');
  lines.push('通用选项：');
  for (const option of GLOBAL_OPTIONS) {
    const label = option.kind === 'boolean' ? `--${option.name}` : `--${option.name} <${option.kind === 'number' ? 'n' : '值'}>`;
    lines.push(`  ${padDisplay(label, 16)}  ${option.description}（默认：${option.default ?? '无'}）`);
  }
  lines.push('');
  lines.push('退出码：');
  for (const code of [EXIT_CODES.OK, EXIT_CODES.USAGE, EXIT_CODES.VALIDATION, EXIT_CODES.CHANNEL, EXIT_CODES.INTERNAL]) {
    lines.push(`  ${code}  ${EXIT_CODE_MEANINGS[code] ?? ''}`);
  }
  lines.push('');
  lines.push('每个子命令的完整参数、默认值与示例：');
  lines.push('  node dist/cli.js <子命令> --help');
  return lines.join('\n');
}

/** 全局用法文案（保持导出名稳定，既有引用不用改） */
export const CLI_HELP = renderGlobalHelp();
