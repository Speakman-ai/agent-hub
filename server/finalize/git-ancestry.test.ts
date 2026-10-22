import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plainIsAncestor, shallowAwareIsAncestor } from './git-ancestry.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('shallowAwareIsAncestor', () => {
  let root: string;
  let upstream: string;
  const shas: string[] = [];

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'git-ancestry-'));
    upstream = path.join(root, 'upstream');
    execFileSync('git', ['init', '-q', '-b', 'main', upstream]);
    git(upstream, 'config', 'user.email', 't@example.com');
    git(upstream, 'config', 'user.name', 't');
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(upstream, 'f.txt'), String(i));
      git(upstream, 'add', 'f.txt');
      git(upstream, 'commit', '-q', '-m', `c${i}`);
      shas.push(git(upstream, 'rev-parse', 'HEAD'));
    }
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function shallowClone(name: string): string {
    const dir = path.join(root, name);
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${upstream}`, dir]);
    return dir;
  }

  it('confirms a real ancestor past the shallow boundary', async () => {
    const dir = shallowClone('a');
    // The plain check can't see past the graft: this is the false "stale".
    expect(await plainIsAncestor(dir, shas[2], shas[4])).not.toBe(true);
    expect(await shallowAwareIsAncestor(dir, shas[2], shas[4])).toBe(true);
  });

  it('still answers false for a commit that is not an ancestor', async () => {
    const dir = shallowClone('b');
    expect(await shallowAwareIsAncestor(dir, shas[4], shas[2])).not.toBe(true);
  });

  it('short-circuits equal shas', async () => {
    expect(await shallowAwareIsAncestor('/nonexistent', 'abc', 'abc')).toBe(true);
  });
});
