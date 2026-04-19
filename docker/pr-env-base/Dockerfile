# syntax=docker/dockerfile:1.7
# Container pool — lean PR preview env base image (W3).
#
# Target: ~200 MiB compressed, ~230 MiB uncompressed.
#
# This image is the runtime fallback for PR preview envs that do NOT ship
# their own Dockerfile / compose file. The PR repo's own image is preferred
# when present; this base only runs when a repo comes in "bare" and the
# dispatcher needs a Node runtime to spin up `npm start` or similar.
#
# Deliberately minimal — no templates, no baked node_modules, no gh CLI.
# The scaffold base (docker/scaffold-base/Dockerfile) layers on top of this
# and pays the extra ~500 MiB for pre-installed scaffolding templates.
#
# Contents (per "Container Pool" wiki §5.1):
#   - Node 20 LTS (node:20-slim base, ~180 MiB)
#   - pnpm + yarn (npm already ships with Node)
#   - git, curl, openssl, ca-certificates
#   - A tiny /healthcheck.mjs HTTP server on $PORT for bare fallbacks
#
# Image tag convention (pushed by .github/workflows/base-images.yml):
#   ghcr.io/<owner>/agent-hub/pr-env-base:YYYYMMDD  (immutable, always pushed)
#   ghcr.io/<owner>/agent-hub/pr-env-base:latest    (mutable, pushed when no upstream major bump)
#
# The dispatcher pins to `:latest` by default; operators roll back by
# pinning the host to `:YYYYMMDD` via SSM (see spec §5.3 "Rollback").

FROM node:20-slim AS base

# Pin Debian mirrors and disable suggests/recommends so the image stays
# lean. `--no-install-recommends` alone would still pull in a few MiB of
# man-pages we never read.
ENV DEBIAN_FRONTEND=noninteractive

# System packages:
#   - git: required by most PR repos (npm scripts, post-install hooks)
#   - curl: healthchecks, optional image-pull shell scripts
#   - openssl: TLS inside the container (npm registry, git over https)
#   - ca-certificates: without this every https:// fetch fails
#   - tini: PID 1 signal handling so SIGTERM actually reaches Node and
#           `docker compose down --timeout 30` can drain cleanly instead
#           of hitting the 30 s timeout and kill -9.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git \
       curl \
       openssl \
       ca-certificates \
       tini \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Install pnpm and yarn as global npm packages. We pin both to known
# majors so the image contents are reproducible across nightly rebuilds —
# a silent pnpm v9 → v10 upgrade in the middle of a build week is the
# exact class of surprise the weekly rebuild cadence is supposed to
# surface through the version-bump detector, not slip in unnoticed.
#
# Versions chosen 2026-04-19; bump via the starter-versions manifest and
# a weekly CI detector run (see scripts/check-starter-versions.mjs).
#
# The `node:20-slim` base ships yarn 1.x PRE-INSTALLED at
# /usr/local/bin/yarn (as a plain symlink into a corepack shim layout in
# newer images, or a real binary in older ones). `npm install -g
# yarn@1.22.22` refuses to overwrite that with `EEXIST: File exists`, so
# we delete the shipped copy first rather than using `npm install
# --force` (which would also mask real conflicts if we ever add another
# global). Same thing for `yarnpkg` — a sibling symlink that npm's bin-
# linking also tries to place.
ARG PNPM_VERSION=9.15.0
ARG YARN_VERSION=1.22.22
RUN rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && npm install -g --no-audit --no-fund \
       pnpm@${PNPM_VERSION} \
       yarn@${YARN_VERSION} \
  && npm cache clean --force

# Drop to an unprivileged user. `node:20-slim` ships a `node` UID 1000
# by default; we reuse it rather than adding a second user so volume
# mounts from the host (uid 1000 agenthub) line up without chown dances.
WORKDIR /app
RUN chown -R node:node /app
USER node

# The tiny healthcheck/echo HTTP server. Used only when the PR repo
# didn't ship a runnable command — Nginx still needs *something* on the
# mapped port to return 200 so the healthcheck probe (§3.1 of the
# compose template) doesn't mark the slot `failed` and reap it.
COPY --chown=node:node healthcheck.mjs /app/healthcheck.mjs

# Default $PORT matches the compose template's host-port mapping target
# (3000). The scaffold base overrides ENTRYPOINT; PR env stays on CMD so
# the PR's own image can `CMD ["npm", "start"]` if it inherits FROM us.
ENV PORT=3000
EXPOSE 3000

# tini reaps zombies and forwards SIGTERM → Node so `docker compose down
# --timeout 30` can drain gracefully. Without this, Node as PID 1 ignores
# SIGTERM and we wait the full timeout every teardown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/healthcheck.mjs"]
