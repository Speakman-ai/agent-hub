#!/usr/bin/env bash
# scripts/linear.sh — high-level wrapper around the Linear GraphQL API.
#
# Usage:
#   linear.sh team   list
#   linear.sh state  list --team <teamId>
#   linear.sh cycle  list --team <teamId>
#   linear.sh project list [--team <teamId>]
#   linear.sh issue  list   [--team <teamId>] [--state <stateName>] [--limit <n>]
#   linear.sh issue  get    <issueId|LIN-42>
#   linear.sh issue  search <query>
#   linear.sh issue  create --title <title> --team <teamId>
#                           [--description <text>] [--state <stateName>]
#                           [--priority urgent|high|medium|no]
#   linear.sh issue  update <issueId> [--title <title>] [--state <stateName>]
#                           [--assignee <userId>] [--priority urgent|high|medium|no]
#   linear.sh issue  comment  <issueId> --body <text>
#   linear.sh issue  comments <issueId> [--limit <n>]
#   linear.sh whoami

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/_common.sh"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_priority_int() {
  case "${1,,}" in
    urgent) echo 1 ;;
    high)   echo 2 ;;
    medium) echo 3 ;;
    low)    echo 4 ;;
    no|none|0) echo 0 ;;
    *) linear_die "unknown priority '$1'. Use: urgent high medium low no" ;;
  esac
}

# _resolve_state_id TEAM_ID STATE_NAME → prints stateId UUID
_resolve_state_id() {
  local team_id="$1" state_name="$2"
  local q='query WS($t:String!){workflowStates(filter:{team:{id:{eq:$t}}}){nodes{id name}}}'
  linear_gql "$q" "{\"t\":\"$team_id\"}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
nodes = data['data']['workflowStates']['nodes']
name = sys.argv[1].lower()
match = next((n for n in nodes if n['name'].lower() == name), None)
if not match:
    print('error: state not found. Available:', ', '.join(n[\"name\"] for n in nodes), file=sys.stderr)
    sys.exit(1)
print(match['id'])
" "$state_name"
}

# ---------------------------------------------------------------------------
# whoami
# ---------------------------------------------------------------------------
cmd_whoami() {
  local q='query{viewer{id name email teams{nodes{id name key}}}}'
  linear_gql "$q" | pp_json
}

# ---------------------------------------------------------------------------
# team list
# ---------------------------------------------------------------------------
cmd_team_list() {
  local q='query{teams(first:50){nodes{id name key timezone}}}'
  linear_gql "$q" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for t in data['data']['teams']['nodes']:
    print(f\"{t['id']}\t{t['key']}\t{t['name']}\")
"
}

# ---------------------------------------------------------------------------
# state list --team <teamId>
# ---------------------------------------------------------------------------
cmd_state_list() {
  local team_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --team) team_id="$2"; shift 2 ;;
      *) linear_die "state list: unknown flag '$1'" ;;
    esac
  done
  [[ -z "$team_id" ]] && linear_die "state list requires --team <teamId>"

  local q='query WS($t:String!){workflowStates(filter:{team:{id:{eq:$t}}}){nodes{id name type position color}}}'
  linear_gql "$q" "{\"t\":\"$team_id\"}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
nodes = sorted(data['data']['workflowStates']['nodes'], key=lambda n: n.get('position', 0))
for n in nodes:
    print(f\"{n['id']}\t{n['type']:12s}\t{n['name']}\")
"
}

# ---------------------------------------------------------------------------
# cycle list --team <teamId>
# ---------------------------------------------------------------------------
cmd_cycle_list() {
  local team_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --team) team_id="$2"; shift 2 ;;
      *) linear_die "cycle list: unknown flag '$1'" ;;
    esac
  done
  [[ -z "$team_id" ]] && linear_die "cycle list requires --team <teamId>"

  local q='query CY($t:String!){cycles(filter:{team:{id:{eq:$t}}},first:20){nodes{id name number startsAt endsAt completedAt}}}'
  linear_gql "$q" "{\"t\":\"$team_id\"}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for c in data['data']['cycles']['nodes']:
    done = '✓' if c.get('completedAt') else ' '
    print(f\"[{done}] {c['id']}\t#{c['number']} {c.get('name','')}\t{c.get('startsAt','?')[:10]} → {c.get('endsAt','?')[:10]}\")
"
}

# ---------------------------------------------------------------------------
# project list [--team <teamId>]
# ---------------------------------------------------------------------------
cmd_project_list() {
  local team_id="" cursor=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --team) team_id="$2"; shift 2 ;;
      *) linear_die "project list: unknown flag '$1'" ;;
    esac
  done

  local filter="{}"
  [[ -n "$team_id" ]] && filter="{\"t\":\"$team_id\"}"

  local q
  if [[ -n "$team_id" ]]; then
    q='query PL($t:String!,$c:String){projects(first:50,after:$c,filter:{accessibleTeams:{id:{eq:$t}}}){nodes{id name state progress targetDate url}pageInfo{hasNextPage endCursor}}}'
  else
    q='query PL($c:String){projects(first:50,after:$c){nodes{id name state progress targetDate url}pageInfo{hasNextPage endCursor}}}'
  fi

  linear_gql "$q" "$filter" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for p in data['data']['projects']['nodes']:
    pct = int((p.get('progress') or 0) * 100)
    print(f\"{p['id']}\t{p['state']:12s}\t{pct:3d}%\t{p['name']}\")
"
}

# ---------------------------------------------------------------------------
# issue list [--team <teamId>] [--state <stateName>] [--limit <n>]
# ---------------------------------------------------------------------------
cmd_issue_list() {
  local team_id="" state_name="" limit=25
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --team)  team_id="$2";  shift 2 ;;
      --state) state_name="$2"; shift 2 ;;
      --limit) limit="$2"; shift 2 ;;
      *) linear_die "issue list: unknown flag '$1'" ;;
    esac
  done

  # Build filter object
  local filter_parts=()
  [[ -n "$team_id" ]] && filter_parts+=("\"team\":{\"id\":{\"eq\":\"$team_id\"}}")
  [[ -n "$state_name" ]] && filter_parts+=("\"state\":{\"name\":{\"eq\":\"$state_name\"}}")
  local filter="{$(IFS=,; echo "${filter_parts[*]}")}"

  local q='query IL($f:IssueFilter,$n:Int){issues(first:$n,filter:$f,orderBy:updatedAt){nodes{id identifier title state{name}assignee{name}priority priorityLabel updatedAt url}pageInfo{hasNextPage endCursor}}}'
  linear_gql "$q" "{\"f\":$filter,\"n\":$limit}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for i in data['data']['issues']['nodes']:
    assignee = i['assignee']['name'] if i.get('assignee') else '-'
    state = i['state']['name'] if i.get('state') else '?'
    print(f\"{i['identifier']}\t{state:15s}\t{i.get('priorityLabel','?'):8s}\t{assignee:20s}\t{i['title']}\")
"
}

# ---------------------------------------------------------------------------
# issue get <issueId>
# ---------------------------------------------------------------------------
cmd_issue_get() {
  [[ $# -lt 1 ]] && linear_die "issue get <issueId|LIN-42>"
  local issue_id="$1"

  local q='query IG($id:String!){issue(id:$id){id identifier title description state{id name type}assignee{id name email}priority priorityLabel labels{nodes{id name color}}project{id name}cycle{id name number}createdAt updatedAt url}}'
  linear_gql "$q" "{\"id\":\"$issue_id\"}" | pp_json
}

# ---------------------------------------------------------------------------
# issue search <query>
# ---------------------------------------------------------------------------
cmd_issue_search() {
  [[ $# -lt 1 ]] && linear_die "issue search <query>"
  local query="$*"

  # Encode via python3 so quotes, backslashes, and Unicode in the query string
  # don't produce malformed JSON variables.
  local q_json
  q_json=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$query")

  local q='query IS($q:String!){issueSearch(query:$q,first:25){nodes{id identifier title state{name}assignee{name}url}pageInfo{hasNextPage endCursor}}}'
  linear_gql "$q" "{\"q\":$q_json}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for i in data['data']['issueSearch']['nodes']:
    assignee = i['assignee']['name'] if i.get('assignee') else '-'
    state = i['state']['name'] if i.get('state') else '?'
    print(f\"{i['identifier']}\t{state:15s}\t{assignee:20s}\t{i['title']}\")
"
}

# ---------------------------------------------------------------------------
# issue create --title <title> --team <teamId> [options]
# ---------------------------------------------------------------------------
cmd_issue_create() {
  local title="" team_id="" description="" state_name="" priority="" assignee_id="" project_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title)       title="$2";       shift 2 ;;
      --team)        team_id="$2";     shift 2 ;;
      --description) description="$2"; shift 2 ;;
      --state)       state_name="$2";  shift 2 ;;
      --priority)    priority="$2";    shift 2 ;;
      --assignee)    assignee_id="$2"; shift 2 ;;
      --project)     project_id="$2";  shift 2 ;;
      *) linear_die "issue create: unknown flag '$1'" ;;
    esac
  done

  [[ -z "$title" ]]   && linear_die "issue create requires --title"
  [[ -z "$team_id" ]] && linear_die "issue create requires --team"

  # Build input JSON
  local input_parts=("\"title\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$title")")
  input_parts+=("\"teamId\":\"$team_id\"")
  [[ -n "$description" ]] && input_parts+=("\"description\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$description")")
  if [[ -n "$state_name" ]]; then
    local state_id
    state_id=$(_resolve_state_id "$team_id" "$state_name")
    input_parts+=("\"stateId\":\"$state_id\"")
  fi
  [[ -n "$priority" ]]    && input_parts+=("\"priority\":$(_priority_int "$priority")")
  [[ -n "$assignee_id" ]] && input_parts+=("\"assigneeId\":\"$assignee_id\"")
  [[ -n "$project_id" ]]  && input_parts+=("\"projectId\":\"$project_id\"")

  local input_json="{$(IFS=,; echo "${input_parts[*]}")}"

  local q='mutation IC($i:IssueCreateInput!){issueCreate(input:$i){success issue{id identifier title state{name}url}}}'
  local result
  result=$(linear_gql "$q" "{\"i\":$input_json}")

  echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
issue = data['data']['issueCreate']['issue']
print(f\"Created {issue['identifier']}: {issue['title']}\")
print(f\"State : {issue['state']['name']}\")
print(f\"URL   : {issue['url']}\")
"
}

# ---------------------------------------------------------------------------
# issue update <issueId> [options]
# ---------------------------------------------------------------------------
cmd_issue_update() {
  [[ $# -lt 1 ]] && linear_die "issue update <issueId> [--title ...] [--state ...] [--assignee ...] [--priority ...]"
  local issue_id="$1"; shift

  local title="" state_name="" assignee_id="" priority=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title)    title="$2";       shift 2 ;;
      --state)    state_name="$2";  shift 2 ;;
      --assignee) assignee_id="$2"; shift 2 ;;
      --priority) priority="$2";    shift 2 ;;
      *) linear_die "issue update: unknown flag '$1'" ;;
    esac
  done

  # Build input JSON
  local input_parts=()
  [[ -n "$title" ]] && input_parts+=("\"title\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$title")")

  if [[ -n "$state_name" ]]; then
    # We need the team_id to resolve states — get it from the issue first
    local issue_info team_id
    issue_info=$(linear_gql 'query IssueTeam($id:String!){issue(id:$id){team{id}}}' "{\"id\":\"$issue_id\"}")
    team_id=$(echo "$issue_info" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['issue']['team']['id'])")
    local state_id
    state_id=$(_resolve_state_id "$team_id" "$state_name")
    input_parts+=("\"stateId\":\"$state_id\"")
  fi

  [[ -n "$priority" ]]    && input_parts+=("\"priority\":$(_priority_int "$priority")")
  [[ -n "$assignee_id" ]] && input_parts+=("\"assigneeId\":\"$assignee_id\"")

  [[ ${#input_parts[@]} -eq 0 ]] && linear_die "issue update: no fields specified. Use --title, --state, --assignee, or --priority."

  local input_json="{$(IFS=,; echo "${input_parts[*]}")}"

  local q='mutation IU($id:String!,$i:IssueUpdateInput!){issueUpdate(id:$id,input:$i){success issue{id identifier title state{name}url}}}'
  local result
  result=$(linear_gql "$q" "{\"id\":\"$issue_id\",\"i\":$input_json}")

  echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
issue = data['data']['issueUpdate']['issue']
print(f\"Updated {issue['identifier']}: {issue['title']}\")
print(f\"State : {issue['state']['name']}\")
print(f\"URL   : {issue['url']}\")
"
}

# ---------------------------------------------------------------------------
# issue comment <issueId> --body <text>
# ---------------------------------------------------------------------------
cmd_issue_comment() {
  [[ $# -lt 1 ]] && linear_die "issue comment <issueId> --body <text>"
  local issue_id="$1"; shift

  local body=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --body) body="$2"; shift 2 ;;
      *) linear_die "issue comment: unknown flag '$1'" ;;
    esac
  done

  [[ -z "$body" ]] && linear_die "issue comment requires --body"

  local body_json
  body_json=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$body")

  local q='mutation CC($i:CommentCreateInput!){commentCreate(input:$i){success comment{id body createdAt}}}'
  linear_gql "$q" "{\"i\":{\"issueId\":\"$issue_id\",\"body\":$body_json}}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
c = data['data']['commentCreate']['comment']
print(f\"Comment {c['id']} added at {c['createdAt'][:19]}\")
"
}

# ---------------------------------------------------------------------------
# issue comments <issueId> [--limit <n>]
# ---------------------------------------------------------------------------
cmd_issue_comments() {
  [[ $# -lt 1 ]] && linear_die "issue comments <issueId> [--limit <n>]"
  local issue_id="$1"; shift
  local limit=25
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit) limit="$2"; shift 2 ;;
      *) linear_die "issue comments: unknown flag '$1'" ;;
    esac
  done

  local q='query Cmt($id:String!,$n:Int){comments(filter:{issue:{id:{eq:$id}}},first:$n){nodes{id body user{name}createdAt}pageInfo{hasNextPage}}}'
  linear_gql "$q" "{\"id\":\"$issue_id\",\"n\":$limit}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for c in data['data']['comments']['nodes']:
    user = c['user']['name'] if c.get('user') else 'unknown'
    ts = c['createdAt'][:10]
    body_preview = c['body'][:80].replace('\n',' ')
    print(f\"[{ts}] {user}: {body_preview}\")
"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
ENTITY="${1:-}"
shift || true
SUBCOMMAND="${1:-}"
shift || true

case "$ENTITY" in
  whoami)
    cmd_whoami "$@"
    ;;
  team)
    case "$SUBCOMMAND" in
      list) cmd_team_list "$@" ;;
      *) linear_die "unknown team subcommand '$SUBCOMMAND'. Available: list" ;;
    esac
    ;;
  state)
    case "$SUBCOMMAND" in
      list) cmd_state_list "$@" ;;
      *) linear_die "unknown state subcommand '$SUBCOMMAND'. Available: list" ;;
    esac
    ;;
  cycle)
    case "$SUBCOMMAND" in
      list) cmd_cycle_list "$@" ;;
      *) linear_die "unknown cycle subcommand '$SUBCOMMAND'. Available: list" ;;
    esac
    ;;
  project)
    case "$SUBCOMMAND" in
      list) cmd_project_list "$@" ;;
      *) linear_die "unknown project subcommand '$SUBCOMMAND'. Available: list" ;;
    esac
    ;;
  issue)
    case "$SUBCOMMAND" in
      list)     cmd_issue_list     "$@" ;;
      get)      cmd_issue_get      "$@" ;;
      search)   cmd_issue_search   "$@" ;;
      create)   cmd_issue_create   "$@" ;;
      update)   cmd_issue_update   "$@" ;;
      comment)  cmd_issue_comment  "$@" ;;
      comments) cmd_issue_comments "$@" ;;
      *)
        linear_die "unknown issue subcommand '$SUBCOMMAND'. Available: list get search create update comment comments"
        ;;
    esac
    ;;
  *)
    cat >&2 <<USAGE
Usage: linear.sh <entity> <subcommand> [options]

Entities:
  whoami
  team     list
  state    list --team <teamId>
  cycle    list --team <teamId>
  project  list [--team <teamId>]
  issue    list get search create update comment comments

Examples:
  linear.sh team list
  linear.sh issue list --team abc123 --state "In Progress"
  linear.sh issue get LIN-42
  linear.sh issue create --title "Bug: crash on save" --team abc123
  linear.sh issue update LIN-42 --state Done
  linear.sh issue comment LIN-42 --body "Fixed in PR #99."
USAGE
    exit 2
    ;;
esac
