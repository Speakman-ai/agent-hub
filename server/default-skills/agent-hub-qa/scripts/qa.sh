#!/usr/bin/env bash
# qa.sh — QA plan / case / run / result wrapper over
# /api/projects/$PROJECT_ID/qa/plans. Prints the API's JSON response.
#
# Subcommands:
#   plan list [--status new|in_progress|done]
#   plan get <planId>
#   plan update <planId> [--title T] [--goal G] [--target-url U]
#                        [--epic-id ID|--no-epic] [--card-id ID|--no-card]
#                        [--auto-rerun on|off] [--max-iterations N]
#   case add <planId> --title T [--steps S] [--expected E]
#   case update <planId> <caseId> [--title T] [--steps S] [--expected E]
#   case delete <planId> <caseId>
#   case reorder <planId> <caseId> [<caseId> ...]   (every case id, new order)
#   run get <planId> <runId>
#   run begin <planId> <runId>
#   run finish <planId> <runId>
#   result post <planId> <runId> --case <caseId> --verdict pass|fail|needs_change|blocked
#                        [--actual A] [--notes N] [--screenshot <artifactId>]...
#                        [--finding-card <cardId>]
#   env list                    (servers under test + test accounts; passwords masked)
#
# --steps / --expected / --actual / --notes / --goal accept "@path" to read the
# value from a file, or "-" to read it from stdin.
#
# Environment: PROJECT_ID (required), AGENT_HUB_URL / API key via ah-api.sh.
# Exit codes: 0 ok, 2 bad invocation, other = curl / API error.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/../../agent-hub/scripts/ah-api.sh"

usage() {
  sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "qa.sh: $*" >&2
  exit 2
}

need_value() {
  [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"
}

# Text flags take a literal, "@file", or "-" (stdin).
read_text() {
  local v="$1"
  if [[ "$v" == "-" ]]; then
    cat
  elif [[ "$v" == @* ]]; then
    local f="${v#@}"
    [[ -f "$f" ]] || die "file not found: $f"
    [[ -r "$f" ]] || die "file not readable: $f"
    cat "$f" || die "could not read: $f"
  else
    printf '%s' "$v"
  fi
}

# JSON body builder: each call adds one key. Values go through jq --arg /
# --argjson so quotes and newlines are escaped correctly.
JQ_ARGS=()
JQ_FILTER='{}'
N=0
set_str() {
  JQ_ARGS+=(--arg "v$N" "$2")
  JQ_FILTER+=" | .$1 = \$v$N"
  N=$((N + 1))
}
set_json() {
  JQ_ARGS+=(--argjson "v$N" "$2")
  JQ_FILTER+=" | .$1 = \$v$N"
  N=$((N + 1))
}
# set_text KEY VALUE: like set_str, but VALUE goes through read_text. The read
# runs in a command substitution, where die only exits the subshell, so the
# status is checked here to stop before any request is sent.
set_text() {
  local text
  text="$(read_text "$2")" || exit 2
  set_str "$1" "$text"
}
body() {
  jq -cn "${JQ_ARGS[@]}" "$JQ_FILTER"
}

valid_id() {
  [[ -n "$1" && "$1" != -* && "$1" =~ ^[A-Za-z0-9._:-]+$ ]] || die "invalid $2: '${1}'"
}

plans_path() {
  printf '/api/projects/%s/qa/plans' "$PROJECT_ID"
}

cmd_plan() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    list)
      local status=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --status)
            need_value "$@"
            status="$2"
            shift 2
            ;;
          *) die "plan list: unknown option $1" ;;
        esac
      done
      local q=""
      if [[ -n "$status" ]]; then
        [[ "$status" =~ ^(new|in_progress|done)$ ]] || die "--status must be new, in_progress, or done"
        q="?status=$status"
      fi
      ah_api GET "$(plans_path)$q"
      ;;
    get)
      valid_id "${1:-}" planId
      ah_api GET "$(plans_path)/$1"
      ;;
    update)
      local plan="${1:-}"
      valid_id "$plan" planId
      shift
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --title | --target-url | --epic-id | --card-id | --max-iterations | --auto-rerun | --goal)
            need_value "$@"
            ;;
        esac
        case "$1" in
          --title) set_str title "$2" ;;
          --goal) set_text goal "$2" ;;
          --target-url) set_str targetUrl "$2" ;;
          --epic-id) set_str epicId "$2" ;;
          --card-id) set_str cardId "$2" ;;
          --no-epic)
            set_json epicId null
            shift
            continue
            ;;
          --no-card)
            set_json cardId null
            shift
            continue
            ;;
          --auto-rerun)
            case "$2" in
              on | true) set_json autoRerun true ;;
              off | false) set_json autoRerun false ;;
              *) die "--auto-rerun must be on or off" ;;
            esac
            ;;
          --max-iterations)
            [[ "$2" =~ ^[0-9]+$ ]] || die "--max-iterations must be an integer"
            set_json maxIterations "$2"
            ;;
          *) die "plan update: unknown option $1" ;;
        esac
        shift 2
      done
      [[ $N -gt 0 ]] || die "plan update: nothing to change"
      ah_api PATCH "$(plans_path)/$plan" -d "$(body)"
      ;;
    *) die "unknown plan subcommand '${sub}' (list, get, update)" ;;
  esac
}

# Parses --title/--steps/--expected into the body builder.
case_fields() {
  while [[ $# -gt 0 ]]; do
    need_value "$@"
    case "$1" in
      --title) set_str title "$2" ;;
      --steps) set_text steps "$2" ;;
      --expected) set_text expected "$2" ;;
      *) die "case: unknown option $1" ;;
    esac
    shift 2
  done
}

cmd_case() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    add)
      local plan="${1:-}"
      valid_id "$plan" planId
      shift
      case_fields "$@"
      [[ "$JQ_FILTER" == *".title ="* ]] || die "case add: --title is required"
      ah_api POST "$(plans_path)/$plan/cases" -d "$(body)"
      ;;
    update)
      local plan="${1:-}" case_id="${2:-}"
      valid_id "$plan" planId
      valid_id "$case_id" caseId
      shift 2
      case_fields "$@"
      [[ $N -gt 0 ]] || die "case update: nothing to change"
      ah_api PATCH "$(plans_path)/$plan/cases/$case_id" -d "$(body)"
      ;;
    delete)
      valid_id "${1:-}" planId
      valid_id "${2:-}" caseId
      ah_api DELETE "$(plans_path)/$1/cases/$2"
      ;;
    reorder)
      local plan="${1:-}"
      valid_id "$plan" planId
      shift
      [[ $# -gt 0 ]] || die "case reorder: pass every case id in the new order"
      local id
      for id in "$@"; do valid_id "$id" caseId; done
      set_json orderedIds "$(printf '%s\n' "$@" | jq -R . | jq -cs .)"
      ah_api POST "$(plans_path)/$plan/cases/reorder" -d "$(body)"
      ;;
    *) die "unknown case subcommand '${sub}' (add, update, delete, reorder)" ;;
  esac
}

cmd_run() {
  local sub="${1:-}"
  shift || true
  valid_id "${1:-}" planId
  valid_id "${2:-}" runId
  local base
  base="$(plans_path)/$1/runs/$2"
  case "$sub" in
    get) ah_api GET "$base" ;;
    begin) ah_api POST "$base/begin" ;;
    finish) ah_api POST "$base/finish" ;;
    *) die "unknown run subcommand '${sub}' (get, begin, finish)" ;;
  esac
}

cmd_result() {
  local sub="${1:-}"
  shift || true
  [[ "$sub" == "post" ]] || die "unknown result subcommand '${sub}' (post)"
  local plan="${1:-}" run="${2:-}"
  valid_id "$plan" planId
  valid_id "$run" runId
  shift 2
  local case_id="" verdict="" shots=() s
  while [[ $# -gt 0 ]]; do
    need_value "$@"
    case "$1" in
      --case) case_id="$2" ;;
      --verdict) verdict="$2" ;;
      --actual) set_text actual "$2" ;;
      --notes) set_text notes "$2" ;;
      --screenshot)
        IFS=',' read -r -a parts <<<"$2"
        for s in "${parts[@]}"; do
          s="${s//[[:space:]]/}"
          [[ -z "$s" ]] && continue
          valid_id "$s" "screenshot artifact id"
          shots+=("$s")
        done
        ;;
      --finding-card)
        valid_id "$2" findingCardId
        set_str findingCardId "$2"
        ;;
      *) die "result post: unknown option $1" ;;
    esac
    shift 2
  done
  valid_id "$case_id" "--case"
  [[ "$verdict" =~ ^(pass|fail|needs_change|blocked)$ ]] ||
    die "--verdict must be pass, fail, needs_change, or blocked"
  set_str caseId "$case_id"
  set_str verdict "$verdict"
  if [[ ${#shots[@]} -gt 0 ]]; then
    set_json screenshotArtifactIds "$(printf '%s\n' "${shots[@]}" | jq -R . | jq -cs .)"
  fi
  ah_api POST "$(plans_path)/$plan/runs/$run/results" -d "$(body)"
}

group="${1:-help}"
shift || true
if [[ "$group" != help && "$group" != -h && "$group" != --help ]]; then
  command -v jq >/dev/null 2>&1 || die "jq is required"
  [[ -n "${PROJECT_ID:-}" ]] || die "PROJECT_ID must be set"
fi
case "$group" in
  plan) cmd_plan "$@" ;;
  case) cmd_case "$@" ;;
  run) cmd_run "$@" ;;
  result) cmd_result "$@" ;;
  env)
    [[ "${1:-}" == list ]] || die "usage: qa.sh env list"
    ah_api GET "/api/projects/$PROJECT_ID/qa/environments"
    ;;
  help | -h | --help) usage ;;
  *) die "unknown command '$group' (try qa.sh help)" ;;
esac
