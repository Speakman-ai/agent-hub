import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { ensureHostCliHome, hostCliHomePath, hostCodexHomePath } from './host-cli-home.js';

describe('host-cli-home', () => {
  let dataDir: string;
  let operatorHome: string;
  let prevHome: string | undefined;
  let prevCodexHome: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ah-host-creds-'));
    operatorHome = mkdtempSync(path.join(os.tmpdir(), 'ah-operator-home-'));
    // Pin operator HOME so migration does not copy the developer's real ~/.cursor.
    prevHome = process.env.HOME;
    prevCodexHome = process.env.CODEX_HOME;
    process.env.HOME = operatorHome;
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(operatorHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
  });

  it('creates persistent host HOME under dataDir', () => {
    const home = ensureHostCliHome(dataDir);
    expect(home).toBe(hostCliHomePath(dataDir));
    expect(existsSync(home)).toBe(true);
  });

  it('creates the host HOME with mode 0700 (no other user can read CLI tokens)', () => {
    const home = ensureHostCliHome(dataDir);
    const mode = statSync(home).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('is idempotent — repeated calls return the same path with no errors', () => {
    const a = ensureHostCliHome(dataDir);
    const b = ensureHostCliHome(dataDir);
    const c = ensureHostCliHome(dataDir);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(existsSync(a)).toBe(true);
  });

  it('refuses to use a host HOME owned by a different OS UID (ownership guard)', () => {
    // Pre-create the leaf so mkdirSync's recursive no-op path triggers and we
    // can simulate the "data volume populated by a prior container under a
    // different UID" scenario. Then stub `geteuid` to a value that does not
    // match the leaf's reported uid.
    const home = hostCliHomePath(dataDir);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const realUid = statSync(home).uid;
    const proc = process as NodeJS.Process & { geteuid?: () => number };
    if (typeof proc.geteuid !== 'function') return; // Windows — guard is skipped, nothing to assert
    const spy = vi.spyOn(proc, 'geteuid').mockReturnValue(realUid + 1);
    try {
      expect(() => ensureHostCliHome(dataDir)).toThrow(/owned by uid/);
    } finally {
      spy.mockRestore();
    }
  });

  it('migrates operator ~/.cursor into host HOME when destination is empty', () => {
    const operatorCursor = path.join(operatorHome, '.cursor');
    mkdirSync(operatorCursor, { recursive: true });
    writeFileSync(path.join(operatorCursor, 'token.json'), '{"migrated":true}');

    const hostHome = ensureHostCliHome(dataDir);
    const migrated = path.join(hostHome, '.cursor');
    expect(existsSync(migrated)).toBe(true);
    expect(readdirSync(migrated)).toContain('token.json');
  });

  it('migrates operator ~/.codex into host HOME when destination is empty', () => {
    const operatorCodex = path.join(operatorHome, '.codex');
    mkdirSync(operatorCodex, { recursive: true });
    writeFileSync(path.join(operatorCodex, 'auth.json'), '{"tokens":{}}');

    const hostHome = ensureHostCliHome(dataDir);
    const migrated = hostCodexHomePath(dataDir);
    expect(migrated).toBe(path.join(hostHome, '.codex'));
    expect(existsSync(migrated)).toBe(true);
    expect(readdirSync(migrated)).toContain('auth.json');
  });
});
