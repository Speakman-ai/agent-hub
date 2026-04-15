FROM node:22-slim AS build

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install all deps (including dev) to get tsx for runtime
RUN npm ci

# Copy server source
COPY . .

# ─── Production image ────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Copy built node_modules (includes native bindings) and source
COPY --from=build /app /app

# Create data and uploads directories
RUN mkdir -p /data /app/uploads

ENV NODE_ENV=production
ENV AGENT_HUB_DATA_DIR=/data
ENV AGENT_HUB_HOST=0.0.0.0
ENV AGENT_HUB_PORT=3051

EXPOSE 3051

# Use tsx directly from node_modules — no npx overhead
CMD ["node_modules/.bin/tsx", "index.ts"]
