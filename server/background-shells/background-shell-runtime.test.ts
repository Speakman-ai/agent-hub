/**
 * BackgroundShellRuntime lifecycle tests.
 *
 * Every process boundary is faked. No test in this file spawns a real
 * child process (the global CLI-spawn guard would reject `claude` etc.,
 * but these fakes never touch `child_process` at all).
 */

import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'child_process';
import {
  BackgroundShellRuntime,
  systemClock,
  type BackgroundShellLogSink,
  type SpawnFn,
} from './background-shell-runtime.js';

/** A minimal fake ChildProcess: EventEmitter + fake stdout/stderr streams. */
class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emitExit(null, signal ?? 'SIGTERM');
    return true;
  }

  emitData(stream: 'stdout' | 'stderr', chunk: string): void {
    this[stream].emit('data', Buffer.from(chunk, 'utf8'));
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode != null || this.signalCode != null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface Harness {
  runtime: BackgroundShellRuntime;
  db: Database.Database;
  children: FakeChild[];
  killCalls: Array<{ target: number; signal: NodeJS.Signals }>;
  logs: Map<string, string>;
  readCalls: string[];
  lastSpawnOpts: () => Record<string, unknown> | null;
}

function makeHarness(opts: { failSpawn?: boolean } = {}): Harness {
  const db = new Database(':memory:');
  const children: FakeChild[] = [];
  const killCalls: Array<{ target: number; signal: NodeJS.Signals }> = [];
  const logs = new Map<string, string>();
  const readCalls: string[] = [];
  let nextPid = 1000;
  let lastOpts: Record<string, unknown> | null = null;

  const spawn: SpawnFn = (_cmd, _args, options) => {
    lastOpts = options as Record<string, unknown>;
    if (opts.failSpawn) throw new Error('ENOENT sh');
    const child = new FakeChild(nextPid++);
    children.push(child);
    return child as unknown as ChildProcess;
  };

  const logSink: BackgroundShellLogSink = {
    open(shellId) {
      logs.set(shellId, '');
      return {
        path: `/fake/${shellId}.log`,
        append: (chunk) => logs.set(shellId, (logs.get(shellId) ?? '') + chunk),
      };
    },
    read(logPath, limit) {
      readCalls.push(logPath);
      const shellId = logPath.replace(/^\/fake\//, '').replace(/\.log$/, '');
      const lines = (logs.get(shellId) ?? '').split('\n').filter((line) => line.length > 0);
      return limit != null && limit >= 0 && lines.length > limit
        ? lines.slice(lines.length - limit)
        : lines;
    },
  };

  const runtime = new BackgroundShellRuntime({
    db,
    spawn,
    logSink,
    // Simulate the OS: signalling a process group (`-pid`) makes the
    // matching child exit-with-signal, so `waitForExit` resolves.
    kill: (target, signal) => {
      killCalls.push({ target, signal });
      const pid = target < 0 ? -target : target;
      children.find((c) => c.pid === pid)?.emitExit(null, signal);
    },
    config: { killGraceMs: 10 },
  });

  return { runtime, db, children, killCalls, logs, readCalls, lastSpawnOpts: () => lastOpts };
}

const START = {
  sessionId: 'sess-1',
  projectId: 'proj-1',
  command: 'npm run build',
  cwd: '/wt/sess-1',
  label: 'build',
};

describe('BackgroundShellRuntime.start', () => {
  it('inserts a running row, records pid, and spawns detached in its own group', () => {
    const h = makeHarness();
    const row = h.runtime.start(START);

    expect(row.status).toBe('running');
    expect(row.command).toBe('npm run build');
    expect(row.label).toBe('build');
    expect(row.pid).toBe(1000);
    expect(row.log_path).toBe(`/fake/${row.id}.log`);
    expect(h.lastSpawnOpts()).toMatchObject({ cwd: '/wt/sess-1', detached: true });
  });

  it('captures stdout/stderr into the log tail', () => {
    const h = makeHarness();
    const row = h.runtime.start(START);
    h.children[0].emitData('stdout', 'compiling\n');
    h.children[0].emitData('stderr', 'warning: x\n');

    expect(h.runtime.getLogTail(row.id)).toEqual(['compiling', 'warning: x']);
    expect(h.logs.get(row.id)).toContain('compiling');
  });

  it('keeps the log tail readable after the shell exits (cross-turn monitoring)', () => {
    const h = makeHarness();
    const row = h.runtime.start(START);
    h.children[0].emitData('stdout', 'done\n');
    h.children[0].emitExit(0);
    // Simulates a later turn reading logs of an already-finished shell.
    expect(h.runtime.getById(row.id)!.status).toBe('exited');
    expect(h.runtime.getLogTail(row.id)).toContain('done');
    expect(h.readCalls).toEqual([`/fake/${row.id}.log`]);
  });

  it('marks a row failed when spawn throws (never propagates)', () => {
    const h = makeHarness({ failSpawn: true });
    const row = h.runtime.start(START);
    expect(row.status).toBe('failed');
    expect(row.pid).toBeNull();
    expect(h.runtime.getLogTail(row.id).join('\n')).toContain('spawn failed');
  });
});

describe('BackgroundShellRuntime exit handling', () => {
  it('flips to exited on clean exit (code 0)', () => {
    const h = makeHarness();
    const row = h.runtime.start(START);
    h.children[0].emitExit(0);
    const after = h.runtime.getById(row.id)!;
    expect(after.status).toBe('exited');
    expect(after.exit_code).toBe(0);
  });

  it('flips to failed on non-zero exit', () => {
    const h = makeHarness();
    const row = h.runtime.start(START);
    h.children[0].emitExit(2);
    const after = h.runtime.getById(row.id)!;
    expect(after.status).toBe('failed');
    expect(after.exit_code).toBe(2);
  });

  it('flips to failed on child error event', () => {
    const h = makeHarness();
    const row = h.runtime.start(START);
    h.children[0].emit('error', new Error('boom'));
    expect(h.runtime.getById(row.id)!.status).toBe('failed');
  });

  it('retains a naturally exited shell while descendants remain in its group', async () => {
    const db = new Database(':memory:');
    const child = new FakeChild(7200);
    const killCalls: NodeJS.Signals[] = [];
    let groupAlive = true;
    const runtime = new BackgroundShellRuntime({
      db,
      spawn: (() => child) as unknown as SpawnFn,
      logSink: { open: () => ({ path: null, append: () => {} }) },
      kill: (_target, signal) => {
        killCalls.push(signal);
        groupAlive = false;
      },
      probeGroupAlive: () => groupAlive,
      config: { killGraceMs: 10 },
    });
    const started = runtime.start(START);
    child.emitExit(0);

    expect(runtime.getById(started.id)!.status).toBe('running');
    const stopped = await runtime.stop(started.id);
    expect(stopped!.status).toBe('stopped');
    expect(killCalls).toEqual(['SIGTERM']);
  });
});

describe('BackgroundShellRuntime.stop', () => {
  it('SIGTERMs the process group and marks the row stopped', async () => {
    const h = makeHarness();
    const row = h.runtime.start(START);
    const result = await h.runtime.stop(row.id);

    expect(result!.status).toBe('stopped');
    // Negative pid => whole process group.
    expect(h.killCalls).toContainEqual({ target: -1000, signal: 'SIGTERM' });
  });

  it('does not clobber a stopped row when the ensuing exit event fires', async () => {
    const h = makeHarness();
    const row = h.runtime.start(START);
    await h.runtime.stop(row.id);
    // The kill() on the fake already emitted exit; assert it stayed stopped.
    h.children[0].emitExit(0);
    expect(h.runtime.getById(row.id)!.status).toBe('stopped');
  });

  it('is idempotent and safe on unknown ids', async () => {
    const h = makeHarness();
    expect(await h.runtime.stop('nope')).toBeNull();
  });

  it('never hangs when the signal produces no exit event (wedged process)', async () => {
    // A kill that records but does NOT make the child exit — models a wedged /
    // unresponsive process group or a signal that yields no Node `exit` event.
    const db = new Database(':memory:');
    const children: FakeChild[] = [];
    const logSink: BackgroundShellLogSink = { open: () => ({ path: null, append: () => {} }) };
    const killCalls: NodeJS.Signals[] = [];
    const runtime = new BackgroundShellRuntime({
      db,
      spawn: (() => {
        const c = new FakeChild(7000);
        children.push(c);
        return c as unknown as ChildProcess;
      }) as unknown as SpawnFn,
      logSink,
      kill: (_target, signal) => killCalls.push(signal), // never emits exit
      probeGroupAlive: () => true,
      config: { killGraceMs: 10 },
    });
    const started = runtime.start(START);

    // Must resolve via the give-up timer (~2 * killGraceMs), not hang.
    const stopped = await runtime.stop(started.id);
    expect(stopped!.status).toBe('stopped');
    // Escalated SIGTERM -> SIGKILL even though neither produced an exit.
    expect(killCalls).toContain('SIGTERM');
    expect(killCalls).toContain('SIGKILL');
  });

  it('escalates when the leader exits but a descendant group remains alive', async () => {
    const db = new Database(':memory:');
    const child = new FakeChild(7100);
    const killCalls: NodeJS.Signals[] = [];
    let groupAlive = true;
    const runtime = new BackgroundShellRuntime({
      db,
      spawn: (() => child) as unknown as SpawnFn,
      logSink: { open: () => ({ path: null, append: () => {} }) },
      kill: (_target, signal) => {
        killCalls.push(signal);
        if (signal === 'SIGTERM') child.emitExit(null, signal);
        if (signal === 'SIGKILL') groupAlive = false;
      },
      probeGroupAlive: () => groupAlive,
      config: { killGraceMs: 10 },
    });
    const started = runtime.start(START);

    const stopped = await runtime.stop(started.id);
    expect(stopped!.status).toBe('stopped');
    expect(killCalls).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('downgrades a running row with no live handle to stopped', async () => {
    const h = makeHarness();
    // Simulate a row left over from a prior Hub process: insert directly.
    h.db
      .prepare(
        `INSERT INTO background_shells (id, session_id, project_id, command, status, created_at, updated_at)
         VALUES ('orphan', 'sess-1', 'proj-1', 'sleep 999', 'running', '2020-01-01', '2020-01-01')`,
      )
      .run();
    const result = await h.runtime.stop('orphan');
    expect(result!.status).toBe('stopped');
  });

  it('reaps a prior-process row before stopping it when no handle exists', async () => {
    const db = new Database(':memory:');
    const killCalls: Array<{ target: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const runtime = new BackgroundShellRuntime({
      db,
      spawn: (() => {
        throw new Error('should not spawn');
      }) as unknown as SpawnFn,
      logSink: { open: () => ({ path: null, append: () => {} }) },
      kill: (target, signal) => {
        killCalls.push({ target, signal });
        alive = false;
      },
      readProcStartTime: () => 'instance-1',
      probeGroupAlive: () => alive,
      config: { killGraceMs: 1 },
    });
    await runtime.bootReconcile;
    db.prepare(
      `INSERT INTO background_shells
       (id, session_id, project_id, command, pid, pid_start_time, status, created_at, updated_at)
       VALUES ('orphan', 'sess-1', 'proj-1', 'sleep 999', 7000, 'instance-1', 'running', '2020-01-01', '2020-01-01')`,
    ).run();

    const result = await runtime.stop('orphan');
    expect(result!.status).toBe('stopped');
    expect(killCalls).toContainEqual({ target: -7000, signal: 'SIGTERM' });
  });
});

describe('BackgroundShellRuntime.stopBySessionId', () => {
  it('stops every running shell for the session and returns the count', async () => {
    const h = makeHarness();
    h.runtime.start(START);
    h.runtime.start({ ...START, command: 'sleep 1' });
    // A shell in another session must not be touched.
    const other = h.runtime.start({ ...START, sessionId: 'sess-2' });

    const count = await h.runtime.stopBySessionId('sess-1');
    expect(count).toBe(2);
    expect(h.runtime.getById(other.id)!.status).toBe('running');
    expect(h.runtime.list('sess-1').every((s) => s.status === 'stopped')).toBe(true);
  });

  it('disarms before killing, so session teardown cannot wake the session', async () => {
    const h = makeHarness();
    const watchAtFinalize: number[] = [];
    h.runtime.subscribeFinalize((row) => watchAtFinalize.push(row.watch));

    const row = h.runtime.start({ ...START, watch: true });
    // Session delete awaits this before the row is soft-deleted, so an armed
    // shell here would queue a wake against a session that still looks alive.
    await h.runtime.stopBySessionId('sess-1');

    expect(watchAtFinalize).toEqual([0]);
    expect(h.runtime.getById(row.id)!.watch).toBe(0);
    expect(h.runtime.getById(row.id)!.watch_resolved_at).not.toBeNull();
  });

  it('disarms armed shells that already finished, so no pending wake survives', async () => {
    const h = makeHarness();
    const done = h.runtime.start({ ...START, watch: true });
    h.children[0].emitExit(0);
    // Still armed: the watcher consumes the flag only once it dispatches.
    expect(h.runtime.getById(done.id)!.watch).toBe(1);
    const running = h.runtime.start({ ...START, label: 'still going', watch: true });

    await h.runtime.stopBySessionId('sess-1');

    expect(h.runtime.getById(done.id)!.watch).toBe(0);
    expect(h.runtime.getById(running.id)!.watch).toBe(0);
  });

  it('leaves other sessions armed', async () => {
    const h = makeHarness();
    const other = h.runtime.start({ ...START, sessionId: 'sess-2', watch: true });
    h.runtime.start({ ...START, watch: true });

    await h.runtime.stopBySessionId('sess-1');

    expect(h.runtime.getById(other.id)!.watch).toBe(1);
    expect(h.runtime.getById(other.id)!.status).toBe('running');
  });
});

describe('BackgroundShellRuntime.list / boot reconcile', () => {
  it('lists shells newest-first', () => {
    const h = makeHarness();
    const a = h.runtime.start({ ...START, command: 'first' });
    const b = h.runtime.start({ ...START, command: 'second' });
    const ids = h.runtime.list('sess-1').map((r) => r.id);
    expect(ids).toEqual([b.id, a.id]);
  });

  it('marks pre-existing running rows failed on construction (orphan reconcile)', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE background_shells (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
      command TEXT NOT NULL, label TEXT, cwd TEXT, pid INTEGER,
      status TEXT NOT NULL DEFAULT 'running', exit_code INTEGER, log_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    db.prepare(
      `INSERT INTO background_shells (id, session_id, project_id, command, status, created_at, updated_at)
       VALUES ('z', 's', 'p', 'sleep 999', 'running', '2020-01-01', '2020-01-01')`,
    ).run();

    const logSink: BackgroundShellLogSink = { open: () => ({ path: null, append: () => {} }) };
    const runtime = new BackgroundShellRuntime({
      db,
      spawn: (() => {
        throw new Error('should not spawn');
      }) as unknown as SpawnFn,
      logSink,
      clock: systemClock,
    });
    await runtime.bootReconcile;
    expect(runtime.getById('z')!.status).toBe('failed');
  });

  // The restart auto-resume names these shells in the resume prompt so the
  // agent stops polling work the Hub already killed. It runs on `listen`, which
  // races the async reap, so the list must come from a snapshot taken at
  // construction rather than a live `status = 'running'` query.
  it('exposes boot orphans per session after the reconcile has flipped them terminal', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE background_shells (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
      command TEXT NOT NULL, label TEXT, cwd TEXT, pid INTEGER,
      status TEXT NOT NULL DEFAULT 'running', exit_code INTEGER, log_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    const insert = db.prepare(
      `INSERT INTO background_shells (id, session_id, project_id, command, label, status, created_at, updated_at)
       VALUES (?, ?, 'p', ?, ?, ?, '2020-01-01', '2020-01-01')`,
    );
    insert.run('a', 'sess-a', 'pytest -q', 'backend tests', 'running');
    insert.run('b', 'sess-b', 'npm run dev', null, 'running');
    insert.run('c', 'sess-a', 'already done', null, 'exited');

    const logSink: BackgroundShellLogSink = { open: () => ({ path: null, append: () => {} }) };
    const runtime = new BackgroundShellRuntime({
      db,
      spawn: (() => {
        throw new Error('should not spawn');
      }) as unknown as SpawnFn,
      logSink,
      clock: systemClock,
    });
    await runtime.bootReconcile;

    expect(runtime.getById('a')!.status).toBe('failed');
    const orphans = runtime.listBootOrphans('sess-a');
    expect(orphans.map((r) => r.id)).toEqual(['a']);
    expect(orphans[0].command).toBe('pytest -q');
    expect(orphans[0].label).toBe('backend tests');
    expect(runtime.listBootOrphans('sess-b').map((r) => r.id)).toEqual(['b']);
    expect(runtime.listBootOrphans('sess-unknown')).toEqual([]);
  });

  it('does not report shells started by this Hub process as boot orphans', () => {
    const h = makeHarness();
    h.runtime.start({ ...START, command: 'fresh' });
    expect(h.runtime.listBootOrphans('sess-1')).toEqual([]);
  });

  it('broadcasts an update on start and on terminal transition', () => {
    const db = new Database(':memory:');
    const events: string[] = [];
    const logSink: BackgroundShellLogSink = { open: () => ({ path: null, append: () => {} }) };
    const children: FakeChild[] = [];
    const runtime = new BackgroundShellRuntime({
      db,
      spawn: (() => {
        const c = new FakeChild(42);
        children.push(c);
        return c as unknown as ChildProcess;
      }) as unknown as SpawnFn,
      logSink,
      broadcast: (e) => events.push(e.shell.status),
    });
    runtime.start(START);
    children[0].emitExit(0);
    expect(events).toEqual(['running', 'exited']);
  });
});

describe('BackgroundShellRuntime boot-orphan process reaping', () => {
  const SCHEMA = `CREATE TABLE background_shells (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    command TEXT NOT NULL, label TEXT, cwd TEXT, pid INTEGER, pid_start_time TEXT,
    status TEXT NOT NULL DEFAULT 'running', exit_code INTEGER, log_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`;
  const noopSink: BackgroundShellLogSink = { open: () => ({ path: null, append: () => {} }) };
  const neverSpawn = (() => {
    throw new Error('should not spawn');
  }) as unknown as SpawnFn;

  function seed(
    db: Database.Database,
    pid: number | null,
    command: string,
    pidStartTime: string | null,
  ) {
    db.prepare(
      `INSERT INTO background_shells
       (id, session_id, project_id, command, pid, pid_start_time, status, created_at, updated_at)
       VALUES ('orphan', 's', 'p', ?, ?, ?, 'running', '2020-01-01', '2020-01-01')`,
    ).run(command, pid, pidStartTime);
  }

  function build(
    pid: number | null,
    command: string,
    readProcArgv: (pid: number) => string[] | null,
    probeGroupAlive: (pid: number) => boolean = () => false,
    pidStartTime: string | null = null,
  ) {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    seed(db, pid, command, pidStartTime);
    const killCalls: Array<{ target: number; signal: NodeJS.Signals }> = [];
    const runtime = new BackgroundShellRuntime({
      db,
      spawn: neverSpawn,
      logSink: noopSink,
      kill: (target, signal) => killCalls.push({ target, signal }),
      readProcArgv,
      readProcStartTime: () => pidStartTime,
      probeGroupAlive,
      config: { killGraceMs: 1 },
    });
    return { runtime, killCalls };
  }

  const signals = (calls: Array<{ target: number; signal: NodeJS.Signals }>) =>
    calls.map((c) => c.signal);

  it('escalates SIGTERM→SIGKILL when the group ignores SIGTERM, then marks failed', async () => {
    // argv matches (ours) and the group stays alive through both probes.
    let probes = 0;
    const { runtime, killCalls } = build(
      4242,
      'sleep 999',
      () => ['sh', '-c', 'sleep 999'],
      () => ++probes < 3,
    );
    await runtime.bootReconcile;
    expect(killCalls).toContainEqual({ target: -4242, signal: 'SIGTERM' });
    expect(killCalls).toContainEqual({ target: -4242, signal: 'SIGKILL' });
    expect(runtime.getById('orphan')!.status).toBe('failed');
  });

  it('sends only SIGTERM when the group dies after it', async () => {
    let probes = 0;
    const { runtime, killCalls } = build(
      4242,
      'sleep 999',
      () => ['sh', '-c', 'sleep 999'],
      () => ++probes === 1, // alive before SIGTERM, gone after
    );
    await runtime.bootReconcile;
    expect(signals(killCalls)).toEqual(['SIGTERM']);
    expect(runtime.getById('orphan')!.status).toBe('failed');
  });

  it('skips signalling when the pid was reused by an unrelated process', async () => {
    const { runtime, killCalls } = build(
      4242,
      'sleep 999',
      () => ['python3', '-c', 'sleep 999'],
      () => true,
    );
    await runtime.bootReconcile;
    expect(killCalls).toHaveLength(0);
    // Keep it running so a later stop/archive can retry without losing track
    // of an OS process whose identity we could not safely verify.
    expect(runtime.getById('orphan')!.status).toBe('running');
  });

  it('does not signal when the group is already gone', async () => {
    const { runtime, killCalls } = build(
      4242,
      'sleep 999',
      () => ['sh', '-c', 'sleep 999'],
      () => false,
    );
    await runtime.bootReconcile;
    expect(killCalls).toHaveLength(0);
    expect(runtime.getById('orphan')!.status).toBe('failed');
  });

  it('keeps the row running when argv is unreadable (dead pid / non-Linux)', async () => {
    const { runtime, killCalls } = build(
      4242,
      'sleep 999',
      () => null,
      () => true,
    );
    await runtime.bootReconcile;
    expect(killCalls).toHaveLength(0);
    expect(runtime.getById('orphan')!.status).toBe('running');
  });

  it('reaps a shell-optimized exec using the stored process identity', async () => {
    let probes = 0;
    const { runtime, killCalls } = build(
      4242,
      'sleep 999',
      () => ['sleep', '999'],
      () => ++probes < 3,
      'instance-1',
    );
    await runtime.bootReconcile;
    expect(killCalls).toContainEqual({ target: -4242, signal: 'SIGTERM' });
    expect(runtime.getById('orphan')!.status).toBe('failed');
  });

  it('does not signal when the orphan row has no recorded pid', async () => {
    const { runtime, killCalls } = build(
      null,
      'sleep 999',
      () => ['sh', '-c', 'sleep 999'],
      () => true,
    );
    await runtime.bootReconcile;
    expect(killCalls).toHaveLength(0);
    expect(runtime.getById('orphan')!.status).toBe('failed');
  });
});

describe('BackgroundShellRuntime — watch surface', () => {
  it('starts unwatched by default so an explicit opt-in is required', () => {
    const h = makeHarness();
    expect(h.runtime.start(START).watch).toBe(0);
  });

  it('arms the watch when asked, and lists it while the shell runs', () => {
    const h = makeHarness();
    const row = h.runtime.start({ ...START, watch: true });

    expect(row.watch).toBe(1);
    expect(h.runtime.listWatched('sess-1').map((r) => r.id)).toEqual([row.id]);
  });

  it('drops a finished shell from listWatched — the indicator tracks live work', () => {
    const h = makeHarness();
    h.runtime.start({ ...START, watch: true });
    h.children[0].emitExit(0);

    expect(h.runtime.listWatched('sess-1')).toEqual([]);
  });

  it('scopes listWatched to one session', () => {
    const h = makeHarness();
    h.runtime.start({ ...START, watch: true });
    h.runtime.start({ ...START, sessionId: 'sess-2', watch: true });

    expect(h.runtime.listWatched('sess-1')).toHaveLength(1);
  });

  it('clearWatch stamps a resolution time and is idempotent', () => {
    const h = makeHarness();
    const row = h.runtime.start({ ...START, watch: true });

    h.runtime.clearWatch(row.id);
    const after = h.runtime.getById(row.id)!;
    expect(after.watch).toBe(0);
    expect(after.watch_resolved_at).toBeTruthy();

    h.runtime.clearWatch(row.id);
    expect(h.runtime.getById(row.id)!.watch_resolved_at).toBe(after.watch_resolved_at);
  });

  it('notifies subscribers on a clean exit', () => {
    const h = makeHarness();
    const seen: string[] = [];
    h.runtime.subscribeFinalize((row) => seen.push(`${row.id}:${row.status}`));

    const row = h.runtime.start({ ...START, watch: true });
    h.children[0].emitExit(0);

    expect(seen).toEqual([`${row.id}:exited`]);
  });

  it('notifies subscribers on a non-zero exit', () => {
    const h = makeHarness();
    const seen: string[] = [];
    h.runtime.subscribeFinalize((row) => seen.push(row.status));

    h.runtime.start({ ...START, watch: true });
    h.children[0].emitExit(3);

    expect(seen).toEqual(['failed']);
  });

  it('notifies subscribers when a shell is stopped, so the agent still hears about it', async () => {
    const h = makeHarness();
    const seen: string[] = [];
    h.runtime.subscribeFinalize((row) => seen.push(row.status));

    const row = h.runtime.start({ ...START, watch: true });
    await h.runtime.stop(row.id);

    expect(seen).toEqual(['stopped']);
  });

  it('disarms a spawn failure before notifying — the caller already has that result', () => {
    const h = makeHarness({ failSpawn: true });
    const watchAtFinalize: number[] = [];
    h.runtime.subscribeFinalize((row) => watchAtFinalize.push(row.watch));

    const row = h.runtime.start({ ...START, watch: true });

    // The subscriber still sees the row (every terminal path notifies), but
    // with `watch` already cleared, so the watch loop skips it and the session
    // isn't woken to be told something it learned synchronously.
    expect(watchAtFinalize).toEqual([0]);
    expect(row.status).toBe('failed');
    expect(h.runtime.getById(row.id)!.watch).toBe(0);
  });

  it('a throwing subscriber cannot wedge finalization', () => {
    const h = makeHarness();
    h.runtime.subscribeFinalize(() => {
      throw new Error('subscriber blew up');
    });
    const second: string[] = [];
    h.runtime.subscribeFinalize((row) => second.push(row.status));

    const row = h.runtime.start({ ...START, watch: true });
    expect(() => h.children[0].emitExit(0)).not.toThrow();

    expect(h.runtime.getById(row.id)!.status).toBe('exited');
    expect(second).toEqual(['exited']);
  });

  it('unsubscribing stops delivery', () => {
    const h = makeHarness();
    const seen: string[] = [];
    const off = h.runtime.subscribeFinalize((row) => seen.push(row.status));
    off();

    h.runtime.start({ ...START, watch: true });
    h.children[0].emitExit(0);

    expect(seen).toEqual([]);
  });

  it('cancelWatch disarms and kills every watched shell in the session', async () => {
    const h = makeHarness();
    const a = h.runtime.start({ ...START, watch: true });
    const b = h.runtime.start({ ...START, label: 'second', watch: true });
    const unwatched = h.runtime.start({ ...START, label: 'third' });

    const stopped = await h.runtime.cancelWatch('sess-1');

    expect(stopped.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(h.runtime.getById(a.id)!.watch).toBe(0);
    expect(h.runtime.getById(a.id)!.status).toBe('stopped');
    expect(h.runtime.getById(unwatched.id)!.status).toBe('running');
  });

  it('cancelWatch disarms before killing, so the teardown does not wake the session', async () => {
    const h = makeHarness();
    const watchedAtFinalize: number[] = [];
    h.runtime.subscribeFinalize((row) => watchedAtFinalize.push(row.watch));

    h.runtime.start({ ...START, watch: true });
    await h.runtime.cancelWatch('sess-1');

    expect(watchedAtFinalize).toEqual([0]);
  });

  it('listRunning spans sessions and excludes finished shells', () => {
    const h = makeHarness();
    h.runtime.start({ ...START, watch: true });
    h.runtime.start({ ...START, sessionId: 'sess-2' });
    const done = h.runtime.start({ ...START, label: 'done' });
    h.children[2].emitExit(0);

    const running = h.runtime.listRunning();
    expect(running.map((r) => r.session_id).sort()).toEqual(['sess-1', 'sess-2']);
    expect(running.some((r) => r.id === done.id)).toBe(false);
  });
});
