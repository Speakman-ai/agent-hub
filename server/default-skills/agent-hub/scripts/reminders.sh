#!/usr/bin/env bash
# scripts/reminders.sh — personal reminders (`/api/me/reminders`) wrapper.
#
# Runs as the session owner: a reminder set from an agent session is for the
# human who owns the session, and is linked back to this session. It fires
# into their notification inbox (in-app, desktop, push per their settings) and,
# when their Google Calendar is connected, also lands on their calendar.
#
# Subcommands:
#   add <title> (--at <iso8601> | --in <dur>) [--notes <text>] [--no-calendar]
#   list [--status pending,fired,dismissed|all] [--this-session]
#   snooze <id> <dur>
#   dismiss <id>
#   delete <id>
#
# <dur> is minutes, or a number with m / h / d (e.g. 30m, 2h, 1d).
# --at needs an offset or Z, e.g. 2026-10-17T09:00:00-07:00.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

_usage() {
  cat <<'USAGE'
usage: reminders.sh <subcommand> [args]
  add <title> (--at <iso8601> | --in <dur>) [--notes <text>] [--no-calendar]
  list [--status pending,fired,dismissed|all] [--this-session]
  snooze <id> <dur>
  dismiss <id>
  delete <id>

<dur>: minutes, or 30m / 2h / 1d
USAGE
}

# to_minutes <dur> — prints whole minutes or exits 2.
to_minutes() {
  local raw="$1" n unit
  if [[ "$raw" =~ ^([0-9]+)([mhd]?)$ ]]; then
    n="${BASH_REMATCH[1]}"
    unit="${BASH_REMATCH[2]}"
    case "$unit" in
      h) echo $((n * 60)) ;;
      d) echo $((n * 1440)) ;;
      *) echo "$n" ;;
    esac
  else
    usage_die "error: bad duration '$raw' (use minutes, or 30m / 2h / 1d)"
  fi
}

# json_body key=value... — builds a JSON object. Only the known numeric keys
# become numbers; every other value (title, notes, ...) stays a string.
json_body() {
  python3 - "$@" <<'PY'
import json, sys
NUMERIC = {"inMinutes", "snoozeMinutes"}
out = {}
for arg in sys.argv[1:]:
    k, v = arg.split("=", 1)
    out[k] = int(v) if k in NUMERIC else v
print(json.dumps(out))
PY
}

cmd="${1:-}"
[[ -n "$cmd" ]] || { _usage >&2; exit 2; }
shift

case "$cmd" in
  add)
    [[ $# -ge 1 ]] || usage_die "error: add needs a title"
    title="$1"
    shift
    at="" in="" notes="" calendar="auto"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --at) at="${2:-}"; shift 2 ;;
        --in) in="$(to_minutes "${2:-}")"; shift 2 ;;
        --notes) notes="${2:-}"; shift 2 ;;
        --no-calendar) calendar="none"; shift ;;
        *) usage_die "error: unknown flag $1" ;;
      esac
    done
    if [[ -n "$at" && -n "$in" ]] || [[ -z "$at" && -z "$in" ]]; then
      usage_die "error: pass exactly one of --at or --in"
    fi
    args=("title=$title" "calendar=$calendar")
    [[ -n "$at" ]] && args+=("remindAt=$at")
    [[ -n "$in" ]] && args+=("inMinutes=$in")
    [[ -n "$notes" ]] && args+=("notes=$notes")
    [[ -n "${AGENT_HUB_SESSION_ID:-}" ]] && args+=("sessionId=$AGENT_HUB_SESSION_ID")
    # Build the body first so a serialization failure aborts before any request.
    body="$(json_body "${args[@]}")"
    hub_api POST /api/me/reminders -d "$body"
    ;;
  list)
    status="" query=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --status) status="${2:-}"; shift 2 ;;
        --this-session)
          require_var AGENT_HUB_SESSION_ID
          query+=("sessionId=$AGENT_HUB_SESSION_ID")
          shift
          ;;
        *) usage_die "error: unknown flag $1" ;;
      esac
    done
    [[ -n "$status" ]] && query+=("status=$status")
    qs=""
    if [[ ${#query[@]} -gt 0 ]]; then
      qs="?$(IFS='&'; echo "${query[*]}")"
    fi
    hub_api GET "/api/me/reminders$qs"
    ;;
  snooze)
    [[ $# -eq 2 ]] || usage_die "error: snooze <id> <dur>"
    minutes="$(to_minutes "$2")"
    body="$(json_body "snoozeMinutes=$minutes")"
    hub_api PATCH "/api/me/reminders/$1" -d "$body"
    ;;
  dismiss)
    [[ $# -eq 1 ]] || usage_die "error: dismiss <id>"
    hub_api PATCH "/api/me/reminders/$1" -d '{"status":"dismissed"}'
    ;;
  delete)
    [[ $# -eq 1 ]] || usage_die "error: delete <id>"
    hub_api DELETE "/api/me/reminders/$1"
    ;;
  -h|--help|help) _usage ;;
  *) _usage >&2; exit 2 ;;
esac
