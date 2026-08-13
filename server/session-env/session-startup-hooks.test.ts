import { describe, expect, it, vi, beforeEach } from 'vitest';
import { homedir } from 'os';
import path from 'path';
import {
  __resetSessionStartupStatusForTests,
  formatSessionStartupProgressDetail,
  formatSessionStartupPromptSection,
  getSessionStartupStatus,
  normalizeSessionStartupCommands,
  runSessionStartupHooks,
  SESSION_STARTUP_STATUS_GUEST_ABS,
  SESSION_STARTUP_STATUS_REL,
  type SessionStartupStatus,
} from './session-startup-hooks.js';
import type { SessionEnv, SessionEnvExit, SessionEnvProcess } from './session-env.js';
import type { SessionWorktreeIo } from './worktree-io.js';

function makeIo(): {
  io: SessionWorktreeIo;
  writes: Array<{ path: string; body: string }>;
} {
  const writes: Array<{ path: string; body: string }> = [];
  const io: SessionWorktreeIo = {
    sharing: 'host-shared',
    hostPath: '/wt',
    git: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    exec: async (command) => {
      // Status-file persist uses mkdir + base64 decode to an absolute path.
      const m = command.match(/base64 -d > '([^']+)'/);
      if (m?.[1]) {
        const b64 = command.match(/printf '%s' '([^']*)'/)?.[1] ?? '';
        writes.push({ path: m[1], body: Buffer.from(b64, 'base64').toString('utf8') });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command.startsWith('mkdir ')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error('session startup must use SessionEnv.spawn, not worktreeIo.exec');
    },
    readFile: async () => Buffer.from(''),
    writeFile: async (relPath, contents) => {
      writes.push({
        path: relPath,
        body: typeof contents === 'string' ? contents : contents.toString('utf8'),
      });
    },
    downloadFile: async () => {},
    listDir: async () => [],
    stat: async () => null,
    exists: async () => false,
  };
  return { io, writes };
}

function makeSpawnProc(result: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
  hangUntilKill?: boolean;
}): SessionEnvProcess & { killed: boolean } {
  let resolveExit: ((e: SessionEnvExit) => void) | null = null;
  const exitWaiters: Array<(e: SessionEnvExit) => void> = [];
  const settle = (e: SessionEnvExit) => {
    for (const cb of exitWaiters) cb(e);
    resolveExit?.(e);
  };
  const proc = {
    pid: 1,
    name: 'test',
    exited: false,
    exitResult: null as SessionEnvExit | null,
    killed: false,
    onStdout(cb: (chunk: string) => void) {
      if (result.stdout) queueMicrotask(() => cb(result.stdout!));
      return () => {};
    },
    onStderr(cb: (chunk: string) => void) {
      if (result.stderr) queueMicrotask(() => cb(result.stderr!));
      return () => {};
    },
    onExit(cb: (e: SessionEnvExit) => void) {
      exitWaiters.push(cb);
      if (!result.hangUntilKill) {
        queueMicrotask(() => {
          const e = { code: result.exitCode, signal: null };
          proc.exited = true;
          proc.exitResult = e;
          settle(e);
        });
      } else {
        resolveExit = (e) => {
          proc.exited = true;
          proc.exitResult = e;
          cb(e);
        };
      }
      return () => {};
    },
    kill() {
      proc.killed = true;
      if (result.hangUntilKill) {
        settle({ code: null, signal: 'SIGKILL' });
      }
    },
  };
  return proc;
}

function makeEnv(
  io: SessionWorktreeIo,
  spawnImpl?: (command: string, opts: { cwd?: string }) => SessionEnvProcess,
): SessionEnv & {
  spawnCalls: Array<{ command: string; cwd?: string }>;
} {
  const spawnCalls: Array<{ command: string; cwd?: string }> = [];
  const env = {
    kind: 'host' as const,
    sessionId: 's1',
    worktreePath: '/wt',
    worktreeIo: io,
    disposed: false,
    createdAtMs: 0,
    lastActivityAtMs: 0,
    spawnCalls,
    mountWorktree: async () => ({
      hostPath: '/wt',
      envPath: '/workspace',
      sharing: 'host-shared' as const,
    }),
    liveProcessCount: () => 0,
    hasDetachedWorkload: async () => false,
    retainAfterFailedEnsure: () => false,
    onDispose: () => () => {},
    dispose: async () => {},
    spawn: (command: string, opts: { cwd?: string } = {}) => {
      spawnCalls.push({ command, cwd: opts.cwd });
      if (spawnImpl) return spawnImpl(command, opts);
      return makeSpawnProc({ exitCode: 0 });
    },
    openPty: async () => {
      throw new Error('not used');
    },
    mapPortsOut: async () => [],
    unmapPorts: async () => {},
    portRouting: { mode: 'host' as const },
  };
  return env as unknown as SessionEnv & {
    spawnCalls: Array<{ command: string; cwd?: string }>;
  };
}

beforeEach(() => {
  __resetSessionStartupStatusForTests();
});

describe('normalizeSessionStartupCommands', () => {
  it('trims and drops empties', () => {
    expect(normalizeSessionStartupCommands(['  a  ', '', 'b', 3])).toEqual(['a', 'b']);
  });
});

describe('runSessionStartupHooks', () => {
  it('is a no-op skipped status for an empty command list', async () => {
    const { io, writes } = makeIo();
    const env = makeEnv(io);
    const status = await runSessionStartupHooks({
      sessionId: 's1',
      env,
      commands: [],
    });
    expect(status.status).toBe('skipped');
    expect(env.spawnCalls).toEqual([]);
    expect(writes).toEqual([]);
    expect(getSessionStartupStatus('s1')?.status).toBe('skipped');
  });

  it('runs commands via SessionEnv.spawn at the session worktree root', async () => {
    const { io, writes } = makeIo();
    const progress: string[] = [];
    const env = makeEnv(io);
    const status = await runSessionStartupHooks({
      sessionId: 's1',
      env,
      commands: ['echo one', 'echo two'],
      onProgress: (u) => progress.push(u.stepStatus),
    });
    expect(status.status).toBe('ready');
    expect(status.commands.map((c) => c.status)).toEqual(['ok', 'ok']);
    expect(env.spawnCalls.map((c) => c.command)).toEqual([
      "bash -c 'echo one'",
      "bash -c 'echo two'",
    ]);
    expect(env.spawnCalls.every((c) => c.cwd === '.')).toBe(true);
    const expectedPath = path.join(homedir(), '.agent-hub-runtime', 'session-startup', 's1.json');
    expect(status.statusPath).toBe(expectedPath);
    expect(writes.some((w) => w.path === expectedPath)).toBe(true);
    expect(
      writes.every((w) => !w.path.includes('/workspace/') && w.path !== SESSION_STARTUP_STATUS_REL),
    ).toBe(true);
    const last = JSON.parse(writes.at(-1)!.body) as SessionStartupStatus;
    expect(last.status).toBe('ready');
    expect(progress[0]).toBe('started');
    expect(progress.at(-1)).toBe('completed');
  });

  it('wraps commands in bash -c so source and other bashisms work', async () => {
    const { io } = makeIo();
    const env = makeEnv(io, (cmd) => {
      expect(cmd.startsWith('bash -c ')).toBe(true);
      expect(cmd).toContain('source .venv/bin/activate');
      return makeSpawnProc({ exitCode: 0 });
    });
    const status = await runSessionStartupHooks({
      sessionId: 's1',
      env,
      commands: ['source .venv/bin/activate'],
    });
    expect(status.status).toBe('ready');
    expect(env.spawnCalls[0]?.command).toBe("bash -c 'source .venv/bin/activate'");
  });

  it('fails fast and skips remaining commands', async () => {
    const { io } = makeIo();
    const progress: Array<{ stepStatus: string; detail?: string }> = [];
    const env = makeEnv(io, (cmd) => {
      if (cmd.includes("'false'"))
        return makeSpawnProc({ stdout: '', stderr: 'boom', exitCode: 1 });
      return makeSpawnProc({ exitCode: 0 });
    });
    const status = await runSessionStartupHooks({
      sessionId: 's1',
      env,
      commands: ['true', 'false', 'echo never'],
      onProgress: (u) => progress.push({ stepStatus: u.stepStatus, detail: u.detail }),
    });
    expect(status.status).toBe('failed');
    expect(status.commands.map((c) => c.status)).toEqual(['ok', 'failed', 'skipped']);
    expect(status.commands[1]!.detail).toContain('boom');
    expect(progress.at(-1)?.stepStatus).toBe('failed');
    // Progress/WS detail must not leak the command line or log tail.
    expect(progress.at(-1)?.detail).toBe('Session setup command failed (exit 1)');
    expect(progress.at(-1)?.detail).not.toContain('false');
    expect(progress.at(-1)?.detail).not.toContain('boom');
    expect(env.spawnCalls.map((c) => c.command)).toEqual(["bash -c 'true'", "bash -c 'false'"]);
  });

  it('aborts pending work when the signal fires before a command', async () => {
    const ac = new AbortController();
    const { io } = makeIo();
    const holder: { proc: ReturnType<typeof makeSpawnProc> | null } = { proc: null };
    const env = makeEnv(io, (cmd) => {
      if (cmd.includes("'slow'")) {
        holder.proc = makeSpawnProc({ exitCode: 0, hangUntilKill: true });
        return holder.proc;
      }
      return makeSpawnProc({ exitCode: 0 });
    });
    const runP = runSessionStartupHooks({
      sessionId: 's1',
      env,
      commands: ['slow', 'after'],
      signal: ac.signal,
    });
    await vi.waitFor(() => {
      expect(getSessionStartupStatus('s1')?.commands[0]?.status).toBe('running');
    });
    ac.abort();
    const status = await runP;
    expect(status.status).toBe('failed');
    expect(status.commands[1]!.status).toBe('skipped');
    expect(holder.proc?.killed).toBe(true);
  });
});

describe('formatSessionStartupProgressDetail', () => {
  it('redacts command and output by default', () => {
    const status: SessionStartupStatus = {
      status: 'failed',
      startedAt: 1,
      finishedAt: 2,
      bootId: 'x',
      statusPath: SESSION_STARTUP_STATUS_GUEST_ABS,
      commands: [{ cmd: 'secret-cmd', status: 'failed', exitCode: 7, detail: 'secret-out' }],
    };
    expect(formatSessionStartupProgressDetail(status)).toBe(
      'Session setup command failed (exit 7)',
    );
    expect(formatSessionStartupProgressDetail(status, { redact: false })).toContain('secret-cmd');
  });
});

describe('formatSessionStartupPromptSection', () => {
  it('returns empty when nothing is configured', () => {
    expect(formatSessionStartupPromptSection(null)).toBe('');
  });

  it('describes a pending unconfigured-null when commands are configured', () => {
    const text = formatSessionStartupPromptSection(null, { commandsConfigured: true });
    expect(text).toContain('Session Startup Setup');
    expect(text).toContain('pending');
    expect(text).toContain(SESSION_STARTUP_STATUS_GUEST_ABS);
  });

  it('includes ready guidance', () => {
    const text = formatSessionStartupPromptSection({
      status: 'ready',
      startedAt: 1,
      finishedAt: 2,
      bootId: 'abcdef12-xxxx',
      statusPath: SESSION_STARTUP_STATUS_REL,
      commands: [{ cmd: 'echo hi', status: 'ok', exitCode: 0, detail: null }],
    });
    expect(text).toContain('completed');
    expect(text).toContain('echo hi');
  });
});
