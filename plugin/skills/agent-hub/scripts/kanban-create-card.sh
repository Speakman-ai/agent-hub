#!/usr/bin/env bash
# scripts/kanban-create-card.sh — create a kanban card with flag-based args.
#
# Usage:
#   kanban-create-card.sh [options]
#
# Options:
#   --title <str>         card title (required)
#   --column <name>       column name (default: To Do). Resolved via
#                         resolve-column-id.sh.
#   --description <str>   card description (supports markdown)
#   --priority <level>    one of: low, medium, high (default: medium)
#   --labels <csv>        comma-separated labels (e.g. bug,urgent)
#   --assignee <str>      assignee string
#   --epic-id <uuid>      link to an epic
#   --session-id <id>     link card to a session (usually $AGENT_HUB_SESSION_ID)
#   -h, --help            print this help
#
# Environment:
#   PROJECT_ID   required
#   AGENT_HUB_URL / API key — resolved by ah-api.sh
#
# Exit codes:
#   0  created; JSON card returned on stdout
#   2  bad invocation
#   *  curl / API error

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ah-api.sh
source "$DIR/ah-api.sh"

_usage() {
  cat <<'EOF'
usage: kanban-create-card.sh --title <str> [options]

Create a kanban card on the board for $PROJECT_ID.

Options:
  --title <str>         card title                       (required)
  --column <name>       column name (default: To Do)
  --description <str>   markdown description
  --priority <level>    low | medium | high (default: medium)
  --labels <csv>        comma-separated labels
  --assignee <str>      assignee
  --epic-id <uuid>      link to epic
  --session-id <id>     link to session
  -h, --help            print this help

Example:
  PROJECT_ID=agent-hub kanban-create-card.sh \
    --title "Fix auth race condition" \
    --column "To Do" \
    --priority high \
    --labels bug,security \
    --session-id "$AGENT_HUB_SESSION_ID"
EOF
}

title=""
column="To Do"
description=""
priority="medium"
labels=""
assignee=""
epic_id=""
session_id=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)        title="${2:-}"; shift 2 ;;
    --column)       column="${2:-}"; shift 2 ;;
    --description)  description="${2:-}"; shift 2 ;;
    --priority)     priority="${2:-}"; shift 2 ;;
    --labels)       labels="${2:-}"; shift 2 ;;
    --assignee)     assignee="${2:-}"; shift 2 ;;
    --epic-id)      epic_id="${2:-}"; shift 2 ;;
    --session-id)   session_id="${2:-}"; shift 2 ;;
    -h|--help|help) _usage; exit 0 ;;
    *)
      echo "error: unknown option '$1'" >&2
      _usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$title" ]]; then
  echo "error: --title is required" >&2
  exit 2
fi
if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "error: PROJECT_ID must be set" >&2
  exit 2
fi
case "$priority" in
  low|medium|high) ;;
  *)
    echo "error: --priority must be one of: low, medium, high (got '$priority')" >&2
    exit 2
    ;;
esac

# Resolve column name → UUID via the sibling script; surface its error verbatim.
column_id="$("$DIR/resolve-column-id.sh" "$column")"

# Build JSON body with python3 for safe escaping (titles may contain quotes).
# NB: POST /board/cards does NOT accept epic_id — epic linking is a separate
# endpoint (`POST /board/cards/:id/epic`). We omit epic from the create payload
# and chain a second call below if --epic-id was supplied.
body="$(
  AH_TITLE="$title" \
  AH_DESC="$description" \
  AH_COL="$column_id" \
  AH_PRIO="$priority" \
  AH_LABELS="$labels" \
  AH_ASSIGNEE="$assignee" \
  AH_SESSION="$session_id" \
  python3 <<'PY'
import json, os
payload = {
    "title":       os.environ["AH_TITLE"],
    "columnId":    os.environ["AH_COL"],
    "priority":    os.environ["AH_PRIO"],
}
for key, env in [
    ("description", "AH_DESC"),
    ("labels",      "AH_LABELS"),
    ("assignee",    "AH_ASSIGNEE"),
    ("session_id",  "AH_SESSION"),
]:
    v = os.environ.get(env, "")
    if v:
        payload[key] = v
print(json.dumps(payload))
PY
)"

card_json="$(ah_api POST "/api/projects/$PROJECT_ID/board/cards" -d "$body")"

# Chain the epic link when requested. Failing this leaves the card created but
# unlinked — surface that by exiting non-zero so the caller can retry or fix.
if [[ -n "$epic_id" ]]; then
  card_id="$(
    AH_CARD="$card_json" python3 -c '
import json, os, sys
c = json.loads(os.environ["AH_CARD"])
cid = c.get("id")
if not cid:
    sys.stderr.write("error: create response had no id field\n")
    sys.exit(1)
print(cid)
'
  )"
  if ! linked_json="$(
    ah_api POST "/api/projects/$PROJECT_ID/board/cards/$card_id/epic" \
      -d "{\"epicId\":\"$epic_id\"}"
  )"; then
    echo "error: card $card_id created but epic link failed (epicId=$epic_id)" >&2
    exit 1
  fi
  printf '%s\n' "$linked_json"
else
  printf '%s\n' "$card_json"
fi
