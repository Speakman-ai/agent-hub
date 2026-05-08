---
name: 1password
description: >-
  Fetch secrets, inject env vars, and (with explicit confirmation) create or
  update items in 1Password via the op CLI. TRIGGER when: the user mentions
  "1password", "1Password", "op CLI", references an "op://" secret reference
  URI (e.g. op://vault/item/field), asks to fetch, inject, read, or look up a
  secret from their vault, mentions "Service Account token" in a 1Password
  context, or asks to run a command with secrets injected from 1Password.
  DO NOT TRIGGER on: unrelated "password" questions, password-reset flows,
  general credential management not specific to 1Password, or "op" as an
  abbreviation for "operation" / "operator" unless an op:// URI or the
  "1Password CLI" is clearly in view.
category: integration
version: 1.0.0
keep-coding-instructions: true
credentials:
  - name: OP_SERVICE_ACCOUNT_TOKEN
    label: 1Password Service Account Token
    description: >-
      Service Account token from 1Password (service-accounts.1password.com).
      Stored encrypted in Agent Hub Settings — never paste into chat.
      Preferred for headless / cron / heartbeat work (no biometric prompt).
      See https://developer.1password.com/docs/service-accounts/get-started
    required: false
    type: secret
    docs_url: https://developer.1password.com/docs/service-accounts/get-started
---

# 1Password

Use this skill to interact with 1Password vaults via the **`op` CLI** — read
secrets, inject env vars into commands, list items, and (with confirmation)
create or update items.

> ⚠️ **Writes require confirmation.**  
> Read operations run immediately. Any mutation (`op item create`, `op item edit`,
> `op document create`, etc.) **must be confirmed by the user first** — show the
> field names and item title, never the secret values, before executing.

## Prerequisites

### `op` CLI

All scripts require the **1Password CLI (`op`)** on `$PATH`.

- macOS: `brew install --cask 1password-cli`
- Linux / other: https://developer.1password.com/docs/cli/get-started#install
- Verify: `op --version`

### `python3`

`op-list.sh` and `op-read.sh item` use **Python 3** (3.6+) for JSON formatting.
Present by default on macOS and standard Linux distributions.

- macOS: `brew install python3` (if missing)
- Linux: `sudo apt-get install python3` (Debian/Ubuntu) or `sudo yum install python3` (RHEL)
- Verify: `python3 --version`

### Authentication

**Preferred (headless / cron-safe): Service Account**  
Set `OP_SERVICE_ACCOUNT_TOKEN` under **Settings → Skills → Credentials →
1Password** in Agent Hub. The token is injected automatically into every agent
session — no biometric prompt needed.

See [references/auth-modes.md](references/auth-modes.md) for the full resolution
order and how to create a Service Account.

**Fallback: biometric / interactive session**  
If no Service Account token is configured, the scripts fall back to an existing
`op` session on the host (e.g. started via `eval $(op signin)`). This only works
in interactive sessions — not crons or heartbeats.

## Safety Model — Read-default, Write-on-confirm

**Read operations** (item get, item list, vault list, read, inject, op run) run
immediately.

**Write operations** (`op item create`, `op item edit`, `op document create`,
`op document edit`) are **out of scope for this skill version**. Do not
attempt them with the current scripts. If a user requests a write operation,
explain that write support is not yet available and suggest using the `op` CLI
directly with care.

## Security Rules (non-negotiable)

- **Never log or echo secret values.** The wrappers mask `op://` references and
  any value that looks like a resolved secret in stdout/stderr before surfacing
  output to the model.
- **Never expose `OP_SERVICE_ACCOUNT_TOKEN` in chat, daily notes, or card
  descriptions.** If you need to diagnose auth, use `op whoami` (no secrets in
  the output).
- **Prefer `op run -- <cmd>` over plaintext exports.** This injects secrets as
  env vars into the child process without ever materialising them on disk or in
  the shell history.

## Quick Reference

```bash
# Check authentication / identity
scripts/op-read.sh whoami

# Read a single field value to stdout — capture; do NOT echo to chat
API_KEY=$(scripts/op-read.sh "op://Personal/AWSAccount/access_key_id")
my-tool --api-key "$API_KEY"

# List items (safe, read-only)
scripts/op-list.sh
scripts/op-list.sh --vault Shared --category Login
scripts/op-list.sh --tags automation

# List vaults
scripts/op-list.sh vaults

# Inject secrets into a command (preferred over plaintext export)
scripts/op-run.sh -- npm run deploy
scripts/op-run.sh --env-file .env.tpl -- docker-compose up -d

# Render a config template with op:// references resolved
scripts/op-run.sh inject -i config.tpl -o config.resolved
```

## Full Reference

- **[references/auth-modes.md](references/auth-modes.md)** — Service Account vs
  biometric vs Connect; token resolution; creating a Service Account; scoping
  vault access; error messages and fixes
- **[references/secret-references.md](references/secret-references.md)** — the
  `op://vault/item/field` URI scheme; special field names; template syntax for
  `op inject`; common pitfalls
- **[references/op-run-recipes.md](references/op-run-recipes.md)** — safe
  env-injection patterns with `op run`; config-file templating with `op inject`;
  CI/CD recipes; cron/heartbeat patterns

## Guardrails

- Never surface the value of a secret in chat output, daily notes, or kanban
  card comments.
- When diagnosing auth failures, use `op whoami` — its output contains no
  secrets.
- Do not attempt `op item create` / `op item edit` — write support is not yet
  shipped. Direct the user to use the `op` CLI directly for writes.
- All wrappers exit `2` with an actionable message when `op` is missing,
  `python3` is missing, the session is expired, or the Service Account token
  is invalid.
