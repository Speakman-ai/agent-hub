/**
 * rum-enrichment.ts — derive the low-cardinality request facets the RUM dashboard
 * filters on from the ingest HTTP request: device_type / browser / os (parsed
 * from the `User-Agent` header) and geo_country (resolved from the client IP).
 *
 * These are Datadog's "common facets" (see the facets spec decision): all
 * low-cardinality, index well as first-class columns on the `rum_sessions`
 * rollup row, and are computed once per session (first-non-null-wins, since a
 * browser session's UA/IP is stable). Everything here is PURE — no IO, no
 * network — so it unit-tests without mocks. The one external dependency, IP→
 * country, is injected as a `GeoResolver` function so the caller owns the geo
 * database (or lack of one) and tests can mock it.
 */

/** Device class, mirroring Datadog's low-cardinality `device.type` facet. */
export type DeviceType = 'Desktop' | 'Mobile' | 'Tablet' | 'Bot' | 'Other';

/** Parsed User-Agent facets. Each field is null when it can't be determined. */
export interface UserAgentFacets {
  deviceType: DeviceType | null;
  browser: string | null;
  os: string | null;
}

/** The full set of request-derived facet columns written on the session row. */
export interface SessionEnrichment {
  deviceType: DeviceType | null;
  browser: string | null;
  os: string | null;
  geoCountry: string | null;
}

/**
 * Resolve a client IP to an ISO 3166-1 alpha-2 country code (uppercase), or null
 * when it can't be resolved. Injected by the caller so the geo database is not a
 * hard dependency of enrichment — v1 ships without one (the default resolver
 * returns null), and tests mock it. A future card can wire a MaxMind/GeoLite
 * lookup here without touching the ingest path.
 */
export type GeoResolver = (ip: string) => string | null;

/** The default resolver: no geo database wired, so every IP resolves to null. */
export const nullGeoResolver: GeoResolver = () => null;

/** Detect a bot/crawler/spider UA — checked first so a headless crawler never
 *  counts as a real Desktop/Mobile user. */
function isBot(ua: string): boolean {
  return /bot\b|crawler|spider|crawling|slurp|mediapartners|headlesschrome|phantomjs|facebookexternalhit|bingpreview/i.test(
    ua,
  );
}

/**
 * Classify the device type. Order matters: bots first, then tablets (an Android
 * tablet UA has no "Mobile" token; iPad is always a tablet), then phones, else
 * desktop.
 */
function detectDeviceType(ua: string): DeviceType {
  if (isBot(ua)) return 'Bot';
  const isAndroid = /Android/i.test(ua);
  // iPad (incl. iPadOS reporting as Macintosh with touch is not distinguishable
  // from UA alone, so we only catch the classic iPad token) and Android-without-
  // Mobile are tablets; explicit Tablet/Kindle tokens too.
  if (/iPad/i.test(ua) || (isAndroid && !/Mobile/i.test(ua)) || /Tablet|Kindle|Silk/i.test(ua)) {
    return 'Tablet';
  }
  if (/Mobi|iPhone|iPod|Windows Phone|IEMobile|BlackBerry|(Android.*Mobile)/i.test(ua)) {
    return 'Mobile';
  }
  return 'Desktop';
}

/**
 * Detect the OS family. Order matters: Android before Linux (Android UAs contain
 * "Linux"), iOS before macOS (iOS UAs contain "like Mac OS X"), Chrome OS before
 * Linux.
 */
function detectOs(ua: string): string | null {
  if (/Windows Phone/i.test(ua)) return 'Windows Phone';
  if (/Windows NT|Windows/i.test(ua)) return 'Windows';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod|iOS/i.test(ua)) return 'iOS';
  if (/CrOS/.test(ua)) return 'Chrome OS';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return null;
}

/**
 * Detect the browser family. Order matters: Edge/Opera/Samsung before Chrome
 * (their UAs embed "Chrome"), Chrome before Safari (Chrome's UA embeds "Safari"),
 * in-app iOS wrappers (CriOS/FxiOS/EdgiOS) mapped to their real engine.
 */
function detectBrowser(ua: string): string | null {
  if (/Edg(A|iOS)?\/|Edge\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera|OPiOS\//.test(ua)) return 'Opera';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/UCBrowser\//.test(ua)) return 'UC Browser';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  if (/MSIE |Trident\//.test(ua)) return 'Internet Explorer';
  return null;
}

/**
 * Parse a `User-Agent` string into device/browser/os facets. Returns all-null
 * for a missing/empty UA. Pure — no IO. Intentionally covers the common desktop
 * and mobile families as low-cardinality buckets rather than exact versions
 * (versions would explode facet cardinality with no filtering value).
 */
export function parseUserAgent(ua: string | null | undefined): UserAgentFacets {
  if (typeof ua !== 'string' || ua.trim().length === 0) {
    return { deviceType: null, browser: null, os: null };
  }
  return {
    deviceType: detectDeviceType(ua),
    browser: detectBrowser(ua),
    os: detectOs(ua),
  };
}

/** Loopback / private / link-local / unique-local ranges that never geo-resolve
 *  to a public country. Cheap prefix checks — not a full CIDR parser. */
function isPrivateOrLocalIp(ip: string): boolean {
  if (ip === '' || ip === 'unknown') return true;
  if (ip === '::1' || ip === 'localhost') return true;
  // IPv4 private / loopback / link-local
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  // 172.16.0.0 – 172.31.255.255
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  return false;
}

/**
 * Normalize a raw client IP: strip an IPv4-mapped-IPv6 prefix (`::ffff:1.2.3.4`),
 * a zone id (`fe80::1%eth0`), and a trailing `:port` on a bare IPv4. Returns the
 * cleaned IP for the geo lookup. Pure.
 */
export function normalizeIp(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  let ip = raw.trim();
  if (ip.length === 0) return '';
  // IPv4-mapped IPv6, e.g. ::ffff:203.0.113.5
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  // Zone id on IPv6 link-local
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  // Trailing :port on a bare IPv4 (never strip from a bracketless IPv6)
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  return ip;
}

/**
 * Resolve a client IP to an ISO alpha-2 country code via the injected resolver.
 * Private/loopback/link-local IPs and anything the resolver can't map return
 * null. The resolver's output is normalized to a 2-letter uppercase code; a
 * malformed resolver return (wrong length, non-alpha) is treated as
 * unresolvable. Pure relative to the resolver.
 */
export function resolveGeoCountry(
  ip: string | null | undefined,
  resolver: GeoResolver = nullGeoResolver,
): string | null {
  const norm = normalizeIp(ip);
  if (isPrivateOrLocalIp(norm)) return null;
  let code: string | null;
  try {
    code = resolver(norm);
  } catch {
    return null;
  }
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

/**
 * Compute the full request-derived enrichment (device/browser/os + geo_country)
 * from the ingest request's User-Agent and client IP. Returns null when nothing
 * could be derived (no UA facets and no geo), so the caller can skip touching the
 * row's enrichment columns entirely. Pure relative to the injected geo resolver.
 */
export function computeEnrichment(input: {
  userAgent?: string | null;
  ip?: string | null;
  geoResolver?: GeoResolver;
}): SessionEnrichment | null {
  const ua = parseUserAgent(input.userAgent);
  const geoCountry = resolveGeoCountry(input.ip, input.geoResolver);
  if (ua.deviceType == null && ua.browser == null && ua.os == null && geoCountry == null) {
    return null;
  }
  return { deviceType: ua.deviceType, browser: ua.browser, os: ua.os, geoCountry };
}
