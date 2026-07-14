# Wiring an App for Live-Edit Session Previews

> **Superseded by the dev-server pivot.** The two opt-ins below (`entryWorkdir` + `shadowDirs` live-mount, and `AGENT_HUB_PREVIEW_BASE_PATH` asset-URL wiring) belonged to the compose **app-wrapping** model. That model is retired: the app now runs as a **managed host process** (`prEnv.devServer.startCommand`) that reads the worktree directly, so live edits are native (nothing to bind-mount). For apps compatible with the proxy mount path, asset URLs resolve through the `portMap` preview proxy without per-app base-path plumbing; apps that hardcode `/` for HMR or assets still need the opt-in subdomain mode. To wire an app now, author `prEnv.devServer` (see the **preview-setup** skill) and, for legacy `preview.compose` projects, run the migration plan at `GET /api/projects/:projectId/preview/migrate-devserver-plan`. Canonical model: [`devserver-preview-pivot-adr`](./devserver-preview-pivot-adr.md). The steps below are kept for historical context only.

**Audience:** project authors wiring their app's `docker-compose.preview.yml` so that Agent Hub session previews render correctly _and_ pick up agent edits without a restart. Both halves are opt-in per project — apps that don't follow these steps keep working the way they did before, just without the live-edit and with a broken iframe for frameworks that emit absolute asset URLs.

Read alongside [`preview-model-worktree-previews-only`](./preview-model-worktree-previews-only.md) (canonical preview model) and [`session-previews-devcontainer-style-bind-mount-and-url-routing`](./session-previews-devcontainer-style-bind-mount-and-url-routing.md) (the RFC these features ship from).

---

## TL;DR — two opt-ins

1. **Live edits reach the container** → set `prEnv.preview.compose.entryWorkdir` + `shadowDirs` in the project config. Make sure the entry service's image uses the same `WORKDIR`.
2. **Asset URLs resolve correctly inside the iframe** → make the app's dev-server command read `AGENT_HUB_PREVIEW_BASE_PATH` and pass it to the framework's base-URL knob.

Either can ship without the other. The asset-URL fix is the more user-visible one (white screen → page renders); live edit is the iterate-on-changes loop that makes previews worth using.

---

## Step 1 — live edits (Phase 1, opt-in)

Project config additions:

```jsonc
// PATCH /api/projects/<id>
{
  "prEnv": {
    "preview": {
      "enabled": true,
      "compose": {
        "entryService": "frontend",
        "entryPort": 4200,
        "entryWorkdir": "/workspace", // ← absolute in-container path
        "shadowDirs": ["node_modules", "dist"], // ← keep image-baked
      },
    },
  },
}
```

Agent Hub then emits a per-session compose override:

```yaml
services:
  frontend:
    ports: !override
      - '4123:4200'
    volumes: !override
      - '.:/workspace' # bind source = --project-directory
      - '/workspace/node_modules' # anonymous; preserves image's deps
      - '/workspace/dist' # anonymous; preserves build output
```

### Two things the app side must get right

**Image WORKDIR matches `entryWorkdir`.** If your Dockerfile has `WORKDIR /app` but you set `entryWorkdir: /workspace`, the bind mounts the worktree at `/workspace` but `npm run dev` runs from `/app` and sees the image-baked source. Either:

- Change the Dockerfile to `WORKDIR /workspace`, or
- Set `entryWorkdir` to whatever your Dockerfile uses (`/app`, `/srv`, etc).

**Shadow every directory the app writes to.** `node_modules` is the obvious one. Less obvious cases:

| Framework              | Directories to shadow                         |
| ---------------------- | --------------------------------------------- |
| Next.js                | `node_modules`, `.next`                       |
| Vite + Tailwind        | `node_modules`, `dist`, `node_modules/.vite`  |
| Angular CLI            | `node_modules`, `dist`, `.angular`            |
| Django (collectstatic) | `staticfiles`                                 |
| Rails (precompile)     | `tmp`, `public/assets`                        |
| Go (with build cache)  | `bin`, `vendor` (if checked in: don't shadow) |

If you miss one, the symptom is usually slow first-request (the dev server rebuilds artifacts that should have been image-cached) or, in some cases, an immediate import-resolution failure.

### macOS host gotcha

Bind mounts on macOS go through 9p/virtiofs and are noticeably slower than on Linux. If you run an Agent Hub host locally on macOS and watch latency spikes during the first build, the watcher in your dev server may need a polling backend. Most dev servers fall back automatically; if yours doesn't, set `CHOKIDAR_USEPOLLING=1` or the equivalent for your framework.

---

## Step 2 — asset URL base path (Phase 2, opt-in)

Agent Hub injects `AGENT_HUB_PREVIEW_BASE_PATH` into every preview's entry service environment. Its value ends with `/` and looks like `/api/sessions/<sid>/preview/proxy/`. Map it to whichever knob your framework exposes.

### Angular CLI

`ng serve --serve-path=…` is the right knob. Don't read the var from `angular.json` — the value is per-session and changes; just thread it via the command:

```yaml
# docker-compose.preview.yml
services:
  frontend:
    command:
      - sh
      - -c
      - npx ng serve --host 0.0.0.0 --port 4200 --serve-path=$${AGENT_HUB_PREVIEW_BASE_PATH:-/}
```

(`$$` escapes compose interpolation so the inner `$` reaches the shell.)

### Vite (standalone)

`base` in `vite.config.ts` is read at config-load. Pass it through env:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
export default defineConfig({
  base: process.env.AGENT_HUB_PREVIEW_BASE_PATH ?? '/',
});
```

```yaml
services:
  frontend:
    command: ['npx', 'vite', '--host', '0.0.0.0', '--port', '5173']
    # no extra env needed — agent-hub injects AGENT_HUB_PREVIEW_BASE_PATH
```

Vite's HMR WebSocket inherits the `base` automatically.

### Next.js

`basePath` in `next.config.js` is read at startup:

```js
// next.config.js
module.exports = {
  basePath: process.env.AGENT_HUB_PREVIEW_BASE_PATH?.replace(/\/$/, '') ?? '',
};
```

(Next requires no trailing slash; strip it.)

### Create React App / similar

CRA uses `PUBLIC_URL` at runtime:

```yaml
services:
  frontend:
    environment:
      PUBLIC_URL: ${AGENT_HUB_PREVIEW_BASE_PATH:-/}
```

### Generic SPA behind a static server

If your preview just serves `dist/` with nginx/Caddy, the `<base href>` in `index.html` is what matters. Either build with the right base baked in (Vite/CRA do this when `base`/`PUBLIC_URL` is set), or let Agent Hub's HTML rewriter handle it — `injectHtmlPreviewBaseHref` (preview-proxy.ts) overrides any `<base href>` with the correct mount path, so SPAs whose only path-dependence is the `<base>` tag work without any opt-in.

### Why the env var, not subdomain routing?

Subdomain previews (one host per session) would make all of this redundant — the app would see itself at `/` and no config would be needed. That's the destination but not the current state; it requires re-introducing a wildcard cert + DNS-01 dependency that was deliberately removed (see [`preview-model-worktree-previews-only`](./preview-model-worktree-previews-only.md)). Track it as Phase 4 of the [session-previews RFC](./session-previews-devcontainer-style-bind-mount-and-url-routing.md).

---

## Troubleshooting

### "White screen, console says `Manifest: Line 1, column 1, Syntax error`"

Your manifest URL is resolving outside the proxy mount — the browser receives HTML (the Hub auth gate or SPA fallback) where it expected `application/manifest+json`. Check:

1. The HTML `<base href>` shows the proxy mount path (Hub rewrites this automatically; if not, your upstream may be emitting `<base href>` with attributes the regex doesn't match — file a bug with the exact tag).
2. `<link rel="manifest" href="…">` is _relative_ (no leading `/`). If it's absolute (`href="/manifest.webmanifest"`), the `<base href>` doesn't help — change to relative or use Step 2's env var so the dev server emits the right absolute path.

### "Page renders but blank/empty white area"

Open DevTools → Network. Look for the JS bundle (`main.js`, chunks, etc):

- **200 text/html instead of text/javascript** → asset URL is absolute and resolves outside the proxy. Step 2 fixes this.
- **401 application/json** → cookie auth missing. The iframe top-level nav should mint a ticket → cookie; if your iframe URL was opened in a new tab without going through Agent Hub, there's no cookie.

### "Edits don't appear in the preview"

- Check the container's mounts: `docker inspect <container> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'`. The worktree should bind to `entryWorkdir`.
- Confirm `WORKDIR` in the image matches `entryWorkdir`. The dev server's CWD is what determines what it watches.
- For frameworks with explicit file-watching config (some Webpack setups, jest watchers), confirm the patterns include the bind path.
- macOS: try `CHOKIDAR_USEPOLLING=1`.

### "Container crashes immediately on start with `Cannot find module 'X'`"

`shadowDirs` is incomplete. The host bind clobbered something the image had. Add the missing dir (usually `node_modules`, `.next`, or framework-specific build cache).

### "First request is slow after a code change"

Expected for build-on-demand frameworks (Next.js, Vite production). HMR-based ones (Vite dev, ng serve) should be sub-second. If Vite dev is slow, suspect macOS bind perf (see step 1 gotcha).

---

## Reference: minimum opt-in for an Angular app

Concrete config verified on a dev deploy (`https://agenthub.dev.example.com`):

**Project config (PATCH `/api/projects/<your-project>`):**

```jsonc
{
  "prEnv": {
    "preview": {
      "enabled": true,
      "compose": {
        "file": "compose.preview.yml",
        "entryService": "frontend",
        "entryPort": 4200,
        "entryWorkdir": "/app",
        "shadowDirs": ["node_modules", "dist", ".angular"],
      },
    },
  },
}
```

**`compose.preview.yml` (in the app repo):**

```yaml
services:
  frontend:
    # … existing build/image …
    command:
      - sh
      - -c
      - npx ng serve --host 0.0.0.0 --port ${FRONTEND_PORT:-4200} --serve-path=$${AGENT_HUB_PREVIEW_BASE_PATH:-/} --allowed-hosts=.example.com --allowed-hosts=localhost --allowed-hosts=.localhost --allowed-hosts=host.docker.internal
```

That's the entire change on the app side.
