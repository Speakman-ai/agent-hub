/**
 * google-connections-store.ts — Per-user Google identity + token persistence.
 *
 * Stores the link between an Agent Hub user (`users.id` in orgs.db) and their
 * Google account from the OAuth 2.0 web-server flow. Unlike the GitHub store
 * (plaintext columns on `users`), Google tokens are ENCRYPTED at rest with the
 * shared AES-256-GCM helper (`secret-crypto.ts`) and live in a dedicated
 * `google_connections` table (schema in `google-connections-schema.ts`).
 *
 * Transparent refresh:
 *   `getActiveAccessToken` checks the stored expiry and, if within the 5-minute
 *   safety window, calls `refreshGoogleAccessToken` and writes the rotated
 *   access token back before returning. Callers get a valid access token or
 *   `null` and never see the refresh machinery.
 *
 * Revocation:
 *   On `invalid_grant` (user un-linked the app / token revoked) the row is
 *   DELETED so the status endpoint reports "not connected" and the UI prompts
 *   for a re-link. This differs from the GitHub store, which leaves a dead row
 *   so it can report "connected but expired".
 */
import { getOrgsDb } from './orgs.js';
import { encryptSecret, decryptSecret } from './secret-crypto.js';
import {
  refreshGoogleAccessToken,
  GoogleInvalidGrantError,
  type GoogleOAuthCredentials,
} from './google-oauth.js';

export interface GoogleConnectionRow {
  userId: string;
  googleSub: string;
  googleEmail: string;
  accessToken: string;
  /** ISO timestamp of access-token expiry. Google access tokens always expire. */
  tokenExpiresAt: string | null;
  /** Long-lived refresh token (reusable; Google does not rotate it on refresh). */
  refreshToken: string | null;
  grantedScopes: string[];
  connectedAt: string; // ISO
}

export interface GoogleConnectionStatus {
  connected: boolean;
  email: string | null;
  grantedScopes: string[];
  connectedAt: string | null;
  tokenExpiresAt: string | null;
}

interface RawGoogleRow {
  user_id: string;
  google_sub: string;
  google_email: string;
  access_token_enc: string;
  token_expires_at: string | null;
  refresh_token_enc: string;
  granted_scopes_json: string;
  connected_at: string;
}

/**
 * Access tokens this close to expiry get pre-emptively rotated on read. Matches
 * the 5-minute window used by `github-connections-store.ts`.
 */
const REFRESH_SAFETY_WINDOW_MS = 5 * 60 * 1000;

function isoFromSecondsFromNow(seconds: number, now: number): string {
  return new Date(now + seconds * 1000).toISOString();
}

function parseScopes(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function rowToConnection(row: RawGoogleRow | undefined): GoogleConnectionRow | null {
  if (!row) return null;
  return {
    userId: row.user_id,
    googleSub: row.google_sub,
    googleEmail: row.google_email,
    accessToken: row.access_token_enc ? decryptSecret(row.access_token_enc) : '',
    tokenExpiresAt: row.token_expires_at,
    refreshToken: row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : null,
    grantedScopes: parseScopes(row.granted_scopes_json),
    connectedAt: row.connected_at,
  };
}

/**
 * Persist a fresh or re-consented connection. Tokens are encrypted before
 * write. Safe to call multiple times — `connected_at` is preserved across
 * reconnects (the first link timestamp survives a per-surface re-consent).
 */
export function upsertGoogleConnection(args: {
  userId: string;
  googleSub: string;
  googleEmail: string;
  accessToken: string;
  tokenExpiresAt: string | null;
  refreshToken: string | null;
  grantedScopes: string[];
  connectedAt?: string;
}): void {
  const db = getOrgsDb();
  const connectedAt = args.connectedAt || new Date().toISOString();
  db.prepare(
    `INSERT INTO google_connections
       (user_id, google_sub, google_email, access_token_enc, token_expires_at,
        refresh_token_enc, granted_scopes_json, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       google_sub = excluded.google_sub,
       google_email = excluded.google_email,
       access_token_enc = excluded.access_token_enc,
       token_expires_at = excluded.token_expires_at,
       refresh_token_enc = excluded.refresh_token_enc,
       granted_scopes_json = excluded.granted_scopes_json,
       updated_at = datetime('now')`,
  ).run(
    args.userId,
    args.googleSub,
    args.googleEmail,
    encryptSecret(args.accessToken),
    args.tokenExpiresAt,
    args.refreshToken ? encryptSecret(args.refreshToken) : '',
    JSON.stringify(args.grantedScopes),
    connectedAt,
  );
}

/**
 * Persist a rotated access token from a refresh. Keeps the refresh token,
 * scopes, and connectedAt untouched (Google reuses the same refresh token).
 */
export function updateRotatedAccessToken(
  userId: string,
  accessToken: string,
  tokenExpiresAt: string,
): void {
  const db = getOrgsDb();
  db.prepare(
    `UPDATE google_connections
     SET access_token_enc = ?, token_expires_at = ?, updated_at = datetime('now')
     WHERE user_id = ?`,
  ).run(encryptSecret(accessToken), tokenExpiresAt, userId);
}

/** Raw connection row (tokens decrypted). Use `getActiveAccessToken` for calls. */
export function getGoogleConnection(userId: string): GoogleConnectionRow | null {
  const db = getOrgsDb();
  const row = db.prepare(`SELECT * FROM google_connections WHERE user_id = ?`).get(userId) as
    | RawGoogleRow
    | undefined;
  return rowToConnection(row);
}

/** UI-safe status (no tokens exposed). */
export function getGoogleConnectionStatus(userId: string): GoogleConnectionStatus {
  const conn = getGoogleConnection(userId);
  if (!conn) {
    return {
      connected: false,
      email: null,
      grantedScopes: [],
      connectedAt: null,
      tokenExpiresAt: null,
    };
  }
  return {
    connected: true,
    email: conn.googleEmail,
    grantedScopes: conn.grantedScopes,
    connectedAt: conn.connectedAt,
    tokenExpiresAt: conn.tokenExpiresAt,
  };
}

/** Remove a user's Google connection. Idempotent. */
export function deleteGoogleConnection(userId: string): void {
  const db = getOrgsDb();
  db.prepare(`DELETE FROM google_connections WHERE user_id = ?`).run(userId);
}

/**
 * Return a currently-valid Google access token for the user, refreshing
 * transparently if it's within the safety window. Returns null when:
 *   - the user has no connection
 *   - `credentials` are missing (no OAuth app configured server-side)
 *   - there is no refresh token to rotate with
 *   - the refresh fails (transient — connection kept, retry later)
 *
 * On `invalid_grant` (revoked) the row is DELETED and null is returned — the
 * connection is dead and the user must re-link from Account settings.
 */
export async function getActiveAccessToken(
  userId: string,
  credentials: GoogleOAuthCredentials | null,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<string | null> {
  const conn = getGoogleConnection(userId);
  if (!conn) return null;
  const now = opts.now ?? Date.now();

  // Still comfortably valid — return the stored token without a network call.
  if (conn.tokenExpiresAt) {
    const expiryMs = Date.parse(conn.tokenExpiresAt);
    if (Number.isFinite(expiryMs) && expiryMs - now > REFRESH_SAFETY_WINDOW_MS) {
      return conn.accessToken;
    }
  }

  // Expired or in the safety window — refresh.
  if (!credentials) return null;
  if (!conn.refreshToken) return null;

  try {
    const rotated = await refreshGoogleAccessToken({
      credentials,
      refreshToken: conn.refreshToken,
      fetchImpl: opts.fetchImpl,
    });
    const tokenExpiresAt = isoFromSecondsFromNow(rotated.expires_in, now);
    updateRotatedAccessToken(userId, rotated.access_token, tokenExpiresAt);
    return rotated.access_token;
  } catch (err: unknown) {
    if (err instanceof GoogleInvalidGrantError) {
      // Revoked — drop the dead connection so /status reports "not connected".
      deleteGoogleConnection(userId);
      console.warn(`[google-oauth] Connection revoked for user ${userId}; cleared.`);
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[google-oauth] Refresh failed for user ${userId}: ${msg.split('\n')[0]}`);
    return null;
  }
}
