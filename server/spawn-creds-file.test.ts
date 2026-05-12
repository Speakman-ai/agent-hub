import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  spawnCredsDir,
  spawnCredsPath,
  writeSpawnCredsFile,
  readSpawnCredsFile,
  removeSpawnCredsFile,
} from './spawn-creds-file.js';

describe('spawn-creds-file', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'spawn-creds-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('path helpers', () => {
    it('spawnCredsDir is <dataDir>/spawn-creds', () => {
      expect(spawnCredsDir(tmp)).toBe(path.join(tmp, 'spawn-creds'));
    });

    it('spawnCredsPath includes the session id with .token suffix', () => {
      expect(spawnCredsPath('abc-123', tmp)).toBe(path.join(tmp, 'spawn-creds', 'abc-123.token'));
    });

    it('rejects session ids with path separators (anti-traversal)', () => {
      expect(() => spawnCredsPath('../etc/passwd', tmp)).toThrow(/invalid sessionId/);
      expect(() => spawnCredsPath('a/b', tmp)).toThrow(/invalid sessionId/);
      expect(() => spawnCredsPath('', tmp)).toThrow(/invalid sessionId/);
    });
  });

  describe('writeSpawnCredsFile', () => {
    it('creates the file with mode 0600', () => {
      const written = writeSpawnCredsFile('sess-1', 'ahub_test_token', tmp);
      expect(existsSync(written)).toBe(true);
      const mode = statSync(written).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(readFileSync(written, 'utf8')).toBe('ahub_test_token');
    });

    it('creates the directory with mode 0700', () => {
      writeSpawnCredsFile('sess-1', 'tok', tmp);
      const dirMode = statSync(spawnCredsDir(tmp)).mode & 0o777;
      expect(dirMode).toBe(0o700);
    });

    it('overwrites an existing file with the new token (rotation)', () => {
      writeSpawnCredsFile('sess-1', 'old', tmp);
      writeSpawnCredsFile('sess-1', 'new', tmp);
      expect(readSpawnCredsFile('sess-1', tmp)).toBe('new');
    });

    it('preserves mode 0600 across overwrite', () => {
      writeSpawnCredsFile('sess-1', 'a', tmp);
      // Tamper with the mode the way a careless caller might.
      writeFileSync(spawnCredsPath('sess-1', tmp), 'b', { mode: 0o644 });
      writeSpawnCredsFile('sess-1', 'c', tmp);
      const mode = statSync(spawnCredsPath('sess-1', tmp)).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('rejects empty tokens', () => {
      expect(() => writeSpawnCredsFile('sess-1', '', tmp)).toThrow(/non-empty/);
    });

    it('writes are atomic — no half-written file visible on rename', () => {
      // Hard to assert atomicity directly without two threads, but at
      // least confirm the temp file is gone after a successful write.
      writeSpawnCredsFile('sess-1', 'final', tmp);
      const tmpFile = `${spawnCredsPath('sess-1', tmp)}.${process.pid}.tmp`;
      expect(existsSync(tmpFile)).toBe(false);
    });
  });

  describe('readSpawnCredsFile', () => {
    it('returns null when the file does not exist', () => {
      expect(readSpawnCredsFile('missing', tmp)).toBeNull();
    });

    it('round-trips a written token', () => {
      writeSpawnCredsFile('s1', 'ahub_xyz', tmp);
      expect(readSpawnCredsFile('s1', tmp)).toBe('ahub_xyz');
    });

    it('trims trailing newline if one was appended externally', () => {
      // writeSpawnCredsFile creates the directory + writes; we then
      // overwrite via plain writeFileSync to simulate an external writer
      // that left a trailing newline.
      writeSpawnCredsFile('s2', 'placeholder', tmp);
      writeFileSync(spawnCredsPath('s2', tmp), 'tok\n', { mode: 0o600 });
      expect(readSpawnCredsFile('s2', tmp)).toBe('tok');
    });
  });

  describe('removeSpawnCredsFile', () => {
    it('removes an existing file', () => {
      writeSpawnCredsFile('s1', 'tok', tmp);
      removeSpawnCredsFile('s1', tmp);
      expect(readSpawnCredsFile('s1', tmp)).toBeNull();
    });

    it('is a no-op when the file does not exist', () => {
      expect(() => removeSpawnCredsFile('never-existed', tmp)).not.toThrow();
    });
  });
});
