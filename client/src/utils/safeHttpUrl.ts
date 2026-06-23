/**
 * Returns an absolute http(s) URL safe for use in href, or null.
 * Rejects javascript:, data:, etc. (defense against malicious skill frontmatter).
 *
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function safeHttpHref(raw: any) {
  if (raw == null || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {
    /* invalid URL */
  }
  return null;
}
