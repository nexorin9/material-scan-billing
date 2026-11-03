/**
 * 启动自检：常驻进程开跑之前逐项检查，**任何一项不通过就拒绝启动**。
 *
 * 语义来源（源产品主路径）：源产品的服务入口用 `requiredVars` 逐项检查环境变量，
 * 缺失即打印变量名并 `process.exit(1)` —— 缺位 = 拒绝启动，绝不带着空凭据继续跑
 * （`github_ref/macro/services/lexical-service/src/server.ts`、
 *   `github_ref/macro/services/bots/anthropic-status-bot/src/server.ts`）。
 * 本模块把这条语义从「只查环境变量」扩到「查得到跑得起来的程度」：
 *
 *   ① 三路凭据位齐否（入站扫码网关 / 出站 HIS 计费 / 企业微信推送）—— 缺哪个**指名变量名**；
 *   ② 台账目录可写 —— 状态写在哪儿，写不进去等于没跑；
 *   ③ RFID 投递目录可读 —— 目录投递这一路收不到东西，等于哑火；
 *   ④ 台账库版本 —— 库比程序新时拒绝启动（降级跑会把新表结构写坏）。
 *
 * **不通过时的输出必须指名到变量名或路径**：手术室现场拿到一句「启动失败」没法排查，
 * 拿到「缺 HIS_CHANGING_TOKEN」当场就能补。
 */

import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  channelStatus,
  CHANNEL_LABELS,
  readIdempotencyKeyProfile,
  readMasterDataEncoding,
  type Channel,
  type EnvSnapshot,
} from '../config/env.js';
import { LEDGER_SCHEMA_VERSION } from '../ledger/db.js';

/** 启动自检的错误码（与 `src/log/error-codes.ts` 的码同一套命名） */
export const STARTUP_CHECK_ERROR_CODE = 'ERR_STARTUP_CHECK_FAILED';

/** 三路通道在自检里的检查顺序 */
export const CHECKED_CHANNELS: readonly Channel[] = ['inbound', 'outbound', 'notify'];

/** 一项检查的结论 */
export interface StartupCheckItem {
  /** 检查项名称（中文业务说法，不是工程黑话） */
  name: string;
  /** 是否通过 */
  ok: boolean;
  /** 不通过时的原因（人话；指名变量名或路径） */
  detail: string;
  /** 缺哪些环境变量名（**只报名字，不报值**） */
  missing_vars: string[];
}

/** 启动自检的总体结论 */
export interface StartupCheckResult {
  /** 全部通过才为 true */
  ok: boolean;
  /** 逐项结论 */
  items: StartupCheckItem[];
  /** 总体错误码 */
  error_code: string;
  /** 检查时刻 */
  checked_at: string;
}

/** 启动自检的输入 */
export interface StartupCheckOptions {
  /** 环境变量快照（默认读进程环境） */
  env?: EnvSnapshot;
  /** 台账库路径 */
  ledgerDbPath: string;
  /** RFID 投递目录 */
  scanInboxDir: string;
  /** 本程序支持的台账 schema 版本（默认取代码里的最新版本） */
  supportedSchemaVersion?: number;
}

/**
 * 读台账库文件上的 schema 版本（`PRAGMA user_version`）。
 *
 * 库不存在返回 null；读不出来（文件损坏 / 不是 SQLite 文件）也返回 null ——
 * 读不出版本不等于「版本不对」，让后面的打开步骤去报错更准确。
 */
export function readLedgerSchemaVersion(ledgerDbPath: string): number | null {
  const path = resolve(ledgerDbPath);
  if (!existsSync(path)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return row?.user_version ?? null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // 读版本失败不影响后续判断
    }
  }
}

/** 目录能不能写（真写一个临时文件再删掉 —— 只看权限位不算数） */
function directoryWritable(dirPath: string): { ok: boolean; detail: string } {
  const path = resolve(dirPath);
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      detail: `目录建不出来：${path}（${error instanceof Error ? error.message : String(error)}）`,
    };
  }
  const probe = resolve(path, `.write-probe-${process.pid}`);
  try {
    writeFileSync(probe, 'ok', 'utf8');
    unlinkSync(probe);
    return { ok: true, detail: path };
  } catch (error) {
    return {
      ok: false,
      detail: `目录不可写：${path}（${error instanceof Error ? error.message : String(error)}）`,
    };
  }
}

/** 目录能不能读（存在且是目录） */
function directoryReadable(dirPath: string): { ok: boolean; detail: string } {
  const path = resolve(dirPath);
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      detail: `目录建不出来：${path}（${error instanceof Error ? error.message : String(error)}）`,
    };
  }
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return { ok: false, detail: `不是目录：${path}` };
    }
    return { ok: true, detail: path };
  } catch (error) {
    return {
      ok: false,
      detail: `目录不可读：${path}（${error instanceof Error ? error.message : String(error)}）`,
    };
  }
}

/**
 * 跑一遍启动自检。
 *
 * 返回逐项结论；调用方决定是打印后退出（正式入口）还是继续（测试）。
 */
export function runStartupChecks(options: StartupCheckOptions): StartupCheckResult {
  const env = options.env ?? process.env;
  const items: StartupCheckItem[] = [];

  // ① 三路凭据位：缺哪个指名变量名（只报名字，不报值）
  for (const channel of CHECKED_CHANNELS) {
    const status = channelStatus(channel, env);
    if (status.ready) {
      items.push({
        name: `凭据位 · ${CHANNEL_LABELS[channel]}`,
        ok: true,
        detail: '齐备',
        missing_vars: [],
      });
      continue;
    }
    items.push({
      name: `凭据位 · ${CHANNEL_LABELS[channel]}`,
      ok: false,
      detail: `缺 ${status.missing.join('、')}`,
      missing_vars: [...status.missing],
    });
  }

  // ② 台账目录可写：状态写在哪儿，写不进去等于没跑
  const dataDir = dirname(resolve(options.ledgerDbPath));
  const writable = directoryWritable(dataDir);
  items.push({
    name: '台账目录可写',
    ok: writable.ok,
    detail: writable.ok ? `${writable.detail}（台账文件：${options.ledgerDbPath}）` : writable.detail,
    missing_vars: [],
  });

  // ③ RFID 投递目录可读：目录投递这一路收不到东西 = 哑火
  const readable = directoryReadable(options.scanInboxDir);
  items.push({
    name: 'RFID 投递目录可读',
    ok: readable.ok,
    detail: readable.ok
      ? `${readable.detail}（目录投递路就绪）`
      : `${readable.detail}；检查环境变量 SCAN_INBOX_DIR`,
    missing_vars: [],
  });

  // ④ 台账库版本：库比程序新时拒绝启动（降级跑会写坏新表结构）
  const supported = options.supportedSchemaVersion ?? LEDGER_SCHEMA_VERSION;
  const onDisk = readLedgerSchemaVersion(options.ledgerDbPath);
  if (onDisk === null) {
    items.push({
      name: '台账库版本',
      ok: true,
      detail: `还没有台账库，启动时新建（schema 版本 ${supported}）`,
      missing_vars: [],
    });
  } else if (onDisk > supported) {
    items.push({
      name: '台账库版本',
      ok: false,
      detail: `台账库版本 ${onDisk} 高于本程序支持的 ${supported}，请升级程序后再启动`,
      missing_vars: [],
    });
  } else {
    items.push({
      name: '台账库版本',
      ok: true,
      detail: `台账库版本 ${onDisk}，启动时升到 ${supported}`,
      missing_vars: [],
    });
  }

  // ⑤ 幂等键档位：档位决定「同一耗材同一台次算几笔」，配错就是重复计费或多计费
  try {
    const profile = readIdempotencyKeyProfile(env);
    items.push({
      name: '幂等键档位',
      ok: true,
      detail:
        profile === 'v2'
          ? 'v2（耗材码 + 台次 + 批号）：同码同台次的不同批号各算一次'
          : 'v1（耗材码 + 台次）：同码同台次只算一次',
      missing_vars: [],
    });
  } catch (error) {
    items.push({
      name: '幂等键档位',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      missing_vars: ['IDEMPOTENCY_KEY_PROFILE'],
    });
  }

  // ⑥ 主数据编码策略：老系统导 GBK、新系统导 UTF-8，策略配错整份主数据都读不出来
  try {
    const encoding = readMasterDataEncoding(env);
    items.push({
      name: '主数据编码策略',
      ok: true,
      detail:
        encoding === 'auto'
          ? 'auto（UTF-8 与 GBK 里择优）：老系统导出的 GBK 主数据也能读'
          : `${encoding}（只认这一种编码）`,
      missing_vars: [],
    });
  } catch (error) {
    items.push({
      name: '主数据编码策略',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      missing_vars: ['MASTER_DATA_ENCODING'],
    });
  }

  const ok = items.every((item) => item.ok);
  return {
    ok,
    items,
    error_code: ok ? '' : STARTUP_CHECK_ERROR_CODE,
    checked_at: new Date().toISOString(),
  };
}

/** 把自检结论渲染成人能直接照着改的一段文字 */
export function formatStartupCheckResult(result: StartupCheckResult): string {
  const lines: string[] = [];
  lines.push('== 启动自检 ==');
  for (const item of result.items) {
    lines.push(`  ${item.ok ? '通过' : '不通过'}  ${item.name}：${item.detail}`);
  }
  if (result.ok) {
    lines.push('  全部通过，可以启动。');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('启动自检未通过，拒绝启动（缺位不带着空凭据跑）。请按下面逐项处理：');
  for (const item of result.items) {
    if (item.ok) continue;
    if (item.missing_vars.length > 0) {
      for (const name of item.missing_vars) {
        lines.push(`  Missing required environment variable: ${name}`);
      }
    }
    lines.push(`  ${item.name}：${item.detail}`);
  }
  return lines.join('\n');
}

/** 自检不通过时抛的异常（入口据此退出码非 0） */
export class StartupCheckError extends Error {
  readonly code = STARTUP_CHECK_ERROR_CODE;

  constructor(readonly result: StartupCheckResult) {
    super('启动自检未通过，拒绝启动');
    this.name = 'StartupCheckError';
  }
}
