import { describe, expect, it, vi } from 'vitest';
import type { SessionEnv, SessionEnvPty, SessionEnvPtyOpts } from '../session-env/session-env.js';
import { PtyHost } from './pty-host.js';
import { PtySession } from './pty-session.js';
import { FakeTerminalBuffer, type TerminalBufferFactory } from './terminal-buffer.js';

class FakePty implements SessionEnvPty {
  pid = 7;
  killed = false;
  readonly #exit = new Set<(e: { exitCode: number; signal?: number }) => void>();
  write(): void {}
  resize(): void {}
  onData(): () => void {
    return () => {};
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): () => void {
    this.#exit.add(cb);
    return () => this.#exit.delete(cb);
  }
  kill(): void {
    this.killed = true;
  }
  exit(code: number): void {
    for (const cb of this.#exit) cb({ exitCode: code });
  }
}

const fakeBufferFactory: TerminalBufferFactory = async (opts) => new FakeTerminalBuffer(opts);

function makeHost() {
  const ptys: FakePty[] = [];
  const createSession = (sessionId: string) => {
    const pty = new FakePty();
    ptys.push(pty);
    const env = {
      openPty: async (_opts?: SessionEnvPtyOpts) => pty,
    } as unknown as SessionEnv;
    return new PtySession({
      sessionId,
      env,
      createBuffer: fakeBufferFactory,
      logger: { warn: () => {} },
    });
  };
  const host = new PtyHost({ createSession: vi.fn(createSession), logger: { warn: () => {} } });
  return { host, ptys, createSession };
}

describe('PtyHost', () => {
  it('creates one session per id and reuses it', () => {
    const { host } = makeHost();
    const a = host.ensure('s1');
    const b = host.ensure('s1');
    expect(a).toBe(b);
    expect(host.size).toBe(1);
    expect(host.get('s1')).toBe(a);
    expect(host.has('s1')).toBe(true);
    expect(host.listSessionIds()).toEqual(['s1']);
  });

  it('keeps distinct sessions for distinct ids', () => {
    const { host } = makeHost();
    const a = host.ensure('s1');
    const b = host.ensure('s2');
    expect(a).not.toBe(b);
    expect(host.size).toBe(2);
  });

  it('evicts an exited session and boots a fresh one on next ensure', async () => {
    const { host, ptys } = makeHost();
    const first = host.ensure('s1');
    await first.start();
    expect(host.size).toBe(1);

    ptys[0].exit(0);
    // The exited session was evicted and disposed.
    expect(host.has('s1')).toBe(false);
    expect(first.status).toBe('disposed');

    const second = host.ensure('s1');
    expect(second).not.toBe(first);
    expect(host.size).toBe(1);
  });

  it('replaces an exited session even if it lingered in the map', async () => {
    const { host } = makeHost();
    const first = host.ensure('s1');
    // Force exit without going through the host hook path by disposing.
    first.dispose();
    const second = host.ensure('s1');
    expect(second).not.toBe(first);
  });

  it('dispose tears down one session; disposeAll clears the rest', async () => {
    const { host, ptys } = makeHost();
    const s1 = host.ensure('s1');
    const s2 = host.ensure('s2');
    await s1.start();
    await s2.start();

    host.dispose('s1');
    expect(host.has('s1')).toBe(false);
    expect(s1.status).toBe('disposed');
    expect(ptys[0].killed).toBe(true);
    expect(host.size).toBe(1);

    host.disposeAll();
    expect(host.size).toBe(0);
    expect(s2.status).toBe('disposed');
    expect(ptys[1].killed).toBe(true);

    host.dispose('missing'); // idempotent / no-op
  });

  it('attach convenience ensures the session then attaches', async () => {
    const { host } = makeHost();
    const seen: string[] = [];
    const res = await host.attach('s1', {
      id: 'v',
      cols: 80,
      rows: 24,
      onData: (d) => seen.push(d),
    });
    expect(typeof res.snapshot).toBe('string');
    expect(host.get('s1')?.viewerCount).toBe(1);
  });
});
