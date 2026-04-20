# ─── Build stage: native modules (better-sqlite3) ───────────────────────────
FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --ignore-scripts

COPY server/ ./server/
COPY shared/ ./shared/

# ─── Client build stage ─────────────────────────────────────────────────────
FROM node:22-slim AS client-build

WORKDIR /app

COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci

COPY client/ ./client/
COPY shared/ ./shared/
RUN cd client && VITE_API_PORT="" npm run build

# ─── Runtime stage ───────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# OS packages the server shells out to or links against
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    ca-certificates \
    curl \
    openssl \
    bash \
    jq \
    tini \
    gnupg \
 && rm -rf /var/lib/apt/lists/*

# Chromium system libs (playwright chromium runtime deps)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 libx11-xcb1 \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
      https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy built node_modules and source from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/package.json ./

# Copy client dist for serving the web UI
COPY --from=client-build /app/client/dist ./client/dist

# Set up data volume and uploads
RUN mkdir -p /data /app/uploads && chown -R node:node /data /app/uploads /app

# Install Playwright Chromium as the node user
USER node
RUN npx --yes playwright install chromium

ENV AGENT_HUB_DATA_DIR=/data
ENV AGENT_HUB_HOST=0.0.0.0
ENV NODE_ENV=production

WORKDIR /app/server

VOLUME /data
EXPOSE 3051

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/tsx", "index.ts"]
