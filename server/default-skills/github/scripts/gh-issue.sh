#!/usr/bin/env bash
# scripts/gh-issue.sh — issue workflows for the GitHub skill.
#
# Usage:
#   gh-issue.sh create  --title <title> [--body <text>] [--label <label,…>]
#                       [--assignee <login>] [--milestone <number>]
#   gh-issue.sh list    [--state open|closed|all] [--label <label>]
#                       [--assignee <login>] [--limit <n>] [--repo owner/repo]
#   gh-issue.sh view    <number|URL>
#   gh-issue.sh comment <number> --body <text>
#   gh-issue.sh close   <number> [--comment <text>]
#   gh-issue.sh reopen  <number>
#   gh-issue.sh label   <number> --add <label,…> | --remove <label,…>
#   gh-issue.sh assign  <number> --add <login,…> | --remove <login,…>
#   gh-issue.sh search  "<query>" [--limit <n>]

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/_common.sh"

# ---------------------------------------------------------------------------
# issue create
# ---------------------------------------------------------------------------
cmd_create() {
  local title="" body="" label="" assignee="" milestone=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title)     title="$2";     shift 2 ;;
      --body)      body="$2";      shift 2 ;;
      --label)     label="$2";     shift 2 ;;
      --assignee)  assignee="$2";  shift 2 ;;
      --milestone) milestone="$2"; shift 2 ;;
      *) gh_die "issue create: unknown flag '$1'" ;;
    esac
  done
  _require_arg "--title" "$title"

  require_gh_token

  local args=(issue create --title "$title")
  [[ -n "$body" ]]      && args+=(--body "$body")
  [[ -n "$label" ]]     && args+=(--label "$label")
  [[ -n "$assignee" ]]  && args+=(--assignee "$assignee")
  [[ -n "$milestone" ]] && args+=(--milestone "$milestone")

  gh "${args[@]}"
}

# ---------------------------------------------------------------------------
# issue list
# ---------------------------------------------------------------------------
cmd_list() {
  local state="open" label="" assignee="" limit=20 repo=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --state)    state="$2";    shift 2 ;;
      --label)    label="$2";    shift 2 ;;
      --assignee) assignee="$2"; shift 2 ;;
      --limit)    limit="$2";    shift 2 ;;
      --repo)     repo="$2";     shift 2 ;;
      *) gh_die "issue list: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  local args=(issue list --state "$state" --limit "$limit"
    --json number,title,author,state,labels,assignees,updatedAt
    --jq '.[] | "#\(.number)\t\(.state)\t\(.author.login)\t\([.labels[].name] | join(","))\t\(.title)"')
  [[ -n "$label" ]]    && args+=(--label "$label")
  [[ -n "$assignee" ]] && args+=(--assignee "$assignee")
  [[ -n "$repo" ]]     && args+=(--repo "$repo")

  gh "${args[@]}"
}

# ---------------------------------------------------------------------------
# issue view
# ---------------------------------------------------------------------------
cmd_view() {
  [[ $# -lt 1 ]] && gh_die "issue view <number|URL>"
  require_gh_token

  local target="$1"
  if [[ "$target" =~ ^https?:// ]]; then
    gh issue view "$target"
  else
    gh issue view "$target" \
      --json number,title,author,state,body,labels,assignees,milestone,url,createdAt,comments \
      --jq '"Issue #\(.number): \(.title)\nAuthor : \(.author.login)\nState  : \(.state)\nLabels : \([.labels[].name] | join(", "))\nURL    : \(.url)\n\nBody:\n\(.body)"'
  fi
}

# ---------------------------------------------------------------------------
# issue comment
# ---------------------------------------------------------------------------
cmd_comment() {
  [[ $# -lt 1 ]] && gh_die "issue comment <number> --body <text>"
  local number="$1"; shift

  local body=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --body) body="$2"; shift 2 ;;
      *) gh_die "issue comment: unknown flag '$1'" ;;
    esac
  done
  _require_arg "--body" "$body"

  require_gh_token
  gh issue comment "$number" --body "$body"
  echo "Comment posted on issue #$number"
}

# ---------------------------------------------------------------------------
# issue close
# ---------------------------------------------------------------------------
cmd_close() {
  [[ $# -lt 1 ]] && gh_die "issue close <number> [--comment <text>]"
  local number="$1"; shift

  local comment=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --comment) comment="$2"; shift 2 ;;
      *) gh_die "issue close: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  if [[ -n "$comment" ]]; then
    gh issue comment "$number" --body "$comment"
  fi
  gh issue close "$number"
  echo "Issue #$number closed"
}

# ---------------------------------------------------------------------------
# issue reopen
# ---------------------------------------------------------------------------
cmd_reopen() {
  [[ $# -lt 1 ]] && gh_die "issue reopen <number>"
  require_gh_token
  gh issue reopen "$1"
  echo "Issue #$1 reopened"
}

# ---------------------------------------------------------------------------
# issue label
# ---------------------------------------------------------------------------
cmd_label() {
  [[ $# -lt 1 ]] && gh_die "issue label <number> --add <labels> | --remove <labels>"
  local number="$1"; shift

  local add="" remove=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --add)    add="$2";    shift 2 ;;
      --remove) remove="$2"; shift 2 ;;
      *) gh_die "issue label: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  if [[ -n "$add" ]]; then
    gh issue edit "$number" --add-label "$add"
    echo "Added labels [$add] to issue #$number"
  fi
  if [[ -n "$remove" ]]; then
    gh issue edit "$number" --remove-label "$remove"
    echo "Removed labels [$remove] from issue #$number"
  fi
  [[ -z "$add" && -z "$remove" ]] && gh_die "issue label: specify --add and/or --remove"
}

# ---------------------------------------------------------------------------
# issue assign
# ---------------------------------------------------------------------------
cmd_assign() {
  [[ $# -lt 1 ]] && gh_die "issue assign <number> --add <login,…> | --remove <login,…>"
  local number="$1"; shift

  local add="" remove=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --add)    add="$2";    shift 2 ;;
      --remove) remove="$2"; shift 2 ;;
      *) gh_die "issue assign: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  if [[ -n "$add" ]]; then
    gh issue edit "$number" --add-assignee "$add"
    echo "Assigned $add to issue #$number"
  fi
  if [[ -n "$remove" ]]; then
    gh issue edit "$number" --remove-assignee "$remove"
    echo "Removed $remove from issue #$number"
  fi
  [[ -z "$add" && -z "$remove" ]] && gh_die "issue assign: specify --add and/or --remove"
}

# ---------------------------------------------------------------------------
# issue search
# ---------------------------------------------------------------------------
cmd_search() {
  [[ $# -lt 1 ]] && gh_die "issue search \"<query>\" [--limit <n>]"
  local query="$1"; shift
  local limit=20

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit) limit="$2"; shift 2 ;;
      *) gh_die "issue search: unknown flag '$1'" ;;
    esac
  done

  require_gh_token
  gh issue list --search "$query" --limit "$limit" \
    --json number,title,author,state,labels,url \
    --jq '.[] | "#\(.number)\t\(.state)\t\(.author.login)\t\(.title)\t\(.url)"'
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
SUBCOMMAND="${1:-}"
shift || true

case "$SUBCOMMAND" in
  create)  cmd_create  "$@" ;;
  list)    cmd_list    "$@" ;;
  view)    cmd_view    "$@" ;;
  comment) cmd_comment "$@" ;;
  close)   cmd_close   "$@" ;;
  reopen)  cmd_reopen  "$@" ;;
  label)   cmd_label   "$@" ;;
  assign)  cmd_assign  "$@" ;;
  search)  cmd_search  "$@" ;;
  *)
    cat >&2 <<USAGE
Usage: gh-issue.sh <subcommand> [options]

Subcommands:
  create   --title <title> [--body <text>] [--label <label,…>]
           [--assignee <login>] [--milestone <number>]
  list     [--state open|closed|all] [--label <label>] [--assignee <login>]
           [--limit <n>] [--repo owner/repo]
  view     <number|URL>
  comment  <number> --body <text>
  close    <number> [--comment <text>]
  reopen   <number>
  label    <number> --add <labels> | --remove <labels>
  assign   <number> --add <logins> | --remove <logins>
  search   "<query>" [--limit <n>]

Examples:
  gh-issue.sh create --title "Bug: crash on save" --label bug
  gh-issue.sh list --state open --label bug --limit 10
  gh-issue.sh comment 42 --body "Confirmed — reproduces on v2.3."
  gh-issue.sh label 42 --add "needs-investigation" --remove "bug"
  gh-issue.sh close 42 --comment "Fixed in PR #99."
USAGE
    exit 2
    ;;
esac
