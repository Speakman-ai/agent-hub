# Contributing to Agent Hub

Thanks for your interest in improving Agent Hub. This guide covers how to set
up the project, the conventions we follow, and how to get a change merged.

Agent Hub is mixed-license. First-party works owned by Ryan Speakman are
source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use of those
works requires a separate commercial license from Ryan Speakman
(see [`docs/licensing.md`](docs/licensing.md)). Unverified contributions
remain under Apache License 2.0.

PolyForm is only an outbound noncommercial grant to the public. Contributors
retain copyright. Agreeing that a contribution is "licensed under PolyForm"
does **not** give the licensor the right to commercially license the combined
work.

## Contributor agreement (required before every code contribution)

Every code contribution intended for the commercially licensed product,
including tests, documentation, and other copyrightable material that will
ship in the repository, is accepted **only** after the contributor has
completed one of:

1. the [Contributor License Agreement](CLA.md), which grants the licensor a
   perpetual, worldwide, sublicensable copyright and patent license that
   includes the right to license the contribution under PolyForm Noncommercial
   **and** under the licensor's commercial terms, or
2. a written copyright assignment of that contribution to the licensor.

**Maintainers must not merge such a contribution until a completed CLA or
copyright assignment is on file.** There is no maintainer discretion to skip
this for a small patch, and opening an issue does not replace the agreement.
PolyForm terms alone are not a contributor agreement for this purpose.

How to complete the CLA is in [CLA.md](CLA.md). You may open a pull
request before the CLA is completed. Put the acceptance statement from
CLA.md in the pull request description. Maintainers must not merge until
that statement is recorded. A checkbox is not a substitute. If your
employer owns rights in the contribution, the employer must complete the
agreement first. An AI agent cannot complete the CLA; the human copyright
holder must.

Bug reports and feature requests that do not include copyrightable patches
do not require a CLA.

Please also read our [Code of Conduct](CODE_OF_CONDUCT.md). For security
issues, follow the [Security Policy](SECURITY.md) instead of opening a public
issue.

## Ways to Contribute

- **Report a bug** — open a [bug report](.github/ISSUE_TEMPLATE/bug_report.yml).
- **Request a feature** — open a
  [feature request](.github/ISSUE_TEMPLATE/feature_request.yml).
- **Fix or build something** — pick up an open issue (or file one first for
  larger changes so we can agree on direction), then open a pull request.
- **Improve docs** — README, `docs/`, and inline guidance are all fair game.

For anything non-trivial, open an issue first. It saves you from building
something that conflicts with in-flight work or the project direction.

## Development Setup

Agent Hub is an npm monorepo with four surfaces: `server/` (TypeScript, ESM,
run via `tsx`), `client/` (React + Vite + Tailwind), `mobile/` (React Native +
Expo), and `electron/` (desktop shell).

Requirements: **Node.js `>=22.14.0 <23.0.0`** (run `nvm use` in the repo root)
and a working C toolchain for `better-sqlite3` (`build-essential python3` on
Linux, `xcode-select --install` on macOS).

```bash
git clone <your-fork-url>
cd agent-hub
npm run install:all      # root, server, client, mobile (includes dev deps)
npm run dev              # client on :3050, server on :3051
```

On first launch, open http://localhost:3050 and complete the `/api/auth/setup`
flow to create the first Owner account. No required env vars, no external
services: SQLite is local and FTS5 ships with `better-sqlite3`.

## Branch & PR Flow

Fork the repo (or, if you have write access, create a branch) and work from a
feature branch:

```bash
git checkout main && git pull
git checkout -b feature/your-change
```

- **Never commit directly to `main`**, and never push feature work to `main`.
- Keep each PR focused on one logical change.
- Rebase on the latest `main` before opening the PR.
- Fill out the [pull request template](.github/pull_request_template.md),
  including a **Summary** and a **Test plan**.
- Only maintainers merge to `main`.

## Code Conventions

- **ES Modules** throughout (`import` / `export`, no `require`).
- **TypeScript everywhere** — strict mode in `server/`, `client/`, `mobile/`,
  `shared/`, `electron/`, and `e2e/`. Server source is all `.ts`; ESM imports
  carry `.js` extensions (TypeScript resolves `.js` → `.ts`).
- **PascalCase** for React components, **camelCase** for functions/variables,
  **kebab-case** for file names.
- **Tailwind CSS** utility classes; dark theme by default.
- **Raw SQL** with prepared statements via `better-sqlite3` (no ORM).
- **Modular routes** — REST handlers live in `server/routes/` with a Zod schema
  registered for OpenAPI (see below).
- Never hardcode ports or CLI binary paths; config is centralized in
  `~/.agent-hub/data/config.json` (falling back to `server/config.json`).

Formatting and linting are enforced:

```bash
npm run format        # Prettier write
npm run format:check  # Prettier check (CI)
npm run lint          # ESLint
npm run lint:fix      # ESLint --fix
npm run typecheck     # tsc --noEmit across all packages
```

## Testing

**Every feature, bugfix, and refactor ships with at least one test.** PRs
without tests for new logic will be flagged in review. For a bug fix, write a
test that would have failed before your fix.

- **Vitest** for unit/integration tests, co-located as `server/<module>.test.ts`
  or `client/src/**/*.test.{ts,tsx}`.
- **Playwright** for E2E tests, in `e2e/`.

```bash
npm test              # server unit tests
npm run test:client   # client tests
cd server && npx vitest <file>   # run a single file while iterating
```

Hard rails in the test suite (do not defeat them):

- **Tests must not spawn the real `claude` / `cursor-agent` / `gemini` /
  `codex` CLIs.** Mock the wrapper module or `child_process`. A guard in
  `server/test/setup.ts` fails loudly if a real binary is spawned.
- **Tests must not hit a live deployment over the network.** A network guard
  throws on any non-loopback `fetch`. Mock `fetch` or the wrapper instead.

## API Changes — OpenAPI Coverage

Every REST route must be backed by a Zod schema registered with the
`OpenAPIRegistry`. When you add or change a route:

1. Mount the `router.<verb>(path, handler)` in `server/routes/<name>.ts`.
2. Register the schema with `registry.registerPath({ ... })`, inline or in a
   sibling `server/routes/<name>.openapi.ts` companion.
3. Regenerate the spec: `npm run generate:openapi`.
4. Commit both the route change and the regenerated `docs/api/openapi.yaml`.

Run `npm run check:openapi` before opening the PR to catch coverage or
freshness drift.

## Before You Open a PR

- [ ] The pull request description includes the CLA acceptance statement
      from [CLA.md](CLA.md) (or a copyright assignment is already on file).
      Maintainers will not merge without this. A checkbox is not a
      substitute.
- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` and `npm run format:check` pass.
- [ ] Relevant tests pass, and new logic has tests.
- [ ] `npm run check:openapi` passes if you touched a route.
- [ ] The PR description explains the change and how you tested it.

## AI-Agent Development

Agent Hub is often developed with AI agents running inside the platform itself.
The agent-specific conventions (session worktrees, the one-session-one-branch
invariant, control blocks, self-reporting) live in
[`CLAUDE.md`](CLAUDE.md). Human contributors do not need it, but it is the
source of truth for how in-hub agents work.

## Questions

Open a [feature request](.github/ISSUE_TEMPLATE/feature_request.yml) or a
regular issue with the `question` label. For security, use the
[Security Policy](SECURITY.md).
