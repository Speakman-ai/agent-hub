/**
 * Helpers for the webhook author-allowlist UI.
 *
 * The backend stores the allowlist as a JSON string (e.g. `'["mcsteen"]'`) in
 * `webhook_configs.author_allowlist`. The UI represents it as a comma-separated
 * text input for human ergonomics. These helpers handle the two-way conversion
 * plus the usual trim/dedupe/empty-drop hygiene.
 */

/**
 * Parse a comma-separated user input into a normalized array of GitHub logins.
 *
 *   parseAllowlist("mcsteen, alice, ,  bob , alice")
 *     → ["mcsteen", "alice", "bob"]
 *
 * - Trims each entry
 * - Drops empty / whitespace-only entries
 * - Dedupes case-insensitively (first occurrence wins, original casing preserved)
 */
export function parseAllowlist(input) {
  if (typeof input !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const raw of input.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Serialize a normalized array back to a human-friendly comma-separated string
 * for display in the text input.
 *
 *   serializeAllowlist(["mcsteen", "alice"]) → "mcsteen, alice"
 *   serializeAllowlist([]) → ""
 */
export function serializeAllowlist(list) {
  if (!Array.isArray(list)) return '';
  return list.filter((s) => typeof s === 'string' && s.trim().length > 0).join(', ');
}

/**
 * Parse the raw column value from the backend (a JSON string) into an array.
 * Tolerates malformed JSON — returns `[]` so the UI never crashes.
 */
export function parseAllowlistFromBackend(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === 'string');
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
