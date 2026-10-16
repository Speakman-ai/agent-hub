import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import {
  __resetSecretCryptoForTests,
  __setSecretCryptoKeyFilePathForTests,
} from '../secret-crypto.js';
import {
  createContainerDesktopRuntime,
  DesktopCapacityError,
  DesktopStartError,
  type ContainerDesktopRuntimeDeps,
} from './container-desktop-runtime.js';
import type {
  DesktopContainerHost,
  DesktopHostStartRequest,
  DesktopHostStatus,
} from './container-desktop-host.js';
import { DesktopUnreachableError, type DesktopControlClient } from './desktop-control-client.js';
import {
  getDesktopComputer,
  getOrCreateDesktopComputer,
  recordDesktopStarted,
} from './desktop-containers-store.js';
import { DESKTOP_IDLE_STOP_MS } from './desktop-runtime.js';
import { DesktopComputerDeletingError } from './desktop-deletion-guard.js';
import type { DesktopContainerPlacement } from './desktop-runtime-selection.js';

const KEY = { userId: 'u1', agentId: 'a1', projectId: 'p1' };
const KEY2 = { userId: 'u2', agentId: 'a1', projectId: 'p1' };

interface FakeHost extends DesktopContainerHost {
  starts: DesktopHostStartRequest[];
  stops: string[];
  deletedHomes: string[];
  statuses: Map<string, DesktopHostStatus>;
  /** Whether `stop` confirms the container gone (false: a runner still holds it). */
  confirmStops: boolean;
}

function fakeHost(
  placement: DesktopContainerPlacement = 'hub-docker',
  opts: { initial?: DesktopHostStatus; confirmStops?: boolean } = {},
): FakeHost {
  let n = 0;
  const host: FakeHost = {
    placement,
    confirmStops: opts.confirmStops ?? true,
    starts: [],
    stops: [],
    deletedHomes: [],
    statuses: new Map(),
    allocateRef: () => `ref-${++n}`,
    async start(req) {
      host.starts.push(req);
      const ref = req.runnerRef;
      host.statuses.set(
        ref,
        opts.initial ?? {
          state: 'running',
          endpoint: { host: '127.0.0.1', port: 40000 + Number(ref.slice(4)) },
          detail: null,
        },
      );
      return {
        homeRef: placement === 'hub-docker' ? `vol-${req.computerId}` : req.homeRef,
      };
    },
    async status(ref) {
      return host.statuses.get(ref) ?? { state: 'lost', endpoint: null, detail: 'gone' };
    },
    async stop(ref) {
      host.stops.push(ref);
      host.statuses.set(ref, { state: 'stopped', endpoint: null, detail: null });
      return { confirmed: host.confirmStops };
    },
    async deleteHome(id) {
      host.deletedHomes.push(id);
    },
  };
  return host;
}

function fakeClient(): DesktopControlClient & { op: ReturnType<typeof vi.fn> } {
  return {
    healthy: vi.fn(async () => true),
    op: vi.fn(async (_e, _t, body: Record<string, unknown>) => {
      if (body.op === 'screenshot') return { ok: true, png: Buffer.from('PNG').toString('base64') };
      if (body.op === 'exec')
        return { ok: true, exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false };
      return { ok: true };
    }),
  };
}

let dir: string;
let clock: number;

function makeRuntime(
  host: DesktopContainerHost,
  client: DesktopControlClient,
  extra: Partial<ContainerDesktopRuntimeDeps> = {},
) {
  return createContainerDesktopRuntime({
    host,
    client,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    startTimer: () => ({ stop: () => {} }),
    newToken: () => 'tok',
    log: () => {},
    ...extra,
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'desktop-runtime-'));
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  __resetSecretCryptoForTests();
  __setSecretCryptoKeyFilePathForTests(path.join(dir, 'secret.key'));
  initOrgsDb();
  clock = 1_000_000;
});

afterEach(() => {
  setOrgsDbPathForTests(null);
  __setSecretCryptoKeyFilePathForTests(null);
  __resetSecretCryptoForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('container desktop runtime', () => {
  it('starts one container for concurrent callers of the same computer', async () => {
    const host = fakeHost();
    const rt = makeRuntime(host, fakeClient());
    const [a, b] = await Promise.all([rt.ensureStarted(KEY), rt.ensureStarted(KEY)]);
    expect(a.state).toBe('running');
    expect(b.state).toBe('running');
    expect(host.starts).toHaveLength(1);
    expect(getDesktopComputer(KEY)).toMatchObject({ runnerRef: 'ref-1', placement: 'hub-docker' });
    expect(rt.runningCount()).toBe(1);
  });

  it('runs ops against the daemon and resumes a stopped computer on the next op', async () => {
    const host = fakeHost();
    const client = fakeClient();
    const rt = makeRuntime(host, client);
    expect((await rt.screenshot(KEY)).toString()).toBe('PNG');
    const id = getDesktopComputer(KEY)!.id;
    await rt.stop(KEY);
    expect((await rt.status(KEY)).state).toBe('stopped');
    expect(getDesktopComputer(KEY)!.runnerRef).toBeNull();

    const res = await rt.exec(KEY, 'echo hi', { timeoutMs: 5_000 });
    expect(res).toEqual({ exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false });
    // Same computer (and so the same home), a fresh container.
    expect(host.starts.map((s) => s.computerId)).toEqual([id, id]);
    expect(host.starts[1].homeRef).toBe(`vol-${id}`);
    expect(client.op).toHaveBeenLastCalledWith(
      { host: '127.0.0.1', port: 40002 },
      'tok',
      { op: 'exec', command: 'echo hi', timeoutMs: 5_000 },
      20_000,
    );
  });

  it('viewFrame captures a running computer without starting or touching it', async () => {
    const host = fakeHost();
    const rt = makeRuntime(host, fakeClient());
    expect(await rt.viewFrame(KEY)).toBeNull();
    expect(host.starts).toHaveLength(0);

    await rt.ensureStarted(KEY);
    const before = (await rt.status(KEY)).lastActiveAt;
    clock += 60_000;
    expect((await rt.viewFrame(KEY))?.toString()).toBe('PNG');
    expect((await rt.status(KEY)).lastActiveAt).toBe(before);
    // Watching alone does not hold off the idle stop.
    clock += DESKTOP_IDLE_STOP_MS;
    expect(await rt.sweepIdle()).toHaveLength(1);
    expect(await rt.viewFrame(KEY)).toBeNull();
    expect(host.starts).toHaveLength(1);
  });

  it('maps input events onto daemon ops', async () => {
    const client = fakeClient();
    const rt = makeRuntime(fakeHost(), client);
    await rt.input(KEY, { type: 'drag', fromX: 1, fromY: 2, toX: 3, toY: 4 });
    await rt.input(KEY, { type: 'move', x: 10, y: 20 });
    expect(client.op.mock.calls[0][2]).toEqual({ op: 'drag', x: 1, y: 2, toX: 3, toY: 4 });
    expect(client.op.mock.calls[1][2]).toMatchObject({
      op: 'exec',
      command: 'xdotool mousemove --sync 10 20',
    });
  });

  it('stops a computer after 30 idle minutes and not before', async () => {
    const host = fakeHost();
    const rt = makeRuntime(host, fakeClient());
    await rt.screenshot(KEY);
    clock += DESKTOP_IDLE_STOP_MS - 1;
    expect(await rt.sweepIdle()).toEqual([]);
    await rt.screenshot(KEY); // activity resets the clock
    clock += DESKTOP_IDLE_STOP_MS - 1;
    expect(await rt.sweepIdle()).toEqual([]);
    clock += 1;
    const stopped = await rt.sweepIdle();
    expect(stopped).toEqual([getDesktopComputer(KEY)!.id]);
    expect(host.stops).toEqual(['ref-1']);
    expect((await rt.status(KEY)).state).toBe('stopped');
    expect(rt.runningCount()).toBe(0);
  });

  it('does not idle-stop a computer while an op is in flight', async () => {
    const host = fakeHost();
    const client = fakeClient();
    let release!: () => void;
    const rt = makeRuntime(host, client);
    await rt.ensureStarted(KEY);
    client.op.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ ok: true, exitCode: 0 }))),
    );
    const pending = rt.exec(KEY, 'sleep 3600');
    await new Promise((r) => setImmediate(r));
    clock += DESKTOP_IDLE_STOP_MS * 2;
    expect(await rt.sweepIdle()).toEqual([]);
    release();
    await pending;
    expect(host.stops).toEqual([]);
  });

  it('refuses a start past the capacity cap with an explanation, and frees the slot on stop', async () => {
    const host = fakeHost();
    const rt = makeRuntime(host, fakeClient(), { maxRunning: 1 });
    await rt.ensureStarted(KEY);
    const err = await rt.screenshot(KEY2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesktopCapacityError);
    expect((err as Error).message).toMatch(/All 1 desktop slots on this Hub are in use/);
    expect((err as Error).message).toMatch(/30 minutes without a computer call/);
    expect((err as Error).message).toMatch(/AGENT_HUB_DESKTOP_MAX_RUNNING/);
    expect(host.starts).toHaveLength(1);

    await rt.stop(KEY);
    await expect(rt.ensureStarted(KEY2)).resolves.toMatchObject({ state: 'running' });
  });

  it('does not let concurrent starts of different computers overshoot the cap', async () => {
    const rt = makeRuntime(fakeHost(), fakeClient(), { maxRunning: 1 });
    const results = await Promise.allSettled([rt.ensureStarted(KEY), rt.ensureStarted(KEY2)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('fails with a clear error when no runner picks the desktop up', async () => {
    const host = fakeHost('runner-fleet', {
      initial: { state: 'pending', endpoint: null, detail: null },
    });
    const rt = makeRuntime(host, fakeClient(), { startTimeoutMs: 60_000, pollMs: 5_000 });
    const err = await rt.ensureStarted(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesktopStartError);
    expect((err as Error).message).toMatch(/No runner picked up the desktop within 1 minutes/);
    expect(host.stops).toEqual(['ref-1']);
    expect(await rt.status(KEY)).toMatchObject({ state: 'error' });
    expect(rt.runningCount()).toBe(0);
  });

  it('restarts and retries once when the container died under an op', async () => {
    const host = fakeHost();
    const client = fakeClient();
    const rt = makeRuntime(host, client);
    await rt.ensureStarted(KEY);
    host.statuses.set('ref-1', { state: 'lost', endpoint: null, detail: 'oom' });
    client.op.mockRejectedValueOnce(new DesktopUnreachableError('ECONNREFUSED'));
    expect((await rt.screenshot(KEY)).toString()).toBe('PNG');
    expect(host.starts).toHaveLength(2);
  });

  it('keeps the ref and slot after a stop its runner has not confirmed', async () => {
    const host = fakeHost('runner-fleet', { confirmStops: false });
    const rt = makeRuntime(host, fakeClient(), { maxRunning: 1 });
    await rt.ensureStarted(KEY);
    await rt.stop(KEY);
    expect(await rt.status(KEY)).toMatchObject({ state: 'stopping' });
    expect(getDesktopComputer(KEY)!.runnerRef).toBe('ref-1');
    expect(rt.runningCount()).toBe(1);
    await expect(rt.ensureStarted(KEY2)).rejects.toBeInstanceOf(DesktopCapacityError);

    // The runner finishes (container removed, home saved): the next sweep
    // confirms it and the slot frees.
    host.confirmStops = true;
    await rt.sweepIdle();
    expect(getDesktopComputer(KEY)!.runnerRef).toBeNull();
    expect(rt.runningCount()).toBe(0);
  });

  it('starts with a fresh home when the computer last ran on another placement', async () => {
    const rec = getOrCreateDesktopComputer(KEY, 'hub-docker');
    recordDesktopStarted({
      id: rec.id,
      placement: 'hub-docker',
      runnerRef: 'old',
      controlToken: 't',
      homeRef: 'vol-old',
      now: clock,
    });
    const oldHost = fakeHost('hub-docker');
    oldHost.statuses.set('old', { state: 'running', endpoint: null, detail: null });
    const host = fakeHost('runner-fleet');
    const rt = makeRuntime(host, fakeClient(), { hostFor: () => oldHost });
    await rt.ensureStarted(KEY);
    // The old container is stopped through its own placement, never forgotten.
    expect(oldHost.stops).toEqual(['old']);
    expect(host.starts[0].homeRef).toBeNull();
    expect(getDesktopComputer(KEY)).toMatchObject({
      placement: 'runner-fleet',
      homePlacements: ['hub-docker', 'runner-fleet'],
    });
  });

  it('refuses to start over a container on a placement it cannot reach', async () => {
    const rec = getOrCreateDesktopComputer(KEY, 'hub-docker');
    recordDesktopStarted({
      id: rec.id,
      placement: 'hub-docker',
      runnerRef: 'old',
      controlToken: 't',
      homeRef: 'vol-old',
      now: clock,
    });
    const host = fakeHost('runner-fleet');
    const rt = makeRuntime(host, fakeClient(), { maxRunning: 1 });
    await expect(rt.ensureStarted(KEY)).rejects.toThrow(/no desktop host for placement hub-docker/);
    expect(host.starts).toEqual([]);
    expect(getDesktopComputer(KEY)!.runnerRef).toBe('old');
    expect(rt.runningCount()).toBe(1);
  });

  it('deletes the home on every placement after a switch, keeping the record until all are clean', async () => {
    const oldHost = fakeHost('hub-docker');
    const host = fakeHost('runner-fleet');
    const first = makeRuntime(oldHost, fakeClient());
    await first.ensureStarted(KEY);
    await first.stop(KEY);
    const id = getDesktopComputer(KEY)!.id;

    let oldHostBroken = true;
    const realDelete = oldHost.deleteHome.bind(oldHost);
    oldHost.deleteHome = async (cid) => {
      if (oldHostBroken) throw new Error('docker not reachable');
      return realDelete(cid);
    };
    const rt = makeRuntime(host, fakeClient(), { hostFor: () => oldHost });
    await rt.ensureStarted(KEY);
    await expect(rt.destroy(KEY)).rejects.toThrow(/hub-docker: docker not reachable/);
    expect(getDesktopComputer(KEY)).not.toBeNull();

    oldHostBroken = false;
    await rt.destroy(KEY);
    expect(oldHost.deletedHomes).toEqual([id]);
    expect(host.deletedHomes).toEqual([id, id]);
    expect(getDesktopComputer(KEY)).toBeNull();
  });

  it('keeps the slot and retries when boot inspection fails while the container lives', async () => {
    const host = fakeHost();
    const first = makeRuntime(host, fakeClient());
    await first.ensureStarted(KEY);

    const realStatus = host.status.bind(host);
    let dockerDown = true;
    host.status = async (ref) => {
      if (dockerDown) throw new Error('Cannot connect to the Docker daemon');
      return realStatus(ref);
    };
    const second = makeRuntime(host, fakeClient(), { maxRunning: 1 });
    await second.adopt();
    expect(await second.status(KEY)).toMatchObject({ state: 'error' });
    expect(second.runningCount()).toBe(1);
    await expect(second.ensureStarted(KEY2)).rejects.toBeInstanceOf(DesktopCapacityError);

    // The next sweep reconciles it, and idle stop then applies.
    dockerDown = false;
    await second.sweepIdle();
    expect(await second.status(KEY)).toMatchObject({ state: 'running' });
    expect(host.starts).toHaveLength(1);
    clock += DESKTOP_IDLE_STOP_MS;
    expect(await second.sweepIdle()).toHaveLength(1);
    expect(second.runningCount()).toBe(0);
  });

  it('counts a live record this process never loaded', async () => {
    const host = fakeHost();
    const first = makeRuntime(host, fakeClient());
    await first.ensureStarted(KEY);
    const second = makeRuntime(host, fakeClient(), { maxRunning: 1 });
    await expect(second.ensureStarted(KEY2)).rejects.toBeInstanceOf(DesktopCapacityError);
    // Using the computer itself reconciles (adopts) it instead of starting a second one.
    await second.screenshot(KEY);
    expect(host.starts).toHaveLength(1);
  });

  it('deletes the home and record on destroy, and is a no-op for an unknown computer', async () => {
    const host = fakeHost();
    const rt = makeRuntime(host, fakeClient());
    await rt.destroy(KEY);
    expect(host.deletedHomes).toEqual([]);
    await rt.ensureStarted(KEY);
    const id = getDesktopComputer(KEY)!.id;
    await rt.destroy(KEY);
    expect(host.stops).toEqual(['ref-1']);
    expect(host.deletedHomes).toEqual([id]);
    expect(getDesktopComputer(KEY)).toBeNull();
  });

  it('adopts a computer left running by a previous Hub process and idle-stops it later', async () => {
    const host = fakeHost();
    const first = makeRuntime(host, fakeClient());
    await first.ensureStarted(KEY);
    first.dispose();

    const client = fakeClient();
    const second = makeRuntime(host, client);
    await second.adopt();
    expect(await second.status(KEY)).toMatchObject({ state: 'running' });
    await second.screenshot(KEY);
    expect(host.starts).toHaveLength(1);
    expect(client.op.mock.calls[0][1]).toBe('tok');

    clock += DESKTOP_IDLE_STOP_MS;
    expect(await second.sweepIdle()).toHaveLength(1);
  });

  it('clears a computer whose container died while the Hub was down', async () => {
    const host = fakeHost();
    const first = makeRuntime(host, fakeClient());
    await first.ensureStarted(KEY);
    host.statuses.set('ref-1', { state: 'lost', endpoint: null, detail: 'gone' });
    const second = makeRuntime(host, fakeClient());
    await second.adopt();
    expect(getDesktopComputer(KEY)!.runnerRef).toBeNull();
    expect(second.runningCount()).toBe(0);
  });

  it('keeps the slot while a stop is still in progress', async () => {
    const host = fakeHost();
    const rt = makeRuntime(host, fakeClient(), { maxRunning: 1 });
    await rt.ensureStarted(KEY);
    let finish!: () => void;
    const realStop = host.stop.bind(host);
    host.stop = (ref, id) =>
      new Promise((r) => (finish = () => r(realStop(ref, id)))) as ReturnType<typeof host.stop>;
    const stopping = rt.stop(KEY);
    await new Promise((r) => setImmediate(r));
    expect(rt.runningCount()).toBe(1);
    await expect(rt.ensureStarted(KEY2)).rejects.toBeInstanceOf(DesktopCapacityError);
    finish();
    await stopping;
    expect(rt.runningCount()).toBe(0);
    await expect(rt.ensureStarted(KEY2)).resolves.toMatchObject({ state: 'running' });
  });

  it('keeps the slot after a failed stop, and cleans up before restarting', async () => {
    const host = fakeHost();
    const rt = makeRuntime(host, fakeClient(), { maxRunning: 1 });
    await rt.ensureStarted(KEY);
    const realStop = host.stop.bind(host);
    host.stop = async () => {
      throw new Error('docker daemon not responding');
    };
    await expect(rt.stop(KEY)).rejects.toThrow(/not responding/);
    expect(await rt.status(KEY)).toMatchObject({ state: 'error' });
    expect(rt.runningCount()).toBe(1);
    await expect(rt.ensureStarted(KEY2)).rejects.toBeInstanceOf(DesktopCapacityError);
    // The container is in fact still healthy: the next start re-adopts it.
    await expect(rt.ensureStarted(KEY)).resolves.toMatchObject({ state: 'running' });
    expect(host.starts).toHaveLength(1);

    // A dead container whose stop keeps failing blocks the restart instead
    // of leaking a second container.
    host.statuses.set('ref-1', { state: 'lost', endpoint: null, detail: 'oom' });
    await expect(rt.stop(KEY)).rejects.toThrow(/not responding/);
    await expect(rt.ensureStarted(KEY)).rejects.toThrow(/not responding/);
    expect(host.starts).toHaveLength(1);
    expect(rt.runningCount()).toBe(1);

    host.stop = realStop;
    await expect(rt.ensureStarted(KEY)).resolves.toMatchObject({ state: 'running' });
    expect(host.stops).toEqual(['ref-1']);
    expect(host.starts).toHaveLength(2);
    expect(rt.runningCount()).toBe(1);
  });

  it('keeps the slot when cleanup of a failed start fails', async () => {
    const host = fakeHost('hub-docker', {
      initial: { state: 'lost', endpoint: null, detail: 'exited 1' },
    });
    host.stop = async () => {
      throw new Error('rm failed');
    };
    const rt = makeRuntime(host, fakeClient(), { maxRunning: 1 });
    await expect(rt.ensureStarted(KEY)).rejects.toBeInstanceOf(DesktopStartError);
    expect((await rt.status(KEY)).error).toMatch(/Cleaning up the failed container also failed/);
    expect(rt.runningCount()).toBe(1);
    await expect(rt.ensureStarted(KEY2)).rejects.toBeInstanceOf(DesktopCapacityError);
  });

  it('restarts a lost fleet desktop only after its runner confirms the old one gone', async () => {
    const host = fakeHost('runner-fleet', { confirmStops: false });
    const client = fakeClient();
    let sleeps = 0;
    const rt = makeRuntime(host, client, {
      pollMs: 1_000,
      sleep: async (ms) => {
        clock += ms;
        // The runner acknowledges after a few polls (it was saving the home).
        if (++sleeps === 3) host.confirmStops = true;
      },
    });
    await rt.ensureStarted(KEY);
    host.statuses.set('ref-1', { state: 'lost', endpoint: null, detail: 'container stopped' });
    client.op.mockRejectedValueOnce(new DesktopUnreachableError('ECONNREFUSED'));
    await rt.screenshot(KEY);
    expect(host.starts).toHaveLength(2);
    // The new start began only after the old ref was confirmed and released.
    expect(host.stops.filter((r) => r === 'ref-1').length).toBeGreaterThanOrEqual(2);
    expect(getDesktopComputer(KEY)!.runnerRef).toBe('ref-2');
  });

  it('gives up a restart with a clear error while the old runner never confirms', async () => {
    const host = fakeHost('runner-fleet', { confirmStops: false });
    const rt = makeRuntime(host, fakeClient(), { stopConfirmTimeoutMs: 10_000, pollMs: 1_000 });
    await rt.ensureStarted(KEY);
    await rt.stop(KEY);
    await expect(rt.ensureStarted(KEY)).rejects.toThrow(/still shutting down on its runner/);
    expect(host.starts).toHaveLength(1);
    expect(rt.runningCount()).toBe(1);
    await expect(rt.destroy(KEY)).rejects.toThrow(/still shutting down/);
    expect(host.deletedHomes).toEqual([]);
    expect(getDesktopComputer(KEY)).not.toBeNull();
  });

  it('records the ref before creating anything, and keeps it when create and cleanup both fail', async () => {
    const host = fakeHost();
    host.allocateRef = (id) => `agent-hub-desktop-${id}`;
    let reservedAtCreate: string | null = null;
    host.start = async (req) => {
      reservedAtCreate = getDesktopComputer(KEY)!.runnerRef;
      host.starts.push(req);
      throw new Error('docker run: port is already allocated');
    };
    host.stop = async () => {
      throw new Error('docker rm: daemon not responding');
    };
    const rt = makeRuntime(host, fakeClient(), { maxRunning: 1 });
    await expect(rt.ensureStarted(KEY)).rejects.toThrow(/port is already allocated/);
    const id = getDesktopComputer(KEY)!.id;
    expect(reservedAtCreate).toBe(`agent-hub-desktop-${id}`);
    expect(getDesktopComputer(KEY)!.runnerRef).toBe(`agent-hub-desktop-${id}`);
    expect((await rt.status(KEY)).error).toMatch(/Cleaning up the failed container also failed/);
    expect(rt.runningCount()).toBe(1);
    await expect(rt.ensureStarted(KEY2)).rejects.toBeInstanceOf(DesktopCapacityError);
  });

  it('refuses starts while the profile is being deleted, including ones that queued behind it', async () => {
    const { beginDesktopDeletion } = await import('./desktop-deletion-guard.js');
    const host = fakeHost();
    const rt = makeRuntime(host, fakeClient());
    const end = beginDesktopDeletion(KEY);
    await expect(rt.ensureStarted(KEY)).rejects.toBeInstanceOf(DesktopComputerDeletingError);
    expect(getDesktopComputer(KEY)).toBeNull();
    end();

    // A start admitted before a delete began, waiting for the previous
    // container's stop to be confirmed.
    const fleet = fakeHost('runner-fleet', { confirmStops: false });
    let endDelete: (() => void) | null = null;
    const rt2 = makeRuntime(fleet, fakeClient(), {
      sleep: async (ms) => {
        clock += ms;
        endDelete ??= beginDesktopDeletion(KEY);
        fleet.confirmStops = true;
      },
    });
    await rt2.ensureStarted(KEY);
    await rt2.stop(KEY);
    endDelete = null;
    await expect(rt2.ensureStarted(KEY)).rejects.toBeInstanceOf(DesktopComputerDeletingError);
    expect(fleet.starts).toHaveLength(1);
    (endDelete as (() => void) | null)?.();
  });

  it('is what the registry calls to delete a container desktop with its profile', async () => {
    const host = fakeHost();
    const rt = makeRuntime(host, fakeClient());
    const registry = await import('./desktop-runtime-registry.js');
    registry.registerDesktopRuntime(rt);
    try {
      await rt.ensureStarted(KEY);
      const id = getDesktopComputer(KEY)!.id;
      let profileDeleted = false;
      await registry.deleteDesktopComputersWithProfile(KEY, () => {
        profileDeleted = true;
      });
      expect(profileDeleted).toBe(true);
      expect(host.deletedHomes).toEqual([id]);
      expect(getDesktopComputer(KEY)).toBeNull();
    } finally {
      registry.resetDesktopRuntimesForTests();
    }
  });

  it('stops a persisted computer from a fresh runtime before adoption reached it', async () => {
    const host = fakeHost();
    const first = makeRuntime(host, fakeClient());
    await first.ensureStarted(KEY);
    const fresh = makeRuntime(host, fakeClient());
    // No adopt() yet: the cache is empty, but the record says it runs.
    await fresh.stop(KEY);
    expect(host.stops).toEqual(['ref-1']);
    expect(getDesktopComputer(KEY)!.runnerRef).toBeNull();
    expect(fresh.runningCount()).toBe(0);
  });

  it('staggered resumes behind an unconfirmed stop share one replacement and never cancel it', async () => {
    const host = fakeHost('runner-fleet', { confirmStops: false });
    let ticks = 0;
    const rt = makeRuntime(host, fakeClient(), {
      pollMs: 1_000,
      sleep: async (ms) => {
        clock += ms;
        ticks++;
        // The old runner confirms after a few polls; the replacement takes a
        // few more to be claimed and come up.
        if (ticks === 3) host.confirmStops = true;
        if (ticks === 8) {
          host.statuses.set('ref-2', {
            state: 'running',
            endpoint: { host: '127.0.0.1', port: 40002 },
            detail: null,
          });
        }
        await new Promise((r) => setImmediate(r));
      },
    });
    await rt.ensureStarted(KEY);
    const realStart = host.start.bind(host);
    host.start = async (req) => {
      const res = await realStart(req);
      host.statuses.set(req.runnerRef, { state: 'pending', endpoint: null, detail: null });
      return res;
    };
    await rt.stop(KEY);
    expect(getDesktopComputer(KEY)!.runnerRef).toBe('ref-1');
    ticks = 0;

    const a = rt.ensureStarted(KEY);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const b = rt.ensureStarted(KEY);
    const [sa, sb] = await Promise.all([a, b]);

    expect(sa.state).toBe('running');
    expect(sb.state).toBe('running');
    expect(host.starts.map((r) => r.runnerRef)).toEqual(['ref-1', 'ref-2']);
    // The replacement was never reconciled away by the later resume.
    expect(host.stops.filter((r) => r === 'ref-2')).toEqual([]);
    expect(getDesktopComputer(KEY)!.runnerRef).toBe('ref-2');
  });

  it('recovery after a lost container leaves a replacement another caller started alone', async () => {
    const host = fakeHost();
    const client = fakeClient();
    const rt = makeRuntime(host, client);
    await rt.ensureStarted(KEY);
    host.statuses.set('ref-1', { state: 'lost', endpoint: null, detail: 'oom' });
    // Both calls used ref-1 when it died. A recovers first; B only notices
    // after A already started the replacement.
    let releaseB!: () => void;
    const bGate = new Promise<void>((r) => (releaseB = r));
    client.op.mockImplementationOnce(async () => {
      throw new DesktopUnreachableError('ECONNREFUSED');
    });
    client.op.mockImplementationOnce(async () => {
      await bGate;
      throw new DesktopUnreachableError('ECONNREFUSED');
    });
    const a = rt.screenshot(KEY);
    const b = rt.screenshot(KEY);
    await a;
    expect(getDesktopComputer(KEY)!.runnerRef).toBe('ref-2');
    releaseB();
    await b;
    expect(host.starts).toHaveLength(2);
    expect(host.stops).toEqual(['ref-1']);
    expect(getDesktopComputer(KEY)!.runnerRef).toBe('ref-2');
  });

  it("recovery never removes a replacement that reuses the dead container's name", async () => {
    // Like the Hub-docker host: one container name per computer, every start.
    const host = fakeHost();
    host.allocateRef = (id) => `agent-hub-desktop-${id}`;
    const client = fakeClient();
    const rt = makeRuntime(host, client);
    await rt.ensureStarted(KEY);
    const name = getDesktopComputer(KEY)!.runnerRef!;
    host.statuses.set(name, { state: 'lost', endpoint: null, detail: 'oom' });

    // A and B both fail against the dead container. B's inspection sees it
    // missing, but its answer only arrives after A restarted under the same name.
    let releaseB!: () => void;
    const bGate = new Promise<void>((r) => (releaseB = r));
    const realStatus = host.status.bind(host);
    let statusCalls = 0;
    host.status = async (ref) => {
      const seen = await realStatus(ref);
      if (++statusCalls === 2) await bGate;
      return seen;
    };
    client.op.mockRejectedValueOnce(new DesktopUnreachableError('ECONNREFUSED'));
    client.op.mockRejectedValueOnce(new DesktopUnreachableError('ECONNREFUSED'));
    const a = rt.screenshot(KEY);
    const b = rt.screenshot(KEY);
    await a;
    expect(host.starts).toHaveLength(2);
    expect(host.stops).toEqual([name]);

    releaseB();
    expect((await b).toString()).toBe('PNG');
    // B's stale recovery left the healthy replacement alone.
    expect(host.stops).toEqual([name]);
    expect(host.starts).toHaveLength(2);
    expect(await rt.status(KEY)).toMatchObject({ state: 'running' });
  });
});
