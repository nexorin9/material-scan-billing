#!/usr/bin/env node
/**
 * 运维 CLI 的启动入口：`node dist/cli.js <子命令> [选项]`。
 *
 * 本文件只做一件事 —— 把命令行交给 `src/cli/index.ts` 的 `main()`，并把退出码带出去。
 * 业务逻辑全在 `src/cli/` 里，测试直接 import 那些模块，不必起子进程。
 *
 * 退出码约定（监控按退出码判定，不解析输出文本）：
 *   0 成功 / 2 参数错误 / 3 业务校验失败 / 4 外部通道不可达 / 5 内部错误
 */

import { main } from './src/cli/index.js';
import { EXIT_CODES } from './src/cli/args.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // 未预期的异常 = 程序自己的问题 → 内部错误（5）
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT_CODES.INTERNAL;
  });
