import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync } from 'fs';
import path from 'path';

// Point auth + orgs stores at tmp dirs so these tests own the DB.
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
const {
  createUser,
  getUserById,
  getUserByUsername,
  listUsers,
  countUsers,
  deleteUser,
  updateUserPassword,
  migrateAuthRecordIfNeeded,
  getUserClaudeAuth,
  setUserClaudeAuth,
  getUserCursorAuth,
  setUserCursorAuth,
  getUserGeminiAuth,
  setUserGeminiAuth,
  getUserCodexAuth,
  setUserCodexAuth,
  listUserEngineAuthAudit,
} = await import('./users-store.js');
const { __resetSecretCryptoForTests, __setSecretCryptoKeyFilePathForTests } =
  await import('./secret-crypto.js');
const { getMembershipRole, createMembership, listMembershipsForUser } =
  await import('./memberships-store.js');
const { saveAuthRecord, setAuthFilePathForTests, reloadAuthRecord } =
  await import('./auth-store.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'users-store-test-'));
  mkdirSync(TMP_DIR, { recursive: true });
  // Pin the AES-GCM encryption key file to the tmp dir so encrypted
  // credential blobs are valid for this test only (each test gets a
  // fresh random key — no cross-test leakage of ciphertext).
  __setSecretCryptoKeyFilePathForTests(path.join(TMP_DIR, 'pr-env-secret.key'));
  __resetSecretCryptoForTests();
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  reloadAuthRecord();
  initOrgsDb();
}

describe('users-store — basic CRUD', () => {
  beforeEach(() => {
    freshDb();
  });

  it('creates a user and looks it up by id and username', () => {
    const user = createUser({
      username: 'alice',
      passwordHash: 'scrypt$ignored',
    });
    expect(user.id).toBeTruthy();
    expect(user.username).toBe('alice');
    expect(getUserById(user.id)?.username).toBe('alice');
    expect(getUserByUsername('alice')?.id).toBe(user.id);
    expect(getUserByUsername('bob')).toBeNull();
  });

  it('rejects duplicate usernames via the UNIQUE constraint', () => {
    createUser({ username: 'alice', passwordHash: 'h1' });
    expect(() => createUser({ username: 'alice', passwordHash: 'h2' })).toThrow();
  });

  it('listUsers returns all users ordered by created_at', () => {
    createUser({ username: 'a', passwordHash: 'h', createdAt: '2026-04-01T00:00:00Z' });
    createUser({ username: 'b', passwordHash: 'h', createdAt: '2026-04-02T00:00:00Z' });
    const users = listUsers();
    expect(users.map((u) => u.username)).toEqual(['a', 'b']);
    expect(countUsers()).toBe(2);
  });

  it('deleteUser removes the row and cascades to memberships', () => {
    const user = createUser({ username: 'alice', passwordHash: 'h' });
    createMembership(user.id, 'default', 'Admin');
    expect(getMembershipRole(user.id, 'default')).toBe('Admin');
    deleteUser(user.id);
    expect(getUserById(user.id)).toBeNull();
    // ON DELETE CASCADE on memberships should have dropped this too.
    expect(getMembershipRole(user.id, 'default')).toBeNull();
  });

  it('updateUserPassword updates the stored hash', () => {
    const user = createUser({ username: 'alice', passwordHash: 'old' });
    updateUserPassword(user.id, 'new');
    expect(getUserById(user.id)?.password_hash).toBe('new');
  });

  it('supports per-org roles via memberships', () => {
    const user = createUser({ username: 'multi', passwordHash: 'h' });
    // Our default org is seeded; membership in it + its data is fine.
    createMembership(user.id, 'default', 'User');
    expect(getMembershipRole(user.id, 'default')).toBe('User');
    expect(listMembershipsForUser(user.id)).toHaveLength(1);
  });
});

describe('users-store — migration from auth.json', () => {
  beforeEach(() => {
    freshDb();
  });

  it('is a no-op when users already exist', () => {
    createUser({ username: 'already-there', passwordHash: 'h' });
    const result = migrateAuthRecordIfNeeded();
    expect(result).toBeNull();
  });

  it('is a no-op when auth.json is missing', () => {
    expect(migrateAuthRecordIfNeeded()).toBeNull();
    expect(countUsers()).toBe(0);
  });

  it('seeds a user + Owner membership for the default org from auth.json', () => {
    // Simulate a pre-Phase-3 single-user install.
    saveAuthRecord({
      username: 'legacy-owner',
      passwordHash: 'scrypt$existing',
      jwtSecret: 'secret',
      role: 'Owner',
    });
    reloadAuthRecord();

    const result = migrateAuthRecordIfNeeded();
    expect(result).not.toBeNull();
    expect(result?.migratedUserId).toBeTruthy();

    const user = getUserByUsername('legacy-owner');
    expect(user).not.toBeNull();
    expect(user?.password_hash).toBe('scrypt$existing');
    expect(getMembershipRole(user!.id, 'default')).toBe('Owner');
  });

  it('seeds memberships for every existing org, not just default', () => {
    // Seed auth.json and then a second org before running the migration.
    saveAuthRecord({
      username: 'legacy',
      passwordHash: 'h',
      jwtSecret: 's',
      role: 'Owner',
    });
    reloadAuthRecord();

    // Direct INSERT rather than via the org routes (no Express stack here).
    getOrgsDb()
      .prepare(
        "INSERT INTO orgs (id, name, mode, color, remote_url, api_key, position) VALUES ('team-b', 'Team B', 'local', '#000', '', '', 1)",
      )
      .run();

    const result = migrateAuthRecordIfNeeded();
    expect(result).not.toBeNull();
    const user = getUserByUsername('legacy');
    expect(user).not.toBeNull();
    expect(getMembershipRole(user!.id, 'default')).toBe('Owner');
    expect(getMembershipRole(user!.id, 'team-b')).toBe('Owner');
  });
});

describe('users-store — per-user Claude credentials', () => {
  beforeEach(() => freshDb());

  it('returns null Claude auth on a fresh user (columns nullable)', () => {
    const u = createUser({ username: 'alice', passwordHash: 'h' });
    const auth = getUserClaudeAuth(u.id);
    expect(auth).not.toBeNull();
    expect(auth!.anthropicApiKey).toBeNull();
    expect(auth!.claudeCodeOAuthToken).toBeNull();
    expect(auth!.claudeCodeOAuthExpiresAt).toBeNull();
    expect(auth!.updatedAt).toBeNull();
  });

  it('round-trips both credentials and stamps updatedAt', () => {
    const u = createUser({ username: 'bob', passwordHash: 'h' });
    const updated = setUserClaudeAuth(u.id, {
      anthropicApiKey: 'sk-ant-api03-bob',
      claudeCodeOAuthToken: 'sk-ant-oat01-bob',
      claudeCodeOAuthExpiresAt: '2030-01-01T00:00:00Z',
    });
    expect(updated).not.toBeNull();
    expect(updated!.anthropicApiKey).toBe('sk-ant-api03-bob');
    expect(updated!.claudeCodeOAuthToken).toBe('sk-ant-oat01-bob');
    expect(updated!.claudeCodeOAuthExpiresAt).toBe('2030-01-01T00:00:00Z');
    expect(updated!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const reread = getUserClaudeAuth(u.id);
    expect(reread!.anthropicApiKey).toBe('sk-ant-api03-bob');
    expect(reread!.claudeCodeOAuthToken).toBe('sk-ant-oat01-bob');
  });

  it('partial patch leaves other fields untouched', () => {
    const u = createUser({ username: 'carol', passwordHash: 'h' });
    setUserClaudeAuth(u.id, {
      anthropicApiKey: 'sk-ant-api03-carol',
      claudeCodeOAuthToken: 'sk-ant-oat01-carol',
    });
    setUserClaudeAuth(u.id, { anthropicApiKey: 'sk-ant-api03-carol-rotated' });
    const auth = getUserClaudeAuth(u.id);
    expect(auth!.anthropicApiKey).toBe('sk-ant-api03-carol-rotated');
    expect(auth!.claudeCodeOAuthToken).toBe('sk-ant-oat01-carol');
  });

  it('empty string clears the field; whitespace-only also clears', () => {
    const u = createUser({ username: 'dan', passwordHash: 'h' });
    setUserClaudeAuth(u.id, { anthropicApiKey: 'sk-ant-api03-dan' });
    expect(getUserClaudeAuth(u.id)!.anthropicApiKey).toBe('sk-ant-api03-dan');
    setUserClaudeAuth(u.id, { anthropicApiKey: '' });
    expect(getUserClaudeAuth(u.id)!.anthropicApiKey).toBeNull();
    setUserClaudeAuth(u.id, { anthropicApiKey: 'sk-ant-api03-dan2' });
    setUserClaudeAuth(u.id, { anthropicApiKey: '   ' });
    expect(getUserClaudeAuth(u.id)!.anthropicApiKey).toBeNull();
  });

  it('returns null for an unknown user id', () => {
    expect(getUserClaudeAuth('does-not-exist')).toBeNull();
    expect(setUserClaudeAuth('does-not-exist', { anthropicApiKey: 'x' })).toBeNull();
  });
});

// Per-user single-key engine helpers (Cursor / Gemini / Codex) share the
// same shape, so we drive them with one table-style test block.
describe.each([
  {
    engine: 'cursor',
    get: () => getUserCursorAuth,
    set: () => setUserCursorAuth,
    sample: 'curs-XYZ',
  },
  {
    engine: 'gemini',
    get: () => getUserGeminiAuth,
    set: () => setUserGeminiAuth,
    sample: 'gem-XYZ',
  },
  {
    engine: 'codex',
    get: () => getUserCodexAuth,
    set: () => setUserCodexAuth,
    sample: 'sk-codex-XYZ',
  },
])('users-store — per-user $engine credentials', ({ engine, get, set, sample }) => {
  beforeEach(() => freshDb());

  it(`returns null ${engine} auth on a fresh user`, () => {
    const u = createUser({ username: `${engine}-alice`, passwordHash: 'h' });
    const auth = get()(u.id);
    expect(auth).not.toBeNull();
    expect(auth!.apiKey).toBeNull();
    expect(auth!.updatedAt).toBeNull();
  });

  it(`round-trips the ${engine} key and stamps updatedAt`, () => {
    const u = createUser({ username: `${engine}-bob`, passwordHash: 'h' });
    const updated = set()(u.id, { apiKey: sample });
    expect(updated!.apiKey).toBe(sample);
    expect(updated!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(get()(u.id)!.apiKey).toBe(sample);
  });

  it(`empty / whitespace clears the ${engine} key`, () => {
    const u = createUser({ username: `${engine}-dan`, passwordHash: 'h' });
    set()(u.id, { apiKey: sample });
    expect(get()(u.id)!.apiKey).toBe(sample);
    set()(u.id, { apiKey: '' });
    expect(get()(u.id)!.apiKey).toBeNull();
    set()(u.id, { apiKey: sample });
    set()(u.id, { apiKey: '   ' });
    expect(get()(u.id)!.apiKey).toBeNull();
  });

  it(`returns null on an unknown user id (${engine})`, () => {
    expect(get()('does-not-exist')).toBeNull();
    expect(set()('does-not-exist', { apiKey: 'x' })).toBeNull();
  });

  it(`isolates ${engine} from the other engines' keys`, () => {
    const u = createUser({ username: `${engine}-iso`, passwordHash: 'h' });
    set()(u.id, { apiKey: sample });
    // The other two single-key engines should still be untouched.
    const others = (['cursor', 'gemini', 'codex'] as const).filter((e) => e !== engine);
    for (const other of others) {
      const fn =
        other === 'cursor'
          ? getUserCursorAuth
          : other === 'gemini'
            ? getUserGeminiAuth
            : getUserCodexAuth;
      expect(fn(u.id)!.apiKey).toBeNull();
    }
    // Claude should also be untouched.
    expect(getUserClaudeAuth(u.id)!.anthropicApiKey).toBeNull();
  });
});

// ── Encryption-at-rest ───────────────────────────────────────────────
//
// Asserts that secret columns are encrypted on disk and that the read
// path transparently decrypts them. We poke directly at the SQLite row
// to confirm the stored value is the iv:tag:ciphertext shape and not
// the plaintext API key that the test handed to `setUser*Auth`.

function rawColumn(userId: string, column: string): string | null {
  const row = getOrgsDb().prepare(`SELECT ${column} AS v FROM users WHERE id = ?`).get(userId) as
    | { v: string | null }
    | undefined;
  return row?.v ?? null;
}

const ENCRYPTED_BLOB_RE = /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

describe('users-store — encryption at rest', () => {
  beforeEach(() => freshDb());

  it('stores Anthropic API key as encrypted blob, not plaintext', () => {
    const u = createUser({ username: 'enc-alice', passwordHash: 'h' });
    setUserClaudeAuth(u.id, { anthropicApiKey: 'sk-ant-api03-secret-value-xyz' });
    const stored = rawColumn(u.id, 'anthropic_api_key');
    expect(stored).not.toBeNull();
    expect(stored).not.toBe('sk-ant-api03-secret-value-xyz');
    expect(stored).toMatch(ENCRYPTED_BLOB_RE);
    // Round-trip via the typed reader still yields plaintext.
    expect(getUserClaudeAuth(u.id)!.anthropicApiKey).toBe('sk-ant-api03-secret-value-xyz');
  });

  it('stores Claude Code OAuth token as encrypted blob', () => {
    const u = createUser({ username: 'enc-bob', passwordHash: 'h' });
    setUserClaudeAuth(u.id, { claudeCodeOAuthToken: 'sk-ant-oat01-bearer-XYZ' });
    const stored = rawColumn(u.id, 'claude_code_oauth_token');
    expect(stored).not.toBe('sk-ant-oat01-bearer-XYZ');
    expect(stored).toMatch(ENCRYPTED_BLOB_RE);
    expect(getUserClaudeAuth(u.id)!.claudeCodeOAuthToken).toBe('sk-ant-oat01-bearer-XYZ');
  });

  it.each(['cursor_api_key', 'gemini_api_key', 'codex_api_key'])(
    'stores %s as encrypted blob',
    (column) => {
      const u = createUser({ username: `enc-${column}`, passwordHash: 'h' });
      const sample = `secret-${column}-value`;
      if (column === 'cursor_api_key') setUserCursorAuth(u.id, { apiKey: sample });
      if (column === 'gemini_api_key') setUserGeminiAuth(u.id, { apiKey: sample });
      if (column === 'codex_api_key') setUserCodexAuth(u.id, { apiKey: sample });
      const stored = rawColumn(u.id, column);
      expect(stored).not.toBe(sample);
      expect(stored).toMatch(ENCRYPTED_BLOB_RE);
      // Reader returns plaintext.
      const reread =
        column === 'cursor_api_key'
          ? getUserCursorAuth(u.id)
          : column === 'gemini_api_key'
            ? getUserGeminiAuth(u.id)
            : getUserCodexAuth(u.id);
      expect(reread!.apiKey).toBe(sample);
    },
  );

  it('clearing a field nulls the column rather than storing ciphertext-of-empty', () => {
    const u = createUser({ username: 'enc-clear', passwordHash: 'h' });
    setUserClaudeAuth(u.id, { anthropicApiKey: 'sk-ant-api03-temp' });
    expect(rawColumn(u.id, 'anthropic_api_key')).toMatch(ENCRYPTED_BLOB_RE);
    setUserClaudeAuth(u.id, { anthropicApiKey: '' });
    expect(rawColumn(u.id, 'anthropic_api_key')).toBeNull();
  });

  it('decrypts every supported secret column on read', () => {
    const u = createUser({ username: 'enc-all', passwordHash: 'h' });
    setUserClaudeAuth(u.id, {
      anthropicApiKey: 'sk-ant-api03-all-1',
      claudeCodeOAuthToken: 'sk-ant-oat01-all-2',
    });
    setUserCursorAuth(u.id, { apiKey: 'cur-all-3' });
    setUserGeminiAuth(u.id, { apiKey: 'gem-all-4' });
    setUserCodexAuth(u.id, { apiKey: 'sk-codex-all-5' });
    // Every column on disk must be encrypted.
    for (const c of [
      'anthropic_api_key',
      'claude_code_oauth_token',
      'cursor_api_key',
      'gemini_api_key',
      'codex_api_key',
    ]) {
      expect(rawColumn(u.id, c)).toMatch(ENCRYPTED_BLOB_RE);
    }
    // Every reader must round-trip plaintext.
    expect(getUserClaudeAuth(u.id)!.anthropicApiKey).toBe('sk-ant-api03-all-1');
    expect(getUserClaudeAuth(u.id)!.claudeCodeOAuthToken).toBe('sk-ant-oat01-all-2');
    expect(getUserCursorAuth(u.id)!.apiKey).toBe('cur-all-3');
    expect(getUserGeminiAuth(u.id)!.apiKey).toBe('gem-all-4');
    expect(getUserCodexAuth(u.id)!.apiKey).toBe('sk-codex-all-5');
  });

  it('lazily backfills a legacy plaintext row as encrypted on first read', () => {
    // Simulate a pre-encryption row: insert plaintext directly via
    // raw SQL, bypassing the encrypting writer.
    const u = createUser({ username: 'enc-legacy', passwordHash: 'h' });
    const plaintext = 'sk-ant-api03-legacy-plaintext';
    getOrgsDb().prepare('UPDATE users SET anthropic_api_key = ? WHERE id = ?').run(plaintext, u.id);
    expect(rawColumn(u.id, 'anthropic_api_key')).toBe(plaintext);

    // First read returns the plaintext value (handling legacy rows).
    const first = getUserClaudeAuth(u.id);
    expect(first!.anthropicApiKey).toBe(plaintext);

    // …and rewrites the column with an encrypted blob so subsequent
    // reads no longer touch a plaintext-on-disk row.
    expect(rawColumn(u.id, 'anthropic_api_key')).toMatch(ENCRYPTED_BLOB_RE);
    expect(rawColumn(u.id, 'anthropic_api_key')).not.toBe(plaintext);
    expect(getUserClaudeAuth(u.id)!.anthropicApiKey).toBe(plaintext);
  });

  it('lazily backfills a legacy plaintext single-key row (cursor) too', () => {
    const u = createUser({ username: 'enc-legacy-cur', passwordHash: 'h' });
    getOrgsDb()
      .prepare('UPDATE users SET cursor_api_key = ? WHERE id = ?')
      .run('cur-legacy-plain', u.id);
    expect(rawColumn(u.id, 'cursor_api_key')).toBe('cur-legacy-plain');
    expect(getUserCursorAuth(u.id)!.apiKey).toBe('cur-legacy-plain');
    expect(rawColumn(u.id, 'cursor_api_key')).toMatch(ENCRYPTED_BLOB_RE);
  });

  it('returns null when a stored encrypted blob fails to decrypt (corrupt row)', () => {
    const u = createUser({ username: 'enc-corrupt', passwordHash: 'h' });
    // Mint a real blob, then flip a byte of the auth TAG segment (which
    // is exactly 16 bytes → 24 base64 chars with no padding, so any
    // single-char swap definitely changes the decoded bytes). AES-GCM
    // verifies the tag during decryptSecret, so a corrupt tag triggers
    // the catch branch in decryptCredentialColumn.
    setUserClaudeAuth(u.id, { anthropicApiKey: 'sk-ant-api03-soon-corrupt' });
    const blob = rawColumn(u.id, 'anthropic_api_key')!;
    const parts = blob.split(':');
    expect(parts).toHaveLength(3);
    // Flip the first char of the tag segment to one that's still in the
    // base64 alphabet but reliably different.
    const tag = parts[1];
    const flippedTag = (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1);
    parts[1] = flippedTag;
    getOrgsDb()
      .prepare('UPDATE users SET anthropic_api_key = ? WHERE id = ?')
      .run(parts.join(':'), u.id);
    // Corrupt ciphertext degrades to "no credential" rather than throwing
    // up the chain — `chat.ts` and `engine-auth-status.ts` already
    // tolerate null and fall back to host config.
    expect(getUserClaudeAuth(u.id)!.anthropicApiKey).toBeNull();
  });
});

// ── Audit logging ────────────────────────────────────────────────────
//
// Every secret-field write to a per-user engine credential must emit
// exactly one `user_engine_auth_audit` row, tagged with the engine,
// the column-name field, and the action (`upsert` for set/rotate,
// `delete` when an existing value was cleared). Bookkeeping-only PUTs
// (changing only `claudeCodeOAuthExpiresAt`, or re-PUTting with the
// `apiKey` field omitted) must NOT pollute the log.

describe('users-store — audit logging on credential writes', () => {
  beforeEach(() => freshDb());

  it('emits an upsert row when setting an Anthropic API key', () => {
    const u = createUser({ username: 'aud-alice', passwordHash: 'h' });
    setUserClaudeAuth(u.id, { anthropicApiKey: 'sk-ant-api03-aud-1' });
    const rows = listUserEngineAuthAudit(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: u.id,
      engine: 'claude',
      field: 'anthropic_api_key',
      action: 'upsert',
      actor_user_id: u.id,
    });
  });

  it('emits two rows for a single PUT that sets both Claude fields', () => {
    const u = createUser({ username: 'aud-bob', passwordHash: 'h' });
    setUserClaudeAuth(u.id, {
      anthropicApiKey: 'sk-ant-api03-bob',
      claudeCodeOAuthToken: 'sk-ant-oat01-bob',
    });
    const rows = listUserEngineAuthAudit(u.id, { engine: 'claude' });
    expect(rows).toHaveLength(2);
    const fields = rows.map((r) => r.field).sort();
    expect(fields).toEqual(['anthropic_api_key', 'claude_code_oauth_token']);
    expect(rows.every((r) => r.action === 'upsert')).toBe(true);
  });

  it('emits a delete row when clearing a previously-set field', () => {
    const u = createUser({ username: 'aud-carol', passwordHash: 'h' });
    setUserClaudeAuth(u.id, { anthropicApiKey: 'sk-ant-api03-carol' });
    setUserClaudeAuth(u.id, { anthropicApiKey: '' });
    const rows = listUserEngineAuthAudit(u.id);
    expect(rows).toHaveLength(2);
    // Both writes can land in the same SQLite-second so the row order
    // is non-deterministic; assert the multiset of actions/fields.
    expect(rows.map((r) => r.action).sort()).toEqual(['delete', 'upsert']);
    expect(rows.every((r) => r.field === 'anthropic_api_key' && r.engine === 'claude')).toBe(true);
  });

  it('does NOT emit an audit row for an expiry-only metadata PUT', () => {
    const u = createUser({ username: 'aud-dan', passwordHash: 'h' });
    setUserClaudeAuth(u.id, { claudeCodeOAuthExpiresAt: '2030-01-01T00:00:00Z' });
    expect(listUserEngineAuthAudit(u.id)).toHaveLength(0);
  });

  it.each([
    { engine: 'cursor', set: () => setUserCursorAuth, field: 'cursor_api_key' },
    { engine: 'gemini', set: () => setUserGeminiAuth, field: 'gemini_api_key' },
    { engine: 'codex', set: () => setUserCodexAuth, field: 'codex_api_key' },
  ])('emits one upsert and one delete row for $engine over set→clear', ({ engine, set, field }) => {
    const u = createUser({ username: `aud-${engine}`, passwordHash: 'h' });
    set()(u.id, { apiKey: `${engine}-key-1` });
    set()(u.id, { apiKey: '' });
    const rows = listUserEngineAuthAudit(u.id, {
      engine: engine as 'cursor' | 'gemini' | 'codex',
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.action).sort()).toEqual(['delete', 'upsert']);
    expect(rows.every((r) => r.field === field)).toBe(true);
    expect(rows.every((r) => r.engine === engine)).toBe(true);
  });

  it('does NOT emit an audit row when the patch omits the apiKey field (no-op write)', () => {
    const u = createUser({ username: 'aud-noop', passwordHash: 'h' });
    setUserCursorAuth(u.id, { apiKey: 'cur-noop-1' });
    // Empty patch: nothing to audit. Calling the setter still bumps
    // `cursor_auth_updated_at` (intentional — the route always stamps
    // the row), but the audit log must stay quiet.
    const before = listUserEngineAuthAudit(u.id).length;
    setUserCursorAuth(u.id, {});
    expect(listUserEngineAuthAudit(u.id).length).toBe(before);
  });

  it('actorUserId defaults to the row owner but can be overridden', () => {
    const u = createUser({ username: 'aud-actor', passwordHash: 'h' });
    setUserClaudeAuth(u.id, { anthropicApiKey: 'sk-ant-api03-self' });
    setUserClaudeAuth(
      u.id,
      { anthropicApiKey: 'sk-ant-api03-admin-rotated' },
      { actorUserId: 'admin-user-id' },
    );
    // Two writes in the same SQLite-second resolve to identical
    // `created_at`; the ORDER BY fallback to `id DESC` on a random uuid
    // makes per-row position non-deterministic. Assert the multiset of
    // actor ids instead.
    const rows = listUserEngineAuthAudit(u.id);
    expect(rows).toHaveLength(2);
    const actors = rows.map((r) => r.actor_user_id).sort();
    expect(actors).toEqual([u.id, 'admin-user-id'].sort());
  });
});
