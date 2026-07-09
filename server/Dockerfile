# ─── Build stage: native modules (better-sqlite3) ───────────────────────────
FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

COPY server/package.json server/package-lock.json ./server/
# `--ignore-scripts` speeds up the install and avoids arbitrary code from
# transitive deps, but we still need better-sqlite3's native binding. Rebuild
# only that package — it fetches the prebuilt binary for the current Node
# version, or compiles from source using python3/make/g++ installed above.
# Without this, runtime crashes with "Could not locate the bindings file" as
# Node resolves better-sqlite3 from /app/server/node_modules first.
RUN cd server && npm ci --ignore-scripts && npm rebuild better-sqlite3

# Copy application sources only — never host `server/node_modules` (macOS
# better-sqlite3 .node files break Linux runtime with "invalid ELF header").
COPY server/ ./server/
RUN rm -rf ./server/node_modules && cd server && npm ci --ignore-scripts && npm rebuild better-sqlite3
COPY shared/ ./shared/

# ─── Client build stage ─────────────────────────────────────────────────────
FROM node:22-slim AS client-build

WORKDIR /app

COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci

# vite.config.js reads the canonical app version from the repo-root
# package.json (the only one that release-all.yml bumps). Without this COPY
# the build falls back to client/package.json (stuck at 1.2.1) — or, with
# the loud-fail resolver, fails outright. Copy it before `vite build` so
# the bundle's VITE_APP_VERSION matches the released version.
COPY package.json ./
COPY client/ ./client/
COPY shared/ ./shared/
# Vendor control-plane endpoints (build-time; inlined by Vite). Empty by default
# so a self-hosted / fork build never phones home — the first-party release must
# pass these as --build-arg (the ECR publish workflow sources them from GitHub
# repo Variables). VITE_REPLAY_INGEST_ENDPOINT derives from the bug-report origin
# when unset. See .env.example + client/Dockerfile for the same contract.
ARG VITE_BUG_REPORT_ENDPOINT=""
ARG VITE_REPLAY_INGEST_ENDPOINT=""
ARG VITE_RELEASE_BUCKET_BASE=""
RUN cd client && VITE_API_PORT="" \
    VITE_BUG_REPORT_ENDPOINT="${VITE_BUG_REPORT_ENDPOINT}" \
    VITE_REPLAY_INGEST_ENDPOINT="${VITE_REPLAY_INGEST_ENDPOINT}" \
    VITE_RELEASE_BUCKET_BASE="${VITE_RELEASE_BUCKET_BASE}" \
    npm run build

# ─── Runtime stage ───────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# OS packages the server shells out to or links against.
# Git 2.35+ "dubious ownership": bind mounts and mixed UIDs make git refuse
# the repo; lint-staged / husky pre-commit then fail. Trust all paths in this
# single-tenant agent image.
#
# Python 3 (+ venv + pip) is included so agents can run Python scripts and,
# under PEP 668, create a venv to pip-install ad-hoc deps. The build stage
# already installs python3 to compile better-sqlite3, but that stage is
# discarded, so we install it again here for the runtime container.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    ca-certificates \
    curl \
    unzip \
    openssl \
    bash \
    jq \
    ripgrep \
    tini \
    gnupg \
    python3 \
    python3-venv \
    python3-pip \
 && git config --system --add safe.directory '*' \
 && rm -rf /var/lib/apt/lists/*

# Chromium runtime system libs are NOT hand-maintained here. They are installed
# later via Playwright's own `install-deps` (after server/node_modules is copied)
# so the dep set always matches the *pinned* Chromium build and can't silently
# drift — a stale hand-list is exactly what makes Chromium launch then crash,
# which surfaces to Stagehand as a CDP ECONNREFUSED. See the
# PLAYWRIGHT_BROWSERS_PATH block in the runtime stage below.

# Python 3 + pip — required for any project whose `commands.install` shells
# out to `pip` / `python` during the pre-commit dependency-install step
# (`server/auto-git.ts` → `ensureSessionWorktreeDependenciesInstalled`).
# Without these, projects like webapp (Django backend, `pip install -r
# requirements.txt` in their install command) crash with `pip: not found`,
# write the sticky `.agent-hub-dependency-install-failed` marker into the
# session worktree, and every subsequent commit short-circuits with a 422.
#
# `python-is-python3` provides /usr/bin/python → python3 for projects that
# call `python` directly. Debian 12's `python3-pip` only ships `pip3`, so
# we symlink `pip → pip3` so commands like `pip install -r requirements.txt`
# work without modification.
#
# PEP 668 (enforced on Debian 12 + Python 3.11+) marks system Python as
# externally-managed and refuses `pip install` outside a venv. Since the
# Agent Hub container IS the isolation boundary for every spawned session,
# we opt out at the env level so projects' install commands don't have to
# learn about `--break-system-packages` to run.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python-is-python3 \
 && ln -sf /usr/bin/pip3 /usr/local/bin/pip \
 && rm -rf /var/lib/apt/lists/*
ENV PIP_BREAK_SYSTEM_PACKAGES=1

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
      https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# AWS CLI v2 (bundled installer; maps dpkg arch to AWS's x86_64/aarch64 zips).
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) aws_arch=x86_64 ;; \
      arm64) aws_arch=aarch64 ;; \
      *) echo "aws-cli: unsupported architecture: $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o /tmp/awscliv2.zip \
 && unzip -q /tmp/awscliv2.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/aws /tmp/awscliv2.zip

# AWS Session Manager plugin (required for `aws ssm start-session` — SSM shell
# sessions and port forwarding). The AWS CLI shells out to this binary, so the
# CLI alone is not enough. Official .deb packages map dpkg arch to AWS's
# ubuntu_64bit / ubuntu_arm64 builds.
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) smp_arch=ubuntu_64bit ;; \
      arm64) smp_arch=ubuntu_arm64 ;; \
      *) echo "session-manager-plugin: unsupported architecture: $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/${smp_arch}/session-manager-plugin.deb" \
      -o /tmp/session-manager-plugin.deb \
 && dpkg -i /tmp/session-manager-plugin.deb \
 && rm -f /tmp/session-manager-plugin.deb

# Docker CLI + Compose v2 plugin (no daemon, no buildx). The runtime
# container talks to the *host* docker daemon over a bind-mounted
# /var/run/docker.sock so PR-env orchestration (legacy; removed by
# PR-Env Removal #4) could spin up per-PR preview containers on the
# host. Worktree previews are the supported preview surface now; the
# docker CLI stays in the image for scaffold-builder and any future
# host-side container ops.
#
# We install only the CLI + compose plugin — buildx and the daemon
# would just bloat the image. The CLI's wire protocol is
# version-skew tolerant against a slightly newer/older host daemon, so
# we don't pin a specific major. Source from the official Docker apt
# repo (matches the host's install source on AL2023 / Ubuntu / Debian).
#
# WARNING: a mounted docker socket grants the agent-hub container
# root-equivalent control of the host. The launch script
# (/usr/local/bin/agenthub-server-run.sh) is what actually performs the
# bind-mount + group-add; this layer just supplies the binaries needed
# to use it. Acceptable only for trusted single-tenant Hub deployments.
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
 && chmod a+r /etc/apt/keyrings/docker.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Gemini CLI — lets agents run the `gemini-cli` engine.
# See https://geminicli.com/docs/ for install + auth details.
RUN npm install -g @google/gemini-cli

# OpenAI Codex CLI — places `codex` on npm's global PATH (`/usr/local/bin` on
# official Node images), matching `codexBin` static fallback in server/config.ts.
RUN npm install -g @openai/codex

WORKDIR /app

# Own app files at copy time. A recursive chown over ./node_modules alone can take
# many minutes on Docker Desktop; COPY --chown avoids that walk entirely.
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/server ./server
COPY --chown=node:node --from=build /app/shared ./shared
COPY --chown=node:node --from=build /app/package.json ./

# Copy client dist for serving the web UI
COPY --chown=node:node --from=client-build /app/client/dist ./client/dist

# Writable mount points only (not all of /app).
# Pre-create /home/node/.agent-hub (and its projects/workspaces children) owned by
# node. Without this, docker auto-creates the parent as ROOT when the run script
# bind-mounts .agent-hub/workspaces, so the node user (uid 1000) then can't mkdir
# .agent-hub/projects/<id> at project-onboarding time (EACCES at projects.ts).
RUN mkdir -p /data /app/uploads /home/node/.agent-hub/projects /home/node/.agent-hub/workspaces \
    && chown node:node /data /app/uploads \
    && chown -R node:node /home/node/.agent-hub

# Playwright Chromium — system deps + fixed install location.
#
# PLAYWRIGHT_BROWSERS_PATH decouples the browser install dir from $HOME/user, so
# `chromium.executablePath()` resolves to the SAME path at build time (root) and
# at run time (the node user) regardless of which HOME the server runs under —
# the old default (~/.cache/ms-playwright) silently breaks if those differ.
#
# `playwright install-deps chromium` (root/apt) installs the exact system
# libraries the *pinned* playwright in server/node_modules needs, replacing the
# hand-maintained apt list that could drift from the installed Chromium build.
# A drifted/incomplete lib set lets Chromium spawn and then crash, which the
# Stagehand CDP handshake reports as ECONNREFUSED — the failure mode we're
# closing here. The browser binary itself is downloaded below as the node user.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright \
    && chown node:node /ms-playwright \
    && cd /app/server && npx playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Cursor Agent CLI — official installer drops the `agent` symlink at
# ~/.local/bin/agent; config.ts defaults cursorBin there for HOME=/home/node so
# Settings auth flows work without manual path overrides. Install URL:
# https://cursor.com/docs/cli/installation
USER node
RUN curl -fsSL https://cursor.com/install | bash

# Grok Build CLI — xAI's official installer drops the `grok` binary at
# ~/.local/bin/grok (per-user, same shape as Cursor), which is where config.ts
# defaults grokBin for HOME=/home/node so the `grok-cli` engine works without a
# manual path override. Auth is XAI_API_KEY (headless) or `grok login`.
# Install URL: https://x.ai/cli — see https://docs.x.ai/build/overview
RUN curl -fsSL https://x.ai/cli/install.sh | bash

# Download Playwright's Chromium as the node user using the PINNED playwright in
# server/node_modules (note `cd /app/server` + bare `npx playwright`, NOT
# `npx --yes playwright`). `npx --yes` at /app cannot resolve the local pinned
# playwright, so it fetches the LATEST playwright and a Chromium revision that
# won't match the runtime lib — leaving chromium.executablePath() pointing at a
# build that isn't there. Installs into PLAYWRIGHT_BROWSERS_PATH (set above).
RUN cd /app/server && npx playwright install chromium

ENV AGENT_HUB_DATA_DIR=/data
ENV AGENT_HUB_HOST=0.0.0.0
ENV NODE_ENV=production
# PEP 668: this Debian Bookworm runtime marks the system Python as
# "externally managed", so `pip install ...` outside a venv fails with
# `error: externally-managed-environment`. The same opt-out is set on the
# per-spawn install env in server/worktree.ts; setting it on the image
# means agent-driven shells (e.g. `pip install` from a skill or user
# instruction) also work without per-call --break-system-packages flags.
# Operators who want PEP 668 enforcement back can set
# PIP_REQUIRE_VIRTUALENV=1, which pip honours over PIP_BREAK_SYSTEM_PACKAGES.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

WORKDIR /app/server

VOLUME /data
EXPOSE 3051

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/tsx", "index.ts"]
