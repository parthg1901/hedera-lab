# Multi-platform manifest pinned to the base used for the deployment validation.
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
COPY package.json package-lock.json ./
RUN npm ci \
    && npx playwright install --with-deps chromium \
    && command -v flock \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*
COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples
COPY prompts ./prompts
COPY skills-index.json ./
RUN npm run build && mkdir -p /data /worker-socket && chown node:node /data /worker-socket
ENV NODE_ENV=production
USER node
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4318/health',{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok||!(await r.json()).ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","dist/index.js","verify","serve","--config","examples/verification/service-catalog.json","--host","0.0.0.0","--port","4318","--store","/data","--mode","testnet"]
