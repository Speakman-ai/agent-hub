FROM node:22-slim AS base

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# Copy server source
COPY . .

# Create data and uploads directories
RUN mkdir -p /data /app/uploads

ENV NODE_ENV=production
ENV AGENT_HUB_DATA_DIR=/data
ENV AGENT_HUB_HOST=0.0.0.0
ENV AGENT_HUB_PORT=3051

EXPOSE 3051

CMD ["npx", "tsx", "index.ts"]
