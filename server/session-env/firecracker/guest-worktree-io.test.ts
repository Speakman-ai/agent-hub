import { Buffer } from 'buffer';
import { describe, expect, it } from 'vitest';
import {
  GuestWorktreeIo,
  parseFindEntries,
  parseStatOutput,
  type GuestExecResult,
  type GuestWorktreeChannel,
} from './guest-worktree-io.js';
import { WorktreeGitError } from '../worktree-io.js';

interface ExecCall {
  command: string;
  cwd: string;
  timeoutMs: number;
}

function makeChannel(
  exec: (command: string) => GuestExecResult = () => ({ stdout: '', stderr: '', exitCode: 0 }),
): {
  channel: GuestWorktreeChannel;
  execCalls: ExecCall[];
  reads: string[];
  writes: Array<{ path: string; contents: Buffer }>;
  downloads: Array<{ path: string; destHostPath: string }>;
} {
  const execCalls: ExecCall[] = [];
  const reads: string[] = [];
  const writes: Array<{ path: string; contents: Buffer }> = [];
  const downloads: Array<{ path: string; destHostPath: string }> = [];
  return {
    execCalls,
    reads,
    writes,
    downloads,
    channel: {
      exec: async (command, opts) => {
        execCalls.push({ command, ...opts });
        return exec(command);
      },
      readFile: async (guestPath) => {
        reads.push(guestPath);
        return Buffer.from('contents');
      },
      writeFile: async (guestPath, contents) => {
        writes.push({ path: guestPath, contents });
      },
      downloadFile: async (guestPath, destHostPath) => {
        downloads.push({ path: guestPath, destHostPath });
      },
    },
  };
}

function makeIo(exec?: (command: string) => GuestExecResult) {
  const harness = makeChannel(exec);
  return { ...harness, io: new GuestWorktreeIo(harness.channel, '/workspace') };
}

describe('GuestWorktreeIo sharing', () => {
  it('reports env-owned and refuses to hand out a host path', () => {
    const { io } = makeIo();
    expect(io.sharing).toBe('env-owned');
    expect(io.hostPath).toBeNull();
  });
});

describe('GuestWorktreeIo.git', () => {
  it('runs git in the guest at a worktree-relative cwd', async () => {
    const { io, execCalls } = makeIo(() => ({
      stdout: ' M server/index.ts\n',
      stderr: '',
      exitCode: 0,
    }));
    const result = await io.git(['status', '--porcelain'], { cwd: 'server' });
    expect(result.stdout).toBe(' M server/index.ts\n');
    expect(execCalls[0]?.command).toBe(`git 'status' '--porcelain'`);
    // Relative, because SessionEnv.spawn resolves cwd against the worktree.
    expect(execCalls[0]?.cwd).toBe('server');
  });

  it('defaults to the worktree root', async () => {
    const { io, execCalls } = makeIo();
    await io.git(['rev-parse', 'HEAD']);
    expect(execCalls[0]?.cwd).toBe('');
  });

  it('quotes arguments so refspecs and messages survive the shell', async () => {
    const { io, execCalls } = makeIo();
    await io.git(['commit', '-m', "it's a 'quoted' message"]);
    expect(execCalls[0]?.command).toBe(`git 'commit' '-m' 'it'\\''s a '\\''quoted'\\'' message'`);
  });

  it('passes env as shell assignments scoped to the git process', async () => {
    const { io, execCalls } = makeIo();
    await io.git(['status'], { env: { GIT_AUTHOR_NAME: 'A B' } });
    expect(execCalls[0]?.command).toBe(`GIT_AUTHOR_NAME='A B' git 'status'`);
  });

  it('returns a non-zero exit rather than throwing, so probes can read it', async () => {
    const { io } = makeIo(() => ({ stdout: '', stderr: '', exitCode: 1 }));
    // `git diff --quiet` answers with exit 1; that is a result, not a failure.
    await expect(io.git(['diff', '--quiet'])).resolves.toMatchObject({ exitCode: 1 });
  });

  it('throws on non-zero only when asked', async () => {
    const { io } = makeIo(() => ({ stdout: '', stderr: 'fatal: bad revision', exitCode: 128 }));
    await expect(io.git(['rev-parse', 'nope'], { throwOnNonZero: true })).rejects.toThrow(
      WorktreeGitError,
    );
  });

  it('rejects a cwd that escapes the worktree', async () => {
    const { io } = makeIo();
    await expect(io.git(['status'], { cwd: '../../etc' })).rejects.toThrow(/escapes the worktree/);
  });
});

describe('GuestWorktreeIo file ops', () => {
  it('resolves relative paths against the guest worktree root', async () => {
    const { io, reads, writes } = makeIo();
    await io.readFile('server/index.ts');
    await io.writeFile('a/b.txt', 'hi');
    expect(reads).toEqual(['/workspace/server/index.ts']);
    expect(writes[0]?.path).toBe('/workspace/a/b.txt');
    expect(writes[0]?.contents.toString('utf8')).toBe('hi');
  });

  it('rejects absolute paths instead of reinterpreting them', async () => {
    const { io } = makeIo();
    // Under env-owned sharing a host path is a different tree entirely, so
    // silently accepting one would read the wrong machine.
    await expect(io.readFile('/etc/passwd')).rejects.toThrow(/must be relative/);
  });

  it('rejects traversal out of the worktree', async () => {
    const { io } = makeIo();
    await expect(io.readFile('../../etc/passwd')).rejects.toThrow(/escapes the worktree/);
  });
});

describe('GuestWorktreeIo.listDir', () => {
  it('parses the NUL-delimited find stream', async () => {
    const { io, execCalls } = makeIo(() => ({
      stdout: 'f\0index.ts\0d\0src\0l\0link\0',
      stderr: '',
      exitCode: 0,
    }));
    await expect(io.listDir('server')).resolves.toEqual([
      { name: 'index.ts', kind: 'file' },
      { name: 'src', kind: 'directory' },
      { name: 'link', kind: 'symlink' },
    ]);
    expect(execCalls[0]?.command).toContain(`find 'server' -maxdepth 1`);
  });

  it('throws with the guest stderr when find fails', async () => {
    const { io } = makeIo(() => ({ stdout: '', stderr: 'No such file', exitCode: 1 }));
    await expect(io.listDir('nope')).rejects.toThrow(/No such file/);
  });
});

describe('parseFindEntries', () => {
  it('survives names containing newlines', () => {
    expect(parseFindEntries('f\0we\nird.txt\0')).toEqual([{ name: 'we\nird.txt', kind: 'file' }]);
  });

  it('returns nothing for an empty directory', () => {
    expect(parseFindEntries('')).toEqual([]);
  });

  it('maps unknown type letters to other', () => {
    expect(parseFindEntries('p\0fifo\0')).toEqual([{ name: 'fifo', kind: 'other' }]);
  });
});

describe('GuestWorktreeIo.stat', () => {
  it('asks stat for escape-interpreted output so the fields are NUL-delimited', async () => {
    // `-c` does not interpret backslash escapes — coreutils prints a literal
    // backslash and zero, the NUL split finds one field, and every stat in a
    // microVM session comes back unparseable. `exists` reports that as "not
    // there": a Finalize-gated project looked unconfigured to the ship gate,
    // and a live guest looked empty to the Changes pane. Only `--printf`
    // emits the real NUL the parser is written against.
    const { io, execCalls } = makeIo(() => ({
      stdout: 'regular file\x00128\x001700000000.0',
      stderr: '',
      exitCode: 0,
    }));
    await io.stat('.agent-hub/ci.yaml');

    expect(execCalls[0]?.command).toContain('--printf');
    expect(execCalls[0]?.command).not.toMatch(/stat\s+-c\b/);
  });

  it('reports a missing path as absent rather than throwing', async () => {
    const { io } = makeIo(() => ({ stdout: '', stderr: 'No such file', exitCode: 1 }));
    await expect(io.stat('nope.yaml')).resolves.toBeNull();
    await expect(io.exists('nope.yaml')).resolves.toBe(false);
  });

  it('reports a present path as existing', async () => {
    const { io } = makeIo(() => ({
      stdout: 'regular file\x005588\x001700000000.0',
      stderr: '',
      exitCode: 0,
    }));
    await expect(io.exists('.agent-hub/ci.yaml')).resolves.toBe(true);
  });
});

describe('parseStatOutput', () => {
  it('parses kind, size, and fractional mtime', () => {
    expect(parseStatOutput('regular file\x00128\x001700000000.500000000')).toEqual({
      kind: 'file',
      size: 128,
      mtimeMs: 1700000000500,
    });
  });

  it('recognises directories and symlinks', () => {
    expect(parseStatOutput('directory\x004096\x001700000000.0')?.kind).toBe('directory');
    expect(parseStatOutput('symbolic link\x007\x001700000000.0')?.kind).toBe('symlink');
  });

  it('treats an empty regular file as a file, not as missing', () => {
    expect(parseStatOutput('regular empty file\x000\x001700000000.0')).toEqual({
      kind: 'file',
      size: 0,
      mtimeMs: 1700000000000,
    });
  });

  it('returns null on unparseable output', () => {
    expect(parseStatOutput('')).toBeNull();
    expect(parseStatOutput('regular file\x00notanumber\x00also')).toBeNull();
  });
});

describe('GuestWorktreeIo.stat / exists', () => {
  it('returns null rather than throwing when stat fails', async () => {
    const { io } = makeIo(() => ({ stdout: '', stderr: 'No such file', exitCode: 1 }));
    await expect(io.stat('missing.txt')).resolves.toBeNull();
    await expect(io.exists('missing.txt')).resolves.toBe(false);
  });

  it('reports existence for a present path', async () => {
    const { io } = makeIo(() => ({
      stdout: 'regular file\x0010\x001700000000.0',
      stderr: '',
      exitCode: 0,
    }));
    await expect(io.exists('present.txt')).resolves.toBe(true);
  });
});
