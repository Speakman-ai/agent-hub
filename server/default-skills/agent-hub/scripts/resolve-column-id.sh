#!/usr/bin/env bash
# scripts/resolve-column-id.sh — translate a kanban column name into its UUID.
#
# Usage:
#   resolve-column-id.sh <columnName>
#
# Column name match is case-insensitive. Prints the UUID to stdout.
# Exit codes:
#   0  match found (UUID printed)
#   2  bad invocation or column not found (suggestion printed to stderr)
#   *  curl / API error
#
# Environment:
#   PROJECT_ID        required — the project slug, e.g. agent-hub
#   AGENT_HUB_URL     default http://localhost:3051
#   AGENT_HUB_API_KEY see ah-api.sh for resolution order

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ah-api.sh
source "$DIR/ah-api.sh"

_usage() {
  cat <<'EOF'
usage: resolve-column-id.sh <columnName>

Resolve a kanban column name (case-insensitive) to its UUID for the project
identified by $PROJECT_ID. Standard columns are:
  To Do, In Progress, Review, Done

Example:
  PROJECT_ID=agent-hub resolve-column-id.sh "In Progress"
  #=> 0a60cfce-0108-4eea-a209-46f1bd764c1a

Exit codes:
  0  UUID printed to stdout
  2  bad invocation or column not found
EOF
}

case "${1:-}" in
  -h|--help|help)
    _usage
    exit 0
    ;;
  '')
    _usage >&2
    exit 2
    ;;
esac

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "error: PROJECT_ID must be set (e.g. PROJECT_ID=agent-hub)" >&2
  exit 2
fi

want="$1"
board_json="$(ah_api GET "/api/projects/$PROJECT_ID/board")"

if command -v jq >/dev/null 2>&1; then
  uuid="$(
    printf '%s' "$board_json" \
      | jq -r --arg want "$want" '
          .columns
          | map(select((.name|ascii_downcase) == ($want|ascii_downcase)))
          | .[0].id // empty
        '
  )"
  if [[ -z "$uuid" ]]; then
    names="$(printf '%s' "$board_json" | jq -r '.columns | map(.name) | join(", ")')"
    echo "error: column '$want' not found. Available: $names" >&2
    exit 2
  fi
  printf '%s\n' "$uuid"
elif command -v python3 >/dev/null 2>&1; then
  AH_COL_WANT="$want" AH_COL_JSON="$board_json" python3 <<'PY'
import json, os, sys
want = os.environ["AH_COL_WANT"].strip().lower()
data = json.loads(os.environ["AH_COL_JSON"])
cols = data.get("columns", [])
for c in cols:
    if c.get("name", "").strip().lower() == want:
        print(c["id"])
        sys.exit(0)
names = ", ".join(c.get("name", "") for c in cols)
sys.stderr.write(
    f"error: column {os.environ['AH_COL_WANT']!r} not found. Available: {names}\n"
)
sys.exit(2)
PY
else
  echo "error: resolve-column-id.sh needs either 'jq' or 'python3' installed" >&2
  exit 2
fi
