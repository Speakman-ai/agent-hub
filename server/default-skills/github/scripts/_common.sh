#!/usr/bin/env bash
# scripts/_common.sh — shared auth + utility helpers for GitHub skill scripts.
# Source, don't exec:
#
#     DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     source "$DIR/_common.sh"
#
# Exposes:
#   require_gh_token        → asserts a token is available or exits 2
#   gh_api PATH [ARGS…]     → gh api wrapper; prints JSON to stdout
#   gh_die MESSAGE          → print to stderr + exit 1
#   GITHUB_REPO             → resolved owner/repo (from GH_REPO or git remote)

set -euo pipefail

# ---------------------------------------------------------------------------
# Token resolution
#
# Priority order (matches server/github-skill-auth-resolve.ts):
#   1. GH_TOKEN  — Agent Hub per-user credential store injects this
#   2. GITHUB_TOKEN — GitHub Actions built-in, or host export
#   3. gh auth status — host's existing gh login (no env var needed)
# ---------------------------------------------------------------------------

# Normalise: if GH_TOKEN is set but GITHUB_TOKEN is not, export it so that gh
# and curl both pick it up automatically.
if [[ -n "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  export GITHUB_TOKEN="$GH_TOKEN"
fi

require_gh_token() {
  # If either env var is set we're good — gh honours GITHUB_TOKEN automatically.
  if [[ -n "${GITHUB_TOKEN:-}" || -n "${GH_TOKEN:-}" ]]; then
    return 0
  fi

  # Fall back to a live gh auth check (slow, but only runs once per script).
  if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    return 0
  fi

  cat >&2 <<'HELP'
error: no GitHub token found.

To fix (pick one):
  1. Agent Hub → Settings → Skills → Credentials → GitHub → GH_TOKEN
     Paste a fine-grained or classic PAT (repo scope).
     Agent Hub injects it automatically next session.

  2. export GITHUB_TOKEN="ghp_..." in your shell before starting the agent.

  3. Run `gh auth login` to sign in via the browser.

Token scopes needed:
  - repo (read+write access to repos, PRs, issues)
  - workflow (to trigger/cancel workflow runs)
  - gist (optional, only needed for gist commands)

See: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
HELP
  exit 2
}

# ---------------------------------------------------------------------------
# require_gh_cli — verify gh is installed
# ---------------------------------------------------------------------------
require_gh_cli() {
  if ! command -v gh &>/dev/null; then
    cat >&2 <<'HELP'
error: gh CLI not found on PATH.

Install it first:
  macOS:  brew install gh
  Linux:  https://cli.github.com/
  Windows: winget install GitHub.cli

Then re-run this script.
HELP
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# gh_die MESSAGE — print to stderr + exit 1
# ---------------------------------------------------------------------------
gh_die() {
  echo "error: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# resolve_repo — set GITHUB_REPO to owner/repo if not already in env
#
# Resolution order:
#   1. GH_REPO env var (e.g. GH_REPO=owner/repo)
#   2. `gh repo view --json nameWithOwner` (reads from current git remote)
#   3. Git remote URL parse (fallback when gh fails)
# ---------------------------------------------------------------------------
resolve_repo() {
  if [[ -n "${GH_REPO:-}" ]]; then
    GITHUB_REPO="$GH_REPO"
    return 0
  fi

  require_gh_cli

  local name_with_owner
  name_with_owner=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)

  if [[ -n "$name_with_owner" ]]; then
    GITHUB_REPO="$name_with_owner"
    return 0
  fi

  # Fallback: parse remote URL manually
  local remote_url
  remote_url=$(git remote get-url origin 2>/dev/null || true)
  if [[ -n "$remote_url" ]]; then
    # Strip protocol prefix, .git suffix, and isolate owner/repo
    GITHUB_REPO=$(echo "$remote_url" \
      | sed -E 's|.*github\.com[:/]||; s|\.git$||')
    if [[ "$GITHUB_REPO" == */* ]]; then
      return 0
    fi
  fi

  gh_die "cannot determine owner/repo. Set GH_REPO=owner/repo or run from inside a git repo with a GitHub remote."
}

# ---------------------------------------------------------------------------
# gh_api PATH [EXTRA_ARGS…]
#
# Thin wrapper around `gh api` that:
# - Prepends the REST v3 base path if the path starts with /
# - Passes --paginate when the caller passes --paginate
# - Forwards all extra flags to gh api
#
# Examples:
#   gh_api /repos/owner/repo/issues
#   gh_api /repos/owner/repo/pulls --paginate
#   gh_api graphql -f query='…'
# ---------------------------------------------------------------------------
gh_api() {
  require_gh_cli
  require_gh_token
  gh api "$@"
}

# ---------------------------------------------------------------------------
# pp_json — pretty-print JSON from stdin
# ---------------------------------------------------------------------------
pp_json() {
  python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))" 2>/dev/null \
    || cat   # if python3 is absent, pass through raw
}

# ---------------------------------------------------------------------------
# jq_required — assert jq is available (used by scripts that need heavy filtering)
# ---------------------------------------------------------------------------
jq_or_python() {
  # Prefer jq if available; otherwise fall back to python3 -m json.tool
  if command -v jq &>/dev/null; then
    jq "$@"
  else
    # simple passthrough for basic uses — callers requiring real filtering
    # should detect the absence of jq and warn.
    python3 -m json.tool
  fi
}

# ---------------------------------------------------------------------------
# _require_arg FLAG VALUE — die if value is empty
# ---------------------------------------------------------------------------
_require_arg() {
  local flag="$1" value="$2"
  [[ -z "$value" ]] && gh_die "$flag is required"
}

# Run prerequisite checks immediately when sourced so wrappers don't have to
# repeat them.
#
# NOTE: `require_gh_cli` hard-exits if `gh` is not on PATH, which means ANY
# script that sources _common.sh will fail fast if the CLI is missing — even
# if it only needs utility helpers like `pp_json` or `_require_arg`. This is
# intentional for the current callers (all three wrapper scripts need `gh`),
# but keep this in mind if you add a helper that does not depend on the CLI.
require_gh_cli
