# Finalize CI runner — ubuntu-24.04 with DinD, Compose, Buildx, Node LTS, Chrome.
# Production (GHA parity, linux amd64):
#   docker build --platform linux/amd64 -t agent-hub/finalize-runner:ubuntu-24.04 server/finalize/runner
# Local Apple Silicon dev (native arm64, faster Cypress):
#   docker build -t agent-hub/finalize-runner:ubuntu-24.04-arm64 server/finalize/runner

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV AGENT_HUB_RUNNER=1

# Run apt's download/verify step as root instead of the unprivileged `_apt` user.
# On Docker Desktop (Apple Silicon) the privilege-drop breaks file access in apt's
# gpgv verify path, producing a spurious "At least one invalid signature was
# encountered" even though the downloaded InRelease is byte-identical and verifies
# fine with gpgv standalone. Harmless on native amd64 (GHA/prod) where the build
# already runs as root. Must precede the first apt-get update.
RUN echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/00no-sandbox

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    iptables \
    jq \
    lsb-release \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    libpq-dev \
    build-essential \
    imagemagick \
    libmagickwand-dev \
    ghostscript \
    xvfb \
    sudo \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Docker Engine + Compose plugin (inner dockerd for DinD — GHA parity)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      docker-ce \
      docker-ce-cli \
      containerd.io \
      docker-buildx-plugin \
      docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Node.js LTS (via NodeSource)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Cypress E2E browser.
#   amd64 (GHA parity / prod): Google Chrome stable from Google's apt repo.
#   arm64 (local Apple Silicon dev): Google does NOT ship Chrome for ARM Linux
#     (no arm64 .deb; Chrome-for-Testing and Edge-for-Linux are x86-only too, and
#     Ubuntu 24.04's chromium/firefox apt packages are snap stubs that can't run
#     in a container). So local arm64 runs Cypress against its BUNDLED Electron
#     (Chromium engine, native arm64, fetched during the repo's npm install).
#     We only install the shared libraries Electron/Chromium need at runtime.
#     Run such repos with CYPRESS_BROWSER=electron / --browser electron.
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
    amd64) \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
      && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
      && apt-get update \
      && apt-get install -y --no-install-recommends google-chrome-stable \
      ;; \
    arm64) \
      apt-get update \
      && apt-get install -y --no-install-recommends \
        libgtk-3-0t64 libgbm1 libnotify4 libnss3 libxss1 \
        libasound2t64 libxtst6 libatk-bridge2.0-0t64 libatk1.0-0t64 \
        libcups2t64 libdrm2 libxcomposite1 libxdamage1 libxrandr2 \
        libxfixes3 libxkbcommon0 libpango-1.0-0 libcairo2 \
      ;; \
    *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/runner-entrypoint.sh
RUN chmod +x /usr/local/bin/runner-entrypoint.sh

# Pull-based runner agent (bundled single-file ESM via esbuild). Generated into
# this build context by build.sh / CI BEFORE `docker build` — see build.sh.
# Used by the `agent` entrypoint mode; harmless in `daemon` (job) containers.
COPY runner-agent.mjs /usr/local/bin/runner-agent.mjs

# Non-root runner user (GHA-style workspace path)
RUN useradd -m -s /bin/bash runner \
    && usermod -aG docker runner \
    && mkdir -p /github/workspace \
    && chown runner:runner /github/workspace \
    && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner

USER runner
WORKDIR /github/workspace

ENTRYPOINT ["/usr/local/bin/runner-entrypoint.sh"]
CMD ["daemon"]
