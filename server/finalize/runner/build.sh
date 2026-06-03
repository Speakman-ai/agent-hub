#!/usr/bin/env bash
# Build the Finalize CI runner image locally (dev fallback).
# Production images are built by CI and pushed to ECR Public:
#   public.ecr.aws/h9t4v7h0/agent-hub-finalize-runner:main
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$ROOT/../.." && pwd)" # server/
TAG="${FINALIZE_RUNNER_TAG:-agent-hub/finalize-runner:ubuntu-24.04}"

# Bundle the pull-based runner agent into a single self-contained ESM file the
# image's `agent` entrypoint mode runs (node /usr/local/bin/runner-agent.mjs).
# Emitted into the build context so `docker build "$ROOT"` can COPY it.
echo "Bundling runner-agent → $ROOT/runner-agent.mjs"
(cd "$SERVER_DIR" && npx --no-install esbuild finalize/runner-agent-cli.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
  --outfile="$ROOT/runner-agent.mjs")

docker build -t "$TAG" "$ROOT"
echo "Built $TAG"
echo "Prod uses ECR — see ops/terraform/ecr-public.tf and CLAUDE.md (Finalize CI Runners)."
