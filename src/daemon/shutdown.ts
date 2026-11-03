/**
 * 优雅停机：收到 SIGTERM / SIGINT 之后**先停接新的、再把在途的做完**、最后才退出。
 *
 * 为什么必须这样：手术室的一次扫码如果处理到一半被砍掉，
 * 会出现「扫码枪以为已经扫了、台账里没有、耗材也没计费」的三方不一致 ——
 * 事后没人说得清这笔耗材到底用没���。
 *
 * 停机顺序（本模块的硬约束）：
 *   ① 置停止标志：**不再接收新事件**（目录路不再捡新文件、入站路不再接新连接）；
 *   ② 等在途批次结算完成（带超时上限，超时就如实记录，不无限等）；
 *   ③ 落盘并关闭 SQLite 连接；
 *   ④ 以退出码 0 退出 —— 正常停机不是故障。
 *
 * 在途计数的口径：一个批次从「开始处理」到「处理完（含计费回写）」算在途。
 * 结算层本身是同步的，真正需要等的是**异步的计费回写**（在等 HIS 计费侧响应）。
 */

/** 在途批次计数 */
export interface InFlightTracker {
  /** 一个批次开始处理 */
  begin(): void;
  /** 一个批次处理完 */
  end(): void;
  /** 当前在途批次数 */
  count(): number;
}

/** 建一个在途计数器 */
export function createInFlightTracker(): InFlightTracker {
  let inFlight = 0;
  return {
    begin(): void {
      inFlight += 1;
    },
    end(): void {
      inFlight = Math.max(0, inFlight - 1);
    },
    count(): number {
      return inFlight;
    },
  };
}

/** 等在途批次跑完的结果 */
export interface DrainResult {
  /** 是否在超时前跑完了 */
  drained: boolean;
  /** 跑完（或超时）时还剩几个在途 */
  remaining: number;
  /** 实际等了多久（毫秒） */
  waited_ms: number;
}

/**
 * 等在途批次跑完（带超时上限）。
 *
 * 超时不抛错 —— 返回 `drained: false` 让调用方如实记录；
 * 无限等会把 systemd 的停机也拖死（systemd 那边有 TimeoutStopSec）。
 */
export async function waitForIdle(
  tracker: InFlightTracker,
  timeoutMs: number,
  options: { pollIntervalMs?: number } = {},
): Promise<DrainResult> {
  const startedAt = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  while (tracker.count() > 0) {
    if (Date.now() - startedAt >= timeoutMs) {
      return { drained: false, remaining: tracker.count(), waited_ms: Date.now() - startedAt };
    }
    await new Promise((done) => setTimeout(done, pollIntervalMs));
  }
  return { drained: true, remaining: 0, waited_ms: Date.now() - startedAt };
}

/** 信号处理器的安装结果 */
export interface ShutdownHandlers {
  /** 卸载信号处理器（测试与正常退出时用） */
  dispose(): void;
}

/**
 * 装 SIGTERM / SIGINT 处理器。
 *
 * 只负责「收到信号 → 调用回调」，**不负责退出**：退出顺序由调用方编排
 * （停接新事件 → 等在途 → 落盘关闭 → 退出码 0），这样顺序才可控。
 */
export function installShutdownHandlers(options: {
  onSignal: (signal: 'SIGTERM' | 'SIGINT') => void;
}): ShutdownHandlers {
  const handler = (signal: 'SIGTERM' | 'SIGINT') => (): void => {
    options.onSignal(signal);
  };
  const onTerm = handler('SIGTERM');
  const onInt = handler('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  return {
    dispose(): void {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
    },
  };
}
