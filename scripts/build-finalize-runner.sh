#!/usr/bin/env bash
# Build Finalize DinD runner images.
#
# Usage:
#   ./scripts/build-finalize-runner.sh          # native arch (arm64 on Apple Silicon)
#   ./scripts/build-finalize-runner.sh amd64    # GHA / production parity
#   ./scripts/build-finalize-runner.sh arm64    # native arm64 (local M-series dev)
#
# Tags:
#   agent-hub/finalize-runner:ubuntu-24.04        (native or explicit amd64)
#   agent-hub/finalize-runner:ubuntu-24.04-arm64  (arm64)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="$ROOT/server/finalize/runner/Dockerfile"
ARCH="${1:-native}"

case "$ARCH" in
  amd64)
    docker build --platform linux/amd64 \
      -f "$DOCKERFILE" \
      -t agent-hub/finalize-runner:ubuntu-24.04 \
      "$ROOT"
    echo "Built agent-hub/finalize-runner:ubuntu-24.04 (linux/amd64)"
    ;;
  arm64)
    docker build --platform linux/arm64 \
      -f "$DOCKERFILE" \
      -t agent-hub/finalize-runner:ubuntu-24.04-arm64 \
      "$ROOT"
    echo "Built agent-hub/finalize-runner:ubuntu-24.04-arm64 (linux/arm64)"
    ;;
  native)
    docker build \
      -f "$DOCKERFILE" \
      -t agent-hub/finalize-runner:ubuntu-24.04 \
      "$ROOT"
    echo "Built agent-hub/finalize-runner:ubuntu-24.04 (native $(uname -m))"
    ;;
  *)
    echo "Usage: $0 [amd64|arm64|native]" >&2
    exit 1
    ;;
esac

echo ""
echo "Debug a Finalize run locally against a session worktree:"
echo "  FINALIZE_RUNNER_IMAGE=agent-hub/finalize-runner:ubuntu-24.04 \\"
echo "    ./scripts/debug-finalize-runner.sh start <worktree-path>"
