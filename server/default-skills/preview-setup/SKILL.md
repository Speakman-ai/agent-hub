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
- **`$AGENT_HUB_URL`**, **`$AGENT_HUB_API_KEY`** — set for curl.

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
