# CLI Recipes — Common End-to-End GitHub Flows

Back to [SKILL.md](../SKILL.md).

## Contents

- [Open a pull request](#open-a-pull-request)
- [Review and merge a pull request](#review-and-merge-a-pull-request)
- [Issue triage](#issue-triage)
- [Cut a release](#cut-a-release)
- [Investigate a failing workflow run](#investigate-a-failing-workflow-run)
- [Clone and fork a repo](#clone-and-fork-a-repo)
- [GitHub Projects v2 (via gh api)](#github-projects-v2-via-gh-api)

---

## Open a pull request

```bash
# 1. Make sure you're on a feature branch with commits
git status

# 2. Push to origin
git push -u origin HEAD

# 3. Create the PR
scripts/gh-pr.sh create \
  --title "feat: add dark mode" \
  --base main \
  --body "Adds a toggle in Settings. Closes #42." \
  --reviewer octocat \
  --label enhancement

# Start as draft while CI is running
scripts/gh-pr.sh create \
  --title "wip: dark mode" \
  --base main \
  --draft

# Later, promote draft to ready
scripts/gh-pr.sh ready 57
```

---

## Review and merge a pull request

```bash
# See what's open
scripts/gh-pr.sh list --state open --limit 20

# Read the PR and its diff
scripts/gh-pr.sh view 57
scripts/gh-pr.sh diff 57

# Check CI
scripts/gh-pr.sh checks 57

# Approve (simple, no comment)
scripts/gh-pr.sh review 57 --approve

# Approve with a note
scripts/gh-pr.sh review 57 --approve --body "LGTM — great work!"

# Request changes
scripts/gh-pr.sh review 57 --request-changes \
  --body "Please add unit tests for the toggle component."

# Leave a review comment (no approval/rejection)
scripts/gh-pr.sh review 57 --comment \
  --body "Nit: rename 'darkMode' → 'theme' for consistency."

# Post a regular comment (not a review)
scripts/gh-pr.sh comment 57 --body "Rebased on main — ready for another look."

# Merge (squash, clean up branch) — squash is the default if no method given
scripts/gh-pr.sh merge 57 --squash --delete-branch

# Merge with rebase
scripts/gh-pr.sh merge 57 --rebase

# Enqueue for auto-merge (requires merge queues to be enabled on the repo;
# --squash is explicit here because gh requires a method with --auto)
scripts/gh-pr.sh merge 57 --squash --auto

# Close without merging
scripts/gh-pr.sh close 57
```

---

## Issue triage

```bash
# List open bugs
scripts/gh-issue.sh list --state open --label bug --limit 25

# Search for issues about a topic
scripts/gh-issue.sh search "login crash" --limit 10

# View a specific issue
scripts/gh-issue.sh view 42

# Add a label and assignee
scripts/gh-issue.sh label 42 --add "confirmed,high-priority"
scripts/gh-issue.sh assign 42 --add octocat

# Comment with findings
scripts/gh-issue.sh comment 42 \
  --body "Reproduced on v2.3 — stack trace points to auth middleware."

# Close with a resolution note
scripts/gh-issue.sh close 42 \
  --comment "Fixed in PR #57. Will ship in the next release."

# Reopen if the fix regressed
scripts/gh-issue.sh reopen 42
```

---

## Cut a release

```bash
# 1. Tag and push (git side — not a gh command)
git tag -a v1.2.0 -m "Release v1.2.0"
git push origin v1.2.0

# 2. Create the release with auto-generated notes
scripts/gh-release.sh create \
  --tag v1.2.0 \
  --title "v1.2.0 — Dark mode & bug fixes" \
  --notes "## Changes
- Added dark mode toggle (#57)
- Fixed login crash (#42)"

# Draft first, publish later
scripts/gh-release.sh create \
  --tag v1.2.0 \
  --title "v1.2.0" \
  --draft

# Attach a build artefact
scripts/gh-release.sh create \
  --tag v1.2.0 \
  --title "v1.2.0" \
  --asset ./dist/app-v1.2.0.tar.gz

# List releases
scripts/gh-release.sh list --limit 5

# Download assets from a release
scripts/gh-release.sh download v1.2.0 --dir ./downloaded-assets
```

---

## Investigate a failing workflow run

```bash
# List recent runs (all workflows)
scripts/gh-release.sh run-list --limit 10

# Filter by workflow file and status
scripts/gh-release.sh run-list \
  --workflow ci.yml \
  --status failure \
  --limit 5

# View summary of a specific run
scripts/gh-release.sh run-view 12345678

# Tail the full logs (pipes to pager)
scripts/gh-release.sh run-logs 12345678 | less

# Re-run just the failed jobs
scripts/gh-release.sh run-rerun 12345678 --failed

# Re-run everything
scripts/gh-release.sh run-rerun 12345678

# Cancel a run that's stuck
scripts/gh-release.sh run-cancel 12345678

# Trigger a workflow manually (workflow_dispatch)
scripts/gh-release.sh workflow-run \
  --workflow deploy.yml \
  --ref main \
  --field environment=staging
```

---

## Clone and fork a repo

These operations use `gh` directly (no wrapper needed):

```bash
# Clone — creates a local copy
gh repo clone owner/repo

# Fork — creates a fork under your account and clones it
gh repo fork owner/repo --clone

# View repo metadata
gh repo view owner/repo

# List repos you have access to
gh repo list --limit 20

# List repos in an org
gh repo list my-org --limit 50
```

---

## GitHub Projects v2 (via gh api)

Projects v2 uses a GraphQL API. See
[references/api-escape-hatch.md](api-escape-hatch.md) for the full escape-hatch
pattern. Quick examples:

```bash
# List projects for a user
gh api graphql -f query='
  query {
    user(login: "octocat") {
      projectsV2(first: 10) {
        nodes { id title url number }
      }
    }
  }
'

# Add an issue to a project
# Step 1: get the project ID and content ID (issue node ID)
ISSUE_NODE_ID=$(gh issue view 42 --json id --jq '.id')
PROJECT_ID="<from above query>"

gh api graphql -f query='
  mutation($project: ID!, $content: ID!) {
    addProjectV2ItemById(input: {projectId: $project, contentId: $content}) {
      item { id }
    }
  }
' -f project="$PROJECT_ID" -f content="$ISSUE_NODE_ID"
```

For richer Projects v2 work (field updates, status changes, iteration
management), reach for the GraphQL API escape hatch in
[api-escape-hatch.md](api-escape-hatch.md).
