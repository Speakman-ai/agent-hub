# Google Cloud OAuth Setup for Google Workspace Integration

One-time operator runbook for registering the Google Cloud OAuth **app** that
backs the per-user Google Workspace connection (Calendar, Gmail, Sheets, Drive).
Until this is done, `GET /api/auth/google/status` returns
`serverConfigured: false`, the Account settings pane shows "Google not
configured", and no user can link a Google account.

Everything below is applied by hand in the Google Cloud Console. There is no
Terraform path — the OAuth consent screen and verification are console + Google
review only.

## Where the credentials actually live

The server reads the app client id/secret from the **server-global**
`config.googleOAuth` block, resolved by `resolveGoogleOAuthConfig()` in
`server/google-oauth-config.ts`:

```jsonc
// ~/.agent-hub/data/config.json  (falls back to server/config.json)
{
  "googleOAuth": {
    "clientId": "1234567890-abcdef.apps.googleusercontent.com",
    "clientSecret": "GOCSPX-xxxxxxxxxxxxxxxxxxxx"
  }
}
```

> **Note on the card wording.** The epic card says
> `config.personalOAuth.google`. That was the spike-era guess. The shipped code
> keeps the Google app credentials in their **own** top-level `googleOAuth`
> block (separate from GitHub's `personalOAuth`), gated to Owner/Admin. Set
> `googleOAuth`, not `personalOAuth.google`.

Both `clientId` and `clientSecret` must be non-empty; a partial block resolves
to "unconfigured" (`resolveGoogleOAuthConfig` returns `null`) so the connect
flow degrades cleanly to "not configured" instead of a broken handshake. You can
also patch it live with `PATCH /api/config` (Owner/Admin) instead of editing the
file, then it takes effect on the next config read.

## The redirect URI (must match exactly)

The callback path is `GOOGLE_CALLBACK_PATH = '/api/auth/google/callback'`
(`server/google-oauth.ts`). The server builds the full redirect URI from
`config.publicUrl` (stable behind nginx, may carry a path prefix), falling back
to the request origin only for local dev:

```
<publicUrl>/api/auth/google/callback
```

Register that exact string as an **Authorized redirect URI** on the OAuth
client. A mismatch fails consent with `redirect_uri_mismatch`. Examples:

| Environment | `publicUrl` | Authorized redirect URI |
| --- | --- | --- |
| Production | `https://hub.example.com` | `https://hub.example.com/api/auth/google/callback` |
| Staging | `https://staging.hub.example.com` | `https://staging.hub.example.com/api/auth/google/callback` |
| Local dev | (unset → request origin) | `http://localhost:3051/api/auth/google/callback` |

If `publicUrl` carries a path prefix (e.g. `https://example.com/hub`), the
redirect URI carries it too: `https://example.com/hub/api/auth/google/callback`.
Register one client per environment (prod / staging) so each stable redirect URI
is pinned, or add multiple redirect URIs to one client.

## Step 1 — Create the Google Cloud project

1. [Google Cloud Console](https://console.cloud.google.com/) → project picker →
   **New Project**.
2. Name it e.g. `agent-hub-workspace` (this name is internal, not user-facing).
3. Note the project id.

## Step 2 — Enable the required APIs

APIs & Services → **Library** → enable each of:

- **Google Calendar API**
- **Gmail API**
- **Google Sheets API**
- **Google Drive API**

(People API is not required — identity comes from the OpenID `id_token`.)

## Step 3 — Configure the OAuth consent screen

APIs & Services → **OAuth consent screen**.

1. **User type**: **External** (the hub is multi-tenant; users bring personal or
   any Workspace account). Internal only works if every user is in one Workspace
   org, which is not our model.
2. **App information**:
   - **App name**: `Agent Hub` (this is what users see on the consent dialog).
   - **User support email**: a monitored address (Google requires it and shows
     it to users).
   - **App logo**: upload the Agent Hub logo (120×120+ PNG). A logo triggers
     brand verification but is expected for a published app.
3. **App domain**:
   - **Application home page**: `https://hub.example.com`
   - **Privacy policy URL**: required for verification with sensitive scopes.
   - **Terms of service URL**: optional but recommended.
4. **Authorized domains**: add the registrable domain (`example.com`).
5. **Developer contact information**: an email Google can reach.

## Step 4 — Add the scopes

The server requests scopes **incrementally per surface** (identity up front, each
surface's scope only when the user enables it), but the consent screen must list
every scope the app may ever request. Add these (all **non-sensitive** or
**sensitive** — deliberately no **restricted** scopes, so no annual CASA
assessment):

| Scope | Tier | Surface | Constant |
| --- | --- | --- | --- |
| `openid` | non-sensitive | identity | `GOOGLE_IDENTITY_SCOPES` |
| `email` | non-sensitive | identity | `GOOGLE_IDENTITY_SCOPES` |
| `profile` | non-sensitive | identity | `GOOGLE_IDENTITY_SCOPES` |
| `.../auth/drive.file` | non-sensitive | Drive | `DRIVE_FILE_SCOPE` |
| `.../auth/calendar.events` | sensitive | Calendar | `CALENDAR_EVENTS_SCOPE` |
| `.../auth/spreadsheets` | sensitive | Sheets | `SHEETS_SCOPE` |
| `.../auth/gmail.modify` | sensitive | Gmail | `GMAIL_MODIFY_SCOPE` |
| `.../auth/gmail.send` | sensitive | Gmail | `GMAIL_SEND_SCOPE` |

Full scope URLs (paste into the "Add scope" box):

```
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.send
```

> **Do NOT add** `gmail.readonly`, `drive.readonly`, full `drive`, or
> `https://mail.google.com/`. Those are **restricted** scopes and trigger the
> annual Google-approved third-party CASA security assessment
> ($500–$4,500/yr + ongoing). v1 avoids them by design. The scope constants live
> in `server/google-scopes.ts`; the legacy full scopes are accepted where an
> upgraded connection already has them but are never requested.

## Step 5 — Create the OAuth 2.0 Web client

APIs & Services → **Credentials** → **Create credentials** → **OAuth client ID**.

1. **Application type**: **Web application**.
2. **Name**: `agent-hub-web` (internal label).
3. **Authorized redirect URIs**: add the exact URI(s) from the redirect table
   above (one per environment, or multiple on one client).
4. Leave **Authorized JavaScript origins** empty — the flow is server-side
   (Authorization Code); the browser never holds a token.
5. Create → copy the **client id** and **client secret** into
   `config.googleOAuth` (Step "Where the credentials actually live").

## Step 6 — Sensitive-scope justifications (for the verification form)

Google's verification form asks, per sensitive scope, "why does your app need
this?" Paste-ready justifications:

**`calendar.events` — See, edit, share, and permanently delete calendar events.**
> Agent Hub is an AI agent workspace. When a user links their Google account,
> our AI agents and the built-in Calendar view read the user's upcoming events
> to provide agenda context and create/update events the user asks for (e.g.
> "schedule a review at 3pm Thursday"). Access is per-user via the user's own
> OAuth grant; the app never accesses events without an explicit user link and
> never shares them with other users.

**`spreadsheets` — See, edit, create, and delete all Google Sheets spreadsheets.**
> Users ask our AI agents to read and update spreadsheets they own (e.g. append
> rows to a tracking sheet, read a data range to summarize). Writes happen only
> in response to a direct user request in the user's own session, scoped to the
> user's OAuth grant. No cross-user or bulk access.

**`gmail.modify` — Read, compose, and send emails; manage labels (no permanent delete).**
> Users ask agents to read recent threads for context, draft/label messages, and
> triage their inbox. We request `gmail.modify` (not `gmail.readonly` or the
> full `https://mail.google.com/` scope) specifically to avoid restricted-scope
> CASA while still allowing label management and drafting. No permanent deletion.

**`gmail.send` — Send email on the user's behalf.**
> Users ask agents to send emails they compose or approve (e.g. "email this
> summary to my team"). Sending is always in response to an explicit user
> instruction within the user's own linked session.

**`drive.file` — Per-file access to files the app creates or the user opens with the app.**
> Non-sensitive scope. Used so agents can create/read only files the Agent Hub
> app itself created or the user explicitly picked, never the user's whole Drive.
> We deliberately avoid `drive.readonly` / full `drive` (restricted).

**Cross-cutting notes for the reviewer (put in the "additional info" box):**
- The connection is per-user OAuth (Authorization Code + offline refresh),
  mirroring standard "Sign in with Google" apps. No service-account
  domain-wide delegation.
- Tokens are stored **encrypted at rest** (AES-256-GCM) and never leave the
  server — the browser/mobile/Electron clients never receive a Google token.
- All Google API calls are made server-side via the official `googleapis` SDK.

## Step 7 — Demo video

Verification with sensitive scopes requires a screencast (unlisted YouTube link
is fine). Script:

1. Show the app's Account settings page, **not connected** state.
2. Click **Connect Google**, walk through the OAuth consent screen — narrate
   that the consent dialog shows the `Agent Hub` brand and the exact scopes.
3. Show the **connected** state (linked email + granted scopes chip).
4. Demonstrate each sensitive scope in use:
   - Calendar: agent reads/creates an event.
   - Sheets: agent appends a row / reads a range.
   - Gmail: agent drafts + sends an email, applies a label.
5. Show **Disconnect** revoking the connection.
6. State on-camera that access is per-user and tokens stay server-side.

Keep it under ~3 minutes, show the OAuth grant URL bar so Google can confirm the
client id matches the submitted app.

## Step 8 — Test mode vs Published

The OAuth consent screen has a **Publishing status**:

- **Testing** — the app works only for **explicitly added test users** (up to
  100). No verification needed. Refresh tokens issued in Testing expire after
  **7 days**, so a linked connection silently breaks after a week — fine for
  staging QA, not for production.
- **In production (Published)** — any Google user can consent. Sensitive scopes
  require Google verification (brand + per-scope justification + demo video from
  Steps 6–7) before the "unverified app" interstitial is removed. Refresh tokens
  do not have the 7-day cap.

**Recommended path:**

1. **Staging**: keep the staging OAuth client's consent screen in **Testing**.
   Add each QA/staging tester under **Audience → Test users**. This unblocks
   end-to-end testing immediately with no Google review. Re-link is needed every
   7 days due to the refresh-token cap — document that for testers.
2. **Production**: submit the production consent screen for verification (Publish
   → Prepare for verification). Expect Google review to take days to weeks;
   start early. Until approved, only test users can connect, and they see the
   "unverified app" warning.

### Adding test users (staging)

OAuth consent screen → **Audience** (or **Test users** in the classic UI) →
**Add users** → enter each tester's Google email → Save. Only listed users can
complete the flow while in Testing; everyone else gets `access_denied`.

## Step 9 — Verify the wiring end to end

After setting `config.googleOAuth` and restarting the server:

1. `GET /api/auth/google/status` should report `serverConfigured: true`
   (before the user links, `connected: false`).
2. In the web app: Settings → Account → **Connect Google** → complete consent →
   the pane shows the linked email and granted scopes.
3. `GET /api/auth/google/status` now returns `connected: true` with
   `grantedScopes` listing the identity scopes plus whichever surface you
   enabled.

If `/status` still reports `serverConfigured: false`, the `googleOAuth` block is
missing/partial or the server didn't reload config. If consent fails with
`redirect_uri_mismatch`, the Authorized redirect URI does not byte-match
`<publicUrl>/api/auth/google/callback`.

## Reference

- `server/google-oauth-config.ts` — `resolveGoogleOAuthConfig()` (credential resolution)
- `server/google-oauth.ts` — `GOOGLE_CALLBACK_PATH`, redirect URI + auth URL builders, `GOOGLE_IDENTITY_SCOPES`
- `server/routes/google-oauth.ts` — `/api/auth/google/{start,callback,status}` routes
- `server/google-scopes.ts` — scope constants + per-surface grant predicates
- Google docs: [OAuth 2.0 scopes](https://developers.google.com/identity/protocols/oauth2/scopes),
  [Consent screen verification](https://support.google.com/cloud/answer/13463073),
  [Restricted-scope / CASA requirements](https://support.google.com/cloud/answer/9110914)
