import { describe, expect, it, vi } from 'vitest';
import type { SessionEnv, SessionEnvPty, SessionEnvPtyOpts } from '../session-env/session-env.js';
import { PtySession, promptLineDirtyAfterWrite, type PtySessionDeps } from './pty-session.js';
import { FakeTerminalBuffer, type TerminalBufferFactory } from './terminal-buffer.js';

/** Controllable in-memory PTY — never spawns a real shell. */
class FakePty implements SessionEnvPty {
  pid = 4242;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  killSignal: string | undefined;
  readonly #data = new Set<(d: string) => void>();
  readonly #exit = new Set<(e: { exitCode: number; signal?: number }) => void>();

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  onData(cb: (d: string) => void): () => void {
    this.#data.add(cb);
    return () => this.#data.delete(cb);
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): () => void {
    this.#exit.add(cb);
    return () => this.#exit.delete(cb);
  }
  kill(signal?: string): void {
    this.killed = true;
    this.killSignal = signal;
  }

  // ── test drivers ──
  emit(data: string): void {
    for (const cb of this.#data) cb(data);
  }
  exit(exitCode: number, signal?: number): void {
    for (const cb of this.#exit) cb({ exitCode, signal });
  }
}

function fakeEnv(pty: FakePty): { env: SessionEnv; ptyOpts: SessionEnvPtyOpts[] } {
  const ptyOpts: SessionEnvPtyOpts[] = [];
  const env = {
    openPty: async (opts: SessionEnvPtyOpts = {}) => {
      ptyOpts.push(opts);
      return pty;
    },
  } as unknown as SessionEnv;
  return { env, ptyOpts };
}

const fakeBufferFactory: TerminalBufferFactory = async (opts) => new FakeTerminalBuffer(opts);

function makeSession(pty: FakePty, extra: Partial<PtySessionDeps> = {}) {
  const { env, ptyOpts } = fakeEnv(pty);
  const session = new PtySession({
    sessionId: 'sess-1',
    env,
    createBuffer: fakeBufferFactory,
    logger: { warn: () => {} },
    ...extra,
  });
  return { session, ptyOpts };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('PtySession', () => {
  it('opens a login shell in the worktree on first start', async () => {
    const pty = new FakePty();
    const { session, ptyOpts } = makeSession(pty, {
      shell: '/bin/bash',
      cwd: 'sub/dir',
      shellEnv: { FOO: 'bar' },
    });
    await session.start();
    expect(session.isRunning).toBe(true);
    expect(session.pid).toBe(4242);
    expect(ptyOpts).toHaveLength(1);
    expect(ptyOpts[0]).toMatchObject({
      command: '/bin/bash',
      args: ['-l'],
      cwd: 'sub/dir',
      env: { FOO: 'bar' },
    });
  });

  it('start is idempotent and concurrency-safe (one PTY for racing callers)', async () => {
    const pty = new FakePty();
    const { session, ptyOpts } = makeSession(pty);
    await Promise.all([session.start(), session.start()]);
    await session.start();
    expect(ptyOpts).toHaveLength(1);
  });

  it('attach returns a snapshot of prior output, then SIGWINCHes for redraw', async () => {
    const pty = new FakePty();
    const { session } = makeSession(pty);
    await session.start();

    // Output produced before any viewer connects is retained in scrollback.
    pty.emit('$ echo hi\r\nhi\r\n');

    const live: string[] = [];
    const { snapshot } = await session.attach({
      id: 'tab-1',
      cols: 100,
      rows: 30,
      onData: (d) => live.push(d),
    });

    expect(snapshot).toBe('$ echo hi\r\nhi\r\n');
    // Snapshot is replay only — the live sink got nothing yet.
    expect(live).toEqual([]);
    // Redraw nudge: bounce a row and settle on the effective size.
    expect(pty.resizes.at(-1)).toEqual([100, 30]);
    expect(pty.resizes.length).toBeGreaterThanOrEqual(2);

    // Output after attach streams live to the viewer.
    pty.emit('next\r\n');
    expect(live).toEqual(['next\r\n']);
  });

  it('fans out live output to every attached viewer', async () => {
    const pty = new FakePty();
    const { session } = makeSession(pty);
    const a: string[] = [];
    const b: string[] = [];
    await session.attach({ id: 'a', cols: 80, rows: 24, onData: (d) => a.push(d) });
    await session.attach({ id: 'b', cols: 80, rows: 24, onData: (d) => b.push(d) });
    pty.emit('shared\r\n');
    expect(a).toEqual(['shared\r\n']);
    expect(b).toEqual(['shared\r\n']);
  });

  it('arbitrates winsize to the smallest viewer and back up on detach', async () => {
    const pty = new FakePty();
    const { session } = makeSession(pty);
    await session.attach({ id: 'big', cols: 200, rows: 50, onData: () => {} });
    const small = await session.attach({ id: 'small', cols: 80, rows: 24, onData: () => {} });
    // Effective size clamps to the smallest viewer.
    expect(pty.resizes.at(-1)).toEqual([80, 24]);

    small.detach();
    // Smallest viewer gone → PTY grows back to the remaining viewer.
    expect(pty.resizes.at(-1)).toEqual([200, 50]);
    // The shell is still alive — detach does not kill it.
    expect(pty.killed).toBe(false);
    expect(session.isRunning).toBe(true);
  });

  it('an explicit resize re-arbitrates the winsize', async () => {
    const pty = new FakePty();
    const { session } = makeSession(pty);
    await session.attach({ id: 'v', cols: 100, rows: 30, onData: () => {} });
    pty.resizes.length = 0;
    session.resize('v', 120, 40);
    expect(pty.resizes.at(-1)).toEqual([120, 40]);
    // Unknown viewer id is ignored.
    session.resize('ghost', 5, 5);
    expect(pty.resizes.at(-1)).toEqual([120, 40]);
  });

  it('funnels all input through the single writer queue in order', async () => {
    const pty = new FakePty();
    const { session } = makeSession(pty);
    await session.start();
    session.write('git status\n');
    session.write('npm test\n');
    await flush();
    expect(pty.writes).toEqual(['git status\n', 'npm test\n']);
  });

  it('the PTY outlives all clients (write still works with zero viewers)', async () => {
    const pty = new FakePty();
    const { session } = makeSession(pty);
    const v = await session.attach({ id: 'only', cols: 80, rows: 24, onData: () => {} });
    v.detach();
    expect(session.viewerCount).toBe(0);
    expect(session.isRunning).toBe(true);
    expect(pty.killed).toBe(false);
    expect(session.write('still alive\n')).toBe(true);
    await flush();
    expect(pty.writes).toEqual(['still alive\n']);
  });

  it('fires exit hooks, stops accepting writes, and reports the exit result', async () => {
    const pty = new FakePty();
    const { session } = makeSession(pty);
    await session.start();
    const exits: Array<{ exitCode: number; signal?: number }> = [];
    session.onExit((e) => exits.push(e));

    pty.exit(0, 15);
    expect(exits).toEqual([{ exitCode: 0, signal: 15 }]);
    expect(session.status).toBe('exited');
    expect(session.exitResult).toEqual({ exitCode: 0, signal: 15 });
    expect(session.write('too late\n')).toBe(false);

    // A hook added after exit fires immediately.
    const late: number[] = [];
    session.onExit((e) => late.push(e.exitCode));
    expect(late).toEqual([0]);
  });

  it('dispose kills the shell and rejects further work', async () => {
    const pty = new FakePty();
    const { session } = makeSession(pty);
    await session.start();
    session.dispose();
    expect(session.status).toBe('disposed');
    expect(pty.killed).toBe(true);
    expect(session.write('nope\n')).toBe(false);
    await expect(session.attach({ id: 'x', cols: 80, rows: 24, onData: () => {} })).rejects.toThrow(
      /disposed/,
    );
    session.dispose(); // idempotent
  });

  it('a viewer callback that throws does not break fan-out to others', async () => {
    const pty = new FakePty();
    const warn = vi.fn();
    const { session } = makeSession(pty, { logger: { warn } });
    const ok: string[] = [];
    await session.attach({
      id: 'bad',
      cols: 80,
      rows: 24,
      onData: () => {
        throw new Error('render blew up');
      },
    });
    await session.attach({ id: 'good', cols: 80, rows: 24, onData: (d) => ok.push(d) });
    pty.emit('data\r\n');
    expect(ok).toEqual(['data\r\n']);
    expect(warn).toHaveBeenCalled();
  });

  describe('agent turn-taking primitives', () => {
    it('lastOutputAt seeds at shell start and advances on every output', async () => {
      const pty = new FakePty();
      let clock = 1000;
      const { session } = makeSession(pty, { now: () => clock });
      await session.start();
      // Seeded at start so a just-booted shell is not treated as long-idle.
      expect(session.lastOutputAt).toBe(1000);
      clock = 1500;
      pty.emit('prompt$ ');
      expect(session.lastOutputAt).toBe(1500);
    });

    it('inputQueueIdle is false before start and true on a quiet running shell', async () => {
      const pty = new FakePty();
      const { session } = makeSession(pty);
      expect(session.inputQueueIdle).toBe(false);
      await session.start();
      expect(session.inputQueueIdle).toBe(true);
    });

    it('inputQueueIdle is false after exit', async () => {
      const pty = new FakePty();
      const { session } = makeSession(pty);
      await session.start();
      pty.exit(0);
      expect(session.inputQueueIdle).toBe(false);
    });

    it('readSnapshot flushes + serializes scrollback without registering a viewer', async () => {
      const pty = new FakePty();
      const { session } = makeSession(pty);
      await session.start();
      pty.emit('line-1\r\nline-2\r\n');
      const snap = await session.readSnapshot();
      expect(snap).toBe('line-1\r\nline-2\r\n');
      // Pure read — no viewer registered, so no SIGWINCH redraw was issued.
      expect(session.viewerCount).toBe(0);
      expect(pty.resizes).toEqual([]);
    });

    it('readSnapshot returns null before the shell has started', async () => {
      const pty = new FakePty();
      const { session } = makeSession(pty);
      expect(await session.readSnapshot()).toBeNull();
    });

    it('write routes one injected line through the shared queue', async () => {
      const pty = new FakePty();
      const { session } = makeSession(pty);
      await session.start();
      expect(session.write('npm test\n')).toBe(true);
      await flush();
      expect(pty.writes).toEqual(['npm test\n']);
    });

    it('promptLineDirty tracks un-submitted input across writes', async () => {
      const pty = new FakePty();
      const { session } = makeSession(pty);
      await session.start();
      // Fresh prompt is clean.
      expect(session.promptLineDirty).toBe(false);
      // Human types a partial command (no Enter) → dirty.
      session.write('rm -rf ');
      expect(session.promptLineDirty).toBe(true);
      // Pressing Enter submits the line → clean again.
      session.write('\r');
      expect(session.promptLineDirty).toBe(false);
      // Type again, then Ctrl-U (kill line) clears it → clean.
      session.write('half');
      expect(session.promptLineDirty).toBe(true);
      session.write('\x15');
      expect(session.promptLineDirty).toBe(false);
    });

    it('promptLineDirty is false for a non-running shell', () => {
      const pty = new FakePty();
      const { session } = makeSession(pty);
      expect(session.promptLineDirty).toBe(false);
    });

    it('a write to a non-running shell is refused and leaves promptLineDirty untouched', async () => {
      // A write the PTY never receives must not flip turn-taking state. On a
      // non-running shell write() returns false before touching the flag.
      const pty = new FakePty();
      const { session } = makeSession(pty);
      await session.start();
      pty.exit(0); // exited → queue closed
      expect(session.write('\n')).toBe(false); // refused, PTY never receives it
      expect(session.promptLineDirty).toBe(false);
    });
  });

  describe('injectAtIdle (atomic turn-taking reservation)', () => {
    const opts = { now: 10_000, quietWindowMs: 750 };

    it('enqueues the line in one step when the prompt is idle', async () => {
      const pty = new FakePty();
      // Non-zero start stamp so lastOutputAt isn't the "never output" sentinel.
      let clock = 1_000;
      const { session } = makeSession(pty, { now: () => clock });
      await session.start(); // lastOutputAt := 1_000
      clock = 10_000; // 9s of quiet ≫ window
      const res = session.injectAtIdle('npm test\n', opts);
      expect(res).toEqual({ ok: true });
      await flush();
      expect(pty.writes).toEqual(['npm test\n']);
      // The inject's trailing newline leaves the line clean.
      expect(session.promptLineDirty).toBe(false);
    });

    it('defers (enqueues nothing) when the prompt line is dirty', async () => {
      const pty = new FakePty();
      let clock = 1_000;
      const { session } = makeSession(pty, { now: () => clock });
      await session.start();
      clock = 10_000;
      session.write('half-typed'); // human mid-command, dirty
      const res = session.injectAtIdle('ls\n', opts);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.deferred).toBe(true);
      await flush();
      expect(pty.writes).toEqual(['half-typed']); // only the human input
    });

    it('defers while the shell is inside the output-quiet window', async () => {
      const pty = new FakePty();
      const { session } = makeSession(pty, { now: () => 1_000 });
      await session.start(); // lastOutputAt := 1_000
      // Evaluate the gate only 100ms later — inside the 750ms quiet window.
      const res = session.injectAtIdle('ls\n', { now: 1_100, quietWindowMs: 750 });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.deferred).toBe(true);
      expect(pty.writes).toEqual([]);
    });

    it('defers (never phantom-writes) when the shell is not running', () => {
      const pty = new FakePty();
      const { session } = makeSession(pty); // never started
      const res = session.injectAtIdle('ls\n', opts);
      expect(res.ok).toBe(false);
      // Not running → gate returns not-idle (deferred), never a phantom write.
      if (!res.ok) expect(res.deferred).toBe(true);
      expect(pty.writes).toEqual([]);
    });
  });
});

describe('promptLineDirtyAfterWrite', () => {
  it('newline / carriage-return submit the line (clean)', () => {
    expect(promptLineDirtyAfterWrite(true, '\n')).toBe(false);
    expect(promptLineDirtyAfterWrite(true, '\r')).toBe(false);
  });

  it('Ctrl-C and Ctrl-U abort/kill the line (clean)', () => {
    expect(promptLineDirtyAfterWrite(true, '\x03')).toBe(false);
    expect(promptLineDirtyAfterWrite(true, '\x15')).toBe(false);
  });

  it('printable input makes the line dirty', () => {
    expect(promptLineDirtyAfterWrite(false, 'l')).toBe(true);
    expect(promptLineDirtyAfterWrite(false, 'echo hi')).toBe(true);
  });

  it('an agent inject (command + trailing newline) ends clean', () => {
    expect(promptLineDirtyAfterWrite(false, 'npm test\n')).toBe(false);
  });

  it('trailing chars after a newline are uncommitted (dirty)', () => {
    // e.g. a submitted line followed by the start of the next command.
    expect(promptLineDirtyAfterWrite(false, 'ls\rrm')).toBe(true);
  });
});
