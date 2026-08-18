#!/usr/bin/env bash
# scripts/heartbeats.sh — retired.
#
# Per-agent heartbeat check-ins are no longer scheduled or exposed over the
# API. Use project crons instead: crons.sh

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

echo "heartbeats.sh: per-agent heartbeats are retired. Use crons.sh for scheduled jobs." >&2
exit 1
