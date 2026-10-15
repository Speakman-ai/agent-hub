/**
 * scripts/history-scrub/scrub-history.py against throwaway fixture repos
 * (real git + python3, no network, nothing pushed).
 */
import { spawnSync, execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'history-scrub',
  'scrub-history.py',
);
const SECRET = 'AKIAFIXTURESECRET0001';

const hasFilterRepo =
  spawnSync('python3', ['-c', 'import git_filter_repo'], { stdio: 'ignore' }).status === 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim();
}

function scrub(...args: string[]) {
  return spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('scrub-history.py', () => {
  let root: string;
  let repo: string;
  let secrets: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'history-scrub-'));
    repo = path.join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '--initial-branch=main');
    writeFileSync(path.join(repo, 'a.txt'), 'clean contents\n');
    git(repo, 'add', 'a.txt');
    secrets = path.join(root, 'secrets.txt');
    writeFileSync(secrets, `${SECRET}\n`);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const verifyArgs = () => ['--workdir', repo, '--verify-only', '--replace-text', secrets];

  it('verify flags an identifier that appears only in a commit or tag message', () => {
    git(repo, 'commit', '-q', '-m', 'add a\n\nfiled by widgetcorp');
    git(repo, 'tag', '-a', 'v1', '-m', 'release for widgetcorp');
    const res = scrub('--workdir', repo, '--verify-only', '--word', 'widgetcorp=acme');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('leak: commit');
    expect(res.stderr).toContain('leak: tag');
  });

  it.skipIf(!hasFilterRepo)(
    'verify flags a credential that appears only in a commit message',
    () => {
      git(repo, 'commit', '-q', '-m', `add a\n\ntoken=${SECRET}`);
      const res = scrub(...verifyArgs());
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('leak: commit');
    },
  );

  it.skipIf(!hasFilterRepo)('verify flags a credential that appears only in a tag message', () => {
    git(repo, 'commit', '-q', '-m', 'add a');
    git(repo, 'tag', '-a', 'v1', '-m', `release ${SECRET}`);
    const res = scrub(...verifyArgs());
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('leak: tag');
  });

  it.skipIf(!hasFilterRepo)('verify passes a clean repo', () => {
    git(repo, 'commit', '-q', '-m', 'add a');
    const res = scrub(...verifyArgs());
    expect(res.stdout).toMatch(/verified \d+ objects, 0 with matches/);
    expect(res.status).toBe(0);
  });

  it('verify-only runs without --source; a rewrite still requires it', () => {
    git(repo, 'commit', '-q', '-m', 'add a');
    const verify = scrub('--workdir', repo, '--verify-only', '--word', 'widgetcorp=acme');
    expect(verify.stdout).toMatch(/verified \d+ objects, 0 with matches/);
    expect(verify.status).toBe(0);

    const rewrite = scrub('--workdir', path.join(root, 'out'), '--word', 'widgetcorp=acme');
    expect(rewrite.status).toBe(2);
    expect(rewrite.stderr).toContain('--source is required unless --verify-only');
  });

  it('verify fails on a directory that is not a repository', () => {
    const plain = path.join(root, 'plain');
    mkdirSync(plain);
    const res = scrub('--workdir', plain, '--verify-only', '--word', 'x=y');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('verification failed');
  });

  it('verify fails on a plain subdirectory inside another repository', () => {
    git(repo, 'commit', '-q', '-m', 'add a');
    const sub = path.join(repo, 'sub');
    mkdirSync(sub);
    const res = scrub('--workdir', sub, '--verify-only', '--word', 'x=y');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('not a git repository root');
  });

  it.skipIf(!hasFilterRepo)('rewrite removes a credential from commit and tag messages', () => {
    git(repo, 'commit', '-q', '-m', `add a\n\ntoken=${SECRET}`);
    git(repo, 'tag', '-a', 'v1', '-m', `release ${SECRET}`);
    const out = path.join(root, 'out');
    const res = scrub('--source', repo, '--workdir', out, '--replace-text', secrets);
    expect(res.stderr).not.toContain('leak:');
    expect(res.status).toBe(0);
    expect(git(out, 'log', '--format=%B', '-1', 'main')).toContain('token=***REMOVED***');
    expect(git(out, 'cat-file', '-p', 'v1')).toContain('release ***REMOVED***');
  });

  it.skipIf(!hasFilterRepo)(
    'regex replacements expand capture groups; literal rules stay literal; glob works',
    () => {
      writeFileSync(
        path.join(repo, 'a.txt'),
        `token=${SECRET}\nhost=old.internal\npass=hunter2x\n`,
      );
      git(repo, 'add', 'a.txt');
      git(repo, 'commit', '-q', '-m', `rotate\n\ntoken=${SECRET}`);
      writeFileSync(
        secrets,
        [`regex:(token=)${SECRET}==>\\1REMOVED`, 'glob:hunter2?==>GLOBBED'].join('\n') + '\n',
      );
      const out = path.join(root, 'out');
      const res = scrub(
        '--source',
        repo,
        '--workdir',
        out,
        '--replace-text',
        secrets,
        '--literal',
        'old.internal=new\\1.example',
      );
      expect(res.stderr).not.toContain('leak:');
      expect(res.status).toBe(0);
      const file = git(out, 'show', 'main:a.txt');
      expect(file).toContain('token=REMOVED');
      expect(file).not.toContain('\\1REMOVED');
      expect(file).toContain('host=new\\1.example');
      expect(file).toContain('pass=GLOBBED');
      expect(git(out, 'log', '--format=%B', '-1', 'main')).toContain('token=REMOVED');
    },
  );

  it.skipIf(!hasFilterRepo)('leaves binary blobs untouched and reports the match', () => {
    writeFileSync(path.join(repo, 'img.bin'), Buffer.from(`\0\0widgetcorp\0`));
    git(repo, 'add', 'img.bin');
    git(repo, 'commit', '-q', '-m', 'add binary');
    const out = path.join(root, 'out');
    const res = scrub('--source', repo, '--workdir', out, '--word', 'widgetcorp=acme');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('leak: blob');
    expect(execFileSync('git', ['show', 'main:img.bin'], { cwd: out })).toEqual(
      Buffer.from(`\0\0widgetcorp\0`),
    );
  });
});
