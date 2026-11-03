/**
 * 扫码枪位置登记簿：扫码枪编号 → 它固定在哪个手术间 / 哪个科室。
 *
 * 为什么要有这本簿子：扫码事件里带的是**事件自己说的**手术间（room_no），
 * 排台主数据里带的是**排台说的**手术间。两边对不上，可能是三种完全不同的事：
 *   ① 台次号挂错台 —— A 科室的台次号扫到了 B 手术间；
 *   ② 扫码枪被挪了间、登记没更新 —— 配置漂移；
 *   ③ 有人拿别人的枪扫 —— 事件根本不是这台枪发的。
 * 这三种都**不能猜绑**（绑错台 = 错账），只能转人工。
 *
 * 登记格式（环境变量 `OR_SCANNER_REGISTRY`）：
 *
 *   SCAN-GUN-07=OR-01,SURG-01;SCAN-GUN-08=OR-02
 *
 * 即 `扫码枪编号=手术间[,科室]`，多条用 `;` 分隔；手术间与科室都可留空
 * （只登记其中一项也行，那一项才参与核对）。
 *
 * **没登记 = 不参与核对**：簿子为空时，归属核对只剩「事件手术间 vs 排台手术间」
 * 一个因子。登记簿是**配置**，不是凭据 —— 不配不影响启动，配错了按配置漂移处理。
 */

import type { EnvSnapshot } from './env.js';

/** 一条扫码枪的位置登记 */
export interface ScannerDeclaration {
  /** 扫码枪编号 */
  scanner_id: string;
  /** 登记的手术间（没登记为 null） */
  room_no: string | null;
  /** 登记的科室（没登记为 null） */
  dept_code: string | null;
}

/** 解析出来的一条问题（登记簿写错时逐条报出来，不静默吞掉） */
export interface ScannerRegistryIssue {
  /** 出问题的那段原文 */
  entry: string;
  /** 中文原因 */
  reason: string;
}

/**
 * 扫码枪位置登记簿。
 *
 * 只读：登记簿一旦解析出来就不再变（配置变了要重启守护进程生效）。
 */
export class ScannerRegistry {
  private readonly byId: Map<string, ScannerDeclaration>;

  constructor(declarations: readonly ScannerDeclaration[] = []) {
    this.byId = new Map();
    for (const declaration of declarations) {
      this.byId.set(declaration.scanner_id, declaration);
    }
  }

  /** 登记簿条目数（doctor / 启动自检用） */
  get size(): number {
    return this.byId.size;
  }

  /** 查某把枪的登记；没登记返回 undefined */
  lookup(scanner_id: string | null | undefined): ScannerDeclaration | undefined {
    if (typeof scanner_id !== 'string') return undefined;
    const key = scanner_id.trim();
    if (key.length === 0) return undefined;
    return this.byId.get(key);
  }

  /** 全量登记（体检时逐条展示） */
  all(): ScannerDeclaration[] {
    return [...this.byId.values()];
  }
}

/** 空登记簿 */
export const EMPTY_SCANNER_REGISTRY = new ScannerRegistry();

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 解析登记簿文本。
 *
 * 宽容解析、严格报问题：写得不对的那一条被跳过并记一条 issue，
 * **不让一条写错的登记把整本簿子带崩**（其余登记照常生效）。
 */
export function parseScannerRegistry(raw: string | null | undefined): {
  registry: ScannerRegistry;
  issues: ScannerRegistryIssue[];
} {
  const issues: ScannerRegistryIssue[] = [];
  const declarations: ScannerDeclaration[] = [];
  const text = trimmed(raw);
  if (text.length === 0) return { registry: new ScannerRegistry(), issues };

  for (const chunk of text.split(/[;\n]/)) {
    const entry = chunk.trim();
    if (entry.length === 0) continue;

    const eq = entry.indexOf('=');
    if (eq <= 0) {
      issues.push({ entry, reason: '登记格式应为「扫码枪编号=手术间[,科室]」，这条缺少等号' });
      continue;
    }

    const scanner_id = entry.slice(0, eq).trim();
    const rest = entry.slice(eq + 1).trim();
    if (scanner_id.length === 0) {
      issues.push({ entry, reason: '扫码枪编号为空' });
      continue;
    }
    if (rest.length === 0) {
      issues.push({ entry, reason: '登记里没有手术间，这把枪不参与归属核对' });
      continue;
    }

    const [roomPart, deptPart, ...extra] = rest.split(',');
    if (extra.length > 0) {
      issues.push({ entry, reason: '登记字段过多（只接受「手术间,科室」两段）' });
      continue;
    }

    const room_no = trimmed(roomPart) || null;
    const dept_code = trimmed(deptPart) || null;
    if (room_no === null && dept_code === null) {
      issues.push({ entry, reason: '手术间与科室都是空的，这把枪不参与归属核对' });
      continue;
    }

    declarations.push({ scanner_id, room_no, dept_code });
  }

  return { registry: new ScannerRegistry(declarations), issues };
}

/**
 * 从环境变量读登记簿（`OR_SCANNER_REGISTRY`）。
 *
 * 没配 = 空登记簿（不报错）：登记簿是可选配置，不是必填凭据。
 */
export function readScannerRegistry(env: EnvSnapshot = process.env): ScannerRegistry {
  return parseScannerRegistry(env['OR_SCANNER_REGISTRY']).registry;
}
