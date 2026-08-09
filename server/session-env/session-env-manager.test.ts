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
  opts: {
    kind?: SessionEnvKind;
    idleTtlMs?: number;
    failOnMount?: boolean;
    bootSweep?: Promise<unknown>;
  } = {},
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
    ...(opts.bootSweep ? { bootSweep: opts.bootSweep } : {}),
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

  it('waits for the boot sweep before creating a container', async () => {
    // The boot GC sweep deletes every labeled session container as a leak from
    // a previous run, but the servers accept traffic before it finishes. A
    // container created inside that window gets swept, and the readiness probe
    // then polls something that no longer exists until it times out.
    let sweepDone!: () => void;
    const bootSweep = new Promise<void>((resolve) => {
      sweepDone = resolve;
    });
    const { manager, created } = makeManager({ bootSweep });

    const pending = manager.ensure('s1');
    await Promise.resolve();
    expect(created).toHaveLength(0);

    sweepDone();
    await pending;
    expect(created).toHaveLength(1);
  });

  it('still creates the env when the boot sweep fails', async () => {
    const { manager, created } = makeManager({
      bootSweep: Promise.reject(new Error('docker down')),
    });
    await manager.ensure('s1');
    expect(created).toHaveLength(1);
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

  /**
   * Replaces `dispose` with one that hangs until released, standing in for a
   * `docker rm -f` still in flight.
   */
  function holdDispose(env: FakeEnv): { release: () => void } {
    let release = () => {};
    const removal = new Promise<void>((resolve) => {
      release = resolve;
    });
    env.dispose = async () => {
      env.disposeCalls++;
      await removal;
      env.disposed = true;
    };
    return { release };
  }

  /** Lets every pending microtask and I/O callback run. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('waits for a teardown to finish before building a replacement', async () => {
    // A session's container name comes from its id, so the old container and
    // its replacement compete for one name. Building while the removal is
    // still running either fails on the name being in use or — if the removal
    // lands second — deletes the container the session just started using.
    const { manager, created } = makeManager();
    await manager.ensure('s1');
    const { release } = holdDispose(created[0]);

    const disposing = manager.dispose('s1');
    const rebuilding = manager.ensure('s1');
    await settle();
    expect(created).toHaveLength(1);

    release();
    await disposing;
    const replacement = await rebuilding;
    expect(created).toHaveLength(2);
    expect(replacement).toBe(created[1] as unknown as SessionEnv);
    expect(manager.get('s1')).toBe(created[1] as unknown as SessionEnv);
  });

  it('reports a concurrent dispose as done only once the env is gone', async () => {
    // The second caller finds no entry. Returning immediately would tell it the
    // container is gone while it is still being removed.
    const { manager, created } = makeManager();
    await manager.ensure('s1');
    const { release } = holdDispose(created[0]);

    const first = manager.dispose('s1');
    let secondSettled = false;
    const second = manager.dispose('s1').then(() => {
      secondSettled = true;
    });
    await settle();
    expect(secondSettled).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
    expect(created[0].disposeCalls).toBe(1);
  });

  it('builds a replacement even when the teardown failed', async () => {
    // The name is probably free anyway, and refusing would leave the session
    // with no environment at all.
    const { manager, created } = makeManager();
    await manager.ensure('s1');
    created[0].dispose = async () => {
      throw new Error('docker rm failed');
    };

    await manager.dispose('s1');
    expect(manager.listSessions()).toEqual([]);
    const next = await manager.ensure('s1');
    expect(created).toHaveLength(2);
    expect(next).toBe(created[1] as unknown as SessionEnv);
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
  const settle = () => new Promise((resolve) => setImmediate(resolve));

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

  it('does not deadlock when dispose runs during the boot sweep', async () => {
    let sweepDone!: () => void;
    const bootSweep = new Promise<void>((resolve) => {
      sweepDone = resolve;
    });
    const { manager } = makeManager({ bootSweep });

    const pendingEnsure = manager.ensure('s1');
    await settle();
    const pendingDispose = manager.dispose('s1');
    await settle();

    sweepDone();
    const results = await Promise.race([
      Promise.allSettled([pendingEnsure, pendingDispose]),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('deadlock')), 500),
      ),
    ]);
    expect(results).toHaveLength(2);
    expect(results[1].status).toBe('fulfilled');
  });

  it('spares an env whose boundary is started but idle', async () => {
    const { manager, created } = makeManager({ idleTtlMs: 1000 });
    await manager.ensure('s1');
    created[0].lastActivityAtMs = 0;
    created[0].live = 0;
    (created[0] as FakeEnv & { started?: boolean }).started = true;
    const original = created[0].liveProcessCount.bind(created[0]);
    created[0].liveProcessCount = () => original() + 1;

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
