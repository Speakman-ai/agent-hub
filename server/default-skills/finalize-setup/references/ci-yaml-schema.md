# `.agent-hub/ci.yaml` — Schema Cheat Sheet (v1 + v2)

The executable parser is `server/finalize/ci-config.ts` (which dispatches
to `ci-config-v2.ts` when `version: 2`). This page is the human-readable
form of the same contract; if the two disagree, the parser wins.

**Which version?** `version: 1` is a flat `steps:` list that runs
**sequentially on the Hub box**. `version: 2` is a `jobs:` map where each
job runs as its **own concurrent runner on the DinD fleet** — this is the
GitHub-Actions-parity mode. Prefer v2 whenever the repo runs more than
one CI lane; see the [v2 section](#v2--concurrent-jobs-gha-parity) below.

---

## v1 — sequential steps

## Skeleton

```yaml
version: 1            # required, must be the literal 1
on:                   # required, non-empty list
  - finalize          # only `finalize` and `manual` are accepted at v1
  - manual
timeout_minutes: 30   # optional; default 60; range [1, 60]
steps:                # required, non-empty list, run in order
  - name: install     # optional; defaults to "step 1", "step 2", ...
    run: npm ci       # required; non-empty string
  - name: test
    run: npm test
```

## Top-level keys (allowlist)

| Key | Required | Notes |
|---|---|---|
| `version` | Yes | Must be the literal integer `1`. Strings (`"1"`) fail. |
| `on` | Yes | List of strings. Allowed values: `finalize`, `manual`. No `pull_request` at v1. |
| `timeout_minutes` | No | Integer in `[1, 60]`. Default = 60. Config may **lower** the cap; raising it is rejected. |
| `steps` | Yes | Non-empty list of step objects. |

**Any other top-level key is a hard error.** Notably:

- `autofix:` — rejected at parse time. Fixes flow into the originating
  session, not into a separate phase.
- `env:` / `globals:` / `defaults:` — not in the v1 spec.

## Step keys (allowlist)

| Key | Required | Notes |
|---|---|---|
| `run` | Yes | Verbatim shell command. Executed under `bash -euo pipefail -c <run>`. |
| `name` | No | Display string. Defaults to `step <1-indexed-position>`. |

**Any other step key is a hard error.** Notably:

- `shell:` — no override allowed. Every step runs under
  `bash -euo pipefail -c`.
- `uses:` / `with:` — no action / composite step model at v1.
- `env:` — per-step env not supported; pull values from project
  secrets via the runtime instead.
- `matrix:` / `if:` / `continue-on-error:` — no fan-out / conditionals
  at v1.

## Execution semantics

- Steps run **in declaration order** in the worktree.
- First non-zero exit fails the pipeline (the shell is `bash -euo
  pipefail -c`).
- Active time across the whole run is capped at `timeout_minutes`
  (default 60).
- Step output is streamed back to the originating session as it
  arrives.
- On failure, the orchestrator dispatches the failed-step context
  back into the originating session (the "fix-dispatch" loop). The
  next commit re-enters from rebase.

## Error codes (from the parser)

The apply endpoint surfaces these in the body when validation fails so
the wizard can react.

```
yaml_parse_error        — could not be parsed as YAML
not_an_object           — top-level is null / array / scalar
missing_version         — no `version` key
invalid_version         — `version` is not literal 1
unknown_top_level_key   — top-level key outside the allowlist
missing_on              — no `on` key
invalid_on_shape        — `on` is not a list
empty_on                — `on: []`
invalid_on_value        — entry that isn't `finalize` or `manual`
invalid_timeout_shape   — `timeout_minutes` not an integer
timeout_out_of_range    — `timeout_minutes` < 1 or > 60
missing_steps           — no `steps` key
invalid_steps_shape     — `steps` is not a list
empty_steps             — `steps: []`
invalid_step_shape      — step is not a mapping
missing_step_run        — step has no `run`
invalid_step_run        — `run` is empty / not a string
invalid_step_name       — `name` provided but not a non-empty string
unknown_step_key        — step key outside the allowlist
```

## Two known-good fixtures

A minimal config the wizard can always fall back to:

```yaml
version: 1
on:
  - finalize
  - manual
steps:
  - name: test
    run: ./scripts/test.sh
```

A typical Node monorepo config:

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

---

## v2 — concurrent jobs (GHA parity)

The executable parser is `server/finalize/ci-config-v2.ts`. v2 adds a
`jobs:` map; every job runs as an **independent concurrent runner** on
the DinD fleet (`runs-on: ubuntu-24.04`), one privileged container per
job instance — the same way GitHub fans a workflow out. Map **one v2 job
per GitHub job**; mirror a GitHub `matrix` with `matrix.include`. Only
`version === 2` reaches the runner fleet — a v1 pipeline runs
sequentially on the Hub box.

### Skeleton

```yaml
version: 2                 # required, must be the literal 2
on:                        # same as v1: finalize / manual
  - finalize
  - manual
timeout_minutes: 45        # optional; range [1, 240]
env:                       # optional top-level env (lowest precedence)
  GIT_BRANCH: ${FINALIZE_BRANCH}
jobs:                      # required, non-empty MAP keyed by job id
  build:
    runs-on: ubuntu-24.04  # required
    steps:                 # required, non-empty
      - name: install
        run: npm ci --include=dev
      - name: build
        run: npm run build
  test:
    runs-on: ubuntu-24.04
    fail-fast: false       # optional; Finalize default is false (run all shards)
    needs: []              # optional — job ids this job waits on (DAG)
    env:                   # optional job-level env (overrides top-level)
      AWS_REGION: ${AWS_REGION}
    matrix:                # optional — GHA-style fan-out
      include:             # each row → one concurrent instance
        - { shard: "1", shards: "3" }
        - { shard: "2", shards: "3" }
        - { shard: "3", shards: "3" }
    steps:
      - name: test (shard ${FINALIZE_MATRIX_SHARD})
        env:               # optional step-level env (highest precedence)
          NODE_ENV: test
        run: npx vitest run --shard="$FINALIZE_MATRIX_SHARD/$FINALIZE_MATRIX_SHARDS"
```

### Top-level keys (allowlist)

| Key | Required | Notes |
|---|---|---|
| `version` | Yes | Literal integer `2`. |
| `on` | Yes | List of `finalize` / `manual`. |
| `timeout_minutes` | No | Integer in `[1, 240]`. |
| `env` | No | Map of string→string. Lowest-precedence env layer. |
| `jobs` | Yes | Non-empty **map** keyed by job id (not a list). |

### Job keys (allowlist)

| Key | Required | Notes |
|---|---|---|
| `runs-on` | Yes | `ubuntu-24.04` or `ubuntu-latest` (→ the fleet image), `host` (Hub box, legacy), or a fully-qualified image ref. |
| `steps` | Yes | Non-empty list; same `name` + `run` + optional `env` shape as v1. |
| `fail-fast` | No | **Finalize default `false`** (unlike GHA's `true`): every matrix shard runs to completion so the fix agent sees the full failure set instead of collateral `context canceled` shards. Set `true` per-job to cancel siblings on first failure, or flip the global default back with `FINALIZE_MATRIX_FAIL_FAST_DEFAULT=true`. |
| `needs` | No | String or list of job ids this job depends on. Cycles are rejected. A failed/skipped dependency skips the dependent. |
| `warmup` | No | `true` makes the job an implicit prerequisite of every non-warmup job (e.g. seed a shared image cache once). |
| `matrix` | No | `{ include: [ {k: "v"}, ... ] }`. Each row spawns a concurrent instance; **all values must be quoted strings**. |
| `env` | No | Map of string→string, overrides top-level. |

### Step keys (allowlist)

Same as v1 (`run` required, `name` optional) **plus** `env` (map of
string→string, highest-precedence layer). No `shell:` / `uses:` /
`with:` / `if:` — branch inside `run` instead.

### Env & `${VAR}` substitution

`${VAR}` / `$VAR` in `run`, `name`, and `env` values resolve against, in
increasing precedence: builtins (`FINALIZE_BRANCH`, `FINALIZE_HEAD_SHA`,
`GIT_BRANCH`, `GIT_COMMIT_SHA`) → top-level `env` → job `env` → matrix
builtins → step `env`. Each `matrix.include` key `foo` is injected as
`FINALIZE_MATRIX_FOO` (uppercased; non-alphanumerics → `_`), plus
`FINALIZE_MATRIX_KEY` with the row label. An unresolved `${VAR}` is left
out of the process environment, not passed through literally.

### Execution semantics

- Independent jobs (no `needs`) start **concurrently** — no per-level
  barrier. A dependent job launches the moment all its `needs` finish
  **successfully**.
- The remote fleet sizes itself to the live job count (the Hub drives
  ECS desired-count); there is no fixed runner cap to design around.
- **No `node_modules` / artifact sharing between jobs** — each job runs
  on its own runner with a fresh worktree, so every job installs its own
  deps. (A `/finalize-cache` Docker volume exists for `docker save/load`
  image reuse via a `warmup` job — not for npm.)

### v2-specific error codes

In addition to the shared codes above, the v2 parser emits:
`missing_jobs`, `invalid_jobs_shape`, `empty_jobs`, `invalid_job_shape`,
`unknown_job_key`, `missing_runs_on`, `invalid_runs_on`,
`invalid_matrix_shape`, `empty_matrix`, `invalid_matrix_entry`,
`invalid_env_shape`, `invalid_env_entry`, `invalid_fail_fast`,
`invalid_warmup`, `invalid_needs`, `unknown_needs_job`, `cyclic_needs`,
`unknown_top_level_key_v2`, and the `*_v2` step variants
(`missing_steps_v2`, `empty_steps_v2`, `invalid_step_shape_v2`,
`unknown_step_key_v2`, `missing_step_run_v2`, `invalid_step_run_v2`).

### Concrete fan-out fixture

```yaml
version: 2
on:
  - finalize
  - manual
timeout_minutes: 45
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - name: Build + typecheck
        run: npm ci --include=dev && npm run build && cd server && npx tsc --noEmit
  test:
    runs-on: ubuntu-24.04
    fail-fast: false
    matrix:
      include:
        - { shard: "1", shards: "3" }
        - { shard: "2", shards: "3" }
        - { shard: "3", shards: "3" }
    steps:
      - name: Tests (shard ${FINALIZE_MATRIX_SHARD})
        run: |
          npm ci --include=dev
          npx vitest run --shard="$FINALIZE_MATRIX_SHARD/$FINALIZE_MATRIX_SHARDS"
  lint:
    runs-on: ubuntu-24.04
    steps:
      - name: Lint
        run: npm ci --include=dev && npm run lint
```
