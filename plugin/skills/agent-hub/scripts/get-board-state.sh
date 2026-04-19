#!/usr/bin/env bash
# scripts/get-board-state.sh — dump the full board (columns + cards + epics)
# as a single JSON object for agent consumption.
#
# Usage:
#   get-board-state.sh [--pretty]
#
# Environment:
#   PROJECT_ID  required
#
# Exit codes:
#   0  success
#   2  bad invocation
#   *  curl / API error

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ah-api.sh
source "$DIR/ah-api.sh"

_usage() {
  cat <<'EOF'
usage: get-board-state.sh [--pretty]

Fetch the complete board (columns, cards, epics) for $PROJECT_ID as JSON.

Options:
  --pretty    pretty-print output (requires jq or python3)
  -h, --help  print this help

Example:
  PROJECT_ID=agent-hub get-board-state.sh --pretty
EOF
}

pretty=0
case "${1:-}" in
  -h|--help|help) _usage; exit 0 ;;
  --pretty)       pretty=1 ;;
  '')             ;;
  *)
    echo "error: unknown option '$1'" >&2
    _usage >&2
    exit 2
    ;;
esac

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "error: PROJECT_ID must be set" >&2
  exit 2
fi

raw="$(ah_api GET "/api/projects/$PROJECT_ID/board")"

if [[ "$pretty" -eq 1 ]]; then
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$raw" | jq .
  elif command -v python3 >/dev/null 2>&1; then
    # Pipe via stdin — $raw can exceed MAX_ARG_STRLEN on large boards.
    python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin), indent=2))' <<<"$raw"
  else
    # Neither formatter available — still dump the JSON rather than failing.
    printf '%s\n' "$raw"
  fi
else
  printf '%s\n' "$raw"
fi
