# Finalize ci.yaml — Stack Recipes

Common shapes for the major stacks. Each block is a complete v1
`.agent-hub/ci.yaml`. Take the closest match and tune to the user's
actual scripts before applying.

The v1 schema only supports `name` + `run` on steps — no `env:`,
`shell:`, or matrix. See [ci-yaml-schema.md](./ci-yaml-schema.md).

## Node.js — npm

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

Notes:

- `--include=dev` is the canonical fix for `Cannot find package
  '@vitejs/plugin-react'` style failures in `NODE_ENV=production`
  contexts.
- Drop steps the project doesn't have (e.g. no `npm run typecheck` →
  remove the step rather than letting it fail).
- For monorepos with workspaces, `npm ci` at the root usually installs
  everything; per-workspace `--workspace=apps/web run lint` form works
  too.

## Node.js — pnpm

```yaml
version: 1
on:
  - finalize
  - manual
timeout_minutes: 30
steps:
  - name: install
    run: pnpm install --frozen-lockfile
  - name: typecheck
    run: pnpm typecheck
  - name: lint
    run: pnpm lint
  - name: test
    run: pnpm test
```

## Node.js — yarn

```yaml
version: 1
on:
  - finalize
  - manual
timeout_minutes: 30
steps:
  - name: install
    run: yarn install --frozen-lockfile
  - name: typecheck
    run: yarn typecheck
  - name: lint
    run: yarn lint
  - name: test
    run: yarn test
```

## Python — pip (requirements.txt)

```yaml
version: 1
on:
  - finalize
  - manual
timeout_minutes: 20
steps:
  - name: install
    run: pip install -r requirements.txt
  - name: lint
    run: ruff check .
  - name: typecheck
    run: mypy .
  - name: test
    run: pytest
```

Drop lint / typecheck steps the project doesn't have (no `ruff` config
→ remove that step; no `mypy` setup → remove it). Falsely failing
because a tool isn't configured is worse than running fewer checks.

## Python — Poetry

```yaml
version: 1
on:
  - finalize
  - manual
timeout_minutes: 20
steps:
  - name: install
    run: poetry install --no-interaction
  - name: lint
    run: poetry run ruff check .
  - name: typecheck
    run: poetry run mypy .
  - name: test
    run: poetry run pytest
```

## Rust — cargo

```yaml
version: 1
on:
  - finalize
  - manual
timeout_minutes: 60
steps:
  - name: fmt
    run: cargo fmt --check
  - name: clippy
    run: cargo clippy --all-targets -- -D warnings
  - name: test
    run: cargo test --all
```

Rust builds dominate run time; the default 60-minute cap is the safe
choice. Drop `clippy` if the repo doesn't run it.

## Go — go test

```yaml
version: 1
on:
  - finalize
  - manual
timeout_minutes: 20
steps:
  - name: vet
    run: go vet ./...
  - name: test
    run: go test ./...
```

Add `go build ./...` as a separate step if the repo cares about the
build artifact.

## Mixed / monorepo (one step per sub-project)

```yaml
version: 1
on:
  - finalize
  - manual
timeout_minutes: 45
steps:
  - name: server install
    run: cd server && npm ci --include=dev
  - name: server test
    run: cd server && npm test
  - name: client install
    run: cd client && npm ci --include=dev
  - name: client test
    run: cd client && npm test
```

`cd <dir>` inside `run:` is the way to scope a step to a sub-project
because v1 has no `working_directory:` field. The shell exits at the
end of the step, so the `cd` doesn't leak.

## Fallback — Makefile

```yaml
version: 1
on:
  - finalize
  - manual
timeout_minutes: 30
steps:
  - name: test
    run: make test
```

Use this when the project already has a `Makefile` that owns the
test/lint/build orchestration. One v1 step is fine — failures still
surface the exact command + exit code.

## When the user has no test command at all

Don't invent steps. Propose the smallest pipeline that still does
something useful:

```yaml
version: 1
on:
  - finalize
  - manual
steps:
  - name: install
    run: <install command>
  - name: build
    run: <build command>
```

…and tell the user a richer pipeline lands when they add a test
command. Empty `steps:` is rejected by the parser, so a single step is
the floor.
