# 高值耗材扫码计费闭环系统 · 容器镜像
#
# 构建（在项目根目录）：
#   docker build -t material-scan-billing:latest .
#
# 运行（凭据从环境变量文件读，不进镜像）：
#   docker run --rm --env-file /etc/chaosforge/material-scan-billing.env \
#     -p 8099:8099 \
#     -v "$PWD/data:/var/lib/material-scan-billing" \
#     -v "$PWD/scan-inbox:/var/spool/material-scan-billing/scan-inbox" \
#     material-scan-billing:latest
#
# 镜像里只有：Node 运行时 + 编译产物 dist/。源码、测试数据、台账都不进镜像。

# syntax=docker/dockerfile:1
FROM node:22-slim

ENV NODE_ENV=production \
    LEDGER_DB_PATH=/var/lib/material-scan-billing/ledger.db \
    SCAN_INBOX_DIR=/var/spool/material-scan-billing/scan-inbox \
    HTTP_PORT=8099

WORKDIR /app

# 依赖：运行时零依赖，只有编译期要 typescript
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# 源码 → 编译产物
COPY tsconfig.json daemon.ts cli.ts ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev && npm cache clean --force

# 状态目录（默认非 root 的 node 用户可写）
RUN mkdir -p /var/lib/material-scan-billing /var/spool/material-scan-billing/scan-inbox \
 && chown -R node:node /var/lib/material-scan-billing /var/spool/material-scan-billing

USER node

EXPOSE 8099
VOLUME ["/var/lib/material-scan-billing", "/var/spool/material-scan-billing"]

# 健康检查走**心跳探针**：进程自己写心跳，心跳不新鲜就判不健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "dist/scripts/healthcheck.js", "--max-age", "90000"]

# 停机宽限期：给守护进程留时间把在途批次结算完
STOPSIGNAL SIGTERM

ENTRYPOINT ["node", "dist/daemon.js"]
