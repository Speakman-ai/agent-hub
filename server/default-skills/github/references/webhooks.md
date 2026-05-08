# Webhooks — GitHub Event Payloads

Back to [SKILL.md](../SKILL.md).

## Overview

GitHub webhooks deliver HTTP POST requests to a registered URL when events
occur in a repository or organisation. Agent Hub registers its own webhooks
for the PR-review pipeline; this document is a quick reference for agents
that need to understand payload shapes or set up additional webhooks via the
API.

For the Agent Hub webhook architecture specifically, see the project wiki pages:
- **"Webhook-Driven PR Lifecycle"**
- **"GitHub Webhooks API"**
- **"Webhook Dispatch: Per-Event Timeouts & Stream Diagnostics"**
- **"Webhook Registration — GitHub App Token Auth (no gh CLI dependency)"**

---

## Common event types and payload fields

### `pull_request`

Triggered when a PR is opened, closed, merged, synchronised (new commit),
converted to/from draft, or labelled/unlabelled.

Key fields:

| Field | Description |
|-------|-------------|
| `action` | `opened`, `closed`, `synchronize`, `reopened`, `labeled`, `converted_to_draft`, `ready_for_review` |
| `pull_request.number` | PR number |
| `pull_request.state` | `open` / `closed` |
| `pull_request.merged` | `true` when `action=closed` and it was merged |
| `pull_request.head.sha` | commit SHA at the tip of the PR branch |
| `pull_request.base.ref` | target branch name |
| `pull_request.user.login` | PR author |
| `repository.full_name` | `owner/repo` |
| `installation.id` | GitHub App installation id (only present for App webhooks) |

```json
{
  "action": "opened",
  "pull_request": {
    "number": 42,
    "title": "feat: dark mode",
    "state": "open",
    "merged": false,
    "head": { "sha": "abc123", "ref": "feature/dark-mode" },
    "base": { "ref": "main" },
    "user": { "login": "octocat" },
    "html_url": "https://github.com/owner/repo/pull/42"
  },
  "repository": { "full_name": "owner/repo" }
}
```

### `pull_request_review`

Triggered when a review is submitted (approved, changes-requested, or comment).

| Field | Description |
|-------|-------------|
| `action` | `submitted`, `dismissed`, `edited` |
| `review.state` | `approved`, `changes_requested`, `commented` |
| `review.user.login` | reviewer's login |
| `pull_request.number` | PR number |

### `issues`

Triggered when an issue is opened, closed, labelled, assigned, etc.

| Field | Description |
|-------|-------------|
| `action` | `opened`, `closed`, `labeled`, `unlabeled`, `assigned`, `unassigned`, `reopened` |
| `issue.number` | issue number |
| `issue.title` | issue title |
| `issue.state` | `open` / `closed` |
| `label.name` | label that triggered the event (for `labeled`/`unlabeled`) |

### `issue_comment`

Triggered when a comment is created/edited/deleted on an issue or PR.

| Field | Description |
|-------|-------------|
| `action` | `created`, `edited`, `deleted` |
| `comment.body` | comment content |
| `comment.user.login` | commenter |
| `issue.number` | issue/PR number |

### `push`

Triggered on every push to a branch.

| Field | Description |
|-------|-------------|
| `ref` | full ref path, e.g. `refs/heads/main` |
| `after` | new HEAD commit SHA |
| `commits[].message` | commit messages |
| `pusher.name` | who pushed |
| `repository.full_name` | `owner/repo` |

### `workflow_run`

Triggered when a GitHub Actions workflow run starts, completes, or is
requested.

| Field | Description |
|-------|-------------|
| `action` | `requested`, `in_progress`, `completed` |
| `workflow_run.id` | run id (use with `gh run view <id>`) |
| `workflow_run.status` | `queued`, `in_progress`, `completed` |
| `workflow_run.conclusion` | `success`, `failure`, `cancelled`, `skipped` |
| `workflow_run.name` | workflow name |
| `workflow_run.head_branch` | branch that triggered the run |

---

## Registering webhooks via `gh api`

```bash
# List existing webhooks on a repo
gh api repos/{owner}/{repo}/hooks --jq '.[] | "\(.id)\t\(.config.url)\t\(.events)"'

# Create a webhook
gh api repos/{owner}/{repo}/hooks \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "name": "web",
  "active": true,
  "events": ["pull_request", "push", "issues"],
  "config": {
    "url": "https://your-hub.example.com/api/webhooks/github",
    "content_type": "json",
    "secret": "your-webhook-secret"
  }
}
EOF

# Delete a webhook
gh api repos/{owner}/{repo}/hooks/{hook_id} --method DELETE
```

---

## HMAC signature verification

GitHub signs every webhook payload with `HMAC-SHA256` using the shared
secret. The signature is in the `X-Hub-Signature-256` header.

Agent Hub verifies this in `server/routes/github.ts`. When building your
own handler:

```bash
# Shell verification (for debugging)
echo -n "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print "sha256=" $2}'
# Compare to X-Hub-Signature-256 header value
```

```typescript
// Node.js / TypeScript
import { createHmac, timingSafeEqual } from 'crypto';

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

Always use `timingSafeEqual` — a plain string comparison leaks timing
information that can be used to forge signatures.

---

## Useful docs

- Full event catalog: https://docs.github.com/en/webhooks/webhook-events-and-payloads
- Webhook security: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- GitHub App webhooks: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps
