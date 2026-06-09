# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Development Server
- `npm run dev` - Start both client and server in development mode concurrently
- `npm run dev:client` - Start only the React client on port 3050
- `npm run dev:server` - Start only the Node.js server on port 3051

### Build Commands  
- `npm run build` - Build the client React application
- `npm run install:all` - Install dependencies for root, server, client, and mobile

### Individual Component Commands
- **Client**: `cd client && npm run dev` (Vite dev server on port 3050)
- **Server**: `cd server && npm start` (Express server on port 3051, uses `tsx`)
- **Mobile**: `npm run mobile` or `cd mobile && expo start` (Expo dev server)

### TypeScript (Server)
- `npm run typecheck` (repo root) or `cd server && npm run typecheck` — Run `tsc --noEmit` on the server. Requires `server/node_modules` with devDependencies (use `npm run install:all` or `cd server && npm ci --include=dev`). Running `tsc` without installing `server/` first can make resolution walk up to the root `node_modules` and fail with missing `express` / `uuid` / `@types/*`.
- `cd server && npx tsc --noEmit` - Same as above, directly
- The server uses `tsx` for runtime (no build step) and `tsc --noEmit` for type checking only

### Lint & Format
- `npm run lint` - Run ESLint across the repo
- `npm run lint:fix` - Run ESLint with `--fix` to auto-correct where possible
- `npm run format` - Format `server/`, `client/src/`, and `electron/` with Prettier
- `npm run format:check` - Check formatting without writing (used in CI/pre-commit)

## Architecture Overview

This is a full-stack Agent Hub application that manages and interfaces with AI agents (Claude Code and Cursor Agent).

### Core Components

**Server (`/server`)** — **TypeScript** (strict mode, ESM)
- **Express.js** backend with WebSocket support for real-time chat
- **TypeScript** with `strict: true`, using `tsx` for runtime and `tsc --noEmit` for type checking
- **SQLite database** (`better-sqlite3`) for sessions, messages, heartbeats, crons
- **Project→Agent hierarchy** - Projects are top-level entities (with `cwd`, `ahw` workspace, color); each project contains one or more agents. Defined in `server/projects.json`.
- **Centralized config** - `~/.agent-hub/data/config.json` holds port, CLI binary paths (`claudeBin`, `cursorBin`), and `defaultCwd`. Falls back to `server/config.json` (legacy) if the data-dir copy doesn't exist. Edit here rather than hardcoding.
- **Agent management** - CRUD operations for AI agent configurations
- **Session management** - Persistent chat sessions with message history
- **Heartbeat system** - Scheduled agent check-ins with configurable prompts
- **Cron jobs** - Automated tasks (dependabot merging, job search monitoring)
- **Skills system** - Agent-specific skill discovery from workspace directories
- **Memory system** - Daily notes and context files (AGENTS.md, SOUL.md, etc.)
- **Slack integration** - Multi-agent Slack bot support

**Client (`/client`)**
- **React + Vite** frontend with Tailwind CSS
- **WebSocket connection** for real-time chat streaming
- **Agent selection** and configuration interface
- **Session management** with persistent chat history
- **Skills browser** - View and manage agent-specific skills
- **Settings pages** - Configure agents, heartbeats, cron jobs
- **Memory interface** - View and edit agent memory files

**Mobile (`/mobile`)**
- **React Native + Expo** mobile app (iOS & Android)
- **1:1 feature parity** with the web client
- **Drawer navigation** for agent/session sidebar (swipe to open)
- **Real-time chat** via WebSocket with streaming responses
- **Skills & Context** - Browse skills and edit context files
- **Settings** - Heartbeats, cron jobs, Slack bots, agent configuration
- **Auto-connects** to local server using Expo's dev host detection
- **Dark theme** matching the web app's color palette

### Key Architecture Patterns

1. **Multi-Engine Support**: Supports both Claude Code and Cursor Agent with different CLI invocation patterns
2. **Agent-Workspace Binding**: Each agent has a configurable workspace directory with context files and skills
3. **Enriched System Prompts**: Automatically builds prompts from agent config + workspace context files + skills + memory
4. **Real-time Streaming**: WebSocket-based chat with live response streaming
5. **SQLite-Backed Persistence**: All sessions, messages, and agent data stored in local SQLite database
6. **Flat Agent Model**: Agents are dedicated ("full-stack" or specialist) and coordinate via plain chat or optional multi-agent sessions — there is **no** `<delegate>` / `<handoff>` sub-agent dispatch system. The CLI engines (Claude Code, Cursor) handle their own internal sub-agent orchestration.

### Database Schema

- **sessions**: Chat sessions linked to agents with engine/model info
- **messages**: Individual chat messages with role (user/assistant) 
- **heartbeat_logs**: Scheduled agent check-in results
- **crons**: Automated task definitions and execution logs
- **slack_messages**: Slack bot interaction history
- **delegations** / **handoffs** (legacy): retained for historical data only — the `<delegate>` / `<handoff>` sub-agent system has been removed. New rows are no longer written.

### File Structure Conventions

- **Agent workspaces** contain:
  - Context files: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`
  - Skills directory: `skills/` with `SKILL.md` frontmatter files
  - Memory directory: `memory/` with daily note files

### Integration Points

- **Claude Code CLI** and **Cursor Agent CLI** paths are configured in `~/.agent-hub/data/config.json` (`claudeBin` / `cursorBin`). Falls back to `server/config.json` if the data-dir copy doesn't exist. The built-in defaults point at `/usr/local/bin/claude`; update in config.json for your environment.
- **Slack Bot Framework**: `@slack/bolt` for multi-agent Slack integration
- **Cron Scheduling**: `node-cron` for automated task execution

## Git Workflow — One Session, One Branch

**The platform already created your branch. Do not create another one.**

Every Agent Hub session with a worktree is a dedicated clone checked out on
exactly one deterministic branch — `agent-hub/<agentId>/session-<id>` —
created once by the platform (`server/worktree.ts`) and never switched for
the life of the session. The session record, the Finalize Code Changes
flow, the `changes_ready` indicator, and the push/PR step all key off that
single branch. **Switching or creating a branch inside the worktree breaks
that invariant**: Finalize validates whatever branch is checked out but
pushes the recorded session branch, so a second branch silently strands
your commits where Finalize can never see them (it then re-runs the same
checks forever / fails with `fix_no_progress`).

### Standard Flow
1. **You are already on the right branch.** Do not run `git checkout main`,
   `git checkout -b ...`, `git switch -c ...`, or `git branch <new>`.
2. **Build the environment** → `npm install` (or equivalent) if needed.
3. **Implement** — all edits, builds, and tests happen on the current
   session branch.
4. **Rebase on latest** → `git fetch origin && git rebase origin/main`
   (rebases the current branch; do not switch branches to do it).
5. **Commit** to the current session branch.
6. **Stop there.** Pushing, opening the PR, and merging are handled by the
   platform's **Finalize Code Changes** flow / per-session automation — not
   by you. See the "Agent Hub — Shipping" contract.

### Rules
- **Never create or switch branches** in a session worktree — commit to the
  branch you are already on.
- When the user says "commit", commit to the **current session branch**.
- Never commit directly to `main`, and never `git push origin main`.
- **Never merge your own PR** — only humans merge to main.
- Formal GitHub PR review is owned by the project's Reviewer agent.

### What NOT to Do
- `git checkout -b feature/...` / `git switch -c ...` / `git branch <name>`
  inside the worktree — this is the exact action that breaks Finalize.
- `git checkout main` to "start fresh" — the session branch IS your branch.
- `git push origin main` for feature work.
- Editing files in the main repo and copying them around.
- Merging PRs — leave that for the human.

## Kanban Card Hygiene — Done-State Contract

Full contract in the wiki: **`kanban-done-state-contract-when-a-card-may-move-to-done`**. Read it once; the rules below are the operational summary.

A card may move to **Done** only if **one** of these holds:

- **(a) Full scope shipped** — every acceptance criterion in the card description was actually delivered in user-visible form.
- **(b) Partial / spec only** — the card title is prefixed `[Spec]` or `[Partial]`, AND a comment on the card lists the follow-up card IDs that cover the gap. Both halves are required: the prefix makes the gap visible at-a-glance; the IDs make the remaining work findable.

There is no third option. If neither holds, the card stays in **In Progress** or **Review** until follow-up cards exist.

### At PR-merge time (lead checklist)

Before moving a card to Done after a PR merges:

1. Diff the PR contents against the card's acceptance criteria.
2. If scope shrank: **create the follow-up cards first**, wire blocker edges, link them under an epic if there's one, retitle the original card with `[Spec]` / `[Partial]`, and post a comment on the original card listing the follow-up IDs and a one-line "why we split" rationale.
3. **Then** move it to Done.

The bookkeeping happens at the moment the gap exists, not weeks later when someone asks "wasn't this supposed to ship?"

### End-of-session announcement

The closing message of any session that touched the kanban board must include an explicit **user-visible delta** statement:

> **User-visible behavior change after merge:** yes / no.
> If no: **follow-up cards required** → `<id1>`, `<id2>`, …

This is what tells the human in the loop whether they will see anything different after the merge lands. If you closed a card under path (b), this announcement is non-optional — it's the live signal that scaffolding shipped, not the feature.

### What "user-visible" means

- ✅ A page, button, or copy renders differently in web / mobile / Electron.
- ✅ A REST or WebSocket surface gains or changes behavior callers can observe.
- ✅ A CLI / script output, log line, or installed binary changes.
- ❌ A new file/type/function with no caller exercising it yet.
- ❌ Test-only additions.
- ❌ Internal refactors with unchanged external contracts.
- ❌ Spec docs, ADRs, wiki pages.

When in doubt, err toward "not user-visible" and require the follow-up.

## Web Search — Required for Opinions, Best Practices & Recommendations

Training data has a knowledge cutoff and grows stale. Whenever you are asked for an opinion ("which is better?"), a best practice ("what's the best way to do X?"), a recommendation ("should we use X or Y?"), or the current state of the ecosystem — **always perform a web search first** before answering.

- Use `WebSearch` or the `<agenthub:react>` web action to fetch current results
- Never answer opinion or best-practice questions from training data alone
- Training data is a starting point; a live web search is the answer

This applies to: library comparisons, architecture decisions, tooling recommendations, "best way to" queries, and any question where the right answer may have changed since training.

## External API Documentation — Always Verify

When working with any external service API (GitHub, Slack, Stripe, AWS, etc.), **always search for and read the current official documentation** before implementing or debugging. Do not rely solely on training data — APIs change.

- Consult the official documentation for the service you're integrating with
- Compare the current API contract against what the code implements
- Do this **proactively** — don't wait until something breaks

This applies to all work: new integrations, bug fixes, and debugging unexpected behavior from third-party services.

## Suppress File-Safety / "Not Malware" Acknowledgments

The Claude Code CLI binary appends a hidden `<system-reminder>` after every Read tool result asking the model to "consider whether [the file] would be considered malware." This injection is server-side and **cannot be disabled via settings.json, env vars, or CLI flags** (see wiki: *Claude Code Malware Reminder*). The model often verbalizes an acknowledgment ("Not malware — …", "This appears safe — …") which adds noise to transcripts.

**Do not write these acknowledgments in your responses.** Read the file, perform your task, and continue silently. Treat the malware reminder the same way you treat the TodoWrite reminder — internalize it but never surface it to the user. If a file genuinely looks malicious, raise it explicitly; otherwise stay quiet.

## Testing

**Every feature, bugfix, and refactor should include at least one test.** PRs without tests for new logic will be flagged in review.

### Framework
- **Vitest** for all unit/integration tests
- **Playwright** for E2E tests (in `e2e/`)

### Running Tests
- `npm test` — Run all server unit tests
- `npm run test:server` — Server tests only
- `npm run test:client` — Client tests only
- `cd server && npx vitest --watch` — Watch mode for server

**Vitest missing or `Cannot find package '@vitejs/plugin-react'`:** With `NODE_ENV=production`, npm omits devDependencies unless you pass `--include=dev`. Use `npm run install:all` (includes dev deps), or reinstall per package: `cd client && npm ci --include=dev`, same for `server/` and `mobile/`. CI and deploy workflows use `npm ci --include=dev` for reproducible installs.

### Where Tests Go
- **Server**: Co-located as `server/<module>.test.ts` (e.g., `stream-parser.test.ts`) or in `server/test/` for API integration tests
- **Client**: Co-located as `client/src/**/*.test.js` (e.g., `utils/humanCron.test.js`)
- **E2E**: In `e2e/tests/*.spec.js`

### Test Patterns
- Use `describe`, `it`, `expect` from Vitest (globals enabled)
- Server API tests use `supertest` with the Express app from `server/test/setup.ts`
- Client utility tests are pure function tests — no React component rendering needed for utils
- Mock external dependencies (CLI spawning, file system) when testing server logic

### Tests MUST NOT spawn the real CLI binaries

Server tests must never spawn the real `claude`, `cursor-agent`, `gemini`, or `codex` CLIs. This is a hard rule, not a style preference.

**Why:** A real `claude` invocation holds ~250 MB RSS, takes seconds-to-minutes to settle, and — crucially — gets reparented to init if its parent test process exits before it finishes. Earlier this happened: tests that forgot to mock `child_process` left ~20 orphaned `claude` processes accumulating on the prod box, which eventually swap-thrashed the host into 83% I/O wait. We don't want that to be possible.

**How it's enforced:**
- `server/test/setup.ts` (the global vitest `setupFiles`) points `CLAUDE_BIN` / `CURSOR_BIN` / `GEMINI_BIN` / `CODEX_BIN` at `server/test/fixtures/no-real-cli-in-tests.sh`, which exits non-zero with a loud pointer to this rule.
- The same file monkey-patches `child_process.{spawn,spawnSync,execFile,execFileSync}` to throw immediately if any of the forbidden binary names is the command.
- Either layer will surface the offending test loudly. Don't try to defeat the guard — fix the test.

**How to mock instead:**
- Tests that exercise a chat / heartbeat / room-chat path: mock the wrapper module, not `child_process`. Example: `vi.mock('./heartbeat.js', () => ({ runClaude: vi.fn().mockResolvedValue('mocked') }));`
- Tests that need to assert on the spawn args themselves: mock `child_process` directly with `vi.mock('child_process', ...)` and inspect calls. See `server/heartbeat-run-claude-model.test.ts` for the pattern.
- Tests that need a fake CLI process behavior (stream events, exit codes): use a `MockProc` that implements `stdout`/`stderr`/`on('close')` rather than spawning a real binary.

### What to Test
- **New utility functions**: Unit test inputs/outputs and edge cases
- **New API endpoints**: Integration test with supertest (request → response)
- **Bug fixes**: Write a test that would have caught the bug before fixing it
- **Complex logic**: State machines, parsers, data transformations

### What NOT to Test
- Simple CRUD wiring with no logic (e.g., a route that just calls a prepared statement and returns the result)
- UI layout/styling (that's E2E territory)

## OpenAPI Schema Coverage — Every Route Needs a Zod Registration

The published REST surface is auto-documented from Zod schemas registered at module load. The committed `docs/api/openapi.yaml` is the output of `npm run generate:openapi`, which imports every `server/routes/*.ts` and walks the singleton `OpenAPIRegistry`. Two checks keep this honest — both run on `push: main` in `.github/workflows/api-docs.yml` (post-merge informational, NOT a PR gate as of the CI baseline cleanup):

1. **Coverage ratchet** — `scripts/check-openapi-coverage.ts` (`npm run check:openapi-coverage`).
   Counts `router.<verb>(...)` handlers vs. `registry.registerPath(...)` calls per file (inline + `<name>.openapi.ts` companion). Per-file allowances live in `scripts/openapi-coverage-baseline.json`; any file exceeding its allowance fails the post-merge run. New files default to **0 allowed** — they must come with schemas.
2. **Freshness gate** — `scripts/check-openapi-freshness.ts` (`npm run check:openapi-freshness`) regenerates the spec into a tmp file and diffs against the committed `docs/api/openapi.yaml`. The api-docs workflow also runs `git diff --exit-code` on the same path after `generate:openapi`. Any drift fails the post-merge build with instructions to run `npm run generate:openapi`.

Because these only fire on main, you can land a PR that breaks them. The convention is: regenerate locally and commit before pushing — run `npm run check:openapi` (alias for coverage + freshness) before opening the PR.

### Workflow when adding or changing a route

1. Add the `router.<verb>(path, handler)` mount in `server/routes/<name>.ts`.
2. Add `registry.registerPath({ method, path, ... })` either inline (small files) or in the sibling `server/routes/<name>.openapi.ts` companion (preferred for larger files — keeps the route file readable).
3. Run `npm run generate:openapi` to refresh `docs/api/openapi.yaml`.
4. Commit both the route change and the regenerated YAML.

### Migrating a legacy route file

If a file is still listed in `scripts/openapi-coverage-baseline.json` with `allowed_unregistered > 0`, lowering the number is welcome in any PR. Run `npm run check:openapi-coverage` — when a file dips below its baseline the script prints a `Suggested baseline patch:` block you can paste into the JSON.

### When the lint check fires falsely

`router.use(...)` mounts (middleware) do not match the handler regex (`get|post|put|delete|patch`), so adding middleware is unaffected. If you add a new HTTP verb (e.g., `options`) the matcher must be extended in `server/openapi-coverage.ts`.

Wiki page with full context: `openapi-coverage-enforcement-zod-schema-lint`.

## Development Notes

- The server is **TypeScript** (strict mode) running via `tsx` — no build/dist step needed
- All server source files are `.ts`; imports use `.js` extensions per ESM convention (TypeScript resolves `.js` → `.ts`)
- Core types live in `server/types.ts` (DB row types, `Stmts`, `RouteDeps`, `Project`, `Agent`, stream events, etc.)
- The server runs as an ES module (`"type": "module"`)
- SQLite WAL mode enabled for concurrent access
- WebSocket handles chat streaming, cancellation, and real-time updates
- Agent configurations are stored in `server/agents.json` and auto-saved
- See `README.md` for general project documentation; this CLAUDE.md provides AI agent-specific guidance

## Finalize CI Runners (DinD — GHA parity)

ci.yaml v2 jobs with `runs-on: ubuntu-24.04` execute inside **privileged DinD runner containers** — one container per job instance (matrix shard), each with its own inner `dockerd`. This matches GitHub Actions (one VM = one Docker daemon) so parallel E2E shards can all bind default ports (`8001`, `4300`) without collision.

### Runner image

- **Image**: `agent-hub/finalize-runner:ubuntu-24.04` (local dev) or `public.ecr.aws/h9t4v7h0/agent-hub-finalize-runner:main` (prod)
- **Build (local only)**: `server/finalize/runner/build.sh`
- **CI + deploy**: pushed alongside the server image on every merge to `main` (`.github/workflows/ecr-publish-rollout-docker-dev.yml`). EC2 user-data and `agenthub-server-run.sh` pull the runner on every Hub restart and set `FINALIZE_RUNNER_IMAGE_UBUNTU_24_04` on the Hub container.
- **One-time ECR setup**: create the `agent-hub-finalize-runner` public repo (see `ops/terraform/ecr-public.tf` runbook). Extend the GitHub OIDC push policy if Terraform is not applied yet.

### How it works

- Agent Hub starts one long-lived runner per job: `docker run -d --privileged ... entrypoint.sh daemon`
- All steps in that job run via `docker exec` into the same container
- Nested `docker compose` talks to the **inner** daemon; Cypress hits `127.0.0.1` / `mcsteen.localhost` inside the runner
- Job teardown: `docker rm -f -v` removes the runner and its inner graph volume

### Host requirements

- The Finalize host must allow **privileged** `docker run` from the Agent Hub process
- If Agent Hub itself runs in Docker, its container needs host docker access **and** permission to spawn privileged siblings
- **RAM**: recommend **16GB+** when running backend + frontend + 4 E2E shards concurrently (~6 inner dockerds). Tune `FINALIZE_MAX_PARALLEL_JOBS` (default 4) if needed
- **Disk**: inner compose images accumulate per job; repo scripts should `docker compose down -v`; outer `docker rm -v` clears the per-job graph volume

### GitHub-parity resource caps (gate runner) vs pre-prod runner

A correctness gate must **not** be faster or beefier than the GitHub-hosted runner it stands in for. A more powerful runner launders timing-sensitive failures: PR surveytracker#1001 was Finalize-green / GitHub-red because the runner's extra CPU let a Cypress `input:visible` 10s timeout pass that blew on a 2-vCPU GitHub runner. So every Finalize job container is CPU/memory-capped to approximate a GitHub-hosted runner.

- **Gate runner (default)**: GitHub-parity, constrained. `docker run` gets `--cpus`, `--memory`, and `--memory-swap` (== `--memory`, so the RAM cap is hard with no swap headroom). Resolved from env in `server/finalize/runner-resource-profile.ts`; applied in the shared `buildStartJobContainerArgv` so the Hub-local and remote runner-agent paths cap identically.
- **Pre-prod runner**: ECS/prod-like, intentionally unconstrained — for perf/soak/preview work where matching production capacity matters, **not** for the pass/fail gate. Select with `FINALIZE_RUNNER_RESOURCE_PROFILE=unconstrained`.

GitHub-hosted standard Ubuntu runner specs (verified June 2026, [docs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)): public repos 4 vCPU / 16 GB; private repos 2 vCPU / 8 GB; `ubuntu-slim` 1 vCPU / 5 GB.

The runner auto-derives the tier from the **gated repo's GitHub visibility** (detected Hub-side from the worktree's `origin` remote via `gh api repos/{owner}/{repo} --jq .visibility`, cached per slug in `server/finalize/runner-repo-visibility.ts`): a **public** repo gets `ubuntu-public` (4 vCPU / 16 GB) for exact parity, a **private**/**internal** repo gets `ubuntu-private` (2 vCPU / 8 GB). When visibility can't be resolved (no GitHub remote, no token, gh missing, network/timeout) it falls back to the **stricter `ubuntu-private` default** — the safe direction, since a detection miss can only run the gate at-or-slower-than GitHub, never faster. An explicit `FINALIZE_RUNNER_RESOURCE_PROFILE` always wins over the derived tier. The visibility flows through `JobClaimSpec` → both the local and remote (wire-spec) runner backends, so the fleet runner-agent caps identically.

Config (env):

- `FINALIZE_RUNNER_RESOURCE_PROFILE` — explicit override that wins over visibility detection: `ubuntu-public`, `ubuntu-private`, `ubuntu-slim`, or `unconstrained`. When unset, the tier is auto-derived from repo visibility (default `ubuntu-private` when unknown). Unknown names fall back to the visibility-derived tier (else the stricter default) — a typo never silently uncaps the gate.
- `FINALIZE_RUNNER_CPUS` — override CPU cores (layers on the base profile).
- `FINALIZE_RUNNER_MEMORY` — override RAM, bytes or docker suffix (`16g`, `512m`, …).

### Escape hatch

- `FINALIZE_RUNNER_DOCKER_MODE=host-socket` restores legacy behavior (mount host `/var/run/docker.sock`, one ephemeral container per step, `host.docker.internal` for port probes). Use only for debugging.
- `FINALIZE_RUNNER_RESOURCE_PROFILE=unconstrained` removes the GitHub-parity CPU/memory caps (legacy full-host behavior). Use for the pre-prod runner or local debugging — never for the gate.

### Key files

- `server/finalize/job-container.ts` — job-scoped start / exec / stop
- `server/finalize/runner-exec-args.ts` — shared pure `docker run` / `docker exec` argv builders (parity seam)
- `server/finalize/runner-resource-profile.ts` — GitHub-parity CPU/memory cap resolution
- `server/finalize/runner-image-versions.ts` — targeted Node/Docker/Compose/Buildx versions (mirrors the GitHub ubuntu-24.04 manifest; soft-pinned in the Dockerfile, drift-tested). Bump here + the Dockerfile ARGs together when GitHub updates the image.
- `server/finalize/runner/entrypoint.sh` — starts inner dockerd
- `server/finalize/runner-docker-mode.ts` — `dind` vs `host-socket`

## Deployment

### Production Server (generic single-host topology)
- **Host**: configure per your environment (any Linux host with Node 22+; the original reference deployment was a single EC2 instance, but nothing in the app assumes EC2).
- **Nginx** reverse proxy on port 80 → localhost:3051
- **PM2** manages the Node.js process
- **Port 3051** is localhost-only — all external traffic goes through Nginx
- **Spawned CLI `AGENT_HUB_URL`**: the server injects `AGENT_HUB_URL` for child processes (skills, kanban scripts). It defaults to loopback; if tool sandboxes cannot reach `127.0.0.1`, set **`AGENT_HUB_AGENT_URL`** (or **`agentHubUrl`** in `config.json`) to a base those hosts can reach (often the same URL as **`AGENT_HUB_PUBLIC_URL`** / **`publicUrl`**, which is used automatically when set—including path prefixes so spawned CLIs hit the same `/api/...` namespace as OAuth redirects). See `resolveAgentHubApiBaseForSpawn` in `server/config.ts`.
- Deploy: `ssh → git pull → npm install && npm run build && (cd server && npm install) → pm2 start ecosystem.config.cjs` (or `pm2 restart agent-hub`). The API is TS (`tsx index.ts`); do not point PM2 at `index.js`.

### CORS — `ALLOWED_ORIGINS`
- Browser requests to the API are gated by an explicit origin allowlist in `server/cors-config.ts`.
- Set the `ALLOWED_ORIGINS` env var to a **comma-separated** list of origins (no trailing slash):
  - **Production** (`ecosystem.config.cjs`): `https://hub.example.com` — update to your real web-app URL before opening to users. Override per-deploy with `ALLOWED_ORIGINS=https://hub.your-domain pm2 restart agent-hub`.
  - **Dev** (`npm run dev`): defaults to `http://localhost:3050` (the Vite client) when the env var is unset. Override with `ALLOWED_ORIGINS=http://localhost:3050,http://localhost:4173 npm run dev:server` if needed.
- Requests with no `Origin` header (Electron desktop shell, React Native mobile, curl, server-to-server) are always allowed — only browsers enforce CORS.
- Unknown browser origins receive a normal HTTP response with **no** `Access-Control-Allow-Origin` header; the browser's SOP then blocks the response from reaching the caller.
- The public bug-report intake endpoint at `POST /api/bug-reports` keeps its own `Access-Control-Allow-Origin: *` via `server/routes/bug-reports.ts` (intentionally cross-origin, rate-limited).

### Rate limiting — `trust proxy` is coupled to the proxy topology
- `server/index.ts` sets `app.set('trust proxy', 'loopback')` so `req.ip` resolves via `X-Forwarded-For` from our local nginx (127.0.0.1). This is what lets the per-IP login / invite-accept rate limiters in `server/routes/auth.ts` see the real client IP.
- **If the topology ever changes** (moving behind AWS ALB, Cloudflare, or any non-loopback proxy), this value MUST be revisited. `'loopback'` will drop the forwarded IP outside 127.0.0.1 and per-IP limits will collapse to a single bucket (the edge proxy's IP). See the express docs on `trust proxy` for the hop-count / CIDR / `true` options.
