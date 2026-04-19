#!/usr/bin/env bash
# scripts/_common.sh — shared helpers for every scripts/*.sh wrapper in the
# agent-hub skill. Source, don't exec:
#
#     DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     source "$DIR/_common.sh"
#
# Exposes:
#   $AGENT_HUB_URL   base URL (default http://localhost:3051)
#   $PROJECT_ID      current project slug (required for /api/projects/<id>/...)
#   hub_api METHOD PATH [curl args...]   → curl wrapper with auth + JSON header

set -euo pipefail

: "${AGENT_HUB_URL:=http://localhost:3051}"

# PROJECT_ID is required for most calls but we don't error-out here — some
# endpoints (e.g. /api/config, /api/projects) work without it. Individual
# scripts assert when they need it.

_HUB_AUTH_ARGS=()
if [[ -n "${AGENT_HUB_API_KEY:-}" ]]; then
  _HUB_AUTH_ARGS+=(-H "x-api-key: ${AGENT_HUB_API_KEY}")
fi

# hub_api <METHOD> <PATH> [extra curl args...]
# Emits the raw JSON body to stdout. -f fails on non-2xx (body suppressed),
# -sS hides progress but shows errors. Accept header guards against SPA
# fallback returning HTML on unknown routes.
hub_api() {
  local method="$1"; shift
  local path="$1"; shift
  curl -fsS -X "$method" \
    "${_HUB_AUTH_ARGS[@]}" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json' \
    "${AGENT_HUB_URL}${path}" \
    "$@"
}

# require_var <name> — abort with a clear message if unset or empty.
require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "error: $name must be set" >&2
    exit 2
  fi
}

# usage_die <message> — print usage + exit 2.
usage_die() {
  echo "$*" >&2
  exit 2
}
