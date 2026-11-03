/**
 * 绑定判定（主干调用面）：一条扫码 → 一个绑定结论 + 一行台账。
 *
 * **判定规则本体在 `src/engine/`**：三层校验（`validate-code.ts`）、台次状态（`operation.ts`）、
 * 五种结论归类（`conclude.ts`）。本文件只做两件事：
 *   ① 把判定结果落到台账（走幂等占位三段租约）；
 *   ② 把异常结论升成带台次上下文的核查条目。
 * 批量结算落在 `src/engine/settle.ts`。
 *
 * 语义来源（源产品主路径）：源产品按**目标实体**路由批量唯一消息，并**逐条取回执**；
 * 源注释明示「单条投递失败是普通结果而非中断」，不得丢弃已产生的回执。
 * 本文件照此语义：一条扫码失败只让**这一条**落 rejected，同批其余照常给结论。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { ConclusionCode } from '../domain/scan-event.js';
import {
  DEFAULT_IDEMPOTENCY_KEY_PROFILE,
  deriveIdempotencyKeyForProfile,
  type ConfigurableIdempotencyKeyProfile,
} from '../domain/idempotency.js';
import {
  countBindings,
  insertBinding,
  listBindingsByCodeAndOperation,
  type BindingDuplicateCandidate,
} from '../ledger/binding-repo.js';
import { buildParseTrace, parseCode } from '../ingest/codes.js';
import { claim, confirm, release } from '../ledger/claim.js';
import { concludeAndRecord } from './conclude.js';
import type { ScannerContext } from './operation.js';
import { serializeQuantityTrace } from './units.js';

/** 计费状态：本轮尚未接入计费通道，统一停在「未提交」 */
export type ChargeState = 'not_submitted' | 'submitted' | 'accepted' | 'rejected' | 'pending_retry';

/** 结论原因码（逐条可追踪，落到回执与核查任务上） */
export { REASON_OPERATION_NOT_FOUND } from './operation.js';
export { REASON_MATERIAL_NOT_REGISTERED } from './validate-code.js';
export { REASON_CROSS_OP_DUPLICATE } from './conclude.js';
export const REASON_DUPLICATE_SCAN = 'DUPLICATE_SCAN';
/** 批号差异原因码：同一耗材同一台次，但批号与已入台账的那笔不同（v1 档位判重复） */
export const REASON_DUPLICATE_BATCH_MISMATCH = 'DUPLICATE_SCAN_BATCH_MISMATCH';
export const REASON_CLAIM_BUSY = 'CLAIM_BUSY';
export const REASON_INTERNAL_ERROR = 'INTERNAL_ERROR';

/** 判定结果（accepted 数组的元素形状，与 spec.md 逐字一致） */
export interface BindingOutcome {
  material_code: string;
  operation_no: string;
  bound: boolean;
  conclusion: ConclusionCode;
  reason_code: string | null;
  /**
   * 统一错误码（ERR_*）：与结构化日志、核查条目、计费回执行展示同一个码。
   * 绑定成功时为 null。
   */
  error_code: string | null;
  charge_state: ChargeState;
  /** 补充说明（异常时的现场信息，异常条目的排查依据） */
  detail?: string | null;
}

export interface BindContext {
  db: DatabaseSync;
  /** 扫码事件上下文（台次、手术间、扫码枪） */
  operation_no: string;
  room_no: string;
  scanner_id: string;
  /**
   * 事件自带的科室上下文（可空）。
   *
   * 参与**归属双因子核对**：事件科室与排台科室对不上时拒绝绑定。
   * 没带就取扫码枪位置登记簿里登记的科室（见 `scanner`）。
   */
  dept_code?: string | null;
  /** 扫码枪位置登记（可空；没登记则不参与科室因子的核对） */
  scanner?: ScannerContext | null;
  /** 已归一的耗材条目 */
  material_code: string;
  raw_code: string;
  quantity: number;
  /** 批号（v2 档位的去重维度；v1 档位也记进台账供事后核对） */
  batch_no?: string | null;
  /** 码制：UDI / GS1_AI01 / INTERNAL */
  code_form?: string | null;
  /** 码制解析轨迹（JSON 字符串；落台账供事后核对） */
  code_parse_trace?: string | null;
  /** 幂等键档位（默认 v1：同码同台次只算一次） */
  key_profile?: ConfigurableIdempotencyKeyProfile;
  /**
   * 本次投递的标识（溯源用）。
   *
   * 落到台账行的 request_id 列与占位/确认的审计行上：
   * 按一个 request_id 就能把「设备报了什么 → 落了哪几行台账 → 怎么处置」串起来。
   */
  request_id?: string | null;
  /**
   * 业务使用时间（设备上报的扫码时间，归一后落库）。
   *
   * 月度对账按**业务月**切账期，用的就是它 —— 不是台账落账时间。
   */
  use_time?: string | null;
}

/** 维度级重复判定结果 */
interface DuplicateVerdict {
  reason_code: string;
  error_code: string;
  detail: string;
}

/**
 * 维度级重复判定：这一笔是不是已经入过台账。
 *
 * 为什么要按**维度**判、而不只看幂等键：
 *   - 老行（legacy 键）与新行（v1 键）字节不同，但业务上都是「同码同台次只算一次」，
 *     必须互相挡住 —— 否则老行会被当成新事件再计一笔；
 *   - v2 档位下同码同台次可以有多行（不同批号），判重要带批号维度。
 *
 * 口径：
 *   v1 / legacy 档位 —— 同码同台次已有行即重复；批号不同也给重复，
 *                        但原因码标成「批号差异」，让护士长看得出是两批撞上了；
 *   v2 档位         —— 同码同台次**同批号**已有行即重复；
 *                        批号不同且两边的批号都明确 → 视为另一笔真实消耗，允许各算一次；
 *                        有一边批号不明 → 分不清是不是同一批，按重复处理（不冒重复计费风险）。
 */
export function judgeDuplicate(
  existing: readonly BindingDuplicateCandidate[],
  profile: 'legacy' | 'v1' | 'v2',
  batch_no: string | null,
): DuplicateVerdict | null {
  if (existing.length === 0) return null;
  const incomingBatch = (batch_no ?? '').trim();

  if (profile !== 'v2') {
    // v1 / legacy：同码同台次只算一次（批号不参与去重）
    const first = existing[0]!;
    const firstBatch = (first.batch_no ?? '').trim();
    if (firstBatch.length > 0 && incomingBatch.length > 0 && firstBatch !== incomingBatch) {
      return {
        reason_code: REASON_DUPLICATE_BATCH_MISMATCH,
        error_code: 'ERR_DUPLICATE_BATCH_MISMATCH',
        detail:
          `耗材 ${first.material_code ?? ''} 在台次 ${first.operation_no} 已入台账（批号 ${firstBatch}），` +
          `本条批号 ${incomingBatch}；v1 档位同码同台次只算一次，本条不重复计费`,
      };
    }
    return {
      reason_code: REASON_DUPLICATE_SCAN,
      error_code: 'ERR_DUPLICATE_SCAN',
      detail: `耗材 ${first.material_code ?? ''} 在台次 ${first.operation_no} 已入台账，本条为重复扫码，不重复计费`,
    };
  }

  // v2 档位：批号参与去重
  for (const row of existing) {
    const rowBatch = (row.batch_no ?? '').trim();
    const sameV2Row = row.key_profile === 'v2';
    if (sameV2Row && rowBatch === incomingBatch) {
      return {
        reason_code: REASON_DUPLICATE_SCAN,
        error_code: 'ERR_DUPLICATE_SCAN',
        detail:
          `耗材 ${row.material_code ?? ''} 在台次 ${row.operation_no} 的批号 ${incomingBatch} 已入台账，` +
          `本条为同一批的重复扫码，不重复计费`,
      };
    }
    if (!sameV2Row) {
      // 老行 / v1 行：批号明确且与本条不同 → 另一笔真实消耗，不判重复
      if (rowBatch.length > 0 && incomingBatch.length > 0 && rowBatch !== incomingBatch) {
        continue;
      }
      // 有一边批号不明：分不清是不是同一批 → 按重复处理（宁可少算，不可重复计费）
      return {
        reason_code: REASON_DUPLICATE_SCAN,
        error_code: 'ERR_DUPLICATE_SCAN',
        detail:
          `耗材 ${row.material_code ?? ''} 在台次 ${row.operation_no} 已有台账行（批号 ${rowBatch || '未记录'}），` +
          `本条批号 ${incomingBatch || '未记录'}；批号不明时无法证明是另一批，按重复处理，不重复计费`,
      };
    }
  }
  return null;
}

/**
 * 判一条并落一行台账。
 *
 * 幂等键按**档位**派生（`src/domain/idempotency.ts`）：
 *   v1 —— sha256("v1|耗材码|台次")：同码同台次只算一次（默认）；
 *   v2 —— sha256("v2|耗材码|台次|批号")：同码同台次**按批号**各算一次。
 * 两档都与时间戳 / 重试次数 / 扫码枪编号无关。
 *
 * 写入路径走「幂等占位」三段租约（`src/ledger/claim.ts`）：
 *   claim   —— 原子占位，拿到租约才允许写台账（并发同键只有一个能拿到）；
 *   confirm —— 落台账成功后确认，同键再次投递直接判重复；
 *   release —— 写失败则释放并记原因，租约到期也会自动释放（崩溃续跑）。
 * 台账上 `idempotency_key` 与「同码同台次（+ 批号）」两道唯一索引兜底，
 * 重复扫码**不产生第二行台账、也不会触发第二次计费**。
 */
export function bindOne(db: DatabaseSync, ctx: BindContext): BindingOutcome {
  const base: BindingOutcome = {
    material_code: ctx.material_code,
    operation_no: ctx.operation_no,
    bound: false,
    conclusion: 'NOT_REGISTERED',
    reason_code: null,
    error_code: null,
    charge_state: 'not_submitted',
  };

  let judged: ReturnType<typeof concludeAndRecord>;
  try {
    // 判定 + 异常条目升核查条目（带台次上下文）
    judged = concludeAndRecord(db, {
      db,
      operation_no: ctx.operation_no,
      room_no: ctx.room_no,
      scanner_id: ctx.scanner_id,
      dept_code: ctx.dept_code ?? null,
      scanner: ctx.scanner ?? null,
      material_code: ctx.material_code,
      raw_code: ctx.raw_code,
      quantity: ctx.quantity,
    });
  } catch (error) {
    // 查表失败也算「这一条的普通结果」，不中断同批
    return {
      ...base,
      reason_code: REASON_INTERNAL_ERROR,
      error_code: 'ERR_INTERNAL',
      conclusion: 'NOT_REGISTERED',
    };
  }

  if (judged.conclusion !== 'BOUND' || !judged.material) {
    return {
      ...base,
      conclusion: judged.conclusion,
      reason_code: judged.reason_code,
      error_code: judged.error_code,
    };
  }

  const keyProfile = ctx.key_profile ?? DEFAULT_IDEMPOTENCY_KEY_PROFILE;
  const derived = deriveIdempotencyKeyForProfile(
    {
      material_code: ctx.material_code,
      operation_no: ctx.operation_no,
      batch_no: ctx.batch_no ?? null,
    },
    keyProfile,
  );
  const idempotency_key = derived.key;

  // ⓪ 维度级重复判定：同一耗材同一台次下已经入过账的（含历史格式的老行）
  //   —— 老行不会被当成新事件再计一笔；v2 档位下不同批号各算一次。
  const existing = listBindingsByCodeAndOperation(db, ctx.material_code, ctx.operation_no);
  const duplicate = judgeDuplicate(existing, derived.profile, ctx.batch_no ?? null);
  if (duplicate) {
    return {
      ...base,
      reason_code: duplicate.reason_code,
      error_code: duplicate.error_code,
      detail: duplicate.detail,
    };
  }

  // ① 占位：拿到租约才允许写台账
  const lease = claim(db, idempotency_key, {
    operation_no: ctx.operation_no,
    material_code: ctx.material_code,
    scanner_id: ctx.scanner_id,
    request_id: ctx.request_id ?? null,
  });
  if (lease.status === 'duplicate') {
    // 这笔已入台账（同键重复投递）
    return { ...base, reason_code: REASON_DUPLICATE_SCAN, error_code: 'ERR_DUPLICATE_SCAN' };
  }
  if (lease.status === 'busy') {
    // 别人正处理这一条：不重复处理，也不重复计费
    return { ...base, reason_code: REASON_CLAIM_BUSY, error_code: 'ERR_CLAIM_BUSY' };
  }
  const token = lease.token as string;

  // 码制解析轨迹：**调用方没给就按原始码现算一份** ——
  // 台账上的「原始码 + 解析轨迹」是硬保证（事后核对要看的就是这两样），
  // 不能因为调用路径不同就缺一块。
  const parsedMeta =
    ctx.code_parse_trace && ctx.code_parse_trace.length > 0
      ? null
      : ctx.raw_code && ctx.raw_code.trim().length > 0
        ? parseCode(ctx.raw_code)
        : null;
  const codeForm = ctx.code_form ?? parsedMeta?.code_form ?? null;
  const codeParseTrace =
    ctx.code_parse_trace && ctx.code_parse_trace.length > 0
      ? ctx.code_parse_trace
      : parsedMeta
        ? JSON.stringify(buildParseTrace(parsedMeta))
        : null;

  try {
    insertBinding(db, {
      idempotency_key,
      operation_no: ctx.operation_no,
      room_no: ctx.room_no,
      dept_code: judged.operation?.dept_code ?? '',
      material_code: ctx.material_code,
      quantity: ctx.quantity,
      price_code: judged.material.price_code,
      fee_category: judged.material.fee_category,
      medical_insurance_class: judged.material.medical_insurance_class,
      conclusion: 'BOUND',
      status: 'bound',
      raw_code: ctx.raw_code,
      key_profile: derived.profile,
      batch_no: ctx.batch_no ?? null,
      code_form: codeForm,
      code_parse_trace: codeParseTrace,
      // 计价数量与换算轨迹：原始数量（包装数）与计价数量（换算后）都留在行上，
      // 计费回写用计价数量，事后核对看得到「凭什么算这几个支」。
      charge_quantity: judged.quantity_conversion?.trace.charge_quantity ?? null,
      quantity_trace: judged.quantity_conversion
        ? serializeQuantityTrace(judged.quantity_conversion.trace)
        : null,
      // 归属核对的两侧都落台账：事后能核对「当时核的是哪两个手术间」
      event_room_no: ctx.room_no,
      master_room_no: judged.operation?.room_no ?? ctx.room_no,
      event_dept_code: judged.attribution?.event_dept_code ?? ctx.dept_code ?? null,
      // 溯源：这一行是被哪一次投递带进来的
      request_id: ctx.request_id ?? null,
      // 业务使用时间：月度对账按业务月切账期用它（不是落账时间）
      use_time: ctx.use_time ?? null,
    });
  } catch (error) {
    // 唯一索引冲突 = 同一条扫码已入过台账；释放占位并按「重复扫码」落 rejected，不抛给主流程
    release(db, idempotency_key, token, REASON_DUPLICATE_SCAN, {
      request_id: ctx.request_id ?? null,
    });
    return { ...base, reason_code: REASON_DUPLICATE_SCAN, error_code: 'ERR_DUPLICATE_SCAN' };
  }

  // ② 确认：这一笔已落台账，同键再次投递直接判重复
  try {
    confirm(db, idempotency_key, token, { request_id: ctx.request_id ?? null });
  } catch (error) {
    // 确认失败不静默改数据：台账行已落，占位会到期自动释放并被续跑接管（不会重复写行）
  }

  return {
    material_code: ctx.material_code,
    operation_no: ctx.operation_no,
    bound: true,
    conclusion: 'BOUND',
    reason_code: null,
    error_code: null,
    charge_state: 'not_submitted',
  };
}

/** 台账行数（演示脚本回查用） */
export function ledgerRowCount(db: DatabaseSync): number {
  return countBindings(db);
}
