/**
 * Shared input validators for authentication endpoints + boot-time
 * provisioning. Lifted out of `routes/auth.ts` so the auto-provision
 * code in `auth-bootstrap.ts` can reuse the exact same rules — drift
 * between the two paths would let a Terraform-supplied password get in
 * that the interactive setup endpoint would reject.
 */

/**
 * Username allowlist: 1–64 chars of letters, digits, `.`, `_`, `-`, `@`.
 * Returns the trimmed value on success, or `null` to indicate rejection.
 */
export function sanitizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return null;
  if (!/^[a-zA-Z0-9_.\-@]+$/.test(trimmed)) return null;
  return trimmed;
}

// Minimum password length for every account. These credentials grant full
// server control (process spawning, arbitrary shell via CLI), so we follow
// NIST 800-63B guidance for privileged accounts (≥ 12).
export const MIN_PASSWORD_LEN = 12;
export const MAX_PASSWORD_LEN = 256;

/**
 * Returns the password as-is when within length bounds, `null` otherwise.
 * No transformation — passwords are accepted with leading/trailing spaces
 * intact (users who pasted them in expect them to round-trip).
 */
export function sanitizePassword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length < MIN_PASSWORD_LEN || raw.length > MAX_PASSWORD_LEN) return null;
  return raw;
}
