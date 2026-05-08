# Auth — Personal API Key vs OAuth, Credential Resolution

Back to [SKILL.md](../SKILL.md).

## Contents

- [Minting a personal API key](#minting-a-personal-api-key)
- [Authentication header format](#authentication-header-format)
- [Credential resolution hierarchy](#credential-resolution-hierarchy)
- [OAuth 2.0 (applications)](#oauth-20-applications)
- [Security guardrails](#security-guardrails)

## Minting a personal API key

1. Open Linear → **Settings → API → Personal API keys**.
2. Click **Create key**, give it a name (e.g. "Agent Hub"), copy the key.
3. In Agent Hub: **Settings → Skills → Credentials → Linear → LINEAR_API_KEY**,
   paste the key. It is stored AES-256-GCM encrypted and never shown again.
4. Agent Hub injects the decrypted value as `LINEAR_API_KEY` into every session
   that loads the `linear` skill — no further setup needed.

Docs: <https://linear.app/settings/api>

## Authentication header format

| Credential type   | Header value                          |
| ----------------- | ------------------------------------- |
| Personal API key  | `Authorization: <YOUR_API_KEY>`       |
| OAuth access token| `Authorization: Bearer <ACCESS_TOKEN>`|

The personal key is sent **without** a `Bearer` prefix; OAuth tokens use `Bearer`.
The `_common.sh` helper handles this automatically when `LINEAR_API_KEY` is set.

Endpoint: `POST https://api.linear.app/graphql`
Content-Type: `application/json`

## Credential resolution hierarchy

When `scripts/_common.sh` is sourced, it resolves `LINEAR_API_KEY` in this order:

1. **Environment variable `LINEAR_API_KEY`** — Agent Hub injects this when the
   user has stored a key in the per-user credential store (Settings → Skills →
   Credentials). This is the normal path in agent sessions.
2. **Host shell export** — if the user ran `export LINEAR_API_KEY=...` before
   starting the session, that value is already in the environment.
3. **Absent** — if neither is set, `_common.sh` exits with a clear error
   message and a pointer to the settings page. No silent failures.

The scripts **never** read `~/.netrc` or any other credential file outside the
injected environment — all credential management is delegated to Agent Hub.

## OAuth 2.0 (applications)

For third-party apps that act on behalf of multiple users, Linear supports
OAuth 2.0. The flow produces a `Bearer` access token:

- Register the app: Linear → Settings → API → OAuth applications → Create.
- Redirect URL: your app's callback route.
- Scopes: `read`, `write`, `issues:create`, `comments:create`, `admin`.
- Token exchange: `POST https://api.linear.app/oauth/token`

Reference: <https://linear.app/developers/oauth-2-0-authentication>

> Agent Hub does not run the OAuth dance on the user's behalf — it stores
> tokens the user pastes in. If you need to acquire a fresh OAuth token, run
> the flow in your browser or a separate tool and paste the result.

## Security guardrails

- **Never log the API key.** Do not print it to stdout, daily notes, kanban
  card descriptions, or chat messages.
- Keys have no built-in expiry — treat them like passwords and rotate if
  compromised.
- Personal keys inherit the user's full workspace permissions. Use an OAuth
  application with minimal scopes for production integrations.
