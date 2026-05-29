---
name: finalize-setup
description: >-
  Default guided walkthrough for Finalize Code Changes `.agent-hub/ci.yaml`
  setup. Triggered by Settings → Finalize or POST .../finalize/setup-wizard.
  Reads README + package manifests (package.json, pyproject.toml,
  Cargo.toml, go.mod), detects existing CI signal (GitHub workflows,
  Makefile, npm scripts), proposes a v1 ci.yaml that mirrors what the repo
  already runs, collects env vars, persists via setup-apply (commits the
  file to the worktree).
version: 1.0.0
keep-coding-instructions: true
---

# Finalize Setup — Guided Walkthrough (default)

You are the **default** authoring path for `.agent-hub/ci.yaml`. Users
should not have to read the v1 schema docs to get started — your job is
to introspect the repo, propose a sensible default, get user approval on
a small set of decisions, and persist the file via `setup-apply`.

## Bound values

- **`PROJECT_ID`**, **`PROJECT_CWD`** — from kickoff.
- **`WORKTREE_PATH`** — where the proposed `.agent-hub/ci.yaml` will
  land. This is the originating session's worktree (the session-as-fixer
  model), **not** the project's main `cwd`.
- **`$AGENT_HUB_URL`**, **`$AGENT_HUB_API_KEY`** — set for curl. If any
  wizard curl returns HTTP **401** or **403**, halt — see
  [Auth failure](#auth-failure) below. **Never** ask the operator to
  paste a token into chat.

## Draft (start here)

Kickoff includes full `draft` JSON. Fields:

| Field | Use |
|-------|-----|
| `stack` | Detected primary stack (`node`, `python`, `rust`, `go`, `mixed`, `unknown`) |
| `packageManager` | `npm`, `pnpm`, `yarn`, `pip`, `poetry`, `cargo`, `go`, or null |
| `isMonorepo` | If true: list sub-projects in `subprojects[]`; ask the user whether to run all or one |
| `subprojects` | Detected sub-projects with their own manifests (path + manager) |
| `existingCi` | Boolean — is `.agent-hub/ci.yaml` already on disk? Warn before overwriting. |
| `githubWorkflows` | `.github/workflows/*.yml` filenames (signal: what does the repo already test?) |
| `npmScripts` | Top-level `package.json` scripts that look like test / lint / typecheck / build |
| `makefileTargets` | Make targets that look like test / lint / typecheck / build |
| `readme` | `setupExcerpt`, `readmePath` |
| `proposedSteps` | Ordered candidate steps the server pre-built from the signals above |
| `envVars` | Keys + `sources` + `required` (scanned the same way preview-setup does) |

**Do not** re-scan the repo unless the user changed files mid-session.

## Step 1 — README + repo summary

Read `README.md` under `<PROJECT_CWD>` (or `draft.readme.readmePath` if
set). Summarize in 2–4 sentences:

- Primary stack (Node/Python/Rust/Go/etc.) and package manager
- What the team already runs in CI (from `draft.githubWorkflows`)
- Anything notable about test / lint / typecheck commands

Quote `draft.readme.setupExcerpt` if it has useful content (often the
"Development" or "Testing" sections).

## Step 2 — Existing config check

If `draft.existingCi === true`:

- Read the existing `<WORKTREE_PATH>/.agent-hub/ci.yaml` and show it.
- `agenthub:ask` whether to **overwrite** with a fresh proposal, **edit
  in place** (you propose targeted changes), or **abort**.
- Do not silently overwrite — the file is part of the repo.

## Step 3 — Monorepo / sub-project handling

When `draft.isMonorepo === true` or `draft.subprojects.length > 1`:

1. Print a bullet list: each `subprojects[i]` → its manager + manifest
   path + a one-line role guess (web UI, API, worker, lib).
2. `agenthub:ask`: **run all subprojects** (one step per project) **or
   pick one** (single-step pipeline targeting that subproject).
3. If "pick one", a second `agenthub:ask` to choose the target.

Single-project repos: skip this step.

## Step 4 — Step proposal

The server pre-builds `draft.proposedSteps` from the signals it found.
Typical shape for a Node monorepo:

```yaml
version: 1
on:
  - finalize
  - manual
timeout_minutes: 30
steps:
  - name: install
    run: npm ci --include=dev
  - name: typecheck
    run: npm run typecheck
  - name: lint
    run: npm run lint
  - name: test
    run: npm test
```

Show the proposed YAML verbatim in a fenced ```yaml block. Then
`agenthub:ask`:

- **Use as-is** — proceed to apply
- **Edit steps** — open a multi-question picker for which steps to
  include / drop (install, typecheck, lint, test, build, custom)
- **Add a custom step** — collect `name` + `run` in plain prose

Hard constraints from the v1 schema you MUST respect:

- `version: 1` (no other value works)
- `on:` must be a non-empty list of `finalize` / `manual` (no
  `pull_request` at v1)
- Each step needs `name` + `run` only — **no** `shell:`, `uses:`,
  `with:`, `env:`, `matrix:` (parser rejects unknown keys)
- `timeout_minutes` between 1 and 60 (config may lower, never raise)
- No `autofix:` field — fixes flow back into the originating session

The full cheat sheet is at
[references/ci-yaml-schema.md](references/ci-yaml-schema.md). Stack
recipes (npm/pnpm/yarn/pip/poetry/cargo/go) are at
[references/stack-recipes.md](references/stack-recipes.md).

## Step 5 — Env vars (optional)

For each entry in `draft.envVars` (especially `required: true`):

- Ask in plain prose whether the value should be a project secret.
- v1 ci.yaml has **no** `env:` field at the step or top level. If the
  user needs secrets, point them at **Settings → Secrets** (or
  Settings → Preview → Secrets) — those are injected at run time the
  same way preview env vars are. Do not invent a non-spec field.

Surface this as a "secrets the steps will need" checklist, not a
blocker.

## Step 6 — Persist

```bash
curl -s -X POST "$AGENT_HUB_URL/api/projects/$PROJECT_ID/finalize/setup-apply" \
  -H "x-api-key: $AGENT_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"ci_yaml_content\": \"<the final YAML>\"}"
```

Response shape:

```jsonc
{
  "ok": true,
  "file": ".agent-hub/ci.yaml",
  "commit_sha": "abc123…",
  "branch": "<branch the file was committed on>"
}
```

Server rejects with **400** + `{ "error": "ci_config_invalid", "code":
"<CiConfigErrorCode>", "message": "...", "path": "..." }` if the YAML
fails v1 validation. Fix the issue and re-submit — do not work around
the validation.

## Step 7 — Close the session

After a successful apply, post a short summary in chat:

- File committed at `<commit_sha>` on branch `<branch>`
- The card and session can now run Finalize → click **Finalize** in the
  card view and the steps you just configured will run.

```xml
<agenthub:close-card>
{"reason": "already-done", "note": "Finalize ci.yaml setup complete."}
</agenthub:close-card>
```

## Rules

- **Fenced** `agenthub:ask` only (≥2 options per question). JSON must
  use **`question`** + **`header`** + **`options[].label`** +
  **`options[].description`** — not `prompt`, `id`, or `type` (those
  render as raw code in chat).
- Multiple ask rounds are fine — monorepos need extra picks; custom
  steps need free-text rounds.
- **Never** propose a step that requires a non-spec field (`shell:`,
  `env:`, etc.). The parser rejects it and the wizard ends in failure.
- Prefer pointing users to **Settings → Finalize** for re-running the
  wizard; the apply endpoint overwrites the existing file in a single
  commit.

## Auth failure

**Trigger:** a wizard curl returns HTTP **401** or **403**. That is the
actual auth-rejected signal. Do **not** fire this rule on an empty
`$AGENT_HUB_API_KEY` alone — on an **open** hub (no `apiKey` in config,
no user signed up via `/api/auth/setup`), an empty key is fine and
requests pass through. Treat other HTTP errors (404, 5xx, transport
failures) as wizard or hub bugs, not auth failures.

When a 401 or 403 lands: the Hub is auth-gated and the spawn-time
credentials missed (or are stale). **Do not** try to work around it by
asking the user for a token, prompting them to paste a bearer string
into chat, or instructing them to export an env var into the spawned
session. The env was frozen at spawn time and cannot be updated from
chat; the only fix is to set the key on the server and start a new
session.

Halt the wizard and tell the operator, verbatim, one of:

1. **`PATCH /api/config` (hot path, recommended)** — run `curl -X PATCH
   "$AGENT_HUB_URL/api/config" -H "x-api-key: <existing-or-empty>" -H
   "Content-Type: application/json" -d '{"apiKey": "<value>"}'`. The
   handler mutates the live in-memory config and persists to
   `~/.agent-hub/data/config.json` in one shot, so the change is
   effective for both new spawns and the running auth middleware — no
   restart needed.
2. **Direct file edit (cold path)** — edit `apiKey` in
   `~/.agent-hub/data/config.json`, then **restart the server**
   (`pm2 restart agent-hub` on a deployed host, or stop/start the local
   process).
3. **Escalate to a Hub admin** if the operator has neither
   `PATCH /api/config` nor restart access.

Then exit the walkthrough — do not retry the curls until the operator
confirms the key is set and starts a new session.
