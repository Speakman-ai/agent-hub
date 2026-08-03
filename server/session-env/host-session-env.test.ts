import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostChildLike,
  HostPtyFactory,
  HostPtyLike,
  HostSessionEnv,
  HostSessionEnvDeps,
} from './host-session-env.js';
import { SessionEnvClock } from './session-env.js';
import { describeSessionEnvContract } from './session-env-contract.js';

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => new FakePty()),
}));

// ── Fakes ─────────────────────────────────────────────────────────

class FakeChild extends EventEmitter implements HostChildLike {
  pid: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: NodeJS.Signals[] = [];
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

interface SpawnRecord {
  command: string;
  args: readonly string[];
  options: { cwd: string; env: Record<string, string | undefined>; detached: boolean };
  child: FakeChild;
}

function makeFakeSpawn() {
  const records: SpawnRecord[] = [];
  let nextPid = 1000;
  const spawn = (
    command: string,
    args: readonly string[],
    options: SpawnRecord['options'],
  ): HostChildLike => {
    const child = new FakeChild(nextPid++);
    records.push({ command, args, options, child });
    return child;
  };
  return { spawn, records };
}

class FakeClock implements SessionEnvClock {
  private now = 1_000_000;
  private sleepers: Array<{ dueAt: number; resolve: () => void }> = [];
  nowMs(): number {
    return this.now;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({ dueAt: this.now + ms, resolve });
    });
  }
  async advance(ms: number): Promise<void> {
    this.now += ms;
    const due = this.sleepers.filter((s) => s.dueAt <= this.now);
    this.sleepers = this.sleepers.filter((s) => s.dueAt > this.now);
    for (const s of due) s.resolve();
    // Let the resolved sleeps run their continuations.
    await new Promise((r) => setTimeout(r, 0));
  }
}

class FakePty implements HostPtyLike {
  pid = 7777;
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  kills: Array<string | undefined> = [];
  private dataSubs = new Set<(d: string) => void>();
  private exitSubs = new Set<(e: { exitCode: number; signal?: number }) => void>();
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  onData(cb: (d: string) => void) {
    this.dataSubs.add(cb);
    return { dispose: () => this.dataSubs.delete(cb) };
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitSubs.add(cb);
    return { dispose: () => this.exitSubs.delete(cb) };
  }
  kill(signal?: string): void {
    this.kills.push(signal);
  }
  emitData(d: string): void {
    for (const cb of this.dataSubs) cb(d);
  }
  emitExit(exitCode: number): void {
    for (const cb of this.exitSubs) cb({ exitCode });
  }
}

interface Fixture {
  env: HostSessionEnv;
  records: SpawnRecord[];
  clock: FakeClock;
  killCalls: Array<[number, NodeJS.Signals]>;
}

function makeEnv(overrides: Partial<HostSessionEnvDeps> = {}): Fixture {
  const { spawn, records } = makeFakeSpawn();
  const clock = new FakeClock();
  const killCalls: Array<[number, NodeJS.Signals]> = [];
  const env = new HostSessionEnv({
    sessionId: 'sess-1',
    worktreePath: '/wt/session-1',
    spawn,
    clock,
    kill: (pid, signal) => {
      killCalls.push([pid, signal]);
      // Simulate process-group delivery: find the child and record it.
      const rec = records.find((r) => r.child.pid === Math.abs(pid));
      rec?.child.kill(signal);
    },
    isDirectory: async () => true,
    baseEnv: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/hub' },
    logger: { warn: () => {} },
    ...overrides,
  });
  return { env, records, clock, killCalls };
}

// ── Interface contract (adapter-agnostic suite) ───────────────────

const contractFixtures: Fixture[] = [];
// Each contract test creates one fixture; reset between tests so the
// array never accumulates across the suite.
afterEach(() => {
  contractFixtures.length = 0;
});
describeSessionEnvContract('host adapter', {
  createEnv() {
    const fixture = makeEnv();
    contractFixtures.push(fixture);
    return fixture.env;
  },
  exitProcess(env, pid, code) {
    const fixture = contractFixtures.find((f) => f.env === env);
    const rec = fixture?.records.find((r) => r.child.pid === pid);
    if (!rec) throw new Error(`no fake child with pid ${pid}`);
    rec.child.exit(code);
  },
  async advanceClock(ms) {
    // The afterEach reset above guarantees only the current test's env
    // (exactly one) is ever in the array here.
    for (const f of contractFixtures) await f.clock.advance(ms);
  },
});

// ── Host-adapter specifics ────────────────────────────────────────

describe('HostSessionEnv.spawn', () => {
  it('runs the command via sh -c in its own process group with merged env', () => {
    const { env, records } = makeEnv();
    env.spawn('npm run dev', { cwd: 'web', env: { PORT: '4123', PATH: '/override' } });

    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.command).toBe('sh');
    expect(rec.args).toEqual(['-c', 'npm run dev']);
    expect(rec.options.detached).toBe(true);
    expect(rec.options.cwd).toBe('/wt/session-1/web');
    // opts.env wins over baseEnv; untouched base keys survive.
    expect(rec.options.env.PATH).toBe('/override');
    expect(rec.options.env.PORT).toBe('4123');
    expect(rec.options.env.HOME).toBe('/home/hub');
  });

  it('rejects absolute and worktree-escaping cwd', () => {
    const { env } = makeEnv();
    expect(() => env.spawn('ls', { cwd: '/etc' })).toThrow(/relative to the worktree/);
    expect(() => env.spawn('ls', { cwd: '../other' })).toThrow(/escape the worktree/);
    expect(() => env.spawn('ls', { cwd: 'a/../../b' })).toThrow(/escape the worktree/);
  });

  it('streams stdout/stderr as strings and bumps activity', async () => {
    const { env, records, clock } = makeEnv();
    const proc = env.spawn('npm run dev');
    const out: string[] = [];
    const err: string[] = [];
    proc.onStdout((c) => out.push(c));
    proc.onStderr((c) => err.push(c));

    const before = env.lastActivityAtMs;
    await clock.advance(50);
    records[0].child.stdout.emit('data', Buffer.from('ready on 5173\n'));
    records[0].child.stderr.emit('data', 'warn: slow\n');

    expect(out).toEqual(['ready on 5173\n']);
    expect(err).toEqual(['warn: slow\n']);
    expect(env.lastActivityAtMs).toBeGreaterThan(before);
  });

  it('kill signals the process group and falls back to the pid', () => {
    const killCalls: Array<[number, NodeJS.Signals]> = [];
    let failGroupKill = true;
    const { env, records } = makeEnv({
      kill: (pid, signal) => {
        killCalls.push([pid, signal]);
        if (pid < 0 && failGroupKill) throw new Error('ESRCH');
      },
    });
    const proc = env.spawn('npm run dev');
    const pid = records[0].child.pid;

    proc.kill('SIGTERM');
    expect(killCalls).toEqual([
      [-pid, 'SIGTERM'],
      [pid, 'SIGTERM'],
    ]);

    failGroupKill = false;
    killCalls.length = 0;
    proc.kill('SIGKILL');
    expect(killCalls).toEqual([[-pid, 'SIGKILL']]);
  });

  it('a spawn error settles the process with the error attached', () => {
    const { env, records } = makeEnv();
    const proc = env.spawn('nonexistent-binary');
    const exits: Array<{ code: number | null; error?: Error }> = [];
    proc.onExit((r) => exits.push(r));

    records[0].child.emit('error', new Error('spawn ENOENT'));
    expect(proc.exited).toBe(true);
    expect(exits).toHaveLength(1);
    expect(exits[0].code).toBeNull();
    expect(exits[0].error?.message).toBe('spawn ENOENT');
    expect(env.liveProcessCount()).toBe(0);
  });

  it('kill after exit is a no-op', () => {
    const { env, records, killCalls } = makeEnv();
    const proc = env.spawn('true');
    records[0].child.exit(0);
    proc.kill('SIGTERM');
    expect(killCalls).toEqual([]);
  });
});

describe('HostSessionEnv.openPty', () => {
  it('opens a PTY through the injected factory with merged env and shell default', async () => {
    const fake = new FakePty();
    const calls: Parameters<HostPtyFactory>[0][] = [];
    const { env } = makeEnv({
      openPty: async (opts) => {
        calls.push(opts);
        return fake;
      },
    });

    const pty = await env.openPty({ cwd: 'web', cols: 120, rows: 40, env: { TERM_APP: 'hub' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('/bin/zsh'); // baseEnv.SHELL
    expect(calls[0].cwd).toBe('/wt/session-1/web');
    expect(calls[0].cols).toBe(120);
    expect(calls[0].rows).toBe(40);
    expect(calls[0].env.TERM_APP).toBe('hub');
    expect(calls[0].env.HOME).toBe('/home/hub');
    expect(env.liveProcessCount()).toBe(1);

    const seen: string[] = [];
    pty.onData((d) => seen.push(d));
    fake.emitData('$ ');
    expect(seen).toEqual(['$ ']);

    pty.write('ls\n');
    expect(fake.written).toEqual(['ls\n']);
    pty.resize(100, 30);
    expect(fake.resizes).toEqual([[100, 30]]);

    fake.emitExit(0);
    expect(env.liveProcessCount()).toBe(0);
  });

  it('unsets an inherited variable when the overlay maps it to undefined', async () => {
    const fake = new FakePty();
    const calls: Parameters<HostPtyFactory>[0][] = [];
    const { env } = makeEnv({
      baseEnv: { PATH: '/usr/bin', SHELL: '/bin/zsh', AWS_PROFILE: 'operator-only' },
      openPty: async (opts) => {
        calls.push(opts);
        return fake;
      },
    });

    await env.openPty({ env: { AWS_PROFILE: undefined, AWS_CONFIG_FILE: '/data/aws/config' } });

    expect('AWS_PROFILE' in calls[0].env).toBe(false);
    expect(calls[0].env.AWS_CONFIG_FILE).toBe('/data/aws/config');
  });

  it('uses a line-editing shell when the host environment has no SHELL', async () => {
    const fake = new FakePty();
    const calls: Parameters<HostPtyFactory>[0][] = [];
    const { env } = makeEnv({
      baseEnv: { PATH: '/usr/bin', HOME: '/home/hub' },
      openPty: async (opts) => {
        calls.push(opts);
        return fake;
      },
    });

    await env.openPty();

    expect(calls[0].command).toBe('/bin/bash');
  });

  it('PTY I/O bumps lastActivityAtMs', async () => {
    const fake = new FakePty();
    const { env, clock } = makeEnv({ openPty: async () => fake });
    await env.openPty();
    await clock.advance(500);
    const before = env.lastActivityAtMs;
    await clock.advance(500);
    fake.emitData('output');
    expect(env.lastActivityAtMs).toBeGreaterThan(before);
  });

  it('kills a PTY that resolves after dispose already ran', async () => {
    const fake = new FakePty();
    let resolveFactory!: (p: HostPtyLike) => void;
    const { env } = makeEnv({
      openPty: () => new Promise<HostPtyLike>((r) => (resolveFactory = r)),
    });
    const pending = env.openPty();
    await env.dispose({ graceMs: 1 });
    resolveFactory(fake);
    await expect(pending).rejects.toThrow(/disposed/);
    expect(fake.kills.length).toBeGreaterThan(0);
  });

  it('opens a PTY through the installed node-pty dependency by default', async () => {
    const { env } = makeEnv({ openPty: undefined });
    const pty = await env.openPty({ command: '/bin/bash' });

    expect(pty.pid).toBe(7777);
    expect(env.liveProcessCount()).toBe(1);
  });
});

describe('HostSessionEnv.mapPort', () => {
  it('defaults to identity mapping on the host', async () => {
    const { env } = makeEnv();
    const m = await env.mapPort(5173);
    expect(m).toEqual({
      internalPort: 5173,
      hostPort: 5173,
      envPort: 5173,
      hostUrl: 'http://127.0.0.1:5173',
    });
  });

  it('uses the injected allocator and releases mappings on dispose', async () => {
    const released: number[] = [];
    const { env } = makeEnv({
      allocateHostPort: async (internal) => 4100 + (internal % 100),
      releaseHostPort: (m) => released.push(m.hostPort),
    });
    const a = await env.mapPort(5173);
    const b = await env.mapPort(8080);
    expect(a.hostPort).toBe(4173);
    expect(b.hostPort).toBe(4180);
    expect(env.listPortMappings()).toHaveLength(2);

    await env.dispose({ graceMs: 1 });
    expect(released.sort()).toEqual([4173, 4180]);
    expect(env.listPortMappings()).toEqual([]);
  });

  it('a failed allocation does not poison the cache for retries', async () => {
    let calls = 0;
    const { env } = makeEnv({
      allocateHostPort: () => {
        calls += 1;
        if (calls === 1) throw new Error('pool exhausted');
        return 4200;
      },
    });
    await expect(env.mapPort(3000)).rejects.toThrow(/pool exhausted/);
    // The rejected entry is evicted on the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    const m = await env.mapPort(3000);
    expect(m.hostPort).toBe(4200);
  });
});

describe('HostSessionEnv.mapPortsOut', () => {
  it('resolves every port loopback-only in order and shares mapPort caching', async () => {
    const allocations: number[] = [];
    const { env } = makeEnv({
      allocateHostPort: (internal) => {
        allocations.push(internal);
        return 4100 + (internal % 100);
      },
    });
    const [a, b] = await env.mapPortsOut([5173, 8080]);
    expect(a).toEqual({
      internalPort: 5173,
      hostPort: 4173,
      envPort: 4173,
      hostUrl: 'http://127.0.0.1:4173',
    });
    expect(b.internalPort).toBe(8080);
    expect(b.hostUrl).toBe('http://127.0.0.1:4180');

    // A repeat batch (and a port already resolved via mapPort) does not
    // re-allocate — the pooled port is handed back from cache.
    await env.mapPort(5173);
    const again = await env.mapPortsOut([5173, 8080]);
    expect(again).toEqual([a, b]);
    expect(allocations).toEqual([5173, 8080]);
  });

  it('with no argument returns the mappings established so far', async () => {
    const { env } = makeEnv();
    expect(await env.mapPortsOut()).toEqual([]);
    await env.mapPort(3000);
    expect(await env.mapPortsOut()).toEqual(env.listPortMappings());
  });
});

describe('HostSessionEnv.mountWorktree', () => {
  it('returns the worktree in place (hostPath === envPath)', async () => {
    const { env } = makeEnv();
    await expect(env.mountWorktree()).resolves.toEqual({
      hostPath: '/wt/session-1',
      envPath: '/wt/session-1',
    });
  });

  it('throws when the worktree directory is missing', async () => {
    const { env } = makeEnv({ isDirectory: async () => false });
    await expect(env.mountWorktree()).rejects.toThrow(/worktree not found/i);
  });
});

describe('HostSessionEnv.dispose', () => {
  it('SIGTERMs live work, then SIGKILLs survivors after the grace window', async () => {
    const fakePty = new FakePty();
    const { env, records, clock, killCalls } = makeEnv({ openPty: async () => fakePty });
    env.spawn('npm run dev');
    await env.openPty();
    const pid = records[0].child.pid;

    const disposed = env.dispose({ graceMs: 5000 });
    // SIGTERM lands immediately (process group) + pty kill.
    expect(killCalls).toContainEqual([-pid, 'SIGTERM']);
    expect(fakePty.kills).toEqual([undefined]);

    // Neither exits within the grace window → SIGKILL both.
    await clock.advance(5001);
    expect(killCalls).toContainEqual([-pid, 'SIGKILL']);
    expect(fakePty.kills).toContain('SIGKILL');

    // Teardown completes without the processes ever reporting exit.
    records[0].child.exit(null, 'SIGKILL');
    fakePty.emitExit(137);
    await disposed;
    expect(env.disposed).toBe(true);
  });

  it('skips SIGKILL when everything exits within the grace window', async () => {
    const { env, records, clock, killCalls } = makeEnv();
    env.spawn('npm run dev');
    const disposed = env.dispose({ graceMs: 5000 });
    records[0].child.exit(0);
    await clock.advance(1);
    await disposed;
    const sigkills = killCalls.filter(([, sig]) => sig === 'SIGKILL');
    expect(sigkills).toEqual([]);
  });
});
