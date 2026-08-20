/**
 * Regression coverage for #1905: a fresh session worktree's node_modules used to
 * be a junction symlink into the shared project checkout, so a project build that
 * ran a package manager in the linked dir (surveytracker's `build_app` runs
 * `npm ci` in `frontend/`) recursed THROUGH the link and deleted packages out of
 * the shared donor tree — corrupting every other worktree pointing at the same
 * inode.
 *
 * `provisionNodeModules` now materializes an isolated tree via a tiered strategy
 * (reflink -> hardlink -> copy -> symlink last resort). The central invariant —
 * a project-run wipe of the session tree leaves the shared donor intact — is
 * exercised here deterministically on ANY same-device filesystem: where reflink
 * is unavailable (ext4/overlayfs CI) the hardlink tier still isolates deletion,
 * so the assertion never silently degrades to the symlink-only branch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import os from 'os';

import { __test } from './worktree.js';

const { provisionNodeModules, hardlinkCopyDir } = __test;

describe('provisionNodeModules — session node_modules isolation (#1905)', () => {
  let root = '';
  let donorNM = '';
  let target = '';

  beforeEach(() => {
    root = path.join(
      os.tmpdir(),
      `nm-provision-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    // Shared "project checkout" with a populated node_modules the Hub seeds from.
    donorNM = path.join(root, 'source', 'frontend', 'node_modules');
    mkdirSync(path.join(donorNM, 'http-proxy'), { recursive: true });
    writeFileSync(path.join(donorNM, 'http-proxy', 'index.js'), 'module.exports = 1;\n', 'utf8');
    mkdirSync(path.join(donorNM, '.bin'), { recursive: true });

    // Fresh session worktree target (does not exist yet — the caller mkdirs the parent).
    target = path.join(root, 'clone', 'frontend', 'node_modules');
    mkdirSync(path.dirname(target), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('materializes an isolated tree (never a symlink) that a project-run wipe cannot reach', async () => {
    const mode = await provisionNodeModules(donorNM, target);

    // Same-device tmpdir (the normal CI case): reflink on CoW, else hardlink.
    // Either way we must NOT get the corruption-prone junction symlink.
    expect(['reflink', 'hardlink', 'copy']).toContain(mode);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(readFileSync(path.join(target, 'http-proxy', 'index.js'), 'utf8')).toContain(
      'module.exports = 1;',
    );

    // Simulate the project build wiping node_modules (what `npm ci` does first).
    rmSync(target, { recursive: true, force: true });

    // The shared donor must be untouched — this is the whole point of the fix.
    expect(existsSync(path.join(donorNM, 'http-proxy', 'index.js'))).toBe(true);
  });

  it('falls back to a junction symlink when the donor node_modules is itself a symlink', async () => {
    // A symlinked donor can't be copied without dereferencing; keep the legacy
    // junction (no worse than before) rather than cloning a link into the donor.
    const realNM = path.join(root, 'real-node-modules');
    mkdirSync(realNM, { recursive: true });
    const linkedDonor = path.join(root, 'linked-node-modules');
    symlinkSync(realNM, linkedDonor, 'junction');

    expect(await provisionNodeModules(linkedDonor, target)).toBe('symlink');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });
});

describe('hardlinkCopyDir — deletion isolation on any same-device filesystem', () => {
  let root = '';
  let src = '';
  let dst = '';

  beforeEach(() => {
    root = path.join(os.tmpdir(), `hl-copy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    src = path.join(root, 'src');
    dst = path.join(root, 'dst');
    mkdirSync(path.join(src, 'pkg'), { recursive: true });
    writeFileSync(path.join(src, 'pkg', 'index.js'), 'hi', 'utf8');
    // A relative symlink like node_modules/.bin entries — must be recreated as a
    // symlink, not followed/hardlinked.
    symlinkSync(path.join('pkg', 'index.js'), path.join(src, 'link.js'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('hardlinks files (shared inode), recreates symlinks, and survives a wipe of the copy', async () => {
    await hardlinkCopyDir(src, dst);

    // File is a hardlink: same inode as the donor.
    const srcIno = statSync(path.join(src, 'pkg', 'index.js')).ino;
    const dstIno = statSync(path.join(dst, 'pkg', 'index.js')).ino;
    expect(dstIno).toBe(srcIno);

    // Symlink was recreated as a symlink, not dereferenced into a hardlink.
    expect(lstatSync(path.join(dst, 'link.js')).isSymbolicLink()).toBe(true);

    // Wiping the copy leaves the donor's tree and files intact (deletion isolated).
    rmSync(dst, { recursive: true, force: true });
    expect(existsSync(path.join(src, 'pkg', 'index.js'))).toBe(true);
    expect(existsSync(path.join(src, 'link.js'))).toBe(true);
  });

  it('copies a nested tree larger than the worker pool (bounded queue drains fully)', async () => {
    // More dirs and files than NODE_MODULES_HARDLINK_CONCURRENCY (8) so the
    // fixed-pool queue-drain (active-counter termination, dynamic enqueue) is
    // exercised — a premature-exit bug would drop files.
    const expected: string[] = [];
    for (let d = 0; d < 25; d++) {
      const dir = path.join(src, 'deps', `pkg-${d}`, 'lib');
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 4; f++) {
        const rel = path.join('deps', `pkg-${d}`, 'lib', `f-${f}.js`);
        writeFileSync(path.join(src, rel), `module.exports = ${d * 10 + f};\n`, 'utf8');
        expected.push(rel);
      }
    }

    await hardlinkCopyDir(src, dst);

    for (const rel of expected) {
      expect(statSync(path.join(dst, rel)).ino).toBe(statSync(path.join(src, rel)).ino);
    }
  });
});
