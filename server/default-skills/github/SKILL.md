---
name: github
description: >-
  Bash / gh CLI workflows against GitHub (repos, PRs, issues, releases,
  Actions, gists, and Projects v2) using the caller's PAT or host gh auth.
  TRIGGER when: the user mentions "GitHub", references a PR/issue/repo URL
  (github.com/…), uses a repo slug (owner/repo), says "gh", or asks to
  open/review/merge/comment/list/close/label/release anything on GitHub.
  Also trigger when the user mentions "pull request", "PR", "GitHub Actions",
  "workflow run", "GitHub Projects", or "gist". DO NOT TRIGGER on: generic
  git commands (commit, push, pull, branch, rebase) — those belong to the
  engine's own tools; Jira/Linear/Asana issue trackers; GitLab/Bitbucket;
  or any mention of "git" that is clearly about local VCS operations with no
  GitHub hostname or slug in view.
category: integration
version: 1.0.0
keep-coding-instructions: true
credentials:
  - name: GH_TOKEN
    label: GitHub personal access token
    description: >-
      Fine-grained or classic PAT with at least repo scope. Stored encrypted
      in Agent Hub Settings — never paste into chat.
      See https://github.com/settings/tokens
    required: false
    type: secret
    docs_url: https://github.com/settings/tokens
---

# GitHub

Use this skill when work targets **GitHub** — repos, pull requests, issues,
releases, Actions/workflow runs, gists, or GitHub Projects (v2).

## Prerequisites

### Token resolution (automatic)
When `GH_TOKEN` is stored under **Settings → Skills → Credentials → GitHub**,
Agent Hub injects it into the agent shell automatically. No extra setup needed.

If `GH_TOKEN` is not set, the scripts fall back to:
1. `GITHUB_TOKEN` env var (GitHub Actions built-in, or host export)
2. `gh auth status` — the host's existing `gh` login

Scripts exit with a clear error if none of the above resolves.

### `gh` CLI
All wrapper scripts require the **GitHub CLI** (`gh`) on `$PATH`.

- macOS: `brew install gh`
- Linux: https://cli.github.com/
- Verify: `gh --version`

If the CLI is missing, install it before calling any `scripts/gh-*.sh` wrapper.

## Safety Model — Read-default, Write-on-confirm

**Read operations** (list, view, diff, status) run immediately.  
**Write operations** (create PR, merge, comment, approve, close, label, release)
should be confirmed with the user first, unless the user already said "go ahead",
"do it", "create it", "merge it", etc.

Show a brief summary of what will change before running any mutation.

> **This is a behavioural contract on the agent, not a runtime guard.**
> The scripts execute mutations immediately when invoked. The agent must ask first.

## Quick Reference

```bash
# Pull requests
scripts/gh-pr.sh create  --base main --title "feat: …" [--draft] [--body "…"]
scripts/gh-pr.sh list    [--state open|closed|merged] [--limit 20]
scripts/gh-pr.sh view    <number|URL>
scripts/gh-pr.sh diff    <number>
scripts/gh-pr.sh checkout <number>
scripts/gh-pr.sh review  <number> --approve
scripts/gh-pr.sh review  <number> --request-changes --body "…"
scripts/gh-pr.sh comment <number> --body "…"
scripts/gh-pr.sh merge   <number> [--squash|--rebase|--merge] [--auto]
scripts/gh-pr.sh ready   <number>          # convert draft → ready
scripts/gh-pr.sh status                    # PRs touching your branches

# Issues
scripts/gh-issue.sh create  --title "Bug: …" [--body "…"] [--label bug]
scripts/gh-issue.sh list    [--state open|closed|all] [--label bug] [--limit 20]
scripts/gh-issue.sh view    <number|URL>
scripts/gh-issue.sh comment <number> --body "…"
scripts/gh-issue.sh close   <number>
scripts/gh-issue.sh label   <number> --add bug,enhancement
scripts/gh-issue.sh search  "<query>"

# Releases & gists
scripts/gh-release.sh create  --tag v1.0.0 [--title "…"] [--notes "…"] [--draft]
scripts/gh-release.sh list    [--limit 10]
scripts/gh-release.sh view    <tag>
scripts/gh-release.sh download <tag> [--dir ./dist]
scripts/gh-release.sh gist-create  <file> [--desc "…"] [--public]
scripts/gh-release.sh gist-list    [--limit 10]

# Workflow runs (Actions)
scripts/gh-release.sh run-list    [--workflow ci.yml] [--limit 10]
scripts/gh-release.sh run-view    <run-id>
scripts/gh-release.sh run-logs    <run-id>
scripts/gh-release.sh run-rerun   <run-id>
scripts/gh-release.sh run-cancel  <run-id>

# Raw API escape hatch
gh api repos/{owner}/{repo}/issues          # REST GET
gh api graphql -f query='{ viewer { login }}'
```

## Full Reference

- **[references/auth.md](references/auth.md)** — PAT vs OAuth vs GitHub App;
  per-user credential resolution; fine-grained vs classic PATs; Reviewer App
  boundary
- **[references/cli-recipes.md](references/cli-recipes.md)** — common end-to-end
  flows: open PR, review + merge, issue triage, release cut, workflow rerun
- **[references/api-escape-hatch.md](references/api-escape-hatch.md)** — when
  to drop to `gh api`; REST vs GraphQL; pagination; rate limits
## Guardrails

- **Never log or surface the token** in chat, daily notes, card descriptions,
  or commit messages.
- Honour repository visibility: do not operate on private repos unless the
  resolved token has the required scope.
- Respect branch-protection rules: do not force-push or bypass required reviews.
- The **Reviewer GitHub App** already wired into Agent Hub is a separate
  credential used exclusively for automated PR reviews — do **not** reuse it
  for ad-hoc skill calls. See [references/auth.md](references/auth.md).
- Rate limits: REST = 5 000 req/hr authenticated; GraphQL = 5 000 points/hr.
  The `gh_api` wrapper in `_common.sh` is a thin passthrough — it does **not**
  automatically retry on `403` or secondary rate-limits. If you hit a limit,
  back off manually (see [references/api-escape-hatch.md](references/api-escape-hatch.md)
  for a retry loop example).
