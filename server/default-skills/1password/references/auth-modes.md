# Auth Modes — Service Account vs Biometric vs Connect

Three ways to authenticate the `op` CLI in an agent context. Service Account
is strongly recommended for any automated work.

Back to [SKILL.md](../SKILL.md).

## Contents

- [Token resolution order](#token-resolution-order)
- [Service Account (recommended)](#service-account-recommended)
  - [Creating a Service Account](#creating-a-service-account)
  - [Scoping vault access](#scoping-vault-access)
  - [Security best practices](#security-best-practices)
- [Biometric / interactive session (fallback)](#biometric--interactive-session-fallback)
- [Connect server (self-hosted)](#connect-server-self-hosted)
- [Error messages and fixes](#error-messages-and-fixes)

## Token resolution order

`scripts/_common.sh` resolves auth in this priority order:

1. **`OP_SERVICE_ACCOUNT_TOKEN`** — set via Agent Hub **Settings → Skills →
   Credentials → 1Password**. Injected automatically into every agent session.
   No biometric prompt. Works in cron, heartbeat, and headless contexts.
2. **`OP_SERVICE_ACCOUNT_TOKEN`** from the host environment — useful for local
   dev or CI when Agent Hub isn't the credential store.
3. **Existing `op` session** on the host — the CLI checks for a signed-in
   session (set by a prior `eval $(op signin)` or GUI unlock). Only viable in
   interactive agent sessions, not cron/heartbeat.

If none of the above resolve, `_common.sh` exits `2` with an actionable error
message pointing to the Service Account setup guide.

## Service Account (recommended)

Service Accounts are machine identities in 1Password that carry a long-lived
bearer token (`ops_...`). They:

- Require no biometric prompt — safe for cron, heartbeat, CI.
- Can be scoped to specific vaults — principle of least privilege.
- Are auditable separately from human accounts.
- Do not expire by default (but can be rotated or revoked at any time).

Official docs: https://developer.1password.com/docs/service-accounts/

### Creating a Service Account

1. Open **1Password.com** → **Integrations** → **Service Accounts**.
2. Click **New Service Account**.
3. Give it a name (e.g. `agent-hub-read`).
4. Select the vaults this account can access (start with read-only).
5. Copy the token (`ops_...`) — it's shown **once**.
6. In Agent Hub: **Settings → Skills → Credentials → 1Password** → paste under
   **OP_SERVICE_ACCOUNT_TOKEN**.

The token is stored encrypted with AES-256-GCM in Agent Hub's credential store
and injected at spawn time — never committed to disk or logs.

Quick-start guide: https://developer.1password.com/docs/service-accounts/get-started

### Scoping vault access

Grant the Service Account only the vaults it needs:

- **Read-only access** is sufficient for `op read`, `op item get`, `op run`, and
  `op inject`. These are the most common agent use-cases.
- **Write access** is only needed if agents create or update items (and only with
  user confirmation — see SKILL.md safety model).

You can edit vault permissions for a Service Account at any time via
**Integrations → Service Accounts → [account] → Edit**.

### Security best practices

From https://developer.1password.com/docs/service-accounts/security:

- One Service Account per environment (dev / staging / prod) with separate
  vault scopes.
- Rotate tokens regularly (via **Integrations → Service Accounts → Regenerate**).
- Never embed the token in source code, config files, or logs.
- Monitor Service Account activity under **Integrations → Audit Events**.
- Service Accounts cannot access **Private** vaults — only shared vaults.

## Biometric / interactive session (fallback)

If no Service Account token is set, the `op` CLI looks for an existing
authenticated session on the host. This requires a prior `eval $(op signin)` or
the 1Password desktop app to be running and unlocked.

**This mode does NOT work in:**
- Cron jobs
- Heartbeat runs
- Any session spawned without an interactive terminal

Error you'll see if no session exists:
```
[ERROR] 2023/… 401 Unauthorized
```

Fix: set `OP_SERVICE_ACCOUNT_TOKEN` as described above.

## Connect server (self-hosted)

For teams that self-host a 1Password Connect server (an on-premises alternative
to the 1Password cloud):

- Set `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` env vars instead of
  `OP_SERVICE_ACCOUNT_TOKEN`.
- Scripts detect these vars and prefer Connect when both are set.
- The `op` CLI automatically routes requests through the Connect server.

Docs: https://developer.1password.com/docs/connect/

## Error messages and fixes

| Error | Likely cause | Fix |
|-------|-------------|-----|
| `[ERROR] … 401 Unauthorized` | No session / expired token | Set `OP_SERVICE_ACCOUNT_TOKEN` or re-run `eval $(op signin)` |
| `[ERROR] … not found in PATH` | `op` not installed | Install: `brew install --cask 1password-cli` |
| `[ERROR] … account not found` | Token from wrong account | Verify the token matches the intended 1Password account |
| `[ERROR] … vault not found` | SA doesn't have access | Grant vault access in **Integrations → Service Accounts** |
| `[ERROR] … item not found` | Wrong title / UUID | Use `op item list` to find the correct name or UUID |
| `exit 2` from wrapper | `op` binary missing | Install `op` CLI; see SKILL.md prerequisites |
