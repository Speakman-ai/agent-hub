#!/usr/bin/env bash
# Build Finalize DinD runner images.
#
# Usage:
#   ./scripts/build-finalize-runner.sh          # native arch (arm64 on Apple Silicon)
#   ./scripts/build-finalize-runner.sh amd64    # GHA / production parity
#   ./scripts/build-finalize-runner.sh arm64    # native arm64 (local M-series dev)
#
# Tags:
#   agent-hub/finalize-runner:ubuntu-24.04        (amd64)
#   agent-hub/finalize-runner:ubuntu-24.04-arm64  (arm64)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CTX="$ROOT/server/finalize/runner"
ARCH="${1:-native}"

case "$ARCH" in
  amd64)
    docker build --platform linux/amd64 \
      -t agent-hub/finalize-runner:ubuntu-24.04 \
      "$CTX"
    echo "Built agent-hub/finalize-runner:ubuntu-24.04 (linux/amd64)"
    ;;
  arm64)
    docker build --platform linux/arm64 \
      -t agent-hub/finalize-runner:ubuntu-24.04-arm64 \
      "$CTX"
    echo "Built agent-hub/finalize-runner:ubuntu-24.04-arm64 (linux/arm64)"
    ;;
  native)
    docker build -t agent-hub/finalize-runner:ubuntu-24.04-arm64 "$CTX"
    echo "Built agent-hub/finalize-runner:ubuntu-24.04-arm64 (native $(uname -m))"
    ;;
  *)
    echo "Usage: $0 [amd64|arm64|native]" >&2
    exit 1
    ;;
esac

echo ""
echo "Run surveytracker CI locally:"
echo "  FINALIZE_RUNNER_IMAGE=agent-hub/finalize-runner:ubuntu-24.04-arm64 \\"
echo "    ./scripts/run-surveytracker-master-ci.sh /tmp/surveytracker-master"
