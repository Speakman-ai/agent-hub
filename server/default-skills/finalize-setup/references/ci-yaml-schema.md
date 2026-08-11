# `.agent-hub/ci.yaml` — Schema Cheat Sheet

The executable parser is `server/finalize/ci-config.ts` (document root:
`version`, `on`, `timeout_minutes`) plus `server/finalize/ci-config-jobs.ts`
(the `jobs:` body). This page is the human-readable form of the same
contract; if the two disagree, the parser wins.

`version: 2` is the only accepted schema. The document is a `jobs:` map
where every job runs as its **own concurrent runner** on the DinD fleet
(`runs-on: ubuntu-24.04`), one privileged container per job instance,
the same way GitHub fans a workflow out. Map **one job per GitHub job**
and mirror a GitHub `matrix` with `matrix.include`.

---

## Skeleton

```yaml
version: 2                 # required, must be the literal 2
on:                        # required, non-empty list
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

## Top-level keys (allowlist)

| Key | Required | Notes |
|---|---|---|
| `version` | Yes | Must be the literal integer `2`. Strings (`"2"`) fail. |
| `on` | Yes | List of strings. Allowed values: `finalize`, `manual`, `push` (`push` marks configs meant for CI-on-push against Hub-hosted repos). No `pull_request`. |
| `timeout_minutes` | No | Integer in `[1, 240]`. Default = 240. **Pipeline wall-clock** hang limit (jobs/steps). Config may **lower** that hang limit; raising it is rejected. Does **not** cap the 4-hour active-time budget for reviewer / fix-dispatch agent turns. |
| `env` | No | Map of string→string. Lowest-precedence env layer. |
| `jobs` | Yes | Non-empty **map** keyed by job id (not a list). |

**Any other top-level key is a hard error.** Notably `autofix:` is
rejected at parse time: fixes flow into the originating session, not
into a separate phase.

## Job keys (allowlist)

| Key | Required | Notes |
|---|---|---|
| `runs-on` | Yes | `ubuntu-24.04` or `ubuntu-latest` (→ the fleet image), `host` (the Hub box, for lightweight gates that need no Docker), or a fully-qualified image ref. |
| `steps` | Yes | Non-empty list of step objects. |
| `fail-fast` | No | **Finalize default `false`** (unlike GHA's `true`): every matrix shard runs to completion so the fix agent sees the full failure set instead of collateral `context canceled` shards. Set `true` per-job to cancel siblings on first failure, or flip the global default back with `FINALIZE_MATRIX_FAIL_FAST_DEFAULT=true`. |
| `needs` | No | String or list of job ids this job depends on. Cycles are rejected. A failed/skipped dependency skips the dependent. |
| `warmup` | No | `true` makes the job an implicit prerequisite of every non-warmup job (e.g. seed a shared image cache once). |
| `matrix` | No | `{ include: [ {k: "v"}, ... ] }`. Each row spawns a concurrent instance; **all values must be quoted strings**. |
| `paths` | No | List of path globs this job covers. Read only by the flake-recovery classifier, which uses it to tell a real fix from a laundered flake. |
| `retries` | No | Integer in `[0, 10]`. Extra same-commit re-runs of a shard that fails a test. Default 2 for a normal job, 0 for a `warmup` job. |
| `env` | No | Map of string→string, overrides top-level. |

## Step keys (allowlist)

| Key | Required | Notes |
|---|---|---|
| `run` | Yes | Verbatim shell command. Executed under `bash -euo pipefail -c <run>`. |
| `name` | No | Display string. Defaults to `step <1-indexed-position>`. |
| `env` | No | Map of string→string, highest-precedence env layer. |
| `timeout_minutes` | No | Positive integer wall-clock cap for this step, no larger than the pipeline ceiling. Tightens the deadline only. |

**Any other step key is a hard error.** Notably:

- `shell:` — no override allowed. Every step runs under
  `bash -euo pipefail -c`.
- `uses:` / `with:` — there is no action / composite step model.
- `if:` / `continue-on-error:` — branch inside `run` instead.

## Env & `${VAR}` substitution

`${VAR}` / `$VAR` in `run`, `name`, and `env` values resolve against, in
increasing precedence: builtins (`FINALIZE_BRANCH`, `FINALIZE_HEAD_SHA`,
`GIT_BRANCH`, `GIT_COMMIT_SHA`) → top-level `env` → job `env` → matrix
builtins → step `env`. Each `matrix.include` key `foo` is injected as
`FINALIZE_MATRIX_FOO` (uppercased; non-alphanumerics → `_`), plus
`FINALIZE_MATRIX_KEY` with the row label. An unresolved `${VAR}` is left
out of the process environment, not passed through literally.

Two computed matrix builtins are also injected per instance:
`FINALIZE_MATRIX_ORDINAL` is the **1-based** position of the instance within
its job's matrix (`1`, `2`, …) and `FINALIZE_MATRIX_TOTAL` is the matrix size.
Use these for a human "shard N/M" label when your runner index is 0-based —
`--shard-id=$FINALIZE_MATRIX_GROUP` (0-based) but
`shard ${FINALIZE_MATRIX_ORDINAL}/${FINALIZE_MATRIX_TOTAL}` in the step name.
A job with no `matrix` is one instance: ordinal `1` of total `1`. An explicit
`matrix.include` key named `ordinal`/`total` overrides the computed value.

## Execution semantics

- Steps within a job run **in declaration order** in the worktree, and
  the first non-zero exit fails the job (the shell is `bash -euo
  pipefail -c`).
- Independent jobs (no `needs`) start **concurrently** — no per-level
  barrier. A dependent job launches the moment all its `needs` finish
  **successfully**.
- The remote fleet sizes itself to the live job count (the Hub drives
  ECS desired-count); there is no fixed runner cap to design around.
- **No `node_modules` / artifact sharing between jobs** — each job runs
  on its own runner with a fresh worktree, so every job installs its own
  deps. (A `/finalize-cache` Docker volume exists for `docker save/load`
  image reuse via a `warmup` job — not for npm.)
- Pipeline wall-clock (jobs/steps) is capped at `timeout_minutes`. The
  4-hour active-time budget for reviewer / fix-dispatch agent turns is
  a separate ceiling and is **not** lowered by this field.
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
ci_config_absent        — no `.agent-hub/ci.yaml` on disk
not_an_object           — top-level is null / array / scalar
missing_version         — no `version` key
invalid_version         — `version` is not literal 2
unknown_top_level_key   — top-level key outside the allowlist
missing_on              — no `on` key
invalid_on_shape        — `on` is not a list
empty_on                — `on: []`
invalid_on_value        — entry that isn't `finalize`, `manual`, or `push`
invalid_timeout_shape   — `timeout_minutes` not an integer
timeout_out_of_range    — `timeout_minutes` < 1 or > 240
missing_jobs            — no `jobs` key
invalid_jobs_shape      — `jobs` is not a mapping
empty_jobs              — `jobs: {}`
invalid_job_shape       — a job is not a mapping
unknown_job_key         — job key outside the allowlist
missing_runs_on         — job has no `runs-on`
invalid_runs_on         — `runs-on` is empty / not a string
invalid_matrix_shape    — `matrix` is not a mapping with `include`
empty_matrix            — `matrix.include` is empty / not a list
invalid_matrix_entry    — a matrix row or value isn't a string mapping
invalid_env_shape       — an `env` block is not a mapping
invalid_env_entry       — an `env` value is not a string
invalid_fail_fast       — `fail-fast` is not a boolean
invalid_warmup          — `warmup` is not a boolean
invalid_needs           — `needs` is not a job id / list of job ids
invalid_paths           — `paths` is not a list of non-empty strings
invalid_retries         — `retries` outside [0, 10]
unknown_needs_job       — `needs` references a job that doesn't exist
cyclic_needs            — the `needs` graph has a cycle
missing_steps           — job has no `steps` key
invalid_steps_shape     — `steps` is not a list
empty_steps             — `steps: []`
invalid_step_shape      — step is not a mapping
missing_step_run        — step has no `run`
invalid_step_run        — `run` is empty / not a string
invalid_step_name       — `name` provided but not a non-empty string
invalid_step_timeout    — step `timeout_minutes` not a positive integer in range
unknown_step_key        — step key outside the allowlist
```

## Two known-good fixtures

A minimal config the wizard can always fall back to:

```yaml
version: 2
on:
  - finalize
  - manual
jobs:
  test:
    runs-on: host
    steps:
      - name: test
        run: ./scripts/test.sh
```

A typical Node repo fanned out one job per CI lane:

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
