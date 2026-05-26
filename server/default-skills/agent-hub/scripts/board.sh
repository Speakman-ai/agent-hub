#!/usr/bin/env bash
# scripts/board.sh — kanban board wrapper.
#
# Subcommands:
#   get                               full board (columns + cards)
#   list                              flat list of cards
#   create <json>                     POST a new card
#   move   <cardId> <columnId>        move a card to a column
#   update <cardId> <json>            PATCH-ish update (PUT /cards/:id)
#   comment <cardId> <json>           POST a comment
#
# Requires: PROJECT_ID. Uses $AGENT_HUB_URL / $AGENT_HUB_API_KEY via _common.sh.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

require_var PROJECT_ID

cmd="${1:-help}"
shift || true

case "$cmd" in
  get)
    hub_api GET "/api/projects/$PROJECT_ID/board"
    ;;
  list)
    hub_api GET "/api/projects/$PROJECT_ID/board/cards"
    ;;
  create)
    body="${1:-}"
    [[ -n "$body" ]] || usage_die "usage: board.sh create '<json>'"
    # Session header is scoped to card create only (not hub_api globally).
    # When $AGENT_HUB_SESSION_ID is set we send both the caller's JSON (which may
    # already include session_id) and the header. The server prefers an explicit
    # body sessionId (including null to opt out); the header fills in when the
    # body key is omitted.
    if [[ -n "${AGENT_HUB_SESSION_ID:-}" ]]; then
      hub_api POST "/api/projects/$PROJECT_ID/board/cards" \
        -H "X-Agent-Hub-Session-Id: $AGENT_HUB_SESSION_ID" \
        -d "$body"
    else
      hub_api POST "/api/projects/$PROJECT_ID/board/cards" -d "$body"
    fi
    ;;
  move)
    card="${1:-}"; col="${2:-}"
    [[ -n "$card" && -n "$col" ]] || usage_die "usage: board.sh move <cardId> <columnId>"
    hub_api POST "/api/projects/$PROJECT_ID/board/cards/$card/move" \
      -d "{\"columnId\":\"$col\"}"
    ;;
  update)
    card="${1:-}"; body="${2:-}"
    [[ -n "$card" && -n "$body" ]] || usage_die "usage: board.sh update <cardId> '<json>'"
    hub_api PUT "/api/projects/$PROJECT_ID/board/cards/$card" -d "$body"
    ;;
  comment)
    card="${1:-}"; body="${2:-}"
    [[ -n "$card" && -n "$body" ]] || usage_die "usage: board.sh comment <cardId> '<json>'"
    hub_api POST "/api/projects/$PROJECT_ID/board/cards/$card/comments" -d "$body"
    ;;
  help|-h|--help|'')
    cat <<EOF
usage: board.sh <subcommand> [args]
  get                             full board
  list                            flat card list
  create <json>                   create a card
  move   <cardId> <columnId>      move a card
  update <cardId> <json>          update a card
  comment <cardId> <json>         add a comment
EOF
    ;;
  *)
    usage_die "unknown subcommand: $cmd (try board.sh help)"
    ;;
esac
