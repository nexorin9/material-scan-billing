/**
 * 台次状态判定 + **台次归属双因子交叉核对**：排台台次在不在、是不是已经关台、
 * 归哪个科室与手术间，以及「这次扫码到底发生在哪台手术上」。
 *
 * 台次是耗材绑定的**锚点** —— 台次不存在就没有「绑到哪台」可言，台次已关台则本轮
 * 不再接受新耗材（术中增减 / 退库的冲正与差额不属本轮）。
 *
 * 主数据权威 = 手术排台；本模块**每次现读**，不缓存快照 —— 排台改了下一次判定立刻按新值判
 * （导入即生效、不重启）。
 *
 * ## 归属双因子（room_no × dept_code）
 *
 * 事件里带的是**事件自己说的**手术间，排台里带的是**排台说的**手术间。
 * 两个说法对不上时，可能是台次号挂错台、扫码枪挪了间、或者有人拿别人的枪扫 ——
 * 绑错台就是错账，所以**任一因子对不上就一律拒绝、转人工，绝不按单一因子猜绑**。
 *
 *   因子 A（手术间 room_no）：事件手术间 vs 排台手术间
 *   因子 B（科室 dept_code）：事件科室上下文 vs 排台科室
 *
 * 「事件科室上下文」从哪来：优先取事件自带的科室；事件没带时取**扫码枪位置登记簿**
 * 里登记的科室（枪固定在某间手术间，那间手术间就属于某个科室 —— 这是与手术间
 * 相互独立的第二个信息源）。
 *
 * 另外还核一次**配置漂移**：登记簿里这台枪登记的手术间与事件自己说的手术间对不上，
 * 说明枪挪了间 / 登记过期 / 事件不是这台枪发的 —— 这条单独记审计（配置问题要留痕），
 * 并按归属冲突处理。
 *
 * 没有登记簿时：只有因子 A 参与核对（因子 B 无从判断，不硬凑）。
 */

import type { DatabaseSync } from 'node:sqlite';

import { findOperation } from '../ledger/binding-repo.js';

/** 台次状态：开台 / 已关台 / 排台里查不到 */
export type OperationStatus = 'open' | 'closed' | 'unknown';

export const REASON_OPERATION_NOT_FOUND = 'OPERATION_NOT_FOUND';
export const REASON_OPERATION_CLOSED = 'OPERATION_CLOSED';

/** 台次归属冲突原因码（双因子核对未通过） */
export const REASON_OPERATION_ATTRIBUTION_CONFLICT = 'OPERATION_ATTRIBUTION_CONFLICT';

/** 参与归属核对的因子 */
export type AttributionFactor = 'room_no' | 'dept_code';

/** 扫码枪位置登记（事件侧科室上下文的来源） */
export interface ScannerContext {
  /** 扫码枪编号 */
  scanner_id?: string | null;
  /** 登记的手术间 */
  room_no?: string | null;
  /** 登记的科室 */
  dept_code?: string | null;
}

/** 事件侧上下文 */
export interface AttributionEventContext {
  /** 事件自己说的手术间 */
  room_no?: string | null;
  /** 事件自带的科室上下文（没有则取扫码枪登记的科室） */
  dept_code?: string | null;
}

/** 双因子核对结论 */
export interface AttributionVerdict {
  /** 双因子是否都一致（true = 允许绑定） */
  ok: boolean;
  /** 事件侧手术间 */
  event_room_no: string | null;
  /** 排台主数据里的手术间 */
  master_room_no: string | null;
  /** 事件侧科室上下文 */
  event_dept_code: string | null;
  /** 排台主数据里的科室 */
  master_dept_code: string | null;
  /** 对不上的因子清单（空数组 = 全部一致） */
  mismatches: AttributionFactor[];
  /** 扫码枪登记与事件本身对不上（配置漂移：枪挪了间 / 登记过期） */
  config_drift: boolean;
  /** 中文说明（说明差在哪） */
  detail: string;
}

/** 台次判定结果 */
export interface OperationResolution {
  operation_no: string;
  /** 开台 / 已关台 / 排台里查不到 */
  status: OperationStatus;
  /** 排台里查得到 */
  found: boolean;
  /** 手术间号（查不到时为 null） */
  room_no: string | null;
  /** 科室编码（查不到时为 null） */
  dept_code: string | null;
  /** 关台时间（关台台次才有） */
  closed_at: string | null;
  /** 非 open 时的原因码 */
  reason_code: string | null;
  /** 中文说明 */
  message: string | null;
  /**
   * 双因子归属核对结论（排台里查不到时为 null —— 没有锚点，无从核对）。
   *
   * 台次**已关台**时这里照样给出结论：关台条目也要带上下文进核查清单，
   * 护士长才看得出「这台扫错了地方」还是「这台已经关了」。
   */
  attribution: AttributionVerdict | null;
}

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length === 0 ? null : t;
}

/**
 * 双因子归属核对（纯函数：不碰数据库，便于单测与复用）。
 *
 * @param master 排台主数据里的手术间与科室
 * @param event  事件侧上下文（事件自己说的手术间 / 科室）
 * @param scanner 扫码枪位置登记（可空）
 */
export function checkAttribution(
  master: { room_no: string | null; dept_code: string | null },
  event: AttributionEventContext = {},
  scanner?: ScannerContext | null,
): AttributionVerdict {
  const masterRoom = trimmed(master.room_no);
  const masterDept = trimmed(master.dept_code);
  const eventRoom = trimmed(event.room_no);
  const scannerRoom = trimmed(scanner?.room_no);
  const scannerDept = trimmed(scanner?.dept_code);

  // 事件侧科室上下文：事件自带的优先；没带就取扫码枪登记的科室。
  const eventDept = trimmed(event.dept_code) ?? scannerDept;

  const mismatches: AttributionFactor[] = [];
  const notes: string[] = [];

  // 因子 A：手术间 —— 事件说的 vs 排台说的
  if (eventRoom !== null && masterRoom !== null && eventRoom !== masterRoom) {
    mismatches.push('room_no');
    notes.push(`事件手术间 ${eventRoom} 与排台手术间 ${masterRoom} 不是同一间`);
  }

  // 因子 B：科室 —— 事件上下文 vs 排台说的
  if (eventDept !== null && masterDept !== null && eventDept !== masterDept) {
    mismatches.push('dept_code');
    notes.push(`事件科室 ${eventDept} 与排台科室 ${masterDept} 不是同一个科室`);
  }

  // 配置漂移：登记簿说这把枪在 A 间，事件却说自己来自 B 间
  const configDrift = scannerRoom !== null && eventRoom !== null && scannerRoom !== eventRoom;
  if (configDrift) {
    notes.push(
      `扫码枪 ${scanner?.scanner_id ?? '未编号'} 登记在手术间 ${scannerRoom}，事件却来自手术间 ${eventRoom}（登记与事件不一致）`,
    );
  }

  return {
    // 配置漂移同样是**冲突**：登记与事件对不上时，这条事件的来源本身就不可信，
    // 不能因为「事件手术间与排台碰巧一致」就放行。
    ok: mismatches.length === 0 && !configDrift,
    event_room_no: eventRoom,
    master_room_no: masterRoom,
    event_dept_code: eventDept,
    master_dept_code: masterDept,
    mismatches,
    config_drift: configDrift,
    detail:
      notes.length > 0
        ? notes.join('；')
        : `事件手术间 ${eventRoom ?? '未提供'} / 事件科室 ${eventDept ?? '未提供'}，与排台手术间 ${masterRoom ?? '未登记'} / 排台科室 ${masterDept ?? '未登记'} 一致`,
  };
}

/** 解析台次的输入上下文 */
export interface OperationResolveContext extends AttributionEventContext {
  /** 扫码枪位置登记（可空；没登记则不参与科室因子的核对） */
  scanner?: ScannerContext | null;
}

/**
 * 解析台次：查排台主数据 → 给状态判定 + 双因子归属核对。
 *
 * 查不到返回 unknown（不是错误，只是排台里没有这个台次号）。
 */
export function resolveOperation(
  db: DatabaseSync,
  operation_no: string,
  context: OperationResolveContext = {},
): OperationResolution {
  const row = findOperation(db, operation_no);

  if (!row) {
    return {
      operation_no,
      status: 'unknown',
      found: false,
      room_no: null,
      dept_code: null,
      closed_at: null,
      reason_code: REASON_OPERATION_NOT_FOUND,
      message: `排台台次 ${operation_no} 不在手术排台主数据中`,
      attribution: null,
    };
  }

  const attribution = checkAttribution(
    { room_no: row.room_no, dept_code: row.dept_code },
    { room_no: context.room_no, dept_code: context.dept_code },
    context.scanner,
  );

  if (row.status === 'closed') {
    return {
      operation_no,
      status: 'closed',
      found: true,
      room_no: row.room_no,
      dept_code: row.dept_code,
      closed_at: row.closed_at,
      reason_code: REASON_OPERATION_CLOSED,
      message: `台次 ${operation_no} 已关台（${row.closed_at ?? '关台时间未登记'}）`,
      attribution,
    };
  }

  return {
    operation_no,
    status: 'open',
    found: true,
    room_no: row.room_no,
    dept_code: row.dept_code,
    closed_at: null,
    reason_code: null,
    message: null,
    attribution,
  };
}

/** 这个台次是不是还在开台（可接受新耗材） */
export function isOperationOpen(resolution: OperationResolution): boolean {
  return resolution.status === 'open';
}
