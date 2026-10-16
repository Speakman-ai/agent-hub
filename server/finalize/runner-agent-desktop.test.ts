import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import { PassThrough, Writable } from 'stream';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {
  runAgentDesktop,
  runDocker,
  type SpawnFn,
  type DesktopAgentDocker,
  type DesktopTransport,
} from './runner-agent-desktop.js';
import type { RunnerJobWireSpec } from './runner-backend-remote.js';

const SPEC: RunnerJobWireSpec = {
  orgId: 'o',
  projectId: 'p',
  runId: 'desktop-c1',
  jobId: 'desktop',
  matrixKey: 'desktop',
  image: 'agent-hub/desktop:test',
  composeProjectName: '',
  env: {},
  kind: 'desktop',
  desktop: { computerId: 'c1', controlToken: 'tok', memory: '2g', cpus: '1', restoreHome: true },
};

function fakeDocker(overrides: Partial<DesktopAgentDocker> = {}) {
  const events: string[] = [];
  const docker: DesktopAgentDocker = {
    createVolume: vi.fn(async (v) => void events.push(`volume:${v}`)),
    removeVolume: vi.fn(async () => void events.push('rmvolume')),
    restoreHome: vi.fn(
      async (_v, _i, file) => void events.push(`restore:${readFileSync(file, 'utf8')}`),
    ),
    snapshotHome: vi.fn(async (_v, _i, file) => {
      writeFileSync(file, 'snapshot');
      events.push('snapshot');
    }),
    startDesktop: vi.fn(
      async (argv, token) => void events.push(`start:${token}:${argv.includes('tok')}`),
    ),
    isRunning: vi.fn(async () => true),
    hostPort: vi.fn(async () => 32001),
    removeContainer: vi.fn(async () => void events.push('rm')),
    ...overrides,
  };
  return { docker, events };
}

function fakeTransport(opts: { home?: string | null; downloadFails?: boolean } = {}) {
  let gone = false;
  const uploads: string[] = [];
  const reports: unknown[] = [];
  const transport: DesktopTransport & { stop: () => void; uploads: string[]; reports: unknown[] } =
    {
      stop: () => {
        gone = true;
      },
      uploads,
      reports,
      postLogs: vi.fn(async () => {}),
      postFinish: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => ({ gone })),
      postEnvironment: vi.fn(async (_id, report) => {
        reports.push(report);
        return { gone: false };
      }),
      async downloadDesktopHome(_id, dest) {
        if (opts.downloadFails) throw new Error('download failed: 502');
        if (opts.home == null) return false;
        writeFileSync(dest, opts.home);
        return true;
      },
      async uploadDesktopHome(_id, file) {
        uploads.push(readFileSync(file, 'utf8'));
        return { outcome: 'accepted' as const };
      },
      reportDesktopHomeRejected: vi.fn(async () => {}),
      getDesktopHomeDecision: vi.fn(async () => 'hold' as const),
    };
  return transport;
}

const FAST = {
  heartbeatMs: 5,
  livenessMs: 5,
  readyRetryMs: 1,
  delivery: { attempts: 1, baseDelayMs: 1 },
  cleanupRetryMs: 1,
};

describe('runAgentDesktop', () => {
  it('restores the home, reports ready, and snapshots the home after the Hub stops it', async () => {
    const { docker, events } = fakeDocker();
    const transport = fakeTransport({ home: 'old-home' });
    const run = runAgentDesktop({
      jobId: 'job-1',
      spec: SPEC,
      transport,
      docker,
      resolveHost: async () => '10.0.0.5',
      ...FAST,
    });
    await vi.waitFor(() => expect(transport.reports).toHaveLength(1));
    expect(transport.reports[0]).toEqual({ status: 'ready', host: '10.0.0.5', port: 32001 });
    transport.stop();
    const res = await run;
    expect(res).toEqual({ ready: true, error: 'stopped', home: 'accepted' });
    // The token goes through the env, never argv.
    expect(events).toEqual([
      'volume:agent-hub-desktop-home-c1-job1',
      'restore:old-home',
      'start:tok:false',
      'rm',
      'snapshot',
      'rmvolume',
    ]);
    expect(transport.uploads).toEqual(['snapshot']);
    expect(transport.postFinish).toHaveBeenCalledWith('job-1', 0, null);
  });

  it('never uploads a home it failed to restore', async () => {
    const { docker, events } = fakeDocker();
    const transport = fakeTransport({ downloadFails: true });
    const res = await runAgentDesktop({ jobId: 'job-2', spec: SPEC, transport, docker, ...FAST });
    expect(res.home).toBe('not-saved');
    expect(res.error).toMatch(/download failed/);
    expect(events).not.toContain('snapshot');
    expect(transport.uploads).toEqual([]);
    expect(transport.reports).toEqual([{ status: 'lost', detail: 'download failed: 502' }]);
  });

  it('reports a dead container as lost and still saves its home', async () => {
    const { docker } = fakeDocker({ isRunning: vi.fn(async () => false) });
    const transport = fakeTransport({ home: null });
    const res = await runAgentDesktop({
      jobId: 'job-3',
      spec: { ...SPEC, desktop: { ...SPEC.desktop!, restoreHome: false } },
      transport,
      docker,
      resolveHost: async () => 'h',
      ...FAST,
    });
    expect(res).toMatchObject({
      ready: false,
      error: 'the desktop container stopped',
      home: 'accepted',
    });
    expect(transport.reports.at(-1)).toEqual({
      status: 'lost',
      detail: 'the desktop container stopped',
    });
    expect(docker.restoreHome).not.toHaveBeenCalled();
  });

  it('refuses to start, and never uploads, when an expected home is missing', async () => {
    const { docker, events } = fakeDocker();
    const transport = fakeTransport({ home: null });
    const res = await runAgentDesktop({ jobId: 'job-4', spec: SPEC, transport, docker, ...FAST });
    expect(res).toMatchObject({ ready: false, home: 'not-saved' });
    expect(res.error).toMatch(/could not be found; refusing to start empty/);
    expect(docker.startDesktop).not.toHaveBeenCalled();
    expect(events).not.toContain('snapshot');
    expect(transport.uploads).toEqual([]);
    expect(transport.reports).toEqual([{ status: 'lost', detail: res.error }]);
  });

  it('snapshots only after the container is confirmed removed, retrying the removal', async () => {
    let failures = 2;
    const { docker, events } = fakeDocker({
      removeContainer: vi.fn(async () => {
        if (failures-- > 0) throw new Error('Cannot connect to the Docker daemon');
        events.push('rm');
      }),
    });
    const transport = fakeTransport({ home: 'old-home' });
    const run = runAgentDesktop({
      jobId: 'job-5',
      spec: SPEC,
      transport,
      docker,
      resolveHost: async () => 'h',
      ...FAST,
    });
    await vi.waitFor(() => expect(transport.reports).toHaveLength(1));
    transport.stop();
    const res = await run;
    expect(docker.removeContainer).toHaveBeenCalledTimes(3);
    expect(events.slice(-3)).toEqual(['rm', 'snapshot', 'rmvolume']);
    expect(res.home).toBe('accepted');
  });

  it('keeps the home and the job until a failing upload is accepted', async () => {
    const { docker, events } = fakeDocker();
    const transport = fakeTransport({ home: 'old-home' });
    let attempts = 0;
    let snapshotKeptWhileFailing = true;
    let finishedWhileFailing = false;
    transport.uploadDesktopHome = async (_id, file) => {
      attempts++;
      if (attempts <= 3) {
        snapshotKeptWhileFailing &&= existsSync(file) && !events.includes('rmvolume');
        finishedWhileFailing ||= vi.mocked(transport.postFinish).mock.calls.length > 0;
        throw new Error('desktop home upload failed: 503');
      }
      transport.uploads.push(readFileSync(file, 'utf8'));
      return { outcome: 'accepted' as const };
    };
    const run = runAgentDesktop({
      jobId: 'job-8',
      spec: SPEC,
      transport,
      docker,
      resolveHost: async () => 'h',
      ...FAST,
    });
    await vi.waitFor(() => expect(transport.reports).toHaveLength(1));
    transport.stop();
    const heartbeatsBeforeTeardown = vi.mocked(transport.heartbeat).mock.calls.length;
    const res = await run;
    expect(attempts).toBe(4);
    expect(snapshotKeptWhileFailing).toBe(true);
    expect(finishedWhileFailing).toBe(false);
    expect(res.home).toBe('accepted');
    expect(transport.uploads).toEqual(['snapshot']);
    expect(events.at(-1)).toBe('rmvolume');
    expect(transport.postFinish).toHaveBeenCalledTimes(1);
    // Heartbeats kept the Hub holding the job during teardown.
    expect(vi.mocked(transport.heartbeat).mock.calls.length).toBeGreaterThan(
      heartbeatsBeforeTeardown,
    );
  });

  it('parks on a home the Hub refuses for good, holding the job until told to discard it', async () => {
    const { docker, events } = fakeDocker();
    const transport = fakeTransport({ home: 'old-home' });
    transport.uploadDesktopHome = vi.fn(async () => ({
      outcome: 'rejected' as const,
      detail: 'home snapshot exceeds 4294967296 bytes',
    }));
    const decisions = ['hold', 'hold', 'discard'] as const;
    let asked = 0;
    let finishedWhileParked = false;
    let volumeGoneWhileParked = false;
    transport.getDesktopHomeDecision = vi.fn(async () => {
      finishedWhileParked ||= vi.mocked(transport.postFinish).mock.calls.length > 0;
      volumeGoneWhileParked ||= events.includes('rmvolume');
      return decisions[Math.min(asked++, decisions.length - 1)];
    });
    const run = runAgentDesktop({
      jobId: 'job-14',
      spec: SPEC,
      transport,
      docker,
      resolveHost: async () => 'h',
      ...FAST,
      decisionPollMs: 1,
    });
    await vi.waitFor(() => expect(transport.reports).toHaveLength(1));
    transport.stop();
    const res = await run;
    // Not resent: the same file can never fit.
    expect(transport.uploadDesktopHome).toHaveBeenCalledTimes(1);
    expect(transport.reportDesktopHomeRejected).toHaveBeenCalledWith(
      'job-14',
      expect.stringMatching(
        /exceeds 4294967296 bytes.*docker volume agent-hub-desktop-home-c1-job14/,
      ),
    );
    // Parked: the job and the only copy were held until the Hub decided.
    expect(asked).toBe(3);
    expect(finishedWhileParked).toBe(false);
    expect(volumeGoneWhileParked).toBe(false);
    // Discarded: the copy is removed before the job finishes.
    expect(res.home).toBe('discarded');
    expect(events.at(-1)).toBe('rmvolume');
    expect(transport.postFinish).toHaveBeenCalledTimes(1);
  });

  it('uploads a parked home again when the Hub says retry', async () => {
    const { docker } = fakeDocker();
    const transport = fakeTransport({ home: 'old-home' });
    let attempt = 0;
    transport.uploadDesktopHome = vi.fn(async () =>
      ++attempt === 1
        ? { outcome: 'rejected' as const, detail: 'too large' }
        : { outcome: 'accepted' as const },
    );
    transport.getDesktopHomeDecision = vi.fn(async () => 'retry' as const);
    const run = runAgentDesktop({
      jobId: 'job-15',
      spec: SPEC,
      transport,
      docker,
      resolveHost: async () => 'h',
      ...FAST,
    });
    await vi.waitFor(() => expect(transport.reports).toHaveLength(1));
    transport.stop();
    const res = await run;
    expect(res.home).toBe('accepted');
    expect(docker.snapshotHome).toHaveBeenCalledTimes(2);
    expect(transport.uploadDesktopHome).toHaveBeenCalledTimes(2);
  });

  it('keeps sending the finish, heartbeating, until the Hub acknowledges it', async () => {
    const { docker } = fakeDocker();
    const transport = fakeTransport({ home: 'old-home' });
    const protection = { set: vi.fn(async () => {}) };
    let fails = 5;
    const heartbeatsAtFinish: number[] = [];
    transport.postFinish = vi.fn(async () => {
      heartbeatsAtFinish.push(vi.mocked(transport.heartbeat).mock.calls.length);
      if (fails-- > 0) throw new Error('finish post failed: 503');
    });
    const run = runAgentDesktop({
      jobId: 'job-16',
      spec: SPEC,
      transport,
      docker,
      protection,
      resolveHost: async () => 'h',
      ...FAST,
    });
    await vi.waitFor(() => expect(transport.reports).toHaveLength(1));
    transport.stop();
    await run;
    // More than any bounded delivery would try, and only then let go.
    expect(transport.postFinish).toHaveBeenCalledTimes(6);
    // Heartbeats kept going between the failed attempts.
    expect(heartbeatsAtFinish.at(-1)!).toBeGreaterThan(heartbeatsAtFinish[0]);
    expect(protection.set).toHaveBeenLastCalledWith(false);
  });

  it('stops sending the finish once the Hub no longer has the job', async () => {
    const { docker } = fakeDocker();
    const transport = fakeTransport({ home: null });
    transport.postFinish = vi.fn(async () => {
      throw new Error('finish post failed: 404');
    });
    await runAgentDesktop({
      jobId: 'job-17',
      spec: { ...SPEC, desktop: { ...SPEC.desktop!, restoreHome: false } },
      transport,
      docker,
      resolveHost: async () => 'h',
      ...FAST,
      selfStopMs: 1,
      watchdogMs: 1,
    });
    expect(transport.postFinish).toHaveBeenCalledTimes(1);
  });

  it('holds through many liveness polls without piling up abort listeners', async () => {
    // Count live 'abort' listeners per signal while the run holds.
    const live = new Map<EventTarget, number>();
    const proto = EventTarget.prototype;
    const realAdd = proto.addEventListener;
    const realRemove = proto.removeEventListener;
    proto.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      if (type === 'abort') live.set(this, (live.get(this) ?? 0) + 1);
      return (realAdd as (...a: unknown[]) => void).call(this, type, ...rest);
    } as typeof proto.addEventListener;
    proto.removeEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      if (type === 'abort') live.set(this, Math.max(0, (live.get(this) ?? 0) - 1));
      return (realRemove as (...a: unknown[]) => void).call(this, type, ...rest);
    } as typeof proto.removeEventListener;
    try {
      const { docker } = fakeDocker();
      const transport = fakeTransport({ home: 'old-home' });
      const run = runAgentDesktop({
        jobId: 'job-18',
        spec: SPEC,
        transport,
        docker,
        resolveHost: async () => 'h',
        ...FAST,
        livenessMs: 1,
      });
      await vi.waitFor(() =>
        expect(vi.mocked(docker.isRunning).mock.calls.length).toBeGreaterThan(30),
      );
      // One sleep and one inspect race at a time, not one per past poll.
      expect(Math.max(0, ...live.values())).toBeLessThanOrEqual(3);
      transport.stop();
      await run;
    } finally {
      proto.addEventListener = realAdd;
      proto.removeEventListener = realRemove;
    }
  });

  it('clears spools a previous run left, and removes its own before finishing', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-spool-'));
    try {
      const leftover = path.join(tmpRoot, 'agent-hub-desktop-spool', 'job-old');
      mkdirSync(leftover, { recursive: true });
      writeFileSync(path.join(leftover, 'snapshot.tar.gz'), 'old copy');
      const { docker } = fakeDocker();
      const transport = fakeTransport({ home: 'old-home' });
      let failures = 2;
      let finishedWithSpool = false;
      const removeDir = vi.fn(async (d: string) => {
        if (d.includes('job-old')) return rmSync(d, { recursive: true, force: true });
        if (failures-- > 0) throw new Error('EBUSY');
        rmSync(d, { recursive: true, force: true });
      });
      transport.postFinish = vi.fn(async () => {
        finishedWithSpool = readdirSync(path.join(tmpRoot, 'agent-hub-desktop-spool')).length > 0;
      });
      const run = runAgentDesktop({
        jobId: 'job-19',
        spec: SPEC,
        transport,
        docker,
        resolveHost: async () => 'h',
        ...FAST,
        tmpRoot,
        removeDir,
      });
      await vi.waitFor(() => expect(transport.reports).toHaveLength(1));
      expect(existsSync(leftover)).toBe(false);
      transport.stop();
      await run;
      // Retried until gone, and only then the finish.
      expect(finishedWithSpool).toBe(false);
      expect(readdirSync(path.join(tmpRoot, 'agent-hub-desktop-spool'))).toEqual([]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('a spool that cannot be set up still ends the run cleanly: no timers or protection survive', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'agent-spool-fail-'));
    try {
      // The spool root is a file, so creating it fails (like a full or unreadable disk).
      const tmpRoot = path.join(base, 'not-a-dir');
      writeFileSync(tmpRoot, 'x');
      const { docker } = fakeDocker();
      const transport = fakeTransport({ home: 'old-home' });
      const protection = { set: vi.fn(async () => {}) };
      const res = await runAgentDesktop({
        jobId: 'job-20',
        spec: SPEC,
        transport,
        docker,
        protection,
        ...FAST,
        tmpRoot,
      });
      expect(res.ready).toBe(false);
      expect(res.error).toMatch(/ENOTDIR|EEXIST/);
      expect(docker.createVolume).not.toHaveBeenCalled();
      expect(transport.postFinish).toHaveBeenCalledTimes(1);
      expect(protection.set).toHaveBeenLastCalledWith(false);

      // Several heartbeat periods later, nothing is still ticking.
      const heartbeats = vi.mocked(transport.heartbeat).mock.calls.length;
      const renewals = protection.set.mock.calls.length;
      await new Promise((r) => setTimeout(r, 40));
      expect(vi.mocked(transport.heartbeat).mock.calls.length).toBe(heartbeats);
      expect(protection.set.mock.calls.length).toBe(renewals);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('stops retrying when the Hub discards the home', async () => {
    const { docker } = fakeDocker();
    const transport = fakeTransport({ home: 'old-home' });
    transport.uploadDesktopHome = vi.fn(async () => ({ outcome: 'discarded' as const }));
    const run = runAgentDesktop({
      jobId: 'job-9',
      spec: SPEC,
      transport,
      docker,
      resolveHost: async () => 'h',
      ...FAST,
    });
    await vi.waitFor(() => expect(transport.reports).toHaveLength(1));
    transport.stop();
    const res = await run;
    expect(res.home).toBe('discarded');
    expect(transport.uploadDesktopHome).toHaveBeenCalledTimes(1);
    expect(transport.postFinish).toHaveBeenCalled();
  });

  it('stops a desktop whose ready report never lands while the Hub is unreachable', async () => {
    const { docker, events } = fakeDocker();
    const transport = fakeTransport({ home: null });
    transport.heartbeat = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    transport.postEnvironment = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    let t = 0;
    const res = await runAgentDesktop({
      jobId: 'job-11',
      spec: { ...SPEC, desktop: { ...SPEC.desktop!, restoreHome: false } },
      transport,
      docker,
      resolveHost: async () => 'h',
      ...FAST,
      readyRetryMs: 2,
      selfStopMs: 50,
      watchdogMs: 1,
      now: () => (t += 5),
    });
    expect(res.ready).toBe(false);
    expect(res.error).toMatch(/lost contact with the Hub/);
    // The container that came up is removed and its home still saved.
    expect(events).toEqual(expect.arrayContaining(['rm', 'snapshot']));
    expect(events.indexOf('rm')).toBeLessThan(events.indexOf('snapshot'));
  });

  it('stops during startup when the deadline passes in a slow home download', async () => {
    const { docker } = fakeDocker();
    const transport = fakeTransport({ home: 'old-home' });
    transport.heartbeat = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    transport.downloadDesktopHome = () => new Promise<boolean>(() => {});
    let t = 0;
    const res = await runAgentDesktop({
      jobId: 'job-12',
      spec: SPEC,
      transport,
      docker,
      ...FAST,
      selfStopMs: 50,
      watchdogMs: 1,
      now: () => (t += 5),
    });
    expect(res.error).toMatch(/lost contact with the Hub/);
    expect(docker.startDesktop).not.toHaveBeenCalled();
    // A home that never restored is never uploaded over the saved one.
    expect(res.home).toBe('not-saved');
    expect(docker.removeVolume).toHaveBeenCalled();
  });

  it('leaves the hold for teardown even while a docker inspect hangs', async () => {
    const { docker, events } = fakeDocker({
      isRunning: vi.fn(() => new Promise<boolean>(() => {})),
    });
    const transport = fakeTransport({ home: 'old-home' });
    const run = runAgentDesktop({
      jobId: 'job-13',
      spec: SPEC,
      transport,
      docker,
      resolveHost: async () => 'h',
      ...FAST,
    });
    await vi.waitFor(() => expect(docker.isRunning).toHaveBeenCalled());
    transport.stop();
    const res = await run;
    expect(res.error).toBe('stopped');
    expect(events).toEqual(expect.arrayContaining(['rm', 'snapshot']));
  });

  it('stops its own desktop after losing contact with the Hub, then saves the home', async () => {
    const { docker, events } = fakeDocker();
    const transport = fakeTransport({ home: 'old-home' });
    transport.heartbeat = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    let t = 0;
    const res = await runAgentDesktop({
      jobId: 'job-10',
      spec: SPEC,
      transport,
      docker,
      resolveHost: async () => 'h',
      ...FAST,
      selfStopMs: 50,
      now: () => (t += 10),
    });
    expect(res.error).toMatch(/lost contact with the Hub/);
    expect(events).toContain('rm');
    expect(res.home).toBe('accepted');
  });

  it('retries the volume removal until done before finishing', async () => {
    let failures = 2;
    const { docker } = fakeDocker({
      removeVolume: vi.fn(async () => {
        if (failures-- > 0) throw new Error('volume is in use');
      }),
    });
    const transport = fakeTransport({ home: 'old-home' });
    const run = runAgentDesktop({
      jobId: 'job-6',
      spec: SPEC,
      transport,
      docker,
      resolveHost: async () => 'h',
      ...FAST,
    });
    await vi.waitFor(() => expect(transport.reports).toHaveLength(1));
    transport.stop();
    const res = await run;
    expect(res.home).toBe('accepted');
    expect(docker.removeVolume).toHaveBeenCalledTimes(3);
    expect(transport.postFinish).toHaveBeenCalledTimes(1);
  });
});

describe('runAgentDesktop start failures', () => {
  it('removes a container left by a failed docker run', async () => {
    const { docker } = fakeDocker({
      startDesktop: vi.fn(async () => {
        throw new Error('docker run exited 125');
      }),
    });
    const res = await runAgentDesktop({
      jobId: 'job-7',
      spec: { ...SPEC, desktop: { ...SPEC.desktop!, restoreHome: false } },
      transport: fakeTransport({}),
      docker,
      ...FAST,
    });
    expect(res.error).toMatch(/exited 125/);
    expect(docker.removeContainer).toHaveBeenCalled();
  });
});

describe('runDocker streams', () => {
  function fakeChild(opts: { stdin?: Writable; exitCode?: number | null; stderr?: string }) {
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable | null;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = opts.stdin ?? new PassThrough();
    child.kill = vi.fn(() => {
      child.stdout.end();
      setImmediate(() => child.emit('close', null));
      return true;
    });
    const finish = () => {
      if (opts.stderr) child.stderr.write(opts.stderr);
      child.stdout.end();
      setImmediate(() => child.emit('close', opts.exitCode ?? 0));
    };
    return { child, finish };
  }

  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'run-docker-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('writes stdout to the file', async () => {
    const { child, finish } = fakeChild({});
    const spawnImpl: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.write('tar-bytes');
        finish();
      });
      return child as unknown as ReturnType<SpawnFn>;
    };
    const out = path.join(tmp, 'snap.tgz');
    await runDocker(['run'], { stdoutFile: out }, spawnImpl);
    expect(readFileSync(out, 'utf8')).toBe('tar-bytes');
  });

  it('rejects and kills the child when the output file cannot be written', async () => {
    const { child } = fakeChild({});
    const spawnImpl: SpawnFn = () => {
      setImmediate(() => child.stdout.write('tar-bytes'));
      return child as unknown as ReturnType<SpawnFn>;
    };
    const out = path.join(tmp, 'no-such-dir', 'snap.tgz');
    await expect(runDocker(['run'], { stdoutFile: out }, spawnImpl)).rejects.toThrow(
      /docker run stream failed: ENOENT/,
    );
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects when the child closes stdin early', async () => {
    const stdin = new Writable({
      write(_chunk, _enc, cb) {
        cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });
    const { child } = fakeChild({ stdin });
    const spawnImpl: SpawnFn = () => {
      setImmediate(() => child.stderr.write('tar: invalid magic'));
      return child as unknown as ReturnType<SpawnFn>;
    };
    const input = path.join(tmp, 'home.tgz');
    writeFileSync(input, 'x'.repeat(1024));
    await expect(runDocker(['run'], { stdinFile: input }, spawnImpl)).rejects.toThrow(
      /stream failed: write EPIPE/,
    );
    expect(child.kill).toHaveBeenCalled();
  });

  it('surfaces a non-zero exit with stderr, and a spawn error as itself', async () => {
    const { child, finish } = fakeChild({ exitCode: 2, stderr: 'no space left' });
    const failing: SpawnFn = () => {
      setImmediate(finish);
      return child as unknown as ReturnType<SpawnFn>;
    };
    await expect(runDocker(['run'], {}, failing)).rejects.toThrow(
      /docker run exited 2: no space left/,
    );

    const { child: c2 } = fakeChild({});
    const missing: SpawnFn = () => {
      setImmediate(() => c2.emit('error', new Error('spawn docker ENOENT')));
      return c2 as unknown as ReturnType<SpawnFn>;
    };
    const input = path.join(tmp, 'home.tgz');
    writeFileSync(input, 'x');
    await expect(runDocker(['run'], { stdinFile: input }, missing)).rejects.toThrow(
      /spawn docker ENOENT/,
    );
  });
});
