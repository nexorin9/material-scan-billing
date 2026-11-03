#!/usr/bin/env node
/**
 * 常驻守护进程入口：`node dist/daemon.js`。
 *
 * 这个文件只做一件事 —— 把启动交给 `src/daemon/runner.ts` 的 `main()`，并把退出码带出去。
 * 业务逻辑全在 `src/daemon/` 里，测试直接 import 那些模块，不必起子进程。
 *
 * 停机信号（SIGTERM / SIGINT）由守护进程自己处理：
 * 先停接新事件 → 等在途批次结算完 → 落盘关库 → 退出码 0。
 */

import { main } from './src/daemon/runner.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
    // 兜底：若还有句柄没关干净（比如 keep-alive 连接），50 毫秒后强制退出。
    // 定时器不 ref —— 事件循环空了的话进程自然退出，不会被它拖着。
    const timer = setTimeout(() => {
      process.exit(code);
    }, 50);
    timer.unref();
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
