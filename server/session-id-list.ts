/**
 * Session-id list helpers with no dependencies, so migrations can import them
 * without pulling in the session modules (and `db.ts`) behind them.
 */

/** `"a, a"` → `"a"`; `"a, b"` stays as-is; blank → null. */
export function collapseSessionIdList(raw: string): string | null {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const unique = [...new Set(parts)];
  return unique.length === 1 ? unique[0] : unique.join(', ');
}

export function isSingleSessionId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '' && !value.includes(',');
}
