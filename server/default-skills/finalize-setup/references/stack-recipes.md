# Finalize ci.yaml — Stack Recipes

Common shapes for the major stacks. Each block is a complete
`.agent-hub/ci.yaml`. Take the closest match and tune to the user's
actual scripts before applying.

Every recipe below uses `runs-on: host` (the Hub box) because these
gates need no Docker. Host jobs all execute in the **same session
worktree**, so a shared dependency install is its own job and the gates
that consume it declare `needs:`; that way the install happens once and
the gates still fan out concurrently. A job on `runs-on: ubuntu-24.04`
gets its own container and fresh checkout instead, so it has to install
its own deps. See [ci-yaml-schema.md](./ci-yaml-schema.md).

## Node.js — npm

```yaml
version: 2
on:
  - finalize
  - manual
timeout_minutes: 30
jobs:
  install:
    runs-on: host
    steps:
      - name: install
        run: npm ci --include=dev
  typecheck:
    runs-on: host
    needs: [install]
    steps:
      - name: typecheck
        run: npm run typecheck
  lint:
    runs-on: host
    needs: [install]
    steps:
      - name: lint
        run: npm run lint
  test:
    runs-on: host
    needs: [install]
    steps:
      - name: test
        run: npm test
```

Notes:

- `--include=dev` is the canonical fix for `Cannot find package
  '@vitejs/plugin-react'` style failures in `NODE_ENV=production`
  contexts.
- Drop jobs the project doesn't have (e.g. no `npm run typecheck` →
  remove the job rather than letting it fail).
- For monorepos with workspaces, `npm ci` at the root usually installs
  everything; per-workspace `--workspace=apps/web run lint` form works
  too.

## Node.js — pnpm

```yaml
version: 2
on:
  - finalize
  - manual
timeout_minutes: 30
jobs:
  install:
    runs-on: host
    steps:
      - name: install
        run: pnpm install --frozen-lockfile
  typecheck:
    runs-on: host
    needs: [install]
    steps:
      - name: typecheck
        run: pnpm typecheck
  lint:
    runs-on: host
    needs: [install]
    steps:
      - name: lint
        run: pnpm lint
  test:
    runs-on: host
    needs: [install]
    steps:
      - name: test
        run: pnpm test
```

## Node.js — yarn

```yaml
version: 2
on:
  - finalize
  - manual
timeout_minutes: 30
jobs:
  install:
    runs-on: host
    steps:
      - name: install
        run: yarn install --frozen-lockfile
  typecheck:
    runs-on: host
    needs: [install]
    steps:
      - name: typecheck
        run: yarn typecheck
  lint:
    runs-on: host
    needs: [install]
    steps:
      - name: lint
        run: yarn lint
  test:
    runs-on: host
    needs: [install]
    steps:
      - name: test
        run: yarn test
```

## Python — pip (requirements.txt)

```yaml
version: 2
on:
  - finalize
  - manual
timeout_minutes: 20
jobs:
  install:
    runs-on: host
    steps:
      - name: install
        run: pip install -r requirements.txt
  lint:
    runs-on: host
    needs: [install]
    steps:
      - name: lint
        run: ruff check .
  typecheck:
    runs-on: host
    needs: [install]
    steps:
      - name: typecheck
        run: mypy .
  test:
    runs-on: host
    needs: [install]
    steps:
      - name: test
        run: pytest
```

Drop lint / typecheck jobs the project doesn't have (no `ruff` config
→ remove that job; no `mypy` setup → remove it). Falsely failing
because a tool isn't configured is worse than running fewer checks.

## Python — Poetry

```yaml
version: 2
on:
  - finalize
  - manual
timeout_minutes: 20
jobs:
  install:
    runs-on: host
    steps:
      - name: install
        run: poetry install --no-interaction
  lint:
    runs-on: host
    needs: [install]
    steps:
      - name: lint
        run: poetry run ruff check .
  typecheck:
    runs-on: host
    needs: [install]
    steps:
      - name: typecheck
        run: poetry run mypy .
  test:
    runs-on: host
    needs: [install]
    steps:
      - name: test
        run: poetry run pytest
```

## Rust — cargo

```yaml
version: 2
on:
  - finalize
  - manual
timeout_minutes: 60
jobs:
  fmt:
    runs-on: host
    steps:
      - name: fmt
        run: cargo fmt --check
  clippy:
    runs-on: host
    steps:
      - name: clippy
        run: cargo clippy --all-targets -- -D warnings
  test:
    runs-on: host
    steps:
      - name: test
        run: cargo test --all
```

Rust builds dominate run time; a 60-minute cap is the safe choice.
Drop `clippy` if the repo doesn't run it. `clippy` and `test` share
`target/`, and cargo takes its own build-directory lock, so one waits
on the other instead of corrupting the build.

## Go — go test

```yaml
version: 2
on:
  - finalize
  - manual
timeout_minutes: 20
jobs:
  vet:
    runs-on: host
    steps:
      - name: vet
        run: go vet ./...
  test:
    runs-on: host
    steps:
      - name: test
        run: go test ./...
```

Add a `build` job running `go build ./...` if the repo cares about the
build artifact.

## Mixed / monorepo (one job per sub-project)

```yaml
version: 2
on:
  - finalize
  - manual
timeout_minutes: 45
jobs:
  server:
    runs-on: host
    steps:
      - name: server install
        run: cd server && npm ci --include=dev
      - name: server test
        run: cd server && npm test
  client:
    runs-on: host
    steps:
      - name: client install
        run: cd client && npm ci --include=dev
      - name: client test
        run: cd client && npm test
```

`cd <dir>` inside `run:` is the way to scope a step to a sub-project;
there is no `working_directory:` field. The shell exits at the end of
the step, so the `cd` doesn't leak. Each sub-project owns its install,
so the two jobs touch different directories and can run at once.

## Fallback — Makefile

```yaml
version: 2
on:
  - finalize
  - manual
timeout_minutes: 30
jobs:
  test:
    runs-on: host
    steps:
      - name: test
        run: make test
```

Use this when the project already has a `Makefile` that owns the
test/lint/build orchestration. One job with one step is fine — failures
still surface the exact command + exit code.

## When the user has no test command at all

Don't invent jobs. Propose the smallest pipeline that still does
something useful:

```yaml
version: 2
on:
  - finalize
  - manual
jobs:
  build:
    runs-on: host
    steps:
      - name: install
        run: <install command>
      - name: build
        run: <build command>
```

…and tell the user a richer pipeline lands when they add a test
command. An empty `jobs:` map and an empty `steps:` list are both
rejected by the parser, so one job with one step is the floor.
