/**
 * test_cli_contract：运维 CLI 的**对外契约**。
 *
 * CLI 是常驻进程唯一的运维面 —— 信息科要能在一条命令里看到「哪一路不通、
 * 哪些耗材还没闭环」，而且**能被脚本和监控接走**。所以本文件盯四件事：
 *
 *   ① **用法齐全** —— 每个子命令 `--help` 都有「用途 / 参数 / 默认值 / 示例」
 *      四要素，示例能直接照抄；
 *   ② **退出码稳定** —— 0 成功 / 2 参数错误 / 3 业务校验失败 / 4 外部通道不可达 /
 *      5 内部错误；监控按退出码判定，不解析输出文本；
 *   ③ **`--json` 机器可读** —— stdout 上只有一份 JSON，`JSON.parse(stdout)` 一定解析得动；
 *   ④ **凭据零明文** —— 任何子命令、任何输出模式（含错误信息与用法提示），
 *      都不出现 token / secret 明文。
 *
 * 替身说明：HIS 计费替身只出现在需要打 HIS 的用例里；本文件其余部分只读本地台账。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openLedger, type LedgerDb } from '../src/ledger/db.js';
import { importMasterData } from '../src/ledger/import-master-data.js';
import { startIngestServer, type IngestServerHandle } from '../src/ingest/http-server.js';
import { formatSignatureHeader } from '../src/ingest/signature.js';
import { newNonce } from '../src/ingest/replay-guard.js';
import {
  COMMAND_SPECS,
  EXIT_CODES,
  parseArgs,
  renderCommandHelp,
  renderGlobalHelp,
  validateArgs,
} from '../src/cli/args.js';
import { redactText, redactValue, registerEnvSecrets } from '../src/cli/output.js';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const cliPath = resolve(projectRoot, 'dist', 'cli.js');
const fixturesDir = resolve(projectRoot, 'tests', 'fixtures');

/** 五个核心子命令（任务书点名的五个） */
const CORE_COMMANDS = ['doctor', 'replay', 'ledger', 'pack', 'summary'] as const;

const SCANNER_TOKEN = 'cli-contract-scanner-token-zzzz';
const SCANNER_SECRET = 'cli-contract-scanner-secret-zzzz';
const HIS_TOKEN = 'cli-contract-his-token-zzzz';
const WECOM_SECRET = 'cli-contract-wecom-secret-zzzz';
const WECOM_KEY = 'cli-contract-webhook-key-zzzz';

/** 所有凭据明文 —— 任何一个都不许出现在输出里 */
const ALL_SECRETS = [SCANNER_TOKEN, SCANNER_SECRET, HIS_TOKEN, WECOM_SECRET, WECOM_KEY];

const operationsCsv = readFileSync(resolve(fixturesDir, 'operations.csv'), 'utf8');
const materialsCsv = readFileSync(resolve(fixturesDir, 'materials.csv'), 'utf8');

let workDir: string;
let dbPath: string;
let ledger: LedgerDb;
let ingest: IngestServerHandle;

/** 跑一次 CLI，返回退出码与两路输出（不抛 —— 非零退出码本身就是断言对象） */
async function runCli(
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      env,
      cwd: projectRoot,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? '',
    };
  }
}

/** 投递一批扫码事件（走真实入站 HTTP 路径，产生台账行 / 核查条目 / 事件日志） */
async function postBatch(body: unknown): Promise<number> {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = newNonce();
  const signature = formatSignatureHeader(timestamp, nonce, rawBody, SCANNER_SECRET);
  const response = await fetch(`http://127.0.0.1:${ingest.port}/api/v1/scan-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SCANNER_TOKEN}`,
      'x-scan-timestamp': timestamp,
      'x-scan-nonce': nonce,
      'x-scan-signature': signature,
    },
    body: rawBody,
  });
  await response.text();
  return response.status;
}

/** 一批 4 条扫码：3 条院内码 + 1 条未建档 */
function demoScans() {
  return [
    { material_code: 'MAT-SAMPLE-01', quantity: 1, scan_time: '2026-01-15T09:12:00+08:00', batch_no: 'LOT-SAMPLE-A' },
    { material_code: 'MAT-SAMPLE-02', quantity: 2, scan_time: '2026-01-15T09:13:10+08:00', batch_no: 'LOT-SAMPLE-B' },
    { material_code: 'MAT-UNKNOWN-99', quantity: 1, scan_time: '2026-01-15T09:17:31+08:00' },
  ];
}

/** 凭据齐备但**故意不通**的环境（通道不可达用例用） */
function credentialEnv(): NodeJS.ProcessEnv {
  return {
    OR_SCANNER_BASE_URL: 'http://127.0.0.1:9',
    OR_SCANNER_TOKEN: SCANNER_TOKEN,
    OR_SCANNER_SECRET: SCANNER_SECRET,
    HIS_CHARGING_BASE_URL: 'http://127.0.0.1:9',
    HIS_CHARGING_TOKEN: HIS_TOKEN,
    WECOM_WEBHOOK_URL: `http://127.0.0.1:9/cgi-bin/webhook/send?key=${WECOM_KEY}`,
    WECOM_SECRET: WECOM_SECRET,
  };
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'msb-cli-contract-'));
  dbPath = resolve(workDir, 'ledger.db');
  ledger = openLedger(dbPath);
  importMasterData(ledger.db, { operationsCsv, materialsCsv });
  ingest = await startIngestServer({ db: ledger.db, token: SCANNER_TOKEN, secret: SCANNER_SECRET });
  await postBatch({
    operation_no: 'OP-SAMPLE-001',
    room_no: 'OR-01',
    scanner_id: 'SCAN-GUN-07',
    scans: demoScans(),
  });
});

after(async () => {
  await ingest.close();
  ledger.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('CLI 参数契约', () => {
  it('五个核心子命令的 --help 都非空，且「用途 / 参数 / 默认值 / 示例」四要素齐全', async () => {
    for (const command of CORE_COMMANDS) {
      const result = await runCli([command, '--help']);
      assert.equal(result.code, EXIT_CODES.OK, `${command} --help 应当退出码 0，实际 ${result.code}`);
      assert.ok(result.stdout.length > 0, `${command} --help 输出为空`);
      // 四要素
      assert.ok(result.stdout.includes('用途：'), `${command} --help 缺「用途」`);
      assert.ok(result.stdout.includes('参数：'), `${command} --help 缺「参数」`);
      assert.ok(result.stdout.includes('默认值：'), `${command} --help 缺「默认值」`);
      assert.ok(result.stdout.includes('示例：'), `${command} --help 缺「示例」`);
      // 示例能直接照抄
      const examples = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('node dist/cli.js'));
      assert.ok(examples.length > 0, `${command} --help 没有可照抄的示例`);
      assert.ok(
        examples.some((line) => line.includes(command)),
        `${command} --help 的示例里没有本子命令：${examples.join(' | ')}`,
      );
      // 退出码说明也在（监控照着这张表接）
      assert.ok(result.stdout.includes('退出码：'), `${command} --help 缺「退出码」`);
      assert.ok(result.stdout.includes('2  参数错误'), `${command} --help 的退出码说明缺参数错误档`);
    }
  });

  it('全局用法列出全部子命令、通用选项与退出码约定', async () => {
    const result = await runCli(['--help']);
    assert.equal(result.code, EXIT_CODES.OK);
    for (const name of Object.keys(COMMAND_SPECS)) {
      assert.ok(result.stdout.includes(name), `全局用法里缺少子命令 ${name}`);
    }
    assert.ok(result.stdout.includes('--json'), '全局用法里缺少 --json');
    assert.ok(result.stdout.includes('--db'), '全局用法里缺少 --db');
    for (const code of [0, 2, 3, 4, 5]) {
      assert.ok(result.stdout.includes(`  ${code}  `), `全局用法里缺少退出码 ${code} 的说明`);
    }
  });

  it('非法参数一律退出码 2，并把用法提示贴出来', async () => {
    const cases: Array<{ args: string[]; expect: string }> = [
      { args: ['nosuchcommand'], expect: '未知子命令' },
      { args: ['doctor', '--nosuchoption'], expect: '未知参数' },
      { args: ['ledger', '--limit', 'abc'], expect: '正整数' },
      { args: ['ledger', '--format', 'xml'], expect: '只接受' },
      { args: ['import-master', '--operations', 'ops.csv'], expect: '缺少必填参数' },
      { args: ['ledger', 'leftover-positional'], expect: '位置参数' },
    ];
    for (const item of cases) {
      const result = await runCli(item.args);
      assert.equal(result.code, EXIT_CODES.USAGE, `${item.args.join(' ')} 应当退出码 2，实际 ${result.code}`);
      assert.ok(
        result.stderr.includes(item.expect),
        `${item.args.join(' ')} 的错误信息里应含「${item.expect}」，实际：${result.stderr.slice(0, 200)}`,
      );
      // 用法提示要跟着出来（子命令用法或全局用法）
      assert.ok(
        result.stderr.includes('用法') || result.stderr.includes('参数：'),
        `${item.args.join(' ')} 应当附用法提示`,
      );
    }
  });

  it('台账库不存在 → 退出码 3（业务校验失败），不是参数错误', async () => {
    const result = await runCli(['doctor', '--db', resolve(workDir, 'not-created.db')]);
    assert.equal(result.code, EXIT_CODES.VALIDATION);
    assert.ok(result.stderr.includes('台账库不存在'));
  });

  it('五个核心子命令的 --json 输出都能被 JSON.parse，且字段齐全', async () => {
    const expectedKeys: Record<string, string[]> = {
      doctor: ['generated_at', 'channels', 'sources', 'counters', 'run_summary'],
      replay: ['generated_at', 'batches', 'invariant', 'diff_path'],
      ledger: ['rows', 'total', 'limit'],
      pack: ['generated_at', 'fields', 'rows', 'total', 'audit_chain'],
      summary: ['generated_at', 'ledger_rows', 'by_conclusion', 'charge', 'check'],
    };

    for (const command of CORE_COMMANDS) {
      const args = [command, '--db', dbPath, '--json'];
      if (command === 'replay') args.push('--diff-out', resolve(workDir, 'replay-diff.json'));
      const result = await runCli(args);
      assert.equal(result.code, EXIT_CODES.OK, `${command} --json 应当退出码 0，实际 ${result.code}：${result.stderr.slice(0, 300)}`);

      // stdout 上**只有**一份 JSON —— 提示语一律走 stderr
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      } catch (error) {
        assert.fail(`${command} --json 的 stdout 不是合法 JSON：${String(error)}\n${result.stdout.slice(0, 400)}`);
      }
      for (const key of expectedKeys[command] ?? []) {
        assert.ok(key in parsed, `${command} --json 的输出里缺字段 ${key}`);
      }
    }
  });

  it('任何子命令的任何输出模式都不出现凭据明文（含 --json 与错误信息）', async () => {
    const env = credentialEnv();
    const runs: Array<{ label: string; args: string[] }> = [
      { label: 'doctor --json', args: ['doctor', '--db', dbPath, '--json'] },
      { label: 'doctor 文本', args: ['doctor', '--db', dbPath] },
      { label: 'summary --json', args: ['summary', '--db', dbPath, '--json'] },
      { label: 'ledger --json', args: ['ledger', '--db', dbPath, '--json'] },
      { label: 'pack --json', args: ['pack', '--db', dbPath, '--json'] },
      { label: 'replay --json', args: ['replay', '--db', dbPath, '--json', '--diff-out', resolve(workDir, 'r.json')] },
      { label: 'doctor --probe（探测失败路径）', args: ['doctor', '--db', dbPath, '--probe', '--json'] },
      { label: '非法参数（错误信息）', args: ['doctor', '--nosuchoption'] },
      { label: '出站通道不可达', args: ['replay', '--db', dbPath, '--charge'] },
    ];

    for (const run of runs) {
      const result = await runCli(run.args, env);
      const combined = `${result.stdout}\n${result.stderr}`;
      for (const secret of ALL_SECRETS) {
        assert.ok(!combined.includes(secret), `${run.label} 的输出里出现了凭据明文：${secret}`);
      }
    }
  });

  it('出站计费通道不可用时，replay --charge 退出码 4 且不重放（不动台账）', async () => {
    const before = await runCli(['ledger', '--db', dbPath, '--json']);
    const rowsBefore = (JSON.parse(before.stdout) as { total: number }).total;

    // 没配出站凭据 → 外部通道不可达
    const result = await runCli(['replay', '--db', dbPath, '--charge'], {
      HIS_CHARGING_BASE_URL: '',
      HIS_CHARGING_TOKEN: '',
    });
    assert.equal(result.code, EXIT_CODES.CHANNEL, `应当退出码 4，实际 ${result.code}`);
    assert.ok(result.stderr.includes('出站计费通道不可用'));

    const after = await runCli(['ledger', '--db', dbPath, '--json']);
    const rowsAfter = (JSON.parse(after.stdout) as { total: number }).total;
    assert.equal(rowsAfter, rowsBefore, '通道不可达时不应改动台账');
  });

  it('参数校验层：未知参数 / 非法取值 / 缺必填都能被 validateArgs 认出来', () => {
    const spec = COMMAND_SPECS['ledger'];
    assert.ok(spec);

    const unknown = validateArgs(parseArgs(['ledger', '--nope', 'x']), spec);
    assert.ok(unknown.some((problem) => problem.includes('未知参数 --nope')));

    const badNumber = validateArgs(parseArgs(['ledger', '--limit', '0']), spec);
    assert.ok(badNumber.some((problem) => problem.includes('正整数')));

    const badChoice = validateArgs(parseArgs(['ledger', '--format', 'yaml']), spec);
    assert.ok(badChoice.some((problem) => problem.includes('只接受')));

    const importSpec = COMMAND_SPECS['import-master'];
    assert.ok(importSpec);
    const missing = validateArgs(parseArgs(['import-master']), importSpec);
    assert.ok(missing.some((problem) => problem.includes('缺少必填参数 --operations')));
    assert.ok(missing.some((problem) => problem.includes('缺少必填参数 --materials')));

    // 合法参数不该报问题
    assert.deepEqual(validateArgs(parseArgs(['ledger', '--limit', '10', '--format', 'csv']), spec), []);
  });

  it('帮助文案由子命令声明生成：子命令清单、参数与默认值同源', () => {
    const global = renderGlobalHelp();
    for (const [name, spec] of Object.entries(COMMAND_SPECS)) {
      assert.ok(global.includes(name), `全局用法缺子命令 ${name}`);
      const help = renderCommandHelp(spec);
      assert.ok(help.includes(spec.summary), `${name} 的用法里缺用途说明`);
      for (const option of spec.options) {
        assert.ok(help.includes(`--${option.name}`), `${name} 的用法里缺参数 --${option.name}`);
      }
    }
  });

  it('输出层脱敏：已登记凭据与 URL query 一律打码，结构化字段按键名打码', () => {
    // 凭据登记进打码名单（CLI 启动时做的同一件事）
    registerEnvSecrets(credentialEnv());

    assert.equal(redactText(`token 是 ${SCANNER_TOKEN} 吗`), 'token 是 *** 吗');
    // 登记过的 webhook 地址整条打码（里面带着 key）
    const redactedUrl = redactText(`端点 ${envUrl()}`);
    assert.ok(!redactedUrl.includes(WECOM_KEY), `URL 里的 webhook key 应当被打码：${redactedUrl}`);
    assert.ok(!redactedUrl.includes('127.0.0.1:9/cgi-bin'), `登记过的 webhook 地址应当整条打码：${redactedUrl}`);
    // 没登记过的 URL：query 参数（key 之类）只留协议 + 主机 + 路径
    const plainUrl = redactText('端点 http://example.org/cgi-bin/webhook/send?key=other-secret-value');
    assert.ok(!plainUrl.includes('other-secret-value'), `未登记 URL 的 query 也应当被剥掉：${plainUrl}`);
    assert.ok(plainUrl.includes('/cgi-bin/webhook/send'), `URL 路径应当保留：${plainUrl}`);
    // 键名敏感的字段值打码
    const structured = redactValue({ token: 'abc', endpoint: 'http://x/y', nested: { secret: 'def' } }) as Record<string, unknown>;
    assert.equal(structured['token'], '***');
    assert.equal(structured['endpoint'], 'http://x/y');
    assert.equal((structured['nested'] as Record<string, unknown>)['secret'], '***');
  });
});

/** 造一个带 webhook key 的地址（脱敏用例用） */
function envUrl(): string {
  return `http://127.0.0.1:9/cgi-bin/webhook/send?key=${WECOM_KEY}`;
}
