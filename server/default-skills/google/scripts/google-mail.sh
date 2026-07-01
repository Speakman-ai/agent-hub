#!/usr/bin/env bash
# google-mail.sh — Gmail via the Hub proxy (scoped to the session owner).
#
#   google-mail.sh threads [--q QUERY] [--label ID]… [--max N] [--include-spam-trash]
#   google-mail.sh thread <threadId> [--format full|metadata|minimal]
#   google-mail.sh send   --to email… [--cc email]… [--bcc email]… \
#                         --subject TEXT (--text BODY | --html BODY) [--thread threadId]
#   google-mail.sh modify <messageId> [--add-label ID]… [--remove-label ID]…
#
# Sends/labels within the granted sensitive scopes (no permanent delete). Read
# ops need no extra tooling; send/modify build JSON with `jq`.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

require_jq_for_write() {
  command -v jq >/dev/null 2>&1 ||
    google_usage_die "google-mail: 'jq' is required to build the request body for this command."
}

cmd_threads() {
  local q="" max="" spam="" labels=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --q | --query) q="${2:-}"; shift 2 ;;
      --label | --label-id) labels+=("${2:-}"); shift 2 ;;
      --max | --max-results) max="${2:-}"; shift 2 ;;
      --include-spam-trash) spam="true"; shift ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-mail threads: unknown arg: $1" ;;
    esac
  done
  local qs="" sep=""
  [[ -n "$q" ]] && { qs+="${sep}q=$(urlenc "$q")"; sep="&"; }
  [[ -n "$max" ]] && { qs+="${sep}maxResults=$(urlenc "$max")"; sep="&"; }
  [[ -n "$spam" ]] && { qs+="${sep}includeSpamTrash=true"; sep="&"; }
  local l
  for l in "${labels[@]}"; do qs+="${sep}labelIds=$(urlenc "$l")"; sep="&"; done
  local path="/api/google/gmail/threads"
  [[ -n "$qs" ]] && path+="?${qs}"
  google_api GET "$path"
}

cmd_thread() {
  local thread_id="${1:-}"
  require_arg "<threadId>" "$thread_id"
  shift
  local format=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --format) format="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-mail thread: unknown arg: $1" ;;
    esac
  done
  local path="/api/google/gmail/threads/$(urlenc "$thread_id")"
  [[ -n "$format" ]] && path+="?format=$(urlenc "$format")"
  google_api GET "$path"
}

cmd_send() {
  require_jq_for_write
  local subject="" text="" html="" thread="" to=() cc=() bcc=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --to) to+=("${2:-}"); shift 2 ;;
      --cc) cc+=("${2:-}"); shift 2 ;;
      --bcc) bcc+=("${2:-}"); shift 2 ;;
      --subject) subject="${2:-}"; shift 2 ;;
      --text | --body) text="${2:-}"; shift 2 ;;
      --html) html="${2:-}"; shift 2 ;;
      --thread | --thread-id) thread="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-mail send: unknown arg: $1" ;;
    esac
  done
  [[ ${#to[@]} -gt 0 ]] || google_usage_die "google-mail send: at least one --to is required."
  [[ -n "$text" || -n "$html" ]] || google_usage_die "google-mail send: one of --text or --html is required."

  local body
  body="$(printf '%s\n' "${to[@]}" | jq -R . | jq -s '{to:.}')"
  [[ ${#cc[@]} -gt 0 ]] && body="$(jq --argjson v "$(printf '%s\n' "${cc[@]}" | jq -R . | jq -s '.')" '. + {cc:$v}' <<<"$body")"
  [[ ${#bcc[@]} -gt 0 ]] && body="$(jq --argjson v "$(printf '%s\n' "${bcc[@]}" | jq -R . | jq -s '.')" '. + {bcc:$v}' <<<"$body")"
  [[ -n "$subject" ]] && body="$(jq --arg v "$subject" '. + {subject:$v}' <<<"$body")"
  [[ -n "$text" ]] && body="$(jq --arg v "$text" '. + {text:$v}' <<<"$body")"
  [[ -n "$html" ]] && body="$(jq --arg v "$html" '. + {html:$v}' <<<"$body")"
  [[ -n "$thread" ]] && body="$(jq --arg v "$thread" '. + {threadId:$v}' <<<"$body")"
  google_api POST "/api/google/gmail/messages" -d "$body"
}

cmd_modify() {
  require_jq_for_write
  local message_id="${1:-}"
  require_arg "<messageId>" "$message_id"
  shift
  local add=() remove=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --add-label) add+=("${2:-}"); shift 2 ;;
      --remove-label) remove+=("${2:-}"); shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-mail modify: unknown arg: $1" ;;
    esac
  done
  [[ ${#add[@]} -gt 0 || ${#remove[@]} -gt 0 ]] ||
    google_usage_die "google-mail modify: provide at least one --add-label or --remove-label."
  local body
  body="$(jq -n '{}')"
  [[ ${#add[@]} -gt 0 ]] && body="$(jq --argjson v "$(printf '%s\n' "${add[@]}" | jq -R . | jq -s '.')" '. + {addLabelIds:$v}' <<<"$body")"
  [[ ${#remove[@]} -gt 0 ]] && body="$(jq --argjson v "$(printf '%s\n' "${remove[@]}" | jq -R . | jq -s '.')" '. + {removeLabelIds:$v}' <<<"$body")"
  google_api POST "/api/google/gmail/messages/$(urlenc "$message_id")/modify" -d "$body"
}

main() {
  local sub="${1:-}"
  [[ $# -gt 0 ]] && shift || true
  case "$sub" in
    threads) cmd_threads "$@" ;;
    thread) cmd_thread "$@" ;;
    send) cmd_send "$@" ;;
    modify) cmd_modify "$@" ;;
    -h | --help | help | '') usage; [[ -z "$sub" ]] && exit 2 || exit 0 ;;
    *) google_usage_die "google-mail: unknown subcommand: $sub" ;;
  esac
}

main "$@"
