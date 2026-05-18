# Auth — API Key Resolution, Config Locations, Fallbacks

Agent Hub runs as a **multi-user, multi-org** system. Every JWT carries a
`uid` (user id) claim alongside the user's current org context. Membership
in an org determines what that user can do; requests outside any org they
belong to return `403` (except the `x-api-key` break-glass header, which
the server treats as Owner for all orgs — use it only for emergencies and
automation).

Back to [SKILL.md](../SKILL.md).

**Endpoint contracts:** <https://speakman-ai.github.io/agent-hub/#tag/Auth>
(request/response shapes, every field). This page is the *how*.

## Contents

- [Role hierarchy](#role-hierarchy)
- [Sole-Owner protection](#sole-owner-protection)
- [API key resolution for scripts](#api-key-resolution-for-scripts)
- [Per-user API keys (`ahub_*`)](#per-user-api-keys-ahub_)
- [Config locations](#config-locations)
- [Endpoints at a glance](#endpoints-at-a-glance)
- [Per-user Claude credentials](#per-user-claude-credentials)
- [Per-user engine credentials (Cursor / Gemini / Codex)](#per-user-engine-credentials-cursor--gemini--codex)
- [Per-user model preferences (`preferences_json`)](#per-user-model-preferences-preferences_json)
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

Every wrapper under `scripts/` resolves the key through `ah-api.sh`
(sourced by `_common.sh`) **on every invocation** — there is no
source-time freeze. Resolution order:

1. `AGENT_HUB_API_KEY` environment variable (the normal path; injected
   by `buildSpawnEnv` from `cfg.apiKey` at every spawn, so a config
   rotation reaches every new heartbeat/cron/delegation/room-chat/
   slack/design-chat process without a server restart).
2. **Per-session spawn-creds file** at
   `$AGENT_HUB_DATA_DIR/spawn-creds/$AGENT_HUB_SESSION_ID.token`
   (mode `0600`, dir `0700`). Written by `/api/auth/setup` for every
   session updated within the last 24h so long-running chat sessions
   whose env was frozen pre-setup can recover without restarting. See
   "Mid-flight recovery" below.
3. **Home-dir fallback** at
   `$HOME/.agent-hub/data/spawn-creds/$AGENT_HUB_SESSION_ID.token` for
   deploys that override `dataDir` but the spawn somehow lost the env
   pin.
4. `x-api-key` value pulled from `~/.agent-hub/data/config.json`
   (`apiKey` field) — legacy fallback for sessions predating the
   spawn-creds file.
5. Empty — requests fall through to whatever JWT cookie the caller may
   carry. Most agent-side calls will `401` in this state.

All wrappers send the resolved key as `x-api-key: <key>` and treat a
missing key as a recoverable error, not a fatal one.

### Mid-flight recovery (`/api/auth/setup` flips the gate)

When `/api/auth/setup` succeeds on a previously-open instance, every
in-flight session was spawned with an empty `AGENT_HUB_API_KEY`. The
child env was captured once at `spawn()` and never refreshed, so the
next tool call would `401` with no recovery short of restarting the
session. The setup endpoint now:

1. Iterates `sessions` with `updated_at >= now − 24h`.
2. For each, mints a fresh `ahub_*` key (30-day TTL, name
   `spawn-recovery (<sessionId8>)`) owned by the newly-created Owner.
3. Atomically writes the plaintext to
   `<dataDir>/spawn-creds/<sessionId>.token` (mode `0600`).
4. Logs `event=spawn_creds_recovery candidates=… recovered=… failed=…`.

Per-session failures are best-effort: they're logged but never abort
the setup endpoint. Sessions older than 24h are intentionally skipped
to avoid minting thousands of unused tokens for ancient rows.

The wrappers then pick up the file on the very next call (step 2
above), so an agent that was stranded mid-turn keeps working without
manual intervention.

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
| `DELETE /users/:id`                            | Owner        | remove user (sole-Owner guard; cascades user's private projects — see "User-delete cascade") |
| `POST /users/:id/password`                     | self/Owner   | reset password                           |
| `POST /invites`, `GET /invites`, `DELETE …`    | Admin        | invite lifecycle                         |
| `GET  /invites/:token`                         | **public**   | preview invite before accepting          |
| `POST /invites/:token/accept`                  | **public**   | redeem invite (per-IP rate-limited)      |
| `GET  /me/claude-auth`                         | any          | masked per-user Claude credentials       |
| `PUT  /me/claude-auth`                         | any          | upsert per-user Claude credentials       |
| `GET  /me/cursor-auth`                         | any          | masked per-user Cursor API key           |
| `PUT  /me/cursor-auth`                         | any          | upsert per-user Cursor API key           |
| `GET  /me/gemini-auth`                         | any          | masked per-user Gemini API key           |
| `PUT  /me/gemini-auth`                         | any          | upsert per-user Gemini API key           |
| `GET  /me/codex-auth`                          | any          | masked Codex API key + `deviceLogin` (per-user `CODEX_HOME` probe) |
| `PUT  /me/codex-auth`                          | any          | upsert per-user Codex (OpenAI) API key   |
| `POST /me/codex-auth/login`                    | any          | start per-user `codex login --device-auth` (engine-isolated `CODEX_HOME`) |
| `POST /me/codex-auth/login/cancel`             | any          | kill the active per-user Codex device login |
| `GET  /me/skill-credentials`                   | any          | masked per-user skill secrets (optional `?skillId=`) |
| `PUT  /me/skill-credentials`                   | any          | upsert one skill credential key (schema-enforced)    |
| `DELETE /me/skill-credentials/:id`             | any          | revoke a stored skill credential row                 |
| `POST /keys`                                   | any          | create per-user `ahub_*` API key (token returned ONCE) |
| `GET  /keys`                                   | any          | list caller's active API keys (no token) |
| `DELETE /keys/:id`                             | any          | revoke an API key the caller owns        |
| `POST /logout`                                 | any          | revoke session                           |

Public paths live in `PUBLIC_PATHS` / `PUBLIC_PREFIXES` (`server/auth.ts`);
everything else falls through `authMiddleware`.

### Body validation contract (Zod + OpenAPI)

Every POST/PUT under `/api/auth` runs its body through a Zod schema
defined in `server/openapi/schemas/auth.ts` and registered with
`@asteasolutions/zod-to-openapi`. Two failure shapes are possible:

- **Legacy-compatible strings** for fields existing clients/tests already
  match on (`apiKey`, `code`, `role`, `newPassword`, `username`,
  `oauthToken`, `token`). Wording is preserved verbatim — e.g.
  `{"error": "role must be Owner, Admin, or User"}` for a bad role on
  `PUT /users/:id/role`.
- **Structured Zod envelope** for any other shape error:
  `{"error": "request body failed validation", "issues": [...]}`.
  Each issue carries `path` (array of field segments) and `message`.

Both surfaces share HTTP 400. The published `docs/api/openapi.yaml`
auth section is now generated from these schemas — do not hand-edit it
for auth changes; update the schema + run `npm run generate:openapi`.

## User-delete cascade

`DELETE /api/auth/users/:id` removes the caller's membership in the active
org, and only deletes the underlying `users` row when that was the user's
**last** membership across all orgs (`countMembershipsForUser(id) === 0`).
When the row is deleted, the route fires a cascade callback
(`AuthRoutesOptions.onUserDeleted`, wired in `server/index.ts` to
`cascadeDeleteUserPrivateProjects`) which sweeps the now-orphaned project
state:

- **Private projects** owned by the deleted user are auto-deleted — no
  remaining member of any org could pass the visibility gate, so the
  rows are unreachable. The cascade tears down each project's scoped
  rows via the shared `deleteProjectScopedRows` helper (kept in sync
  with the DELETE `/api/projects/:id` handler) so there's no drift.
- **Shared projects** owned by the deleted user stay alive but their
  `ownerUserId` is now stale. They are logged but not deleted — shared
  projects can be re-owned manually or left for an Owner to delete via
  the kill switch.

The response shape adds two fields:

```json
{
  "ok": true,
  "userId": "...",
  "orgId": "...",
  "userDeleted": true,
  "cascadedPrivateProjects": ["proj-id-1", "proj-id-2"],
  "orphanedSharedProjects": ["proj-id-3"]
}
```

The cascade is **best-effort**: per-project failures are logged but do
not fail the user-delete response. The user row is gone either way; an
operator can clean up any stragglers manually.

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
when the user row is unknown.

**Encryption-at-rest.** The two secret columns
(`users.anthropic_api_key`, `users.claude_code_oauth_token`) are
encrypted with the shared AES-256-GCM helper in `server/secret-crypto.ts`
— same `pr-env-secret.key` keyfile already used by Slack tokens and per-
user skill credentials. Writes always produce an `iv:tag:ciphertext`
base64 blob; empty / whitespace-only inputs collapse to SQL `NULL` so a
"clear field" PUT lands cleanly. Reads transparently decrypt and, when
they encounter a legacy plaintext row (installs predating this change),
rewrite the column with an encrypted blob in place — the on-disk shape
converges to encrypted-only over time without a one-shot migration.
Corrupt blobs whose auth-tag check fails degrade to `null` rather than
throwing into the spawn path. The OAuth-expiry timestamp and
`claude_auth_updated_at` stay plaintext — they are non-secret metadata.

## Per-user engine credentials (Cursor / Gemini / Codex)

The three single-key CLI engines (Cursor Agent, Gemini CLI, Codex CLI)
each carry exactly one API key. They follow the same per-field, per-user
override pattern as Claude — `buildSpawnEnv` (`server/config.ts`) picks
the **session owner's** key over the host-wide `config.json` key, and
the spawn env injects the right variable for each engine:

| Engine | Env var injected into the spawn | Host config field | User column                |
| ------ | ------------------------------- | ----------------- | -------------------------- |
| Cursor | `CURSOR_API_KEY`                | `cursorApiKey`    | `users.cursor_api_key`     |
| Gemini | `GEMINI_API_KEY`                | `geminiApiKey`    | `users.gemini_api_key`     |
| Codex  | `OPENAI_API_KEY`                | `codexApiKey`     | `users.codex_api_key`      |

**Precedence is per-field** — for each engine the resolver picks:

1. **User value** — `users.<engine>_api_key` on the session-owner row,
   when truthy.
2. **Host value** — the matching `cfg.<engine>ApiKey` from
   `~/.agent-hub/data/config.json`.
3. **Unset** — the variable is **deleted** from the spawn env so the
   CLI does not silently inherit a stale ambient value from the
   operator's shell. Operators relying on systemd/PM2 env inheritance
   must populate the host config or per-user value explicitly.

**REST shape.** Each engine exposes a `GET` / `PUT` pair at
`/api/auth/me/{engine}-auth`. All three share the same compact shape:

| Field                | `GET`                                                       | `PUT`                                              |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| `engine`             | `"cursor" \| "gemini" \| "codex"`                           | — (derived from URL)                               |
| `apiKey`             | masked (e.g. `sk-…abcd`) or `null`                          | accepts string or `null`; empty string clears      |
| `updatedAt`          | last-write timestamp                                        | last-write timestamp                               |
| `hostConfigFallback` | `{ apiKey: boolean }` — does the host have a fallback key?  | same shape — UI re-renders "falling back to host"  |

`PUT` whitelists exactly `apiKey` via
`Object.prototype.hasOwnProperty.call`; stray keys are ignored. Both
endpoints return `401` when `authUserId` is missing and `404` when the
user row is unknown.

**Encryption-at-rest.** All three engine API-key columns
(`users.cursor_api_key`, `users.gemini_api_key`, `users.codex_api_key`)
are encrypted via `server/secret-crypto.ts` on write and decrypted
transparently on read, with the same lazy plaintext-backfill behaviour
documented for the Claude columns above. The per-engine
`<engine>_auth_updated_at` column stays plaintext (non-secret
bookkeeping).

**Helpers.** `server/users-store.ts` exposes
`getUser{Cursor,Gemini,Codex}Auth` / `setUser{Cursor,Gemini,Codex}Auth`
implemented atop a generic `getSingleKeyAuth` / `setSingleKeyAuth`
pair. The DB columns (`<engine>_api_key`, `<engine>_auth_updated_at`)
are added via idempotent `ensureColumn` migrations on boot.

**"Sign in with browser" — per-user HOME isolation.** Cursor Agent,
Codex CLI, and Gemini OAuth all authenticate via files in `$HOME`
(`~/.cursor`, `~/.codex`, `~/.config/gcloud`, …) rather than an
environment variable. Sharing the operator's HOME across all Hub users
would leak login state between accounts. To prevent that,
`buildSpawnEnv(cfg, { userId })` (`server/config.ts`) pins the spawn's
`HOME` to `<dataDir>/per-user-creds/<userId>/home` whenever a session
owner is known. The directory is materialized on demand by
`ensurePerUserHome` (`server/per-user-home.ts`); FS errors fall back to
the host HOME so a transient failure never blocks a chat. When
`userId` is unset (legacy global-apiKey path, Admin host-wide flows)
HOME is left as the operator inherited it.

Every spawn site that previously called `buildSpawnEnv(cfg)` now
resolves a `credOwnerId` (`getSessionOwner(sessionId) || getOrgOwnerUserId()`)
and threads it through as `{ userId: credOwnerId }`, so the per-user
HOME and engine creds reach the right child:

- `server/chat.ts` — interactive chat sessions.
- `server/heartbeat.ts` — scheduled heartbeat runs.
- `server/room-chat.ts` — conference-room turns.
- `server/design-chat.ts` — Design Studio sessions.
- `server/slack.ts` — Slack-bot mediated runs.
- `server/delegation.ts` — both `<delegate>` sub-agent spawns and
  the synthesis pass that summarizes their results.

The practical effect: when a user has authenticated `cursor-agent` /
`codex` via "Sign in with browser" once, every downstream spawn the
platform makes on their behalf — including delegated sub-agents and
synthesis — reads the same per-user token cache without re-prompting.

### Per-engine HOME shim (P3/P4 foundation)

The legacy single-HOME path above (`<dataDir>/per-user-creds/<userId>/home`)
keeps Cursor and Codex sharing one filesystem subtree per user. The
follow-up `server/per-user-cli-home.ts` helper carves out a separate
tree **per (engine, user) pair**:

```
<dataDir>/per-user-cli-home/<engine>/<userId>/
```

Used as `HOME` (Cursor) or `CODEX_HOME` (Codex) so the two engines'
caches can never read each other and a single-engine logout cannot
damage the other. The helper exposes
`perUserCliHomePath` (path math, no FS), `ensurePerUserCliHome`
(mode-0700 create + UID ownership guard that refuses to hand a misowned
dir to a spawn), and `clearPerUserCliHome` (logout-leaf removal that
keeps the parent `<engine>/` dir). Engine names are an allowlist
(`cursor`, `codex`, `gemini`) and user ids are constrained to a strict
path-safe charset before becoming a path segment.

### P4 — Per-user Codex device login (`CODEX_HOME`-isolated)

Codex is the first engine wired to the per-engine HOME shim. The
endpoints are mounted by `server/routes/per-user-engine-auth.ts` and the
shared state lives in `server/per-user-codex-device-login.ts`:

| Verb + path                                  | Behavior                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST /api/auth/me/codex-auth/login`         | Spawns `codex login --device-auth` with `CODEX_HOME=<dataDir>/per-user-cli-home/codex/<userId>`. Streams stdout/stderr until a device URL + user code parse, then returns `{ ok, loginId, deviceAuthUrl, userCode }`. Fast-exit (CLI exits 0 before emitting a code, e.g. cache hit) returns `{ ok: true, loginId, output }`; a 45s timeout collapses to `{ ok: false, output: 'Timed out…' }`. A second `POST` for the same user kills the prior proc and starts fresh — the latest click wins. |
| `POST /api/auth/me/codex-auth/login/cancel`  | Idempotent — kills the per-user proc if one is running, otherwise returns `{ ok: true, output: 'No device login in progress' }`. |
| `GET  /api/auth/me/codex-auth`               | Extends the single-key apiKey response with `deviceLogin: { uiStatus, loginInProgress, oauth: { loggedIn, mode, authJsonPath }, codexHomePath }` — the UI uses this to render "Signed in with ChatGPT" alongside the API-key state. Cursor / Gemini GETs keep the compact apiKey-only shape. |

The active-login map is keyed by `userId` so two users can sign in
simultaneously without stomping each other (mirrors the per-user
isolation that `ensurePerUserCliHome` enforces at the FS layer).

**`buildSpawnEnv` injection.** `server/config.ts:buildSpawnEnv(cfg, {
userId })` now also sets `env.CODEX_HOME = perUserCliHomePath('codex',
userId, cfg.dataDir)` whenever the per-user `auth.json` is populated
(detected by `hasPopulatedCodexDeviceAuth`, which accepts both
`chatgpt` and `apikey` modes). When the user has not signed in,
`CODEX_HOME` is **explicitly deleted** from the spawn env so a stale
host-process value cannot leak the operator's Codex cache into a user
spawn. Net effect: once a user completes the per-user device login,
every chat / heartbeat / cron / room / Slack / delegation spawn owned
by them reads the same `~/.codex` clone without re-prompting.

The matching Cursor/Gemini wiring is a planned follow-up (the cleanup
of the older `/api/auth/me/cursor-auth/browser/*` flow onto the
engine-isolated shim).

## Per-user engine-credential audit (`user_engine_auth_audit`)

Every secret-field write on `PUT /api/auth/me/{claude,cursor,gemini,codex}-auth`
appends one row to `user_engine_auth_audit` in `orgs.db`. The table
parallels `user_skill_credential_audit` and is created alongside it in
`initOrgsDb()` from `server/auth-credential-audit-schema.ts`:

| Column          | Notes                                                             |
| --------------- | ----------------------------------------------------------------- |
| `id`            | UUID                                                              |
| `user_id`       | Owner of the credential row that changed                          |
| `engine`        | `claude` \| `cursor` \| `gemini` \| `codex` (CHECK-constrained)   |
| `field`         | Column name (e.g. `anthropic_api_key`, `cursor_api_key`)          |
| `action`        | `upsert` for set / rotate, `delete` when the new value clears a previously-set field |
| `actor_user_id` | Who performed the write (today: same as `user_id`; left distinct for a future admin-impersonation surface) |
| `created_at`    | `datetime('now')` default                                         |

A single PUT that touches multiple secret fields (e.g. claude-auth
sending both `anthropicApiKey` and `claudeCodeOAuthToken`) emits
**one row per field** so operator attribution stays field-level.
Metadata-only writes (`claudeCodeOAuthExpiresAt`) and patches that omit
the credential field entirely do not pollute the audit log. Audit
inserts are best-effort: a failed audit write never blocks the
credential update itself (matches `skill-credentials-store::appendAudit`).
Read via `listUserEngineAuthAudit(userId, { engine? })`, newest-first.

## Per-user model preferences (`preferences_json`)

Soft per-user preferences ride on a JSON column (`users.preferences_json`)
rather than dedicated columns so we can add new keys without a schema
migration. Two sub-maps today, both managed by
`server/user-preferences-store.ts`:

| Sub-map                | What it pins                                                        | Resolver                                                  |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| `engineDefaultModels`  | Per-user default CLI model id by engine (e.g. `claude-code → claude-opus-4-7`). | `resolveEffectiveModel` (`server/effective-model.ts`).    |
| `agentEngineOverrides` | Per-user, per-agent engine + optional model override.               | `resolveEffectiveEngineAndModel` (`server/effective-model.ts`). |

Two REST pairs back the two sub-maps:

| Verb + path                                  | Body shape                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /api/auth/me/engine-default-models`     | `{ engineDefaultModels: { [engine]: modelId } }`                           |
| `PUT /api/auth/me/engine-default-models`     | same                                                                       |
| `GET /api/auth/me/agent-engine-overrides`    | `{ agentEngineOverrides: { [agentId]: { engine, model? } } }`              |
| `PUT /api/auth/me/agent-engine-overrides`    | same                                                                       |

Both PUTs replace the named sub-map only — the store's
`mergeUserPreferencesJson` helper preserves the untouched sub-map, so two
unrelated PUTs cannot stomp each other. PUT bodies are validated against
`cfg.engineValidModels`; unknown engines and models outside the engine's
allowlist 400. The GETs also strip stale entries (engines / models that
rotated out of the catalogue) before responding, so the client never sees
state the server would refuse to honour.

**Override precedence** (`resolveEffectiveEngineAndModel`):

1. `explicitEngine` — supplied by the caller (e.g. session-creation body).
2. **Per-user `agentEngineOverrides[agentId]`** — `{ engine, model? }`.
   Wins over the agent's shared engine. The override's `model` is treated
   as explicit when set; otherwise the model walks the standard ladder
   keyed to the **override** engine, never the shared one.
3. Agent's shared `engine` / `model` from `projects.json`.

User-facing spawn sites that consult overrides:

- `POST /api/agents/:agentId/sessions` (`server/routes/sessions.ts`).
- `POST /api/projects/:projectId/board/cards/:cardId/assign`
  (`server/routes/board.ts`).
- WebSocket orphan-session bootstrap (`server/chat.ts`).

Reviewer / webhook / autonomous dispatch deliberately does **not** read
per-user overrides because those spawns are not owned by the caller of
the trigger.

## Per-user skill credentials

Third-party tokens for **installed skills** (Linear, GitHub PAT, etc.) live
in a dedicated store — not on the `users` row — so operators are not
tempted to paste secrets into chat or kanban cards.

**Declaration.** Each skill may list keys under a `credentials:` array in
**SKILL.md** frontmatter (`name`, `label`, `description`, `required`,
`type`, `docs_url`). Registry import and `POST /api/skills/registry`
reject malformed blocks.

**Schema resolution (`PUT` validation).** Two flows, gated on whether the
request body carries `agent_id`:

- **(A) `agent_id` provided** — the SkillsPage editor on a specific agent.
  The server resolves the skill's `credentials:` block using **that agent's
  project workspace** `{project.ahw}/skills/{skill_id}` (directory +
  `SKILL.md`, or legacy flat `.md`), **then** bundled
  `server/default-skills/{skill_id}/SKILL.md`, **then** the matching
  `skill_registry` row — the same order as
  `GET /api/agents/:agentId/skills/:skillId`. Hydrated `project.ahw` comes
  from the in-memory projects list (typically
  `<dataDir>/persist/projects/<id>`). This avoids ambiguous "first matching
  workspace across all projects" behavior on multi-project hosts. JWT
  callers must also be a member of the agent's active org (apiKey /
  local-bundled bypass are unaffected).
- **(B) `agent_id` omitted** — the Account page **My Skill Credentials**
  panel. Resolution skips every per-project workspace and walks **only**
  bundled `server/default-skills/{skill_id}/SKILL.md` → `skill_registry`.
  The agent-scoped RBAC gate does not run — any authenticated user may
  store their own personal credential for a bundled skill (e.g. Linear).
  `skill_id` + `key_name` are still required; unknown skills 400 with
  `invalid credential schema for skill: …`.

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
| `/me/skill-credentials` | PUT | Body `{ skill_id, key_name, value, agent_id? }` — `agent_id` is **optional**; when set, schema resolution starts from that agent's project workspace (with org-membership RBAC). When omitted, the schema resolves from bundled `server/default-skills/` + `skill_registry` only, no per-agent context. `key_name` must appear in the resolved schema either way. |
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
| Design Studio chat | `server/design-chat.ts` | WebSocket user if present, else org owner (`DESIGN_SKILL_PRINCIPAL_AGENT_ID` → `__design_studio__` skill toggles) |
| Heartbeats | `server/heartbeat.ts` (`runClaude` `skillCredentialMerge`) | Org owner |
| Crons | `server/heartbeat.ts` (`runCronJob` → `runClaude`; `cron-skill-principal.ts`) | Org owner — agent id from `crons.skill_principal_agent_id`, else `project.cronSkillPrincipalAgentId`, else sole project agent |
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
