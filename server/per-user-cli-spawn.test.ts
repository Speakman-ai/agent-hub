import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { setAuthFilePathForTests, reloadAuthRecord } = await import('./auth-store.js');
const { createUser, setUserCursorAuth, setUserGrokAuth } = await import('./users-store.js');
const { ensurePerUserHome } = await import('./per-user-home.js');
const { userHasPerUserCliIdentity, perUserHomeHasGrokCache } =
  await import('./per-user-cli-spawn.js');

let dataDir = '';

function freshSandbox() {
  dataDir = mkdtempSync(path.join(tmpdir(), 'per-user-cli-spawn-'));
  setOrgsDbPathForTests(path.join(dataDir, 'orgs.db'));
  setAuthFilePathForTests(path.join(dataDir, 'auth.json'));
  reloadAuthRecord();
  initOrgsDb();
}

describe('userHasPerUserCliIdentity', () => {
  beforeEach(() => {
    freshSandbox();
  });

  it('returns false when the user has no keys or OAuth caches', () => {
    const user = createUser({ username: 'empty-user', passwordHash: 'x' });
    expect(userHasPerUserCliIdentity(user.id, dataDir)).toBe(false);
  });

  it('returns true when the user has a stored Cursor API key', () => {
    const user = createUser({ username: 'cursor-key-user', passwordHash: 'x' });
    setUserCursorAuth(user.id, { apiKey: 'cur-test' });
    expect(userHasPerUserCliIdentity(user.id, dataDir)).toBe(true);
  });

  it('returns true when per-user HOME has a populated .cursor cache', () => {
    const user = createUser({ username: 'cursor-oauth-user', passwordHash: 'x' });
    const home = ensurePerUserHome(user.id, dataDir);
    mkdirSync(path.join(home, '.cursor'), { recursive: true });
    writeFileSync(path.join(home, '.cursor', 'token.json'), '{"token":"x"}');
    expect(userHasPerUserCliIdentity(user.id, dataDir)).toBe(true);
  });

  it('returns true when the user has a stored Grok API key', () => {
    const user = createUser({ username: 'grok-key-user', passwordHash: 'x' });
    setUserGrokAuth(user.id, { apiKey: 'xai-test' });
    expect(userHasPerUserCliIdentity(user.id, dataDir)).toBe(true);
  });

  it('returns true when per-user HOME has a grok login OAuth token', () => {
    const user = createUser({ username: 'grok-oauth-user', passwordHash: 'x' });
    const home = ensurePerUserHome(user.id, dataDir);
    mkdirSync(path.join(home, '.grok'), { recursive: true });
    writeFileSync(
      path.join(home, '.grok', 'auth.json'),
      JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
    );
    expect(perUserHomeHasGrokCache(user.id, dataDir)).toBe(true);
    expect(userHasPerUserCliIdentity(user.id, dataDir)).toBe(true);
  });

  it('returns true for issuer-keyed OIDC grok auth.json (current CLI format)', () => {
    const user = createUser({ username: 'grok-oidc-user', passwordHash: 'x' });
    const home = ensurePerUserHome(user.id, dataDir);
    mkdirSync(path.join(home, '.grok'), { recursive: true });
    writeFileSync(
      path.join(home, '.grok', 'auth.json'),
      JSON.stringify({
        'https://auth.x.ai::client-id': { key: 'jwt', refresh_token: 'r', auth_mode: 'oidc' },
      }),
    );
    expect(perUserHomeHasGrokCache(user.id, dataDir)).toBe(true);
  });

  it('does not count a grok auth.json that holds only an api key as an OAuth cache', () => {
    const user = createUser({ username: 'grok-apikey-file-user', passwordHash: 'x' });
    const home = ensurePerUserHome(user.id, dataDir);
    mkdirSync(path.join(home, '.grok'), { recursive: true });
    writeFileSync(path.join(home, '.grok', 'auth.json'), JSON.stringify({ api_key: 'xai-onfile' }));
    expect(perUserHomeHasGrokCache(user.id, dataDir)).toBe(false);
  });
});
