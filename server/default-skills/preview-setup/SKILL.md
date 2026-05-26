---
name: preview-setup
description: >-
  Default guided walkthrough for Docker Compose preview setup. Triggered by
  Settings → Preview or POST .../preview/setup-wizard. Reads README, handles
  monorepos (multiple compose services), collects env vars, persists via
  setup-apply, validates with preview/build.
version: 3.0.0
keep-coding-instructions: true
---

# Preview Setup — Guided Walkthrough (default)

**Settings → Preview → Start setup** is the primary path (scan, edit compose/env, **Build and run**). Use this walkthrough only when the user clicks **Agent walkthrough** or asks for help in chat.

## Bound values

- **`PROJECT_ID`**, **`PROJECT_CWD`** — from kickoff.
- **`$AGENT_HUB_URL`**, **`$AGENT_HUB_API_KEY`** — set for curl. If any wizard curl returns HTTP **401** or **403**, halt — see [Auth failure](#auth-failure) below. **Never** ask the operator to paste a token into chat.

## Draft (start here)

Kickoff includes full `draft` JSON:

| Field | Use |
|-------|-----|
| `isMonorepo` | Extra care: list all services, explain UI vs backend |
| `composeCandidates` | Each compose file + `services[]` with ports |
| `detected` / `bootstrap` | Defaults for asks |
| `readme` | `setupExcerpt`, `readmePath` |
| `envVars` | Keys + `sources` + `required` |
| `scriptHints` | How devs run apps locally |

**Do not** re-scan the repo unless the user changed files mid-session.

## Step 1 — README

Read `README.md` under `<PROJECT_CWD>`. Summarize local dev and docker instructions in 2–4 sentences before any `agenthub:ask`.

## Step 2 — Monorepo / multi-service

When `isMonorepo` **or** more than two services:

1. Print a bullet list: `serviceName` → role guess (web UI, API, worker, db) using README + compose build commands.
2. First `agenthub:ask` (if multiple compose files in `composeCandidates`): pick compose **file** path.
3. Second `agenthub:ask`: pick **entry service** — one option per service in that file, with descriptions (ports from draft).

Single-service repos: one ask combining file confirmation + entry service.

## Step 3 — Bootstrap compose

If `phase === "bootstrap_compose"`:

- Show YAML from `bootstrap.composeYaml`.
- Ask approval to write `bootstrap.file`.
- `POST .../preview/setup-compose-bootstrap` with `{ file, content, overwrite: false }`.

## Step 4 — Ports, health, routes

`agenthub:ask` for entry port, health path (`preview.compose.healthPath`), env file, idle TTL, capture routes. Use draft defaults as option labels.

## Step 5 — Environment variables

For each `draft.envVars` entry (required first):

- Ask in prose for values.
- `kind: secret` for tokens/passwords; `plain` for public URLs.

Bundle into `setup-apply`:

```json
"secrets": { "mode": "merge", "env": "KEY=value\\n", "defaultKind": "secret" }
```

## Step 6 — Persist + validate

```bash
curl -s -X POST .../preview/setup-apply -d '{ "enabled": true, "preview": { "compose": { ... } }, "secrets": { ... } }'
curl -s -X POST .../preview/build -d '{ "compose": { ... }, "envVars": [...] }'
# or preview/test when build is not suitable
curl -s -X POST .../preview/wizard-complete
```

```xml
<agenthub:close-card>
{"reason": "already-done", "note": "Preview walkthrough complete."}
</agenthub:close-card>
```

## Rules

- **Fenced** `agenthub:ask` only (≥2 options per question). JSON must use **`question`**, **`header`**, and **`options[].label`** + **`options[].description`** — not `prompt`, `id`, or `type` (those show as raw code in chat).
- Multiple ask rounds are expected for monorepos.
- Never `startScript` / `processes[]` preview mode.
- Prefer pointing users to **Settings → Preview** for compose/env edits and **Build and run**; use chat asks for choices you cannot infer from the draft.

## Auth failure

**Trigger:** a wizard curl returns HTTP **401** or **403**. That is the actual auth-rejected signal. Do **not** fire this rule on an empty `$AGENT_HUB_API_KEY` alone — on an **open** hub (no `apiKey` in config, no user signed up via `/api/auth/setup`), an empty key is fine and requests pass through. Treat other HTTP errors (404, 5xx, transport failures) as wizard or hub bugs, not auth failures.

When a 401 or 403 lands: the Hub is auth-gated and the spawn-time credentials missed (or are stale). **Do not** try to work around it by asking the user for a token, prompting them to paste a bearer string into chat, or instructing them to export an env var into the spawned session. The env was frozen at spawn time and cannot be updated from chat; the only fix is to set the key on the server and start a new session.

Halt the wizard and tell the operator, verbatim, one of:

1. **`PATCH /api/config` (hot path, recommended)** — run `curl -X PATCH "$AGENT_HUB_URL/api/config" -H "x-api-key: <existing-or-empty>" -H "Content-Type: application/json" -d '{"apiKey": "<value>"}'`. The handler mutates the live in-memory config and persists to `~/.agent-hub/data/config.json` in one shot, so the change is effective for both new spawns and the running auth middleware — no restart needed.
2. **Direct file edit (cold path)** — edit `apiKey` in `~/.agent-hub/data/config.json`, then **restart the server** (`pm2 restart agent-hub` on a deployed host, or stop/start the local process). The server only reads `config.apiKey` from the file at boot; without a restart, the new key sits on disk while the auth middleware keeps validating against the old in-memory copy and the next curl 401s again.
3. **Escalate to a Hub admin** if the operator has neither `PATCH /api/config` nor restart access.

The wiki page **replacing-the-static-api-key-per-user-ahub-tokens-invite-flow** is the canonical reference for the multi-user auth model — it covers the advanced per-user `ahub_*` invite flow, which is adjacent context rather than the fix for this specific error. For this error, paths 1 and 2 above are the resolution.

Then exit the walkthrough — do not retry the curls until the operator confirms the key is set (and the server has been restarted, if they took path 2) and starts a new session.
