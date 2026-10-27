/**
 * Per-user Google identity + token persistence.
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
 *   On `invalid_grant` (user un-linked the app / token revoked) that account's
 *   row is DELETED. If it was the default, the oldest remaining account is
 *   promoted; with none left the status endpoint reports "not connected" and
 *   the UI prompts for a re-link.
 *
 * Multiple accounts:
 *   A user can link several Google accounts. Every read takes an optional
 *   `GoogleAccountSelector`; omitting it means the default account. This differs from the GitHub store, which leaves a dead row
 *   so it can report "connected but expired".
 */
import { randomUUID } from 'crypto';
import { getOrgsDb } from './orgs.js';
import { encryptSecret, decryptSecret } from './secret-crypto.js';
import {
  refreshGoogleAccessToken,
  GoogleInvalidGrantError,
  type GoogleOAuthCredentials,
} from './google-oauth.js';
import { wakeReminderCalendarWork } from './reminders-store.js';

export interface GoogleConnectionRow {
  /** Stable id of this linked Google account (one user can hold several). */
  accountId: string;
  userId: string;
  googleSub: string;
  googleEmail: string;
  accessToken: string;
  /** ISO timestamp of access-token expiry. Google access tokens always expire. */
  tokenExpiresAt: string | null;
  /** Long-lived refresh token (reusable; Google does not rotate it on refresh). */
  refreshToken: string | null;
  grantedScopes: string[];
  /** The account callers get when they do not name one. */
  isDefault: boolean;
  connectedAt: string; // ISO
}

export interface GoogleConnectionStatus {
  connected: boolean;
  email: string | null;
  grantedScopes: string[];
  connectedAt: string | null;
  tokenExpiresAt: string | null;
}

/**
 * Picks one of a user's linked Google accounts. Omitted (or empty) resolves to
 * the default account. A selector that names no linked account resolves to
 * nothing; it never falls back to the default, so a caller asking for a
 * specific mailbox can't silently act on another one.
 */
export interface GoogleAccountSelector {
  accountId?: string | null;
  /** Google account email, matched case-insensitively. */
  email?: string | null;
}

interface RawGoogleRow {
  id: string;
  user_id: string;
  google_sub: string;
  google_email: string;
  access_token_enc: string;
  token_expires_at: string | null;
  refresh_token_enc: string;
  granted_scopes_json: string;
  is_default: number;
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
    accountId: row.id,
    userId: row.user_id,
    googleSub: row.google_sub,
    googleEmail: row.google_email,
    accessToken: row.access_token_enc ? decryptSecret(row.access_token_enc) : '',
    tokenExpiresAt: row.token_expires_at,
    refreshToken: row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : null,
    grantedScopes: parseScopes(row.granted_scopes_json),
    isDefault: row.is_default === 1,
    connectedAt: row.connected_at,
  };
}

function findRawConnection(
  userId: string,
  selector: GoogleAccountSelector | undefined,
): RawGoogleRow | undefined {
  const db = getOrgsDb();
  if (selector?.accountId) {
    return db
      .prepare(`SELECT * FROM google_connections WHERE user_id = ? AND id = ?`)
      .get(userId, selector.accountId) as RawGoogleRow | undefined;
  }
  if (selector?.email) {
    return db
      .prepare(
        `SELECT * FROM google_connections
         WHERE user_id = ? AND lower(google_email) = lower(?)
         ORDER BY is_default DESC, connected_at ASC, rowid ASC LIMIT 1`,
      )
      .get(userId, selector.email) as RawGoogleRow | undefined;
  }
  return db
    .prepare(`SELECT * FROM google_connections WHERE user_id = ? AND is_default = 1`)
    .get(userId) as RawGoogleRow | undefined;
}

/**
 * Give the user a default again when they have accounts but none is marked
 * (the default was just removed). The oldest remaining account wins.
 */
function promoteDefaultIfMissing(userId: string): void {
  const db = getOrgsDb();
  const hasDefault = db
    .prepare(`SELECT 1 FROM google_connections WHERE user_id = ? AND is_default = 1`)
    .get(userId);
  if (hasDefault) return;
  db.prepare(
    `UPDATE google_connections SET is_default = 1, updated_at = datetime('now')
     WHERE id = (
       SELECT id FROM google_connections WHERE user_id = ?
       ORDER BY connected_at ASC, rowid ASC LIMIT 1
     )`,
  ).run(userId);
}

/**
 * Persist a fresh or re-consented connection and return its account id.
 * Tokens are encrypted before write. Re-consenting the same Google account
 * (same `googleSub`) updates its row and preserves `connected_at`; a different
 * Google account is added alongside the existing ones.
 *
 * The user's first account becomes the default. `makeDefault` moves the
 * default to this account. `exclusive` removes the user's other accounts in
 * the same transaction, for the single-account connect flow.
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
  makeDefault?: boolean;
  exclusive?: boolean;
}): string {
  const db = getOrgsDb();
  const connectedAt = args.connectedAt || new Date().toISOString();
  const accessTokenEnc = encryptSecret(args.accessToken);
  const refreshTokenEnc = args.refreshToken ? encryptSecret(args.refreshToken) : '';
  const scopesJson = JSON.stringify(args.grantedScopes);

  const accountId = db.transaction((): string => {
    if (args.exclusive) {
      db.prepare(`DELETE FROM google_connections WHERE user_id = ? AND google_sub != ?`).run(
        args.userId,
        args.googleSub,
      );
    }
    if (args.makeDefault) {
      db.prepare(
        `UPDATE google_connections SET is_default = 0
         WHERE user_id = ? AND google_sub != ? AND is_default = 1`,
      ).run(args.userId, args.googleSub);
    }
    const existing = db
      .prepare(`SELECT id FROM google_connections WHERE user_id = ? AND google_sub = ?`)
      .get(args.userId, args.googleSub) as { id: string } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE google_connections SET
           google_email = ?, access_token_enc = ?, token_expires_at = ?,
           refresh_token_enc = ?, granted_scopes_json = ?,
           is_default = CASE WHEN ? THEN 1 ELSE is_default END,
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        args.googleEmail,
        accessTokenEnc,
        args.tokenExpiresAt,
        refreshTokenEnc,
        scopesJson,
        args.makeDefault ? 1 : 0,
        existing.id,
      );
      promoteDefaultIfMissing(args.userId);
      return existing.id;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO google_connections
         (id, user_id, google_sub, google_email, access_token_enc, token_expires_at,
          refresh_token_enc, granted_scopes_json, is_default, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))`,
    ).run(
      id,
      args.userId,
      args.googleSub,
      args.googleEmail,
      accessTokenEnc,
      args.tokenExpiresAt,
      refreshTokenEnc,
      scopesJson,
      connectedAt,
    );
    if (args.makeDefault) {
      db.prepare(`UPDATE google_connections SET is_default = 1 WHERE id = ?`).run(id);
    } else {
      promoteDefaultIfMissing(args.userId);
    }
    return id;
  })();

  // Calendar work for reminders that failed while Google was unreachable or
  // disconnected becomes due again right away.
  try {
    wakeReminderCalendarWork(args.userId);
  } catch (err) {
    console.warn('[google-connections] reminder calendar wake failed:', (err as Error).message);
  }
  return accountId;
}

/**
 * Persist a rotated access token from a refresh. Keeps the refresh token,
 * scopes, and connectedAt untouched (Google reuses the same refresh token).
 * Targets the selected account (default when omitted).
 */
export function updateRotatedAccessToken(
  userId: string,
  accessToken: string,
  tokenExpiresAt: string,
  selector?: GoogleAccountSelector,
): void {
  const row = findRawConnection(userId, selector);
  if (!row) return;
  getOrgsDb()
    .prepare(
      `UPDATE google_connections
       SET access_token_enc = ?, token_expires_at = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(encryptSecret(accessToken), tokenExpiresAt, row.id);
}

/**
 * Raw connection row (tokens decrypted) for the selected account, default when
 * omitted. Use `getActiveAccessToken` for calls.
 */
export function getGoogleConnection(
  userId: string,
  selector?: GoogleAccountSelector,
): GoogleConnectionRow | null {
  return rowToConnection(findRawConnection(userId, selector));
}

/** Every Google account the user has linked, default first, then oldest first. */
export function listGoogleConnections(userId: string): GoogleConnectionRow[] {
  const rows = getOrgsDb()
    .prepare(
      `SELECT * FROM google_connections WHERE user_id = ?
       ORDER BY is_default DESC, connected_at ASC, rowid ASC`,
    )
    .all(userId) as RawGoogleRow[];
  return rows.map((r) => rowToConnection(r)!);
}

/** Make the given account the user's default. Returns false if it isn't theirs. */
export function setDefaultGoogleConnection(userId: string, accountId: string): boolean {
  const db = getOrgsDb();
  return db.transaction((): boolean => {
    const target = db
      .prepare(`SELECT id FROM google_connections WHERE user_id = ? AND id = ?`)
      .get(userId, accountId);
    if (!target) return false;
    db.prepare(
      `UPDATE google_connections SET is_default = 0 WHERE user_id = ? AND is_default = 1`,
    ).run(userId);
    db.prepare(
      `UPDATE google_connections SET is_default = 1, updated_at = datetime('now') WHERE id = ?`,
    ).run(accountId);
    return true;
  })();
}

/** UI-safe status (no tokens exposed) for the selected account, default when omitted. */
export function getGoogleConnectionStatus(
  userId: string,
  selector?: GoogleAccountSelector,
): GoogleConnectionStatus {
  const conn = getGoogleConnection(userId, selector);
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

/**
 * Remove one of the user's Google accounts (default when the selector is
 * omitted). If it was the default, the oldest remaining account is promoted.
 * Idempotent.
 */
export function deleteGoogleConnection(userId: string, selector?: GoogleAccountSelector): void {
  const db = getOrgsDb();
  db.transaction(() => {
    const row = findRawConnection(userId, selector);
    if (!row) return;
    db.prepare(`DELETE FROM google_connections WHERE id = ?`).run(row.id);
    if (row.is_default === 1) promoteDefaultIfMissing(userId);
  })();
}

/**
 * Return a currently-valid Google access token for the user, refreshing
 * transparently if it's within the safety window. Returns null when:
 *   - the user has no connection
 *   - `credentials` are missing (no OAuth app configured server-side)
 *   - there is no refresh token to rotate with
 *   - the refresh fails (transient — connection kept, retry later)
 *
 * On `invalid_grant` (revoked) that account's row is DELETED and null is
 * returned; a remaining account is promoted to default if needed.
 *
 * `opts.account` picks the account; omitted means the default.
 */
export async function getActiveAccessToken(
  userId: string,
  credentials: GoogleOAuthCredentials | null,
  opts: { fetchImpl?: typeof fetch; now?: number; account?: GoogleAccountSelector } = {},
): Promise<string | null> {
  const conn = getGoogleConnection(userId, opts.account);
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
    updateRotatedAccessToken(userId, rotated.access_token, tokenExpiresAt, {
      accountId: conn.accountId,
    });
    return rotated.access_token;
  } catch (err: unknown) {
    if (err instanceof GoogleInvalidGrantError) {
      // Revoked — drop only this account. If it was the default, the oldest
      // remaining account takes over; with none left /status reports
      // "not connected".
      deleteGoogleConnection(userId, { accountId: conn.accountId });
      console.warn(
        `[google-oauth] Google account ${conn.accountId} revoked for user ${userId}; cleared.`,
      );
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[google-oauth] Refresh failed for user ${userId}: ${msg.split('\n')[0]}`);
    return null;
  }
}
