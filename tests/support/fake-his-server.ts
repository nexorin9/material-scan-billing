/**
 * HIS 耗材计费替身（**测试数据层**）：一个真实的 node:http 服务。
 *
 * 替身说明（与 `tests/charge-client.test.ts` 同一口径）：
 *   - 它是**真实 HTTP 服务**，不是 mock fetch —— 生产客户端与替身走**同一条代码路径**
 *     （原生 fetch → 真实 socket → 真实请求头 / 请求体）；
 *   - 它只存在于 `tests/`（测试数据层），**不是产品的最终对接方式**；
 *     真实对接形态见 `docs/api/his-charging.md`。
 *
 * 它额外做一件产品代码不做的事：**逐条记账**。对端收到哪些（台次 × 耗材码）、
 * 哪一条被收了两次 —— 这正是「重复计费」的可核对口径：
 *   duplicateChargeCount = 收到的明细条数 − 去重后的（台次 × 耗材码）数。
 *
 * 幂等版跑下来这个数必须是 0；朴素重发基线跑下来它必须大于 0 —— 两者的差
 * 就是幂等层省下的重复计费。
 */

import { createServer, type Server } from 'node:http';

/** 对端收到的一条耗材计费明细（字段与出站规范逐字一致） */
export interface FakeHisUse {
  material_code: string;
  quantity: number;
  price_code: string;
  use_time: string;
  fee_category: string;
  medical_insurance_class: string;
}

/** 对端收到的一次提交 */
export interface FakeHisRequest {
  operation_no: string;
  dept_code: string;
  uses: FakeHisUse[];
  received_at: string;
  /** 原始请求体（逐字保存，便于核对字段） */
  raw_body: string;
}

export interface FakeHisServerOptions {
  /** 固定返回状态码（默认 200） */
  status?: number;
  /** 固定延迟（毫秒），用于制造超时场景 */
  delayMs?: number;
  /**
   * 让第 N 个请求（从 1 起）失败（默认 500）。
   *
   * 用途：分批提交场景 —— 「某一批整体失败，其余批照常成功」。
   * 失败的那一批同样计入 requests / entries（对端确实收到了这个请求），
   * 只是没给出结论。
   */
  failRequestIndexes?: number[];
  /** 失败时返回的状态码（默认 500） */
  failStatus?: number;
  /**
   * 每 N 条明细拒收 1 条（默认不拒收）。
   *
   * 用途：月度对账跑测要覆盖「计费被拒」这一档 —— 没有拒收就没有
   * 「被拒条数」这个数，对账包里的那一列永远是 0，等于没验。
   */
  rejectEveryNth?: number;
  /** 拒收时给出的原因码（默认 PRICE_CODE_NOT_FOUND） */
  rejectReasonCode?: string;
}

export interface FakeHisServer {
  /** 基址（不含凭据） */
  baseUrl: string;
  port: number;
  /** 收到的提交列表（按到达顺序） */
  requests: FakeHisRequest[];
  /** 收到的明细逐条展平 */
  entries: Array<{ operation_no: string; material_code: string }>;
  /** 重复计费条目数：同一台次同一耗材码被收了两次以上的条数 */
  duplicateChargeCount: number;
  /** 去重后的计费条目数 */
  distinctChargeCount: number;
  close(): Promise<void>;
}

/** 起一个计费替身；端口由系统分配（0） */
export async function startFakeHisServer(options: FakeHisServerOptions = {}): Promise<FakeHisServer> {
  const requests: FakeHisRequest[] = [];
  const entries: Array<{ operation_no: string; material_code: string }> = [];
  const seen = new Set<string>();
  let duplicateChargeCount = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let operation_no = '';
      let dept_code = '';
      let uses: FakeHisUse[] = [];
      try {
        const parsed = JSON.parse(raw) as {
          operation_no?: unknown;
          dept_code?: unknown;
          uses?: unknown;
        };
        operation_no = String(parsed.operation_no ?? '');
        dept_code = String(parsed.dept_code ?? '');
        uses = Array.isArray(parsed.uses) ? (parsed.uses as FakeHisUse[]) : [];
      } catch {
        // 替身不校验请求体：请求体不合法时按空明细记账，由调用方断言错误码
      }

      requests.push({
        operation_no,
        dept_code,
        uses,
        received_at: new Date().toISOString(),
        raw_body: raw,
      });

      for (const use of uses) {
        const key = `${operation_no}::${use.material_code}`;
        if (seen.has(key)) duplicateChargeCount += 1;
        else seen.add(key);
        entries.push({ operation_no, material_code: use.material_code });
      }

      // 指定批次失败：该请求对端确实收到了，但没给出结论（分批场景用）
      const requestIndex = requests.length;
      const shouldFail = (options.failRequestIndexes ?? []).includes(requestIndex);
      const status = shouldFail ? (options.failStatus ?? 500) : (options.status ?? 200);
      // 逐条拒收：每 N 条拒 1 条（默认不拒收）
      const rejectEveryNth = options.rejectEveryNth ?? 0;
      const rejectedUses: Array<{ material_code: string; reason_code: string }> = [];
      const acceptedUses: Array<{ material_code: string }> = [];
      uses.forEach((use, index) => {
        const rejected = rejectEveryNth > 0 && (index + 1) % rejectEveryNth === 0;
        if (rejected) {
          rejectedUses.push({
            material_code: use.material_code,
            reason_code: options.rejectReasonCode ?? 'PRICE_CODE_NOT_FOUND',
          });
        } else {
          acceptedUses.push({ material_code: use.material_code });
        }
      });
      const payload = shouldFail
        ? JSON.stringify({ message: `batch ${requestIndex} failed on purpose` })
        : JSON.stringify({
            accepted: acceptedUses,
            rejected: rejectedUses,
          });
      const respond = (): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(payload);
      };
      if (options.delayMs && options.delayMs > 0) setTimeout(respond, options.delayMs);
      else respond();
    });
    res.on('error', () => {
      // 客户端超时后主动断开：忽略写回失败（替身侧）
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    entries,
    get duplicateChargeCount(): number {
      return duplicateChargeCount;
    },
    get distinctChargeCount(): number {
      return seen.size;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
