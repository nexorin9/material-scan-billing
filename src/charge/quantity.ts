/**
 * 计价数量口径：台账上的「原始数量（包装数）」与「计价数量（换算后）」的取数规则。
 *
 * 单独成模块是因为**回写与重投两条路都要用同一把尺子** ——
 * 首次提交按包装数换算后的计价数量，重投就必须按同一个数重投，
 * 否则「第一次报 5 支、重投报 1 包」这种错账会真的发生。
 *
 * 口径：
 *   - 新行（带换算轨迹）→ 用 `charge_quantity`；
 *   - 老行（升级前写下的，没有计价数量列）→ 沿用原数量（1:1，保持升级前计费行为不变）；
 *   - 新行却缺计价数量（有轨迹列但值为空）→ 判异常，不提交、不猜数。
 */

/** 取计价数量所需的台账行字段 */
export interface ChargeQuantitySource {
  /** 原始数量（包装数） */
  quantity: number;
  /** 计价数量（换算后的） */
  charge_quantity: number | null;
  /** 换算轨迹（新行有、老行没有） */
  quantity_trace: string | null;
}

/**
 * 取计价数量。
 *
 * @returns `{quantity}` 可提交；`{reason}` 不可提交（附中文原因，供核查清单展示）
 */
export function resolveChargeQuantity(
  row: ChargeQuantitySource,
): { quantity: number } | { reason: string } {
  if (row.charge_quantity == null) {
    if (row.quantity_trace == null) {
      // 老行：1:1 沿用原数量
      if (!Number.isInteger(row.quantity) || row.quantity <= 0) {
        return { reason: `计价数量 ${row.quantity} 不是正整数，不取整、不提交` };
      }
      return { quantity: row.quantity };
    }
    return { reason: '台账行缺计价数量（有换算轨迹但数值为空），不提交、不猜数' };
  }
  if (!Number.isInteger(row.charge_quantity) || row.charge_quantity <= 0) {
    return { reason: `计价数量 ${row.charge_quantity} 不是正整数，不取整、不提交` };
  }
  return { quantity: row.charge_quantity };
}
