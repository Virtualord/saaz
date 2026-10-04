# syntax=docker/dockerfile:1

# ---- Stage 1: build the frontend and typecheck the server -------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Native deps needed to compile better-sqlite3 and onnxruntime-node.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts ./
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY tests ./tests

RUN npm run build:web
RUN npm run typecheck


# ---- Stage 2: fetch open weights so the image can run with no network -------
FROM build AS weights
RUN npx tsx server/scripts/fetch-models.ts \
 && npx tsx server/scripts/vad-fetch.ts


# ---- Stage 3: slim runtime --------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# ffmpeg is a genuine runtime dependency: it probes and decodes the media.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    SAAZ_MODEL_DIR=/app/data/models

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/shared ./shared
# Weights are baked in, which is what makes the offline claim testable.
COPY --from=weights /app/data/models ./data/models

RUN mkdir -p data/uploads data/out \
 && useradd -m -u 10001 saaz \
 && chown -R saaz:saaz /app/data
USER saaz

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/main.js"]