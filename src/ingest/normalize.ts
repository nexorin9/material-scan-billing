/**
 * 字段标准化：UDI / GS1 AI(01) / 院内编码 → 规范耗材码。
 *
 * **纯字段映射，不含任何临床判断**：只回答「设备扫出来的这个码，对应主数据里的哪一个键」，
 * 不回答「这个耗材能不能用」。能否绑定由判定引擎（`src/engine/`）决定。
 *
 * 三种码制（与 spec.md「最小数据格式与字段要求」一致）：
 *   UDI        —— 带 GS1 应用标识符括号的码，含生产标识（如 (10) 批号 / (17) 失效期 / (21) 序列号）
 *   GS1_AI01   —— 裸 `01` + 14 位 GTIN 的包装码
 *   INTERNAL   —— 院内自编码（不走 GS1 规则）
 *
 * 归一后统一落到**院内耗材主数据键**：
 *   UDI / GS1_AI01 → 取 (01) 应用标识符里的 DI（14 位 GTIN）
 *   INTERNAL       → 原样（去空白）
 *
 * 码制的**深解析**（GTIN 校验位、DI/PI 分离、批号与失效期提取、解析轨迹）
 * 在 `src/ingest/codes.ts`：本模块只做字段级映射，深解析落地后**委托调用**，
 * 归一结果与解析轨迹同源，不在这里另写一份解析规则。
 */

import type { CodeForm, CodeParseTrace, NormalizedMaterial, ScanEvent, ScanItem } from '../domain/scan-event.js';
import { buildParseTrace, parseCode } from './codes.js';

export { detectCodeForm } from './codes.js';

export interface CodeParse {
  /** 码制 */
  code_form: CodeForm;
  /** 归一后的院内耗材主数据键 */
  canonical_code: string;
  /** 设备上报的原始码 */
  raw_code: string;
  /** 批号（从生产标识里提取到时才有） */
  batch_no: string | null;
  /** 解析轨迹（落台账，事后可核对） */
  trace: CodeParseTrace;
}

/** 归一耗材码：UDI / GS1_AI01 → DI；INTERNAL → 原样 */
export function normalizeMaterialCode(code: string): CodeParse {
  const parsed = parseCode(code);
  return {
    code_form: parsed.code_form,
    canonical_code: parsed.canonical_code,
    raw_code: parsed.raw_code,
    batch_no: parsed.batch_no,
    trace: buildParseTrace(parsed),
  };
}

/** 归一单条扫码条目：码 → 规范耗材码，数量与扫描时间归一 */
export function normalizeScanItem(item: ScanItem): NormalizedMaterial {
  const parsed = normalizeMaterialCode(item.material_code);
  const parsedTime = new Date(item.scan_time);
  const normalizedTime = Number.isNaN(parsedTime.getTime()) ? item.scan_time : parsedTime.toISOString();
  return {
    material_code: parsed.canonical_code,
    raw_code: parsed.raw_code,
    code_form: parsed.code_form,
    quantity: item.quantity,
    scan_time: normalizedTime,
    batch_no: item.batch_no ?? parsed.batch_no ?? null,
    parse_trace: parsed.trace,
  };
}

/** 归一整批扫码事件 */
export function normalizeScanEvent(event: ScanEvent): {
  event: ScanEvent;
  items: NormalizedMaterial[];
} {
  return {
    event,
    items: event.scans.map(normalizeScanItem),
  };
}
