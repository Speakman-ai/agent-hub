import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { listSessionDesignFiles, listSessionDesignFilesAtRoot } from './session-design-files.js';

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), 'ah-session-design-'));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe('listSessionDesignFiles', () => {
  it('returns [] for a null / blank / non-string worktree path', () => {
    expect(listSessionDesignFiles(null)).toEqual([]);
    expect(listSessionDesignFiles(undefined)).toEqual([]);
    expect(listSessionDesignFiles('')).toEqual([]);
    // @ts-expect-error — intentionally passing a wrong type to exercise the guard
    expect(listSessionDesignFiles(42)).toEqual([]);
  });

  it('returns [] when the worktree has no design/ dir yet', () => {
    expect(listSessionDesignFiles(worktree)).toEqual([]);
  });

  it('lists regular files under design/ with forward-slash relative paths', () => {
    const design = path.join(worktree, 'design');
    mkdirSync(path.join(design, 'assets'), { recursive: true });
    writeFileSync(path.join(design, 'index.html'), '<h1>hi</h1>');
    writeFileSync(path.join(design, 'style.css'), 'body{}');
    writeFileSync(path.join(design, 'assets', 'logo.svg'), '<svg/>');

    const files = listSessionDesignFiles(worktree);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('style.css');
    expect(paths).toContain('assets/logo.svg');
    // Each entry carries a numeric size and an ISO mtime.
    const index = files.find((f) => f.path === 'index.html');
    expect(index?.size).toBeGreaterThan(0);
    expect(typeof index?.mtime).toBe('string');
  });

  it('never follows symlinks (skips them entirely)', () => {
    const design = path.join(worktree, 'design');
    mkdirSync(design, { recursive: true });
    writeFileSync(path.join(design, 'real.html'), 'real');
    // A symlink pointing outside the design root must not be emitted or followed.
    const secret = path.join(worktree, 'secret.txt');
    writeFileSync(secret, 'top secret');
    symlinkSync(secret, path.join(design, 'leak.txt'));

    const paths = listSessionDesignFiles(worktree).map((f) => f.path);
    expect(paths).toContain('real.html');
    expect(paths).not.toContain('leak.txt');
  });
});

describe('listSessionDesignFilesAtRoot (data-dir store)', () => {
  it('returns [] for a null / blank root', () => {
    expect(listSessionDesignFilesAtRoot(null)).toEqual([]);
    expect(listSessionDesignFilesAtRoot(undefined)).toEqual([]);
    expect(listSessionDesignFilesAtRoot('')).toEqual([]);
  });

  it('lists files directly under the root (no design/ subdir)', () => {
    // The workflow store holds artifacts at the root itself.
    const root = path.join(worktree, 'design-sessions', 'sess-1');
    mkdirSync(path.join(root, 'assets'), { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<h1>wf</h1>');
    writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');

    const paths = listSessionDesignFilesAtRoot(root).map((f) => f.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('assets/app.js');
  });
});
