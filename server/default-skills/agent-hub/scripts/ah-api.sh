#!/usr/bin/env bash
# scripts/ah-api.sh — single source of auth truth for the agent-hub skill.
#
# Every other wrapper in this directory resolves the API key through this
# script (either by invoking it or by sourcing it). Do NOT inline
# ${AGENT_HUB_API_KEY} reads anywhere else.
#
# Usage (CLI):
#   ah-api.sh <METHOD> <PATH> [curl args...]
#   ah-api.sh GET /api/health
#   ah-api.sh POST /api/projects/agent-hub/board/cards -d '{"title":"foo"}'
#
# Usage (library — source instead of exec):
#   source "$(dirname "$0")/ah-api.sh"   # exposes ah_api(), ah_resolve_key()
#
# Key resolution precedence (first non-empty wins):
#   1. $AGENT_HUB_API_KEY env var
#   2. Spawn-creds file at $AGENT_HUB_DATA_DIR/spawn-creds/$AGENT_HUB_SESSION_ID.token
#      (when both env vars set) — written by the server on /api/auth/setup
#      and at spawn time. Lets long-running agents recover from mid-flight
#      auth changes without a session restart.
#   3. Spawn-creds file at ~/.agent-hub/data/spawn-creds/$AGENT_HUB_SESSION_ID.token
#      (when AGENT_HUB_SESSION_ID set, AGENT_HUB_DATA_DIR unset/empty)
#   4. apiKey in $AGENT_HUB_DATA_DIR/config.json (when AGENT_HUB_DATA_DIR is set)
#   5. apiKey in ~/.agent-hub/data/config.json
#   6. (none — request sent without x-api-key header)
#
# Base URL:
#   $AGENT_HUB_URL (default http://localhost:3051)
#
# Exits with the underlying curl exit code on transport failure or non-2xx.

set -euo pipefail

: "${AGENT_HUB_URL:=http://localhost:3051}"

# ah_resolve_key — echoes the resolved API key (or empty string) to stdout.
ah_resolve_key() {
  if [[ -n "${AGENT_HUB_API_KEY:-}" ]]; then
    printf '%s' "$AGENT_HUB_API_KEY"
    return 0
  fi

  # ── Spawn-creds file (per-session, written by the server) ──────
  # Read fresh on every call so a credential rotation or a /api/auth/setup
  # that minted a key for this session is picked up without a restart.
  if [[ -n "${AGENT_HUB_SESSION_ID:-}" ]]; then
    local creds_candidates=()
    if [[ -n "${AGENT_HUB_DATA_DIR:-}" ]]; then
      creds_candidates+=("$AGENT_HUB_DATA_DIR/spawn-creds/${AGENT_HUB_SESSION_ID}.token")
    fi
    creds_candidates+=("$HOME/.agent-hub/data/spawn-creds/${AGENT_HUB_SESSION_ID}.token")
    local cfile
    for cfile in "${creds_candidates[@]}"; do
      [[ -r "$cfile" ]] || continue
      # The file holds the raw token, written 0600 by the server.
      # tr trims any stray newline a careless writer might leave.
      local tok
      tok="$(tr -d '\r\n' < "$cfile" || true)"
      if [[ -n "$tok" ]]; then
        printf '%s' "$tok"
        return 0
      fi
    done
  fi

  # ── apiKey from config.json (legacy break-glass shared secret) ──
  local candidates=()
  if [[ -n "${AGENT_HUB_DATA_DIR:-}" ]]; then
    candidates+=("$AGENT_HUB_DATA_DIR/config.json")
  fi
  candidates+=("$HOME/.agent-hub/data/config.json")

  local cfg
  for cfg in "${candidates[@]}"; do
    [[ -r "$cfg" ]] || continue
    local key=""
    if command -v jq >/dev/null 2>&1; then
      key="$(jq -r '.apiKey // empty' "$cfg" 2>/dev/null || true)"
    else
      # POSIX-ish fallback: grep the first "apiKey": "..." occurrence.
      # Only handles simple string values — good enough for config.json which
      # the server writes itself without escape sequences.
      key="$(sed -n 's/.*"apiKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -n1 || true)"
    fi
    if [[ -n "$key" ]]; then
      printf '%s' "$key"
      return 0
    fi
  done
  printf ''
}

# _ah_api_emit_failure — print HTTP status + JSON body + auth hint to stderr.
_ah_api_emit_failure() {
  local method="$1"
  local path="$2"
  local http_code="$3"
  local body_file="$4"
  local had_key="$5"

  echo "ah_api: HTTP ${http_code} on ${method} ${path}" >&2
  if [[ -s "$body_file" ]]; then
    cat "$body_file" >&2
    echo >&2
  fi
  if [[ "$http_code" == "401" || "$http_code" == "403" ]]; then
    if [[ "$had_key" != "1" ]]; then
      echo "ah_api: no API key was sent (AGENT_HUB_API_KEY empty and spawn-creds file missing)." >&2
      echo "ah_api: use scripts/kanban-create-card.sh or scripts/board.sh — not raw curl without auth." >&2
      if [[ -n "${AGENT_HUB_SESSION_ID:-}" ]]; then
        echo "ah_api: expected spawn-creds at \$AGENT_HUB_DATA_DIR/spawn-creds/\$AGENT_HUB_SESSION_ID.token" >&2
      fi
    else
      echo "ah_api: API key was sent but rejected — token may be revoked or the Hub URL may point at the wrong host." >&2
    fi
  fi
}

# ah_api <METHOD> <PATH> [curl args...] — JSON-aware curl wrapper. Emits the
# raw response body to stdout. Fails (exit 22) on non-2xx with the response
# body and an auth hint printed to stderr.
ah_api() {
  if [[ $# -lt 2 ]]; then
    echo "ah_api: usage: ah_api <METHOD> <PATH> [curl args...]" >&2
    return 2
  fi
  local method="$1"; shift
  local path="$1"; shift

  local auth_args=()
  local key
  key="$(ah_resolve_key)"
  local had_key=0
  if [[ -n "$key" ]]; then
    auth_args+=(-H "x-api-key: $key")
    had_key=1
  fi

  # Attach the acting session id so server routes that attribute work to a
  # session owner (kanban card linking, native PR author) can resolve it even
  # when the request authenticates with the global break-glass apiKey, which
  # carries no per-user identity. Harmless on routes that ignore the header.
  if [[ -n "${AGENT_HUB_SESSION_ID:-}" ]]; then
    auth_args+=(-H "X-Agent-Hub-Session-Id: $AGENT_HUB_SESSION_ID")
  fi

  local body_file
  body_file="$(mktemp)"
  local http_code
  http_code="$(
    curl -sS -X "$method" \
      "${auth_args[@]}" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json' \
      -o "$body_file" \
      -w '%{http_code}' \
      "${AGENT_HUB_URL}${path}" \
      "$@" || echo "000"
  )"

  if [[ "$http_code" == "000" ]]; then
    rm -f "$body_file"
    return 7
  fi

  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    _ah_api_emit_failure "$method" "$path" "$http_code" "$body_file" "$had_key"
    rm -f "$body_file"
    return 22
  fi

  cat "$body_file"
  rm -f "$body_file"
}

_ah_api_usage() {
  cat <<'EOF'
usage: ah-api.sh <METHOD> <PATH> [curl args...]

Proxies any HTTP call against the Agent Hub API with auth + JSON headers.
Resolves the API key from (in order):
  1. $AGENT_HUB_API_KEY
  2. $AGENT_HUB_DATA_DIR/spawn-creds/$AGENT_HUB_SESSION_ID.token
  3. ~/.agent-hub/data/spawn-creds/$AGENT_HUB_SESSION_ID.token
  4. $AGENT_HUB_DATA_DIR/config.json  (apiKey field)
  5. ~/.agent-hub/data/config.json    (apiKey field)

Environment:
  AGENT_HUB_URL         (default http://localhost:3051)
  AGENT_HUB_API_KEY     optional; overrides file fallbacks
  AGENT_HUB_DATA_DIR    optional alternate data dir
  AGENT_HUB_SESSION_ID  injected by server at spawn; enables spawn-creds lookup

Examples:
  ah-api.sh GET  /api/health
  ah-api.sh GET  /api/projects/agent-hub/board
  ah-api.sh POST /api/projects/agent-hub/board/cards -d '{"title":"foo"}'

Exit codes:
  0  success (2xx response)
  2  bad invocation (missing args, --help)
  *  curl exit code (e.g. 22 for HTTP error, 7 for connection refused)
EOF
}

# Only execute the CLI frontend when run directly, not when sourced.
# BASH_SOURCE[0] is this file; if it equals $0 we're being executed.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    -h|--help|help|'')
      _ah_api_usage
      [[ -z "${1:-}" ]] && exit 2 || exit 0
      ;;
  esac
  ah_api "$@"
fi
