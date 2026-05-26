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

/** Path on the preview dev server (suffix after the proxy mount). */
export function previewUpstreamPath(reqUrl: string | undefined, sessionId: string): string {
  const mount = previewProxyMountPath(sessionId);
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

export function createPreviewUrlBase(
  publicUrl: string | null | undefined,
): (port: number, sessionId: string) => string {
  return (port, sessionId) => resolvePreviewClientUrl(publicUrl, sessionId, port);
}
