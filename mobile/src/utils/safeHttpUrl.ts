/**
 * Returns an absolute http(s) URL safe to hand to `Linking.openURL`, or null.
 * Rejects javascript:, data:, etc. (defense against malicious skill frontmatter
 * `docs_url` values). Mirrors `client/src/utils/safeHttpUrl.ts` so web and
 * mobile gate credential documentation links identically.
 */
export function safeHttpHref(raw: any): string | null {
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
