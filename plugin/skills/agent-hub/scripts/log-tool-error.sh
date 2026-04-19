#!/usr/bin/env bash
# scripts/log-tool-error.sh — append a TOOL_ERROR self-report line to today's
# daily note.
#
# Format produced (single line, six pipe-delimited fields — see
# references/errors.md):
#
#   TOOL_ERROR | <ISO timestamp> | <tool> | <action> | <exit> | <summary>
#
# The timestamp is generated here in UTC (`YYYY-MM-DDTHH:MM:SSZ`) so agents
# can't drift from the canonical format. Any `|` or newline in caller-supplied
# fields is sanitised (replaced with `/` or space) so the line stays
# parseable.
#
# The daily note lives at `<workspace>/memory/<YYYY-MM-DD>.md`. The workspace
# is read from `GET /api/projects/$PROJECT_ID` (`.ahw`) so the script works
# regardless of the current working directory. Each invocation appends a new
# `## HH:MM` section followed by the TOOL_ERROR line, matching the existing
# daily-note convention used by `appendDailyNote` in `server/memory.ts`.
#
# Usage:
#   log-tool-error.sh --tool <name> --action <cmd> --exit <code> --summary <txt>
#
# Options:
#   --tool     <str>   tool that failed (e.g. Bash, Read, Edit)   (required)
#   --action   <str>   command or action attempted                (required)
#   --exit     <str>   exit code or error type (e.g. "exit 1")    (required)
#   --summary  <str>   one-line summary of the failure            (required)
#   -h, --help         print this help
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

Append a TOOL_ERROR self-report line to today's daily note
(<workspace>/memory/<YYYY-MM-DD>.md). Format:

  TOOL_ERROR | <ISO timestamp> | <tool> | <action> | <exit> | <summary>

Options:
  --tool     <str>   tool that failed (e.g. Bash, Read)        (required)
  --action   <str>   command or action attempted               (required)
  --exit     <str>   exit code or error type (e.g. "exit 1")   (required)
  --summary  <str>   one-line summary of the failure           (required)
  -h, --help         print this help

Environment:
  PROJECT_ID         required
  AGENT_HUB_URL      default http://localhost:3051
  AGENT_HUB_API_KEY  resolved via ah-api.sh

Example:
  PROJECT_ID=agent-hub log-tool-error.sh \
    --tool Bash \
    --action 'npm test' \
    --exit 'exit 1' \
    --summary 'ENOENT: tsx not found in PATH'
EOF
}

tool=""
action=""
exitcode=""
summary=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tool)    tool="${2:-}";     shift 2 ;;
    --action)  action="${2:-}";   shift 2 ;;
    --exit)    exitcode="${2:-}"; shift 2 ;;
    --summary) summary="${2:-}";  shift 2 ;;
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
