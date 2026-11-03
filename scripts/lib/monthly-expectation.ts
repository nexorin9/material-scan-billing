/**
 * 月度跑测的**独立预期**：只按合成数据与产品公开的判定规则算出「这条扫码该是什么结论」，
 * 不碰产品的判定代码（`src/engine/`），再用它逐条核对产品实际给出的结论。
 *
 * 为什么要有这一层：
 *   「跑完了、没报错」不等于「结论是对的」。跑测必须能说清
 *   「这一条本该判 BOUND 却判成了 CROSS_OP_DUP」—— 否则结论分布只是产品的自说自话。
 *
 * 判定顺序（与 `src/engine/conclude.ts` 公开的规则一致，**独立写一遍**）：
 *   ⓪ 同一台次里这个耗材码已经入过台账 → NOT_REGISTERED（重复扫码）
 *   ① 台次查不到                          → NOT_REGISTERED（台次未建档）
 *   ② 台次已关台                          → CLOSED（已关台，不自动补录）
 *   ③ 耗材码不在主数据 / 已停用            → NOT_REGISTERED（耗材未建档 / 已停用）
 *   ④ 同一耗材码已绑在**别的**台次上        → CROSS_OP_DUP（跨台次重复，先到者保留）
 *   ⑤ 其余                                → BOUND
 *
 * 数据侧另有一列 `expected_conclusion`（合成器按「耗材码目录级、台次各自独立」写的预期）。
 * 本模块的独立预期与那一列的差异会单独报出来 —— 差异本身是一条**口径发现**：
 * 目录级耗材码在多个台次复用时，产品按「单件唯一」口径判跨台次重复。
 */

/** 合成器写在扫描条目上的类别（对照用） */
export const SYNTH_CATEGORY = {
  normal: 'normal',
  unregistered: 'unregistered',
  crossOpDup: 'cross_op_dup',
  duplicateScan: 'duplicate_scan',
  operationClosed: 'operation_closed',
  inactiveMaterial: 'inactive_material',
} as const;

/** 独立预期用到的原因码 */
export const EXPECT_REASON = {
  operationNotFound: 'OPERATION_NOT_FOUND',
  operationClosed: 'OPERATION_CLOSED',
  materialNotRegistered: 'MATERIAL_NOT_REGISTERED',
  materialInactive: 'MATERIAL_INACTIVE',
  crossOpDuplicate: 'CROSS_OP_DUPLICATE_MATERIAL',
  duplicateScan: 'DUPLICATE_SCAN',
  duplicateInBatch: 'DUPLICATE_IN_BATCH',
} as const;

/** 一条预期 */
export interface ExpectedItem {
  /** 台次号 */
  operation_no: string;
  /** 规范耗材码 */
  material_code: string;
  /** 独立预期结论 */
  expected_conclusion: string;
  /** 独立预期原因码 */
  expected_reason_code: string | null;
  /** 数据侧自带的预期结论（对照用） */
  data_expected_conclusion: string;
  /** 数据侧自带的类别 */
  category: string;
  /** 该耗材码此前绑在哪个台次（跨台次重复时给出） */
  duplicate_of_operation_no: string | null;
}

/** 排台台次 */
export interface OperationFact {
  operation_no: string;
  status: string;
}

/** 耗材主数据 */
export interface MaterialFact {
  material_code: string;
  active: boolean;
}

/** 合成扫描条目（来自 `data/synthetic/scan-items.csv`） */
export interface ScanItemFact {
  /** 批次号（设备侧那一批的身份）—— 批内重复的判据靠它 */
  scan_batch_id: string;
  operation_no: string;
  room_no: string;
  scanner_id: string;
  seq: number;
  material_code: string;
  canonical_code: string;
  code_form: string;
  quantity: number;
  scan_time: string;
  batch_no: string;
  category: string;
  expected_conclusion: string;
  expected_reason_code: string;
}

/**
 * 逐条算出独立预期结论。
 *
 * @param items   合成扫描条目（**按扫码顺序**）
 * @param operations 排台台次（台次号 → 台次）
 * @param materials  耗材主数据（耗材码 → 主数据行）
 */
export function computeExpectedConclusions(
  items: readonly ScanItemFact[],
  operations: ReadonlyMap<string, OperationFact>,
  materials: ReadonlyMap<string, MaterialFact>,
): ExpectedItem[] {
  /** 耗材码 → 首个绑上台次（跨台次重复的判据） */
  const boundByCode = new Map<string, string>();
  /** 台次号 → 该台次已绑上的耗材码集合（同台次重复扫码的判据） */
  const boundInOperation = new Map<string, Set<string>>();
  /** 本批内已出现的（台次 × 耗材码）—— 批内重复的判据 */
  const seenInBatch = new Set<string>();
  let currentBatchId = '';

  const out: ExpectedItem[] = [];

  for (const item of items) {
    const batchId = item.scan_batch_id;
    if (batchId !== currentBatchId) {
      currentBatchId = batchId;
      seenInBatch.clear();
    }
    const batchKey = `${item.operation_no}|${item.canonical_code}`;

    const operation = operations.get(item.operation_no);
    const material = materials.get(item.canonical_code);
    const boundCodes = boundInOperation.get(item.operation_no) ?? new Set<string>();

    let conclusion: string;
    let reason: string | null = null;
    let duplicateOf: string | null = null;

    if (seenInBatch.has(batchKey)) {
      // 批内重复：同一批里同一个（台次 × 耗材码）出现第二次
      conclusion = 'NOT_REGISTERED';
      reason = EXPECT_REASON.duplicateInBatch;
    } else if (boundCodes.has(item.canonical_code)) {
      // ⓪ 同台次重复扫码
      conclusion = 'NOT_REGISTERED';
      reason = EXPECT_REASON.duplicateScan;
    } else if (!operation) {
      // ① 台次查不到
      conclusion = 'NOT_REGISTERED';
      reason = EXPECT_REASON.operationNotFound;
    } else if (operation.status === 'closed') {
      // ② 台次已关台
      conclusion = 'CLOSED';
      reason = EXPECT_REASON.operationClosed;
    } else if (!material) {
      // ③ 耗材未建档
      conclusion = 'NOT_REGISTERED';
      reason = EXPECT_REASON.materialNotRegistered;
    } else if (!material.active) {
      // ③ 耗材已停用
      conclusion = 'NOT_REGISTERED';
      reason = EXPECT_REASON.materialInactive;
    } else {
      const origin = boundByCode.get(item.canonical_code);
      if (origin && origin !== item.operation_no) {
        // ④ 跨台次重复
        conclusion = 'CROSS_OP_DUP';
        reason = EXPECT_REASON.crossOpDuplicate;
        duplicateOf = origin;
      } else {
        // ⑤ 绑定成立
        conclusion = 'BOUND';
      }
    }

    if (conclusion === 'BOUND') {
      boundByCode.set(item.canonical_code, item.operation_no);
      boundCodes.add(item.canonical_code);
      boundInOperation.set(item.operation_no, boundCodes);
    }
    seenInBatch.add(batchKey);

    out.push({
      operation_no: item.operation_no,
      material_code: item.canonical_code,
      expected_conclusion: conclusion,
      expected_reason_code: reason,
      data_expected_conclusion: item.expected_conclusion,
      category: item.category,
      duplicate_of_operation_no: duplicateOf,
    });
  }

  return out;
}

/** 结论分布（按结论名计数） */
export function distributionOf(items: readonly { expected_conclusion: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    out[item.expected_conclusion] = (out[item.expected_conclusion] ?? 0) + 1;
  }
  return out;
}
