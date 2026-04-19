#!/usr/bin/env bash
# scripts/kanban-move-card.sh — move a card to a column by name.
#
# Usage:
#   kanban-move-card.sh <cardId> <columnName>
#
# Example:
#   PROJECT_ID=agent-hub kanban-move-card.sh cee03e2f-... "In Progress"
#
# Exit codes:
#   0  moved; updated card JSON on stdout
#   2  bad invocation or unknown column
#   *  curl / API error

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ah-api.sh
source "$DIR/ah-api.sh"

_usage() {
  cat <<'EOF'
usage: kanban-move-card.sh <cardId> <columnName>

Move a kanban card to the named column. The column name is resolved via
resolve-column-id.sh (case-insensitive, helpful error if unknown).

Example:
  PROJECT_ID=agent-hub kanban-move-card.sh cee03e2f-... "In Progress"

Exit codes:
  0  moved
  2  bad invocation or unknown column
EOF
}

case "${1:-}" in
  -h|--help|help)
    _usage; exit 0 ;;
esac

if [[ $# -ne 2 ]]; then
  _usage >&2
  exit 2
fi

card_id="$1"
column_name="$2"

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "error: PROJECT_ID must be set" >&2
  exit 2
fi

column_id="$("$DIR/resolve-column-id.sh" "$column_name")"

ah_api POST "/api/projects/$PROJECT_ID/board/cards/$card_id/move" \
  -d "{\"columnId\":\"$column_id\"}"
