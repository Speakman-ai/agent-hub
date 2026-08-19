#!/usr/bin/env bash
# scripts/wiki.sh — project wiki wrapper (FTS5 search + CRUD).
#
# Subcommands:
#   search <query>              FTS query (q=)
#   list   [category]           list all pages, optionally filter by category
#   read   <slug>               fetch a single page
#   create <json>               create a page
#   update <slug> <json>        update a page
#   document-backfill [limit]   start an on-demand docs-agent wiki review

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

require_var PROJECT_ID

cmd="${1:-help}"
shift || true

url_encode() {
  # BSD/GNU-portable minimal url encoder for query values (ASCII-only;
  # multi-byte UTF-8 chars will be mangled)
  local raw="$1"
  local out=""
  local i ch
  for (( i=0; i<${#raw}; i++ )); do
    ch="${raw:i:1}"
    case "$ch" in
      [a-zA-Z0-9._~-]) out+="$ch" ;;
      *) printf -v hex '%%%02X' "'$ch"; out+="$hex" ;;
    esac
  done
  printf '%s' "$out"
}

case "$cmd" in
  search)
    q="${1:-}"
    [[ -n "$q" ]] || usage_die "usage: wiki.sh search '<query>'"
    hub_api GET "/api/projects/$PROJECT_ID/wiki?q=$(url_encode "$q")"
    ;;
  list)
    cat_q="${1:-}"
    if [[ -n "$cat_q" ]]; then
      hub_api GET "/api/projects/$PROJECT_ID/wiki?category=$(url_encode "$cat_q")"
    else
      hub_api GET "/api/projects/$PROJECT_ID/wiki"
    fi
    ;;
  read)
    slug="${1:-}"
    [[ -n "$slug" ]] || usage_die "usage: wiki.sh read <slug>"
    hub_api GET "/api/projects/$PROJECT_ID/wiki/$slug"
    ;;
  create)
    body="${1:-}"
    [[ -n "$body" ]] || usage_die "usage: wiki.sh create '<json>'"
    hub_api POST "/api/projects/$PROJECT_ID/wiki" -d "$body"
    ;;
  update)
    slug="${1:-}"; body="${2:-}"
    [[ -n "$slug" && -n "$body" ]] || usage_die "usage: wiki.sh update <slug> '<json>'"
    hub_api PUT "/api/projects/$PROJECT_ID/wiki/$slug" -d "$body"
    ;;
  document-backfill)
    limit="${1:-}"
    if [[ -n "$limit" ]]; then
      hub_api POST "/api/projects/$PROJECT_ID/wiki/document-backfill" -d "{\"limit\":${limit}}"
    else
      hub_api POST "/api/projects/$PROJECT_ID/wiki/document-backfill" -d '{}'
    fi
    ;;
  help|-h|--help|'')
    cat <<EOF
usage: wiki.sh <subcommand> [args]
  search <query>
  list   [category]
  read   <slug>
  create <json>
  update <slug> <json>
  document-backfill [limit]   review oldest undocumented Done cards (on demand)
EOF
    ;;
  *)
    usage_die "unknown subcommand: $cmd (try wiki.sh help)"
    ;;
esac
