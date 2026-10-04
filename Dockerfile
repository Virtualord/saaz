# syntax=docker/dockerfile:1

# ---- Stage 1: production dependencies ---------------------------------------
# Kept separate so the native modules are compiled once, in an image that has a
# toolchain, and then copied into the slim runtime. Installing production deps in
# both stages meant compiling better-sqlite3 twice, and the second compile ran in
# a stage with no Python, which fails node-gyp.
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 and onnxruntime-node ship prebuilds for linux-x64, so these are
# a fallback rather than the normal path. The toolchain is kept because npm's
# allow-scripts policy (see .npmrc) does not cover every transitive case, and a
# missing compiler is a confusing way to discover that.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev \
 && node -e "require('better-sqlite3')(':memory:').exec('create table t(x)')" \
 && node -e "require('onnxruntime-node'); console.log('native deps verified')"


# ---- Stage 2: build the frontend and typecheck the server -------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json tsconfig.build.json \
     vite.config.ts vitest.config.ts ./
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY tests ./tests

RUN npm run typecheck
RUN npm test
RUN npm run build:web
RUN npm run build:api


# ---- Stage 3: fetch open weights so the image needs no network at runtime ----
# Baked in, which is what makes the offline claim testable rather than asserted.
FROM build AS weights
RUN npx tsx server/scripts/fetch-models.ts \
 && npx tsx server/scripts/vad-fetch.ts


# ---- Stage 4: slim runtime --------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# ffmpeg is a real runtime dependency: it probes and decodes the media.
# Note: no compiler here on purpose. node_modules arrives prebuilt from `deps`.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    SAAZ_MODEL_DIR=/app/data/models

COPY package.json package-lock.json ./
# Compiled once in the deps stage; nothing is built here.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/shared ./shared
COPY --from=weights /app/data/models ./data/models

RUN mkdir -p data/uploads data/out \
 && useradd -m -u 10001 saaz \
 && chown -R saaz:saaz /app/data
USER saaz

EXPOSE 8080

# Fails the build if a native module did not survive the stage copy.
RUN node -e "require('better-sqlite3'); require('onnxruntime-node'); console.log('runtime native deps OK')"

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/main.js"]