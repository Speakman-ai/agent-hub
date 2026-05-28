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
#   gh-pr.sh files    <number>
#   gh-pr.sh checkout <number>
#   gh-pr.sh review   <number> --approve
#   gh-pr.sh review   <number> --request-changes --body <text>
#   (Formal reviews in Agent Hub spawns: POST /api/pr/review with APPROVE or REQUEST_CHANGES only)
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
# Reviewer lock — blocks identity-attributing write subcommands from all spawns
#
# Agent Hub injects AGENT_HUB_REVIEWER_LOCK=1 into EVERY spawn (not just
# reviewer-role spawns) via `applyReviewerSpawnIsolation`. The universal
# lock blocks `gh pr review` — formal review attribution must go through
# `POST /api/pr/review` so it lands as the GitHub App identity.
#
# Interactive non-reviewer spawns receive the session owner's per-user
# OAuth in `GH_TOKEN` (`resolveGithubSpawnToken`), so `gh pr create` is
# allowed when the token is a user credential (`gho_` / `ghp_`) — e.g.
# create-ticket-and-pr / ship-pr skill turns. App installation tokens
# (`ghs_`) and tokenless spawns are still blocked under the universal lock
# so mid-turn autonomous agents cannot author bot-attributed PRs.
# Reviewer-role spawns still block create via `AGENT_HUB_REVIEWER_ROLE_LOCK`.
#
# Other write subcommands (`comment`, `merge`, `close`, `ready`, `edit`)
# are NOT blocked under the universal lock. The role-scoped lock
# (`AGENT_HUB_REVIEWER_ROLE_LOCK=1`, reviewer-only) is the broader
# denylist for reviewer spawns.
#
# Read-only subcommands (view, diff, list, status, checks, checkout) are
# unguarded — inspecting a PR carries no identity attribution risk.
#
# Defense-in-depth: AGENT_HUB_REVIEWER_ROLE_LOCK=1 is set ONLY for
# role=reviewer spawns (see applyReviewerRoleLock in
# server/spawn-github-credentials.ts). The role lock is stricter — it
# blocks create / merge / close / ready (in addition to review) so that
# a future change accidentally leaking a token into the reviewer spawn
# env still cannot forge commits or open PRs. The lock is enforced by
# `_reviewer_role_locked` (sourced from _common.sh) called at the top
# of each blocked subcommand, plus the gh_api allowlist in _common.sh.
# Comment / view / diff / list / status / checks / checkout remain
# available under the role lock because PR conversation comments are a
# legitimate review activity and reads carry no attribution risk.
# ---------------------------------------------------------------------------
_reviewer_locked() {
  if [[ "${AGENT_HUB_REVIEWER_LOCK:-}" == "1" ]]; then
    cat >&2 <<LOCKED
error: gh-pr.sh review is disabled in Agent Hub spawns.

All formal PR reviews must go through the App-mediated endpoint so they
land under the GitHub App identity instead of a personal credential. Use:

  curl -sS -X POST "\$AGENT_HUB_URL/api/pr/review" \\
    -H "X-API-Key: \$AGENT_HUB_API_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{"prUrl":"<pr url>","event":"APPROVE|REQUEST_CHANGES","body":"<markdown>"}'

(Other subcommands — comment/merge/close/ready/view/diff/list — remain available.)
LOCKED
    exit 2
  fi
}

# Block `gh pr create` when the spawn carries an App installation token
# (`ghs_…`) or no user OAuth — those would attribute the PR to the bot.
# Per-user OAuth (`gho_` / `ghp_`) is allowed so ship/create-ticket-and-pr
# skill turns can open PRs under the session owner. See mcsteen/surveytracker
# PR #682 for the bot-attribution repro.
_pr_create_locked() {
  if [[ "${AGENT_HUB_REVIEWER_LOCK:-}" != "1" ]]; then
    return 0
  fi
  local tok="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [[ "$tok" == gho_* || "$tok" == ghp_* ]]; then
    return 0
  fi
  cat >&2 <<LOCKED
error: gh-pr.sh create is disabled in Agent Hub spawns without per-user OAuth.

Spawns with a GitHub App installation token (ghs_…) or no token must not
run \`gh pr create\` — GitHub attributes the PR to \`agent-hub-reviewer[bot]\`
instead of the human session owner.

What to do instead:
  - For ship workflows: use the loaded create-ticket-and-pr skill (POST
    /api/sessions/:id/ship injects it with the session owner's OAuth).
  - Mid-turn on autonomous dispatch: commit and push only; let session-end
    auto-ship open the PR under the owner's credential.

Other subcommands — comment / view / diff / list — remain available.
LOCKED
  exit 2
}

# ---------------------------------------------------------------------------
# pr create
# ---------------------------------------------------------------------------
cmd_create() {
  _reviewer_role_locked "gh-pr.sh create"
  _pr_create_locked
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
#
# Under reviewer lock with no GH token, route through the Agent Hub PR
# proxy (`/api/pr/data`) instead of `gh pr view` — the spawn has no
# credentials by design (`applyReviewerSpawnIsolation`).
# ---------------------------------------------------------------------------
cmd_view() {
  [[ $# -lt 1 ]] && gh_die "pr view <number|URL>"

  local target="$1"

  if _hub_pr_proxy_should_use; then
    local number="$target"
    # If the caller passed a full URL, extract the PR number for the proxy.
    if [[ "$target" =~ /pull/([0-9]+) ]]; then
      number="${BASH_REMATCH[1]}"
    elif ! [[ "$target" =~ ^[0-9]+$ ]]; then
      gh_die "pr view: under reviewer lock, pass a PR number or full PR URL"
    fi
    hub_pr_proxy_data "$number"
    return $?
  fi

  require_gh_token

  if [[ "$target" =~ ^https?:// ]]; then
    gh pr view "$target"
  else
    gh pr view "$target" --json number,title,author,state,body,headRefName,baseRefName,url,mergeable,reviewDecision,checks \
      --jq '"PR #\(.number): \(.title)\nAuthor : \(.author.login)\nState  : \(.state)\nBase   : \(.baseRefName) ← \(.headRefName)\nURL    : \(.url)\nMergeable: \(.mergeable)\nReviews  : \(.reviewDecision // "none")\n\nBody:\n\(.body)"'
  fi
}

# ---------------------------------------------------------------------------
# pr diff
#
# Under reviewer lock with no GH token, route through the Agent Hub PR
# proxy (`/api/pr/diff`).
# ---------------------------------------------------------------------------
cmd_diff() {
  [[ $# -lt 1 ]] && gh_die "pr diff <number>"

  local target="$1"

  if _hub_pr_proxy_should_use; then
    local number="$target"
    if [[ "$target" =~ /pull/([0-9]+) ]]; then
      number="${BASH_REMATCH[1]}"
    elif ! [[ "$target" =~ ^[0-9]+$ ]]; then
      gh_die "pr diff: under reviewer lock, pass a PR number or full PR URL"
    fi
    hub_pr_proxy_diff "$number"
    return $?
  fi

  require_gh_token
  gh pr diff "$1"
}

# ---------------------------------------------------------------------------
# pr files — list changed files for a PR
#
# New subcommand for the reviewer pipeline: returns the JSON file list from
# `/api/pr/files` (paginated server-side, capped at 3000). Outside reviewer
# lock, falls back to `gh pr view --json files`.
# ---------------------------------------------------------------------------
cmd_files() {
  [[ $# -lt 1 ]] && gh_die "pr files <number>"
  local target="$1"

  if _hub_pr_proxy_should_use; then
    local number="$target"
    if [[ "$target" =~ /pull/([0-9]+) ]]; then
      number="${BASH_REMATCH[1]}"
    elif ! [[ "$target" =~ ^[0-9]+$ ]]; then
      gh_die "pr files: under reviewer lock, pass a PR number or full PR URL"
    fi
    hub_pr_proxy_files "$number"
    return $?
  fi

  require_gh_token
  gh pr view "$target" --json files
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
  _reviewer_locked review
  [[ $# -lt 1 ]] && gh_die "pr review <number> --approve [--body <text>] | --request-changes --body <text>"

  local number="$1"; shift

  local approve=false req_changes=false comment=false body=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --approve)          approve=true;      shift   ;;
      --request-changes)  req_changes=true;  shift   ;;
      --comment)
        gh_die "pr review --comment is not supported: COMMENT formal reviews do not count toward required approval. Use --approve (non-blocking notes in --body) or --request-changes. In reviewer spawns use POST /api/pr/review with event APPROVE or REQUEST_CHANGES."
        ;;
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
  else
    gh_die "pr review: specify --approve or --request-changes"
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
  _reviewer_role_locked "gh-pr.sh merge"
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
  _reviewer_role_locked "gh-pr.sh ready"
  [[ $# -lt 1 ]] && gh_die "pr ready <number>"
  require_gh_token
  gh pr ready "$1"
  echo "PR #$1 is now ready for review"
}

# ---------------------------------------------------------------------------
# pr close
# ---------------------------------------------------------------------------
cmd_close() {
  _reviewer_role_locked "gh-pr.sh close"
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
  files)    cmd_files    "$@" ;;
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
  files     <number>
  checkout  <number>
  review    <number> --approve [--body <text>] | --request-changes --body <text>
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
