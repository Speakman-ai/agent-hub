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
- **`RESOLVED COMMIT TARGET`** — at wizard spawn time the server picks
  the most-recent project session that has a worktree, and prints it
  into the kickoff prompt (`session <id>` → branch `<branch>` at
  `<path>`). **Apply re-resolves at request time** — if a fresher
  worktree-bearing session appears between spawn and apply, the commit
  will land on THAT one unless you pass an explicit `session_id`. Treat
  the target as a starting suggestion, not a guarantee.
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
| `proposedCiYaml` | Server-pre-built v1 ci.yaml — show verbatim; mirrors CI gate workflows when present |
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

## CI replacement mode (user scope wins)

Finalize **replaces GitHub Actions CI** as the pre-push gate — including
heavy steps (Docker stacks, AWS/OIDC jobs, full E2E, permissions sync).
When the user says Finalize replaces CI, run all workflows, or asks you
to stop resisting complex steps:

1. Propose **one step per CI gate workflow** in `draft.githubWorkflows`
   (`lint.yml`, `*.ci.yml`, `e2e.yml`, `permissions-*.yml`,
   `smoke-test.yml`). Exclude deploy/release/terraform workflows only.
2. Start from `draft.proposedCiYaml` — the server mirrors those workflows
   using root gate scripts (`./lint`, `./run_api_tests`, …) and `run:`
   lines from workflow files when present.
3. Surface prerequisites (Docker daemon, `.env`, AWS keys, Settings →
   Secrets) as a **checklist the operator must satisfy** — not as a
   reason to drop or refuse steps.
4. **Never** argue that a step "can't run locally", downgrade to a
   subset, or push the user toward "just lint" unless they explicitly
   ask for a lighter pipeline. Their explicit scope wins.

## Step 4 — Step proposal

The server pre-builds `draft.proposedCiYaml` from CI gate workflows and
repo signals. Typical shape when mirroring GitHub CI:

```yaml
version: 1
on:
  - finalize
  - manual
timeout_minutes: 60
steps:
  - name: lint
    run: ./lint
  - name: backend-tests
    run: ./run_api_tests
  - name: frontend-build
    run: cd frontend && npm ci && npm run build:production
  - name: frontend-component-tests
    run: cd frontend && npx cypress run --component
  - name: permissions-sync-check
    run: ./verifypermissionsync
  - name: e2e
    run: ./run_e2e_tests
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

## Step 5 — Env vars and secrets

For each entry in `draft.envVars` that CI steps will read:

1. Show a checklist: key name, whether a project secret already exists
   (the user may have filled these in Settings → Finalize → Project secrets).
2. For keys still missing, `agenthub:ask`:
   - **Collect now** — ask for values in plain prose (one round per batch),
     then persist via `setup-apply` (step 7).
   - **Skip for now** — user will add them in Settings → Finalize.
   - **Import .env blob** — collect a paste and bundle as `secrets.env`.

v1 ci.yaml has **no** `env:` field. Secrets are stored per-project and
merged into the shell env when Finalize steps run.

Persist secrets in the same `setup-apply` call as the ci.yaml commit:

```bash
curl -s -X POST "$AGENT_HUB_URL/api/projects/$PROJECT_ID/finalize/setup-apply" \
  -H "x-api-key: $AGENT_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"ci_yaml_content\": \"<YAML>\", \"session_id\": \"<id>\", \"secrets\": {\"mode\": \"merge\", \"env\": \"AWS_ACCESS_KEY_ID=...\\nPOSTGRES_DB_PASSWORD=...\\n\", \"defaultKind\": \"secret\"}}"
```

Use `kind: secret` for tokens/passwords; `plain` for non-sensitive config.
Never echo decrypted secret values back in chat after apply.

## Step 6 — Confirm target branch (required, before apply)

Re-state the resolved commit target to the user in plain prose:

> "This will land on branch **`<branch>`** in session
> **`<session_id>`** at `<worktree_path>`."

Then `agenthub:ask`:

- **Apply** — keep the resolved target
- **Pick a different session** — collect the explicit session id (or
  pause so the user can start the right session and re-run the wizard)

**Do not call setup-apply without this confirmation.** The default
heuristic (most-recent worktree-bearing session) can land the commit on
an unrelated in-flight branch in a busy project — the confirmation step
is what makes this safe.

## Step 7 — Persist

Always pass the confirmed `session_id` so the apply endpoint targets
the same session the user just approved (no re-resolution race). When
that session has no persisted worktree yet — common for resumed card
sessions working in the project's primary checkout — setup-apply binds
`project.cwd` and the current git branch automatically.

```bash
curl -s -X POST "$AGENT_HUB_URL/api/projects/$PROJECT_ID/finalize/setup-apply" \
  -H "x-api-key: $AGENT_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"ci_yaml_content\": \"<the final YAML>\", \"session_id\": \"<id confirmed in step 6>\", \"secrets\": {\"mode\": \"merge\", \"env\": \"KEY=value\\n\", \"defaultKind\": \"secret\"}}"
```

(`secrets` is optional — omit when nothing new to store.)

Response shape:

```jsonc
{
  "ok": true,
  "file": ".agent-hub/ci.yaml",
  "commit_sha": "abc123…",
  "branch": "<branch the file was committed on>",
  "session_id": "<session whose worktree received the commit>",
  "secrets_imported": 3
}
```

Server rejects with **400** + `{ "error": "ci_config_invalid", "code":
"<CiConfigErrorCode>", "message": "...", "path": "..." }` if the YAML
fails v1 validation. Fix the issue and re-submit — do not work around
the validation.

## Step 8 — Close the session

After a successful apply, echo `branch` and `session_id` from the
response so the user can spot any drift, then summarise:

- File committed at `<commit_sha>` on branch `<branch>` in session
  `<session_id>`.
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
