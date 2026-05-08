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
#   linear_gql QUERY [VARIABLES_JSON]  → single request, prints JSON to stdout
#   require_linear_key                  → asserts LINEAR_API_KEY is set
#   linear_die MESSAGE                  → print to stderr + exit 1
#   pp_json                             → pretty-print JSON from stdin
#
# Prerequisites: bash 4+, curl, python3

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
# Sends exactly ONE GraphQL POST to the Linear API.
# - Uses mktemp for both the response-body and response-header files so
#   parallel calls in the same process tree don't collide.
# - The HTTP status code is captured via curl -w '%{http_code}' on that
#   same single invocation — there is no second curl call.
# - Retries once on HTTP 429, honouring X-RateLimit-Reset from the
#   response headers BEFORE deleting the header tempfile (capped at 10 s).
# - python3 is the sole error reporter: non-JSON responses and GraphQL
#   errors are printed to stderr then exit 1. The shell does not double-
#   print on the failure path.
# ---------------------------------------------------------------------------
linear_gql() {
  require_linear_key

  local query="$1"
  local variables="${2:-{}}"

  local body
  body=$(printf '{"query":%s,"variables":%s}' \
    "$(printf '%s' "$query" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')" \
    "$variables")

  local tmpbody tmphdr
  tmpbody=$(mktemp)
  tmphdr=$(mktemp)

  local attempts=0

  while true; do
    attempts=$((attempts + 1))

    # Single curl: body → tmpbody, headers → tmphdr, status code → http_code.
    # No second request is made — mutations fire exactly once.
    local http_code
    http_code=$(curl -sS \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: ${LINEAR_API_KEY}" \
      --data-raw "$body" \
      -D "$tmphdr" \
      -o "$tmpbody" \
      -w '%{http_code}' \
      "$LINEAR_GQL_URL" 2>&1) || true

    local raw_out
    raw_out=$(cat "$tmpbody")

    # Handle rate limiting BEFORE removing tmphdr (we still need the headers)
    if [[ "$http_code" == "429" ]] && [[ "$attempts" -lt 2 ]]; then
      # Read reset header before deleting the file
      local reset_at wait_sec=5
      reset_at=$(grep -i 'x-ratelimit-reset' "$tmphdr" 2>/dev/null \
        | awk '{print $2}' | tr -d '\r' || echo "")
      if [[ -n "$reset_at" ]]; then
        local now
        now=$(date +%s)
        wait_sec=$(( reset_at - now ))
        [[ "$wait_sec" -lt 1 ]] && wait_sec=1
        [[ "$wait_sec" -gt 10 ]] && wait_sec=10
      fi
      rm -f "$tmphdr"
      echo "warn: rate-limited; retrying in ${wait_sec}s..." >&2
      sleep "$wait_sec"
      continue
    fi

    rm -f "$tmphdr"

    # Check for non-JSON or GraphQL errors.
    # python3 is the sole error reporter — no double-printing from the shell.
    if ! echo "$raw_out" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except json.JSONDecodeError:
    print('error: Linear returned non-JSON response (proxy or network error?)', file=sys.stderr)
    sys.exit(1)
errs = d.get('errors')
if errs:
    for e in errs:
        print(e.get('message', str(e)), file=sys.stderr)
    sys.exit(1)
"; then
      rm -f "$tmpbody"
      exit 1
    fi

    echo "$raw_out"
    rm -f "$tmpbody"
    return 0
  done
}

# ---------------------------------------------------------------------------
# pp_json — pretty-print JSON (used in display subcommands)
# ---------------------------------------------------------------------------
pp_json() {
  python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))"
}
