/**
 * SSRF hardening for host-mediated browser navigation (`page.goto`).
 *
 * Blocks non-http(s) schemes, credentials-in-URL, loopback, RFC1918,
 * link-local / metadata-style targets, and obvious IPv6 equivalents.
 *
 * Limits (URL-string policy only):
 * - Cannot defeat DNS rebinding: a public hostname may later resolve to an
 *   internal address after validation.
 * - HTTP redirects: `browser-tools` applies the same rules to each main-frame
 *   document request via CDP Fetch when available, and validates the committed
 *   `page.url()` after navigation as a backstop.
 */

import { isIPv4, isIPv6 } from 'node:net';

export type BrowserNavigationUrlResult = { ok: true; href: string } | { ok: false; error: string };

/**
 * Optional policy relaxation for host-mediated browsing of targets the host
 * itself owns (e.g. the per-session docker-compose preview on
 * `http://localhost:<port>`).
 *
 * `allowOrigins` entries must be full origins (`scheme://host[:port]`) and are
 * compared against the URL's WHATWG `origin` — exact match only. A matching
 * origin bypasses the loopback/private-address blocks but NOT the scheme or
 * credentials-in-URL checks.
 */
export interface BrowserNavigationPolicyOpts {
  allowOrigins?: readonly string[];
}

/** True when `u`'s origin exactly matches an allowlisted origin. */
function isAllowlistedOrigin(u: URL, opts?: BrowserNavigationPolicyOpts): boolean {
  const allow = opts?.allowOrigins;
  if (!allow || allow.length === 0) return false;
  return allow.includes(u.origin);
}

function isBlockedDottedIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = o;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && o[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/** Node's WHATWG `URL.hostname` keeps brackets on IPv6 literals — strip for `net.isIP` / policy checks. */
function normalizeHostnameForPolicy(hostname: string): string {
  const h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) return h.slice(1, -1);
  return h;
}

function isBlockedIPv6Host(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1') return true;
  if (h.startsWith('::ffff:')) {
    const suff = h.slice('::ffff:'.length);
    if (isIPv4(suff) && isBlockedDottedIPv4(suff)) return true;
    // e.g. `::ffff:7f00:1` (normalized from `::ffff:127.0.0.1`) — last 32 bits as IPv4
    const compact = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(suff);
    if (compact) {
      const hi = parseInt(compact[1], 16);
      const lo = parseInt(compact[2], 16);
      const w32 = ((hi & 0xffff) << 16) | (lo & 0xffff);
      const a = (w32 >>> 24) & 255;
      const b = (w32 >>> 16) & 255;
      const c = (w32 >>> 8) & 255;
      const d = w32 & 255;
      const dotted = `${a}.${b}.${c}.${d}`;
      if (isBlockedDottedIPv4(dotted)) return true;
    }
  }
  if (h.startsWith('fe80:')) return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h.startsWith('ff')) return true;
  return false;
}

/**
 * Returns a normalized `href` safe to pass to `page.goto`, or an error.
 */
export function validateBrowserNavigationUrl(
  raw: string,
  opts?: BrowserNavigationPolicyOpts,
): BrowserNavigationUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'url is required' };

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https URLs are allowed for navigation' };
  }

  if (u.username || u.password) {
    return { ok: false, error: 'URLs with embedded credentials are not allowed' };
  }

  // Pinned-origin allowance (preview drive) — bypasses only the
  // loopback/private-target blocks below, never the scheme/credential checks.
  if (isAllowlistedOrigin(u, opts)) {
    return { ok: true, href: u.href };
  }

  const host = normalizeHostnameForPolicy(u.hostname);
  if (!host) {
    return { ok: false, error: 'URL has an empty host' };
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, error: 'Navigation to localhost is not allowed' };
  }

  if (host === 'metadata.google.internal') {
    return { ok: false, error: 'Navigation to this host is not allowed' };
  }

  if (isIPv4(host)) {
    if (isBlockedDottedIPv4(host)) {
      return {
        ok: false,
        error: 'Navigation to private, loopback, or restricted addresses is not allowed',
      };
    }
    return { ok: true, href: u.href };
  }

  if (isIPv6(host)) {
    if (isBlockedIPv6Host(host)) {
      return {
        ok: false,
        error: 'Navigation to private, loopback, or restricted addresses is not allowed',
      };
    }
    return { ok: true, href: u.href };
  }

  if (/^\d+$/.test(host)) {
    return { ok: false, error: 'Numeric host literals are not allowed' };
  }

  if (/^0x[0-9a-f]+$/i.test(host)) {
    return { ok: false, error: 'Hexadecimal host literals are not allowed' };
  }

  return { ok: true, href: u.href };
}

/**
 * Refusal messages produced by {@link validateBrowserNavigationUrl} that mean
 * "this is a local / private target". The generic `browser` tool appends a
 * pointer to the `preview` tool for these so the agent's recovery is one step.
 */
export function isLocalTargetRefusal(error: string | undefined): boolean {
  if (!error) return false;
  return (
    error.includes('Navigation to localhost is not allowed') ||
    error.includes('private, loopback, or restricted addresses')
  );
}

/** Hint appended to the generic browser tool's local-target refusals. */
export const BROWSER_LOCAL_TARGET_HINT =
  'This is the public-web browser (surface: web). To open this session\'s dev preview use the preview tool instead: {"tool":"preview","op":"navigate","route":"/…"} (a route path, not a URL).';

/** Hint appended when the preview drive browser leaves its pinned origin. */
export const PREVIEW_OFF_ORIGIN_HINT =
  'The preview tool only ever shows this session\'s dev preview (surface: preview). For public-web pages use the generic browser tool: {"tool":"browser","op":"navigate","url":"https://…"}.';
