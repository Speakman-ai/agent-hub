import { vi, type Mock, describe, it, expect, beforeEach } from 'vitest';
import os from 'os';

// Mock child_process before importing heartbeat.js so the runClaude spawn
// path is captured rather than executing the real Claude binary.
//
// Note: heartbeat.js transitively imports `worktree.js`, which now uses
// `execFile` (promisified) for all git plumbing — so the mock must export
// `execFile` and `exec` too, or the worktree module fails at import time
// with "No 'execFile' export is defined on the 'child_process' mock".
// This test never exercises the worktree path (it stubs runClaude's spawn
// and the cwd/runClaude path goes around getOrCreateProcessWorktree), so
// these stubs only need to satisfy the import — they're never invoked.
vi.mock('child_process', () => {
  const mockSpawn = vi.fn();
  const noopExec = vi.fn(
    (
      _file: unknown,
      _args: unknown,
      _opts: unknown,
      cb: (err: Error | null, value: { stdout: string; stderr: string }) => void,
    ) => {
      if (typeof cb === 'function') cb(null, { stdout: '', stderr: '' });
    },
  );
  return { spawn: mockSpawn, execFile: noopExec, exec: noopExec };
});

const { spawn } = await import('child_process');
const { runClaude } = await import('./heartbeat.js');

const spawnMock = spawn as Mock;

interface MockProc {
  stdout: { on: Mock };
  stderr: { on: Mock };
  on: Mock;
  kill: Mock;
}

function setupSpawnSuccess(stdout: string): void {
  spawnMock.mockImplementation((): MockProc => {
    const proc: MockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    };
    setTimeout(() => {
      const dataCb = proc.stdout.on.mock.calls.find((c: unknown[]) => c[0] === 'data')?.[1] as
        | ((buf: Buffer) => void)
        | undefined;
      if (dataCb) dataCb(Buffer.from(stdout));
      const closeCb = proc.on.mock.calls.find((c: unknown[]) => c[0] === 'close')?.[1] as
        | ((code: number) => void)
        | undefined;
      if (closeCb) closeCb(0);
    }, 1);
    return proc;
  });
}

const tmp = os.tmpdir();

beforeEach(() => {
  spawnMock.mockReset();
});

describe('runClaude — model option', () => {
  it('appends --model <id> when options.model is set', async () => {
    setupSpawnSuccess('ok');
    await runClaude('hello', tmp, undefined, { model: 'claude-opus-4-8' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('claude-opus-4-8');
    // Prompt must remain the final positional arg so the CLI parses it as the
    // user message rather than swallowing it into a flag.
    expect(args[args.length - 1]).toBe('hello');
  });

  it('omits --model when no model is provided (CLI default path)', async () => {
    setupSpawnSuccess('ok');
    await runClaude('hello', tmp, undefined, {});

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.includes('--model')).toBe(false);
  });

  it('treats whitespace-only model as unset', async () => {
    setupSpawnSuccess('ok');
    await runClaude('hello', tmp, undefined, { model: '   ' });

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.includes('--model')).toBe(false);
  });

  it('still passes --system-prompt before --model when both are set', async () => {
    setupSpawnSuccess('ok');
    await runClaude('hello', tmp, 'You are X.', { model: 'claude-haiku-4-6' });

    const args = spawnMock.mock.calls[0][1] as string[];
    const sysIdx = args.indexOf('--system-prompt');
    const modelIdx = args.indexOf('--model');
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeGreaterThan(sysIdx);
    expect(args[modelIdx + 1]).toBe('claude-haiku-4-6');
  });
});
