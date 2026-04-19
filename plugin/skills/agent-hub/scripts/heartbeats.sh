#!/usr/bin/env bash
# scripts/heartbeats.sh — per-agent scheduled check-ins.
#
# Subcommands:
#   list                       all heartbeats + state
#   state                      live state (GET /api/heartbeats/state)
#   logs    <agentId>          execution log history
#   thread  <agentId>          persistent thread log
#   update  <agentId> <json>   update prompt/schedule/enabled
#   run     <agentId>          trigger a run now

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

cmd="${1:-help}"
shift || true

case "$cmd" in
  list)   hub_api GET "/api/heartbeats" ;;
  state)  hub_api GET "/api/heartbeats/state" ;;
  logs)
    agent="${1:-}"
    [[ -n "$agent" ]] || usage_die "usage: heartbeats.sh logs <agentId>"
    hub_api GET "/api/heartbeats/$agent/logs"
    ;;
  thread)
    agent="${1:-}"
    [[ -n "$agent" ]] || usage_die "usage: heartbeats.sh thread <agentId>"
    hub_api GET "/api/heartbeats/$agent/thread"
    ;;
  update)
    agent="${1:-}"; body="${2:-}"
    [[ -n "$agent" && -n "$body" ]] || usage_die "usage: heartbeats.sh update <agentId> '<json>'"
    hub_api PUT "/api/heartbeats/$agent" -d "$body"
    ;;
  run)
    agent="${1:-}"
    [[ -n "$agent" ]] || usage_die "usage: heartbeats.sh run <agentId>"
    hub_api POST "/api/heartbeats/$agent/run"
    ;;
  help|-h|--help|'')
    cat <<EOF
usage: heartbeats.sh <subcommand> [args]
  list
  state
  logs   <agentId>
  thread <agentId>
  update <agentId> <json>
  run    <agentId>
EOF
    ;;
  *)
    usage_die "unknown subcommand: $cmd (try heartbeats.sh help)"
    ;;
esac
