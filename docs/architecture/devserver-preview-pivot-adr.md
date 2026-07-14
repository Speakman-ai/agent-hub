# ADR — Session Previews via a Managed Dev-Server Process (Pivot from Compose App-Wrapping)

**Status:** Accepted. Locked during the dev-server pivot spike sessions; core config + runtime + migration have shipped (see companion pages). This ADR is the canonical model for how a session preview boots.

**Supersedes:** the [`worktree-previews-compose-pivot-adr`](/projects/agent-hub/wiki/worktree-previews-compose-pivot-adr) wiki page (the compose-per-session **app-wrapping** decision) and the compose-app-wrapping portions of [`preview-model-worktree-previews-only`](./preview-model-worktree-previews-only.md).

This page records the decision to reverse the app-wrapping half of the 2026-05 Compose Pivot: a session's app now runs as a **managed long-lived host process** started from a configurable startup command, not wrapped in a per-session `docker compose` project. `docker compose` stays available inside the session env for the project's **own backing services** (Postgres, Redis, Mailhog), which keeps the one thing the compose pivot got right: the project's own service definitions are the source of truth.

---

## Context

The 2026-05 Compose Pivot wrapped the whole app in a per-session `docker compose` project keyed by session id, exposed the entry web service on one host port, and served it through the authenticated preview proxy. It fixed the path-prefix-proxy integration tax (per-framework middleware, base-href flags) and gave per-session backing-service isolation.

It also carried costs that compounded per session:

1. **`entryService` / `entryPort` / `PORT` gymnastics** — the published mapping is `hostPort:entryPort`, so the in-container dev server had to listen on the entry (container-internal) port, and `PORT`/`FRONTEND_PORT` had to be injected as `entryPort` (not `hostPort`). Getting this wrong produced a dead published port and a full-budget health timeout (support tickets 27cc6705, 904566fa).
2. **Multi-minute cold builds per session** — `docker compose up --build` on a cold cache burned minutes before the app was reachable, forcing a two-phase readiness budget (`buildCompletedAtMs` deadline rebase) just to stop heavy first builds from tripping the health timeout mid-build.
3. **No real shell for tests** — the agent's own Bash tool ran on the host while the app ran inside a container, so "run the tests the app runs" meant `docker compose exec` gymnastics.
4. **Rigidity** — every framework's dev-server port binding had to be discovered and re-plumbed through compose env interpolation.

## Decision

**Run the app as a managed host process.** The Hub owns its lifecycle:

- **Startup command** — a configurable `devServer.startCommand` (default `npm run dev`). It can bring backing services up first: `docker compose up -d --wait db redis && npm run dev`.
- **Lifecycle** — the Hub owns start / stop / restart, streams stdout+stderr as logs, injects env + resolved secrets at spawn, and reaps on idle / session-end.
- **Backing services stay in compose** — the project brings its own service compose file; the startup command runs `docker compose up -d` for those. The **app itself never runs as a compose entry service**.
- **Ports** — the app's dev-server port(s) are declared in a `portMap` and mapped out through the existing authenticated preview proxy (loopback-only upstream). No raw host:port iframe, no cert/DNS work.

This keeps the compose-pivot win ("project's own service definitions are the source of truth" for backing services) while dropping the app-wrapping tax: a direct process boots faster, gives a real shell for tests, and is more flexible per framework.

## Locked spec decisions

These were locked during the spike sessions. Each has a companion page with the implementation detail.

| Decision           | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Companion page                                                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **process-model**  | App runs as a managed long-lived host process from `devServer.startCommand` (default `npm run dev`); Hub owns start/stop/restart + log streaming + reap; compose kept for backing services only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | [`dev-server-runtime-log-streaming-snapshot-replay-two-phase-readiness`](/projects/agent-hub/wiki/dev-server-runtime-log-streaming-snapshot-replay-two-phase-readiness)                                                                                                                                                      |
| **terminal-stack** | `@xterm/xterm` v6 (scoped; unscoped `xterm` is deprecated) + `node-pty` v1.1 as the server PTY, over a dedicated WebSocket channel. Persistence via a server-side pty-host buffer (`@xterm/headless` + `@xterm/addon-serialize`): PTY outlives the client, replay one serialized snapshot + SIGWINCH on reconnect. Mobile renders `@xterm/xterm` in `react-native-webview`. Rejected turnkey ttyd/wetty/gotty.                                                                                                                                                                                                                                                                                                                          | [`pty-host-daemon-persistent-shell-snapshot-replay-single-writer-queue`](/projects/agent-hub/wiki/pty-host-daemon-persistent-shell-snapshot-replay-single-writer-queue), [`terminal-react-tool-agent-observe-inject-at-idle`](/projects/agent-hub/wiki/terminal-react-tool-agent-observe-inject-at-idle)                     |
| **shared-pty**     | Never let two clients write the PTY master concurrently. Funnel all input through a single server-side writer queue at message granularity; disable client local echo (PTY echo round-trips to every viewer); one resize authority (lock TIOCSWINSZ or debounce to `min(cols,rows)`, tmux `window-size smallest`). Agent + human default to turn-taking (agent injects only at an idle prompt).                                                                                                                                                                                                                                                                                                                                         | [`pty-host-daemon-persistent-shell-snapshot-replay-single-writer-queue`](/projects/agent-hub/wiki/pty-host-daemon-persistent-shell-snapshot-replay-single-writer-queue)                                                                                                                                                      |
| **secrets**        | Reuse the existing encrypted-at-rest project-secrets store (same mechanism as Finalize project secrets). `devServer` references secret **keys**; the server injects resolved values into the process env at spawn and never returns plaintext (write-only in the UI, masked on read).                                                                                                                                                                                                                                                                                                                                                                                                                                                   | [`dev-server-config-schema-project-prenv-devserver`](/projects/agent-hub/wiki/dev-server-config-schema-project-prenv-devserver)                                                                                                                                                                                              |
| **port-model**     | Reuse the same-origin authenticated reverse proxy (`server/preview/preview-proxy.ts`), not raw host:port iframes or a new wildcard-subdomain proxy. Upstream ports bind **loopback only**. Config is `portMap: { internalPort, label, primary }[]` (reuses the 4100–4999 allocator). The `primary` port keeps `/preview/proxy/`; extra ports get `/preview/proxy/p/<internalPort>/`. Subdomain mode (`AGENT_HUB_PREVIEW_SUBDOMAIN_BASE`) stays an opt-in escape hatch. Wildcard-subdomain-as-default deferred; raw `0.0.0.0` publish rejected.                                                                                                                                                                                          | [`sessionenv-abstraction-interface-host-adapter-backend-registry`](/projects/agent-hub/wiki/sessionenv-abstraction-interface-host-adapter-backend-registry), [`compose-devserver-preview-migration-mapping`](/projects/agent-hub/wiki/compose-devserver-preview-migration-mapping)                                           |
| **isolation**      | Build the runtime, PTY host, and port mapping against a `SessionEnv` abstraction (spawn process, open PTY, map ports out, mount worktree) with pluggable backends. v1 ships two adapters: **HOST** (direct host processes; local-dev/Mac path + fast fallback) and **SYSBOX** (per-session rootless container via sysbox-runc, no `--privileged`, no host docker socket; the default boundary on a self-hosted Linux server, runs the project's own compose backing services natively inside). Sysbox is a container runtime (userns + idmapped-mounts, kernel ~5.5+), **not** a VM: no nested virt, runs on the existing single-EC2 topology. Firecracker microVM is the deferred hardened tier, gated on a real multi-tenant trigger. | [`sessionenv-abstraction-interface-host-adapter-backend-registry`](/projects/agent-hub/wiki/sessionenv-abstraction-interface-host-adapter-backend-registry), [`sysbox-host-prereq-capability-probe-sessionenv-adapter-selection`](/projects/agent-hub/wiki/sysbox-host-prereq-capability-probe-sessionenv-adapter-selection) |

## Config contract

`prEnv.devServer` on the project config:

```jsonc
{
  "prEnv": {
    "devServer": {
      "startCommand": "docker compose up -d --wait db redis && npm run dev",
      "cwd": "apps/web", // optional monorepo subdir
      "portMap": [{ "internalPort": 5173, "label": "web", "primary": true }],
      "healthPath": "/",
      "readyTimeoutMs": 300000,
      "env": { "PUBLIC_FLAG": "on" }, // non-secret
      "secretKeys": ["DATABASE_URL"], // names only; values injected at spawn
    },
  },
}
```

Full schema + validation: [`dev-server-config-schema-project-prenv-devserver`](/projects/agent-hub/wiki/dev-server-config-schema-project-prenv-devserver). The **app-wrapping** modes (`preview.compose.entryService`, `preview.startScript`, `preview.processes[]`) are retired; a compose `preview` block is still accepted for services-only setups, but the app never runs as a compose entry service.

## Migration from compose app-wrapping

`prEnv.preview.compose.entryService` maps to `prEnv.devServer` via a pure mapper (`server/preview/migrate-compose-preview.ts`) exposed at `GET /api/projects/:projectId/preview/migrate-devserver-plan`. `entryPort` becomes the primary `portMap` entry; `healthPath` / `readyTimeoutMs` carry over; `file` / `envFile` fold into the generated `startCommand` (with a `--scale <entryService>=0` double-start guard); live-mount fields (`entryWorkdir` / `shadowDirs`) drop. Full field-by-field mapping and warnings: [`compose-devserver-preview-migration-mapping`](/projects/agent-hub/wiki/compose-devserver-preview-migration-mapping). The preview-setup skill (v4+) drives the wizard onto this model.

## Consequences

- **Faster boot** — no per-session image build; the process starts in seconds, backing services `up -d --wait` once.
- **Real shell** — tests and ad-hoc commands run on the same host/adapter as the app.
- **Isolation is a swappable backend** — HOST for local dev, SYSBOX for the self-hosted server, Firecracker later, without a rewrite.
- **Accepted tradeoff** — a minority of apps that hardcode `/` for HMR/assets need the opt-in subdomain mode per project.

## See also

- [`preview-model-worktree-previews-only`](./preview-model-worktree-previews-only.md) — canonical "how do I see my change" page (annotated for this pivot).
- [`session-previews-devcontainer-style-bind-mount-and-url-routing`](./session-previews-devcontainer-style-bind-mount-and-url-routing.md) — the compose-era RFC (annotated as superseded on the app-wrapping half).
- [`wiring-an-app-for-live-edit-previews`](./wiring-an-app-for-live-edit-previews.md) — the compose live-edit opt-ins (annotated: no longer needed for the managed dev server).
