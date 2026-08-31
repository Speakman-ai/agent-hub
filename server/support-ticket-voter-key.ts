/**
 * Derive an opaque `voter_key` from a known user email.
 *
 * SHA-256(server_salt + lowercased/trimmed email). The votes table stores
 * only the hash, never the address. Callers that already have a stable
 * opaque token (or a per-browser device token) should pass that through as
 * `voterKey` instead of going through this helper.
 *
 * Salt must stay on the Hub: Survey Tracker cannot hash the same way without
 * it. The external voting API (and any Hub UI that knows the voter email)
 * should call this, then send the resulting key as `voterKey`.
 */
import { createHash } from 'crypto';

export function deriveVoterKeyFromEmail(email: string, salt: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new Error('email is required');
  }
  if (!salt) {
    throw new Error('vote salt is required');
  }
  return createHash('sha256').update(salt, 'utf8').update(normalized, 'utf8').digest('hex');
}
