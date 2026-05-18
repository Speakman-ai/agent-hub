import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, statSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  perUserCliHomeRoot,
  perUserCliHomePath,
  ensurePerUserCliHome,
  clearPerUserCliHome,
} from './per-user-cli-home.js';

describe('per-user-cli-home', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'percli-home-'));
  });

  afterEach(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('path shape', () => {
    it('roots all per-engine, per-user homes under <dataDir>/per-user-cli-home', () => {
      expect(perUserCliHomeRoot(dataDir)).toBe(path.join(dataDir, 'per-user-cli-home'));
    });

    it('builds <dataDir>/per-user-cli-home/<engine>/<userId>', () => {
      expect(perUserCliHomePath('cursor', 'alice', dataDir)).toBe(
        path.join(dataDir, 'per-user-cli-home', 'cursor', 'alice'),
      );
      expect(perUserCliHomePath('codex', 'bob', dataDir)).toBe(
        path.join(dataDir, 'per-user-cli-home', 'codex', 'bob'),
      );
      expect(perUserCliHomePath('gemini', 'u-1', dataDir)).toBe(
        path.join(dataDir, 'per-user-cli-home', 'gemini', 'u-1'),
      );
    });

    it('keeps engines isolated — cursor and codex paths do not overlap', () => {
      const a = perUserCliHomePath('cursor', 'alice', dataDir);
      const b = perUserCliHomePath('codex', 'alice', dataDir);
      expect(a).not.toBe(b);
      expect(a).toContain(`${path.sep}cursor${path.sep}`);
      expect(b).toContain(`${path.sep}codex${path.sep}`);
    });

    it('keeps users isolated within an engine', () => {
      const a = perUserCliHomePath('cursor', 'alice', dataDir);
      const b = perUserCliHomePath('cursor', 'bob', dataDir);
      expect(a).not.toBe(b);
    });

    it('rejects unknown engine names', () => {
      expect(() => perUserCliHomePath('claude', 'alice', dataDir)).toThrow(/unknown engine/);
      expect(() => perUserCliHomePath('', 'alice', dataDir)).toThrow(/unknown engine/);
      expect(() => perUserCliHomePath('cursor../codex', 'alice', dataDir)).toThrow(
        /unknown engine/,
      );
    });

    it('rejects path-traversal userIds', () => {
      expect(() => perUserCliHomePath('cursor', '..', dataDir)).toThrow(/invalid userId/);
      expect(() => perUserCliHomePath('cursor', '.', dataDir)).toThrow(/invalid userId/);
      expect(() => perUserCliHomePath('cursor', 'alice/../bob', dataDir)).toThrow(/invalid userId/);
      expect(() => perUserCliHomePath('cursor', '', dataDir)).toThrow(/invalid userId/);
      // Accepts UUIDs (with hyphens) and slug-style ids
      expect(() =>
        perUserCliHomePath('cursor', 'a1b2c3d4-e5f6-7890-abcd-ef0123456789', dataDir),
      ).not.toThrow();
      expect(() => perUserCliHomePath('cursor', 'user.with.dots', dataDir)).not.toThrow();
    });
  });

  describe('ensurePerUserCliHome', () => {
    it('creates the leaf directory mode 0700 on first call', () => {
      const home = ensurePerUserCliHome('cursor', 'alice', dataDir);
      expect(existsSync(home)).toBe(true);
      const st = statSync(home);
      expect(st.isDirectory()).toBe(true);
      // Lower 9 bits should be 0o700 (owner rwx only). Skip on platforms
      // where mode bits don't survive (Windows) — guarded by geteuid.
      if (typeof (process as NodeJS.Process & { geteuid?: () => number }).geteuid === 'function') {
        expect(st.mode & 0o777).toBe(0o700);
      }
    });

    it('is idempotent — second call is a no-op and returns the same path', () => {
      const a = ensurePerUserCliHome('cursor', 'alice', dataDir);
      const b = ensurePerUserCliHome('cursor', 'alice', dataDir);
      expect(a).toBe(b);
      expect(existsSync(a)).toBe(true);
    });

    it('returns distinct trees for the same user across engines', () => {
      const cursorHome = ensurePerUserCliHome('cursor', 'alice', dataDir);
      const codexHome = ensurePerUserCliHome('codex', 'alice', dataDir);
      expect(cursorHome).not.toBe(codexHome);
      // Writes to one must not be visible in the other.
      writeFileSync(path.join(cursorHome, 'marker.txt'), 'cursor');
      expect(existsSync(path.join(codexHome, 'marker.txt'))).toBe(false);
    });

    it('creates intermediate <engine> directory on demand', () => {
      // Confirm we never depend on the engine dir pre-existing.
      const root = perUserCliHomeRoot(dataDir);
      expect(existsSync(root)).toBe(false);
      ensurePerUserCliHome('codex', 'alice', dataDir);
      expect(existsSync(path.join(root, 'codex'))).toBe(true);
    });

    it('throws on unknown engine before touching the filesystem', () => {
      const root = perUserCliHomeRoot(dataDir);
      expect(() => ensurePerUserCliHome('claude', 'alice', dataDir)).toThrow(/unknown engine/);
      expect(existsSync(root)).toBe(false);
    });

    it('throws on invalid userId before touching the filesystem', () => {
      const root = perUserCliHomeRoot(dataDir);
      expect(() => ensurePerUserCliHome('cursor', '..', dataDir)).toThrow(/invalid userId/);
      expect(existsSync(root)).toBe(false);
    });

    it('ownership guard rejects a leaf whose uid does not match the running process', () => {
      const procWithUid = process as NodeJS.Process & { geteuid?: () => number };
      if (typeof procWithUid.geteuid !== 'function') return;

      // Pre-create the leaf with our real uid. Then make geteuid() report
      // something different — the guard reads stats.uid (real) vs
      // geteuid() (fake) and the mismatch must throw.
      const leaf = perUserCliHomePath('cursor', 'alice', dataDir);
      mkdirSync(leaf, { recursive: true, mode: 0o700 });

      const realUid = procWithUid.geteuid();
      const spy = vi.spyOn(procWithUid, 'geteuid').mockReturnValue(realUid + 12345);
      try {
        expect(() => ensurePerUserCliHome('cursor', 'alice', dataDir)).toThrow(/owned by uid/);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('clearPerUserCliHome', () => {
    it('removes the leaf when present', () => {
      const home = ensurePerUserCliHome('cursor', 'alice', dataDir);
      writeFileSync(path.join(home, 'token.json'), '{}');
      expect(existsSync(home)).toBe(true);
      clearPerUserCliHome('cursor', 'alice', dataDir);
      expect(existsSync(home)).toBe(false);
    });

    it('is a no-op when the leaf does not exist', () => {
      expect(() => clearPerUserCliHome('cursor', 'never-existed', dataDir)).not.toThrow();
    });

    it('only removes the requested (engine, user) leaf — keeps siblings', () => {
      const cursorAlice = ensurePerUserCliHome('cursor', 'alice', dataDir);
      const cursorBob = ensurePerUserCliHome('cursor', 'bob', dataDir);
      const codexAlice = ensurePerUserCliHome('codex', 'alice', dataDir);
      writeFileSync(path.join(cursorAlice, 'm.txt'), 'a');
      writeFileSync(path.join(cursorBob, 'm.txt'), 'b');
      writeFileSync(path.join(codexAlice, 'm.txt'), 'c');

      clearPerUserCliHome('cursor', 'alice', dataDir);

      expect(existsSync(cursorAlice)).toBe(false);
      expect(existsSync(cursorBob)).toBe(true);
      expect(existsSync(codexAlice)).toBe(true);
    });
  });
});
