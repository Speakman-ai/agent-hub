import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { Writable } from 'stream';
import { endChildStdin, guardChildStdin } from './child-stdin.js';

/**
 * Regression for the 2026-09-17 prod crash loop: a pending stdin write to a
 * child that exits (or is SIGTERMed on a turn timeout) before draining its
 * prompt fails with EPIPE, which Node emits as an 'error' event on the stdin
 * socket. Unhandled, that event is an uncaught exception that exits the Hub.
 */

// Larger than the kernel pipe buffer so the write cannot complete before the
// child is gone.
const BIG_PROMPT = 'x'.repeat(600 * 1024);

/** A child that never reads stdin, like a CLI stuck on an API error. */
function spawnIdleChild(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

function waitForExit(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => proc.once('exit', () => resolve()));
}

describe('child-stdin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the scenario really produces EPIPE on stdin (control)', async () => {
    const proc = spawnIdleChild();
    const seen = new Promise<string>((resolve) => {
      proc.stdin!.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'none'));
    });
    proc.stdin!.end(BIG_PROMPT, 'utf8');
    proc.kill('SIGTERM');
    await waitForExit(proc);
    expect(await seen).toBe('EPIPE');
  });

  it('endChildStdin absorbs the broken pipe when the child is killed mid-write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proc = spawnIdleChild();
    // Without the guard this test process would die with an unhandled
    // 'error' event exactly like the Hub did.
    expect(endChildStdin(proc, BIG_PROMPT, 'test child')).toBe(true);
    proc.kill('SIGTERM');
    await waitForExit(proc);
    // Let the EPIPE error event (delivered on a later tick) be observed.
    await new Promise((r) => setTimeout(r, 50));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(EPIPE)'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('test child'));
  });

  it('logs unexpected stdin errors at error level without throwing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdin = new Writable({
      write(_chunk, _enc, cb) {
        cb(Object.assign(new Error('boom'), { code: 'EACCES' }));
      },
    });
    expect(() => endChildStdin({ stdin } as never, 'weird', 'fake')).not.toThrow();
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('unexpected stdin error (EACCES)'),
          'boom',
        );
        resolve();
      });
    });
  });

  it('returns false and does not throw when the child has no stdin', () => {
    expect(endChildStdin({ stdin: null } as never, 'x', 'no-stdin')).toBe(false);
    expect(() => guardChildStdin({ stdin: null } as never, 'no-stdin')).not.toThrow();
  });

  it('attaches the guard only once per stream', () => {
    const stdin = new Writable({ write: (_c, _e, cb) => cb() });
    guardChildStdin({ stdin } as never, 'a');
    guardChildStdin({ stdin } as never, 'a');
    expect(stdin.listenerCount('error')).toBe(1);
  });
});
