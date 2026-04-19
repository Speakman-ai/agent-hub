#!/usr/bin/env bash
# scripts/log-tool-error.sh — append a TOOL_ERROR self-report line to today's
# daily note.
#
# Two wire formats are supported (see references/errors.md):
#
#   v1 (legacy, always-on default — six pipe-delimited fields):
#     TOOL_ERROR | <ts> | <tool> | <action> | <exit> | <summary>
#
#   v2 (emitted when any structured flag is passed — adds a JSON tail):
#     TOOL_ERROR | <ts> | <tool> | <action> | <exit> | <summary> | {"v":2,...}
#
# The timestamp is generated here in UTC (`YYYY-MM-DDTHH:MM:SSZ`) so agents
# can't drift from the canonical format. Any `|` or newline in the positional
# fields is sanitised (replaced with `/` or space) so those fields always
# split cleanly. JSON-tail string values may contain raw `|` because the
# parser peels the tail atomically before splitting.
#
# The daily note lives at `<workspace>/memory/<YYYY-MM-DD>.md`. The workspace
# is read from `GET /api/projects/$PROJECT_ID` (`.ahw`) so the script works
# regardless of the current working directory. Each invocation appends a new
# `## HH:MM` section followed by the TOOL_ERROR line, matching the existing
# daily-note convention used by `appendDailyNote` in `server/memory.ts`.
#
# Usage:
#   log-tool-error.sh --tool <name> --action <cmd> --exit <code> --summary <txt>
#                     [--sev <blocked|soft|retry>] [--resolution <state>]
#                     [--session-id <id>] [--agent-id <slug>] [--attempt <n>]
#                     [--tag <name>] ... [--card <id>] [--pr <url>]
#
# Options:
#   --tool        <str>   tool that failed (e.g. Bash, Read, Edit)   (required)
#   --action      <str>   command or action attempted                (required)
#   --exit        <str>   exit code or error type (e.g. "exit 1")    (required)
#   --summary     <str>   one-line summary of the failure            (required)
#   --sev         <str>   blocked | soft | retry (v2 opt-in)
#   --resolution  <str>   unresolved | recovered | escalated | duplicate | preexisting
#   --session-id  <str>   session id (usually $AGENT_HUB_SESSION_ID)
#   --agent-id    <str>   agent slug that logged the error
#   --attempt     <int>   retry counter (use with the 3+ retries rule)
#   --tag         <str>   freeform tag; repeatable (--tag ci --tag deploy)
#   --card        <str>   kanban card id this error is scoped to
#   --pr          <str>   PR URL this error is scoped to
#   -h, --help            print this help
#
# Environment:
#   PROJECT_ID        required — selects the workspace
#   AGENT_HUB_URL     optional — default http://localhost:3051
#   AGENT_HUB_API_KEY optional — resolved via ah-api.sh
#
# Exit codes:
#   0  line appended; logged line echoed on stdout
#   2  bad invocation (missing required flag, --help, no PROJECT_ID)
#   *  curl / API / filesystem error

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./ah-api.sh
source "$DIR/ah-api.sh"

_usage() {
  cat <<'EOF'
usage: log-tool-error.sh --tool <name> --action <cmd> --exit <code> --summary <txt>
                         [v2 options: --sev --resolution --session-id --agent-id
                          --attempt --tag (repeatable) --card --pr]

Append a TOOL_ERROR self-report line to today's daily note
(<workspace>/memory/<YYYY-MM-DD>.md).

v1 format (when no v2 flags are set):
  TOOL_ERROR | <ts> | <tool> | <action> | <exit> | <summary>

v2 format (when any v2 flag is set):
  TOOL_ERROR | <ts> | <tool> | <action> | <exit> | <summary> | {"v":2,...}

Required options:
  --tool     <str>   tool that failed (e.g. Bash, Read)
  --action   <str>   command or action attempted
  --exit     <str>   exit code or error type (e.g. "exit 1")
  --summary  <str>   one-line summary of the failure

Optional v2 structured metadata (opting any one in emits a v2 line):
  --sev         blocked | soft | retry
  --resolution  unresolved | recovered | escalated | duplicate | preexisting
  --session-id  e.g. "$AGENT_HUB_SESSION_ID"
  --agent-id    agent slug
  --attempt     integer retry counter
  --tag         freeform tag (repeatable)
  --card        kanban card id
  --pr          PR URL

Environment:
  PROJECT_ID         required
  AGENT_HUB_URL      default http://localhost:3051
  AGENT_HUB_API_KEY  resolved via ah-api.sh

Examples:
  # v1 line (backward-compatible default)
  PROJECT_ID=agent-hub log-tool-error.sh \
    --tool Bash --action 'npm test' --exit 'exit 1' \
    --summary 'ENOENT: tsx not found in PATH'

  # v2 line — soft failure, auto-recovered, correlate to this session
  PROJECT_ID=agent-hub log-tool-error.sh \
    --tool aws-ssm --action 'deploy-dev run 24587084751' \
    --exit 'exit 1' --summary 'PAM session-close; deploy itself succeeded' \
    --sev soft --resolution recovered --session-id "$AGENT_HUB_SESSION_ID" \
    --tag deploy --tag aws
EOF
}

tool=""
action=""
exitcode=""
summary=""
sev=""
resolution=""
session_id=""
agent_id=""
attempt=""
card=""
pr=""
tags=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tool)        tool="${2:-}";       shift 2 ;;
    --action)      action="${2:-}";     shift 2 ;;
    --exit)        exitcode="${2:-}";   shift 2 ;;
    --summary)     summary="${2:-}";    shift 2 ;;
    --sev)         sev="${2:-}";        shift 2 ;;
    --resolution)  resolution="${2:-}"; shift 2 ;;
    --session-id)  session_id="${2:-}"; shift 2 ;;
    --agent-id)    agent_id="${2:-}";   shift 2 ;;
    --attempt)     attempt="${2:-}";    shift 2 ;;
    --tag)         tags+=("${2:-}");    shift 2 ;;
    --card)        card="${2:-}";       shift 2 ;;
    --pr)          pr="${2:-}";         shift 2 ;;
    -h|--help|help) _usage; exit 0 ;;
    *)
      echo "error: unknown option '$1'" >&2
      _usage >&2
      exit 2
      ;;
  esac
done

for pair in "tool:--tool" "action:--action" "exitcode:--exit" "summary:--summary"; do
  name="${pair%%:*}"
  flag="${pair##*:}"
  if [[ -z "${!name}" ]]; then
    echo "error: $flag is required" >&2
    _usage >&2
    exit 2
  fi
done

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "error: PROJECT_ID must be set" >&2
  exit 2
fi

# Sanitise: collapse newlines → space, replace pipes → `/` so the resulting
# line always has exactly 6 pipe-delimited fields. We log a warning on stderr
# if we had to rewrite anything so callers notice silent mangling.
_sanitise() {
  local raw="$1" cleaned
  # tr handles newlines/tabs; sed replaces pipes. Both are stable for UTF-8.
  cleaned="$(printf '%s' "$raw" | tr '\n\r\t' '   ' | sed 's/|/\//g')"
  if [[ "$cleaned" != "$raw" ]]; then
    echo "warning: sanitised TOOL_ERROR field (pipes or newlines rewritten)" >&2
  fi
  printf '%s' "$cleaned"
}

tool="$(_sanitise "$tool")"
action="$(_sanitise "$action")"
exitcode="$(_sanitise "$exitcode")"
summary="$(_sanitise "$summary")"

iso_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
line="TOOL_ERROR | ${iso_ts} | ${tool} | ${action} | ${exitcode} | ${summary}"

# If any v2 flag is set, build a JSON tail and append it as the 7th field.
# We shell out to python3 (already a hard dep of this script) to do JSON
# encoding so string escaping stays correct on arbitrary inputs.
_has_v2_flag=0
if [[ -n "$sev" || -n "$resolution" || -n "$session_id" || -n "$agent_id" ||
      -n "$attempt" || -n "$card" || -n "$pr" || ${#tags[@]} -gt 0 ]]; then
  _has_v2_flag=1
fi

if [[ $_has_v2_flag -eq 1 ]]; then
  # Validate known enums early so agents get a clear failure instead of a
  # silently malformed tail. The parser also collapses unknown values to
  # "unknown", but catching it here surfaces typos at write time.
  if [[ -n "$sev" && "$sev" != "blocked" && "$sev" != "soft" && "$sev" != "retry" ]]; then
    echo "error: --sev must be one of blocked|soft|retry (got '$sev')" >&2
    exit 2
  fi
  if [[ -n "$resolution" && "$resolution" != "unresolved" && "$resolution" != "recovered" &&
        "$resolution" != "escalated" && "$resolution" != "duplicate" &&
        "$resolution" != "preexisting" ]]; then
    echo "error: --resolution must be one of unresolved|recovered|escalated|duplicate|preexisting (got '$resolution')" >&2
    exit 2
  fi
  if [[ -n "$attempt" && ! "$attempt" =~ ^[0-9]+$ ]]; then
    echo "error: --attempt must be a non-negative integer (got '$attempt')" >&2
    exit 2
  fi

  tail_json="$(
    AH_SEV="$sev" AH_RES="$resolution" AH_SESSION="$session_id" AH_AGENT="$agent_id" \
    AH_ATTEMPT="$attempt" AH_CARD="$card" AH_PR="$pr" \
    AH_TAGS_JOINED="$(IFS=$'\x1f'; echo "${tags[*]-}")" \
    python3 <<'PY'
import json, os
obj = {"v": 2}
if os.environ.get("AH_SEV"):      obj["sev"] = os.environ["AH_SEV"]
if os.environ.get("AH_RES"):      obj["resolution"] = os.environ["AH_RES"]
if os.environ.get("AH_SESSION"):  obj["session"] = os.environ["AH_SESSION"]
if os.environ.get("AH_AGENT"):    obj["agent"] = os.environ["AH_AGENT"]
if os.environ.get("AH_ATTEMPT"):  obj["attempt"] = int(os.environ["AH_ATTEMPT"])
if os.environ.get("AH_CARD"):     obj["card"] = os.environ["AH_CARD"]
if os.environ.get("AH_PR"):       obj["pr"] = os.environ["AH_PR"]
raw_tags = os.environ.get("AH_TAGS_JOINED", "")
if raw_tags:
    obj["tags"] = [t for t in raw_tags.split("\x1f") if t]
# Compact separators keep the line short and greppable.
print(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
PY
  )"
  line="${line} | ${tail_json}"
fi

# Resolve the workspace (`ahw`) for the current project. We fail fast if the
# API is unreachable — the caller should either fix that or log manually.
project_json="$(ah_api GET "/api/projects/$PROJECT_ID")"
workspace="$(
  AH_JSON="$project_json" python3 <<'PY'
import json, os, sys
data = json.loads(os.environ["AH_JSON"])
ahw = data.get("ahw") or ""
if not ahw:
    sys.stderr.write("error: project has no workspace (ahw) configured\n")
    sys.exit(1)
print(ahw)
PY
)"

memory_dir="$workspace/memory"
mkdir -p "$memory_dir"

date_str="$(date +"%Y-%m-%d")"
time_str="$(date +"%H:%M")"
note_path="$memory_dir/${date_str}.md"

# Match the `## HH:MM\n<entry>\n\n` block shape used by
# server/memory.ts::appendDailyNote so the web memory UI renders cleanly.
{
  printf '## %s\n' "$time_str"
  printf 'TOOL_ERROR self-report\n\n'
  printf '```\n%s\n```\n\n' "$line"
} >> "$note_path"

printf '%s\n' "$line"
