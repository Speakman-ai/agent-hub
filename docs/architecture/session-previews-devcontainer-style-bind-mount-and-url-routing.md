# Session Previews — Devcontainer-Style Bind-Mount + URL Routing Plan

> **Superseded on the app-wrapping half by the dev-server pivot.** This RFC's live-edit mechanism (bind-mounting the worktree into the entry-service *container*) no longer applies: the app runs as a **managed host process** that reads the worktree directly, so hot-reload is native and there is nothing to bind-mount. The URL-routing half (serving through the authenticated preview proxy, base-href injection, HMR-WS tunnelling) survives and is now driven by the `portMap` model. Canonical runtime model: [`devserver-preview-pivot-adr`](./devserver-preview-pivot-adr.md).

**Status:** Draft / RFC, 2026-05-26. Not implemented. Read alongside [`preview-model-worktree-previews-only`](./preview-model-worktree-previews-only.md) — this proposal upgrades the runtime behaviour of that model; it does **not** propose bringing back the PR-environments subsystem (#886).

This page answers the operator question: **"Why doesn't the preview iframe show the change my agent just made, and what should change so it does?"**

---

## TL;DR

Today's session-preview pipeline has two independent bugs that combine into the user-visible "white screen that never updates" experience:

| # | Problem | Today | Proposed |
|---|---------|-------|----------|
| **A** | **No live reload.** The compose entry image is built from the worktree at `docker compose up --build` time. After that, the container runs `ng serve` / `vite dev` / whatever — but watching files *inside the image*, not the host worktree. Agent edits to the worktree never reach the dev server's watcher. | Image-baked source, file watcher sees nothing change. | **Bind-mount the worktree** into the entry service at a conventional path, with **anonymous volumes** shadowing `node_modules` / `dist` / `.next` so build artifacts survive. Optionally use `docker compose watch` for fast sync. |
| **B** | **Asset URL mismatch behind the path-prefix proxy.** The proxy mounts every preview at `/api/sessions/<sid>/preview/proxy/`, but dev servers default to base `/`. The `<base href>` injection (preview-proxy.ts) handles HTML, but JS modules, HMR WebSocket URLs, and any string asset URL emitted by the dev server still resolve at the Hub root → 401/HTML in place of `main.js`, white screen, "Manifest: Syntax error". | Path-prefix proxy + base-href rewrite. Works for static HTML, breaks for any framework that emits absolute paths in JS. | Pick one of: **(B1)** publish an `AGENT_HUB_PREVIEW_BASE_PATH` env-var convention each app maps to its framework's base knob; or **(B2)** route session previews by **subdomain** (`<short>.preview.<host>`) so the app sees itself at `/` and zero per-app config is needed. |

Problems A and B are orthogonal; either can ship without the other. **A** is required for the iterate-on-changes loop to exist at all. **B** is required for the page to render once changes propagate.

---

## Background — what's there today

The PreviewComposeRuntime (`server/preview/preview-compose-runtime.ts`) spawns `docker compose up --build` against the worktree, allocates a host port in `4100–4999`, and registers `getSessionPreviewPort(sessionId) → port`. The proxy (`server/preview/preview-proxy.ts`) accepts requests at `/api/sessions/<sid>/preview/proxy/...` and forwards them to that port. The compose override that gets injected (`buildComposeOverrideYaml`) **only** sets the host-port mapping — no env vars, no volumes, no `develop.watch` rules.

Auth: iframe top-level nav uses a single-use `ticket` → path-scoped `HttpOnly` cookie (see [`preview-auth.ts`](../../server/preview-auth.ts)). PWA manifest fetches bypass auth (#1111 + #1122).

The PR-environments subsystem (wildcard ACM, host nginx for `*.preview`, container pool) was **deliberately removed** in PR #886. Session previews use the path-prefix proxy *because* that decision was taken — no per-deploy infra, no DNS-01, no cert renewal. Any subdomain-based proposal needs to make peace with that decision (see B2).

---

## Problem A — Bind-mount the worktree

### What needs to happen

The entry service's image keeps its baked-in `node_modules` (and any other artifact dirs), but `/app` (or wherever WORKDIR is) gets overlaid by the host worktree so the file watcher sees host edits.

### Proposed compose override

`buildComposeOverrideYaml` is extended to emit:

```yaml
services:
  <entryService>:
    ports: !override
      - "<hostPort>:<entryPort>"
    volumes:
      - "<worktreePath>:/workspace"          # host worktree → in-container source
      - "/workspace/node_modules"            # anonymous; preserves image's deps
      - "/workspace/.next"                   # only relevant for Next apps
      - "/workspace/dist"                    # only relevant for build-then-serve apps
    environment:
      AGENT_HUB_WORKTREE_PATH: /workspace
```

The set of anonymous-volume shadows is the union of "directories an app is likely to fill itself"; bind-mount semantics mean any path *under* `/workspace` that's then declared as an anonymous volume wins (the bind doesn't see into it). Existing apps that don't write to those paths are unaffected.

### Per-app contract

Apps opt into live reload by:
1. Setting `WORKDIR /workspace` (or referencing `${AGENT_HUB_WORKTREE_PATH}` in their compose).
2. Ensuring their dev server is watching `/workspace` (default for `ng serve`, `vite dev`, `next dev`, `webpack-dev-server`, `nodemon`, `air`, `cargo watch`, etc.).

If the app doesn't follow this convention, the bind-mount is a no-op for it and behavior is identical to today.

### `docker compose watch` alternative

Compose 2.22+ ships `develop.watch` — sync rules per service that copy files into the container (or rebuild on certain changes). It's more selective than a raw bind-mount (the app's compose file declares which paths to sync, with ignore globs), and the user-perceived latency is comparable. We can emit a generic `watch` section as part of the override too:

```yaml
services:
  <entryService>:
    develop:
      watch:
        - action: sync
          path: <worktreePath>
          target: /workspace
          ignore:
            - node_modules/
            - .git/
            - dist/
            - .next/
```

Verdict: start with raw bind-mount + anonymous-volume shadows (simpler, works on Compose ≥ 2.0). Add `develop.watch` opt-in once we have data on how each framework's watcher behaves on bind-mounted FUSE/overlayfs.

### Risks for A

- **node_modules collisions.** If the host worktree has its own `node_modules` (e.g. operator ran `npm install` locally), the anonymous volume hides it from the container *and* the operator can't see what the container is using. Acceptable cost; document it.
- **macOS bind-mount perf.** Local Hub installs run on macOS; bind mounts are slow there. `compose watch` is the real answer for the macOS path, but raw bind works for the EC2 case which is the immediate need.
- **Permissions.** Bind mounts preserve UID/GID from the host; container processes running as a non-root user may not be able to write into shadowed dirs. Need to verify per common base image.

---

## Problem B — URL routing

Two viable paths, with explicit trade-offs. The team should pick one and we close out the other.

### B1. `AGENT_HUB_PREVIEW_BASE_PATH` env-var convention

Agent-hub computes the mount path (`/api/sessions/<sid>/preview/proxy/`) at preview start and injects it into the entry service:

```yaml
services:
  <entryService>:
    environment:
      AGENT_HUB_PREVIEW_BASE_PATH: /api/sessions/<sid>/preview/proxy/
```

Each app's compose maps that to whatever its framework's base-URL knob is:

| Framework | Knob | Mapping |
|---|---|---|
| Angular CLI | `ng serve --serve-path=…` | `PREVIEW_SERVE_PATH: ${AGENT_HUB_PREVIEW_BASE_PATH:-/}` |
| Vite (standalone) | `vite --base=…` or `base:` in `vite.config` | `VITE_BASE: ${AGENT_HUB_PREVIEW_BASE_PATH:-/}` |
| Next.js | `basePath` in `next.config` | `NEXT_PUBLIC_BASE_PATH: ${AGENT_HUB_PREVIEW_BASE_PATH:-/}` |
| CRA | `homepage` in `package.json` / `PUBLIC_URL` | `PUBLIC_URL: ${AGENT_HUB_PREVIEW_BASE_PATH:-/}` |

**Pros**
- One small change in agent-hub (`buildComposeOverrideYaml` adds an `environment:` block).
- Zero new infra. No DNS, no cert, no nginx work.
- Each app opts in at its own pace; non-opted apps stay broken under path-prefix the same way they are today (no regression).

**Cons**
- Per-app config required. Some apps already wire `PREVIEW_SERVE_PATH` → `--serve-path`; others need a one-line compose change.
- Easy to forget: an app dropped into agent-hub for the first time will look broken until someone wires the env var.

### B2. Subdomain-based session previews

Each session preview gets a subdomain like `s-<short>.preview.agenthub.dev.example.com`. Host nginx terminates `*.preview.<host>`, agent-hub routes requests by `Host` header instead of path. App sees itself at `/`; no app config of any kind.

**Pros**
- Zero per-app config. The "doesn't matter what the app setup is" property the operator asked for.
- HMR WebSocket URLs work without any rewriting.
- Survives copy-pasting links from the address bar (no path prefix to strip).

**Cons** (and the architectural-decision conflict)
- Re-introduces the wildcard cert + DNS-01 dependency that PR #886 deliberately removed for the PR-envs subsystem. Different use case (session preview vs PR preview), but same operator footprint: a one-time wildcard ACM + Route 53 record + cert renewal cron. This needs explicit team buy-in *before* anyone writes code, since [`preview-model-worktree-previews-only`](./preview-model-worktree-previews-only.md) is canonical and lists "no DNS-01, no ACM cert" as a benefit.
- Host nginx vhost has to be added per Hub deployment (or one wildcard vhost forwards everything).
- Cookie auth model changes: today the preview cookie is path-scoped to `/api/sessions/<sid>/preview/proxy/`; under subdomains it becomes host-scoped — different security envelope, needs review.
- Local Hub installs (Electron, dev box) don't have a real DNS / wildcard cert. The path-prefix proxy stays in place as a fallback for those. Two code paths to maintain.

### Recommendation

**Start with B1 for the immediate unblock**, then re-litigate B2 separately as an architectural proposal once we have data on how often the per-app cost actually bites (one app? all of them?). B1 doesn't preclude B2 — the env var becomes a no-op once routing is by subdomain.

---

## Sequencing

Independent of A vs B1 vs B2:

| Phase | Scope | Estimated effort | Outcome |
|-------|-------|------------------|---------|
| **0** | Spike — manually bind-mount worktree into an Angular frontend on dev, confirm `ng serve` picks up host edits and HMR fires through the existing path-prefix proxy. | 0.5 day | De-risk **A**. Decides whether anonymous-volume shadows are sufficient or if we need `compose watch`. |
| **1** | Ship **A**: extend `buildComposeOverrideYaml` with `volumes` + `AGENT_HUB_WORKTREE_PATH`. Per-project config for shadow-dirs list. Unit + integration tests. | 2–3 days | Agent edits propagate to running preview. |
| **2** | Ship **B1**: same builder gains an `environment:` block with `AGENT_HUB_PREVIEW_BASE_PATH`. Wiki page documenting the per-framework mapping. An app's compose updated to consume it. | 1 day | Page renders correctly without operator changes for opted-in apps. |
| **3** | Operator-facing docs: "How to wire your app for live-edit session previews" — covers WORKDIR convention, env-var mapping, common pitfalls. | 0.5 day | Lower discovery cost for the next app. |
| **4** (optional) | Decision point: B2 yes/no. If yes, separate plan doc for subdomain routing, cert/DNS provisioning, nginx vhost, auth-cookie model change. | TBD per decision | — |

Total to unblock the operator's primary complaint: **~4 days of work** (Phases 0–3). Phase 4 is a separate, larger conversation.

---

## Open questions

1. **WORKDIR convention.** Is `/workspace` the right default? Most node base images use `/app`. We can default to `/app` and let projects override via per-project config.
2. **node_modules strategy.** Anonymous volume (current proposal) vs `npm ci` at container start vs `pnpm` content-addressable store mount. Pros/cons differ by team; default to anonymous volume.
3. **Worktree persistence.** Worktrees live on the agent-hub host's EBS volume today. Watch perf on EBS is fine (we measured ~1ms for stat); not a concern unless we move to network FS.
4. **Backend services.** Same architecture applies — bind-mount + `air` / `nodemon` / `pytest --watch` — but the env-var base path is irrelevant (backends are usually called by relative paths from the frontend bundle). Document but don't engineer for it specially.
5. **Non-Compose previews.** A few projects use a single Dockerfile + `docker run`. Out of scope here; PreviewRuntime handles those and the bind-mount question is identical but mechanism differs.

---

## What this proposal does NOT do

- Does not bring back the PR-environments subsystem. Session previews stay scoped to the operator iterating inside Agent Hub; per-PR public previews remain the CI provider's responsibility per the canonical model.
- Does not change the auth model under path-prefix (B1). It does flag the model change required for subdomain previews (B2), but defers that decision.
- Does not propose a CI / contract test that fails when an app forgets to wire `AGENT_HUB_PREVIEW_BASE_PATH`. That's a follow-up if B1 ships and the gap becomes a recurring issue.
