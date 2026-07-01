#!/usr/bin/env bash
# google-cal.sh — Google Calendar via the Hub proxy (scoped to the session owner).
#
#   google-cal.sh list   --from <ISO> --to <ISO> [--q TEXT] [--max N] [--calendar ID]
#   google-cal.sh create --summary TEXT --start <ISO> --end <ISO> \
#                        [--description TEXT] [--location TEXT] [--timezone TZ] \
#                        [--calendar ID] [--attendee email]… [--send-updates all|externalOnly|none]
#   google-cal.sh update <eventId> [--summary TEXT] [--start ISO] [--end ISO] \
#                        [--description TEXT] [--location TEXT] [--timezone TZ] [--calendar ID]
#
# ISO timestamps are RFC3339, e.g. 2026-06-30T09:00:00-07:00 (or pass --timezone
# for offset-less local times). Read ops need no extra tooling; create/update
# build JSON with `jq`.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

require_jq_for_write() {
  command -v jq >/dev/null 2>&1 ||
    google_usage_die "google-cal: 'jq' is required to build the request body for this command."
}

dt_json() {
  # dt_json <ISO> <TZ?> → {"dateTime":"…"[,"timeZone":"…"]}
  local iso="$1" tz="${2:-}"
  if [[ -n "$tz" ]]; then
    jq -n --arg dt "$iso" --arg tz "$tz" '{dateTime:$dt, timeZone:$tz}'
  else
    jq -n --arg dt "$iso" '{dateTime:$dt}'
  fi
}

cmd_list() {
  local from="" to="" q="" max="" calendar=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --from | --time-min) from="${2:-}"; shift 2 ;;
      --to | --time-max) to="${2:-}"; shift 2 ;;
      --q | --query) q="${2:-}"; shift 2 ;;
      --max | --max-results) max="${2:-}"; shift 2 ;;
      --calendar | --calendar-id) calendar="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-cal list: unknown arg: $1" ;;
    esac
  done
  require_arg --from "$from"
  require_arg --to "$to"

  local qs="timeMin=$(urlenc "$from")&timeMax=$(urlenc "$to")"
  [[ -n "$calendar" ]] && qs+="&calendarId=$(urlenc "$calendar")"
  [[ -n "$q" ]] && qs+="&q=$(urlenc "$q")"
  [[ -n "$max" ]] && qs+="&maxResults=$(urlenc "$max")"
  google_api GET "/api/google/calendar/events?${qs}"
}

build_event_json() {
  # echoes the event object from the parsed flags in EV_* vars
  local ev
  ev="$(jq -n '{}')"
  [[ -n "${EV_SUMMARY:-}" ]] && ev="$(jq --arg v "$EV_SUMMARY" '. + {summary:$v}' <<<"$ev")"
  [[ -n "${EV_DESC:-}" ]] && ev="$(jq --arg v "$EV_DESC" '. + {description:$v}' <<<"$ev")"
  [[ -n "${EV_LOCATION:-}" ]] && ev="$(jq --arg v "$EV_LOCATION" '. + {location:$v}' <<<"$ev")"
  [[ -n "${EV_START:-}" ]] && ev="$(jq --argjson v "$(dt_json "$EV_START" "${EV_TZ:-}")" '. + {start:$v}' <<<"$ev")"
  [[ -n "${EV_END:-}" ]] && ev="$(jq --argjson v "$(dt_json "$EV_END" "${EV_TZ:-}")" '. + {end:$v}' <<<"$ev")"
  if [[ ${#EV_ATTENDEES[@]} -gt 0 ]]; then
    local arr
    arr="$(printf '%s\n' "${EV_ATTENDEES[@]}" | jq -R '{email:.}' | jq -s '.')"
    ev="$(jq --argjson v "$arr" '. + {attendees:$v}' <<<"$ev")"
  fi
  printf '%s' "$ev"
}

parse_event_flags() {
  EV_SUMMARY=""; EV_DESC=""; EV_LOCATION=""; EV_START=""; EV_END=""; EV_TZ=""
  EV_CALENDAR=""; EV_SEND=""; EV_ATTENDEES=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --summary) EV_SUMMARY="${2:-}"; shift 2 ;;
      --description) EV_DESC="${2:-}"; shift 2 ;;
      --location) EV_LOCATION="${2:-}"; shift 2 ;;
      --start) EV_START="${2:-}"; shift 2 ;;
      --end) EV_END="${2:-}"; shift 2 ;;
      --timezone | --tz) EV_TZ="${2:-}"; shift 2 ;;
      --calendar | --calendar-id) EV_CALENDAR="${2:-}"; shift 2 ;;
      --attendee) EV_ATTENDEES+=("${2:-}"); shift 2 ;;
      --send-updates) EV_SEND="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "unknown arg: $1" ;;
    esac
  done
}

cmd_create() {
  require_jq_for_write
  parse_event_flags "$@"
  require_arg --summary "$EV_SUMMARY"
  require_arg --start "$EV_START"
  require_arg --end "$EV_END"
  local event body
  event="$(build_event_json)"
  body="$(jq -n --argjson event "$event" '{event:$event}')"
  [[ -n "$EV_CALENDAR" ]] && body="$(jq --arg v "$EV_CALENDAR" '. + {calendarId:$v}' <<<"$body")"
  [[ -n "$EV_SEND" ]] && body="$(jq --arg v "$EV_SEND" '. + {sendUpdates:$v}' <<<"$body")"
  google_api POST "/api/google/calendar/events" -d "$body"
}

cmd_update() {
  require_jq_for_write
  local event_id="${1:-}"
  require_arg "<eventId>" "$event_id"
  shift
  parse_event_flags "$@"
  local event body
  event="$(build_event_json)"
  [[ "$(jq 'length' <<<"$event")" == "0" ]] &&
    google_usage_die "google-cal update: provide at least one field to change."
  body="$(jq -n --argjson event "$event" '{event:$event}')"
  [[ -n "$EV_CALENDAR" ]] && body="$(jq --arg v "$EV_CALENDAR" '. + {calendarId:$v}' <<<"$body")"
  [[ -n "$EV_SEND" ]] && body="$(jq --arg v "$EV_SEND" '. + {sendUpdates:$v}' <<<"$body")"
  google_api PATCH "/api/google/calendar/events/$(urlenc "$event_id")" -d "$body"
}

main() {
  local sub="${1:-}"
  [[ $# -gt 0 ]] && shift || true
  case "$sub" in
    list) cmd_list "$@" ;;
    create) cmd_create "$@" ;;
    update) cmd_update "$@" ;;
    -h | --help | help | '') usage; [[ -z "$sub" ]] && exit 2 || exit 0 ;;
    *) google_usage_die "google-cal: unknown subcommand: $sub" ;;
  esac
}

main "$@"
