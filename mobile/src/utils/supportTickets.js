// Pure helpers for the Customer Support queue, factored out of the screen so
// they're unit-testable without pulling in react-native.
import { getServerBaseUrl } from './config';

// Severity → sort rank (most urgent first). Mirrors the server ORDER BY so
// WebSocket-inserted rows land in the right place without a refetch.
export const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

export function sortTickets(list) {
  return [...list].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] ?? 4;
    const sb = SEVERITY_RANK[b.severity] ?? 4;
    if (sa !== sb) return sa - sb;
    // Newest first within a severity, matching the server's created_at DESC.
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}

// Resolve a replay reference to an openable URL. Absolute URLs pass through;
// server-relative paths (e.g. /uploads/...) are prefixed with the server base.
export function resolveReplayUrl(ref) {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  const base = getServerBaseUrl();
  if (ref.startsWith('/')) return `${base}${ref}`;
  return `${base}/${ref}`;
}
