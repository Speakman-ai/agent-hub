---
name: preview-setup
description: >-
  Cursor-style interactive wizard that walks the user through configuring
  `prEnv.preview` for a project. Inspects the repo, runs the static
  detector as a baseline, scans source files for `process.env.X` /
  `import.meta.env.VITE_X` usages, and emits a single `agenthub:ask`
  block to confirm the draft + collect values for required env keys.
  TRIGGER only when a wizard session was spawned by
  `POST /api/projects/:id/preview/setup-wizard` and the project id has
  been injected into the prompt.
version: 1.0.0
keep-coding-instructions: true
---

# Preview Setup Wizard

You are running inside a **one-shot wizard session** spawned by the
Agent Hub server. Your job is to figure out how to boot this project's
dev server so the worktree-preview runtime can spawn it on demand, and
to persist the resulting `prEnv.preview` config to `projects.json`.

The wizard is **read-only with respect to source code**: you may read
files and run npm/grep/find, but you must **never modify code** in the
project workspace. The only mutations you make are HTTP calls to the
local Agent Hub API to persist config and secrets.

## What you will receive

- `$PREVIEW_WIZARD_PROJECT_ID` — the project slug. Use it on every API
  call.
- `$PREVIEW_WIZARD_CWD` — absolute path to the project checkout on
  disk. Your CWD is already set to this directory.
- `$AGENT_HUB_URL` / `$AGENT_HUB_API_KEY` — REST base + auth header for
  the local API.

## Required steps

### 1. Run the static detector as a baseline

The server exposes the same `detectPreviewDefaults()` helper the
new-project wizard uses. Call it first and treat its result as your
starting draft:

```bash
curl -s -X POST \
  -H "x-api-key: $AGENT_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$AGENT_HUB_URL/api/projects/$PREVIEW_WIZARD_PROJECT_ID/preview/detect"
```

If `detected` is non-null, the baseline is `{ startScript, port,
captureRoutes, idleTTL }` plus a `stack` tag (`vite`, `next`, …,
`fullstack-django-react`, `fullstack-monorepo`, `fullstack-scripts`).
If `detected` is null, build the draft from scratch — see step 2.

### 2. Scan the workspace

Walk `src/`, `app/`, `pages/`, `backend/`, `frontend/`,
`apps/*/src` for source files (`.js`, `.jsx`, `.ts`, `.tsx`, `.py`,
`.rb`, `.go`, `.rs`, `.svelte`, `.vue`) and **grep for environment
variable reads**:

- `process.env.FOO` / `process.env['FOO']`
- `import.meta.env.VITE_FOO`
- `os.environ['FOO']` / `os.environ.get('FOO')`
- `ENV['FOO']` / `ENV.fetch('FOO')` (Ruby)
- `os.Getenv("FOO")` (Go)

The bundled helper does this for you:

```bash
bash "$AGENT_HUB_SKILL_DIR/scripts/scan-env-usage.sh" "$PREVIEW_WIZARD_CWD"
```

It emits one env-key per line, deduped. **Skip `NODE_ENV`,
`PATH`, `HOME`, `PWD`, `CI`, and any key starting with `VITE_PUBLIC_`**
— those are runtime-platform vars or already-public values that don't
need to be collected from the user.

Also enumerate npm scripts to make sure your draft `startScript` is
plausible:

```bash
bash "$AGENT_HUB_SKILL_DIR/scripts/scan-package-scripts.sh" "$PREVIEW_WIZARD_CWD"
```

### 3. Propose a draft and ask the user

Emit **one** `agenthub:ask` fenced block with at most 4 questions
covering:

- **Start script** (single-select). Options: the detected default, the
  most plausible alternatives from `scan-package-scripts.sh`, and an
  "Other…" row (the picker UI supplies that automatically — do not add
  one yourself).
- **Health path** (single-select). Default `/`; include `/healthz`,
  `/api/health` as alternatives.
- **Required env keys** (multi-select). One option per env key you
  found in step 2. The user toggles which ones are truly required for
  boot.
- **Optional capture routes** (multi-select). Suggested routes you
  found in `pages/` / `app/` / from React Router config.

Use `multiSelect: true` for the env-keys and routes questions;
`multiSelect: false` for the start-script and health-path questions.

### 4. Collect values for the required env keys

After the user confirms which env keys are required, **ask in plain
prose** for each value. The values go into the secret store —
`POST /api/projects/:id/preview/secrets/import` with `mode: 'merge'`.
Treat anything that *looks* like a secret (API keys, tokens, JWTs,
DB connection strings, anything with the substring `KEY`, `TOKEN`,
`SECRET`, `PASSWORD`, `DSN`) as `kind: 'secret'`; everything else as
`kind: 'plain'`.

### 5. Persist the config

Two API calls, in this order:

1. **Project preview config** via PATCH:

   ```bash
   curl -s -X PATCH \
     -H "x-api-key: $AGENT_HUB_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"prEnv":{"healthPath":"/","preview":{"enabled":true,"startScript":"npm run dev","captureRoutes":["/"],"idleTTL":600}}}' \
     "$AGENT_HUB_URL/api/projects/$PREVIEW_WIZARD_PROJECT_ID"
   ```

2. **Preview secrets** via the import endpoint with `mode: 'merge'`:

   ```bash
   curl -s -X POST \
     -H "x-api-key: $AGENT_HUB_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"mode":"merge","env":"FOO=bar\nBAR=baz\n","defaultKind":"secret"}' \
     "$AGENT_HUB_URL/api/projects/$PREVIEW_WIZARD_PROJECT_ID/preview/secrets/import"
   ```

### 6. Optional — verify boot

If the user opted in to a verification run, call:

```bash
curl -s -X POST \
  -H "x-api-key: $AGENT_HUB_API_KEY" \
  "$AGENT_HUB_URL/api/projects/$PREVIEW_WIZARD_PROJECT_ID/preview/test"
```

Report the `ok` / `error` / `durationMs` to the user in your summary.

### 7. Tell the server the wizard finished

When (and only when) both persistence calls in step 5 succeeded, ping
the completion endpoint so the open Settings panel refetches the
project:

```bash
curl -s -X POST \
  -H "x-api-key: $AGENT_HUB_API_KEY" \
  "$AGENT_HUB_URL/api/projects/$PREVIEW_WIZARD_PROJECT_ID/preview/wizard-complete"
```

The server broadcasts a `preview_wizard_complete` WebSocket event.

### 8. Close the linked kanban card

End your turn with an `<agenthub:close-card>` block citing
`already-done` so the wizard's own session card is moved to Done:

```
<agenthub:close-card>
{"reason": "already-done", "note": "Preview config persisted. healthPath=/, startScript='npm run dev', 3 secrets."}
</agenthub:close-card>
```

## What NOT to do

- Don't run the dev server yourself — the runtime's `preview/test`
  endpoint exists for that, and it handles teardown.
- Don't write to disk in the project workspace.
- Don't ask the user the same question twice — collapse into a single
  `agenthub:ask` block at step 3.
- Don't echo secret values back into chat after collecting them — the
  Agent Hub Secret Store will mask them on subsequent reads anyway.
