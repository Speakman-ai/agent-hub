# `.agent-hub/ci.yaml` v1 — Schema Cheat Sheet

The executable parser is `server/finalize/ci-config.ts`. This page is
the human-readable form of the same contract; if the two disagree, the
parser wins.

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
