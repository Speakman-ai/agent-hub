# GitHub App for Mirror-Push Branch-Protection Bypass

When Agent Hub **hosts** a project's repo (`gitHost: 'agenthub'`) and mirrors it
one-way to GitHub (`gitMirror.enabled`), the mirror pushes the hosted default
branch straight onto the GitHub default branch. If you protect that GitHub
branch (rulesets / classic branch protection), an ordinary user PAT push is
**rejected** — the mirror stalls and records a divergence.

The fix is to give the mirror push a **GitHub App** identity that the branch's
ruleset allows to bypass protection. Everyone else stays blocked; only the
Hub's App can push the mirror.

> **Scope.** This App is used for **nothing else** — no reviewer, no webhooks,
> no PR-review endpoint (all removed in PR #1205 and staying removed). It mints
> a short-lived installation token consumed only by the mirror push
> (`server/git-host/mirror.ts` → `resolveMirrorToken`).
>
> **You do NOT need this for GitHub-as-main-repo projects.** Those push feature
> branches and open PRs; branch protection on `main` never blocks a
> feature-branch push, so there is nothing to bypass. This is exclusively for
> **Hub-hosted mirrors**.

---

## 1. Create the GitHub App

Settings → Developer settings → **GitHub Apps** → **New GitHub App**.

- **Repository permissions:** `Contents: Read and write` (the only permission
  the mirror push needs). Leave everything else `No access`.
- **Webhooks:** **uncheck Active** — the Hub consumes no webhooks.
- **Where can this app be installed:** your choice (only-this-account is fine).

Create it, then:

1. Note the **App ID**.
2. **Generate a private key** (downloads a `.pem`).
3. **Install the App** on the org/user that owns the mirror target repo, scoped
   to that repo (or All repositories). Note the **Installation ID** — it's the
   number at the end of the install settings URL:
   `https://github.com/settings/installations/<INSTALLATION_ID>`.

## 2. Configure Agent Hub

Add a server-global `githubApp` block to the Hub's `config.json`
(`~/.agent-hub/data/config.json`, falling back to `server/config.json`). This is
**file-only** and intentionally not editable through `PATCH /api/config`, so the
private key never crosses the REST surface.

```jsonc
{
  "githubApp": {
    "appId": "123456",
    // Raw contents of the downloaded .pem, as one JSON string — the whole
    // BEGIN/END private-key block. Escaped \n, surrounding quotes, and
    // CRLF/BOM are all tolerated, so pasting it on a single line works.
    "privateKey": "<PEM_PRIVATE_KEY_CONTENTS>",
    "installationId": "78901234",
  },
}
```

Serving several orgs with one App? List per-owner installations instead of (or
alongside) `installationId`; the owner of each mirror repo picks the right one:

```jsonc
{
  "githubApp": {
    "appId": "123456",
    "privateKey": "<PEM_PRIVATE_KEY_CONTENTS>",
    "installations": [
      { "account": "acme-inc", "id": "78901234" },
      { "account": "acme-labs", "id": "78905678" },
    ],
  },
}
```

Restart the Hub. On boot, `resolveGithubAppConfig` reads the block; both `appId`
and `privateKey` must be present or the block is ignored (`config.githubApp`
stays `null`) and the mirror silently falls back to the per-user token chain.

## 3. Protect the branch and add the App to the bypass list

On the mirror target repo: Settings → **Rules → Rulesets → New branch ruleset**.

1. **Target:** the default branch (e.g. `main`). Add release branches too if you
   protect those.
2. **Rules:** enable what you want enforced — typically **Restrict deletions**,
   **Block force pushes**, and **Require a pull request before merging**.
3. **Bypass list → Add bypass → GitHub Apps →** select your Hub App.
   - Choose **Always allow**. As of GitHub's Sept 2025 change you can instead
     pick the **exempt** bypass type for trusted high-volume automation — a
     silent skip that generates no per-push approval prompt, which suits the
     mirror well.

That's it. Human pushes to the protected branch are blocked; the Hub's mirror
push authenticates as the App, matches the bypass entry, and lands.

> Classic branch protection also works if you prefer it: enable **"Do not allow
> bypassing the above settings"** off, and add the App under **"Allow specified
> actors to bypass required pull requests"**. Rulesets are the recommended path —
> only rulesets support the newer _exempt_ bypass type.

## 4. Verify

Push something to the hosted default branch and watch the mirror:

- The `git_host_mirror` WebSocket event / mirror status should go to `synced`.
- `<bare>/agent-hub-mirror-state.json` records `lastSyncAt` with no `lastError`.
- On GitHub, the default branch advances and the commit's push actor is the App.

If the App is misconfigured (bad key, wrong installation, App not on the repo's
bypass list), the token mint returns `null` and the mirror falls back to the
per-user PAT — which the protection then rejects, so you'll see a push error in
the mirror state pointing you back here rather than a silent no-op.

## Rollback

Delete the `githubApp` block from `config.json` and restart. The mirror reverts
to the per-user OAuth/PAT token chain. (Remove the App from the ruleset bypass
list too, or loosen protection, so the fallback token can push.)
