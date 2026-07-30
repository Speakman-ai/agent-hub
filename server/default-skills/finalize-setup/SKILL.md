---
name: finalize-setup
description: >-
  Default guided walkthrough for Finalize Code Changes `.agent-hub/ci.yaml`
  setup. Triggered by Settings → Finalize or POST .../finalize/setup-wizard.
  Reads README + package manifests (package.json, pyproject.toml,
  Cargo.toml, go.mod), detects existing CI signal (GitHub workflows,
  Makefile, npm scripts), proposes a ci.yaml that mirrors what the repo
  already runs (GHA parity: one concurrent job per GitHub job on the
  DinD fleet), collects env vars, proves the pipeline locally, then
  commits + pushes + opens a PR.
version: 1.0.0
keep-coding-instructions: true
---

# Finalize Setup — Guided Walkthrough (default)

You are the **default** authoring path for `.agent-hub/ci.yaml`, and you
run as a **normal worktree-backed session**. You are already checked out
in your own dedicated git worktree on a fresh `agent-hub/…` branch — a
clone of the project. Author the config here, **prove it by running the
configured steps locally**, then **commit, push, and open a PR** so the
runner config goes through normal review, exactly like any code change.
Users should not have to read the schema docs to get started.

## Bound values

- **`PROJECT_ID`**, **`PROJECT_CWD`** — from kickoff. `PROJECT_CWD` is
  where the draft was scanned from; your actual working directory is your
  session's worktree clone.
- **`YOUR SESSION_ID`** — printed in the kickoff prompt. This session
  owns the worktree the config commits to. **Pass it as `session_id` to
  `setup-apply`.** Never ask the user for a `session_id` and never tell
  them to start a different or card-linked session — *this* session is
  the working session.
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
| `proposedCiYaml` | Server-pre-built ci.yaml, a starting point that mirrors CI gate workflows. Fan it out to one job per GitHub job when the repo has >1 CI lane (Step 4). |
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

## Step 4 — Pipeline proposal

A ci.yaml is a `jobs:` map. Every job runs as its own concurrent runner
on the DinD fleet (`runs-on: ubuntu-24.04`), one privileged container
per job instance, the same way GitHub fans a workflow out. A lightweight
gate that needs no Docker can use `runs-on: host` and run on the Hub box
instead.

The whole point is parity: map **one `job` per GitHub job**, mirror a
GitHub `matrix` with `matrix.include` (each row becomes its own
concurrent runner), and **do NOT group, serialize, or drop jobs to
"save" runners** — full fan-out is the goal. Use `needs:` only to
reproduce a real GitHub `needs:` edge; otherwise leave jobs independent
so they all start at once.

### Skeleton (GHA fan-out)

```yaml
version: 2
on:
  - finalize
  - manual
timeout_minutes: 45

jobs:
  build:                          # one job per GitHub job
    runs-on: ubuntu-24.04
    steps:
      - name: Install
        run: npm ci --include=dev
      - name: Build + typecheck
        run: npm run build && cd server && npx tsc --noEmit

  test:                           # GitHub matrix → matrix.include
    runs-on: ubuntu-24.04
    fail-fast: false              # let every shard finish (GHA fail-fast: false)
    matrix:
      include:                    # each row = its own concurrent runner
        - { shard: "1", shards: "3" }
        - { shard: "2", shards: "3" }
        - { shard: "3", shards: "3" }
    steps:
      # Steps have NO `if:` — branch in the script off FINALIZE_MATRIX_*.
      # A matrix key `shard` is injected as $FINALIZE_MATRIX_SHARD.
      - name: Tests (shard ${FINALIZE_MATRIX_SHARD})
        run: |
          npm ci --include=dev
          npx vitest run --shard="$FINALIZE_MATRIX_SHARD/$FINALIZE_MATRIX_SHARDS"

  lint:                           # independent → starts at the same time
    runs-on: ubuntu-24.04
    env:
      SOME_TOKEN: ${SOME_TOKEN}   # project secret, substituted at run time
    steps:
      - name: Install
        run: npm ci --include=dev
      - name: Lint
        run: npm run lint
```

The server pre-builds `draft.proposedCiYaml` from CI gate workflows. It
arrives as a handful of `runs-on: host` jobs (plus an `e2e` matrix when
one was detected); when the repo runs more CI lanes than that, **fan it
out yourself** using `draft.githubWorkflows` + `draft.npmScripts` — one
job per GitHub job.

Show the proposed YAML verbatim in a fenced ```yaml block. Then
`agenthub:ask`:

- **Use as-is** — proceed to apply
- **Edit** — multi-question picker for which jobs/steps to include / drop
- **Add a custom job/step** — collect name + `run` + `runs-on` in prose

Constraints:

- `on:` is a non-empty list of `finalize` / `manual` (no `pull_request`)
- `timeout_minutes` between 1 and 240 (config may lower, never raise)
- **No** `shell:`, `uses:`, `with:`, or `autofix:` anywhere
- every job needs `runs-on: ubuntu-24.04` (or `ubuntu-latest`, or `host`
  for a gate that needs no Docker); matrix values must be **quoted
  strings** (`shard: "1"`, not `1`)

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

Secrets are stored per-project and merged into the shell env when
Finalize steps run, so a step can read them directly. A config can also
reference a project secret explicitly with `${VAR}` in a top-level / job
/ step `env:` block (e.g. `AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}`); an
unresolved `${VAR}` is left out of the step environment rather than
passed through literally.

Persist secrets in the same `setup-apply` call as the ci.yaml commit:

```bash
curl -s -X POST "$AGENT_HUB_URL/api/projects/$PROJECT_ID/finalize/setup-apply" \
  -H "x-api-key: $AGENT_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"ci_yaml_content\": \"<YAML>\", \"session_id\": \"<YOUR SESSION_ID>\", \"secrets\": {\"mode\": \"merge\", \"env\": \"AWS_ACCESS_KEY_ID=...\\nPOSTGRES_DB_PASSWORD=...\\n\", \"defaultKind\": \"secret\"}}"
```

Use `kind: secret` for tokens/passwords; `plain` for non-sensitive config.
Never echo decrypted secret values back in chat after apply.

## Step 6 — Confirm with the user

Restate the proposed pipeline in plain prose and `agenthub:ask` a simple
**Apply** / **Cancel**. **Never** make the user pick or supply a
`session_id` — you already own the worktree the config commits to. Only
call `setup-apply` after the user approves.

## Step 7 — Commit (setup-apply with YOUR own session_id)

Call `setup-apply` with **`YOUR SESSION_ID`** (from the kickoff bound
values). This validates the schema and commits `.agent-hub/ci.yaml` into
**this session's own worktree** — the same worktree you're working in.

```bash
curl -s -X POST "$AGENT_HUB_URL/api/projects/$PROJECT_ID/finalize/setup-apply" \
  -H "x-api-key: $AGENT_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"ci_yaml_content\": \"<the final YAML>\", \"session_id\": \"<YOUR SESSION_ID>\", \"secrets\": {\"mode\": \"merge\", \"env\": \"KEY=value\\n\", \"defaultKind\": \"secret\"}}"
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
fails validation. Fix the issue and re-submit — do not work around the
validation.

## Step 8 — Verify in your worktree (prove the pipeline)

You are in a real worktree — **use it**. Run the steps you just
configured (the `run:` commands from the ci.yaml: install, lint, tests,
etc.) right here, in dependency order, to prove the pipeline is green
**before** you push. This is the whole point of working in a worktree:
catch failures locally, not on the runner.

- If a step fails because the **config** is wrong, fix the YAML and
  re-run `setup-apply` (it re-commits), then re-run the step.
- If it fails because of a **missing secret/env var**, collect it (step
  5) and re-apply, or note the runner prerequisite for the user.
- Don't claim success you didn't observe — only report green for steps
  you actually ran.

## Step 9 — Push + open a PR

Ship it like any change so it goes through review:

```bash
git push -u origin HEAD
gh pr create --title "Add Finalize runner config (.agent-hub/ci.yaml)" \
  --body "Adds the Finalize CI pipeline. Verified locally: <which steps you ran + results>."
```

Report the PR URL back to the user. Do **not** merge it yourself — a
human merges after review.

## Step 10 — Close the session

After the PR is open, echo `branch`, `session_id`, and the PR URL so the
user can review, then summarise:

- File committed at `<commit_sha>` on branch `<branch>` in session
  `<session_id>`; PR opened at `<pr_url>`.
- Once merged, the card and session can run Finalize → click
  **Finalize** in the card view and the steps you just configured will
  run.

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
- **Never** propose `shell:`, `uses:`, `with:`, or `autofix:` — the
  parser rejects them and the wizard ends in failure. `env:` blocks and
  job-level `matrix.include` are first-class, and are how you get
  GHA-parity concurrency.
- **Do not down-scope for concurrency's sake.** When a repo has multiple
  GitHub jobs, fan them out 1-1 — never collapse them into
  fewer jobs to reduce runner count. The fleet scales to the work.
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
