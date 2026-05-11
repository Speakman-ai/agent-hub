#!/usr/bin/env bash
# scripts/gh-pr.sh — pull request workflows for the GitHub skill.
#
# Usage:
#   gh-pr.sh create   --title <title> [--base <branch>] [--body <text>]
#                     [--draft] [--reviewer <login>] [--label <label>]
#   gh-pr.sh list     [--state open|closed|merged|all] [--limit <n>]
#                     [--repo owner/repo]
#   gh-pr.sh view     <number|URL>
#   gh-pr.sh diff     <number>
#   gh-pr.sh checkout <number>
#   gh-pr.sh review   <number> --approve
#   gh-pr.sh review   <number> --request-changes [--body <text>]
#   gh-pr.sh review   <number> --comment --body <text>
#   gh-pr.sh comment  <number> --body <text>
#   gh-pr.sh merge    <number> [--squash|--rebase|--merge] [--auto] [--delete-branch]
#   gh-pr.sh ready    <number>          # mark draft as ready for review
#   gh-pr.sh close    <number>
#   gh-pr.sh status                     # PRs involving your branches
#   gh-pr.sh checks   <number>          # CI check status for a PR

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/_common.sh"

# ---------------------------------------------------------------------------
# pr create
# ---------------------------------------------------------------------------
cmd_create() {
  local title="" base="" body="" draft=false reviewer="" label=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title)    title="$2";    shift 2 ;;
      --base)     base="$2";     shift 2 ;;
      --body)     body="$2";     shift 2 ;;
      --draft)    draft=true;    shift   ;;
      --reviewer) reviewer="$2"; shift 2 ;;
      --label)    label="$2";    shift 2 ;;
      *) gh_die "pr create: unknown flag '$1'" ;;
    esac
  done
  _require_arg "--title" "$title"

  require_gh_token

  local args=(pr create --title "$title")
  [[ -n "$base" ]]       && args+=(--base "$base")
  [[ -n "$body" ]]       && args+=(--body "$body")
  [[ "$draft" == true ]] && args+=(--draft)
  [[ -n "$reviewer" ]] && args+=(--reviewer "$reviewer")
  [[ -n "$label" ]]    && args+=(--label "$label")

  # gh pr create does not support --json/--jq; capture the URL it prints and
  # follow up with a view call for structured output.
  local pr_url
  pr_url=$(gh "${args[@]}")
  gh pr view "$pr_url" --json number,url,title,state \
    --jq '"PR #\(.number): \(.title)\nURL: \(.url)\nState: \(.state)"'
}

# ---------------------------------------------------------------------------
# pr list
# ---------------------------------------------------------------------------
cmd_list() {
  local state="open" limit=20 repo=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --state) state="$2"; shift 2 ;;
      --limit) limit="$2"; shift 2 ;;
      --repo)  repo="$2";  shift 2 ;;
      *) gh_die "pr list: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  local args=(pr list --state "$state" --limit "$limit"
    --json number,title,author,state,headRefName,updatedAt,url
    --jq '.[] | "#\(.number)\t\(.state)\t\(.author.login)\t\(.headRefName)\t\(.title)"')
  [[ -n "$repo" ]] && args+=(--repo "$repo")

  gh "${args[@]}"
}

# ---------------------------------------------------------------------------
# pr view
# ---------------------------------------------------------------------------
cmd_view() {
  [[ $# -lt 1 ]] && gh_die "pr view <number|URL>"
  require_gh_token

  local target="$1"
  if [[ "$target" =~ ^https?:// ]]; then
    gh pr view "$target"
  else
    gh pr view "$target" --json number,title,author,state,body,headRefName,baseRefName,url,mergeable,reviewDecision,checks \
      --jq '"PR #\(.number): \(.title)\nAuthor : \(.author.login)\nState  : \(.state)\nBase   : \(.baseRefName) ← \(.headRefName)\nURL    : \(.url)\nMergeable: \(.mergeable)\nReviews  : \(.reviewDecision // "none")\n\nBody:\n\(.body)"'
  fi
}

# ---------------------------------------------------------------------------
# pr diff
# ---------------------------------------------------------------------------
cmd_diff() {
  [[ $# -lt 1 ]] && gh_die "pr diff <number>"
  require_gh_token
  gh pr diff "$1"
}

# ---------------------------------------------------------------------------
# pr checkout
# ---------------------------------------------------------------------------
cmd_checkout() {
  [[ $# -lt 1 ]] && gh_die "pr checkout <number>"
  require_gh_token
  gh pr checkout "$1"
}

# ---------------------------------------------------------------------------
# pr review
# ---------------------------------------------------------------------------
cmd_review() {
  [[ $# -lt 1 ]] && gh_die "pr review <number> --approve | --request-changes [--body <text>] | --comment --body <text>"

  # Reviewer-agent lock: Agent Hub injects AGENT_HUB_REVIEWER_LOCK=1 into
  # reviewer-role spawn envs so the only correct identity path is the
  # server-side App endpoint at POST /api/pr/review. `gh pr review` here
  # would inherit whatever credential `gh` finds (host login, env tokens,
  # or operator OAuth) and historically attributed reviews to a human
  # account instead of the GitHub App. Fail loud rather than leak.
  if [[ "${AGENT_HUB_REVIEWER_LOCK:-}" == "1" ]]; then
    cat >&2 <<LOCKED
error: gh-pr.sh review is disabled inside Agent Hub reviewer sessions.

Reviewer agents must post formal reviews through the App-mediated
endpoint so reviews land with the GitHub App identity instead of the
host operator's gh login. Use:

  curl -sS -X POST "\$AGENT_HUB_URL/api/pr/review" \\
    -H "X-API-Key: \$AGENT_HUB_API_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{"prUrl":"<pr url>","event":"APPROVE|COMMENT|REQUEST_CHANGES","body":"<markdown>"}'

(Read-only subcommands like view/diff/list/status/checks remain available.)
LOCKED
    exit 2
  fi

  local number="$1"; shift

  local approve=false req_changes=false comment=false body=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --approve)          approve=true;      shift   ;;
      --request-changes)  req_changes=true;  shift   ;;
      --comment)          comment=true;      shift   ;;
      --body)             body="$2";         shift 2 ;;
      *) gh_die "pr review: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  if [[ "$approve" == true ]]; then
    local args=(pr review "$number" --approve)
    [[ -n "$body" ]] && args+=(--body "$body")
    gh "${args[@]}"
    echo "Approved PR #$number"
  elif [[ "$req_changes" == true ]]; then
    _require_arg "--body (required for request-changes)" "$body"
    gh pr review "$number" --request-changes --body "$body"
    echo "Requested changes on PR #$number"
  elif [[ "$comment" == true ]]; then
    _require_arg "--body (required for comment)" "$body"
    gh pr review "$number" --comment --body "$body"
    echo "Review comment posted on PR #$number"
  else
    gh_die "pr review: specify one of --approve, --request-changes, --comment"
  fi
}

# ---------------------------------------------------------------------------
# pr comment
# ---------------------------------------------------------------------------
cmd_comment() {
  [[ $# -lt 1 ]] && gh_die "pr comment <number> --body <text>"
  local number="$1"; shift

  local body=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --body) body="$2"; shift 2 ;;
      *) gh_die "pr comment: unknown flag '$1'" ;;
    esac
  done
  _require_arg "--body" "$body"

  require_gh_token
  gh pr comment "$number" --body "$body"
  echo "Comment posted on PR #$number"
}

# ---------------------------------------------------------------------------
# pr merge
# ---------------------------------------------------------------------------
cmd_merge() {
  [[ $# -lt 1 ]] && gh_die "pr merge <number> [--squash|--rebase|--merge] [--auto] [--delete-branch]"
  local number="$1"; shift

  local squash=false rebase=false merge_commit=false delete_branch=false auto=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --squash)        squash=true;        shift ;;
      --rebase)        rebase=true;        shift ;;
      --merge)         merge_commit=true;  shift ;;
      --auto)          auto=true;          shift ;;
      --delete-branch) delete_branch=true; shift ;;
      *) gh_die "pr merge: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  # gh pr merge requires an explicit method flag when running non-interactively
  # (even with --auto). Default to --squash if the caller didn't specify one.
  if [[ "$squash" == false && "$rebase" == false && "$merge_commit" == false ]]; then
    squash=true
  fi

  local args=(pr merge "$number")
  [[ "$squash" == true ]]        && args+=(--squash)
  [[ "$rebase" == true ]]        && args+=(--rebase)
  [[ "$merge_commit" == true ]]  && args+=(--merge)
  [[ "$auto" == true ]]          && args+=(--auto)
  [[ "$delete_branch" == true ]] && args+=(--delete-branch)

  gh "${args[@]}"

  if [[ "$auto" == true ]]; then
    echo "PR #$number queued for auto-merge"
  else
    echo "PR #$number merged"
  fi
}

# ---------------------------------------------------------------------------
# pr ready — mark draft as ready for review
# ---------------------------------------------------------------------------
cmd_ready() {
  [[ $# -lt 1 ]] && gh_die "pr ready <number>"
  require_gh_token
  gh pr ready "$1"
  echo "PR #$1 is now ready for review"
}

# ---------------------------------------------------------------------------
# pr close
# ---------------------------------------------------------------------------
cmd_close() {
  [[ $# -lt 1 ]] && gh_die "pr close <number>"
  require_gh_token
  gh pr close "$1"
  echo "PR #$1 closed"
}

# ---------------------------------------------------------------------------
# pr status — PRs involving your branches
# ---------------------------------------------------------------------------
cmd_status() {
  require_gh_token
  gh pr status
}

# ---------------------------------------------------------------------------
# pr checks — CI status for a PR
# ---------------------------------------------------------------------------
cmd_checks() {
  [[ $# -lt 1 ]] && gh_die "pr checks <number>"
  require_gh_token
  gh pr checks "$1"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
SUBCOMMAND="${1:-}"
shift || true

case "$SUBCOMMAND" in
  create)   cmd_create   "$@" ;;
  list)     cmd_list     "$@" ;;
  view)     cmd_view     "$@" ;;
  diff)     cmd_diff     "$@" ;;
  checkout) cmd_checkout "$@" ;;
  review)   cmd_review   "$@" ;;
  comment)  cmd_comment  "$@" ;;
  merge)    cmd_merge    "$@" ;;
  ready)    cmd_ready    "$@" ;;
  close)    cmd_close    "$@" ;;
  status)   cmd_status   "$@" ;;
  checks)   cmd_checks   "$@" ;;
  *)
    cat >&2 <<USAGE
Usage: gh-pr.sh <subcommand> [options]

Subcommands:
  create    --title <title> [--base <branch>] [--body <text>] [--draft]
            [--reviewer <login>] [--label <label>]
  list      [--state open|closed|merged|all] [--limit <n>] [--repo owner/repo]
  view      <number|URL>
  diff      <number>
  checkout  <number>
  review    <number> --approve | --request-changes --body <text> | --comment --body <text>
  comment   <number> --body <text>
  merge     <number> [--squash|--rebase|--merge] [--auto] [--delete-branch]
  ready     <number>
  close     <number>
  status
  checks    <number>

Examples:
  gh-pr.sh create --title "feat: add dark mode" --base main --draft
  gh-pr.sh list --state open --limit 10
  gh-pr.sh review 42 --approve
  gh-pr.sh review 42 --request-changes --body "Please add tests."
  gh-pr.sh merge 42 --squash --delete-branch
USAGE
    exit 2
    ;;
esac
