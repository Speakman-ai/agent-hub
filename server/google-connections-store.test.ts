import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('./orgs.js');
const { createUser, deleteUser } = await import('./users-store.js');
const { __resetSecretCryptoForTests } = await import('./secret-crypto.js');
const {
  upsertGoogleConnection,
  getGoogleConnection,
  getGoogleConnectionStatus,
  deleteGoogleConnection,
  updateRotatedAccessToken,
  getActiveAccessToken,
  listGoogleConnections,
  setDefaultGoogleConnection,
} = await import('./google-connections-store.js');
const { createReminder, beginCalendarInsert, getReminder } = await import('./reminders-store.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'google-conn-store-test-'));
  mkdirSync(TMP_DIR, { recursive: true });
  __resetSecretCryptoForTests(); // key file lives under the new TMP_DIR
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.events'];

describe('google-connections-store — CRUD', () => {
  beforeEach(() => {
    freshDb();
  });

  it('returns null for a user with no link', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    expect(getGoogleConnection(user.id)).toBeNull();
    expect(getGoogleConnectionStatus(user.id)).toEqual({
      connected: false,
      email: null,
      grantedScopes: [],
      connectedAt: null,
      tokenExpiresAt: null,
    });
  });

  it('upsert persists all fields and roundtrips via getGoogleConnection', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const now = new Date().toISOString();
    upsertGoogleConnection({
      userId: user.id,
      googleSub: '11223344',
      googleEmail: 'alice@example.com',
      accessToken: 'ya29.access',
      tokenExpiresAt: now,
      refreshToken: '1//refresh',
      grantedScopes: SCOPES,
      connectedAt: now,
    });
    const conn = getGoogleConnection(user.id);
    expect(conn).not.toBeNull();
    expect(conn!.googleSub).toBe('11223344');
    expect(conn!.googleEmail).toBe('alice@example.com');
    expect(conn!.accessToken).toBe('ya29.access');
    expect(conn!.refreshToken).toBe('1//refresh');
    expect(conn!.grantedScopes).toEqual(SCOPES);
  });

  // Encrypt round-trip
  it('encrypts tokens at rest — raw columns hold ciphertext, not plaintext', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'PLAINTEXT-ACCESS',
      tokenExpiresAt: new Date().toISOString(),
      refreshToken: 'PLAINTEXT-REFRESH',
      grantedScopes: SCOPES,
    });
    const raw = getOrgsDb()
      .prepare(
        'SELECT access_token_enc, refresh_token_enc FROM google_connections WHERE user_id = ?',
      )
      .get(user.id) as { access_token_enc: string; refresh_token_enc: string };
    // Stored blobs must be the iv:tag:ciphertext shape, never the plaintext.
    expect(raw.access_token_enc).not.toContain('PLAINTEXT-ACCESS');
    expect(raw.refresh_token_enc).not.toContain('PLAINTEXT-REFRESH');
    expect(raw.access_token_enc.split(':')).toHaveLength(3);
    expect(raw.refresh_token_enc.split(':')).toHaveLength(3);
    // ...but the accessor decrypts back to the originals.
    const conn = getGoogleConnection(user.id)!;
    expect(conn.accessToken).toBe('PLAINTEXT-ACCESS');
    expect(conn.refreshToken).toBe('PLAINTEXT-REFRESH');
  });

  it('status endpoint never leaks tokens', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'secret-access',
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
      refreshToken: 'secret-refresh',
      grantedScopes: SCOPES,
    });
    const status = getGoogleConnectionStatus(user.id);
    expect(status.connected).toBe(true);
    expect(status.email).toBe('alice@example.com');
    expect(status.grantedScopes).toEqual(SCOPES);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('secret-access');
    expect(serialized).not.toContain('secret-refresh');
  });

  it('delete removes the connection and is idempotent', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'a',
      tokenExpiresAt: new Date().toISOString(),
      refreshToken: 'r',
      grantedScopes: SCOPES,
    });
    expect(getGoogleConnection(user.id)).not.toBeNull();
    deleteGoogleConnection(user.id);
    expect(getGoogleConnection(user.id)).toBeNull();
    deleteGoogleConnection(user.id);
    expect(getGoogleConnection(user.id)).toBeNull();
  });

  it('preserves original connectedAt on re-consent', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const original = '2026-01-01T00:00:00.000Z';
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'a1',
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
      refreshToken: 'r1',
      grantedScopes: ['openid'],
      connectedAt: original,
    });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'a2',
      tokenExpiresAt: '2030-02-01T00:00:00.000Z',
      refreshToken: 'r2',
      grantedScopes: SCOPES,
    });
    const conn = getGoogleConnection(user.id)!;
    expect(conn.connectedAt).toBe(original);
    expect(conn.accessToken).toBe('a2');
    expect(conn.grantedScopes).toEqual(SCOPES);
  });

  it('updateRotatedAccessToken rewrites only the access token + expiry', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'a1',
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
      refreshToken: 'r1',
      grantedScopes: SCOPES,
    });
    updateRotatedAccessToken(user.id, 'a2', '2030-03-01T00:00:00.000Z');
    const conn = getGoogleConnection(user.id)!;
    expect(conn.accessToken).toBe('a2');
    expect(conn.tokenExpiresAt).toBe('2030-03-01T00:00:00.000Z');
    // Refresh token + scopes untouched.
    expect(conn.refreshToken).toBe('r1');
    expect(conn.grantedScopes).toEqual(SCOPES);
  });
});

describe('getActiveAccessToken — transparent refresh', () => {
  beforeEach(() => {
    freshDb();
  });

  it('returns null for a user with no connection', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const token = await getActiveAccessToken(user.id, { clientId: 'a', clientSecret: 'b' });
    expect(token).toBeNull();
  });

  it('returns the stored token when still comfortably valid', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'still-valid',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // +1h
      refreshToken: 'r',
      grantedScopes: SCOPES,
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const token = await getActiveAccessToken(
      user.id,
      { clientId: 'a', clientSecret: 'b' },
      { fetchImpl },
    );
    expect(token).toBe('still-valid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Refresh-window
  it('refreshes inside the safety window and persists the rotated access token', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'expiring-soon',
      tokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(), // +1m (< 5m window)
      refreshToken: 'r-keep',
      grantedScopes: SCOPES,
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'rotated-access',
        expires_in: 3600,
        scope: SCOPES.join(' '),
        token_type: 'Bearer',
      }),
      text: async () => '',
    })) as unknown as typeof fetch;
    const token = await getActiveAccessToken(
      user.id,
      { clientId: 'a', clientSecret: 'b' },
      { fetchImpl },
    );
    expect(token).toBe('rotated-access');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const stored = getGoogleConnection(user.id)!;
    expect(stored.accessToken).toBe('rotated-access');
    // Google does not rotate the refresh token — it must survive untouched.
    expect(stored.refreshToken).toBe('r-keep');
    // New expiry is ~1h out, well past the 5m window.
    expect(Date.parse(stored.tokenExpiresAt!) - Date.now()).toBeGreaterThan(REFRESH_SAFETY_NEAR);
  });

  it('refreshes an already-expired token', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'expired',
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshToken: 'r',
      grantedScopes: SCOPES,
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh', expires_in: 3600, token_type: 'Bearer' }),
      text: async () => '',
    })) as unknown as typeof fetch;
    const token = await getActiveAccessToken(
      user.id,
      { clientId: 'a', clientSecret: 'b' },
      { fetchImpl },
    );
    expect(token).toBe('fresh');
  });

  it('returns null without a network call when no OAuth credentials are configured', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'expiring',
      tokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      refreshToken: 'r',
      grantedScopes: SCOPES,
    });
    const token = await getActiveAccessToken(user.id, null);
    expect(token).toBeNull();
  });

  it('returns null (connection kept) on a transient refresh failure', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'expiring',
      tokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      refreshToken: 'r',
      grantedScopes: SCOPES,
    });
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' }),
      text: async () => 'unavailable',
    })) as unknown as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await getActiveAccessToken(
      user.id,
      { clientId: 'a', clientSecret: 'b' },
      { fetchImpl },
    );
    expect(token).toBeNull();
    // Transient failure must NOT drop the connection.
    expect(getGoogleConnection(user.id)).not.toBeNull();
    warn.mockRestore();
  });

  // Revoke clears the row
  it('clears the row on invalid_grant (revoked token)', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 's',
      googleEmail: 'alice@example.com',
      accessToken: 'expiring',
      tokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      refreshToken: 'revoked',
      grantedScopes: SCOPES,
    });
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
      }),
      text: async () => '',
    })) as unknown as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await getActiveAccessToken(
      user.id,
      { clientId: 'a', clientSecret: 'b' },
      { fetchImpl },
    );
    expect(token).toBeNull();
    // Dead connection must be cleared so the UI prompts a re-link.
    expect(getGoogleConnection(user.id)).toBeNull();
    expect(getGoogleConnectionStatus(user.id).connected).toBe(false);
    warn.mockRestore();
  });
});

// A token refreshed with expires_in=3600 must land well beyond the 5-minute
// safety window. 4 minutes is a comfortable lower bound for the assertion.
const REFRESH_SAFETY_NEAR = 4 * 60 * 1000;

describe('google-connections-store — reminder calendar recovery', () => {
  beforeEach(() => {
    freshDb();
  });

  it('makes backed-off reminder calendar work due again when Google is reconnected', () => {
    const userId = createUser({ username: 'reconnect', passwordHash: 'x' }).id;
    const r = createReminder({ userId, title: 't', remindAt: '2030-01-01T00:00:00.000Z' });
    const farFuture = new Date('2030-01-01T00:00:00.000Z');
    beginCalendarInsert(userId, r.id, 'primary', 'ahrabc123', farFuture);
    const before = Date.now();
    upsertGoogleConnection({
      userId,
      googleSub: 'sub',
      googleEmail: 'a@example.com',
      accessToken: 'tok',
      tokenExpiresAt: null,
      refreshToken: 'refresh',
      grantedScopes: SCOPES,
    });
    const row = getOrgsDb()
      .prepare('SELECT calendar_retry_at FROM reminders WHERE id = ?')
      .get(r.id) as { calendar_retry_at: string };
    expect(Date.parse(row.calendar_retry_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(row.calendar_retry_at)).toBeLessThan(farFuture.getTime());
    expect(getReminder(userId, r.id)?.calendar.status).toBe('pending');
  });
});

function linkAccount(
  userId: string,
  sub: string,
  email: string,
  extra: { connectedAt?: string; makeDefault?: boolean; refreshToken?: string } = {},
): string {
  return upsertGoogleConnection({
    userId,
    googleSub: sub,
    googleEmail: email,
    accessToken: `access-${sub}`,
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refreshToken: extra.refreshToken ?? `refresh-${sub}`,
    grantedScopes: SCOPES,
    connectedAt: extra.connectedAt,
    makeDefault: extra.makeDefault,
  });
}

describe('google-connections-store — multi-account', () => {
  beforeEach(() => {
    freshDb();
  });

  it('migrates a single-account table: each row becomes the default, tokens intact', () => {
    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    linkAccount(alice.id, 'sub-a', 'alice@example.com', {
      connectedAt: '2026-01-01T00:00:00.000Z',
    });
    linkAccount(bob.id, 'sub-b', 'bob@example.com');
    const db = getOrgsDb();
    const before = db
      .prepare(
        `SELECT user_id, access_token_enc, refresh_token_enc, connected_at FROM google_connections`,
      )
      .all();
    // Rebuild the pre-migration shape (user_id as PK, no id / is_default).
    db.exec(`
      CREATE TABLE gc_old (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        google_sub TEXT NOT NULL, google_email TEXT NOT NULL,
        access_token_enc TEXT NOT NULL DEFAULT '', token_expires_at TEXT,
        refresh_token_enc TEXT NOT NULL DEFAULT '', granted_scopes_json TEXT NOT NULL DEFAULT '[]',
        connected_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO gc_old SELECT user_id, google_sub, google_email, access_token_enc,
        token_expires_at, refresh_token_enc, granted_scopes_json, connected_at, updated_at
        FROM google_connections;
      DROP TABLE google_connections;
      ALTER TABLE gc_old RENAME TO google_connections;
    `);

    initOrgsDb();

    const cols = (
      getOrgsDb().prepare(`PRAGMA table_info(google_connections)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('id');
    expect(cols).toContain('is_default');
    const after = getOrgsDb()
      .prepare(
        `SELECT user_id, access_token_enc, refresh_token_enc, connected_at FROM google_connections`,
      )
      .all();
    expect(after).toEqual(expect.arrayContaining(before as object[]));
    const conn = getGoogleConnection(alice.id);
    expect(conn).toMatchObject({
      googleSub: 'sub-a',
      accessToken: 'access-sub-a',
      refreshToken: 'refresh-sub-a',
      isDefault: true,
      connectedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(conn!.accountId).toMatch(/^[0-9a-f]{32}$/);
    expect(getGoogleConnection(bob.id)!.isDefault).toBe(true);

    // Running init again is a no-op on the migrated table.
    initOrgsDb();
    expect(getGoogleConnection(alice.id)!.accountId).toBe(conn!.accountId);
  });

  it('first account is the default; later accounts are added, not replaced', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const work = linkAccount(user.id, 'sub-work', 'alice@work.com');
    const home = linkAccount(user.id, 'sub-home', 'Alice@Home.com');
    expect(work).not.toBe(home);
    expect(listGoogleConnections(user.id).map((c) => c.accountId)).toEqual([work, home]);
    expect(getGoogleConnection(user.id)!.accountId).toBe(work);
    expect(getGoogleConnectionStatus(user.id).email).toBe('alice@work.com');
  });

  it('resolves a selector by accountId or case-insensitive email, never falling back', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const other = createUser({ username: 'bob', passwordHash: 'x' });
    linkAccount(user.id, 'sub-work', 'alice@work.com');
    const home = linkAccount(user.id, 'sub-home', 'Alice@Home.com');
    const bobs = linkAccount(other.id, 'sub-bob', 'bob@example.com');
    expect(getGoogleConnection(user.id, { accountId: home })!.googleSub).toBe('sub-home');
    expect(getGoogleConnection(user.id, { email: 'alice@home.COM' })!.accountId).toBe(home);
    expect(getGoogleConnection(user.id, { email: 'nobody@example.com' })).toBeNull();
    // Another user's account id is not reachable.
    expect(getGoogleConnection(user.id, { accountId: bobs })).toBeNull();
    expect(getGoogleConnectionStatus(user.id, { accountId: 'missing' }).connected).toBe(false);
    // Empty selector means default.
    expect(getGoogleConnection(user.id, {})!.googleSub).toBe('sub-work');
  });

  it('re-consenting the same Google account updates its row and keeps the id', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const id = linkAccount(user.id, 'sub-work', 'alice@work.com');
    linkAccount(user.id, 'sub-home', 'alice@home.com');
    const again = linkAccount(user.id, 'sub-home', 'alice@home.com', { refreshToken: 'rotated' });
    expect(listGoogleConnections(user.id)).toHaveLength(2);
    expect(getGoogleConnection(user.id, { accountId: again })!.refreshToken).toBe('rotated');
    expect(getGoogleConnection(user.id)!.accountId).toBe(id);
  });

  it('makeDefault and setDefaultGoogleConnection move the default', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const work = linkAccount(user.id, 'sub-work', 'alice@work.com');
    const home = linkAccount(user.id, 'sub-home', 'alice@home.com', { makeDefault: true });
    expect(getGoogleConnection(user.id)!.accountId).toBe(home);
    expect(setDefaultGoogleConnection(user.id, work)).toBe(true);
    expect(getGoogleConnection(user.id)!.accountId).toBe(work);
    expect(listGoogleConnections(user.id).filter((c) => c.isDefault)).toHaveLength(1);
    expect(setDefaultGoogleConnection(user.id, 'missing')).toBe(false);
    expect(getGoogleConnection(user.id)!.accountId).toBe(work);
  });

  it('exclusive upsert replaces the user’s other accounts', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    linkAccount(user.id, 'sub-work', 'alice@work.com');
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 'sub-home',
      googleEmail: 'alice@home.com',
      accessToken: 'a',
      tokenExpiresAt: null,
      refreshToken: 'r',
      grantedScopes: SCOPES,
      exclusive: true,
    });
    const all = listGoogleConnections(user.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ googleSub: 'sub-home', isDefault: true });
  });

  it('deleting the default promotes the oldest remaining account', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    linkAccount(user.id, 'sub-a', 'a@example.com', { connectedAt: '2026-01-01T00:00:00.000Z' });
    const newest = linkAccount(user.id, 'sub-c', 'c@example.com', {
      connectedAt: '2026-03-01T00:00:00.000Z',
    });
    const oldest = linkAccount(user.id, 'sub-b', 'b@example.com', {
      connectedAt: '2026-02-01T00:00:00.000Z',
    });
    deleteGoogleConnection(user.id);
    expect(getGoogleConnection(user.id)!.accountId).toBe(oldest);
    // Deleting a non-default leaves the default alone.
    deleteGoogleConnection(user.id, { accountId: newest });
    expect(getGoogleConnection(user.id)!.accountId).toBe(oldest);
    expect(listGoogleConnections(user.id)).toHaveLength(1);
  });

  it('invalid_grant deletes only the revoked account and promotes the next default', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const revoked = upsertGoogleConnection({
      userId: user.id,
      googleSub: 'sub-revoked',
      googleEmail: 'old@example.com',
      accessToken: 'expiring',
      tokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      refreshToken: 'revoked',
      grantedScopes: SCOPES,
      connectedAt: '2026-01-01T00:00:00.000Z',
    });
    const keptOld = linkAccount(user.id, 'sub-2', 'two@example.com', {
      connectedAt: '2026-02-01T00:00:00.000Z',
    });
    linkAccount(user.id, 'sub-3', 'three@example.com', { connectedAt: '2026-03-01T00:00:00.000Z' });
    expect(getGoogleConnection(user.id)!.accountId).toBe(revoked);

    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
      text: async () => '',
    })) as unknown as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await getActiveAccessToken(
      user.id,
      { clientId: 'a', clientSecret: 'b' },
      { fetchImpl },
    );
    warn.mockRestore();

    expect(token).toBeNull();
    const remaining = listGoogleConnections(user.id);
    expect(remaining.map((c) => c.googleSub).sort()).toEqual(['sub-2', 'sub-3']);
    expect(getGoogleConnection(user.id)!.accountId).toBe(keptOld);
  });

  it('getActiveAccessToken refreshes and writes back to the selected account only', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    linkAccount(user.id, 'sub-work', 'alice@work.com');
    const home = upsertGoogleConnection({
      userId: user.id,
      googleSub: 'sub-home',
      googleEmail: 'alice@home.com',
      accessToken: 'stale',
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshToken: 'refresh-home',
      grantedScopes: SCOPES,
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh-home', expires_in: 3600 }),
      text: async () => '',
    })) as unknown as typeof fetch;
    const token = await getActiveAccessToken(
      user.id,
      { clientId: 'a', clientSecret: 'b' },
      { fetchImpl, account: { email: 'alice@home.com' } },
    );
    expect(token).toBe('fresh-home');
    expect(getGoogleConnection(user.id, { accountId: home })!.accessToken).toBe('fresh-home');
    expect(getGoogleConnection(user.id)!.accessToken).toBe('access-sub-work');
  });

  it('deleting the user cascades all their Google accounts', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const other = createUser({ username: 'bob', passwordHash: 'x' });
    linkAccount(user.id, 'sub-a', 'a@example.com');
    linkAccount(user.id, 'sub-b', 'b@example.com');
    linkAccount(other.id, 'sub-bob', 'bob@example.com');
    deleteUser(user.id);
    const count = getOrgsDb()
      .prepare(`SELECT COUNT(*) AS n FROM google_connections WHERE user_id = ?`)
      .get(user.id) as { n: number };
    expect(count.n).toBe(0);
    expect(listGoogleConnections(other.id)).toHaveLength(1);
  });
});
