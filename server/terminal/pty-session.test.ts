import { describe, expect, it, vi } from 'vitest';
import type { SessionEnv, SessionEnvPty, SessionEnvPtyOpts } from '../session-env/session-env.js';
import { PtySession, type PtySessionDeps } from './pty-session.js';
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
});
