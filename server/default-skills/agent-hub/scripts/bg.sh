#!/usr/bin/env bash
# scripts/bg.sh — run and monitor background shells that OUTLIVE the turn.
#
# A normal `run_in_background` Bash shell dies when the turn's CLI process is
# reaped, so it can't be polled next turn. bg.sh starts the command in the
# Hub instead, which is long-lived — so `status`, `logs`, and `stop` all work
# in later turns. Output also shows up in the session's Background shells panel.
#
# WATCHED BY DEFAULT: when the command finishes, the Hub wakes this session and
# hands you the result. So the right move is to start the work and END YOUR
# TURN — do not poll, sleep-loop, or wait. Pass --no-watch for fire-and-forget
# work you will never need to hear about.
#
# Usage:
#   bg.sh start [--label <text>] [--no-watch] [--timeout-sec <n>] [--] <command...>
#                                                   Start a background shell.
#   bg.sh list                                      List this session's shells (JSON).
#   bg.sh status <shellId>                          Show one shell's status (JSON).
#   bg.sh logs <shellId> [--limit <n>]              Print a shell's captured output.
#   bg.sh stop <shellId>                            SIGTERM the shell's process group.
#   bg.sh unwatch                                   Cancel the watch loop AND stop
#                                                   every watched shell.
#
# `--label` / `--no-watch` / `--timeout-sec` are only recognized BEFORE the
# command. Use `--` to end wrapper options when your command itself begins
# with a flag, e.g. `bg.sh start -- ./x --label`.
#
# Every shell is capped at 30 minutes (the Hub stops it and wakes this session
# with status `timed_out`). `--timeout-sec` may request a *shorter* cap; longer
# values are clamped to 30 minutes. There is no way to disable the cap.
#
# Everything is scoped to $AGENT_HUB_SESSION_ID (injected by the server at
# spawn). The command runs in the session worktree. Auth is resolved through
# ah-api.sh (no hard-coded key reads).
#
# Environment:
#   AGENT_HUB_URL         (default http://localhost:3051)
#   AGENT_HUB_SESSION_ID  required — the current session
#
# Examples:
#   bg.sh start --label "prod build" npm run build   # then end your turn
#   bg.sh start --timeout-sec 120 --label "slice" ./copy-year.sh
#   bg.sh start --no-watch --label "cache warm" ./warm.sh
#   bg.sh list
#   bg.sh logs 6f1c… --limit 100
#   bg.sh stop 6f1c…
#   bg.sh unwatch

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ah-api.sh
source "$DIR/ah-api.sh"

usage() {
  sed -n '2,48p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "error: $*" >&2
  exit 2
}

require_session() {
  [[ -n "${AGENT_HUB_SESSION_ID:-}" ]] ||
    die "AGENT_HUB_SESSION_ID is not set (are you running inside an Agent Hub session?)"
}

# JSON-escape a string for embedding in a request body (handles quotes,
# backslashes, control chars). Uses the bundled node — always present in a spawn.
json_escape() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' -- "$1"
}

# Wall-clock cap, in seconds, that the Hub enforces on every background shell
# (mirrors BACKGROUND_SHELL_MAX_TIMEOUT_MS = 30 minutes server-side).
TIMEOUT_CAP_SEC=1800

# Validate a --timeout-sec value and set `timeout_ms` (the caller's local, via
# bash dynamic scope) to the requested seconds × 1000, clamped to the cap.
#
# We clamp the SECONDS before multiplying so a huge request can't overflow
# bash's signed 64-bit arithmetic: `--timeout-sec 18446744073709552 * 1000`
# wraps to a small positive ms, which the server clamp would then accept — so
# an above-cap value would time out almost immediately instead of being clamped
# to 30 minutes. Length-comparing first keeps an over-long value out of the
# arithmetic entirely (where the ×1 conversion itself could overflow).
parse_timeout_ms() {
  local sec="$1"
  [[ "$sec" =~ ^[0-9]+$ ]] || die "--timeout-sec must be a positive integer"
  # Drop leading zeros so the length comparison reflects magnitude, not padding.
  while [[ ${#sec} -gt 1 && $sec == 0* ]]; do sec="${sec#0}"; done
  # Reject zero explicitly: it passes the digit-only regex but the server would
  # silently treat timeoutMs 0 as "no request" and fall back to the 30-minute
  # default, running the command far longer than the caller asked for.
  [[ "$sec" == 0 ]] && die "--timeout-sec must be a positive integer"
  if ((${#sec} > ${#TIMEOUT_CAP_SEC})) || ((10#$sec > TIMEOUT_CAP_SEC)); then
    sec=$TIMEOUT_CAP_SEC
  fi
  timeout_ms=$((10#$sec * 1000))
}

cmd_start() {
  require_session
  local label="" watch="true" timeout_ms=""
  # Parse wrapper options ONLY in leading position, so they can't be confused
  # with the command's own argv. Stop at the first non-option token or at an
  # explicit `--` separator; everything after is the command, taken verbatim
  # (so a command may itself contain `--label`, other flags, etc.).
  #   bg.sh start --label "prod build" npm run build
  #   bg.sh start -- ./tool --label really-a-command-arg
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --label)
        shift
        [[ $# -gt 0 ]] || die "--label needs a value"
        label="$1"
        shift
        ;;
      --label=*)
        label="${1#--label=}"
        shift
        ;;
      --no-watch)
        watch="false"
        shift
        ;;
      --watch)
        watch="true"
        shift
        ;;
      --timeout-sec)
        shift
        [[ $# -gt 0 ]] || die "--timeout-sec needs a value"
        parse_timeout_ms "$1"
        shift
        ;;
      --timeout-sec=*)
        parse_timeout_ms "${1#--timeout-sec=}"
        shift
        ;;
      --)
        shift
        break
        ;;
      *) break ;;
    esac
  done
  local -a parts=("$@")
  [[ ${#parts[@]} -gt 0 ]] || die "start needs a command, e.g. bg.sh start npm run build"
  # Reconstruct the command as a POSIX-shell-safe string. The server runs it
  # via `sh -c` (/bin/sh, often dash), so we single-quote each argv element
  # ourselves — escaping any embedded single quote as '\'' — rather than using
  # bash's `printf %q`, whose $'...' / backslash output is NOT valid POSIX sh.
  # Single-quoting preserves exact argument boundaries for ANY bytes (spaces,
  # shell metacharacters, even newlines). Built inline (no command
  # substitution) so a trailing newline in an argument isn't stripped. E.g.
  #   bg.sh start bash -lc 'echo "$FOO"'
  # stays a single `echo "$FOO"` argument to `bash -lc`.
  local command="" part i ch quoted
  for part in "${parts[@]}"; do
    quoted="'"
    for ((i = 0; i < ${#part}; i++)); do
      ch=${part:i:1}
      if [[ $ch == "'" ]]; then
        quoted+="'\\''"
      else
        quoted+=$ch
      fi
    done
    quoted+="'"
    command+="${command:+ }$quoted"
  done
  local body
  body="{\"command\":$(json_escape "$command"),\"label\":$(json_escape "$label"),\"watch\":${watch}"
  if [[ -n "$timeout_ms" ]]; then
    body+=",\"timeoutMs\":${timeout_ms}"
  fi
  body+="}"
  ah_api POST "/api/sessions/${AGENT_HUB_SESSION_ID}/background-shells" -d "$body"
}

cmd_unwatch() {
  require_session
  ah_api POST "/api/sessions/${AGENT_HUB_SESSION_ID}/background-shells/watch/cancel"
}

cmd_list() {
  require_session
  ah_api GET "/api/sessions/${AGENT_HUB_SESSION_ID}/background-shells"
}

cmd_status() {
  require_session
  local id="${1:-}"
  [[ -n "$id" ]] || die "status needs a shellId"
  ah_api GET "/api/sessions/${AGENT_HUB_SESSION_ID}/background-shells/${id}"
}

cmd_logs() {
  require_session
  local id="" limit=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit)
        shift
        [[ $# -gt 0 ]] || die "--limit needs a value"
        limit="$1"
        ;;
      *) [[ -z "$id" ]] && id="$1" || die "unexpected argument: $1" ;;
    esac
    shift
  done
  [[ -n "$id" ]] || die "logs needs a shellId"
  local path="/api/sessions/${AGENT_HUB_SESSION_ID}/background-shells/${id}/logs"
  [[ -n "$limit" ]] && path="${path}?limit=${limit}"
  ah_api GET "$path"
}

cmd_stop() {
  require_session
  local id="${1:-}"
  [[ -n "$id" ]] || die "stop needs a shellId"
  ah_api POST "/api/sessions/${AGENT_HUB_SESSION_ID}/background-shells/${id}/stop"
}

case "${1:-}" in
  -h | --help | help)
    usage
    [[ "${1:-}" == "" ]] && exit 2 || exit 0
    ;;
  start)
    shift
    cmd_start "$@"
    ;;
  list)
    shift
    cmd_list "$@"
    ;;
  status)
    shift
    cmd_status "$@"
    ;;
  logs)
    shift
    cmd_logs "$@"
    ;;
  stop)
    shift
    cmd_stop "$@"
    ;;
  unwatch)
    shift
    cmd_unwatch "$@"
    ;;
  '')
    usage >&2
    exit 2
    ;;
  *) die "unknown subcommand: ${1:-} (try --help)" ;;
esac
