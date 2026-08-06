import { describe, expect, it } from 'vitest';
import { SessionEnvManager } from './session-env-manager.js';
import type { SessionEnv, SessionEnvKind } from './session-env.js';

/** Minimal SessionEnv double — only the manager-facing surface is exercised. */
class FakeEnv {
  readonly createdAtMs = 0;
  lastActivityAtMs = 0;
  disposed = false;
  mountCalls = 0;
  disposeCalls = 0;
  live = 0;
  private readonly hooks = new Set<() => void>();

  constructor(
    readonly kind: SessionEnvKind,
    readonly sessionId: string,
    readonly worktreePath: string,
  ) {}

  async mountWorktree() {
    this.mountCalls++;
    return { hostPath: this.worktreePath, envPath: '/workspace' };
  }
  liveProcessCount() {
    return this.live;
  }
  onDispose(cb: () => void) {
    this.hooks.add(cb);
    return () => this.hooks.delete(cb);
  }
  async dispose() {
    this.disposeCalls++;
    this.disposed = true;
    for (const h of this.hooks) h();
  }
}

interface Harness {
  manager: SessionEnvManager;
  created: FakeEnv[];
  setWorktree: (sessionId: string, path: string | null) => void;
}

function makeManager(
  opts: { kind?: SessionEnvKind; idleTtlMs?: number; failOnMount?: boolean } = {},
): Harness {
  const created: FakeEnv[] = [];
  const worktrees = new Map<string, string | null>([['s1', '/wt/s1']]);
  const manager = new SessionEnvManager({
    resolveWorktree: (id) => worktrees.get(id) ?? null,
    resolveAdapter: () => opts.kind ?? 'container',
    createEnv: (kind, o) => {
      const env = new FakeEnv(kind, o.sessionId, o.worktreePath);
      if (opts.failOnMount) {
        env.mountWorktree = async () => {
          throw new Error('container failed to start');
        };
      }
      created.push(env);
      return env as unknown as SessionEnv;
    },
    ...(opts.idleTtlMs !== undefined ? { idleTtlMs: opts.idleTtlMs } : {}),
    logger: { log: () => {}, warn: () => {} },
  });
  return { manager, created, setWorktree: (id, p) => worktrees.set(id, p) };
}

describe('SessionEnvManager.ensure', () => {
  it('creates one env per session and mounts the worktree', async () => {
    const { manager, created } = makeManager();
    const env = await manager.ensure('s1');

    expect(created).toHaveLength(1);
    expect(created[0].worktreePath).toBe('/wt/s1');
    expect(created[0].mountCalls).toBe(1);
    expect(manager.get('s1')).toBe(env);
  });

  it('returns the same env to repeat callers', async () => {
    // The preview and the terminal must land in one boundary; two envs would
    // mean the shell cannot reach the dev server it is looking at.
    const { manager, created } = makeManager();
    const a = await manager.ensure('s1');
    const b = await manager.ensure('s1');

    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it('collapses concurrent callers into a single environment', async () => {
    // Starting a container takes seconds. A preview and a terminal opened in
    // that window must not each start one.
    const { manager, created } = makeManager();
    const [a, b, c] = await Promise.all([
      manager.ensure('s1'),
      manager.ensure('s1'),
      manager.ensure('s1'),
    ]);

    expect(created).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('refuses a session whose workspace is not provisioned', async () => {
    const { manager } = makeManager();
    await expect(manager.ensure('never-provisioned')).rejects.toThrow(/no workspace yet/i);
  });

  it('allows a retry after a failed start', async () => {
    // A wedged entry would make every later attempt fail with the original
    // error, long after the transient cause is gone.
    const { manager } = makeManager({ failOnMount: true });
    await expect(manager.ensure('s1')).rejects.toThrow(/failed to start/);
    expect(manager.get('s1')).toBeNull();
    await expect(manager.ensure('s1')).rejects.toThrow(/failed to start/);
  });

  it('replaces an env that was disposed out from under it', async () => {
    const { manager, created } = makeManager();
    const first = await manager.ensure('s1');
    await first.dispose();

    const second = await manager.ensure('s1');
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });
});

describe('SessionEnvManager teardown', () => {
  it('disposes the env and forgets the session', async () => {
    const { manager, created } = makeManager();
    await manager.ensure('s1');
    await manager.dispose('s1');

    expect(created[0].disposeCalls).toBe(1);
    expect(manager.get('s1')).toBeNull();
    expect(manager.listSessions()).toEqual([]);
  });

  it('is a no-op for an unknown session', async () => {
    const { manager } = makeManager();
    await expect(manager.dispose('nope')).resolves.toBeUndefined();
  });

  it('drops the entry when the env disposes itself', async () => {
    const { manager } = makeManager();
    const env = await manager.ensure('s1');
    await env.dispose();

    expect(manager.get('s1')).toBeNull();
    expect(manager.listSessions()).toEqual([]);
  });

  it('disposes every env on shutdown', async () => {
    const { manager, created, setWorktree } = makeManager();
    setWorktree('s2', '/wt/s2');
    await manager.ensure('s1');
    await manager.ensure('s2');

    await manager.disposeAll();
    expect(created.map((e) => e.disposeCalls)).toEqual([1, 1]);
    expect(manager.listSessions()).toEqual([]);
  });
});

describe('SessionEnvManager.reap', () => {
  it('disposes an idle env with nothing running', async () => {
    const { manager, created } = makeManager({ idleTtlMs: 1000 });
    await manager.ensure('s1');
    created[0].lastActivityAtMs = 0;

    await expect(manager.reap(5000)).resolves.toEqual({ scanned: 1, reaped: 1 });
    expect(created[0].disposeCalls).toBe(1);
  });

  it('spares an env that is still running something', async () => {
    // Idle by the clock is not idle in fact: a long build or a database the
    // preview depends on must not be reaped out from under the session.
    const { manager, created } = makeManager({ idleTtlMs: 1000 });
    await manager.ensure('s1');
    created[0].lastActivityAtMs = 0;
    created[0].live = 1;

    await expect(manager.reap(5000)).resolves.toEqual({ scanned: 1, reaped: 0 });
    expect(created[0].disposeCalls).toBe(0);
  });

  it('spares a recently active env', async () => {
    const { manager, created } = makeManager({ idleTtlMs: 1000 });
    await manager.ensure('s1');
    created[0].lastActivityAtMs = 4800;

    await expect(manager.reap(5000)).resolves.toEqual({ scanned: 1, reaped: 0 });
    expect(created[0].disposeCalls).toBe(0);
  });
});
