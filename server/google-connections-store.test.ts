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
const { createUser } = await import('./users-store.js');
const { __resetSecretCryptoForTests } = await import('./secret-crypto.js');
const {
  upsertGoogleConnection,
  getGoogleConnection,
  getGoogleConnectionStatus,
  deleteGoogleConnection,
  updateRotatedAccessToken,
  getActiveAccessToken,
} = await import('./google-connections-store.js');

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

  // ── Encrypt round-trip ──────────────────────────────────────────
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

  // ── Refresh-window ──────────────────────────────────────────────
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

  // ── Revoke clears the row ───────────────────────────────────────
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
