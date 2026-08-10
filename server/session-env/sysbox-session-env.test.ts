import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostChildLike, HostPtyFactory, HostPtyLike } from './host-session-env.js';
import { SessionEnvClock } from './session-env.js';
import { describeSessionEnvContract } from './session-env-contract.js';
import { SYSBOX_SESSION_WORKSPACE } from './sysbox-exec-args.js';
import {
  SysboxRunResult,
  SysboxSessionEnv,
  SysboxSessionEnvDeps,
  hasSysboxDetachedWorkloadFromProbeOutput,
  isSysboxBaselineComm,
  isSysboxDetachedWorkloadLine,
} from './sysbox-session-env.js';

describe('isSysboxBaselineComm / isSysboxDetachedWorkloadLine', () => {
  it('treats dockerd/containerd as idle baseline but not bash/sleep workers', () => {
    expect(isSysboxBaselineComm('dockerd')).toBe(true);
    expect(isSysboxBaselineComm('containerd')).toBe(true);
    expect(isSysboxBaselineComm('sleep')).toBe(false);
    expect(isSysboxBaselineComm('bash')).toBe(false);
    expect(isSysboxBaselineComm('node')).toBe(false);
    expect(isSysboxBaselineComm('postgres')).toBe(false);
  });

  it('ignores entrypoint PID 1 sleep but counts user sleep jobs', () => {
    expect(isSysboxDetachedWorkloadLine('1 sleep')).toBe(false);
    expect(isSysboxDetachedWorkloadLine('42 sleep')).toBe(true);
    expect(isSysboxDetachedWorkloadLine('7 bash')).toBe(true);
    expect(isSysboxDetachedWorkloadLine('9 dockerd')).toBe(false);
  });
});

describe('hasSysboxDetachedWorkloadFromProbeOutput', () => {
  it('treats real idle finalize-runner output (sleep + probe ps) as idle', () => {
    // Reproduced shape: entrypoint sleep infinity, plus this probe's sh/ps.
    const idle = ['5', '1 0 sleep', '5 0 sh', '7 5 ps'].join('\n');
    expect(hasSysboxDetachedWorkloadFromProbeOutput(idle)).toBe(false);
  });

  it('counts non-init user work alongside the probe rows', () => {
    const busy = ['5', '1 0 sleep', '5 0 sh', '7 5 ps', '42 1 node'].join('\n');
    expect(hasSysboxDetachedWorkloadFromProbeOutput(busy)).toBe(true);
  });

  it('fails closed on empty or malformed probe headers', () => {
    expect(hasSysboxDetachedWorkloadFromProbeOutput('')).toBe(true);
    expect(hasSysboxDetachedWorkloadFromProbeOutput('not-a-pid\n1 0 sleep')).toBe(true);
  });
});

// ── Fakes ─────────────────────────────────────────────────────────

class FakeChild extends EventEmitter implements HostChildLike {
  pid: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(): boolean {
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

interface SpawnRecord {
  command: string;
  args: readonly string[];
  child: FakeChild;
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
    await new Promise((r) => setTimeout(r, 0));
  }
}

class FakePty implements HostPtyLike {
  pid = 7777;
  written: string[] = [];
  kills: Array<string | undefined> = [];
  private dataSubs = new Set<(d: string) => void>();
  private exitSubs = new Set<(e: { exitCode: number; signal?: number }) => void>();
  write(data: string): void {
    this.written.push(data);
  }
  resize(): void {}
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
  emitExit(exitCode: number): void {
    for (const cb of this.exitSubs) cb({ exitCode });
  }
}

const ok: SysboxRunResult = { ok: true, stdout: '', stderr: '' };

interface Fixture {
  env: SysboxSessionEnv;
  spawnRecords: SpawnRecord[];
  /** Every one-shot docker invocation, in order. */
  runCalls: string[][];
  clock: FakeClock;
  pty: FakePty;
}

function makeEnv(
  overrides: Partial<SysboxSessionEnvDeps> = {},
  respond?: (argv: string[]) => SysboxRunResult | undefined,
): Fixture {
  const spawnRecords: SpawnRecord[] = [];
  const runCalls: string[][] = [];
  const clock = new FakeClock();
  const pty = new FakePty();
  let nextPid = 1000;
  const env = new SysboxSessionEnv({
    sessionId: 'sess-1',
    worktreePath: '/wt/session-1',
    publishPorts: [5173],
    // Pinned, not platform-derived: the default routing differs between a Mac
    // dev box and Linux CI, which would make these assertions pass locally and
    // fail (or silently exercise a different code path) in CI.
    portRouting: 'published-ports',
    spawn: (command, args) => {
      const child = new FakeChild(nextPid++);
      spawnRecords.push({ command, args, child });
      return child;
    },
    runDocker: async (argv) => {
      runCalls.push(argv);
      return respond?.(argv) ?? ok;
    },
    openPty: async () => pty,
    isDirectory: async () => true,
    // Stubbed, not left to the real fs: the default hits disk, and that extra
    // I/O turn lands after the fake-clock tests' `setTimeout(0)` yield, so the
    // clock advances past the readiness sleep before it is even scheduled.
    statWorkspaceOwner: async () => ({ uid: 1000, gid: 1000 }),
    baseEnv: { NODE_ENV: 'development' },
    dockerClientEnv: { PATH: '/usr/bin' },
    clock,
    logger: { warn: () => {} },
    ...overrides,
  });
  return { env, spawnRecords, runCalls, clock, pty };
}

async function startedEnv(
  overrides: Partial<SysboxSessionEnvDeps> = {},
  respond?: (argv: string[]) => SysboxRunResult | undefined,
): Promise<Fixture> {
  const fixture = makeEnv(overrides, respond);
  await fixture.env.mountWorktree();
  return fixture;
}

const isRunArgv = (argv: string[]) => argv[1] === 'run';
const isKillArgv = (argv: string[]) =>
  argv[1] === 'exec' && argv.some((a) => a.includes('kill -s'));
const isDockerInfoProbe = (argv: string[]) =>
  argv[1] === 'exec' && argv[argv.length - 1] === 'info';

// ── Interface contract (adapter-agnostic suite) ───────────────────

const contractFixtures: Fixture[] = [];
afterEach(() => {
  contractFixtures.length = 0;
});
describeSessionEnvContract('sysbox adapter', {
  async createEnv() {
    // The sysbox container must be running before spawn(); production
    // callers await mountWorktree() the same way. Port 5173 (the port the
    // contract exercises) is declared up front — sysbox publishes are fixed
    // at container start.
    const fixture = await startedEnv();
    contractFixtures.push(fixture);
    return fixture.env;
  },
  exitProcess(env, pid, code) {
    const fixture = contractFixtures.find((f) => f.env === env);
    const rec = fixture?.spawnRecords.find((r) => r.child.pid === pid);
    if (!rec) throw new Error(`no fake docker-exec child with pid ${pid}`);
    rec.child.exit(code);
  },
  async advanceClock(ms) {
    for (const f of contractFixtures) await f.clock.advance(ms);
  },
});

// ── Container lifecycle ───────────────────────────────────────────

describe('SysboxSessionEnv container start', () => {
  it('defers docker run under published-ports until ports are declared', async () => {
    // SessionEnvManager.ensure → mountWorktree runs before preview mapPortsOut.
    // Starting with an empty publish set makes later port declarations impossible.
    const { env, runCalls } = makeEnv({ publishPorts: [] });
    await env.mountWorktree();
    expect(env.containerStarted).toBe(false);
    expect(runCalls.some(isRunArgv)).toBe(false);

    await env.mapPortsOut([5173]);
    expect(env.containerStarted).toBe(true);
    const run = runCalls.find(isRunArgv)!;
    expect(run.some((a) => a.startsWith('127.0.0.1:') && a.endsWith(':5173'))).toBe(true);
  });

  it('reallocates a different host port after a Docker bind collision', async () => {
    const allocated: number[] = [];
    let nextHost = 4100;
    let runAttempts = 0;
    const { env, runCalls } = makeEnv(
      {
        publishPorts: [5173],
        allocateHostPort: async () => {
          const p = nextHost++;
          allocated.push(p);
          return p;
        },
        releaseHostPort: () => undefined,
      },
      (argv) => {
        if (isRunArgv(argv)) {
          runAttempts += 1;
          if (runAttempts === 1) {
            return {
              ok: false,
              stdout: '',
              stderr: 'failed to bind host port: address already in use',
            };
          }
        }
        if (isDockerInfoProbe(argv)) return ok;
        return ok;
      },
    );
    await env.mountWorktree();
    expect(env.containerStarted).toBe(true);
    const runArgvs = runCalls.filter(isRunArgv);
    expect(runArgvs.length).toBeGreaterThanOrEqual(2);
    expect(runArgvs[0].some((a) => a.includes('4100:5173'))).toBe(true);
    expect(runArgvs[1].some((a) => a.includes('4101:5173'))).toBe(true);
    expect(allocated).toEqual([4100, 4101]);
  });

  it('starts once on mountWorktree: labeled graph volume, sysbox run, dockerd probe', async () => {
    const { env, runCalls } = makeEnv();
    const mount = await env.mountWorktree();
    expect(mount).toEqual({
      hostPath: '/wt/session-1',
      envPath: SYSBOX_SESSION_WORKSPACE,
      sharing: 'host-shared',
    });
    expect(env.containerStarted).toBe(true);

    expect(runCalls[0].slice(0, 3)).toEqual(['docker', 'volume', 'create']);
    const run = runCalls.find(isRunArgv)!;
    expect(run).toContain('--runtime=sysbox-runc');
    expect(run).not.toContain('--privileged');
    expect(run.join(' ')).toContain(`-v /wt/session-1:${SYSBOX_SESSION_WORKSPACE}:rw`);
    expect(runCalls.some(isDockerInfoProbe)).toBe(true);

    // Idempotent — a second mount does not start a second container.
    await env.mountWorktree();
    expect(runCalls.filter(isRunArgv)).toHaveLength(1);
  });

  it('publishes declared and pre-start mapPort ports loopback-only at start', async () => {
    const { env, runCalls } = makeEnv({
      publishPorts: [3000],
      allocateHostPort: (internal) => 4100 + (internal % 100),
    });
    const mapped = await env.mapPort(5173);
    expect(mapped).toEqual({
      internalPort: 5173,
      host: '127.0.0.1',
      hostPort: 4173,
      envPort: 5173,
      hostUrl: 'http://127.0.0.1:4173',
    });

    await env.mountWorktree();
    const run = runCalls.find(isRunArgv)!.join(' ');
    expect(run).toContain('-p 127.0.0.1:4100:3000');
    expect(run).toContain('-p 127.0.0.1:4173:5173');
  });

  it('passes the worktree owner so the container can match its uid', async () => {
    // Without these the bind mount is read-only to the session user and git
    // refuses the checkout as "dubious ownership" — the session looks up but
    // cannot edit, build, or commit anything.
    const { runCalls } = await startedEnv({
      statWorkspaceOwner: async () => ({ uid: 1000, gid: 1000 }),
    });
    const run = runCalls.find(isRunArgv)!.join(' ');
    expect(run).toContain('-e AGENT_HUB_WORKSPACE_UID=1000');
    expect(run).toContain('-e AGENT_HUB_WORKSPACE_GID=1000');
  });

  it('starts without owner env when the worktree owner cannot be read', async () => {
    const { runCalls } = await startedEnv({ statWorkspaceOwner: async () => null });
    const run = runCalls.find(isRunArgv)!.join(' ');
    expect(run).not.toContain('AGENT_HUB_WORKSPACE_UID');
  });

  it('rejects mapPort for a new port once the container is running', async () => {
    const { env } = await startedEnv();
    await expect(env.mapPort(9999)).rejects.toThrow(/not declared before/);
    // Already-published ports still resolve.
    await expect(env.mapPort(5173)).resolves.toMatchObject({ internalPort: 5173 });
  });

  it('spawn before start throws an actionable error', () => {
    const { env } = makeEnv();
    expect(() => env.spawn('npm run dev')).toThrow(/mountWorktree/);
  });

  it('a failed docker run cleans up and allows a retry', async () => {
    let fail = true;
    const fixture = makeEnv({}, (argv) => {
      if (isRunArgv(argv) && fail) return { ok: false, stdout: '', stderr: 'boom' };
      return undefined;
    });
    await expect(fixture.env.mountWorktree()).rejects.toThrow(/boom/);
    // Best-effort cleanup ran so the retry has no name/volume collision.
    expect(fixture.runCalls.some((a) => a[1] === 'rm')).toBe(true);
    expect(fixture.runCalls.some((a) => a[1] === 'volume' && a[2] === 'rm')).toBe(true);

    fail = false;
    await fixture.env.mountWorktree();
    expect(fixture.env.containerStarted).toBe(true);
  });

  it('throws when the worktree directory is missing', async () => {
    const { env } = makeEnv({ isDirectory: async () => false });
    await expect(env.mountWorktree()).rejects.toThrow(/worktree not found/i);
  });

  it('waits for the inner dockerd and fails after the ready timeout', async () => {
    let probes = 0;
    const fixture = makeEnv({ readyPollMs: 400, readyTimeoutMs: 2000 }, (argv) => {
      if (isDockerInfoProbe(argv)) {
        probes += 1;
        return { ok: probes >= 3, stdout: '', stderr: 'starting' };
      }
      return undefined;
    });
    const pending = fixture.env.mountWorktree();
    // Let the async start chain reach its first readiness sleep before the
    // manual clock moves; otherwise the sleep is scheduled in the future
    // relative to the already-advanced fake time.
    await new Promise((r) => setTimeout(r, 0));
    await fixture.clock.advance(400); // probe 2 fails
    await fixture.clock.advance(400); // probe 3 succeeds
    await pending;
    expect(probes).toBe(3);

    const never = makeEnv({ readyPollMs: 400, readyTimeoutMs: 1000 }, (argv) =>
      isDockerInfoProbe(argv) ? { ok: false, stdout: '', stderr: 'starting' } : undefined,
    );
    const failing = never.env.mountWorktree();
    const assertion = expect(failing).rejects.toThrow(/not ready after 1000ms/);
    await new Promise((r) => setTimeout(r, 0));
    await never.clock.advance(400);
    await never.clock.advance(400);
    await never.clock.advance(400);
    await assertion;
    expect(never.runCalls).toContainEqual(['docker', 'rm', '-f', '-v', 'agenthub-session-sess-1']);
    expect(never.runCalls).toContainEqual([
      'docker',
      'volume',
      'rm',
      '-f',
      'agenthub-session-sess-1-graph',
    ]);
  });
});

// ── Spawn / kill via docker exec ──────────────────────────────────

describe('SysboxSessionEnv.spawn', () => {
  it('execs into the session container with resolved cwd and merged env', async () => {
    const { env, spawnRecords } = await startedEnv();
    env.spawn('npm run dev', { cwd: 'web', env: { PORT: '5173' } });

    expect(spawnRecords).toHaveLength(1);
    const rec = spawnRecords[0];
    expect(rec.command).toBe('docker');
    expect(rec.args[0]).toBe('exec');
    const joined = rec.args.join(' ');
    expect(joined).toContain('agenthub-session-sess-1');
    expect(joined).toContain(`-w ${SYSBOX_SESSION_WORKSPACE}/web`);
    expect(joined).toContain('-e NODE_ENV=development');
    expect(joined).toContain('-e PORT=5173');
    expect(rec.args[rec.args.length - 1]).toBe('npm run dev');
  });

  it('rejects absolute and worktree-escaping cwd', async () => {
    const { env } = await startedEnv();
    expect(() => env.spawn('ls', { cwd: '/etc' })).toThrow(/relative to the worktree/);
    expect(() => env.spawn('ls', { cwd: '../other' })).toThrow(/escape the worktree/);
  });

  it('kill signals the in-container process via its pidfile, not the exec client', async () => {
    const { env, runCalls } = await startedEnv();
    const proc = env.spawn('npm run dev');
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 0));

    const kill = runCalls.find(isKillArgv)!;
    expect(kill[kill.length - 1]).toBe('TERM');
    expect(kill.join(' ')).toContain('/tmp/agenthub-proc-0.pid');
  });

  it('kill after exit is a no-op', async () => {
    const { env, spawnRecords, runCalls } = await startedEnv();
    const proc = env.spawn('true');
    spawnRecords[0].child.exit(0);
    const before = runCalls.length;
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 0));
    expect(runCalls.length).toBe(before);
  });
});

// ── PTY ───────────────────────────────────────────────────────────

describe('SysboxSessionEnv.openPty', () => {
  it('starts the container if needed and opens an interactive docker exec', async () => {
    const fixture = makeEnv();
    const calls: Parameters<HostPtyFactory>[0][] = [];
    const env = new SysboxSessionEnv({
      sessionId: 'sess-1',
      worktreePath: '/wt/session-1',
      // Pin published-ports: Linux defaults to container-ip and would skip the
      // ensureStarted path this test covers.
      portRouting: 'published-ports',
      spawn: () => new FakeChild(1),
      runDocker: async (argv) => {
        fixture.runCalls.push(argv);
        return ok;
      },
      openPty: async (opts) => {
        calls.push(opts);
        return fixture.pty;
      },
      isDirectory: async () => true,
      dockerClientEnv: { PATH: '/usr/bin', SECRET: undefined },
      clock: fixture.clock,
      logger: { warn: () => {} },
    });

    const pty = await env.openPty({ cwd: 'web', cols: 120, rows: 40 });
    expect(env.containerStarted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('docker');
    expect(calls[0].args.slice(0, 2)).toEqual(['exec', '-it']);
    expect(calls[0].args.join(' ')).toContain(`-w ${SYSBOX_SESSION_WORKSPACE}/web`);
    expect(calls[0].cols).toBe(120);
    // undefined client env entries are dropped for node-pty.
    expect('SECRET' in calls[0].env).toBe(false);
    expect(env.liveProcessCount()).toBe(1);
    expect(pty.pid).toBe(7777);

    fixture.pty.emitExit(0);
    expect(env.liveProcessCount()).toBe(0);
  });
});

// ── Dispose / teardown ────────────────────────────────────────────

describe('SysboxSessionEnv.dispose', () => {
  it('TERMs live work, then removes the container and graph volume, releasing ports', async () => {
    const released: number[] = [];
    const fixture = await startedEnv({
      allocateHostPort: (internal) => internal + 1000,
      releaseHostPort: (hostPort) => released.push(hostPort),
    });
    const { env, runCalls, clock } = fixture;
    // Published ports are released once docker run claims them (start), not at dispose.
    expect(released).toEqual([6173]);
    env.spawn('npm run dev');

    const disposed = env.dispose({ graceMs: 5000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(runCalls.some(isKillArgv)).toBe(true);

    // Process never exits within grace; container removal is the backstop.
    await clock.advance(5001);
    await disposed;

    const rm = runCalls.find((a) => a[1] === 'rm')!;
    expect(rm).toEqual(['docker', 'rm', '-f', '-v', 'agenthub-session-sess-1']);
    const volRm = runCalls.find((a) => a[1] === 'volume' && a[2] === 'rm')!;
    expect(volRm).toEqual(['docker', 'volume', 'rm', '-f', 'agenthub-session-sess-1-graph']);
    // rm happens after the grace race, volume rm after container rm.
    expect(runCalls.indexOf(rm)).toBeLessThan(runCalls.indexOf(volRm));
    expect(env.disposed).toBe(true);
  });

  it('skips docker teardown entirely when the container never started', async () => {
    const { env, runCalls } = makeEnv();
    await env.dispose({ graceMs: 1 });
    expect(runCalls).toEqual([]);
    expect(env.disposed).toBe(true);
  });

  it('completes teardown even when docker removal fails', async () => {
    const warnings: string[] = [];
    const fixture = await startedEnv({ logger: { warn: (m) => warnings.push(m) } }, (argv) =>
      argv[1] === 'rm' || (argv[1] === 'volume' && argv[2] === 'rm')
        ? { ok: false, stdout: '', stderr: 'daemon gone' }
        : undefined,
    );
    await fixture.env.dispose({ graceMs: 1 });
    expect(fixture.env.disposed).toBe(true);
    expect(warnings.some((w) => /removal failed/.test(w))).toBe(true);
  });
});

// ── Container-IP routing ──────────────────────────────────────────

const isInspectArgv = (argv: string[]) => argv[1] === 'inspect';

/** Fixture whose docker fake answers `inspect` with a bridge address. */
function containerIpEnv(overrides: Partial<SysboxSessionEnvDeps> = {}, ip = '172.17.0.5') {
  return makeEnv(
    { portRouting: 'container-ip', isolation: 'privileged', publishPorts: [], ...overrides },
    (argv) => (isInspectArgv(argv) ? { ok: true, stdout: `${ip} `, stderr: '' } : undefined),
  );
}

describe('SysboxSessionEnv — container-IP routing', () => {
  it('publishes no ports and reports the container kind', async () => {
    const { env, runCalls } = containerIpEnv();
    await env.mountWorktree();

    expect(env.kind).toBe('container');
    const run = runCalls.find(isRunArgv)!;
    expect(run).not.toContain('-p');
    expect(run).toContain('--privileged');
  });

  it('maps a port that was never declared, after the container is running', async () => {
    // The defect this removes: under published-ports routing, a port not
    // named before `docker run` can never be reached, because publishes are
    // fixed at container start. A session that adds a service mid-flight had
    // to restart its whole environment.
    const { env } = containerIpEnv();
    await env.mountWorktree();

    const mapping = await env.mapPort(8080);
    expect(mapping).toEqual({
      internalPort: 8080,
      host: '172.17.0.5',
      hostPort: 8080,
      envPort: 8080,
      hostUrl: 'http://172.17.0.5:8080',
    });
  });

  it('dials the container address rather than loopback', async () => {
    const { env } = containerIpEnv();
    await env.mountWorktree();

    await expect(env.resolveDialTarget(5173)).resolves.toEqual({
      host: '172.17.0.5',
      port: 5173,
      url: 'http://172.17.0.5:5173',
    });
  });

  it('consumes no host ports even when an allocator is supplied', async () => {
    // Nothing is published, so the shared 4100–4999 pool must stay untouched
    // — that pool's exhaustion and cross-session collisions are the reason
    // this routing exists.
    let allocations = 0;
    const { env } = containerIpEnv({
      allocateHostPort: (p) => {
        allocations++;
        return p + 1000;
      },
    });
    await env.mountWorktree();
    await env.mapPortsOut([5173, 8080, 5432]);

    expect(allocations).toBe(0);
    expect(env.listPortMappings().map((m) => m.hostUrl)).toEqual([
      'http://172.17.0.5:5173',
      'http://172.17.0.5:8080',
      'http://172.17.0.5:5432',
    ]);
  });

  it('fails the start when the container has no reachable address', async () => {
    // Better to fail loudly here than to hand back an env whose every
    // preview connection hangs against an empty host.
    const { env, runCalls } = makeEnv(
      { portRouting: 'container-ip', isolation: 'privileged', publishPorts: [] },
      (argv) => (isInspectArgv(argv) ? { ok: true, stdout: '   ', stderr: '' } : undefined),
    );

    await expect(env.mountWorktree()).rejects.toThrow(/could not resolve a container ip/i);
    // The unusable container must not be left behind to collide with a retry.
    expect(runCalls.some((a) => a[1] === 'rm')).toBe(true);
  });
});

describe('SysboxSessionEnv hasDetachedWorkload', () => {
  const idleProbeStdout = ['5', '1 0 sleep', '5 0 sh', '7 5 ps'].join('\n');

  it('queries container-ns PIDs via docker exec and excludes the probe itself', async () => {
    const { env, runCalls } = await startedEnv({}, (argv) => {
      if (argv[1] === 'exec' && argv.includes('sh') && argv.some((a) => a.includes('ps -eo'))) {
        return { ok: true, stdout: idleProbeStdout, stderr: '' };
      }
      return undefined;
    });
    await expect(env.hasDetachedWorkload()).resolves.toBe(false);
    const probe = runCalls.find((a) => a[1] === 'exec' && a.includes('sh'));
    expect(probe?.slice(0, 4)).toEqual(['docker', 'exec', expect.any(String), 'sh']);
    expect(probe?.at(-1)).toMatch(/printf.*\$\$.*ps -eo pid=,ppid=,comm=/);
    expect(runCalls.some((a) => a[1] === 'top')).toBe(false);
  });

  it('treats non-init sleep and other user processes as busy', async () => {
    const { env } = await startedEnv({}, (argv) => {
      if (argv[1] === 'exec' && argv.includes('sh') && argv.some((a) => a.includes('ps -eo'))) {
        return {
          ok: true,
          stdout: ['5', '1 0 sleep', '5 0 sh', '7 5 ps', '42 1 sleep', '9 1 node'].join('\n'),
          stderr: '',
        };
      }
      return undefined;
    });
    await expect(env.hasDetachedWorkload()).resolves.toBe(true);
  });

  it('fails closed when the namespace probe fails', async () => {
    const { env } = await startedEnv({}, (argv) => {
      if (argv[1] === 'exec' && argv.includes('sh') && argv.some((a) => a.includes('ps -eo'))) {
        return { ok: false, stdout: '', stderr: 'no ps' };
      }
      return undefined;
    });
    await expect(env.hasDetachedWorkload()).resolves.toBe(true);
  });
});
