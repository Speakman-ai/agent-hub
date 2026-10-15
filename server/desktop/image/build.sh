#!/usr/bin/env bash
# Build the agent desktop image locally. CI builds and publishes it to ECR
# Public next to the server and Finalize runner images.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../../.." && pwd)"
TAG="${DESKTOP_IMAGE_TAG:-agent-hub/desktop:dev}"

docker build -f "$ROOT/Dockerfile" -t "$TAG" "$REPO_ROOT"
echo "Built $TAG. Smoke-test it with: $ROOT/smoke-test.sh $TAG"
