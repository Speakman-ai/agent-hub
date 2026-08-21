---
name: dev-server-setup
description: >-
  Guided walkthrough for authoring a project's managed dev-server config
  (`prEnv.devServer`). Triggered by Settings → Dev Server → Agent walkthrough
  or POST .../dev-server/setup-wizard. Reads the server-precomputed repo scan
  (start-command candidates, package manager, monorepo layout, framework/port
  guesses, existing config, README), confirms the start command, port map,
  health path, and env/secret split interactively, then persists via
  dev-server/setup-apply. Also checks the app itself is reachable from a remote
  browser (bind address, host allowlist, API base URL, trusted origins). The
  config lives in projects.json; only the reachability fixes touch the repo.
version: 1.2.0
keep-coding-instructions: true
---

# Dev Server Setup — author `prEnv.devServer`

Agent Hub runs the project as a **managed long-lived process** for session
previews: it spawns `devServer.startCommand` inside the session env, injects
non-secret env + resolved secrets, and maps `portMap[]` internal ports out
through the authenticated preview proxy. Your job is to author that config with
the user, then POST it to `setup-apply`.

The config itself is stored in the project record (`projects.json`), not in a
repo file — unlike the preview/rum/finalize wizards, there is nothing for
Finalize to push. The one exception is step 6: most apps assume the browser runs
on the same machine as the server, which is false for a preview, and correcting
that means editing the repo. Commit those edits on this session's branch.

This is a worktree-backed session, which lets the user click **Start preview**
afterward to boot the dev server and verify everything live.

Preview is gated **solely** by a configured `devServer.startCommand`: once
`setup-apply` persists one, **Start preview** works. The legacy `prEnv.enabled`
flag is a **no-op** — a leftover of the removed PR-environments subsystem that
the dev-server runtime never reads. There is no enable toggle to flip, and
`enabled: false` in the project config does **not** block the preview. Never
report it to the user as a blocker.

## Bound values

- **`PROJECT_ID`**, **`PROJECT_CWD`** — from kickoff. `PROJECT_CWD` is where the
  draft was scanned; your working directory is this session's worktree clone.
- **`$AGENT_HUB_URL`**, **`$AGENT_HUB_API_KEY`** — set for curl. Send
  `-H "X-API-Key: $AGENT_HUB_API_KEY"` on `setup-apply` and `wizard-complete`.
  If a wizard call returns HTTP **401**/**403**, halt and report the auth
  failure. **Never** ask the operator to paste a token into chat.

## Draft (start here)

The kickoff prompt embeds a server-computed draft — do **not** re-run scanners.
Key fields:

- `startCommandCandidates[]` — each `{ command, script, raw, recommended }`
  parsed from `package.json` scripts (package-manager aware). Offer these as
  `agenthub:ask` options, recommended first.
- `packageManager` — `npm` | `pnpm` | `yarn` | `bun` | null.
- `isMonorepo` / `monorepoDirs[]` — when true, decide whether the command runs
  from the repo root or a subdir; set `devServer.cwd` to the subdir.
- `frameworks[]` / `portGuesses[]` — inferred defaults for the port map.
- `healthPathGuess` — sensible readiness path default (usually `/`).
- `existing` — the project's current `prEnv.devServer` (edit it, do not clobber).
- `readme` — `{ path, excerpt }` for how the team runs the app locally.

## `prEnv.devServer` schema (mirror `server/dev-server-config.ts`)

| Field | Contract |
| --- | --- |
| `startCommand` | Non-empty string, run via `sh -c` from `cwd`/worktree root. Default `npm run dev`. Run backing services first if needed, e.g. `docker compose up -d --wait db && npm run dev`. |
| `env` | Map of **non-secret** `KEY: value`. POSIX key names. Reserved keys rejected: `PORT`, `AGENT_HUB_*`, `NODE_*`, `PATH`, `HOME`. |
| `secretKeys` | Array of secret **names** only — references into the encrypted project-secrets store. Must be disjoint from `env`. Plaintext never goes here. |
| `portMap` | Up to 16 `{ internalPort, label, primary? }`. Unique ports; exactly one `primary` (auto-promoted to the first if you omit it). Primary keeps `/preview/proxy/`; extras get `/preview/proxy/p/<port>/`. |
| `healthPath` | Optional readiness path on the primary port. Must start with `/`. |
| `readyTimeoutMs` | Optional int, 5000–3600000. Max wait for `healthPath` 2xx before the preview flips to failed. |
| `cwd` | Optional worktree-relative subdir (monorepo). No leading `/`, no `..`. |
| `aptPackages` | Optional array of OS-level (apt) package names the app needs at runtime but pip/npm can't supply — e.g. `imagemagick`, `libmagickwand-dev` (Python Wand / ImageMagick), `gdal-bin`, `libpq-dev`. Installed via `apt-get` **before** `startCommand`. Names are charset-validated (`a-z0-9`, `+.-`, optional `=version`); no shell metacharacters. **Only** installs when the Hub runs the **sysbox** session backend (isolated rootless per-session container). On the host backend the install is skipped with a loud warning in the preview logs — apt would need root and mutate the shared host. Up to 64 entries. |

## Walkthrough

1. **Read the README** at `PROJECT_CWD/<draft.readme.path>` and summarize local run steps.
2. **Start command** — `agenthub:ask` with `startCommandCandidates[].command`. For a monorepo, set `cwd` to the app subdir.
3. **Port map** — ask for each internal port + short label; mark one primary. Seed defaults from `portGuesses`.
4. **Health path** — ask (default `draft.healthPathGuess`); optional.
5. **Env vs secrets** — scan `process.env` / `import.meta.env` usage (`Read`/`grep` the source). For each var, ask whether it is non-secret (→ `env`) or a secret (→ `secretKeys` + a value stored via `secrets.env`). Never echo secret values back.
6. **System dependencies** — check whether the app needs native OS libraries that pip/npm can't install (a `MagickWand shared library not found` / `libGL.so` / `ImportError: lib*` crash at import is the tell). If so, add the apt package names to `aptPackages` (e.g. `imagemagick`, `libmagickwand-dev`). Tell the user these install only under the sysbox session backend; on the host backend they'll see a skip warning and must instead bake the libs into a compose image.
7. **Reachability from a remote browser** — work the checklist below and edit the repo where it fails. Skipping this is how a preview goes green and still shows a blank page or an app whose every request fails.

## Reachability from a remote browser

A preview browser is **not** on the machine running the app. It reaches a dev
server in the session env through the Hub's authenticated proxy, so four
assumptions that hold locally break, three of them silently. Check each against
the repo and fix what fails — these are real code edits, so commit them.

| # | Assumption that breaks | How it shows up | Fix |
| --- | --- | --- | --- |
| 1 | Server binds `127.0.0.1` | Preview never goes ready; health probe times out | Bind `0.0.0.0` (`vite --host 0.0.0.0`, `ng serve --host 0.0.0.0`, `manage.py runserver 0.0.0.0:8000`, `rails s -b 0.0.0.0`). Prefer a flag in `startCommand` over editing config. |
| 2 | Host header is trusted | Blank page, or a 400/403 the dev server explains in its own log | Allow the proxied host. Vite `server.allowedHosts`, webpack-dev-server `allowedHosts`, Django `ALLOWED_HOSTS`, Rails `config.hosts`. The proxy sends a container address that is not knowable ahead of time. |
| 3 | The API is at a loopback URL | **Page loads, every request fails.** The nastiest one — the preview looks fine | The client must not hardcode `http://127.0.0.1:<port>` / `localhost`. Derive it same-origin (see below) so extra ports resolve through their proxy mount. |
| 4 | Cross-site POSTs are trusted | GETs fine, every form/login 403s | Trust the preview origin: Django `CSRF_TRUSTED_ORIGINS`, Rails `protect_from_forgery` origin check, any framework "trusted origins" list. |

**Deriving the API base URL (#3).** The primary port is served under a base href
of `/api/sessions/<id>/preview/proxy/`, and every other port in `portMap` is
mounted at `/p/<port>/` on that same origin. So resolve the API root from the
document's base URI when one is present and fall back to the loopback default
otherwise, which leaves plain local dev untouched:

```ts
function resolveApiRootUrl(): string {
  const loopback = 'http://127.0.0.1:8000'; // unchanged for local dev
  if (typeof document === 'undefined') return loopback;
  const base = new URL(document.baseURI);
  const mount = /^(\/api\/sessions\/[^/]+\/preview\/proxy)\/$/.exec(base.pathname);
  return mount ? `${base.origin}${mount[1]}/p/8000` : loopback;
}
```

Staying same-origin is what keeps the preview's auth cookie attached and avoids
CORS entirely; a separate origin needs both solved.

**Never hardcode a deployment hostname in the repo.** The Hub's preview domain
differs per deployment, and a baked-in guess fails silently on every other one.
Read hosts and origins from environment variables and set those in
`devServer.env`, so the platform names its own domains:

```python
def _env_list(name):
    return [item.strip() for item in os.environ.get(name, "").split(",") if item.strip()]

ALLOWED_HOSTS = [".localhost"] + _env_list("EXTRA_ALLOWED_HOSTS")
CSRF_TRUSTED_ORIGINS = _env_list("EXTRA_CSRF_TRUSTED_ORIGINS")
```

Unset means empty, so local dev behaves exactly as before. Ask the user before
loosening anything to a wildcard, and keep it to dev-only settings files.

## Persist

```bash
curl -s -X POST "$AGENT_HUB_URL/api/projects/$PROJECT_ID/dev-server/setup-apply" \
  -H "X-API-Key: $AGENT_HUB_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "devServer": {
      "startCommand": "npm run dev",
      "cwd": "apps/web",
      "env": { "API_BASE_URL": "http://localhost:4000" },
      "secretKeys": ["STRIPE_SECRET_KEY"],
      "portMap": [{ "internalPort": 3000, "label": "web", "primary": true }],
      "healthPath": "/",
      "aptPackages": ["imagemagick", "libmagickwand-dev"]
    },
    "secrets": { "env": "STRIPE_SECRET_KEY=sk_test_...", "defaultKind": "secret" }
  }'
```

- `devServer.env` holds non-secret values; `devServer.secretKeys` lists secret
  NAMES; the plaintext secret values go in `secrets.env` as dotenv `KEY=value`
  lines (stored encrypted, referenced by name — never inlined into the config).
- On HTTP **400** the body is `{ "error": "prEnv.devServer.<path>: <message>" }`
  — fix that field and retry.

## Finish

1. Tell the user they can click **Start preview** on this session to boot the dev server and confirm it comes up on the mapped port.
2. `curl -s -X POST "$AGENT_HUB_URL/api/projects/$PROJECT_ID/dev-server/wizard-complete" -H "X-API-Key: $AGENT_HUB_API_KEY"` so Settings refetches.
3. End with `<agenthub:close-card>`.

Do **not** create a new branch and do **not** create or move any kanban card.

## Auth failure

A `401`/`403` from a wizard curl means the injected `$AGENT_HUB_API_KEY` was not
accepted. Halt, report the exact status and endpoint, and stop — do not retry in
a loop and never ask the operator to paste a token into chat.
