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
#
# Auth resolution is delegated to `ah-api.sh:ah_resolve_key` (single source
# of truth). That function checks, in order:
#   1. $AGENT_HUB_API_KEY env var
#   2. Per-session spawn-creds file (writable mid-flight by the server, so
#      `/api/auth/setup` can recover sessions that were spawned before auth
#      existed). See `server/spawn-creds-file.ts`.
#   3. Legacy `apiKey` field in config.json.
# Resolution happens on EVERY hub_api call rather than at source-time, so a
# credential rotation or recovery-write is picked up without restarting the
# long-running shell that sourced this file.

set -euo pipefail

: "${AGENT_HUB_URL:=http://localhost:3051}"

# PROJECT_ID is required for most calls but we don't error-out here — some
# endpoints (e.g. /api/config, /api/projects) work without it. Individual
# scripts assert when they need it.

# Pull in ah_resolve_key from ah-api.sh. Sourcing is idempotent — ah-api.sh
# guards its own CLI frontend with `BASH_SOURCE[0] == $0`, so loading it
# here doesn't run the CLI.
# shellcheck source=./ah-api.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ah-api.sh"

# hub_api <METHOD> <PATH> [extra curl args...]
# Emits the raw JSON body to stdout. -f fails on non-2xx (body suppressed),
# -sS hides progress but shows errors. Accept header guards against SPA
# fallback returning HTML on unknown routes.
hub_api() {
  local method="$1"; shift
  local path="$1"; shift
  local auth_args=()
  local key
  key="$(ah_resolve_key)"
  if [[ -n "$key" ]]; then
    auth_args+=(-H "x-api-key: $key")
  fi
  local session_args=()
  if [[ -n "${AGENT_HUB_SESSION_ID:-}" ]]; then
    session_args+=(-H "X-Agent-Hub-Session-Id: $AGENT_HUB_SESSION_ID")
  fi
  curl -fsS -X "$method" \
    "${auth_args[@]}" \
    "${session_args[@]}" \
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
