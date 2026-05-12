/**
 * Unit tests for the worktree-preview secrets store.
 *
 * Exercises the acceptance criteria spelled out on the kanban card:
 *   - encrypt/decrypt round-trip for `plain` and `secret` kinds
 *   - tamper detection (modified ciphertext → masked / silently dropped)
 *   - reserved-key rejection (AGENT_HUB_*, NODE_*, PATH, HOME)
 *   - `.env` parser handles export, quotes, comments, duplicate keys
 *   - audit row appended on upsert / delete / read
 *   - `loadProjectEnvForSpawn` returns decrypted values + logs read keys
 *
 * Uses the global `server/test/setup.ts` per-file AGENT_HUB_DATA_DIR
 * isolation, so the encryption key and SQLite DB are unique to each
 * test file run (no cross-file leakage of MASK semantics).
 */
import '../test/setup.js';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  listPreviewSecrets,
  listRawPreviewSecretRows,
  replacePreviewSecrets,
  replacePreviewSecretsMixed,
  deletePreviewSecret,
  loadProjectEnvForSpawn,
  parseDotEnv,
  listPreviewSecretAudit,
  PreviewSecretValidationError,
  RESERVED_KEY_RE,
} from './preview-secrets-store.js';
import { MASK } from '../secret-crypto.js';
import { getDb } from '../db.js';

const PROJECT_A = 'proj-secrets-a';
const PROJECT_B = 'proj-secrets-b';

beforeEach(() => {
  // Reset the rows owned by these test projects so each test starts clean.
  // The other tests in the suite run in the same per-file DB; scoping by
  // project id is enough to keep them independent.
  const db = getDb();
  db.prepare(`DELETE FROM worktree_preview_secrets WHERE project_id IN (?, ?)`).run(
    PROJECT_A,
    PROJECT_B,
  );
  db.prepare(`DELETE FROM worktree_preview_secret_audit WHERE project_id IN (?, ?)`).run(
    PROJECT_A,
    PROJECT_B,
  );
});

describe('replacePreviewSecrets + listPreviewSecrets', () => {
  it('round-trips a plain-kind value (returned in clear on list)', () => {
    replacePreviewSecrets(PROJECT_A, [{ key: 'FEATURE_X', value: 'on', kind: 'plain' }]);
    const rows = listPreviewSecrets(PROJECT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'FEATURE_X',
      value: 'on',
      kind: 'plain',
      project_id: PROJECT_A,
    });
  });

  it('masks a secret-kind value on list (never returns plaintext via the list path)', () => {
    replacePreviewSecrets(PROJECT_A, [
      { key: 'STRIPE_KEY', value: 'sk_test_real_value', kind: 'secret' },
    ]);
    const rows = listPreviewSecrets(PROJECT_A);
    expect(rows[0].value).toBe(MASK);
    expect(rows[0].value).not.toContain('sk_test_real_value');
  });

  it('defaults kind=secret when caller omits it', () => {
    replacePreviewSecrets(PROJECT_A, [{ key: 'DATABASE_URL', value: 'postgres://x' }]);
    const rows = listPreviewSecrets(PROJECT_A);
    expect(rows[0].kind).toBe('secret');
    expect(rows[0].value).toBe(MASK);
  });

  it('round-trips both kinds and exposes them in key-sorted order', () => {
    replacePreviewSecrets(PROJECT_A, [
      { key: 'STRIPE_KEY', value: 'sk_live', kind: 'secret' },
      { key: 'FEATURE_X', value: 'on', kind: 'plain' },
      { key: 'AWS_ACCESS_KEY_ID', value: 'AKIA-x', kind: 'secret' },
    ]);
    const rows = listPreviewSecrets(PROJECT_A);
    expect(rows.map((r) => r.key)).toEqual(['AWS_ACCESS_KEY_ID', 'FEATURE_X', 'STRIPE_KEY']);
    expect(rows.find((r) => r.key === 'FEATURE_X')!.value).toBe('on');
    expect(rows.find((r) => r.key === 'STRIPE_KEY')!.value).toBe(MASK);
  });

  it('replaces the prior batch atomically (delete-then-insert)', () => {
    replacePreviewSecrets(PROJECT_A, [
      { key: 'KEEP', value: '1', kind: 'plain' },
      { key: 'DROP', value: '2', kind: 'plain' },
    ]);
    replacePreviewSecrets(PROJECT_A, [{ key: 'NEW', value: '3', kind: 'plain' }]);
    const rows = listPreviewSecrets(PROJECT_A);
    expect(rows.map((r) => r.key)).toEqual(['NEW']);
  });

  it('scopes rows to project_id (no leakage across projects)', () => {
    replacePreviewSecrets(PROJECT_A, [{ key: 'SHARED', value: 'a', kind: 'plain' }]);
    replacePreviewSecrets(PROJECT_B, [{ key: 'SHARED', value: 'b', kind: 'plain' }]);
    expect(listPreviewSecrets(PROJECT_A)[0].value).toBe('a');
    expect(listPreviewSecrets(PROJECT_B)[0].value).toBe('b');
  });
});

describe('replacePreviewSecrets — validation', () => {
  it('throws PreviewSecretValidationError for AGENT_HUB_* keys', () => {
    expect(() => replacePreviewSecrets(PROJECT_A, [{ key: 'AGENT_HUB_URL', value: 'x' }])).toThrow(
      PreviewSecretValidationError,
    );
  });

  it('throws for NODE_* keys', () => {
    expect(() => replacePreviewSecrets(PROJECT_A, [{ key: 'NODE_ENV', value: 'prod' }])).toThrow(
      /reserved/,
    );
  });

  it('throws for exact-match PATH and HOME', () => {
    expect(() => replacePreviewSecrets(PROJECT_A, [{ key: 'PATH', value: '/x' }])).toThrow();
    expect(() => replacePreviewSecrets(PROJECT_A, [{ key: 'HOME', value: '/x' }])).toThrow();
  });

  it('allows PATH-prefixed names that are not exact (e.g. PATHFINDER)', () => {
    // The regex is /PATH$|HOME$/ — PATHFINDER must pass, not be rejected.
    expect(RESERVED_KEY_RE.test('PATHFINDER')).toBe(false);
    expect(() =>
      replacePreviewSecrets(PROJECT_A, [{ key: 'PATHFINDER', value: 'on', kind: 'plain' }]),
    ).not.toThrow();
  });

  it('throws for syntactically invalid identifiers', () => {
    expect(() => replacePreviewSecrets(PROJECT_A, [{ key: '1BAD', value: 'x' }])).toThrow(
      /identifier|match/i,
    );
    expect(() =>
      replacePreviewSecrets(PROJECT_A, [{ key: 'KEY WITH SPACES', value: 'x' }]),
    ).toThrow();
  });

  it('throws on duplicate keys in the same batch (no partial write)', () => {
    expect(() =>
      replacePreviewSecrets(PROJECT_A, [
        { key: 'X', value: 'a', kind: 'plain' },
        { key: 'X', value: 'b', kind: 'plain' },
      ]),
    ).toThrow(/duplicate/);
    // The DB must be unchanged — validation runs before the write tx.
    expect(listPreviewSecrets(PROJECT_A)).toHaveLength(0);
  });

  it('rejects values that exceed the size cap', () => {
    const huge = 'x'.repeat(64 * 1024 + 1);
    expect(() =>
      replacePreviewSecrets(PROJECT_A, [{ key: 'BIG', value: huge, kind: 'plain' }]),
    ).toThrow(/exceeds/);
  });
});

describe('loadProjectEnvForSpawn', () => {
  it('decrypts both plain and secret kinds and returns the merged map', () => {
    replacePreviewSecrets(PROJECT_A, [
      { key: 'STRIPE_KEY', value: 'sk_real', kind: 'secret' },
      { key: 'FEATURE_X', value: 'on', kind: 'plain' },
    ]);
    const env = loadProjectEnvForSpawn(PROJECT_A, { sessionId: 'sess-1' });
    expect(env).toEqual({ STRIPE_KEY: 'sk_real', FEATURE_X: 'on' });
  });

  it('returns an empty object when the project has no secrets', () => {
    const env = loadProjectEnvForSpawn(PROJECT_A, { sessionId: 'sess-empty' });
    expect(env).toEqual({});
  });

  it('appends a read audit row with the keys touched (never the values)', () => {
    replacePreviewSecrets(PROJECT_A, [
      { key: 'STRIPE_KEY', value: 'sk_real', kind: 'secret' },
      { key: 'FEATURE_X', value: 'on', kind: 'plain' },
    ]);
    loadProjectEnvForSpawn(PROJECT_A, { sessionId: 'sess-audit' });
    const audit = listPreviewSecretAudit(PROJECT_A);
    const readRow = audit.find((r) => r.action === 'read');
    expect(readRow).toBeDefined();
    // Keys are pipe-delimited in the audit blob, in key-sorted order.
    expect(readRow!.keys.split('|').sort()).toEqual(['FEATURE_X', 'STRIPE_KEY']);
    expect(readRow!.session_id).toBe('sess-audit');
    // No row may carry the plaintext value anywhere.
    expect(readRow!.keys).not.toContain('sk_real');
    expect(JSON.stringify(readRow)).not.toContain('sk_real');
  });

  it('does not append a read audit when there is nothing to read', () => {
    loadProjectEnvForSpawn(PROJECT_A, { sessionId: 'sess-empty' });
    const audit = listPreviewSecretAudit(PROJECT_A);
    expect(audit.filter((r) => r.action === 'read')).toHaveLength(0);
  });

  it('skips a tampered row but still returns the rest', () => {
    replacePreviewSecrets(PROJECT_A, [
      { key: 'GOOD', value: 'real', kind: 'secret' },
      { key: 'BAD', value: 'corrupt-me', kind: 'secret' },
    ]);
    // Corrupt the BAD row's ciphertext directly. decryptSecret() must
    // throw on the modified blob; loadProjectEnvForSpawn swallows and
    // continues.
    const db = getDb();
    db.prepare(
      `UPDATE worktree_preview_secrets
          SET value_ciphertext = 'AAAA:BBBB:not-real-ciphertext'
        WHERE project_id = ? AND key = 'BAD'`,
    ).run(PROJECT_A);

    const env = loadProjectEnvForSpawn(PROJECT_A, { sessionId: 's' });
    expect(env).toEqual({ GOOD: 'real' });
    expect('BAD' in env).toBe(false);
  });
});

describe('tamper detection', () => {
  it('list path returns MASK rather than throwing when a plain-kind ciphertext is corrupted', () => {
    replacePreviewSecrets(PROJECT_A, [{ key: 'GREETING', value: 'hello', kind: 'plain' }]);
    getDb()
      .prepare(
        `UPDATE worktree_preview_secrets
            SET value_ciphertext = 'AAAA:BBBB:tampered'
          WHERE project_id = ? AND key = 'GREETING'`,
      )
      .run(PROJECT_A);
    const rows = listPreviewSecrets(PROJECT_A);
    // The row is still returned (operators need to see it exists), but
    // its value is the MASK so the corrupt plaintext isn't surfaced.
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(MASK);
  });
});

describe('deletePreviewSecret', () => {
  it('returns true and removes the row when the key exists', () => {
    replacePreviewSecrets(PROJECT_A, [{ key: 'GONE', value: 'bye', kind: 'plain' }]);
    expect(deletePreviewSecret(PROJECT_A, 'GONE')).toBe(true);
    expect(listPreviewSecrets(PROJECT_A)).toHaveLength(0);
  });

  it('returns false when the key does not exist (no audit row appended)', () => {
    expect(deletePreviewSecret(PROJECT_A, 'NEVER_EXISTED')).toBe(false);
    const audit = listPreviewSecretAudit(PROJECT_A);
    expect(audit.filter((r) => r.action === 'delete')).toHaveLength(0);
  });

  it('appends a delete audit row when a row is removed', () => {
    replacePreviewSecrets(PROJECT_A, [{ key: 'GONE', value: 'bye', kind: 'plain' }]);
    deletePreviewSecret(PROJECT_A, 'GONE', 'user-42');
    const audit = listPreviewSecretAudit(PROJECT_A);
    const row = audit.find((r) => r.action === 'delete');
    expect(row).toBeDefined();
    expect(row!.keys).toBe('GONE');
    expect(row!.actor_user_id).toBe('user-42');
  });
});

describe('audit on upsert', () => {
  it('records the keys + actor on replacePreviewSecrets', () => {
    replacePreviewSecrets(
      PROJECT_A,
      [
        { key: 'A', value: '1', kind: 'plain' },
        { key: 'B', value: '2', kind: 'secret' },
      ],
      'user-7',
    );
    const audit = listPreviewSecretAudit(PROJECT_A);
    const upsert = audit.find((r) => r.action === 'upsert');
    expect(upsert).toBeDefined();
    expect(upsert!.keys.split('|').sort()).toEqual(['A', 'B']);
    expect(upsert!.actor_user_id).toBe('user-7');
  });
});

describe('parseDotEnv', () => {
  // parseDotEnv intentionally returns entries with kind: undefined so
  // the route-level `defaultKind` override is reachable (PR #904
  // review). The store's `validateKindOrThrow` defaults undefined to
  // 'secret' when these are passed through to `replacePreviewSecrets`.
  it('parses simple KEY=value pairs with undefined kind', () => {
    const out = parseDotEnv('FOO=bar\nBAZ=qux');
    expect(out).toEqual([
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ]);
    expect(out.every((e) => e.kind === undefined)).toBe(true);
  });

  it('strips a leading `export `', () => {
    const out = parseDotEnv('export FOO=bar');
    expect(out).toEqual([{ key: 'FOO', value: 'bar' }]);
  });

  it('strips matching double / single quote wrappers but preserves inner content', () => {
    const out = parseDotEnv(`A="hello world"\nB='single quoted'\nC="has=inner=eq"`);
    expect(out).toEqual([
      { key: 'A', value: 'hello world' },
      { key: 'B', value: 'single quoted' },
      { key: 'C', value: 'has=inner=eq' },
    ]);
  });

  it('skips comments and blank lines', () => {
    const out = parseDotEnv('# top comment\n\nFOO=bar\n   \n#another\nBAZ=qux');
    expect(out.map((e) => e.key)).toEqual(['FOO', 'BAZ']);
  });

  it('keeps the LAST occurrence on duplicate keys', () => {
    const out = parseDotEnv('FOO=first\nFOO=second\nFOO=third');
    expect(out).toEqual([{ key: 'FOO', value: 'third' }]);
  });

  it('skips lines with invalid identifiers', () => {
    const out = parseDotEnv('1BAD=oops\nGOOD=ok\nKEY WITH SPACE=no');
    expect(out.map((e) => e.key)).toEqual(['GOOD']);
  });

  it('does not shell-expand $VARS', () => {
    const out = parseDotEnv('REF=$OTHER\nPATHY=${X}');
    expect(out[0].value).toBe('$OTHER');
    expect(out[1].value).toBe('${X}');
  });

  it('handles an empty / whitespace-only blob', () => {
    expect(parseDotEnv('')).toEqual([]);
    expect(parseDotEnv('   \n\n  \t')).toEqual([]);
  });
});

describe('listRawPreviewSecretRows', () => {
  it('returns the stored ciphertext, IV, tag, and kind for every row', () => {
    replacePreviewSecrets(PROJECT_A, [
      { key: 'STRIPE_KEY', value: 'sk_live', kind: 'secret' },
      { key: 'FEATURE_X', value: 'on', kind: 'plain' },
    ]);
    const raw = listRawPreviewSecretRows(PROJECT_A);
    expect(raw).toHaveLength(2);
    const byKey = Object.fromEntries(raw.map((r) => [r.key, r]));
    expect(byKey.STRIPE_KEY.kind).toBe('secret');
    expect(byKey.FEATURE_X.kind).toBe('plain');
    // ciphertext is the iv:tag:cipher triple — non-empty, contains
    // colons, never equals the plaintext.
    expect(byKey.STRIPE_KEY.value_ciphertext).toMatch(/^[^:]+:[^:]+:.+$/);
    expect(byKey.STRIPE_KEY.value_ciphertext).not.toContain('sk_live');
  });

  it('returns an empty array for a project with no secrets', () => {
    expect(listRawPreviewSecretRows(PROJECT_A)).toEqual([]);
  });
});

describe('replacePreviewSecretsMixed — merge-mode preservation', () => {
  it('round-trips a secret-kind passthrough row without decrypting (BLOCKER #1 regression)', () => {
    // Seed a secret-kind row and capture its raw form.
    replacePreviewSecrets(PROJECT_A, [
      { key: 'STRIPE_KEY', value: 'sk_live_REAL', kind: 'secret' },
    ]);
    const raw = listRawPreviewSecretRows(PROJECT_A);
    expect(raw).toHaveLength(1);

    // Caller imports a new key. The existing STRIPE_KEY row MUST survive
    // the merge — under the old route logic this row was silently
    // dropped because listPreviewSecrets returned MASK and the route
    // skipped non-plain rows.
    replacePreviewSecretsMixed(PROJECT_A, [{ key: 'NEW_FLAG', value: '1', kind: 'plain' }], raw);

    // Both keys must be present.
    const after = listPreviewSecrets(PROJECT_A);
    expect(after.map((r) => r.key).sort()).toEqual(['NEW_FLAG', 'STRIPE_KEY']);

    // And the secret-kind value must still decrypt to the original
    // plaintext on the spawn-merge path (the only path that reveals it).
    const env = loadProjectEnvForSpawn(PROJECT_A, { sessionId: 's' });
    expect(env.STRIPE_KEY).toBe('sk_live_REAL');
    expect(env.NEW_FLAG).toBe('1');
  });

  it('overwrites a passthrough row when the same key appears in inputs ("inputs win")', () => {
    replacePreviewSecrets(PROJECT_A, [{ key: 'API_KEY', value: 'old', kind: 'secret' }]);
    const raw = listRawPreviewSecretRows(PROJECT_A);
    replacePreviewSecretsMixed(PROJECT_A, [{ key: 'API_KEY', value: 'new', kind: 'secret' }], raw);
    const env = loadProjectEnvForSpawn(PROJECT_A, { sessionId: 's' });
    expect(env.API_KEY).toBe('new');
  });

  it('preserves plain-kind passthrough rows verbatim', () => {
    replacePreviewSecrets(PROJECT_A, [{ key: 'FEATURE_X', value: 'on', kind: 'plain' }]);
    const raw = listRawPreviewSecretRows(PROJECT_A);
    replacePreviewSecretsMixed(PROJECT_A, [{ key: 'OTHER', value: 'y', kind: 'plain' }], raw);
    const env = loadProjectEnvForSpawn(PROJECT_A, { sessionId: 's' });
    expect(env.FEATURE_X).toBe('on');
    expect(env.OTHER).toBe('y');
  });

  it('rejects an input with a reserved key (no write, validation atomic)', () => {
    replacePreviewSecrets(PROJECT_A, [{ key: 'KEEP', value: 'me', kind: 'plain' }]);
    const raw = listRawPreviewSecretRows(PROJECT_A);
    expect(() =>
      replacePreviewSecretsMixed(PROJECT_A, [{ key: 'AGENT_HUB_URL', value: 'evil' }], raw),
    ).toThrow(PreviewSecretValidationError);
    // The original row is still there — nothing was deleted.
    const after = listPreviewSecrets(PROJECT_A);
    expect(after.map((r) => r.key)).toEqual(['KEEP']);
  });

  it('appends an upsert audit row covering the union of input + passthrough keys', () => {
    replacePreviewSecrets(PROJECT_A, [{ key: 'OLD_SECRET', value: 'x', kind: 'secret' }]);
    // Clear the audit trail for a clean assertion (the seed call wrote one).
    getDb()
      .prepare(`DELETE FROM worktree_preview_secret_audit WHERE project_id = ?`)
      .run(PROJECT_A);
    const raw = listRawPreviewSecretRows(PROJECT_A);
    replacePreviewSecretsMixed(
      PROJECT_A,
      [{ key: 'NEW_FLAG', value: '1', kind: 'plain' }],
      raw,
      'user-merge',
    );
    const audit = listPreviewSecretAudit(PROJECT_A);
    const upsert = audit.find((r) => r.action === 'upsert');
    expect(upsert).toBeDefined();
    expect(upsert!.keys.split('|').sort()).toEqual(['NEW_FLAG', 'OLD_SECRET']);
    expect(upsert!.actor_user_id).toBe('user-merge');
  });
});

describe('defaultKind override (via route → store)', () => {
  it('replacePreviewSecrets defaults kind to secret when undefined', () => {
    replacePreviewSecrets(PROJECT_A, [{ key: 'NO_KIND', value: 'v' }]);
    const rows = listPreviewSecrets(PROJECT_A);
    expect(rows[0].kind).toBe('secret');
    expect(rows[0].value).toBe(MASK);
  });

  it('parseDotEnv + caller-supplied plain default lands as plain-kind rows', () => {
    // This is the path the route uses for defaultKind: 'plain'. The
    // parser yields kind: undefined; the route overlays defaultKind;
    // the store accepts the explicit 'plain' and returns it in clear.
    const parsed = parseDotEnv('CFG_A=on\nCFG_B=off');
    const withPlainDefault = parsed.map((p) => ({ ...p, kind: 'plain' as const }));
    replacePreviewSecrets(PROJECT_A, withPlainDefault);
    const rows = listPreviewSecrets(PROJECT_A);
    expect(rows.every((r) => r.kind === 'plain')).toBe(true);
    expect(rows.find((r) => r.key === 'CFG_A')!.value).toBe('on');
    expect(rows.find((r) => r.key === 'CFG_B')!.value).toBe('off');
  });
});
