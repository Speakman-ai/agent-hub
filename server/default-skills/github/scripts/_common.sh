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

  # AGENT_HUB_REVIEWER_LOCK=1: the spawn env was deliberately scrubbed of
  # token vars (`applyReviewerSpawnIsolation` in
  # server/spawn-github-credentials.ts). Falling back to `gh auth status`
  # here would normally read GH_CONFIG_DIR (already rerouted to a Hub
  # empty dir) and return non-zero — but if any host-level path bypasses
  # that override (a different `gh` on PATH, a future gh that reads a
  # fallback config, etc.), the fallback can silently authenticate as
  # the host operator. That is exactly the leak that produced
  # webapp PR #612 (head `review/pr-609`, opened as the host
  # user `speakmanra`). Hard-fail under the lock so there is no third
  # path: env token → ok; lock set → fail; otherwise → fall back to host gh.
  if [[ "${AGENT_HUB_REVIEWER_LOCK:-}" == "1" ]]; then
    cat >&2 <<'HELP'
error: AGENT_HUB_REVIEWER_LOCK=1 and no GitHub token was injected.

This spawn was isolated from host GitHub credentials by Agent Hub. Reviewer
agents are in-session advisors: emit your APPROVE / REQUEST_CHANGES verdict in
session output — Agent Hub no longer posts formal reviews to GitHub. PR reads
are served by the Agent Hub PR proxy (`/api/pr/{data,diff,files}`) without
handing a token to the spawn.

Other write actions (`gh pr create`, `gh pr comment`, `git push`) require a
per-user OAuth/PAT token, which Agent Hub injects automatically when one is
configured. If you expected a token here, sign in via Settings → GitHub or
check the operator's `config.json` (`botGithubToken` for reviewer-role agents).

This script will not fall back to host `gh auth status` while the lock is set.
See server/default-skills/github/scripts/_common.sh.
HELP
    exit 2
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
# Agent Hub project repo guard
#
# Agent Hub spawns carry PROJECT_ID + AGENT_HUB_URL + AGENT_HUB_API_KEY. When a
# project is linked to GitHub, a dev session may only create a PR in that
# project's configured repo. Cross-repo work should be tracked as a ticket in
# the target project, then shipped by that project's own session.
# ---------------------------------------------------------------------------
_normalize_github_repo_slug() {
  printf '%s' "$1" \
    | sed -E 's|^[[:space:]]+||; s|[[:space:]]+$||; s|.*github\.com[:/]||; s|\.git$||; s|/+$||' \
    | tr '[:upper:]' '[:lower:]'
}

_github_repo_from_remote_url() {
  local remote_url="$1"
  case "$remote_url" in
    *github.com[:/]*)
      ;;
    *)
      return 1
      ;;
  esac
  local stripped
  stripped=$(printf '%s' "$remote_url" \
    | sed -E 's|^[[:space:]]+||; s|[[:space:]]+$||; s|.*github\.com[:/]||; s|\.git$||; s|/+$||')
  if [[ "$stripped" == */* ]]; then
    printf '%s' "$stripped"
    return 0
  fi
  return 1
}

_agent_hub_project_github_repo() {
  [[ -n "${PROJECT_ID:-}" && -n "${AGENT_HUB_URL:-}" && -n "${AGENT_HUB_API_KEY:-}" ]] || return 1

  local resp
  resp=$(curl -fsS -m 12 -H "x-api-key: $AGENT_HUB_API_KEY" \
    "${AGENT_HUB_URL%/}/api/projects/${PROJECT_ID}" 2>/dev/null) || return 1

  printf '%s' "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('githubRepo') or ''; print(v if isinstance(v,str) else '')" 2>/dev/null
}

_agent_hub_target_github_repo() {
  if [[ -n "${GH_REPO:-}" && "$GH_REPO" == */* ]]; then
    printf '%s' "$GH_REPO"
    return 0
  fi

  local remote_url
  remote_url=$(git remote get-url origin 2>/dev/null || true)
  if [[ -n "$remote_url" ]] && _github_repo_from_remote_url "$remote_url"; then
    return 0
  fi

  local name_with_owner
  name_with_owner=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
  if [[ -n "$name_with_owner" && "$name_with_owner" == */* ]]; then
    printf '%s' "$name_with_owner"
    return 0
  fi

  return 1
}

agent_hub_guard_pr_create_repo_scope() {
  [[ -n "${PROJECT_ID:-}" && -n "${AGENT_HUB_URL:-}" && -n "${AGENT_HUB_API_KEY:-}" ]] || return 0

  local expected target expected_norm target_norm
  if ! expected=$(_agent_hub_project_github_repo); then
    cat >&2 <<GUARD
error: gh-pr.sh create is blocked: could not verify the Agent Hub project repo.

This spawn has Agent Hub project context for "$PROJECT_ID", but the GitHub
skill could not read the project's configured githubRepo from Agent Hub. To
avoid opening a pull request in the wrong repository, direct PR creation is
blocked. Retry after Agent Hub project lookup is healthy, or create an Agent
Hub ticket in the target project if the work belongs elsewhere.
GUARD
    exit 2
  fi
  expected_norm=$(_normalize_github_repo_slug "$expected")
  [[ -n "$expected_norm" ]] || return 0

  target=$(_agent_hub_target_github_repo || true)
  target_norm=$(_normalize_github_repo_slug "$target")
  if [[ -z "$target_norm" ]]; then
    cat >&2 <<GUARD
error: gh-pr.sh create is blocked: cannot determine the target GitHub repo.

Agent Hub project "$PROJECT_ID" is configured for GitHub repo "$expected".
Do not open pull requests from this project session unless the current repo
matches that configured project repo. If this work belongs in another repo,
create an Agent Hub ticket in that repo's project and let that project ship it.
GUARD
    exit 2
  fi

  if [[ "$target_norm" != "$expected_norm" ]]; then
    cat >&2 <<GUARD
error: gh-pr.sh create is blocked: cross-repo PR creation is not allowed.

Agent Hub project "$PROJECT_ID" is configured for GitHub repo "$expected",
but this command would create a pull request in "$target".

Do not open pull requests in another repo from this project session. Create an
Agent Hub ticket in the target project instead, then let that project/session
own its own PR.
GUARD
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# Reviewer-role lock — defense-in-depth write denylist for role=reviewer spawns
#
# Two distinct env markers govern the github skill's write surface:
#
#   AGENT_HUB_REVIEWER_LOCK=1
#     Universal (set on every spawn by applyReviewerSpawnIsolation). Used by
#     require_gh_token above to hard-fail rather than fall back to host
#     `gh auth status`. Formal `gh pr review` is disabled outright in
#     gh-pr.sh::cmd_review regardless of this flag.
#
#   AGENT_HUB_REVIEWER_ROLE_LOCK=1
#     Set ONLY when agent.role === 'reviewer' (applyReviewerRoleLock). The
#     broader structural backstop: assumes a future change accidentally
#     leaks a GitHub token into the reviewer spawn env, and makes sure the
#     spawn still cannot use it to forge commits or open PRs (the failure
#     mode documented in webapp PR #622).
#
# This file owns the role-lock enforcement helpers; gh-pr.sh calls
# `_reviewer_role_locked` directly for subcommand-level denials, and
# `gh_api` below applies the allowlist on REST writes.
#
# Allowed write surfaces under AGENT_HUB_REVIEWER_ROLE_LOCK=1:
#
#   POST /repos/<owner>/<repo>/issues/<n>/comments  (PR/issue conversation)
#
# Everything else with a write method (POST/PUT/PATCH/DELETE) is denied —
# including POST .../pulls/<n>/reviews, since formal reviews are no longer
# posted to GitHub. `gh api graphql` is denied wholesale (mutation bodies
# are free-form and cannot be allowlisted by path).
# ---------------------------------------------------------------------------
_reviewer_role_locked() {
  local what="${1:-write}"
  if [[ "${AGENT_HUB_REVIEWER_ROLE_LOCK:-}" == "1" ]]; then
    cat >&2 <<LOCKED
error: '$what' is forbidden in reviewer-role spawns.

AGENT_HUB_REVIEWER_ROLE_LOCK=1 blocks direct GitHub write operations from
this spawn as defense-in-depth. The reviewer is an in-session advisor:
emit your APPROVE / REQUEST_CHANGES verdict in session output — Agent Hub
no longer posts formal reviews to GitHub.

Direct invocations of \`gh pr review / create / merge / close / ready / edit\`
and arbitrary write \`gh api\` calls are blocked structurally — even if a
token is reachable in this spawn — to prevent reviewer identity leaks of
the kind documented in acme/webapp PR #622. PR conversation
comments (POST .../issues/<n>/comments) remain available.

If you legitimately need to create commits or open PRs, your agent must
not be configured with role=reviewer.
LOCKED
    exit 2
  fi
}

# Enforce the role-lock write allowlist on a `gh api` invocation. Parses
# the args for `--method` / `-X` (default GET when absent) and the target
# path (first positional). Allowed under the role lock:
#
#   GET / HEAD  (any path)         — reads are unconstrained
#   POST repos/<owner>/<repo>/issues/<n>/comments
#
# Everything else exits 2 with a loud message — including
# POST .../pulls/<n>/reviews, since formal reviews are no longer posted to
# GitHub. `graphql` paths exit unconditionally when the method is not GET
# (graphql writes have free-form bodies and can't be path-allowlisted).
_check_gh_api_reviewer_role_lock() {
  if [[ "${AGENT_HUB_REVIEWER_ROLE_LOCK:-}" != "1" ]]; then
    return 0
  fi

  local method="GET"
  local path=""
  local expect_method_value=0
  local arg
  # Uppercase via `tr` rather than bash 4's `${var^^}`: these scripts run
  # under `#!/usr/bin/env bash`, which is bash 3.2 on stock macOS, where
  # `${var^^}` raises "bad substitution" and would break this security check.
  for arg in "$@"; do
    if (( expect_method_value == 1 )); then
      method=$(printf '%s' "$arg" | tr '[:lower:]' '[:upper:]')
      expect_method_value=0
      continue
    fi
    case "$arg" in
      --method=*)
        method=$(printf '%s' "${arg#--method=}" | tr '[:lower:]' '[:upper:]')
        ;;
      -X=*)
        method=$(printf '%s' "${arg#-X=}" | tr '[:lower:]' '[:upper:]')
        ;;
      --method|-X)
        expect_method_value=1
        ;;
      -*)
        # Other flag — ignore.
        ;;
      *)
        if [[ -z "$path" ]]; then
          path="$arg"
        fi
        ;;
    esac
  done

  # graphql endpoint: refused wholesale under the role lock. `gh api
  # graphql` defaults the HTTP method to POST regardless of whether the
  # query body is a read query or a mutation, and the JSON body is
  # free-form — we cannot allowlist mutations by URL path. Reviewer
  # agents that need GitHub data should call the REST endpoints
  # (`gh api /repos/...`) which the path allowlist below can constrain.
  if [[ "$path" == "graphql" ]]; then
    _reviewer_role_locked "gh api graphql"
    return 0
  fi

  case "$method" in
    GET|HEAD|"") return 0 ;;
  esac

  local norm="${path#/}"
  if [[ "$norm" =~ ^repos/[^/]+/[^/]+/issues/[^/]+/comments/?$ ]]; then
    return 0
  fi

  cat >&2 <<DENIED
error: write \`gh api $method '$path'\` is forbidden in reviewer-role spawns.

AGENT_HUB_REVIEWER_ROLE_LOCK=1 restricts write methods (POST/PUT/PATCH/DELETE)
to PR/issue conversation only:

  POST /repos/<owner>/<repo>/issues/<n>/comments

Formal reviews are not posted to GitHub — the reviewer is an in-session advisor
and emits its verdict in session output. For other writes (creating commits,
opening or editing PRs, mutating labels, graphql mutations, etc.) the agent
must not be configured with role=reviewer; use a dev/lead/author spawn instead.

This guard is structural defense-in-depth: even if a future change leaks a
GitHub token into the reviewer spawn env, the credential cannot be used to
forge commits or open PRs (acme/webapp PR #622 reference case).
DENIED
  exit 2
}

# ---------------------------------------------------------------------------
# gh_api PATH [EXTRA_ARGS…]
#
# Thin wrapper around `gh api` that:
# - Prepends the REST v3 base path if the path starts with /
# - Passes --paginate when the caller passes --paginate
# - Forwards all extra flags to gh api
# - Enforces the reviewer-role-lock write allowlist when
#   AGENT_HUB_REVIEWER_ROLE_LOCK=1 (no-op for non-reviewer spawns).
#
# Examples:
#   gh_api /repos/owner/repo/issues
#   gh_api /repos/owner/repo/pulls --paginate
#   gh_api graphql -f query='…'
# ---------------------------------------------------------------------------
gh_api() {
  require_gh_cli
  require_gh_token
  _check_gh_api_reviewer_role_lock "$@"
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
  return 0
}

# ---------------------------------------------------------------------------
# Agent Hub PR read-proxy
#
# When the spawn is under `AGENT_HUB_REVIEWER_LOCK=1` and has no GitHub
# token, `gh pr view` / `gh pr diff` cannot authenticate. The server-side
# `/api/pr/{data,diff,files}` endpoints proxy those reads through the
# session owner's GitHub OAuth/PAT (resolved server-side) without ever
# handing a token to the spawn. These helpers route through that proxy.
#
# `_hub_pr_proxy_should_use` — true when:
#   - AGENT_HUB_REVIEWER_LOCK=1 (reviewer spawn)
#   - no GH token in env
#   - AGENT_HUB_URL + AGENT_HUB_API_KEY are present
#
# `_hub_pr_proxy_resolve_repo` — sets HUB_PR_OWNER / HUB_PR_REPO from
# `$GH_REPO`, then `git remote get-url origin`. Avoids `gh repo view`
# because that itself needs auth.
#
# `_hub_pr_proxy_diff NUMBER` / `_hub_pr_proxy_data NUMBER`
# / `_hub_pr_proxy_files NUMBER` — print the response body to stdout,
# exit non-zero with a helpful error on failure.
# ---------------------------------------------------------------------------
_hub_pr_proxy_should_use() {
  [[ "${AGENT_HUB_REVIEWER_LOCK:-}" == "1" ]] || return 1
  [[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]] || return 1
  [[ -n "${AGENT_HUB_URL:-}" && -n "${AGENT_HUB_API_KEY:-}" ]] || return 1
  return 0
}

_hub_pr_proxy_resolve_repo() {
  HUB_PR_OWNER=""
  HUB_PR_REPO=""

  if [[ -n "${GH_REPO:-}" ]] && [[ "$GH_REPO" == */* ]]; then
    HUB_PR_OWNER="${GH_REPO%/*}"
    HUB_PR_REPO="${GH_REPO##*/}"
    return 0
  fi

  local remote_url
  remote_url=$(git remote get-url origin 2>/dev/null || true)
  if [[ -n "$remote_url" ]]; then
    local stripped
    stripped=$(echo "$remote_url" | sed -E 's|.*github\.com[:/]||; s|\.git$||')
    if [[ "$stripped" == */* ]]; then
      HUB_PR_OWNER="${stripped%%/*}"
      HUB_PR_REPO="${stripped#*/}"
      # Tolerate sub-paths beyond owner/repo (shouldn't happen for github
      # but be defensive about trailing slashes / paths).
      HUB_PR_REPO="${HUB_PR_REPO%%/*}"
      return 0
    fi
  fi

  cat >&2 <<HELP
error: cannot resolve owner/repo for PR proxy request.

The reviewer spawn is isolated from host \`gh\` credentials and is falling
back to the Agent Hub PR proxy at \$AGENT_HUB_URL/api/pr/*. The proxy needs
to know which repo the PR belongs to. Set one of:

  GH_REPO=owner/repo
  # or run from inside a git worktree whose 'origin' is a github.com remote
HELP
  return 2
}

_hub_pr_proxy_request() {
  # $1 = endpoint suffix (data | diff | files)
  # $2 = pr number
  local endpoint="$1" number="$2"
  _hub_pr_proxy_resolve_repo || return $?

  local url="${AGENT_HUB_URL%/}/api/pr/${endpoint}?owner=${HUB_PR_OWNER}&repo=${HUB_PR_REPO}&number=${number}"
  local tmp_body tmp_status
  tmp_body=$(mktemp)
  tmp_status=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$tmp_body' '$tmp_status'" RETURN

  local http_code
  http_code=$(curl -sS \
    -o "$tmp_body" \
    -w '%{http_code}' \
    -H "X-API-Key: ${AGENT_HUB_API_KEY}" \
    -H 'Accept: */*' \
    --max-time 30 \
    "$url" 2>"$tmp_status") || {
    cat >&2 <<HELP
error: PR proxy request to \$AGENT_HUB_URL/api/pr/${endpoint} failed.

curl error output:
$(cat "$tmp_status")

URL: $url
HELP
    return 1
  }

  if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
    cat "$tmp_body"
    return 0
  fi

  cat >&2 <<HELP
error: PR proxy returned HTTP ${http_code} for /api/pr/${endpoint}.

URL: $url
Body (first 400 bytes):
$(head -c 400 "$tmp_body")

The server's response body is above. Common causes:
  - The session owner's GitHub account lacks access to repo owner "${HUB_PR_OWNER}"
  - PR #${number} does not exist or is in a private repo without coverage
  - The session owner has not connected GitHub in Settings → GitHub
HELP
  return 1
}

# Public helpers for the wrapper scripts.
hub_pr_proxy_diff()  { _hub_pr_proxy_request diff  "$1"; }
hub_pr_proxy_data()  { _hub_pr_proxy_request data  "$1"; }
hub_pr_proxy_files() { _hub_pr_proxy_request files "$1"; }

# Run prerequisite checks immediately when sourced so wrappers don't have to
# repeat them.
#
# NOTE: `require_gh_cli` hard-exits if `gh` is not on PATH, which means ANY
# script that sources _common.sh will fail fast if the CLI is missing — even
# if it only needs utility helpers like `pp_json` or `_require_arg`. This is
# intentional for the current callers (all three wrapper scripts need `gh`),
# but keep this in mind if you add a helper that does not depend on the CLI.
require_gh_cli
