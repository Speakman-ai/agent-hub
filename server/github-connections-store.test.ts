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

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const {
  upsertGithubConnection,
  getGithubConnection,
  getGithubConnectionStatus,
  deleteGithubConnection,
  updateRotatedTokens,
  getActiveAccessToken,
} = await import('./github-connections-store.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'gh-conn-store-test-'));
  mkdirSync(TMP_DIR, { recursive: true });
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

describe('github-connections-store — CRUD', () => {
  beforeEach(() => {
    freshDb();
  });

  it('getGithubConnection returns null for user with no link', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    expect(getGithubConnection(user.id)).toBeNull();
    expect(getGithubConnectionStatus(user.id)).toEqual({
      connected: false,
      login: null,
      connectedAt: null,
      tokenExpiresAt: null,
    });
  });

  it('upsertGithubConnection persists all fields and roundtrips via getGithubConnection', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const now = new Date().toISOString();
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'ghu_123',
      tokenExpiresAt: now,
      refreshToken: 'ghr_abc',
      refreshExpiresAt: now,
      connectedAt: now,
    });
    const conn = getGithubConnection(user.id);
    expect(conn).not.toBeNull();
    expect(conn!.login).toBe('speakmanra');
    expect(conn!.accessToken).toBe('ghu_123');
    expect(conn!.refreshToken).toBe('ghr_abc');
  });

  it('status endpoint never leaks tokens', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'secret-access',
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
      refreshToken: 'secret-refresh',
      refreshExpiresAt: '2030-06-01T00:00:00.000Z',
    });
    const status = getGithubConnectionStatus(user.id);
    expect(status.connected).toBe(true);
    expect(status.login).toBe('speakmanra');
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('secret-access');
    expect(serialized).not.toContain('secret-refresh');
  });

  it('deleteGithubConnection nulls out all github_* columns', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'a',
      tokenExpiresAt: new Date().toISOString(),
      refreshToken: 'r',
      refreshExpiresAt: new Date().toISOString(),
    });
    expect(getGithubConnection(user.id)).not.toBeNull();
    deleteGithubConnection(user.id);
    expect(getGithubConnection(user.id)).toBeNull();
    // Idempotent
    deleteGithubConnection(user.id);
    expect(getGithubConnection(user.id)).toBeNull();
  });

  it('upsertGithubConnection preserves original connectedAt on reconnect', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const originalConnected = '2026-01-01T00:00:00.000Z';
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'a1',
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
      refreshToken: 'r1',
      refreshExpiresAt: '2030-06-01T00:00:00.000Z',
      connectedAt: originalConnected,
    });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'a2',
      tokenExpiresAt: '2030-02-01T00:00:00.000Z',
      refreshToken: 'r2',
      refreshExpiresAt: '2030-07-01T00:00:00.000Z',
    });
    expect(getGithubConnection(user.id)!.connectedAt).toBe(originalConnected);
    expect(getGithubConnection(user.id)!.accessToken).toBe('a2');
  });
});

describe('getActiveAccessToken — transparent refresh', () => {
  beforeEach(() => {
    freshDb();
  });

  it('returns the stored token when still comfortably valid', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'still-valid',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // +1h
      refreshToken: 'r',
      refreshExpiresAt: new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString(),
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

  it('refreshes transparently when inside the safety window and persists rotated tokens', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'expiring-soon',
      tokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(), // +1m (< 5m window)
      refreshToken: 'r-old',
      refreshExpiresAt: new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString(),
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'rotated-access',
        expires_in: 28800,
        refresh_token: 'r-new',
        refresh_token_expires_in: 15724800,
        token_type: 'bearer',
        scope: '',
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
    // Rotated values persisted
    const stored = getGithubConnection(user.id);
    expect(stored!.accessToken).toBe('rotated-access');
    expect(stored!.refreshToken).toBe('r-new');
  });

  it('returns null when the refresh token itself has expired (dead connection)', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'old-access',
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(), // expired
      refreshToken: 'dead',
      refreshExpiresAt: new Date(Date.now() - 1000).toISOString(), // also expired
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const token = await getActiveAccessToken(
      user.id,
      { clientId: 'a', clientSecret: 'b' },
      { fetchImpl },
    );
    expect(token).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    // Still leaves the row so /status can report "connected but expired"
    expect(getGithubConnection(user.id)).not.toBeNull();
  });

  it('returns null when no credentials are configured and token is expiring', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'old',
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshToken: 'r',
      refreshExpiresAt: new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString(),
    });
    const token = await getActiveAccessToken(user.id, null);
    expect(token).toBeNull();
  });

  it('returns null and logs when refresh call itself fails', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'old',
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshToken: 'r',
      refreshExpiresAt: new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString(),
    });
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => 'bad',
    })) as unknown as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = await getActiveAccessToken(
      user.id,
      { clientId: 'a', clientSecret: 'b' },
      { fetchImpl },
    );
    expect(token).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns null for a user with no connection', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const token = await getActiveAccessToken(user.id, { clientId: 'a', clientSecret: 'b' });
    expect(token).toBeNull();
  });

  // ── Non-expiring access tokens ──────────────────────────────────
  //
  // Classic OAuth Apps and GitHub Apps without "Expire user
  // authorization tokens" issue access tokens with no expiry and no
  // refresh token. The store must accept null expiry/refresh columns
  // and `getActiveAccessToken` must return the stored token directly
  // without attempting to call the (non-existent) refresh endpoint.

  it('upserts and reads back a connection with null expiry + null refresh', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'gho_no_expiry',
      tokenExpiresAt: null,
      refreshToken: null,
      refreshExpiresAt: null,
    });
    const conn = getGithubConnection(user.id);
    expect(conn).not.toBeNull();
    expect(conn!.accessToken).toBe('gho_no_expiry');
    expect(conn!.tokenExpiresAt).toBeNull();
    expect(conn!.refreshToken).toBeNull();
    expect(conn!.refreshExpiresAt).toBeNull();
  });

  it('getActiveAccessToken returns the token directly when tokenExpiresAt is null', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'never-expires',
      tokenExpiresAt: null,
      refreshToken: null,
      refreshExpiresAt: null,
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const token = await getActiveAccessToken(
      user.id,
      { clientId: 'a', clientSecret: 'b' },
      { fetchImpl },
    );
    expect(token).toBe('never-expires');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('getActiveAccessToken returns null when token is expired and no refresh token exists', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'expired-no-refresh',
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshToken: null,
      refreshExpiresAt: null,
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const token = await getActiveAccessToken(
      user.id,
      { clientId: 'a', clientSecret: 'b' },
      { fetchImpl },
    );
    expect(token).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('updateRotatedTokens rewrites only the token columns', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const originalConnected = '2026-01-01T00:00:00.000Z';
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'a1',
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
      refreshToken: 'r1',
      refreshExpiresAt: '2030-06-01T00:00:00.000Z',
      connectedAt: originalConnected,
    });
    updateRotatedTokens(user.id, {
      access_token: 'a2',
      expires_in: 28800,
      refresh_token: 'r2',
      refresh_token_expires_in: 15724800,
      token_type: 'bearer',
      scope: '',
    });
    const conn = getGithubConnection(user.id)!;
    expect(conn.accessToken).toBe('a2');
    expect(conn.refreshToken).toBe('r2');
    expect(conn.login).toBe('speakmanra');
    expect(conn.connectedAt).toBe(originalConnected);
  });
});
