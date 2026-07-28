// Vite dev-server config for running INSIDE an Agent Hub session preview, to get
// live hot-module-reload of the agent-hub client against the session worktree.
//
// Activated by AGENT_HUB_PREVIEW=1, exported by `devServer.startCommand` in
// `.agent-hub/preview.json`. Returns null outside preview, so normal
// `npm run dev` / `npm run build` are completely unaffected — the gate is a
// single env var.
//
// ⚠️ REQUIRES Agent Hub **subdomain preview mode** (the app is served at the
// subdomain root, base `/`). In path-prefix mode the Hub proxy strips the mount
// and a dev server's absolute module URLs (/@vite/client) 404 → white screen.
// See ops/RUNBOOK-subdomain-preview-hmr.md.

export function isPreviewMode(env: any) {
  return env.AGENT_HUB_PREVIEW === '1';
}

/** Port the nested Agent Hub API binds when none is pinned. Mirrors `config.ts`. */
const DEFAULT_API_PORT = 3051;

/** Vite's normal local-dev port, and the fallback when `PORT` is absent. */
export const DEFAULT_PREVIEW_CLIENT_PORT = 3050;

/**
 * The fixed internal hostname the Hub reaches the dev server over — both the
 * readiness probe and the preview proxy connect via
 * `AGENT_HUB_PREVIEW_HEALTH_HOST` (default `host.docker.internal` in the
 * DinD deployment), never the public subdomain. Vite MUST allow it.
 */
export function resolvePreviewUpstreamAllowedHost(env: any) {
  return (env.AGENT_HUB_PREVIEW_HEALTH_HOST || 'host.docker.internal').trim();
}

/**
 * Resolve Vite's `server.allowedHosts` for preview mode without resorting to a
 * blanket `true`. Order of precedence:
 *   1. AGENT_HUB_PREVIEW_ALLOWED_HOSTS — explicit override. `*`/`all` is an
 *      explicit opt-in to the unrestricted mode; otherwise a comma list.
 *   2. AGENT_HUB_PREVIEW_SUBDOMAIN_BASE — derive `.<base>`, which allows the
 *      base host and every `<id>.preview.<base>` session subdomain (Vite treats
 *      a leading-dot entry as "this host + all subdomains").
 *   3. Neither set — most restrictive. Vite still always allows localhost /
 *      loopback; unknown external Hosts are rejected until an operator opts in.
 *
 * In ALL non-`true` cases the upstream host (see
 * {@link resolvePreviewUpstreamAllowedHost}) is appended. The subdomain-base
 * entry only allows the *public* Host; but the Hub's preview proxy forwards the
 * *internal* upstream Host (`host.docker.internal`) it connects over. Vite 5
 * rejects any non-allow-listed Host with a 403 ("Blocked request. This host is
 * not allowed."). The readiness probe hides this by faking `Host: localhost`,
 * so the preview shows "ready" while every proxied iframe request 403s. Always
 * allowing the upstream host keeps the proxy path working too.
 *
 * Returns `true` only when explicitly requested.
 */
export function resolvePreviewAllowedHosts(env: any) {
  const upstreamHost = resolvePreviewUpstreamAllowedHost(env);
  const withUpstream = (hosts: any) => {
    if (upstreamHost && !hosts.includes(upstreamHost)) hosts.push(upstreamHost);
    return hosts;
  };

  const explicit = (env.AGENT_HUB_PREVIEW_ALLOWED_HOSTS || '').trim();
  if (explicit) {
    if (explicit === '*' || explicit === 'all') return true;
    return withUpstream(
      explicit
        .split(',')
        .map((h: any) => h.trim())
        .filter(Boolean),
    );
  }
  const base = (env.AGENT_HUB_PREVIEW_SUBDOMAIN_BASE || '').trim().replace(/^\.+/, '');
  const hosts = [];
  if (base) hosts.push(`.${base}`);
  return withUpstream(hosts);
}

export const PREVIEW_WATCH_IGNORED = ['**/.agent-hub-preview/**'];

/**
 * Build the Vite `server` config for preview/HMR mode, or null when not in a
 * session preview. Kept a pure function of `env` so it is unit-testable
 * without running the full vite.config.js (which shells out to git, etc.).
 */
export function buildPreviewServerConfig(env: any) {
  if (!isPreviewMode(env)) return null;

  // The dev-server runtime injects PORT from the PRIMARY portMap entry's
  // mapping — a pool-allocated host port on the host session-env backend, the
  // configured internal port under sysbox. Binding anything else leaves the
  // readiness probe dialling a dead port until the budget expires.
  const port = Number(env.PORT) || DEFAULT_PREVIEW_CLIENT_PORT;
  // `npm run dev` also starts the nested Agent Hub API in the same env, so the
  // dev client talks same-origin and Vite proxies to it over loopback.
  // AGENT_HUB_PORT is what the nested API binds; keep the two in lockstep.
  const apiTarget =
    env.AGENT_HUB_PREVIEW_API_TARGET ||
    `http://127.0.0.1:${Number(env.AGENT_HUB_PORT) || DEFAULT_API_PORT}`;
  // HMR rides the Hub preview proxy's WebSocket tunnel. The public origin is TLS
  // on 443 while Vite listens on `port` internally, so the HMR client must be
  // told the public port/protocol. Defaults suit the prod TLS deployment;
  // override for a plain-http Hub.
  const hmrClientPort = Number(env.AGENT_HUB_PREVIEW_HMR_CLIENT_PORT) || 443;
  const hmrProtocol = env.AGENT_HUB_PREVIEW_HMR_PROTOCOL || 'wss';

  return {
    host: '0.0.0.0',
    port,
    // Vite 5 rejects requests whose Host isn't allow-listed. Restrict to the
    // `*.preview.<base>` session subdomains rather than a blanket `true` (the
    // dev server also proxies /api same-origin). See resolvePreviewAllowedHosts.
    allowedHosts: resolvePreviewAllowedHosts(env),
    hmr: { protocol: hmrProtocol, clientPort: hmrClientPort },
    // Under the sysbox session backend the worktree is bind-mounted into a
    // per-session container, and inotify can miss events across the mount, so
    // poll to keep HMR reliable on both backends.
    watch: { usePolling: true, interval: 300, ignored: PREVIEW_WATCH_IGNORED },
    proxy: {
      // `/api` includes the dedicated session-terminal WebSocket route, so it
      // must forward upgrade requests as well as ordinary REST traffic.
      '/api': { target: apiTarget, ws: true },
      '/uploads': apiTarget,
      '/design-files': apiTarget,
      // The nested app opens a same-origin WebSocket at `/ws` for live chat
      // streaming and real-time updates. Without `ws: true` Vite would not
      // upgrade it to the nested API, so the preview would load but never
      // stream. Distinct from Vite's own HMR socket (config above).
      '/ws': { target: apiTarget, ws: true },
    },
  };
}
