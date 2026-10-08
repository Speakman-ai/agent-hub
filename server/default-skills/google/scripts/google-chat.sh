#!/usr/bin/env bash
# google-chat.sh — Google Chat via the Hub proxy (scoped to the session owner).
#
#   google-chat.sh spaces   [--max N] [--page-token TOKEN]
#   google-chat.sh messages <space> [--thread spaces/X/threads/Y] [--max N] [--asc] [--page-token TOKEN]
#   google-chat.sh send     <space> --text TEXT [--thread spaces/X/threads/Y]
#
# <space> is a space id (AAAA) or resource name (spaces/AAAA). Messages list
# newest first unless --asc. `send` with --thread replies in that thread when
# the space supports thread replies (supportsThreadReplies in `spaces`); in DMs,
# group chats, and unthreaded spaces it posts an ordinary message.
# Requires a Google Workspace account; send builds JSON with `jq`.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

space_id() {
  local raw="${1:-}"
  require_arg "<space>" "$raw"
  raw="${raw#spaces/}"
  [[ "$raw" =~ ^[A-Za-z0-9_-]+$ ]] || google_usage_die "google-chat: invalid space: $1"
  printf '%s' "$raw"
}

cmd_spaces() {
  local max="" token=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --max | --page-size) max="${2:-}"; shift 2 ;;
      --page-token) token="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-chat spaces: unknown arg: $1" ;;
    esac
  done
  local qs="" sep=""
  [[ -n "$max" ]] && { qs+="${sep}pageSize=$(urlenc "$max")"; sep="&"; }
  [[ -n "$token" ]] && { qs+="${sep}pageToken=$(urlenc "$token")"; sep="&"; }
  local path="/api/google/chat/spaces"
  [[ -n "$qs" ]] && path+="?${qs}"
  google_api GET "$path"
}

cmd_messages() {
  local id
  id="$(space_id "${1:-}")"
  shift
  local max="" token="" thread="" order=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --max | --page-size) max="${2:-}"; shift 2 ;;
      --page-token) token="${2:-}"; shift 2 ;;
      --thread) thread="${2:-}"; shift 2 ;;
      --asc) order="asc"; shift ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-chat messages: unknown arg: $1" ;;
    esac
  done
  local qs="" sep=""
  [[ -n "$max" ]] && { qs+="${sep}pageSize=$(urlenc "$max")"; sep="&"; }
  [[ -n "$token" ]] && { qs+="${sep}pageToken=$(urlenc "$token")"; sep="&"; }
  [[ -n "$thread" ]] && { qs+="${sep}threadName=$(urlenc "$thread")"; sep="&"; }
  [[ -n "$order" ]] && { qs+="${sep}order=${order}"; sep="&"; }
  local path="/api/google/chat/spaces/${id}/messages"
  [[ -n "$qs" ]] && path+="?${qs}"
  google_api GET "$path"
}

cmd_send() {
  command -v jq >/dev/null 2>&1 ||
    google_usage_die "google-chat: 'jq' is required to build the request body for send."
  local id
  id="$(space_id "${1:-}")"
  shift
  local text="" thread=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --text) text="${2:-}"; shift 2 ;;
      --thread) thread="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-chat send: unknown arg: $1" ;;
    esac
  done
  [[ -n "$text" ]] || google_usage_die "google-chat send: --text is required."
  local body
  body="$(jq -n --arg t "$text" '{text:$t}')"
  [[ -n "$thread" ]] && body="$(jq --arg v "$thread" '. + {threadName:$v}' <<<"$body")"
  google_api POST "/api/google/chat/spaces/${id}/messages" -d "$body"
}

main() {
  local sub="${1:-}"
  [[ $# -gt 0 ]] && shift || true
  case "$sub" in
    spaces) cmd_spaces "$@" ;;
    messages) cmd_messages "$@" ;;
    send) cmd_send "$@" ;;
    -h | --help | help | '') usage; [[ -z "$sub" ]] && exit 2 || exit 0 ;;
    *) google_usage_die "google-chat: unknown subcommand: $sub" ;;
  esac
}

main "$@"
