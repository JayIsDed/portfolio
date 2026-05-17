# Portfolio image — runs either the web server (default) or the shelf logger
# (override CMD). Single image, two services in compose.
FROM oven/bun:1.3-alpine

WORKDIR /app

# No external deps — Bun's std lib covers HTTP + sqlite. Copy package.json
# anyway so `bun install` is fast and lockfile-stable if deps are ever added.
COPY package.json ./
RUN bun install --production --no-progress 2>/dev/null || true

COPY server.ts flags.ts ./
COPY public ./public
COPY logger ./logger

RUN mkdir -p /app/data && chown -R bun:bun /app

ENV PORT=3000
ENV NODE_ENV=production
ENV SHELF_EVENTS_DB=/app/data/shelf-events.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e 'fetch("http://localhost:"+process.env.PORT+"/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

USER bun

CMD ["bun", "run", "server.ts"]
