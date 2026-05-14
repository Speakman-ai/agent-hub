import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, statSync, existsSync, writeFileSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  perUserCredsRoot,
  perUserHomePath,
  ensurePerUserHome,
  clearPerUserCliCache,
} from './per-user-home.js';

describe('per-user-home — path helpers', () => {
  const dataDir = '/tmp/some-data-dir';

  it('perUserCredsRoot joins dataDir + per-user-creds', () => {
    expect(perUserCredsRoot(dataDir)).toBe('/tmp/some-data-dir/per-user-creds');
  });

  it('perUserHomePath joins dataDir + per-user-creds + userId + home', () => {
    expect(perUserHomePath('user-123', dataDir)).toBe(
      '/tmp/some-data-dir/per-user-creds/user-123/home',
    );
  });

  it('accepts UUID-shaped user ids (hyphens allowed)', () => {
    expect(() => perUserHomePath('11111111-2222-3333-4444-555555555555', dataDir)).not.toThrow();
  });

  it('rejects userId with path separators', () => {
    expect(() => perUserHomePath('a/b', dataDir)).toThrow(/invalid userId/);
    expect(() => perUserHomePath('..', dataDir)).toThrow(/invalid userId/);
    expect(() => perUserHomePath('../escape', dataDir)).toThrow(/invalid userId/);
  });

  it('rejects empty userId', () => {
    expect(() => perUserHomePath('', dataDir)).toThrow(/invalid userId/);
  });

  it('rejects userId exceeding 128 chars (defence-in-depth against path-length attacks)', () => {
    const longId = 'a'.repeat(129);
    expect(() => perUserHomePath(longId, dataDir)).toThrow(/invalid userId/);
  });
});

describe('per-user-home — ensurePerUserHome', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'agent-hub-puh-'));
  });

  it('creates the per-user HOME tree on first call', () => {
    const home = ensurePerUserHome('user-A', tmpDataDir);
    expect(existsSync(home)).toBe(true);
    expect(home).toBe(perUserHomePath('user-A', tmpDataDir));
  });

  it('is idempotent — second call is a no-op (no throw on existing dir)', () => {
    ensurePerUserHome('user-A', tmpDataDir);
    expect(() => ensurePerUserHome('user-A', tmpDataDir)).not.toThrow();
  });

  it('creates the directory with mode 0700', () => {
    const home = ensurePerUserHome('user-perms', tmpDataDir);
    const mode = statSync(home).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('different users get isolated directory subtrees', () => {
    const aHome = ensurePerUserHome('user-A', tmpDataDir);
    const bHome = ensurePerUserHome('user-B', tmpDataDir);
    expect(aHome).not.toBe(bHome);
    expect(existsSync(aHome)).toBe(true);
    expect(existsSync(bHome)).toBe(true);
  });
});

describe('per-user-home — clearPerUserCliCache', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'agent-hub-puh-clear-'));
  });

  it('removes the requested CLI cache subdir', () => {
    const home = ensurePerUserHome('user-clear', tmpDataDir);
    const cursorDir = path.join(home, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(path.join(cursorDir, 'auth.json'), '{"token":"abc"}');
    expect(existsSync(cursorDir)).toBe(true);

    clearPerUserCliCache('user-clear', tmpDataDir, '.cursor');

    expect(existsSync(cursorDir)).toBe(false);
  });

  it('no-op when the subdir doesnt exist', () => {
    ensurePerUserHome('user-noop', tmpDataDir);
    expect(() => clearPerUserCliCache('user-noop', tmpDataDir, '.codex')).not.toThrow();
  });

  it('preserves sibling CLI caches when clearing one', () => {
    const home = ensurePerUserHome('user-sibling', tmpDataDir);
    mkdirSync(path.join(home, '.cursor'), { recursive: true });
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    writeFileSync(path.join(home, '.codex', 'auth.json'), '{"keep":true}');

    clearPerUserCliCache('user-sibling', tmpDataDir, '.cursor');

    expect(existsSync(path.join(home, '.cursor'))).toBe(false);
    expect(existsSync(path.join(home, '.codex'))).toBe(true);
    expect(readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).toContain('keep');
  });

  it('rejects subdir containing a path separator (no generic delete primitive)', () => {
    ensurePerUserHome('user-traverse', tmpDataDir);
    expect(() => clearPerUserCliCache('user-traverse', tmpDataDir, '../../../etc')).toThrow(
      /invalid subdir/,
    );
    expect(() => clearPerUserCliCache('user-traverse', tmpDataDir, '.cursor/sub')).toThrow(
      /invalid subdir/,
    );
    expect(() => clearPerUserCliCache('user-traverse', tmpDataDir, '.')).toThrow(/invalid subdir/);
    expect(() => clearPerUserCliCache('user-traverse', tmpDataDir, '..')).toThrow(/invalid subdir/);
  });
});
