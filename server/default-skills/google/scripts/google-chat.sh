#!/usr/bin/env bash
# google-chat.sh — Google Chat via the Hub proxy (scoped to the session owner).
#
#   google-chat.sh spaces   [--max N] [--page-token TOKEN]
#   google-chat.sh messages <space> [--thread spaces/X/threads/Y] [--max N] [--asc] [--page-token TOKEN]
#   google-chat.sh send     <space> --text TEXT [--thread spaces/X/threads/Y]
#   google-chat.sh sender-stats [--spaces N] [--max M]
#
# <space> is a space id (AAAA) or resource name (spaces/AAAA). Messages list
# newest first unless --asc. `send` with --thread replies in that thread when
# the space supports thread replies (supportsThreadReplies in `spaces`); in DMs,
# group chats, and unthreaded spaces it posts an ordinary message. From an agent
# session, `send` saves the reply as a draft awaiting the session owner's
# approval (unless they turned on auto-send) and says so on stderr.
# sender-stats samples the newest M messages (default 100) in each of the N most
# recently active spaces (default 20) and prints JSON: how many messages lack
# sender.displayName, by sender type and space type, and whether each space's
# page came back newest first (null if the page is empty or any message lacks
# an RFC 3339 createTime).
# Requires a Google Workspace account; send and sender-stats need `jq`.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$DIR/_common.sh"

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
  local out
  out="$(google_api POST "/api/google/chat/spaces/${id}/messages" -d "$body")"
  printf '%s\n' "$out"
  if [[ "$(jq -r '.status // empty' <<<"$out" 2>/dev/null || true)" == "pending_approval" ]]; then
    echo "google-chat: NOT SENT YET. The reply is saved as draft $(jq -r '.draft.id' <<<"$out") and is awaiting approval." >&2
    echo "google-chat: the session owner approves, edits, or discards it in Agent Hub. Do not resend it." >&2
  fi
}

cmd_sender_stats() {
  command -v jq >/dev/null 2>&1 ||
    google_usage_die "google-chat: 'jq' is required for sender-stats."
  local nspaces="20" max="100"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --spaces) nspaces="${2:-}"; shift 2 ;;
      --max | --page-size) max="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) google_usage_die "google-chat sender-stats: unknown arg: $1" ;;
    esac
  done
  [[ "$nspaces" =~ ^[0-9]+$ && "$nspaces" -ge 1 ]] ||
    google_usage_die "google-chat sender-stats: --spaces must be a positive integer."
  [[ "$max" =~ ^[0-9]+$ && "$max" -ge 1 && "$max" -le 1000 ]] ||
    google_usage_die "google-chat sender-stats: --max must be 1-1000."

  local spaces_json
  spaces_json="$(google_api GET "/api/google/chat/spaces?pageSize=$(urlenc "$nspaces")")"
  # Pages go to jq on stdin and collect in a JSON-lines file: a page of large
  # messages can pass the OS per-argument limit (128 KiB on Linux), so no
  # response body is ever handed to jq as an argument.
  local samples id type body
  samples="$(mktemp)"
  # shellcheck disable=SC2064 # expand now: $samples is local to this function.
  trap "rm -f '$samples'" EXIT
  # The proxy returns spaces most recently active first.
  while IFS=$'\t' read -r id type; do
    [[ -n "$id" ]] || continue
    body="$(google_api GET "/api/google/chat/spaces/${id}/messages?pageSize=${max}")"
    jq -c --arg id "$id" --arg type "$type" \
      '{space: $id, spaceType: $type, messages: (.messages // [])}' <<<"$body" >>"$samples"
  done < <(jq -r --argjson n "$nspaces" \
    '(.spaces // [])[:$n][] | select(.id) | [.id, (.spaceType // "UNKNOWN")] | @tsv' <<<"$spaces_json")

  jq -s '
    def missing: ((.sender.displayName // "") | length) == 0;
    # RFC 3339 -> [UTC epoch seconds, 9-digit fraction] so offsets and mixed
    # fractional precision compare chronologically. Same rules as
    # shared/utils/rfc3339.ts: every field is range-checked and the epoch is
    # computed arithmetically, so an impossible date (month 13, Feb 30, 24:00,
    # offset +24:00) yields null instead of an error or a rolled-over instant.
    def leap($y): ($y % 4 == 0 and $y % 100 != 0) or $y % 400 == 0;
    def month_days($y; $m):
      if $m == 2 and leap($y) then 29 else [31,28,31,30,31,30,31,31,30,31,30,31][$m - 1] end;
    def days_from_civil($y0; $m; $d):
      (if $m <= 2 then $y0 - 1 else $y0 end) as $y
      | (($y / 400) | floor) as $era
      | ($y - $era * 400) as $yoe
      | ((((153 * ($m + (if $m > 2 then -3 else 9 end)) + 2) / 5) | floor) + $d - 1) as $doy
      | ($yoe * 365 + (($yoe / 4) | floor) - (($yoe / 100) | floor) + $doy) as $doe
      | $era * 146097 + $doe - 719468;
    def instant:
      if type != "string" then null else
        ([capture("^(?<y>[0-9]{4})-(?<mo>[0-9]{2})-(?<d>[0-9]{2})[Tt](?<h>[0-9]{2}):(?<mi>[0-9]{2}):(?<s>[0-9]{2})(\\.(?<f>[0-9]{1,9}))?(?<z>[Zz]|(?<sign>[+-])(?<oh>[0-9]{2}):(?<om>[0-9]{2}))$")] | .[0]) as $m
        | if $m == null then null else
            ($m.y | tonumber) as $y | ($m.mo | tonumber) as $mo | ($m.d | tonumber) as $d
            | ($m.h | tonumber) as $h | ($m.mi | tonumber) as $mi | ($m.s | tonumber) as $s
            | (if $m.sign == null then 0
               else (($m.oh | tonumber) * 3600 + ($m.om | tonumber) * 60)
                 * (if $m.sign == "-" then -1 else 1 end) end) as $off
            | if $mo < 1 or $mo > 12 or $d < 1 or $d > month_days($y; $mo)
                or $h > 23 or $mi > 59 or $s > 59
                or ($m.sign != null and (($m.oh | tonumber) > 23 or ($m.om | tonumber) > 59))
              then null
              else [days_from_civil($y; $mo; $d) * 86400 + $h * 3600 + $mi * 60 + $s - $off,
                    ((($m.f // "") + "000000000")[0:9])]
              end
          end
      end;
    def tally(rows): {
      messages: (rows | length),
      missingDisplayName: (rows | map(select(missing)) | length)
    } | . + {rate: (if .messages > 0 then ((.missingDisplayName / .messages * 1000 | round) / 1000) else null end)};
    [.[] | .spaceType as $st | .messages[] | select(.deleted | not) | . + {spaceType: $st}] as $all
    | {
        spacesSampled: length,
        total: tally($all),
        bySenderType: ($all | group_by(.sender.type // "NONE")
          | map({key: (.[0].sender.type // "NONE"), value: tally(.)}) | from_entries),
        bySpaceType: ($all | group_by(.spaceType)
          | map({key: .[0].spaceType, value: tally(.)}) | from_entries),
        spaces: map({
          space, spaceType,
          messages: ([.messages[] | select(.deleted | not)] | length),
          # Every message must carry a parseable createTime, or the order is
          # unverifiable (null); so is an empty page.
          newestFirst: ([.messages[] | .createTime | instant] as $k
            | if ($k | length) == 0 or any($k[]; . == null) then null
              else $k == ($k | sort | reverse) end)
        })
      }' "$samples"
}

main() {
  local sub="${1:-}"
  [[ $# -gt 0 ]] && shift || true
  case "$sub" in
    spaces) cmd_spaces "$@" ;;
    messages) cmd_messages "$@" ;;
    send) cmd_send "$@" ;;
    sender-stats) cmd_sender_stats "$@" ;;
    -h | --help | help | '') usage; [[ -z "$sub" ]] && exit 2 || exit 0 ;;
    *) google_usage_die "google-chat: unknown subcommand: $sub" ;;
  esac
}

main "$@"
