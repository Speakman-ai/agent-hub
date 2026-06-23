import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  LocalDirBundleStore,
  bundleRevArgs,
  createWorktreeBundle,
  isWorktreeBundleFailureMessage,
  materializeWorktree,
  worktreeBundleKey,
} from './worktree-bundle.js';

describe('worktree-bundle', () => {
  let base: string;
  let srcRepo: string;
  let storeDir: string;
  let headSha: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'wt-bundle-'));
    srcRepo = path.join(base, 'src');
    storeDir = path.join(base, 'store');
    const git = (args: string[]) =>
      execFileSync('git', ['-C', srcRepo, ...args], { stdio: 'pipe' });
    execFileSync('git', ['init', '-q', '--initial-branch=main', srcRepo], { stdio: 'pipe' });
    git(['config', 'user.email', 't@t.t']);
    git(['config', 'user.name', 'T']);
    writeFileSync(path.join(srcRepo, 'hello.txt'), 'world\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
    headSha = execFileSync('git', ['-C', srcRepo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('bundles a worktree and materializes it back into a real repo (no GitHub push)', async () => {
    const store = new LocalDirBundleStore(storeDir);
    const key = worktreeBundleKey('orgA', 'run-1');
    expect(key).toBe('worktrees/orgA/run-1.bundle');

    const ref = await createWorktreeBundle({ worktreePath: srcRepo, key, store });
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.sizeBytes).toBeGreaterThan(0);

    const dest = path.join(base, 'workspace');
    await materializeWorktree({ ref, store, destPath: dest, rev: headSha });

    // The materialized workspace is a real git repo at the right commit.
    expect(readFileSync(path.join(dest, 'hello.txt'), 'utf8')).toBe('world\n');
    const gotSha = execFileSync('git', ['-C', dest, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    expect(gotSha).toBe(headSha);
  });

  it('materializes from a presigned getUrl (cross-host fleet path, no store)', async () => {
    const store = new LocalDirBundleStore(storeDir);
    const key = worktreeBundleKey('orgA', 'run-url');
    const ref = await createWorktreeBundle({ worktreePath: srcRepo, key, store });
    const bundleBytes = readFileSync(path.join(storeDir, key));

    // Stand in for S3's presigned URL: a fetch that streams the bundle bytes.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(bundleBytes, { status: 200 })) as typeof fetch;
    try {
      const dest = path.join(base, 'ws-url');
      // No store passed — must download via getUrl alone.
      await materializeWorktree({
        ref: { ...ref, getUrl: 'https://example.test/presigned' },
        destPath: dest,
        rev: headSha,
      });
      expect(readFileSync(path.join(dest, 'hello.txt'), 'utf8')).toBe('world\n');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('throws when a ref has neither getUrl nor a store', async () => {
    await expect(
      materializeWorktree({
        ref: { key: 'k', sha256: 'x'.repeat(64), sizeBytes: 1 },
        destPath: path.join(base, 'ws-none'),
      }),
    ).rejects.toThrow(/no getUrl and no store/);
  });

  // Regression: Finalize pins the bundle to the validated FINALIZE_HEAD_SHA by
  // passing a RAW commit SHA as `rev`. `git bundle create <file> <bare-oid>`
  // aborts with "fatal: Refusing to create empty bundle" because a bundle needs
  // a ref — which broke EVERY remote-fleet Finalize run and was misreported as a
  // transient `container_unavailable`. This bundles by raw SHA and asserts it
  // succeeds and round-trips to the exact commit.
  it('bundles by a RAW commit SHA without "Refusing to create empty bundle"', async () => {
    const store = new LocalDirBundleStore(storeDir);
    const key = worktreeBundleKey('orgA', 'run-rawsha', headSha);

    // rev = the bare 40-char OID, exactly what runner-backend-remote passes.
    const ref = await createWorktreeBundle({ worktreePath: srcRepo, key, store, rev: headSha });
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.sizeBytes).toBeGreaterThan(0);

    const dest = path.join(base, 'ws-rawsha');
    await materializeWorktree({ ref, store, destPath: dest, rev: headSha });
    expect(readFileSync(path.join(dest, 'hello.txt'), 'utf8')).toBe('world\n');
    const gotSha = execFileSync('git', ['-C', dest, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    expect(gotSha).toBe(headSha);
  });

  it('bundleRevArgs: raw OID gets a ref (HEAD) appended; symbolic refs pass through', () => {
    expect(bundleRevArgs(undefined)).toEqual(['HEAD']);
    expect(bundleRevArgs('HEAD')).toEqual(['HEAD']);
    expect(bundleRevArgs('main')).toEqual(['main']);
    expect(bundleRevArgs('a'.repeat(40))).toEqual(['a'.repeat(40), 'HEAD']);
    expect(bundleRevArgs('0123abc')).toEqual(['0123abc', 'HEAD']); // short OID
  });

  it('isWorktreeBundleFailureMessage detects deterministic git-bundle fatals', () => {
    expect(
      isWorktreeBundleFailureMessage(
        'Command failed: git -C /wt bundle create /tmp/x.bundle 73f1bbe4 fatal: Refusing to create empty bundle.',
      ),
    ).toBe(true);
    expect(isWorktreeBundleFailureMessage('Refusing to create empty bundle')).toBe(true);
    expect(isWorktreeBundleFailureMessage('container_unavailable: out of pids')).toBe(false);
    expect(isWorktreeBundleFailureMessage('')).toBe(false);
    expect(isWorktreeBundleFailureMessage(undefined)).toBe(false);
  });

  it('rejects a tampered/mismatched bundle (sha256 guard)', async () => {
    const store = new LocalDirBundleStore(storeDir);
    const key = worktreeBundleKey('orgA', 'run-2');
    const ref = await createWorktreeBundle({ worktreePath: srcRepo, key, store });

    await expect(
      materializeWorktree({
        ref: { ...ref, sha256: 'deadbeef'.repeat(8) },
        store,
        destPath: path.join(base, 'ws2'),
      }),
    ).rejects.toThrow(/sha256 mismatch/);
  });
});
