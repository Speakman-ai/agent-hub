#!/usr/bin/env bash
# scripts/_common.sh — shared auth helper for Linear skill scripts.
# Source, don't exec:
#
#     DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     source "$DIR/_common.sh"
#
# Exposes:
#   $LINEAR_API_KEY   resolved API key (or exits with an error if unset)
#   $LINEAR_GQL_URL   GraphQL endpoint (default https://api.linear.app/graphql)
#   linear_gql QUERY [VARIABLES_JSON]  → runs a GraphQL request, prints JSON to stdout
#   require_linear_key                  → asserts LINEAR_API_KEY is set
#   linear_die MESSAGE                  → print to stderr + exit 1

set -euo pipefail

: "${LINEAR_GQL_URL:=https://api.linear.app/graphql}"

# ---------------------------------------------------------------------------
# require_linear_key — abort with a helpful error when the key is not set
# ---------------------------------------------------------------------------
require_linear_key() {
  if [[ -z "${LINEAR_API_KEY:-}" ]]; then
    cat >&2 <<'HELP'
error: LINEAR_API_KEY is not set.

To fix:
  1. Open Agent Hub → Settings → Skills → Credentials → Linear
  2. Paste your personal API key (from https://linear.app/settings/api)
     and save. Agent Hub will inject it automatically next session.

Alternatively: export LINEAR_API_KEY="lin_api_..." before spawning the agent.
HELP
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# linear_die MESSAGE — print to stderr + exit 1
# ---------------------------------------------------------------------------
linear_die() {
  echo "error: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# linear_gql QUERY [VARIABLES_JSON]
#
# Sends a GraphQL request to the Linear API.
# - Automatically retries once on HTTP 429 (rate limit) after waiting for
#   X-RateLimit-Reset (capped at 10 s).
# - Prints the full JSON response to stdout.
# - Exits non-zero and prints errors to stderr when the response contains
#   a top-level "errors" array.
# ---------------------------------------------------------------------------
linear_gql() {
  require_linear_key

  local query="$1"
  local variables="${2:-{}}"

  local body
  body=$(printf '{"query":%s,"variables":%s}' \
    "$(printf '%s' "$query" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')" \
    "$variables")

  local response http_code
  local attempts=0

  while true; do
    attempts=$((attempts + 1))

    # -w appends "|||<http_code>" so we can peel out the status
    response=$(curl -fsS \
      -o /dev/null \
      -w '%{http_code}' \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: ${LINEAR_API_KEY}" \
      --data-raw "$body" \
      "$LINEAR_GQL_URL" 2>/dev/null || true)

    # Re-run capturing body
    local raw_out
    raw_out=$(curl -sS \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: ${LINEAR_API_KEY}" \
      --data-raw "$body" \
      -D /tmp/linear_headers_$$ \
      "$LINEAR_GQL_URL" 2>&1)
    http_code=$(grep -i '^HTTP/' /tmp/linear_headers_$$ 2>/dev/null | tail -1 | awk '{print $2}' || echo "200")
    rm -f /tmp/linear_headers_$$

    if [[ "$http_code" == "429" ]] && [[ "$attempts" -lt 2 ]]; then
      local reset_at
      reset_at=$(grep -i 'x-ratelimit-reset' /tmp/linear_headers_$$ 2>/dev/null | awk '{print $2}' | tr -d '\r' || echo "")
      local wait_sec=5
      if [[ -n "$reset_at" ]]; then
        local now
        now=$(date +%s)
        wait_sec=$(( reset_at - now ))
        [[ "$wait_sec" -lt 1 ]] && wait_sec=1
        [[ "$wait_sec" -gt 10 ]] && wait_sec=10
      fi
      echo "warn: rate-limited; retrying in ${wait_sec}s..." >&2
      sleep "$wait_sec"
      continue
    fi

    # Check GraphQL-layer errors (status 200 but errors array present)
    if echo "$raw_out" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    errs = d.get('errors')
    if errs:
        for e in errs:
            print(e.get('message', str(e)), file=sys.stderr)
        sys.exit(1)
except Exception:
    pass
" 2>&1; then
      : # no errors
    else
      # python3 exited non-zero (errors found) — already printed to stderr above
      echo "$raw_out" >&2
      exit 1
    fi

    echo "$raw_out"
    return 0
  done
}

# ---------------------------------------------------------------------------
# pp_json — pretty-print JSON (used in display subcommands)
# ---------------------------------------------------------------------------
pp_json() {
  python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))"
}
