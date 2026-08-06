/**
 * Subdomain → session-id parsing for the optional "subdomain preview"
 * deployment mode.
 *
 * Background
 * ──────────
 * The default deployment serves session previews at a path prefix
 * (`/api/sessions/<sid>/preview/proxy/`). That works, but the upstream
 * dev server only renders correctly if the app explicitly maps the
 * `AGENT_HUB_PREVIEW_BASE_PATH` env var to its framework's base-URL knob
 * (Angular `--serve-path`, Vite `base`, Next `basePath`, CRA
 * `PUBLIC_URL`). Apps that don't wire it up get a white iframe — the
 * dev server emits asset URLs and HMR WebSocket URLs at `/` (its
 * default), they resolve at the Hub root instead of the proxy mount,
 * and the browser receives the Hub SPA fallback HTML in place of each
 * JS module.
 *
 * Subdomain mode dodges that problem entirely: each session preview
 * lives at `<sid>.preview.<base>`, the app sees itself at `/`, and
 * every framework's default config Just Works with zero per-app
 * wiring. The trade-off is the operator footprint — wildcard ACM cert
 * + Route 53 alias + an ALB listener cert attachment.
 *
 * Mode selection
 * ──────────────
 * Subdomain mode is **opt-in** via the `AGENT_HUB_PREVIEW_SUBDOMAIN_BASE`
 * env var (e.g. `preview.agenthub.dev.example.com`). Unset = mode
 * off, every code path falls back to the existing path-prefix proxy.
 * That means local Hub installs (Electron, dev box) and any deployment
 * without the wildcard cert keep working with no changes.
 *
 * Subdomain shape
 * ───────────────
 * `<sessionId>.<base>`                — the session's primary port.
 * `<internalPort>--<sessionId>.<base>` — one extra `portMap` entry.
 *
 * The session id is a UUID (e.g. `b371b1ba-37d3-4a10-8b44-40bd1cddcc6d`,
 * 36 chars). DNS labels max at 63 chars and accept `[A-Za-z0-9-]`, so
 * even the port-prefixed form (43 chars) fits comfortably. We don't
 * shorten — collision risk on a shortened id would silently route
 * session B's traffic to session A's upstream port, and "no collisions"
 * is much more important than "shorter URL."
 *
 * `--` is the separator because a UUID can never contain one, so the
 * split is unambiguous. It's the same convention Coder uses for
 * workspace port forwarding.
 *
 * Per-port subdomains matter for the same reason the mode exists at all:
 * an extra port served under a path prefix hits the identical
 * absolute-asset-URL problem as the primary did. A multi-port app (say a
 * frontend plus its API) only works end-to-end when *every* port renders
 * at `/`.
 *
 * Strictness
 * ──────────
 * The parser only matches when EVERY condition is met:
 *   - Subdomain mode is configured (`base` non-empty after trim).
 *   - The Host header is exactly `<label>.<base>` with a single label.
 *   - The label is a UUID, optionally prefixed with `<port>--` where
 *     port is 1–65535 with no leading zeros.
 *
 * Refusing to parse on the slightest mismatch is the load-bearing
 * safety property — a hostile Host header crafted to look like a
 * subdomain preview must NOT short-circuit auth or cause us to dispatch
 * the request to an arbitrary upstream port.
 */

/**
 * DNS-label-safe UUID match. Case-insensitive because Host headers are
 * case-insensitive by RFC; mismatched casing must not gate dispatch.
 */
const SESSION_ID_LABEL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Separator between the port prefix and the session id. */
const PORT_SEPARATOR = '--';

/** Which upstream a preview subdomain resolves to. */
export interface PreviewSubdomainTarget {
  sessionId: string;
  /**
   * Internal port of the `portMap` entry this hostname addresses, or
   * `null` for the bare `<sessionId>.<base>` form (the primary port).
   */
  internalPort: number | null;
}

/**
 * Parse the `<port>--` prefix. Rejects leading zeros and out-of-range
 * numbers so `0080--<uuid>` and `99999--<uuid>` don't reach the proxy
 * as near-miss variants of a legitimate hostname.
 */
function parsePortPrefix(raw: string): number | null {
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Strip a trailing `:port` from a Host header value. Express usually
 * delivers the bare hostname, but the underlying `req.headers.host`
 * preserves whatever the client sent — and proxies sometimes leave
 * the port on. Normalising up-front keeps the match simple.
 */
function stripPort(host: string): string {
  // IPv6 addresses are wrapped in [], strip those + their port.
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close === -1) return host;
    return host.slice(1, close);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * Resolve `host` to the session (and optionally the port) it addresses,
 * or `null` when it isn't a preview subdomain. Returns `null` when
 * `base` is unset/empty (subdomain mode off).
 *
 * Both arguments are normalised to lower-case and port-stripped before
 * comparison. The session id is returned lower-cased to match the
 * convention the auth middleware and DB use elsewhere.
 */
export function parsePreviewSubdomainHost(
  host: string | string[] | undefined | null,
  base: string | undefined | null,
): PreviewSubdomainTarget | null {
  if (!base) return null;
  if (typeof host !== 'string' || host.length === 0) return null;
  const cleanBase = stripPort(base.trim().toLowerCase()).replace(/^\.+|\.+$/g, '');
  if (!cleanBase) return null;
  const cleanHost = stripPort(host.trim().toLowerCase());
  if (!cleanHost) return null;

  // Must end in `.<cleanBase>` (note the leading dot — guards against
  // `xxxsessionidpreview.host` accidentally matching when base is
  // `host`). Using length math avoids re-allocating substrings.
  if (cleanHost.length <= cleanBase.length + 1) return null;
  const tail = cleanHost.slice(-(cleanBase.length + 1));
  if (tail !== `.${cleanBase}`) return null;

  const label = cleanHost.slice(0, cleanHost.length - cleanBase.length - 1);
  // Disallow nested subdomains (`foo.bar.<base>`). Only a single label
  // separates the session id from the base.
  if (label.includes('.')) return null;

  const sep = label.indexOf(PORT_SEPARATOR);
  if (sep === -1) {
    if (!SESSION_ID_LABEL_RE.test(label)) return null;
    return { sessionId: label, internalPort: null };
  }

  const internalPort = parsePortPrefix(label.slice(0, sep));
  const sessionId = label.slice(sep + PORT_SEPARATOR.length);
  if (internalPort === null) return null;
  if (!SESSION_ID_LABEL_RE.test(sessionId)) return null;
  return { sessionId, internalPort };
}

/**
 * Build the subdomain hostname for a given session under the configured
 * base. Pure mirror of {@link parsePreviewSubdomainHost} so client/UI
 * code that needs to construct the iframe `src` URL doesn't have to
 * reinvent the format and risk drift.
 *
 * Returns `null` when the base is unset — caller should fall back to
 * the path-prefix URL.
 */
export function buildPreviewSubdomainHost(
  sessionId: string,
  base: string | undefined | null,
  internalPort?: number | null,
): string | null {
  if (!base) return null;
  const cleanBase = stripPort(base.trim().toLowerCase()).replace(/^\.+|\.+$/g, '');
  if (!cleanBase) return null;
  if (!SESSION_ID_LABEL_RE.test(sessionId)) return null;
  const label = sessionId.toLowerCase();
  if (internalPort === undefined || internalPort === null) return `${label}.${cleanBase}`;
  if (parsePortPrefix(String(internalPort)) === null) return null;
  return `${internalPort}${PORT_SEPARATOR}${label}.${cleanBase}`;
}
