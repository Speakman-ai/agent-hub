import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { prepareNodePtySpawnHelper } from './node-pty-spawn-helper.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pty-helper-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(dir: string) {
  const native = path.join(root, dir, 'pty.node');
  const helper = path.join(root, dir, 'spawn-helper');
  mkdirSync(path.dirname(native), { recursive: true });
  writeFileSync(native, 'fixture');
  writeFileSync(helper, 'fixture');
  chmodSync(helper, 0o644);
  return { native, helper };
}

describe('prepareNodePtySpawnHelper', () => {
  it('repairs the non-executable macOS helper beside the loaded native binding', () => {
    const unused = fixture('build/Release');
    const selected = fixture('prebuilds/darwin-arm64');
    prepareNodePtySpawnHelper(path.join(root, 'lib/index.js'), [selected.native], 'darwin');
    expect(statSync(selected.helper).mode & 0o777).toBe(0o744);
    expect(statSync(unused.helper).mode & 0o777).toBe(0o644);
  });

  it('leaves executable helpers unchanged', () => {
    const selected = fixture('build/Release');
    chmodSync(selected.helper, 0o755);
    prepareNodePtySpawnHelper(path.join(root, 'lib/index.js'), [selected.native], 'darwin');
    expect(statSync(selected.helper).mode & 0o777).toBe(0o755);
  });

  it('does not touch other native packages or non-macOS installs', () => {
    const selected = fixture('prebuilds/darwin-arm64');
    prepareNodePtySpawnHelper(path.join(root, 'lib/index.js'), [selected.native], 'linux');
    expect(statSync(selected.helper).mode & 0o777).toBe(0o644);
    prepareNodePtySpawnHelper(path.join(root, 'other/lib/index.js'), [selected.native], 'darwin');
    expect(statSync(selected.helper).mode & 0o777).toBe(0o644);
  });

  it('explains a missing launcher instead of reporting an opaque spawn failure', () => {
    const selected = fixture('build/Release');
    rmSync(selected.helper);
    expect(() =>
      prepareNodePtySpawnHelper(path.join(root, 'lib/index.js'), [selected.native], 'darwin'),
    ).toThrow(/terminal launcher.*Reinstall/s);
  });
});
