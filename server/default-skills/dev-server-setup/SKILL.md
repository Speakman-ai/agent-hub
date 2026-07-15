---
name: dev-server-setup
description: >-
  Guided walkthrough for authoring a project's managed dev-server config
  (`prEnv.devServer`). Triggered by Settings → Dev Server → Agent walkthrough
  or POST .../dev-server/setup-wizard. Reads the server-precomputed repo scan
  (start-command candidates, package manager, monorepo layout, framework/port
  guesses, existing config, README), confirms the start command, port map,
  health path, and env/secret split interactively, then persists via
  dev-server/setup-apply. Config lives in projects.json — there is no repo
  commit.
version: 1.0.0
keep-coding-instructions: true
---

# Dev Server Setup — author `prEnv.devServer`

Agent Hub runs the project as a **managed long-lived process** for session
previews: it spawns `devServer.startCommand` inside the session env, injects
non-secret env + resolved secrets, and maps `portMap[]` internal ports out
through the authenticated preview proxy. Your job is to author that config with
the user, then POST it to `setup-apply`.

Unlike the preview/rum/finalize wizards, this one writes **no repo file** — the
config is stored in the project record (`projects.json`). So there is nothing to
commit and nothing for Finalize to push. This is still a worktree-backed
session, which lets the user click **Start preview** afterward to boot the dev
server and verify the config live.

## Bound values

- **`PROJECT_ID`**, **`PROJECT_CWD`** — from kickoff. `PROJECT_CWD` is where the
  draft was scanned; your working directory is this session's worktree clone.
- **`$AGENT_HUB_URL`**, **`$AGENT_HUB_API_KEY`** — set for curl. Send
  `-H "X-API-Key: $AGENT_HUB_API_KEY"` on `setup-apply` and `wizard-complete`.
  If a wizard call returns HTTP **401**/**403**, halt and report the auth
  failure. **Never** ask the operator to paste a token into chat.

## Draft (start here)

The kickoff prompt embeds a server-computed draft — do **not** re-run scanners.
Key fields:

- `startCommandCandidates[]` — each `{ command, script, raw, recommended }`
  parsed from `package.json` scripts (package-manager aware). Offer these as
  `agenthub:ask` options, recommended first.
- `packageManager` — `npm` | `pnpm` | `yarn` | `bun` | null.
- `isMonorepo` / `monorepoDirs[]` — when true, decide whether the command runs
  from the repo root or a subdir; set `devServer.cwd` to the subdir.
- `frameworks[]` / `portGuesses[]` — inferred defaults for the port map.
- `healthPathGuess` — sensible readiness path default (usually `/`).
- `existing` — the project's current `prEnv.devServer` (edit it, do not clobber).
- `readme` — `{ path, excerpt }` for how the team runs the app locally.

## `prEnv.devServer` schema (mirror `server/dev-server-config.ts`)

| Field | Contract |
| --- | --- |
| `startCommand` | Non-empty string, run via `sh -c` from `cwd`/worktree root. Default `npm run dev`. Run backing services first if needed, e.g. `docker compose up -d --wait db && npm run dev`. |
| `env` | Map of **non-secret** `KEY: value`. POSIX key names. Reserved keys rejected: `PORT`, `AGENT_HUB_*`, `NODE_*`, `PATH`, `HOME`. |
| `secretKeys` | Array of secret **names** only — references into the encrypted project-secrets store. Must be disjoint from `env`. Plaintext never goes here. |
| `portMap` | Up to 16 `{ internalPort, label, primary? }`. Unique ports; exactly one `primary` (auto-promoted to the first if you omit it). Primary keeps `/preview/proxy/`; extras get `/preview/proxy/p/<port>/`. |
| `healthPath` | Optional readiness path on the primary port. Must start with `/`. |
| `readyTimeoutMs` | Optional int, 5000–3600000. Max wait for `healthPath` 2xx before the preview flips to failed. |
| `cwd` | Optional worktree-relative subdir (monorepo). No leading `/`, no `..`. |

## Walkthrough

1. **Read the README** at `PROJECT_CWD/<draft.readme.path>` and summarize local run steps.
2. **Start command** — `agenthub:ask` with `startCommandCandidates[].command`. For a monorepo, set `cwd` to the app subdir.
3. **Port map** — ask for each internal port + short label; mark one primary. Seed defaults from `portGuesses`.
4. **Health path** — ask (default `draft.healthPathGuess`); optional.
5. **Env vs secrets** — scan `process.env` / `import.meta.env` usage (`Read`/`grep` the source). For each var, ask whether it is non-secret (→ `env`) or a secret (→ `secretKeys` + a value stored via `secrets.env`). Never echo secret values back.

## Persist

```bash
curl -s -X POST "$AGENT_HUB_URL/api/projects/$PROJECT_ID/dev-server/setup-apply" \
  -H "X-API-Key: $AGENT_HUB_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "devServer": {
      "startCommand": "npm run dev",
      "cwd": "apps/web",
      "env": { "API_BASE_URL": "http://localhost:4000" },
      "secretKeys": ["STRIPE_SECRET_KEY"],
      "portMap": [{ "internalPort": 3000, "label": "web", "primary": true }],
      "healthPath": "/"
    },
    "secrets": { "env": "STRIPE_SECRET_KEY=sk_test_...", "defaultKind": "secret" }
  }'
```

- `devServer.env` holds non-secret values; `devServer.secretKeys` lists secret
  NAMES; the plaintext secret values go in `secrets.env` as dotenv `KEY=value`
  lines (stored encrypted, referenced by name — never inlined into the config).
- On HTTP **400** the body is `{ "error": "prEnv.devServer.<path>: <message>" }`
  — fix that field and retry.

## Finish

1. Tell the user they can click **Start preview** on this session to boot the dev server and confirm it comes up on the mapped port.
2. `curl -s -X POST "$AGENT_HUB_URL/api/projects/$PROJECT_ID/dev-server/wizard-complete" -H "X-API-Key: $AGENT_HUB_API_KEY"` so Settings refetches.
3. End with `<agenthub:close-card>`.

Do **not** create a new branch and do **not** create or move any kanban card.

## Auth failure

A `401`/`403` from a wizard curl means the injected `$AGENT_HUB_API_KEY` was not
accepted. Halt, report the exact status and endpoint, and stop — do not retry in
a loop and never ask the operator to paste a token into chat.
