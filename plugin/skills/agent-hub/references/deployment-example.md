# Deployment — Example Template (unlinked)

> **Stub.** This is an example scaffold for self-hosting Agent Hub. Replace every
> angle-bracket placeholder (`<your-host>`, `<your-bucket>`, `<your-role>`, etc.)
> with values from your own infrastructure. Agent Hub does **not** ship with a
> reference deployment and encodes no hostnames, bucket names, or IAM roles.
>
> This file is intentionally **not linked from SKILL.md** — it's reserved as a
> placeholder for operator-facing docs so the no-prod-infra guard has something
> to assert against. For the agent-facing surfaces, start at
> [SKILL.md](../SKILL.md).

## Topology

A typical Agent Hub server deployment:

```
Browser / Mobile / Desktop
           │
           ▼
    <your-host>:443            ← TLS-terminating reverse proxy
           │
           ▼
  localhost:3051 (Node.js)     ← Express + WebSocket, managed by PM2 / systemd
           │
           ▼
   SQLite (local, WAL mode)
```

## Environment Variables

| Variable           | Example                                     | Purpose                                          |
| ------------------ | ------------------------------------------- | ------------------------------------------------ |
| `PORT`             | `3051`                                      | HTTP/WebSocket port bound by the Node process.   |
| `ALLOWED_ORIGINS`  | `https://<your-host>`                       | Comma-separated browser origin allowlist (CORS). |
| `DATA_DIR`         | `/var/lib/agent-hub`                        | Where SQLite, configs, and workspaces live.      |
| `PUBLIC_URL`       | `https://<your-host>`                       | External URL used for webhook and PR callbacks.  |

> **Security:** `ALLOWED_ORIGINS` should list only the hosts your real web
> clients use. Unknown origins get no CORS header and the browser's SOP blocks
> them. Non-browser clients (Electron, mobile, server-to-server) bypass CORS
> because they don't send an Origin header.

## Reverse Proxy

Any TLS-terminating proxy works (Nginx, Caddy, Traefik, an ALB). Forward HTTP
and WebSocket traffic to `localhost:3051`:

```nginx
server {
  listen 443 ssl http2;
  server_name <your-host>;

  location / {
    proxy_pass http://localhost:3051;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

If you sit behind a non-loopback proxy (ALB, Cloudflare, etc.), revisit the
`trust proxy` value in `server/index.ts` so per-IP rate limits still see the
real client address.

## Process Manager

PM2 is one option; systemd, Docker, or Nomad are equally fine. A PM2 example:

```bash
# Start (one-time)
pm2 start ecosystem.config.cjs

# Update on deploy
git pull
npm install
npm run build
(cd server && npm install)
pm2 restart <your-pm2-app-name>
```

`ecosystem.config.cjs` lives in the repo root — set `name`, `cwd`, and env
values to match your environment.

## Desktop (Electron)

Agent Hub also ships as an Electron shell (`electron/main.js`) that boots the
same Express server in-process and loads the React client in a
`BrowserWindow`. Self-hosters who want to distribute their own installer need
to know three things the server-only deployment above doesn't cover.

### Two-runtime model — system Node vs. `ELECTRON_RUN_AS_NODE`

The shell spawns the server differently in dev vs. packaged builds, because
native modules (`better-sqlite3`) are ABI-specific to the Node runtime that
compiled them:

| Mode       | How the server is spawned                                             | Which Node compiled `better-sqlite3`           |
| ---------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| `dev`      | `spawn('node', [tsxCli, 'index.ts'])` — your system `node` on `$PATH` | System Node (`postinstall` → `npm rebuild`)    |
| `packaged` | `fork(tsxCli, ['index.ts'])` with `ELECTRON_RUN_AS_NODE=1`            | Electron's bundled Node (`electron-builder` rebuilds at packaging time) |

Dev deliberately avoids `ELECTRON_RUN_AS_NODE` so `npm run dev:server` and the
Electron dev shell share the same `better-sqlite3` build — otherwise a
developer who ran `npm rebuild` for system Node would see ABI errors when
launching the shell, and vice-versa. In packaged builds the opposite is true:
`electron-builder` rebuilds native modules against Electron's Node ABI, so the
fork must run under that same runtime.

If you swap Node versions or Electron majors, re-run `npm rebuild better-sqlite3`
for dev and let `electron-builder` handle packaged rebuilds.

### `asar` layout constraint

`electron-builder` packs the app into `app.asar`, except for anything listed
in `asarUnpack`. The defaults in the repo's `package.json` `build` block look
like this (values are structural, not secrets — keep them as-is unless you
know what you're changing):

```jsonc
"files": [
  "electron/**/*",
  "server/**/*",
  "client/dist/**/*",
  "package.json"
],
"asarUnpack": [
  "server/**/*",
  "node_modules/better-sqlite3/**/*",
  "node_modules/bindings/**/*",
  "node_modules/file-uri-to-path/**/*"
]
```

Consequences for self-hosters patching the server:

- **Root `package.json` lives inside `app.asar`.** It's read-only at runtime;
  don't try to write it from server code.
- **`server/` is unpacked** to `app.asar.unpacked/server/`, which is why
  `electron/main.js` resolves the server directory with
  `path.join(ROOT, 'server').replace('app.asar', 'app.asar.unpacked')`. If
  you add new server assets, keep them under `server/` so the `asarUnpack`
  glob picks them up.
- **Server modules must resolve paths relative to `server/`, never the repo
  root.** Anything computed off `process.cwd()` or a relative `../..` walk
  will land inside `app.asar` (read-only, and `fs` treats it as a virtual
  mount) instead of the unpacked tree. Use `import.meta.url` / `__dirname`
  and anchor from there.
- **Native addon bindings** (`better-sqlite3`, `bindings`,
  `file-uri-to-path`) are unpacked because they're loaded via `dlopen`, which
  cannot read from inside `app.asar`.

### `better-sqlite3` rebuild story

The native module is the single biggest source of packaging pain. The repo
pins three things that have to stay in sync:

1. **`package.json` `engines.node`** — currently `>=22.14.0 <23.0.0`. This
   matches the Node version bundled with Electron 35; bumping Electron majors
   almost always requires bumping this pin too. Check Electron's release
   notes for the embedded Node version before upgrading.
2. **`.nvmrc`** — pins the dev Node version (`22.14.0`) so contributors
   rebuild against the same ABI the packaged app will use. Keep it aligned
   with `engines.node`.
3. **`postinstall`** — runs `npm rebuild better-sqlite3` so cloning + `npm
   install` yields a working dev environment without a manual rebuild step.
   Packaged builds do *not* rely on this; `electron-builder` runs its own
   rebuild step against Electron's headers during `npm run electron:build`.

Day-to-day commands:

```bash
# Dev: rebuild after switching Node versions or pulling a fresh node_modules
npm run rebuild:native          # alias for `npm rebuild better-sqlite3`

# Packaged: build a DMG/AppImage/installer (electron-builder handles the rebuild)
npm run electron:build          # macOS DMG
npm run electron:pack           # --dir output for local smoke-test
```

If you see `Error: The module '.../better_sqlite3.node' was compiled against
a different Node.js version`, the runtime and the compiled binary are out of
sync — re-run `npm rebuild better-sqlite3` under the Node version that
matches your target runtime.

### Where to publish installers

See [Artifact Storage](#artifact-storage-optional) below for the bucket/role
placeholders the auto-updater expects. Agent Hub ships no default
auto-update feed — point it at your own infrastructure or disable the
updater entirely.

## Artifact Storage (optional)

If you publish desktop builds via the Electron auto-updater, point it at your
own bucket:

| Placeholder         | Example                  | Notes                                |
| ------------------- | ------------------------ | ------------------------------------ |
| `<your-bucket>`     | `my-org-hub-releases`    | S3/GCS/R2 bucket for DMG/exe/deb.    |
| `<your-role>`       | `hub-deploy-role`        | IAM role assumed by CI for uploads.  |
| `<your-region>`     | `us-east-2`              | Region for the bucket & role.        |

## CI / Deploy

The specifics depend on your CI system. A typical flow:

1. CI checks out the tag, runs `npm install && npm run build`.
2. CI packages/signs the Electron build (if releasing desktop).
3. CI uploads artifacts to `<your-bucket>` using `<your-role>`.
4. CI SSHs / invokes a remote command on `<your-host>` to `git pull` and
   restart the process manager.

This file is intentionally a stub. Fill in your own values; do **not** commit
real hostnames, bucket names, or IAM role ARNs back into this template.
