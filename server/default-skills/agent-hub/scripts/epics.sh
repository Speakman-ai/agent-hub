#!/usr/bin/env bash
# scripts/epics.sh — kanban epics wrapper.
#
# Subcommands:
#   list                        list epics for $PROJECT_ID
#   create <json>               POST a new epic
#   link   <cardId> <epicId>    attach a card to an epic (PUT cards/:id with epic_id)
#   unlink <cardId>             detach a card (sets epic_id to null)

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

require_var PROJECT_ID

cmd="${1:-help}"
shift || true

case "$cmd" in
  list)
    hub_api GET "/api/projects/$PROJECT_ID/board/epics"
    ;;
  create)
    body="${1:-}"
    [[ -n "$body" ]] || usage_die "usage: epics.sh create '<json>'"
    hub_api POST "/api/projects/$PROJECT_ID/board/epics" -d "$body"
    ;;
  link)
    card="${1:-}"; epic="${2:-}"
    [[ -n "$card" && -n "$epic" ]] || usage_die "usage: epics.sh link <cardId> <epicId>"
    hub_api PUT "/api/projects/$PROJECT_ID/board/cards/$card" \
      -d "{\"epic_id\":\"$epic\"}"
    ;;
  unlink)
    card="${1:-}"
    [[ -n "$card" ]] || usage_die "usage: epics.sh unlink <cardId>"
    hub_api PUT "/api/projects/$PROJECT_ID/board/cards/$card" \
      -d '{"epic_id":null}'
    ;;
  help|-h|--help|'')
    cat <<EOF
usage: epics.sh <subcommand> [args]
  list
  create <json>
  link   <cardId> <epicId>
  unlink <cardId>
EOF
    ;;
  *)
    usage_die "unknown subcommand: $cmd (try epics.sh help)"
    ;;
esac
