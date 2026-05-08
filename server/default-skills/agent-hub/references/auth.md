# Auth — API Key Resolution, Config Locations, Fallbacks

Agent Hub runs as a **multi-user, multi-org** system. Every JWT carries a
`uid` (user id) claim alongside the user's current org context. Membership
in an org determines what that user can do; requests outside any org they
belong to return `403` (except the `x-api-key` break-glass header, which
the server treats as Owner for all orgs — use it only for emergencies and
automation).

Back to [SKILL.md](../SKILL.md).

## Contents

- [Role hierarchy](#role-hierarchy)
- [Sole-Owner protection](#sole-owner-protection)
- [API key resolution for scripts](#api-key-resolution-for-scripts)
- [Per-user API keys (`ahub_*`)](#per-user-api-keys-ahub_)
- [Config locations](#config-locations)
- [Endpoints at a glance](#endpoints-at-a-glance)
- [Per-user Claude credentials](#per-user-claude-credentials)
- [Per-user skill credentials](#per-user-skill-credentials)
- [JWT `uid` claim & pre-migration fallback](#jwt-uid-claim--pre-migration-fallback)
- [Rate limiting — `trust proxy` is coupled to the proxy topology](#rate-limiting--trust-proxy-is-coupled-to-the-proxy-topology)

## Role hierarchy

Three-tier hierarchy (`server/roles.ts`): **Owner** > **Admin** > **User**.
Checks are hierarchical — Owner satisfies any `requireRole('X')`. Never
compare role strings directly; use the server's `hasAtLeastRole` /
`requireRole` helpers server-side, and call the right endpoint
client-side.

## Sole-Owner protection

The server refuses to delete or demote the last Owner of an org
(`countOwnersForOrg(orgId) <= 1` guard on `DELETE /users/:id` and role
changes). If you need to hand off Owner, promote someone else to Owner
first, then demote yourself.

## API key resolution for scripts

Every wrapper under `scripts/` resolves the key through
`scripts/_common.sh` in this order:

1. `AGENT_HUB_API_KEY` environment variable (injected into sessions by
   the server — this is the normal path).
2. `x-api-key` value pulled from `~/.agent-hub/data/config.json`
   (`apiKey` field) if the env var is unset.
3. Empty — requests fall through to whatever JWT cookie the caller may
   carry. Most agent-side calls will `401` in this state; re-source the
   environment.

All wrappers send the resolved key as `x-api-key: <key>` and treat a
missing key as a recoverable error, not a fatal one.

## Per-user API keys (`ahub_*`)

Long-lived programmatic credentials owned by an individual user. Use
these when a script, CI job, or remote Electron client needs stable
credentials without re-logging in or sharing the global break-glass
secret.

**Distinct from the two other auth surfaces:**

| Mechanism                       | Lifetime         | Identity                         | Revocable individually |
| ------------------------------- | ---------------- | -------------------------------- | ---------------------- |
| JWT (`/api/auth/login`)         | 7 days           | The user who logged in           | No (logout = client drop) |
| `AGENT_HUB_API_KEY` (global)    | Until rotated    | None — forced Owner role         | No                     |
| `ahub_*` per-user API key       | Until revoked    | The owning user's membership role| **Yes**                |

**Token format.** `ahub_<43 url-safe base64 chars>` (32 bytes of CSPRNG
entropy). The first 12 chars (`ahub_xxxxxx`) are stored unhashed in the
`prefix` column and used for indexed lookup; the full token is stored
as a SHA-256 hash. Plaintext is **only ever returned by `POST
/api/auth/keys`** at creation; the `GET` endpoint never echoes it.

**How to send the token.** Either header is accepted on REST:

```
Authorization: Bearer ahub_<token>
X-API-Key: ahub_<token>
```

WebSocket handshake accepts the token as `?token=ahub_…` or
`?apiKey=ahub_…` (browsers can't set headers on `new WebSocket(...)`).

**Endpoints.**

| Endpoint                  | Method | Purpose                                            |
| ------------------------- | ------ | -------------------------------------------------- |
| `/api/auth/keys`          | POST   | Create a key. Body: `{ name, expiresInDays? }`. Returns `{ id, name, token, prefix, createdAt, expiresAt }` — `token` shown ONCE. |
| `/api/auth/keys`          | GET    | List the caller's active keys. Never includes the plaintext token or hash. |
| `/api/auth/keys/:id`      | DELETE | Soft-revoke. 404 if the key isn't owned by the caller. |

**Authorization model.** Auth via an `ahub_*` key resolves to the
**owning user's membership-derived role** in the active org — same as a
JWT. This is intentionally narrower than the global `AGENT_HUB_API_KEY`,
which forces Owner; per-user keys never escalate privilege.

**Limits & guardrails.**

- Max 50 active keys per user (revoke an old one to free a slot).
- `expiresInDays` accepts 1–3650; `null`/omitted = never expires.
- `last_used_at` is updated at most once per minute per key (debounced)
  so high-RPS callers don't generate a write storm.

**Electron note.** Electron desktop continues to use JWT — `ahub_*` keys
are intended for non-browser clients (CLI, CI, remote shells) that want
stable credentials. A future Electron settings UI may surface them too.

**Schema.** `api_keys(id, user_id FK, name, token_hash, prefix,
created_at, last_used_at, revoked_at, expires_at)` on `orgs.db`. Indexed
on `user_id` and `prefix`. See `server/api-keys-store.ts`.

## Config locations

- **Primary**: `~/.agent-hub/data/config.json` — port, CLI binary paths
  (`claudeBin`, `cursorBin`), `defaultCwd`, `apiKey`.
- **Legacy fallback**: `server/config.json` — read only when the data-dir
  copy is missing. Kept for backwards compatibility with older
  single-user installs.
- **Env overrides** (see `server/config.ts` / `server/cors-config.ts`): e.g.
  `AGENT_HUB_PORT`, `AGENT_HUB_HOST`, `AGENT_HUB_DATA_DIR`, `AGENT_HUB_PUBLIC_URL`
  (`publicUrl`), `ALLOWED_ORIGINS`.

## Endpoints at a glance

Prefix everything with `/api/auth`. All require auth unless flagged
**public**.

| Endpoint                                       | Min role     | Purpose                                  |
| ---------------------------------------------- | ------------ | ---------------------------------------- |
| `GET  /status`, `POST /setup`, `POST /login`   | public       | bootstrap + sign-in                      |
| `GET  /me`                                     | any          | current user + role                      |
| `GET  /users`                                  | Admin        | list org members                         |
| `POST /users`                                  | Owner        | create user + membership                 |
| `PUT  /users/:id/role`                         | Admin        | change role (sole-Owner guard applies)   |
| `DELETE /users/:id`                            | Owner        | remove user (sole-Owner guard)           |
| `POST /users/:id/password`                     | self/Owner   | reset password                           |
| `POST /invites`, `GET /invites`, `DELETE …`    | Admin        | invite lifecycle                         |
| `GET  /invites/:token`                         | **public**   | preview invite before accepting          |
| `POST /invites/:token/accept`                  | **public**   | redeem invite (per-IP rate-limited)      |
| `GET  /me/claude-auth`                         | any          | masked per-user Claude credentials       |
| `PUT  /me/claude-auth`                         | any          | upsert per-user Claude credentials       |
| `GET  /me/skill-credentials`                   | any          | masked per-user skill secrets (optional `?skillId=`) |
| `PUT  /me/skill-credentials`                   | any          | upsert one skill credential key (schema-enforced)    |
| `DELETE /me/skill-credentials/:id`             | any          | revoke a stored skill credential row                 |
| `POST /keys`                                   | any          | create per-user `ahub_*` API key (token returned ONCE) |
| `GET  /keys`                                   | any          | list caller's active API keys (no token) |
| `DELETE /keys/:id`                             | any          | revoke an API key the caller owns        |
| `POST /logout`                                 | any          | revoke session                           |

Public paths live in `PUBLIC_PATHS` / `PUBLIC_PREFIXES` (`server/auth.ts`);
everything else falls through `authMiddleware`.

## Per-user Claude credentials

`GET` / `PUT /api/auth/me/claude-auth` let an authenticated user attach
their own Anthropic credentials to their user row. When Agent Hub spawns
a Claude Code session, `buildSpawnEnv` (`server/config.ts`) prefers the
**session owner's** credentials over the host-wide `config.json`. This
keeps multi-user installs from coalescing onto a single Anthropic
identity / rate-limit bucket.

**Precedence is per-field, not per-user.** For each of
`ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, the resolver picks:

1. **User value** — `users.anthropic_api_key` / `users.claude_code_oauth_token`
   on the session-owner row, when truthy.
2. **Host value** — `config.anthropicApiKey` / `config.claudeCodeOAuthToken`
   from `~/.agent-hub/data/config.json`.
3. **Unset** — neither layer has a value; the CLI inherits whatever
   ambient env the operator's shell provides.

A user who only sets `anthropicApiKey` still falls back to the host's
OAuth token (and vice-versa). Single-tenant deploys that never write
per-user values are byte-for-bit identical to the pre-Phase-3 behavior.

**Endpoint shape.**

| Field                       | `GET`                                          | `PUT`                                                                                |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `anthropicApiKey`           | masked (`sk-ant-api03-…`) or `null`            | accepts string or `null`; empty string clears                                        |
| `claudeCodeOAuthToken`      | masked or `null`                               | accepts string or `null`; empty string clears                                        |
| `claudeCodeOAuthExpiresAt`  | normalised ISO-8601 string or `null`           | accepts ISO-8601 _or_ a numeric string in Unix seconds / epoch ms; server normalises |
| `claudeCodeOAuthExpired`    | server-computed boolean (`null` when no expiry stored) | not accepted — derived from `claudeCodeOAuthExpiresAt`                       |
| `updatedAt`                 | last-write timestamp                           | last-write timestamp                                                                 |
| `hostConfigFallback`        | `{ anthropicApiKey, claudeCodeOAuthToken }` (booleans) — does the host have a fallback? | same shape — clients can re-render the "falling back to host" hint after save        |

Both endpoints route the stored expiry through `parseClaudeOAuthExpiry`
(`server/oauth-expiry.ts`), which uses the same seconds-vs-ms threshold
helper as the host-config path (`hasClaudeOauth` /
`parseCredentialsFileContent`). Numeric values below `1e12` are treated
as Unix seconds and promoted to ms before any `Date.now()` comparison.
The UI should render expiry chips from the server-computed
`claudeCodeOAuthExpired` boolean rather than recomputing
`Date.now() > expiresAt` against a possibly un-normalised numeric
string. Mirrors the fix landed for the host-config path in PR #723.

`PUT` whitelists exactly those three fields via
`Object.prototype.hasOwnProperty.call`; stray keys are ignored, never
forwarded to the DB. Both endpoints return `401` when `authUserId` is
missing (apiKey-only callers + local-bundled-server bypass) and `404`
when the user row is unknown. Encryption-at-rest is tracked as a
follow-up — credentials currently sit on the users row in plaintext,
mirroring the existing `github_user_token` precedent.

## Per-user skill credentials

Third-party tokens for **installed skills** (Linear, GitHub PAT, etc.) live
in a dedicated store — not on the `users` row — so operators are not
tempted to paste secrets into chat or kanban cards.

**Declaration.** Each skill may list keys under a `credentials:` array in
**SKILL.md** frontmatter (`name`, `label`, `description`, `required`,
`type`, `docs_url`). Registry import and `POST /api/skills/registry`
reject malformed blocks.

**Schema resolution (`PUT` validation).** The request body must include **`agent_id`**
(the agent whose Skills panel issued the save). The server resolves the skill's
`credentials:` block using **only that agent's project workspace**
`{project.ahw}/skills/{skill_id}` (directory + `SKILL.md`, or legacy flat `.md`),
**then** bundled `server/default-skills/{skill_id}/SKILL.md`, **then** the
matching `skill_registry` row — the same order as
`GET /api/agents/:agentId/skills/:skillId`. Hydrated `project.ahw` comes from
the in-memory projects list (typically `<dataDir>/persist/projects/<id>`). This
avoids ambiguous “first matching workspace across all projects” behavior on
multi-project hosts.

**Optional keys.** When a credential is `required: false`, an **empty or
whitespace-only** `value` yields **no DB row** if none exists yet — the
handler responds with `{ skipped: true, credential: null }`.

**Storage & crypto.** Rows in `orgs.db` table `user_skill_credentials`
(`user_skill_credential_audit` for `upsert` / `delete`). Ciphertext uses
`encryptSecret` / `decryptSecret` from `server/pr-env-store.ts` (same
AES-256-GCM key file as PR-env tier-2 secrets).

**REST surface** (all under `/api/auth`, JWT required — `authUserId` must
be present; global `x-api-key` break-glass alone returns **401**):

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/me/skill-credentials` | GET | `{ credentials: [...] }` — `masked_preview`, timestamps; filter with `?skillId=` |
| `/me/skill-credentials` | PUT | Body `{ skill_id, key_name, value, agent_id }` — `key_name` must appear in the schema for that skill as resolved for **that** agent (see above) |
| `/me/skill-credentials/:id` | DELETE | Hard-delete the row |

**Spawn merge.** `mergeSkillCredentialSpawnEnv` in
`server/skill-credentials-spawn.ts` decrypts stored values and merges them
into the child `env` for every **enabled** skill for that agent (project +
bundled defaults, honouring per-agent disable overrides). Keys already set in
the resolved env are **not** overwritten. Call sites:

| Surface | Call path | Whose credential rows (`user_id`) |
| ------- | --------- | ----------------------------------- |
| Interactive 1:1 chat | `server/chat.ts` | Session owner (`ownerId` from the session row) |
| Session rewind | `server/routes/sessions.ts` (`mergeSkillCredentialSpawnEnv` on rewind env) | Session owner if known, else org owner (`getSessionOwner` / `getOrgOwnerUserId`) |
| Session summarize — REST `POST /api/sessions/:sessionId/summarize` | `server/routes/sessions.ts` → `summarizeTranscript` | Session owner if known, else org owner |
| Chat auto-summarize (long reply) | `server/chat.ts` → `summarizeTranscript` | Interactive session owner (`ownerId` in chat) |
| Conference room — WebSocket one-shot CLI | `server/room-chat.ts` | Authenticated WebSocket user if present, else org owner (`getWsAuthUserId` \|\| `getOrgOwnerUserId`) |
| Conference room — REST **summarize** | `server/routes/rooms.ts` → `summarizeTranscript` | **Org owner only** (`getOrgOwnerUserId`) — not the browser user |
| Design Studio chat | `server/design-chat.ts` | WebSocket user if present, else org owner |
| Heartbeats | `server/heartbeat.ts` (`runClaude` `skillCredentialMerge`) | Org owner |
| Crons | `server/heartbeat.ts` (`runCronJob` → `runClaude`) | Org owner |
| Workflows | `server/workflow-runner.ts` | Org owner |
| Slack bot replies | `server/slack.ts` | Org owner |
| Delegation / synthesis spawns | `server/delegation.ts` | Parent session owner if known, else org owner (`getSessionOwner` \|\| `getOrgOwnerUserId`) |

On **single-user** installs the org owner and the interactive user are usually
the same — differences matter in multi-user orgs (saved secrets follow the
`user_id` column, not the agent).

## JWT `uid` claim & pre-migration fallback

The `uid` claim identifies the user across org switches. Pre-migration
tokens that pre-date the claim are still accepted by `authMiddleware` for
backward compatibility, but newly minted tokens always carry `uid`.

## `/api/auth/status` response fields

`GET /api/auth/status` is public and reports what auth surfaces the
server currently exposes. Clients use it to decide between "sign in",
"first-Owner setup", and "upgrade your auth" flows.

| Field               | Meaning                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `authConfigured`    | Alias of `jwtConfigured`. True once `/api/auth/setup` has written `auth.json`.       |
| `jwtConfigured`     | A JWT auth record exists — users can sign in.                                        |
| `apiKeyConfigured`  | The legacy shared-secret `apiKey` is set in `config.json` (break-glass header).      |
| `needsMigration`    | `apiKeyConfigured && !jwtConfigured` — the server is still running apiKey-only.      |
| `activeOrgIsLocal`  | Server was launched with `AGENT_HUB_MODE=local` — the auth gate is short-circuited.  |
| `username`, `role`  | The first-Owner's username + role at install time, or `null` pre-setup.              |

`needsMigration` is the signal for the **"upgrade my auth" banner**: the
server is already protected by the legacy shared secret, but no JWT
record has been written yet. Once `/api/auth/setup` runs, the JWT record
exists and `needsMigration` flips to `false` — even if the apiKey is
still present, because it stays around as break-glass, not as a
migration signal.

`activeOrgIsLocal` is the signal for the **local-bundled-server auth
bypass**: when the server process is launched with the env var
`AGENT_HUB_MODE=local`, `authMiddleware` treats every caller as a
synthetic `local` Owner without requiring a JWT or `x-api-key` header.
This is the single-user desktop install path (Electron's `main.js` sets
`AGENT_HUB_MODE=local` before spawning the embedded server) and the
single-user dev-box path (operators can opt in by exporting the var).

The historical `org.mode='local'` lookup was retired because `org.mode`
is editable from the Settings UI — keying the auth bypass off a
DB-persisted, user-editable value meant a single bad click on a deployed
multi-user server could silently disable auth for every visitor. The env
var is owned by the launching process and cannot be flipped from the UI,
so the default ("unset → multi-user → auth required") fails closed.

The field name `activeOrgIsLocal` is kept for client / API back-compat;
internally the helper is `isLocalBundledServer()` in `server/auth.ts`.

## Rate limiting — `trust proxy` is coupled to the proxy topology

`server/index.ts` sets `app.set('trust proxy', 'loopback')` so `req.ip`
resolves via `X-Forwarded-For` from a local nginx (127.0.0.1). This is
what lets per-IP login / invite-accept rate limiters see the real client
IP.

If the topology ever changes (moving behind an ALB, Cloudflare, or any
non-loopback proxy), this value must be revisited — `'loopback'` will
drop the forwarded IP outside 127.0.0.1 and per-IP limits will collapse
to a single bucket.
