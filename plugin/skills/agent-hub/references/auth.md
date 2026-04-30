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
- [Config locations](#config-locations)
- [Endpoints at a glance](#endpoints-at-a-glance)
- [Per-user Claude credentials](#per-user-claude-credentials)
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

## Config locations

- **Primary**: `~/.agent-hub/data/config.json` — port, CLI binary paths
  (`claudeBin`, `cursorBin`), `defaultCwd`, `apiKey`.
- **Legacy fallback**: `server/config.json` — read only when the data-dir
  copy is missing. Kept for backwards compatibility with older
  single-user installs.
- **Env overrides**: `PORT`, `ALLOWED_ORIGINS`, `DATA_DIR`, `PUBLIC_URL`
  override the on-disk values at process start.

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
| `claudeCodeOAuthExpiresAt`  | ISO-8601 string or `null`                      | accepts string or `null`                                                             |
| `updatedAt`                 | last-write timestamp                           | last-write timestamp                                                                 |
| `hostConfigFallback`        | `{ anthropicApiKey, claudeCodeOAuthToken }` (booleans) — does the host have a fallback? | same shape — clients can re-render the "falling back to host" hint after save        |

`PUT` whitelists exactly those three fields via
`Object.prototype.hasOwnProperty.call`; stray keys are ignored, never
forwarded to the DB. Both endpoints return `401` when `authUserId` is
missing (apiKey-only callers + local-bundled-server bypass) and `404`
when the user row is unknown. Encryption-at-rest is tracked as a
follow-up — credentials currently sit on the users row in plaintext,
mirroring the existing `github_user_token` precedent.

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
