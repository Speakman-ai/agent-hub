/**
 * Client-facing preview URLs and upstream targets for the session proxy.
 *
 * - Local / Electron: `publicUrl` unset → iframe loads `http://localhost:<port>`.
 * - Prod (Terraform + ALB): `AGENT_HUB_PUBLIC_URL` set → iframe loads the
 *   same-origin proxy so remote browsers never hit `localhost` on their laptop.
 */

export function resolvePreviewClientUrl(
  publicUrl: string | null | undefined,
  sessionId: string,
  port: number,
): string {
  const trimmed = typeof publicUrl === 'string' ? publicUrl.trim() : '';
  if (!trimmed) {
    return `http://localhost:${port}`;
  }
  // Path-only: the browser resolves against whatever origin loaded the Hub SPA.
  // Baking in `publicUrl` breaks when that host is wrong or unreachable from the
  // user's machine (e.g. hub.test in config but browsing via ALB IP / another name).
  return previewProxyMountPath(sessionId);
}

/** Host the Hub container uses to reach host-published preview ports. */
export function resolvePreviewUpstreamHost(): string {
  const fromEnv = process.env.AGENT_HUB_PREVIEW_HEALTH_HOST?.trim();
  if (fromEnv) return fromEnv;
  return '127.0.0.1';
}

export function previewProxyMountPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/preview/proxy`;
}

/**
 * Same-origin proxy mount for one dev-server `portMap` entry. The primary
 * port keeps the back-compat `/preview/proxy` mount; every extra port gets
 * a `/preview/proxy/p/<internalPort>` sub-mount so the proxy can route each
 * to its own loopback upstream (port-model epic decision).
 */
export function devServerPortProxyPath(
  sessionId: string,
  internalPort: number,
  primary: boolean,
): string {
  const mount = previewProxyMountPath(sessionId);
  return primary ? mount : `${mount}/p/${internalPort}`;
}

/**
 * Client-facing URL for one dev-server port entry. Local / Electron
 * (`publicUrl` unset) reaches the loopback host port directly; prod routes
 * through the same-origin authenticated proxy — the primary mount, or the
 * `/p/<internalPort>` sub-mount for every extra port.
 */
export function resolveDevServerPortClientUrl(
  publicUrl: string | null | undefined,
  sessionId: string,
  hostPort: number,
  internalPort: number,
  primary: boolean,
): string {
  const trimmed = typeof publicUrl === 'string' ? publicUrl.trim() : '';
  if (!trimmed) return `http://localhost:${hostPort}`;
  return devServerPortProxyPath(sessionId, internalPort, primary);
}

/**
 * Path on the preview dev server (suffix after a proxy mount). `mount` is
 * the mount to strip — the primary `previewProxyMountPath`, or the extra
 * port's `devServerPortProxyPath` — so an extra-port request forwards the
 * path AFTER its `/p/<internalPort>` segment, not the whole thing.
 */
export function previewUpstreamPathForMount(reqUrl: string | undefined, mount: string): string {
  const raw = reqUrl ?? '/';
  const q = raw.indexOf('?');
  const pathOnly = q >= 0 ? raw.slice(0, q) : raw;
  const query = q >= 0 ? raw.slice(q) : '';
  const idx = pathOnly.indexOf(mount);
  const suffix = idx >= 0 ? pathOnly.slice(idx + mount.length) : pathOnly;
  const normalized =
    suffix === '' || suffix === '/' ? '/' : suffix.startsWith('/') ? suffix : `/${suffix}`;
  return normalized + query;
}

/** Path on the preview dev server (suffix after the primary proxy mount). */
export function previewUpstreamPath(reqUrl: string | undefined, sessionId: string): string {
  return previewUpstreamPathForMount(reqUrl, previewProxyMountPath(sessionId));
}

export function createPreviewUrlBase(
  publicUrl: string | null | undefined,
): (port: number, sessionId: string) => string {
  return (port, sessionId) => resolvePreviewClientUrl(publicUrl, sessionId, port);
}
