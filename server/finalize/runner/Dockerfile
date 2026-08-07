# Finalize CI runner — ubuntu-24.04 with DinD, Compose, Buildx, Node LTS, Chrome.
# Production (GHA parity, linux amd64):
#   docker build --platform linux/amd64 -t agent-hub/finalize-runner:ubuntu-24.04 server/finalize/runner
# Local Apple Silicon dev (native arm64, faster Cypress):
#   docker build -t agent-hub/finalize-runner:ubuntu-24.04-arm64 server/finalize/runner

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV AGENT_HUB_RUNNER=1

# ── Targeted GitHub ubuntu-24.04 image manifest versions ─────────────────────
# SINGLE SOURCE OF TRUTH is server/finalize/runner-image-versions.ts; these ARG
# defaults MUST match it (runner-image-versions.test.ts enforces no drift).
# Bump cadence: when actions/runner-images updates the ubuntu-24.04 image, update
# BOTH these ARGs and runner-image-versions.ts to the new manifest values, then
# rebuild. See the runner-image-versions.ts header for the full procedure.
#
# These are applied as a SOFT pin: the build tries the exact version and, if it
# has aged out of the upstream apt repo, falls back to the latest in the same
# major channel with a loud warning. Set RUNNER_ENFORCE_VERSION_PINS=1 to make a
# missing pin fatal instead (reproducible prod builds).
ARG RUNNER_NODE_VERSION=22.22.3
ARG RUNNER_DOCKER_VERSION=28.0.4
ARG RUNNER_COMPOSE_VERSION=2.38.2
ARG RUNNER_BUILDX_VERSION=0.34.1
ARG RUNNER_GH_VERSION=2.95.0
ARG RUNNER_AWSCLI_VERSION=2.36.8
ARG RUNNER_ENFORCE_VERSION_PINS=0

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
# Soft-pinned to the targeted manifest versions: try the exact apt version; if it
# has aged out, fall back to the newest patch WITHIN THE SAME MAJOR line (never
# across majors — that would defeat the parity guard). If even the recorded major
# is gone from the repo, the build fails asking you to bump (or set
# RUNNER_ENFORCE_VERSION_PINS=1 to fail on any drift).
RUN set -e; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    DOCKER_V="5:${RUNNER_DOCKER_VERSION}-1~ubuntu.24.04~${CODENAME}"; \
    COMPOSE_V="${RUNNER_COMPOSE_VERSION}-1~ubuntu.24.04~${CODENAME}"; \
    BUILDX_V="${RUNNER_BUILDX_VERSION}-1~ubuntu.24.04~${CODENAME}"; \
    if apt-get install -y --no-install-recommends \
         "docker-ce=${DOCKER_V}" "docker-ce-cli=${DOCKER_V}" containerd.io \
         "docker-buildx-plugin=${BUILDX_V}" "docker-compose-plugin=${COMPOSE_V}"; then \
       echo "Pinned docker-ce=${DOCKER_V} compose=${COMPOSE_V} buildx=${BUILDX_V}"; \
    elif [ "${RUNNER_ENFORCE_VERSION_PINS}" = "1" ]; then \
       echo "ERROR: pinned Docker versions unavailable and RUNNER_ENFORCE_VERSION_PINS=1" >&2; exit 1; \
    else \
       echo "WARN: exact Docker pins unavailable (aged out of repo?); resolving newest patch within the SAME major line. Bump RUNNER_DOCKER_VERSION/RUNNER_COMPOSE_VERSION/RUNNER_BUILDX_VERSION + runner-image-versions.ts." >&2; \
       pick() { apt-cache madison "$1" | awk '{print $3}' | grep -E "$2" | sort -Vr | head -n1 || true; }; \
       DOCKER_F="$(pick docker-ce "^5:${RUNNER_DOCKER_VERSION%%.*}\\.")"; \
       COMPOSE_F="$(pick docker-compose-plugin "^${RUNNER_COMPOSE_VERSION%%.*}\\.")"; \
       BUILDX_F="$(pick docker-buildx-plugin "^${RUNNER_BUILDX_VERSION%%.*}\\.")"; \
       if [ -z "$DOCKER_F" ] || [ -z "$COMPOSE_F" ] || [ -z "$BUILDX_F" ]; then \
         echo "ERROR: no same-major fallback for docker(${RUNNER_DOCKER_VERSION%%.*})/compose(${RUNNER_COMPOSE_VERSION%%.*})/buildx(${RUNNER_BUILDX_VERSION%%.*}) — the recorded major aged out of the repo. Refusing to cross majors silently (would break GitHub parity). Bump the targeted versions in runner-image-versions.ts + the Dockerfile ARGs." >&2; \
         exit 1; \
       fi; \
       echo "WARN: same-major fallback docker-ce=${DOCKER_F} compose=${COMPOSE_F} buildx=${BUILDX_F}" >&2; \
       apt-get install -y --no-install-recommends \
         "docker-ce=${DOCKER_F}" "docker-ce-cli=${DOCKER_F}" containerd.io \
         "docker-buildx-plugin=${BUILDX_F}" "docker-compose-plugin=${COMPOSE_F}"; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# Node.js LTS (via NodeSource). Major line tracks RUNNER_NODE_VERSION; the exact
# patch is soft-pinned. The fallback installs latest within the same major because
# NodeSource's setup_${NODE_MAJOR}.x configures ONLY that major's repo — plain
# `nodejs` can't cross majors here, so no extra major guard is needed.
RUN NODE_MAJOR="${RUNNER_NODE_VERSION%%.*}" \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && NODE_V="${RUNNER_NODE_VERSION}-1nodesource1" \
    && if apt-get install -y --no-install-recommends "nodejs=${NODE_V}"; then \
         echo "Pinned nodejs=${NODE_V}"; \
       elif [ "${RUNNER_ENFORCE_VERSION_PINS}" = "1" ]; then \
         echo "ERROR: pinned nodejs=${NODE_V} unavailable and RUNNER_ENFORCE_VERSION_PINS=1" >&2; exit 1; \
       else \
         echo "WARN: pinned nodejs=${NODE_V} unavailable (aged out of repo?); installing latest ${NODE_MAJOR}.x. Bump RUNNER_NODE_VERSION + runner-image-versions.ts." >&2; \
         apt-get install -y --no-install-recommends nodejs; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI. Deploy jobs use the same runner image as Finalize, and deploy.yaml
# may legitimately dispatch GitHub workflows with `gh workflow run`.
RUN set -e; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    if apt-get install -y --no-install-recommends "gh=${RUNNER_GH_VERSION}"; then \
      echo "Pinned gh=${RUNNER_GH_VERSION}"; \
    elif [ "${RUNNER_ENFORCE_VERSION_PINS}" = "1" ]; then \
      echo "ERROR: pinned gh=${RUNNER_GH_VERSION} unavailable and RUNNER_ENFORCE_VERSION_PINS=1" >&2; exit 1; \
    else \
      echo "WARN: pinned gh=${RUNNER_GH_VERSION} unavailable (aged out of repo?); resolving newest patch within the SAME major line. Bump RUNNER_GH_VERSION + runner-image-versions.ts." >&2; \
      GH_F="$(apt-cache madison gh | awk '{print $3}' | grep -E "^${RUNNER_GH_VERSION%%.*}\\." | sort -Vr | head -n1 || true)"; \
      if [ -z "$GH_F" ]; then \
        echo "ERROR: no same-major fallback for gh(${RUNNER_GH_VERSION%%.*}) - the recorded major aged out of the repo. Refusing to cross majors silently. Bump the targeted version in runner-image-versions.ts + the Dockerfile ARG." >&2; \
        exit 1; \
      fi; \
      echo "WARN: same-major fallback gh=${GH_F}" >&2; \
      apt-get install -y --no-install-recommends "gh=${GH_F}"; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# AWS CLI v2, from AWS's official installer. Not available via apt: Ubuntu 24.04
# (noble) dropped the `awscli` package, so a project declaring it in
# `prEnv.devServer.aptPackages` gets "no candidate" and the whole apt batch
# fails. Repo scripts that sync a database or fetch artifacts from S3 need it,
# and GitHub's ubuntu-24.04 image ships it, so this is parity too.
#
# AWS keeps every published version at a stable URL indefinitely, so the exact
# pin does not age out the way an apt pin does; the fallback to the unversioned
# "latest" zip exists only for a transient CDN miss, and is refused under
# RUNNER_ENFORCE_VERSION_PINS=1.
ARG TARGETARCH
RUN set -e; \
    case "${TARGETARCH}" in \
      arm64) AWS_ARCH=aarch64 ;; \
      *)     AWS_ARCH=x86_64 ;; \
    esac; \
    cd /tmp; \
    if curl -fsSL -o awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}-${RUNNER_AWSCLI_VERSION}.zip"; then \
      echo "Pinned aws-cli=${RUNNER_AWSCLI_VERSION}"; \
    elif [ "${RUNNER_ENFORCE_VERSION_PINS}" = "1" ]; then \
      echo "ERROR: pinned aws-cli=${RUNNER_AWSCLI_VERSION} unavailable and RUNNER_ENFORCE_VERSION_PINS=1" >&2; exit 1; \
    else \
      echo "WARN: pinned aws-cli=${RUNNER_AWSCLI_VERSION} unavailable; falling back to latest. Bump RUNNER_AWSCLI_VERSION + runner-image-versions.ts." >&2; \
      curl -fsSL -o awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip"; \
    fi; \
    unzip -q awscliv2.zip; \
    ./aws/install; \
    rm -rf /tmp/awscliv2.zip /tmp/aws

# Record targeted vs installed toolchain versions in the build log (parity audit).
RUN echo "Runner toolchain (targeted -> installed):" \
    && echo "  node:    ${RUNNER_NODE_VERSION} -> $(node --version 2>/dev/null || echo '?')" \
    && echo "  docker:  ${RUNNER_DOCKER_VERSION} -> $(docker --version 2>/dev/null || echo '?')" \
    && echo "  compose: ${RUNNER_COMPOSE_VERSION} -> $(docker compose version 2>/dev/null || echo '?')" \
    && echo "  buildx:  ${RUNNER_BUILDX_VERSION} -> $(docker buildx version 2>/dev/null || echo '?')" \
    && echo "  gh:      ${RUNNER_GH_VERSION} -> $(gh --version 2>/dev/null | head -n1 || echo '?')" \
    && echo "  aws:     ${RUNNER_AWSCLI_VERSION} -> $(aws --version 2>/dev/null || echo '?')"

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

# Non-root runner user (GHA-style workspace path), pinned to uid/gid 1000.
#
# Left to itself `useradd` lands runner on 1001, because ubuntu:24.04 ships an
# `ubuntu` account on 1000. That matters for session environments: the worktree
# is bind-mounted from the Hub host and carries the Hub's uid — 1000 in every
# supported deployment — so a mismatched container user gets an effectively
# read-only workspace and git rejects it as "dubious ownership".
#
# It has to be fixed HERE because it cannot be fixed at runtime. The entrypoint
# runs AS this account, and no mechanism can renumber the account a live process
# is using: `usermod` refuses outright ("user runner is currently used by
# process 1"), and rewriting /etc/passwd directly orphans the running uid, after
# which every `sudo` fails with "you do not exist in the passwd database". At
# build time nothing is running yet, so the same operation is safe.
#
# `ubuntu` is parked on a high id rather than deleted, in case the image depends
# on it. GitHub's own runner images use 1001 for `runner`, but nothing keys off
# the number, so matching the Hub host is the more useful invariant.
RUN usermod -u 61000 ubuntu \
    && groupmod -g 61000 ubuntu \
    && groupadd -g 1000 runner \
    && useradd -m -s /bin/bash -u 1000 -g runner runner \
    && usermod -aG docker runner \
    && mkdir -p /github/workspace \
    && chown runner:runner /github/workspace \
    && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner

USER runner
WORKDIR /github/workspace

ENTRYPOINT ["/usr/local/bin/runner-entrypoint.sh"]
CMD ["daemon"]
