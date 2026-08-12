import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  __resetSessionStartupStatusForTests,
  formatSessionStartupPromptSection,
  getSessionStartupStatus,
  normalizeSessionStartupCommands,
  runSessionStartupHooks,
  SESSION_STARTUP_STATUS_REL,
  type SessionStartupStatus,
} from './session-startup-hooks.js';
import type { SessionEnv } from './session-env.js';
import type { SessionWorktreeIo, WorktreeExecResult } from './worktree-io.js';

function makeIo(execImpl?: (cmd: string) => Promise<WorktreeExecResult>): {
  io: SessionWorktreeIo;
  writes: Array<{ path: string; body: string }>;
  execs: string[];
} {
  const writes: Array<{ path: string; body: string }> = [];
  const execs: string[] = [];
  const io: SessionWorktreeIo = {
    sharing: 'host-shared',
    hostPath: '/wt',
    git: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    exec: async (command) => {
      execs.push(command);
      if (execImpl) return execImpl(command);
      return { stdout: '', stderr: '', exitCode: 0 };
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
  return { io, writes, execs };
}

function makeEnv(io: SessionWorktreeIo): SessionEnv {
  return {
    kind: 'host',
    sessionId: 's1',
    worktreePath: '/wt',
    worktreeIo: io,
    disposed: false,
    createdAtMs: 0,
    lastActivityAtMs: 0,
    mountWorktree: async () => ({ hostPath: '/wt', envPath: '/workspace', sharing: 'host-shared' }),
    liveProcessCount: () => 0,
    hasDetachedWorkload: async () => false,
    retainAfterFailedEnsure: () => false,
    onDispose: () => () => {},
    dispose: async () => {},
    spawn: async () => {
      throw new Error('not used');
    },
    openPty: async () => {
      throw new Error('not used');
    },
    mapPortsOut: async () => [],
    unmapPorts: async () => {},
    portRouting: { mode: 'host' },
  } as unknown as SessionEnv;
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
    const { io, writes, execs } = makeIo();
    const status = await runSessionStartupHooks({
      sessionId: 's1',
      env: makeEnv(io),
      commands: [],
    });
    expect(status.status).toBe('skipped');
    expect(execs).toEqual([]);
    expect(writes).toEqual([]);
    expect(getSessionStartupStatus('s1')?.status).toBe('skipped');
  });

  it('runs commands sequentially and marks ready', async () => {
    const { io, writes, execs } = makeIo();
    const progress: string[] = [];
    const status = await runSessionStartupHooks({
      sessionId: 's1',
      env: makeEnv(io),
      commands: ['echo one', 'echo two'],
      onProgress: (u) => progress.push(u.stepStatus),
    });
    expect(status.status).toBe('ready');
    expect(status.commands.map((c) => c.status)).toEqual(['ok', 'ok']);
    expect(execs.filter((c) => c.startsWith('echo'))).toEqual(['echo one', 'echo two']);
    expect(writes.some((w) => w.path === SESSION_STARTUP_STATUS_REL)).toBe(true);
    const last = JSON.parse(writes.at(-1)!.body) as SessionStartupStatus;
    expect(last.status).toBe('ready');
    expect(progress[0]).toBe('started');
    expect(progress.at(-1)).toBe('completed');
  });

  it('fails fast and skips remaining commands', async () => {
    const { io } = makeIo(async (cmd) => {
      if (cmd === 'false') return { stdout: '', stderr: 'boom', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const progress: Array<{ stepStatus: string; detail?: string }> = [];
    const status = await runSessionStartupHooks({
      sessionId: 's1',
      env: makeEnv(io),
      commands: ['true', 'false', 'echo never'],
      onProgress: (u) => progress.push({ stepStatus: u.stepStatus, detail: u.detail }),
    });
    expect(status.status).toBe('failed');
    expect(status.commands.map((c) => c.status)).toEqual(['ok', 'failed', 'skipped']);
    expect(status.commands[1]!.detail).toContain('boom');
    expect(progress.at(-1)?.stepStatus).toBe('failed');
    expect(progress.at(-1)?.detail).toContain('$ false');
    expect(progress.at(-1)?.detail).toContain('boom');
  });

  it('aborts pending work when the signal fires before a command', async () => {
    const ac = new AbortController();
    let resolveSlow: ((r: WorktreeExecResult) => void) | null = null;
    const { io } = makeIo(async (cmd) => {
      if (cmd === 'slow') {
        return await new Promise<WorktreeExecResult>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const runP = runSessionStartupHooks({
      sessionId: 's1',
      env: makeEnv(io),
      commands: ['slow', 'after'],
      signal: ac.signal,
    });
    // Wait until the slow command is in flight, then abort.
    await vi.waitFor(() => {
      expect(getSessionStartupStatus('s1')?.commands[0]?.status).toBe('running');
    });
    ac.abort();
    resolveSlow?.({ stdout: '', stderr: '', exitCode: 0 });
    const status = await runP;
    expect(status.status).toBe('failed');
    expect(status.commands[1]!.status).toBe('skipped');
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
