FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
# 先编服务端再编网页：网页用 import type 引用服务端的 zod 类型，字段对不上会在这里就失败
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg curl \
  && rm -rf /var/lib/apt/lists/*
# 回放的 AI 降噪：DeepFilterNet3 官方命令行（v0.5.6，静态编译、只用 CPU）。核对 sha256，下载被换掉就构建失败
RUN curl -fsSL -o /usr/local/bin/deep-filter \
    https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl \
  && echo "70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da  /usr/local/bin/deep-filter" | sha256sum -c - \
  && chmod +x /usr/local/bin/deep-filter
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
# 人声检测模型（Silero VAD，约 2MB，MIT）。dist/audio/vad.js 按 ../../models 找它
COPY models ./models
RUN mkdir -p /data/audio && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
