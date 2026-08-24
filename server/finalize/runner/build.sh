#!/usr/bin/env bash
# Build the Finalize CI runner image locally (dev fallback).
# Production images are built by CI and pushed to ECR Public:
#   public.ecr.aws/h9t4v7h0/agent-hub-finalize-runner:main
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../../.." && pwd)"
TAG="${FINALIZE_RUNNER_TAG:-agent-hub/finalize-runner:ubuntu-24.04}"

docker build -f "$ROOT/Dockerfile" -t "$TAG" "$REPO_ROOT"
echo "Built $TAG"
echo "Prod uses ECR — see ops/terraform/ecr-public.tf and CLAUDE.md (Finalize CI Runners)."
