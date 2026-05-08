# Auth — PAT vs OAuth vs GitHub App; Credential Resolution

Back to [SKILL.md](../SKILL.md).

## Contents

- [Token resolution hierarchy](#token-resolution-hierarchy)
- [Fine-grained vs classic PATs](#fine-grained-vs-classic-pats)
- [Required scopes by operation](#required-scopes-by-operation)
- [Minting a PAT](#minting-a-pat)
- [gh auth login (OAuth device flow)](#gh-auth-login-oauth-device-flow)
- [GitHub App tokens — Reviewer App boundary](#github-app-tokens--reviewer-app-boundary)
- [Security guardrails](#security-guardrails)

---

## Token resolution hierarchy

`scripts/_common.sh` resolves a GitHub token in this order:

| Priority | Source | Notes |
|----------|--------|-------|
| 1 | `GH_TOKEN` env var | Agent Hub injects this when the user stores a key in **Settings → Skills → Credentials → GitHub**. Normal path in agent sessions. |
| 2 | `GITHUB_TOKEN` env var | GitHub Actions built-in; also set manually via `export GITHUB_TOKEN=...` in the host shell. `_common.sh` promotes `GH_TOKEN` → `GITHUB_TOKEN` so `gh` picks it up. |
| 3 | `gh auth status` | Host's existing `gh` login (OAuth via browser or device code). No env var needed. |
| — | Absent | Script exits with a clear error and remediation steps. No silent failures. |

The same hierarchy is implemented in `server/github-skill-auth-resolve.ts` for
server-side checks (used by the setup wizard, spawn validation, etc.).

---

## Fine-grained vs classic PATs

| | Fine-grained PAT | Classic PAT |
|--|--|--|
| Scope granularity | Per-repo, per-permission | Broad (repo, workflow, gist…) |
| Org support | Requires org admin approval | Works directly |
| Expiry | Required (max 1 year) | Optional |
| Recommendation | ✅ Preferred for new tokens | Legacy; avoid if possible |

Create either at: **https://github.com/settings/tokens**

---

## Required scopes by operation

| Operation | Fine-grained permissions | Classic scope |
|-----------|--------------------------|---------------|
| Read repos/PRs/issues | `Contents: read`, `Pull requests: read`, `Issues: read` | `repo` (read) |
| Open/comment/close PRs & issues | `Pull requests: write`, `Issues: write` | `repo` |
| Merge PRs | `Pull requests: write`, `Contents: write` | `repo` |
| Trigger / cancel workflow runs | `Actions: write` | `workflow` |
| Create releases | `Contents: write` | `repo` |
| Create/read gists | `Gists: write` | `gist` |
| GitHub Projects v2 | `Projects: read/write` | `project` |

For most Agent Hub automation, a fine-grained PAT with
**`Contents: read+write`, `Pull requests: write`, `Issues: write`, `Actions: write`**
on the relevant repos covers all use cases.

---

## Minting a PAT

### Fine-grained

1. **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. Set an expiry (90 days is a reasonable default; max 1 year).
3. Under **Repository access**, select the repos the agent needs.
4. Expand **Permissions** and grant the scopes from the table above.
5. Click **Generate token** and copy the value (shown once).
6. In Agent Hub: **Settings → Skills → Credentials → GitHub → GH_TOKEN** — paste the token. It is stored AES-256-GCM encrypted.

### Classic

1. **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**
2. Select `repo`, `workflow`, `gist` scopes.
3. Copy and store in Agent Hub as above.

---

## gh auth login (OAuth device flow)

If you prefer not to manage a PAT, the `gh` CLI can authenticate via the
GitHub OAuth device flow. This is the "Sign in via browser" path:

```bash
gh auth login
# Choose: GitHub.com → HTTPS → Login with a web browser
# Follow the URL printed in the terminal
```

The token is stored in the system keychain (macOS) or
`~/.config/gh/hosts.yml` (Linux). `scripts/_common.sh` detects this via
`gh auth status`.

**Limitation**: OAuth tokens acquired this way are tied to the host shell.
They are **not** propagated to remote Electron clients or other machines.
Use a PAT stored in Agent Hub credentials for portable auth.

---

## GitHub App tokens — Reviewer App boundary

Agent Hub ships with a **Reviewer GitHub App** (`server/routes/github.ts`,
`REVIEWER_APP_*` env vars) whose installation token is used exclusively for:

- Receiving PR webhook events
- Posting automated code-review comments as the `hub-reviewer` bot identity

**Do NOT reuse the Reviewer App token for ad-hoc skill calls.** The reasons:

1. Installation tokens are short-lived (~1 hour) and scoped to the app's
   installation, not the user's identity.
2. Actions taken under the app identity appear as the bot, not the user —
   which is confusing for teammates.
3. The skill scripts (via `GH_TOKEN` / `gh auth`) act as the *user*, which
   is the correct identity for agent-driven work.

See the Agent Hub wiki page **"GitHub App — Formal PR Reviews & Auto-Setup"**
for the full Reviewer App architecture.

---

## Security guardrails

- **Never log the token.** Do not print it to stdout, daily notes, kanban card
  descriptions, or chat messages. The `_common.sh` helper never echoes it.
- Rotate PATs on suspected compromise. Fine-grained PATs can be revoked
  individually at `https://github.com/settings/tokens`.
- Personal tokens inherit your account's access. Use fine-grained PATs
  scoped to specific repos for production integrations.
- For multi-user deployments, each user should store their own `GH_TOKEN` —
  per-user credential isolation is enforced by Agent Hub's credential store.
- Branch-protection rules apply even to token-authenticated requests.
  The scripts respect these: `gh pr merge` will fail if required reviews are
  missing or status checks haven't passed.
