import { execFile } from 'child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HostWorktreeIo,
  WorktreeGitError,
  resolveWorktreeRelative,
  toPosixRelative,
} from './worktree-io.js';

const execFileAsync = promisify(execFile);

describe('resolveWorktreeRelative', () => {
  it('resolves a relative path under the root', () => {
    expect(resolveWorktreeRelative('/wt', 'a/b.txt')).toBe(path.resolve('/wt/a/b.txt'));
  });

  it('allows the root itself', () => {
    expect(resolveWorktreeRelative('/wt', '.')).toBe(path.resolve('/wt'));
  });

  it('rejects absolute input rather than reinterpreting it', () => {
    expect(() => resolveWorktreeRelative('/wt', '/etc/passwd')).toThrow(/must be relative/);
  });

  it('rejects traversal past the root', () => {
    expect(() => resolveWorktreeRelative('/wt', '../etc/passwd')).toThrow(/escapes the worktree/);
  });

  it('does not treat a sibling with a shared prefix as inside the root', () => {
    // /wt-evil starts with "/wt" as a string but is a different directory.
    expect(() => resolveWorktreeRelative('/wt', '../wt-evil/x')).toThrow(/escapes the worktree/);
  });
});

describe('toPosixRelative', () => {
  it('normalises and strips a leading ./', () => {
    expect(toPosixRelative('./a/./b')).toBe('a/b');
  });

  it('maps the root to the empty string', () => {
    expect(toPosixRelative('.')).toBe('');
  });

  it('rejects absolute and escaping paths', () => {
    expect(() => toPosixRelative('/abs')).toThrow(/must be relative/);
    expect(() => toPosixRelative('../up')).toThrow(/escapes the worktree/);
  });

  it('keeps interior .. that stays inside the tree', () => {
    expect(toPosixRelative('a/../b')).toBe('b');
  });
});

describe('HostWorktreeIo', () => {
  let root: string;
  let io: HostWorktreeIo;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'worktree-io-'));
    io = new HostWorktreeIo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports host-shared and exposes the host path', () => {
    expect(io.sharing).toBe('host-shared');
    expect(io.hostPath).toBe(root);
  });

  it('round-trips file contents', async () => {
    await io.writeFile('a/b.txt', 'hello');
    expect((await io.readFile('a/b.txt')).toString('utf8')).toBe('hello');
    // Written through to the real filesystem, not just an internal cache.
    expect(await readFile(path.join(root, 'a/b.txt'), 'utf8')).toBe('hello');
  });

  it('creates missing parent directories on write', async () => {
    await io.writeFile('deep/nested/dir/file.txt', 'x');
    expect(await io.exists('deep/nested/dir/file.txt')).toBe(true);
  });

  it('preserves binary content', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x00]);
    await io.writeFile('bin.dat', bytes);
    expect(await io.readFile('bin.dat')).toEqual(bytes);
  });

  it('copies a host file in via uploadFile without going through writeFile', async () => {
    const src = path.join(root, 'src.bin');
    await writeFile(src, Buffer.from([0x00, 0xff, 0x10]));
    await io.uploadFile('copied.bin', src);
    expect(await io.readFile('copied.bin')).toEqual(Buffer.from([0x00, 0xff, 0x10]));
  });

  it('lists entries with their kinds', async () => {
    await writeFile(path.join(root, 'file.txt'), 'x');
    await mkdir(path.join(root, 'dir'));
    await symlink(path.join(root, 'file.txt'), path.join(root, 'link'));
    const entries = (await io.listDir()).sort((a, b) => a.name.localeCompare(b.name));
    expect(entries).toEqual([
      { name: 'dir', kind: 'directory' },
      { name: 'file.txt', kind: 'file' },
      { name: 'link', kind: 'symlink' },
    ]);
  });

  it('stats a file and returns null for a missing path', async () => {
    await io.writeFile('present.txt', 'abc');
    expect(await io.stat('present.txt')).toMatchObject({ kind: 'file', size: 3 });
    expect(await io.stat('missing.txt')).toBeNull();
    expect(await io.exists('missing.txt')).toBe(false);
  });

  it('refuses to read outside the worktree', async () => {
    await expect(io.readFile('../escape.txt')).rejects.toThrow(/escapes the worktree/);
    await expect(io.writeFile('/etc/nope', 'x')).rejects.toThrow(/must be relative/);
  });

  describe('git', () => {
    beforeEach(async () => {
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      };
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root, env });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, env });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root, env });
      // An unborn HEAD is not the state callers ever see: worktree.ts clones
      // a repo that already has history, and `rev-parse HEAD` would fail here
      // for a reason unrelated to what these tests check.
      await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'root'], {
        cwd: root,
        env,
      });
    });

    it('runs git in the worktree and captures stdout', async () => {
      const result = await io.git(['rev-parse', '--abbrev-ref', 'HEAD']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('main');
    });

    it('reports a dirty worktree through status --porcelain', async () => {
      await io.writeFile('new.txt', 'x');
      const result = await io.git(['status', '--porcelain']);
      expect(result.stdout).toContain('new.txt');
    });

    it('resolves exit codes instead of throwing, so probes can read them', async () => {
      // `rev-parse` on a bad revision exits non-zero; callers treat that as
      // an answer ("no such ref"), not as a crash.
      const result = await io.git(['rev-parse', '--verify', 'no-such-ref']);
      expect(result.exitCode).not.toBe(0);
    });

    it('throws on non-zero only when asked', async () => {
      await expect(
        io.git(['rev-parse', '--verify', 'no-such-ref'], { throwOnNonZero: true }),
      ).rejects.toThrow(WorktreeGitError);
    });

    it('runs in a subdirectory when given a relative cwd', async () => {
      await io.writeFile('sub/file.txt', 'x');
      const result = await io.git(['rev-parse', '--show-prefix'], { cwd: 'sub' });
      expect(result.stdout.trim()).toBe('sub/');
    });

    it('rejects a cwd outside the worktree', async () => {
      await expect(io.git(['status'], { cwd: '../..' })).rejects.toThrow(/escapes the worktree/);
    });

    it('passes env through to the git process', async () => {
      await io.writeFile('f.txt', 'x');
      await io.git(['add', 'f.txt']);
      await io.git(['commit', '-m', 'msg'], {
        env: {
          GIT_AUTHOR_NAME: 'Envy',
          GIT_AUTHOR_EMAIL: 'envy@example.com',
          GIT_COMMITTER_NAME: 'Envy',
          GIT_COMMITTER_EMAIL: 'envy@example.com',
        },
      });
      const result = await io.git(['log', '-1', '--format=%an']);
      expect(result.stdout.trim()).toBe('Envy');
    });
  });
});
