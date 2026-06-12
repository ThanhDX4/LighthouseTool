FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json vite.config.ts vitest.config.ts ./
COPY src ./src
COPY tests ./tests
COPY web ./web
RUN pnpm run build
RUN pnpm prune --prod

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/var/lib/lh-audit \
    STATIC_DIR=/app/web/dist \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    PUPPETEER_SKIP_DOWNLOAD=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends wget gnupg ca-certificates dumb-init \
  && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /etc/apt/trusted.gpg.d/google.gpg \
  && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    google-chrome-stable \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    libnss3 \
    libatk-bridge2.0-0 \
    libxkbcommon0 \
    libgbm1 \
    libdrm2 \
    libasound2 \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -r lhuser \
  && useradd -r -g lhuser -G audio,video lhuser \
  && mkdir -p /app /var/lib/lh-audit /tmp/lh-audit \
  && chown -R lhuser:lhuser /app /var/lib/lh-audit /tmp/lh-audit

WORKDIR /app
COPY --from=builder --chown=lhuser:lhuser /app/node_modules ./node_modules
COPY --from=builder --chown=lhuser:lhuser /app/dist ./dist
COPY --from=builder --chown=lhuser:lhuser /app/web/dist ./web/dist
COPY --from=builder --chown=lhuser:lhuser /app/package.json ./package.json

USER lhuser
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "node dist/server/index.js & node dist/worker/index.js & wait -n"]
