# syntax=docker/dockerfile:1.7
# Container pool — fat scaffold base image (W3).
#
# Target: ~700 MiB compressed, ~900 MiB uncompressed.
#
# This image is consumed by scaffolding jobs that run
# `create-next-app` / `create-expo-app` and push the generated tree to
# the user's GitHub repo (spec §5.2 of "Container Pool — PR Envs +
# Scaffolding"). We pre-bake the template `node_modules/` directories so
# scaffold jobs avoid the ~90 s `npm install` on the critical path —
# required to hit the 5-minute dogfood SLA.
#
# How the bake works:
#   For each template, we run the real CLI (`npx create-next-app@<v>
#   ...`) against a throwaway directory at build time. The resulting
#   tree (app code + node_modules/ + lockfile) is moved to
#   /scaffold/templates/<name>. At run time, scaffold.sh copies it to
#   /work/<user-name>, mutates package.json metadata (name, description),
#   runs `git init && git commit`, then `gh repo create --push`.
#
# Scope of pre-baked templates in THIS PR (W3 card):
#   - next   → create-next-app (App Router, TS, Tailwind, src/, eslint)
#   - expo   → create-expo-app (TypeScript template)
#
# Not in this PR (follow-up tickets; spec §5.2 lists 5):
#   - vite, cli-starter, astro — deferred until W4 so the PR stays
#     focused on the two templates the card explicitly calls out.
#
# Tag convention (pushed by .github/workflows/base-images.yml):
#   ghcr.io/<owner>/agent-hub/scaffold-base:YYYYMMDD  (always, immutable)
#   ghcr.io/<owner>/agent-hub/scaffold-base:latest    (only when no
#                                                      upstream major
#                                                      bump is detected)
#
# Cache invalidation (spec §5.3):
#   - Weekly schedule rebuilds BOTH tags with fresh registry metadata.
#   - Weekly version-bump detector (scripts/check-starter-versions.mjs)
#     runs BEFORE the build; if any template's MAJOR version jumped
#     (e.g. create-next-app 15 → 16), the workflow skips the `:latest`
#     retag and opens a GitHub issue for human approval — so a Monday
#     demo doesn't blow up because Vercel shipped Next 16 over the
#     weekend. The `:YYYYMMDD` tag is still pushed so the exact image
#     used is recoverable/auditable.

# Pull `pr-env-base` from the same registry this image is pushed to.
# At build time the caller passes BASE_IMAGE=ghcr.io/<owner>/agent-hub
# /pr-env-base:<tag>, so the scaffold base inherits Node, pnpm, yarn,
# git, curl, openssl, ca-certificates, tini, and the `node` user.
ARG BASE_IMAGE=agent-hub/pr-env-base:latest
FROM ${BASE_IMAGE} AS scaffold-base

USER root

# GitHub CLI — required by scaffold.sh to `gh auth login --with-token`
# and `gh repo create --push` against the user's account. We install
# from the official keyring + apt repo (not the `gh` npm package —
# that's a different project, same name, no release parity).
#
# Pinned to a specific major via GH_CLI_VERSION so nightly rebuilds
# are reproducible. Bump via the starter-versions manifest.
ARG GH_CLI_VERSION=2.62.0
RUN set -eux; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /usr/share/keyrings/githubcli-archive-keyring.gpg > /dev/null; \
    chmod 0644 /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "gh=${GH_CLI_VERSION}*"; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    gh --version

# Scaffold workspace layout:
#   /scaffold/templates/<name>/   pre-baked tree (code + node_modules)
#   /scaffold/scaffold.sh         entrypoint (mutates + pushes to GitHub)
#   /work/                        runtime scratch (tmpfs in compose)
RUN mkdir -p /scaffold/templates /work \
  && chown -R node:node /scaffold /work

# Template pins — bump via the starter-versions detector. The MAJOR
# in the pin must match docker/starter-versions.json; the detector fails
# the workflow if they drift, which keeps the Dockerfile as the single
# source of truth for what's actually baked into the image.
ARG CREATE_NEXT_APP_VERSION=15.0.0
ARG CREATE_EXPO_APP_VERSION=3.0.0

# --- Bake: create-next-app (Next.js 15, App Router, TypeScript, Tailwind)
#
# Flags are non-interactive so the build doesn't hang:
#   --ts              TypeScript
#   --tailwind        Tailwind CSS
#   --eslint          ESLint config
#   --app             App Router (not Pages)
#   --src-dir         src/ layout
#   --import-alias    @/*
#   --use-npm         force npm lockfile (pnpm would store under
#                     ~/.local/share/pnpm/store by default and bloat
#                     the image layer silently)
#   --skip-install    we want to control `npm install` ourselves so we
#                     can run it with --omit=dev? → NO, we keep dev deps
#                     because `next dev` is the first thing the user
#                     will run after clone. Drop --skip-install.
USER node
WORKDIR /scaffold/templates
RUN set -eux; \
    npx --yes create-next-app@${CREATE_NEXT_APP_VERSION} next \
      --ts \
      --tailwind \
      --eslint \
      --app \
      --src-dir \
      --import-alias "@/*" \
      --use-npm \
      --no-turbopack \
      --yes; \
    # Prune npm cache inside the template — we don't need it baked in,
    # and it's ~50 MiB of tarballs duplicated from the global cache.
    rm -rf next/.next; \
    du -sh next

# --- Bake: create-expo-app (Expo TypeScript blank template)
#
# create-expo-app is far less flag-rich than create-next-app. The
# `--template blank-typescript` option covers the same "TS, no
# opinionated extras" shape we want. `--yes` suppresses the "which
# template?" prompt.
RUN set -eux; \
    npx --yes create-expo-app@${CREATE_EXPO_APP_VERSION} expo \
      --template blank-typescript \
      --yes; \
    du -sh expo

# Runtime scripts (owned by node so tmpfs+read_only-friendly variants
# of the compose template still execute them).
USER root
COPY --chown=node:node scaffold.sh /scaffold/scaffold.sh
RUN chmod 0755 /scaffold/scaffold.sh

# Scaffold jobs don't need a long-lived listener; the compose template
# uses `restart: "no"`. ENTRYPOINT executes scaffold.sh and exits 0 on
# success / non-zero on failure, which the lifecycle layer surfaces as
# a structured ExitReason.
USER node
WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "--", "/scaffold/scaffold.sh"]
CMD []
