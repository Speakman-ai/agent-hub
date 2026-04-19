#!/usr/bin/env bash
# scripts/crons.sh — project cron jobs wrapper.
#
# Subcommands:
#   list                         list crons
#   create <json>                create a cron
#   update <cronId> <json>       update a cron
#   delete <cronId>              delete a cron
#   run    <cronId>              trigger a run now
#   logs   <cronId>              execution logs
#   thread <cronId>              persistent thread log

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

cmd="${1:-help}"
shift || true

case "$cmd" in
  list)
    hub_api GET "/api/crons"
    ;;
  create)
    body="${1:-}"
    [[ -n "$body" ]] || usage_die "usage: crons.sh create '<json>'"
    hub_api POST "/api/crons" -d "$body"
    ;;
  update)
    id="${1:-}"; body="${2:-}"
    [[ -n "$id" && -n "$body" ]] || usage_die "usage: crons.sh update <cronId> '<json>'"
    hub_api PUT "/api/crons/$id" -d "$body"
    ;;
  delete)
    id="${1:-}"
    [[ -n "$id" ]] || usage_die "usage: crons.sh delete <cronId>"
    hub_api DELETE "/api/crons/$id"
    ;;
  run)
    id="${1:-}"
    [[ -n "$id" ]] || usage_die "usage: crons.sh run <cronId>"
    hub_api POST "/api/crons/$id/run"
    ;;
  logs)
    id="${1:-}"
    [[ -n "$id" ]] || usage_die "usage: crons.sh logs <cronId>"
    hub_api GET "/api/crons/$id/logs"
    ;;
  thread)
    id="${1:-}"
    [[ -n "$id" ]] || usage_die "usage: crons.sh thread <cronId>"
    hub_api GET "/api/crons/$id/thread"
    ;;
  help|-h|--help|'')
    cat <<EOF
usage: crons.sh <subcommand> [args]
  list
  create <json>
  update <cronId> <json>
  delete <cronId>
  run    <cronId>
  logs   <cronId>
  thread <cronId>
EOF
    ;;
  *)
    usage_die "unknown subcommand: $cmd (try crons.sh help)"
    ;;
esac
