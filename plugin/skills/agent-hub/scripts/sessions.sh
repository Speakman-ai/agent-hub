#!/usr/bin/env bash
# scripts/sessions.sh — sessions + messages + ask-mode wrapper.
#
# Subcommands:
#   list <agentId>                     list sessions for an agent
#   messages <sessionId>               message history for a session
#   ask-mode <sessionId> true|false    toggle plan-mode on the session

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

cmd="${1:-help}"
shift || true

case "$cmd" in
  list)
    agent="${1:-}"
    [[ -n "$agent" ]] || usage_die "usage: sessions.sh list <agentId>"
    hub_api GET "/api/agents/$agent/sessions"
    ;;
  messages)
    sid="${1:-}"
    [[ -n "$sid" ]] || usage_die "usage: sessions.sh messages <sessionId>"
    hub_api GET "/api/sessions/$sid/messages"
    ;;
  ask-mode)
    sid="${1:-}"; flag="${2:-}"
    [[ -n "$sid" && -n "$flag" ]] || usage_die "usage: sessions.sh ask-mode <sessionId> true|false"
    case "$flag" in
      true|false) ;;
      *) usage_die "enabled must be 'true' or 'false'" ;;
    esac
    hub_api PUT "/api/sessions/$sid/ask-mode" -d "{\"enabled\":$flag}"
    ;;
  help|-h|--help|'')
    cat <<EOF
usage: sessions.sh <subcommand> [args]
  list <agentId>
  messages <sessionId>
  ask-mode <sessionId> true|false
EOF
    ;;
  *)
    usage_die "unknown subcommand: $cmd (try sessions.sh help)"
    ;;
esac
