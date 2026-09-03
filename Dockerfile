FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY README.md ./README.md

RUN mkdir -p /app/data/cache /app/data/raw /app/data/exports /app/backups \
    && useradd --uid 10001 --create-home appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8787
ENV HEALTH_PORT=8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.HEALTH_PORT || '8787') + '/__bl/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["node", "src/cli.mjs", "serve", "--port", "8787", "--db", "/app/data/probe-history.sqlite"]
