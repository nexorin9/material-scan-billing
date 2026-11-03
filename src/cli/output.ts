/**
 * 运维 CLI 的**输出层**：脱敏 + 打印。
 *
 * 一条硬约束贯穿全文件：**凭据明文一律不出现在任何输出里** —— 包括
 * 正常输出、`--json` 输出、错误信息与用法提示。
 *
 * 三道防线（与 `src/log/logger.ts` 同一套语义）：
 *   ① **已登记凭据打码** —— 启动时把三路凭据位登记进来，文本里出现即替换成 `***`；
 *   ② **字段名打码** —— JSON 结构里键名带 token / secret / authorization /
 *      webhook / password / api_key / credential / cookie 的，值一律替换成 `***`；
 *   ③ **URL 打码** —— URL 里的 query 参数（`?key=…`）只留协议 + 主机 + 路径。
 *
 * 另外两条输出纪律：
 *   - **`--json` 模式下 stdout 只有一份 JSON** —— 人话提示一律走 stderr，
 *     这样 `node dist/cli.js doctor --json | jq` 能直接用；
 *   - **错误信息同样脱敏** —— 报错时常会把配置原样带出来，不能带凭据。
 */

import { redactSecrets, redactUrl, registerSecret } from '../log/logger.js';
import type { EnvSnapshot } from '../config/env.js';

/** 打码后的占位符 */
export const REDACTED = '***';

/** 字段名里带这些词的，值一律打码 */
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|auth_header|api[_-]?key|webhook|credential|cookie|session|sign(ature)?_?key)/i;

/** 环境变量里可能装着凭据的变量名（登记进去 = 出现即打码） */
const CREDENTIAL_ENV_VARS: readonly string[] = [
  'OR_SCANNER_TOKEN',
  'OR_SCANNER_SECRET',
  'HIS_CHARGING_TOKEN',
  'WECOM_SECRET',
  'WECOM_WEBHOOK_URL',
];

/**
 * 把环境变量里的凭据登记进打码名单。
 *
 * 登记的是**值** —— 之后任何文本里出现这些值，一律替换成 `***`。
 * 企微 webhook 的 URL 里常带 `?key=…`，所以整条 URL 也登记进去。
 */
export function registerEnvSecrets(env: EnvSnapshot = process.env): void {
  for (const name of CREDENTIAL_ENV_VARS) {
    registerSecret(env[name]);
  }
  // webhook URL 里的 key 参数单独登记（URL 本身会被 redactUrl 处理，这里补的是
  // 「key 的值被单独贴进别处」的情况）
  const webhook = env['WECOM_WEBHOOK_URL'];
  if (typeof webhook === 'string' && webhook.length > 0) {
    try {
      const url = new URL(webhook);
      for (const value of url.searchParams.values()) registerSecret(value);
    } catch {
      // 地址格式不对就不是有效凭据位，交给 env 层去报错
    }
  }
}

/** 文本打码：已登记凭据 → `***`；URL 的 query → 只留协议 + 主机 + 路径 */
export function redactText(text: string): string {
  const withoutSecrets = redactSecrets(text);
  return withoutSecrets.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactUrl(match));
}

/** 结构化打码：键名敏感的值替换成 `***`，字符串值再走一遍文本打码 */
export function redactValue(value: unknown, keyHint = ''): unknown {
  if (typeof value === 'string') {
    if (keyHint !== '' && SENSITIVE_KEY_PATTERN.test(keyHint)) return REDACTED;
    return redactText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value === undefined ? null : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, keyHint));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(item, key);
    }
    return out;
  }
  return redactText(String(value));
}

/** 打印一行给人看的文本（stdout） */
export function printText(text: string): void {
  console.log(redactText(text));
}

/** 打印一条提示（stderr）—— `--json` 模式下人话提示都走这里 */
export function printNote(text: string): void {
  console.error(redactText(text));
}

/** 打印一条错误（stderr） */
export function printError(text: string): void {
  console.error(redactText(text));
}

/**
 * 生成一份机器可读的 JSON 文本（已脱敏）。
 *
 * 落盘与打印用**同一份**字符串 —— 写进文件的内容与 stdout 看到的一致。
 */
export function jsonDocument(value: unknown): string {
  return JSON.stringify(redactValue(value), null, 2);
}

/**
 * 打印一份机器可读的 JSON（stdout）。
 *
 * `stdout` 上**只有这一份 JSON** —— 脚本 `JSON.parse(stdout)` 一定解析得动。
 */
export function printJson(value: unknown): void {
  console.log(jsonDocument(value));
}
