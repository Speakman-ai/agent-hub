#!/usr/bin/env bash
# scripts/kanban-list.sh — list kanban cards, optionally filtered.
#
# Usage:
#   kanban-list.sh [--column <name>] [--epic <id>]
#
# With no flags: prints every card as a JSON array.
# With --column: prints cards in that column.
# With --epic:   prints cards linked to that epic id.
# Flags may be combined.
#
# Environment:
#   PROJECT_ID   required
#
# Exit codes:
#   0  success; JSON array printed
#   2  bad invocation or unknown column
#   *  curl / API error

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ah-api.sh
source "$DIR/ah-api.sh"

_usage() {
  cat <<'EOF'
usage: kanban-list.sh [--column <name>] [--epic <id>]

List kanban cards for $PROJECT_ID as a JSON array on stdout.

Options:
  --column <name>   filter to one column (case-insensitive)
  --epic <id>       filter to one epic UUID
  -h, --help        print this help

Example:
  PROJECT_ID=agent-hub kanban-list.sh --column "In Progress"
  PROJECT_ID=agent-hub kanban-list.sh --epic 1234-... --column Backlog
EOF
}

column_name=""
epic_id=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --column)  column_name="${2:-}"; shift 2 ;;
    --epic)    epic_id="${2:-}"; shift 2 ;;
    -h|--help|help) _usage; exit 0 ;;
    *)
      echo "error: unknown option '$1'" >&2
      _usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "error: PROJECT_ID must be set" >&2
  exit 2
fi

column_id=""
if [[ -n "$column_name" ]]; then
  column_id="$("$DIR/resolve-column-id.sh" "$column_name")"
fi

cards_json="$(ah_api GET "/api/projects/$PROJECT_ID/board/cards")"

if [[ -z "$column_id" && -z "$epic_id" ]]; then
  printf '%s\n' "$cards_json"
  exit 0
fi

# Pipe cards JSON through stdin — env vars have a MAX_ARG_STRLEN ceiling
# (~128 KB on Linux) that large boards blow past. Filter criteria stay in env.
AH_COL="$column_id" AH_EPIC="$epic_id" python3 -c '
import json, os, sys
cards = json.load(sys.stdin)
col = os.environ.get("AH_COL", "") or None
epic = os.environ.get("AH_EPIC", "") or None
out = []
for c in cards:
    if col is not None and c.get("column_id") != col:
        continue
    if epic is not None and c.get("epic_id") != epic:
        continue
    out.append(c)
json.dump(out, sys.stdout)
print()
' <<<"$cards_json"
