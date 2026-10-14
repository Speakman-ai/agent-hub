#!/usr/bin/env bash
# scripts/sessions.sh — sessions + messages + ask-mode wrapper.
#
# Subcommands:
#   list <agentId>                     list sessions for an agent
#   messages <sessionId>               message history for a session
#   ask-mode <sessionId> true|false    toggle plan-mode on the session
#   dispatch <projectId> --prompt <text|-> [--agent <agentId>] [--name <title>]
#            [--mode <mode>] [--engine <e>] [--model <m>] [--skill <id>]...
#                                      start a session on a project agent as the
#                                      session owner; prints {sessionId, ref, ...}

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
  dispatch)
    project="${1:-}"
    [[ -n "$project" && "$project" != --* ]] || usage_die "usage: sessions.sh dispatch <projectId> --prompt <text|-> [--agent <id>] [--name <title>] [--mode <mode>] [--engine <e>] [--model <m>] [--skill <id>]..."
    shift
    prompt="" agent="" name="" mode="" engine="" model=""
    skills=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --prompt) prompt="${2:-}"; shift 2 ;;
        --agent)  agent="${2:-}"; shift 2 ;;
        --name)   name="${2:-}"; shift 2 ;;
        --mode)   mode="${2:-}"; shift 2 ;;
        --engine) engine="${2:-}"; shift 2 ;;
        --model)  model="${2:-}"; shift 2 ;;
        --skill)  skills+=("${2:-}"); shift 2 ;;
        *) usage_die "error: unknown option '$1' (try sessions.sh help)" ;;
      esac
    done
    if [[ "$prompt" == "-" ]]; then prompt="$(cat)"; fi
    [[ -n "${prompt//[[:space:]]/}" ]] || usage_die "error: --prompt is required"
    body="$(
      AH_PROMPT="$prompt" AH_AGENT="$agent" AH_NAME="$name" AH_MODE="$mode" \
      AH_ENGINE="$engine" AH_MODEL="$model" python3 - ${skills[@]+"${skills[@]}"} <<'PY'
import json, os, sys
payload = {"prompt": os.environ["AH_PROMPT"]}
for key, env in [("agentId", "AH_AGENT"), ("name", "AH_NAME"), ("mode", "AH_MODE"),
                 ("engine", "AH_ENGINE"), ("model", "AH_MODEL")]:
    v = os.environ.get(env, "").strip()
    if v:
        payload[key] = v
skills = [s for s in sys.argv[1:] if s.strip()]
if skills:
    payload["skills"] = skills
print(json.dumps(payload))
PY
    )"
    hub_api POST "/api/projects/$project/sessions/dispatch" -d "$body"
    ;;
  help|-h|--help|'')
    cat <<EOF
usage: sessions.sh <subcommand> [args]
  list <agentId>
  messages <sessionId>
  ask-mode <sessionId> true|false
  dispatch <projectId> --prompt <text|-> [--agent <agentId>] [--name <title>]
           [--mode manual|review|push|merge|consult|scoping|skill-builder|autopilot]
           [--engine <engine>] [--model <model>] [--skill <id>]...
EOF
    ;;
  *)
    usage_die "unknown subcommand: $cmd (try sessions.sh help)"
    ;;
esac
