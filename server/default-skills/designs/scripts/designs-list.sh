#!/usr/bin/env bash
# designs-list.sh — list every design in the active org.
#
# Usage:
#   designs-list.sh               # full JSON
#   designs-list.sh --ids         # just ids, one per line
#   designs-list.sh --names       # "id<TAB>name" table
#
# Env:
#   AGENT_HUB_URL      (default http://localhost:3051)
#   AGENT_HUB_API_KEY  (optional; resolves per ah-api.sh precedence)

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/../../agent-hub/scripts/ah-api.sh"

mode="${1:-json}"
raw="$(ah_api GET /api/designs)"

case "$mode" in
  json|'') printf '%s\n' "$raw" ;;
  --ids)
    if command -v jq >/dev/null 2>&1; then
      printf '%s' "$raw" | jq -r '.[].id'
    else
      printf '%s' "$raw" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
    fi
    ;;
  --names)
    if command -v jq >/dev/null 2>&1; then
      printf '%s' "$raw" | jq -r '.[] | "\(.id)\t\(.name)"'
    else
      echo "designs-list.sh: --names requires jq" >&2
      exit 2
    fi
    ;;
  -h|--help)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "designs-list.sh: unknown mode '$mode' (try --ids, --names, or omit for JSON)" >&2
    exit 2
    ;;
esac
