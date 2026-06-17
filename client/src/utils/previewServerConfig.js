// Vite dev-server config for running INSIDE an Agent Hub session preview, to get
// live hot-module-reload of the agent-hub client against the session worktree.
//
// Activated by AGENT_HUB_PREVIEW=1 (set in compose.preview.yml's client service).
// Returns null outside preview, so normal `npm run dev` / `npm run build` are
// completely unaffected — the gate is a single env var.
//
// ⚠️ REQUIRES Agent Hub **subdomain preview mode** (the app is served at the
// subdomain root, base `/`). In path-prefix mode the Hub proxy strips the mount
// and a dev server's absolute module URLs (/@vite/client) 404 → white screen.
// See ops/RUNBOOK-subdomain-preview-hmr.md.

export function isPreviewMode(env) {
  return env.AGENT_HUB_PREVIEW === '1';
}

/**
 * Resolve Vite's `server.allowedHosts` for preview mode without resorting to a
 * blanket `true`. Order of precedence:
 *   1. AGENT_HUB_PREVIEW_ALLOWED_HOSTS — explicit override. `*`/`all` is an
 *      explicit opt-in to the unrestricted mode; otherwise a comma list.
 *   2. AGENT_HUB_PREVIEW_SUBDOMAIN_BASE — derive `.<base>`, which allows the
 *      base host and every `<id>.preview.<base>` session subdomain (Vite treats
 *      a leading-dot entry as "this host + all subdomains").
 *   3. Neither set — return [] (most restrictive). Vite still always allows
 *      localhost / loopback, so the Hub's `Host: localhost` health probe works;
 *      unknown external Hosts are rejected until an operator opts in.
 * Returns `true` only when explicitly requested.
 */
export function resolvePreviewAllowedHosts(env) {
  const explicit = (env.AGENT_HUB_PREVIEW_ALLOWED_HOSTS || '').trim();
  if (explicit) {
    if (explicit === '*' || explicit === 'all') return true;
    return explicit
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
  }
  const base = (env.AGENT_HUB_PREVIEW_SUBDOMAIN_BASE || '').trim().replace(/^\.+/, '');
  if (base) return [`.${base}`];
  return [];
}

/**
 * Build the Vite `server` config for preview/HMR mode, or null when not in a
 * preview container. Kept a pure function of `env` so it is unit-testable
 * without running the full vite.config.js (which shells out to git, etc.).
 */
export function buildPreviewServerConfig(env) {
  if (!isPreviewMode(env)) return null;

  const port = Number(env.FRONTEND_PORT) || 80;
  // The compose `server` service backs /api; the dev client talks same-origin
  // and Vite proxies to it. Overridable for non-compose harnesses.
  const apiTarget = env.AGENT_HUB_PREVIEW_API_TARGET || 'http://server:3051';
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
    // The worktree is bind-mounted in; inotify can miss events across the mount,
    // so poll to keep HMR reliable.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/api': apiTarget,
      '/uploads': apiTarget,
      '/design-files': apiTarget,
    },
  };
}
