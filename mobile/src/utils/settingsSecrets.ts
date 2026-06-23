// Pure helpers for the Settings → Project Secrets tab (mobile). Mirrors
// server/routes/preview-secrets.ts + server/preview/preview-secrets-store.ts:
//   GET  /api/projects/:id/secrets          (Admin+)  → { secrets: [{key, value, kind}] }
//   PUT  /api/projects/:id/secrets          (Owner)   ← { secrets: [...] } (full replace)
//   DELETE /api/projects/:id/secrets/:key   (Owner)
//
// `secret`-kind rows come back with the MASK sentinel in `value`; PUTting
// MASK back for a secret-kind key means "keep the stored ciphertext".
/** Must match server/secret-crypto.ts MASK — the keep-unchanged sentinel. */
export const SECRET_MASK = '••••••••';
const VALID_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_KEY_RE = /^(AGENT_HUB_|NODE_|PATH$|HOME$)/;
/**
 * Client-side mirror of the server's key validation so users get instant
 * feedback instead of a 400 round-trip. Returns an error string or null.
 */
export function validateSecretKey(key: any) {
    const k = (key || '').trim();
    if (!k)
        return 'Key is required.';
    if (!VALID_KEY_RE.test(k)) {
        return 'Key must start with a letter or underscore and contain only letters, digits, and underscores.';
    }
    if (RESERVED_KEY_RE.test(k)) {
        return 'Key is reserved (AGENT_HUB_*, NODE_*, PATH, HOME are not allowed).';
    }
    return null;
}
/**
 * PUT /secrets is a full replace — any row omitted from the payload is
 * deleted. Build the upsert payload: every existing row passed through
 * verbatim (secret-kind rows keep the MASK sentinel so the server preserves
 * their ciphertext) with the new/edited entry replacing any same-key row.
 *
 * @param {Array<{key: string, value: string, kind: string}>} existing rows from GET
 * @param {{key: string, value: string, kind?: 'plain'|'secret'}} entry
 */
export function buildUpsertSecretsPayload(existing: any, entry: any) {
    const rows = Array.isArray(existing) ? existing.filter(Boolean) : [];
    const key = (entry.key || '').trim();
    const next = rows
        .filter((r: any) => r.key !== key)
        .map((r: any) => ({ key: r.key, value: r.value, kind: r.kind }));
    next.push({ key, value: entry.value, kind: entry.kind || 'secret' });
    return next;
}
/** Display value for a secret row: plain rows show the value, secret rows the mask. */
export function displaySecretValue(row: any) {
    if (!row)
        return '';
    if (row.kind === 'secret')
        return SECRET_MASK;
    return row.value ?? '';
}
/**
 * Map a thrown api error (message shaped "403: detail" by fetchJSON) to a
 * friendly permission explanation, or null when it isn't a permission error.
 * GET requires Admin; PUT/DELETE require Owner.
 */
export function describeSecretsPermissionError(err: any, action: any = 'read') {
    const msg = err?.message || '';
    if (!/^403\b/.test(msg))
        return null;
    if (action === 'read') {
        return 'You need the Admin role on this project to view its secrets.';
    }
    return 'You need the Owner role on this project to change its secrets.';
}
