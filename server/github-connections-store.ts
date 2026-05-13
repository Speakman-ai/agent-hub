/**
 * github-connections-store.ts — Per-user GitHub identity persistence.
 *
 * Stores the link between an Agent Hub user (`users.id` in orgs.db) and
 * their GitHub account via user-to-server OAuth. Tokens live in six
 * columns added to the existing `users` table (see migration in
 * `orgs.ts`) so reads stay on a single row with no JOIN.
 *
 * Transparent refresh:
 *   `getActiveAccessToken` checks the stored expiry and, if within the
 *   configurable safety window, calls `refreshUserToken` from
 *   `github-oauth.ts` and writes the rotated tokens back before
 *   returning. Callers in `pr-list.ts`/`pr-actions.ts` get a valid
 *   access token or `null` — they never see the refresh machinery.
 */
import { getOrgsDb } from './orgs.js';
import {
  refreshUserToken,
  type GitHubOAuthCredentials,
  type GitHubRefreshedTokens,
} from './github-oauth.js';

export interface GithubConnectionRow {
  userId: string;
  login: string;
  accessToken: string;
  /**
   * ISO timestamp, or `null` when the access token never expires
   * (classic OAuth Apps and GitHub Apps without "Expire user
   * authorization tokens" enabled).
   */
  tokenExpiresAt: string | null;
  /**
   * The refresh token, or `null` when the OAuth client does not
   * issue refresh tokens. When null, the access token is treated
   * as non-rotating — if it ever stops working, the user must
   * reconnect manually from Settings.
   */
  refreshToken: string | null;
  /** ISO timestamp paired with `refreshToken`; null iff `refreshToken` is null. */
  refreshExpiresAt: string | null;
  connectedAt: string; // ISO
}

export interface GithubConnectionStatus {
  connected: boolean;
  login: string | null;
  connectedAt: string | null;
  tokenExpiresAt: string | null;
}

interface RawUserRow {
  github_login: string | null;
  github_user_token: string | null;
  github_token_expires_at: string | null;
  github_refresh_token: string | null;
  github_refresh_expires_at: string | null;
  github_connected_at: string | null;
}

/**
 * Refresh tokens this close to expiry get pre-emptively rotated on read.
 * 5 minutes matches what `github-app.ts` uses for installation tokens —
 * keeps the two tiers behaviorally consistent.
 */
const REFRESH_SAFETY_WINDOW_MS = 5 * 60 * 1000;

function isoFromSecondsFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function rowToConnection(userId: string, row: RawUserRow | undefined): GithubConnectionRow | null {
  if (!row) return null;
  // Only the identifying triple is required — login, access token, and
  // the connectedAt marker. Refresh/expiry columns may legitimately be
  // null for OAuth clients that don't issue them.
  if (!row.github_login || !row.github_user_token || !row.github_connected_at) {
    return null;
  }
  return {
    userId,
    login: row.github_login,
    accessToken: row.github_user_token,
    tokenExpiresAt: row.github_token_expires_at,
    refreshToken: row.github_refresh_token,
    refreshExpiresAt: row.github_refresh_expires_at,
    connectedAt: row.github_connected_at,
  };
}

/**
 * Persist a fresh or rotated connection. Safe to call multiple times.
 *
 * `tokenExpiresAt`, `refreshToken`, and `refreshExpiresAt` accept null
 * for OAuth clients that don't issue expiring tokens or refresh tokens
 * (classic OAuth Apps and GitHub Apps without "Expire user
 * authorization tokens").
 */
export function upsertGithubConnection(args: {
  userId: string;
  login: string;
  accessToken: string;
  tokenExpiresAt: string | null;
  refreshToken: string | null;
  refreshExpiresAt: string | null;
  connectedAt?: string;
}): void {
  const db = getOrgsDb();
  const connectedAt = args.connectedAt || new Date().toISOString();
  db.prepare(
    `UPDATE users
     SET github_login = ?,
         github_user_token = ?,
         github_token_expires_at = ?,
         github_refresh_token = ?,
         github_refresh_expires_at = ?,
         github_connected_at = COALESCE(github_connected_at, ?)
     WHERE id = ?`,
  ).run(
    args.login,
    args.accessToken,
    args.tokenExpiresAt,
    args.refreshToken,
    args.refreshExpiresAt,
    connectedAt,
    args.userId,
  );
}

/** Persist the rotated tokens from a refresh — keeps connectedAt/login. */
export function updateRotatedTokens(
  userId: string,
  tokens: GitHubRefreshedTokens,
): { tokenExpiresAt: string; refreshExpiresAt: string } {
  const tokenExpiresAt = isoFromSecondsFromNow(tokens.expires_in);
  const refreshExpiresAt = isoFromSecondsFromNow(tokens.refresh_token_expires_in);
  const db = getOrgsDb();
  db.prepare(
    `UPDATE users
     SET github_user_token = ?,
         github_token_expires_at = ?,
         github_refresh_token = ?,
         github_refresh_expires_at = ?
     WHERE id = ?`,
  ).run(tokens.access_token, tokenExpiresAt, tokens.refresh_token, refreshExpiresAt, userId);
  return { tokenExpiresAt, refreshExpiresAt };
}

/** Raw connection row — does NOT refresh. Use `getActiveAccessToken` for calls. */
export function getGithubConnection(userId: string): GithubConnectionRow | null {
  const db = getOrgsDb();
  const row = db
    .prepare(
      `SELECT github_login, github_user_token, github_token_expires_at,
              github_refresh_token, github_refresh_expires_at, github_connected_at
       FROM users WHERE id = ?`,
    )
    .get(userId) as RawUserRow | undefined;
  return rowToConnection(userId, row);
}

/** UI-safe status (no tokens exposed). */
export function getGithubConnectionStatus(userId: string): GithubConnectionStatus {
  const conn = getGithubConnection(userId);
  if (!conn) {
    return { connected: false, login: null, connectedAt: null, tokenExpiresAt: null };
  }
  return {
    connected: true,
    login: conn.login,
    connectedAt: conn.connectedAt,
    tokenExpiresAt: conn.tokenExpiresAt,
  };
}

/** Remove a user's GitHub connection. Idempotent. */
export function deleteGithubConnection(userId: string): void {
  const db = getOrgsDb();
  db.prepare(
    `UPDATE users
     SET github_login = NULL,
         github_user_token = NULL,
         github_token_expires_at = NULL,
         github_refresh_token = NULL,
         github_refresh_expires_at = NULL,
         github_connected_at = NULL
     WHERE id = ?`,
  ).run(userId);
}

/**
 * Return a currently-valid access token for the given user, refreshing
 * transparently if it's within the safety window. Returns null when:
 *   - the user has no connection
 *   - the refresh token itself has expired (connection dead — user must reconnect)
 *   - `credentials` are missing (no OAuth configured server-side)
 *
 * The store does not itself delete a dead connection on expiry — we let
 * the status endpoint report "connected but expired" so the UI can
 * prompt for reconnect rather than silently dropping the link.
 */
export async function getActiveAccessToken(
  userId: string,
  credentials: GitHubOAuthCredentials | null,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<string | null> {
  const conn = getGithubConnection(userId);
  if (!conn) return null;
  const now = opts.now ?? Date.now();

  // Non-expiring access tokens (classic OAuth Apps, GitHub Apps without
  // expiring user tokens). Nothing to refresh — return what we have.
  if (conn.tokenExpiresAt === null) {
    return conn.accessToken;
  }

  const tokenExpiryMs = Date.parse(conn.tokenExpiresAt);
  if (Number.isFinite(tokenExpiryMs) && tokenExpiryMs - now > REFRESH_SAFETY_WINDOW_MS) {
    return conn.accessToken;
  }

  // Token is expired or in the safety window — try to refresh.
  if (!credentials) return null;

  // No refresh token issued by the OAuth client. We can't rotate — the
  // user must reconnect from Settings.
  if (!conn.refreshToken) return null;

  if (conn.refreshExpiresAt) {
    const refreshExpiryMs = Date.parse(conn.refreshExpiresAt);
    if (Number.isFinite(refreshExpiryMs) && refreshExpiryMs <= now) {
      // Refresh token itself is dead — user must reconnect.
      return null;
    }
  }

  try {
    const rotated = await refreshUserToken({
      credentials,
      refreshToken: conn.refreshToken,
      fetchImpl: opts.fetchImpl,
    });
    updateRotatedTokens(userId, rotated);
    return rotated.access_token;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[github-oauth] Refresh failed for user ${userId}: ${msg.split('\n')[0]}`);
    return null;
  }
}
