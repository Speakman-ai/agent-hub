import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import express, { type Express } from 'express';
import request from 'supertest';
import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import {
  __resetSecretCryptoForTests,
  __setSecretCryptoKeyFilePathForTests,
} from '../secret-crypto.js';

vi.mock('../finalize/hub-task-protection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../finalize/hub-task-protection.js')>();
  return {
    ...actual,
    armHubTaskProtection: vi.fn(async () => 'skipped' as const),
    clearHubTaskProtection: vi.fn(async () => 'skipped' as const),
  };
});

import createRunnerRoutes from '../finalize/runner-routes.js';
import { getRunnerJobStatus } from '../finalize/runner-queue.js';
import { createFleetDesktopHost, sweepDesktopHomeObjects } from './fleet-desktop-host.js';
import { createContainerDesktopRuntime } from './container-desktop-runtime.js';
import { LocalDirDesktopHomeStore } from './desktop-home-store.js';
import { createHomeSpools, type HomeSpools } from './desktop-home-spool.js';
import {
  getDesktopComputer,
  getOrCreateDesktopComputer,
  findDesktopComputerByJob,
  recordDesktopHomeObjectWriting,
  setDesktopHomeDecision,
  recordDesktopReserved,
  recordDesktopStarted,
  recordDesktopStopped,
} from './desktop-containers-store.js';

const FLEET = 'test-fleet-secret';
const KEY = { userId: 'u1', agentId: 'a1', projectId: 'p1' };
const LIMITS = { image: 'agent-hub/desktop:test', memory: '2g', cpus: '1' };

let dir: string;
let app: Express;
let store: LocalDirDesktopHomeStore;
let spools: HomeSpools;
let failSpoolRemoval = 0;
let clock: number;

const SPOT_GRACE_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** One upload attempt's object: `<jobId>-<attemptId>.tar.gz`. */
const fileOf = (jobId: string) => new RegExp(`^${jobId}-[0-9a-f-]{36}\\.tar\\.gz$`);
const snapshotOf = (id: string, jobId: string) =>
  new RegExp(`^${id}/${jobId}-[0-9a-f-]{36}\\.tar\\.gz$`);

function makeHost() {
  return createFleetDesktopHost({
    homeStore: async () => store,
    orgId: () => 'orgA',
    limits: LIMITS,
    scale: () => {},
    now: () => clock,
    spotReclaimGraceMs: SPOT_GRACE_MS,
    log: () => {},
  });
}

const finish = (token: string, jobId: string) =>
  request(app)
    .post(`/api/runners/jobs/${jobId}/finish`)
    .set({ Authorization: `Bearer ${token}` })
    .send({ exitCode: 0 })
    .expect(204);

/** What the runtime does around host.start (write-ahead ref), minus the waiting. */
async function startComputer(host: ReturnType<typeof makeHost>) {
  const rec = getOrCreateDesktopComputer(KEY, 'runner-fleet');
  const runnerRef = host.allocateRef(rec.id);
  recordDesktopReserved({
    id: rec.id,
    placement: 'runner-fleet',
    runnerRef,
    controlToken: 'tok',
  });
  const res = await host.start({
    computerId: rec.id,
    key: KEY,
    controlToken: 'tok',
    homeRef: rec.homeRef,
    runnerRef,
  });
  recordDesktopStarted({
    id: rec.id,
    placement: 'runner-fleet',
    runnerRef,
    controlToken: 'tok',
    homeRef: res.homeRef,
    now: clock,
  });
  return { id: rec.id, jobId: runnerRef };
}

const register = async (capabilities: string[]) => {
  const r = await request(app)
    .post('/api/runners/register')
    .send({ fleetToken: FLEET, capabilities });
  expect(r.status).toBe(200);
  return r.body.token as string;
};

const claim = (token: string) =>
  request(app).post('/api/runners/claim').set('Authorization', `Bearer ${token}`).send({});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-desktop-'));
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  __resetSecretCryptoForTests();
  __setSecretCryptoKeyFilePathForTests(path.join(dir, 'secret.key'));
  initOrgsDb();
  store = new LocalDirDesktopHomeStore(path.join(dir, 'homes'));
  failSpoolRemoval = 0;
  spools = createHomeSpools(path.join(dir, 'spool'), async (d) => {
    if (failSpoolRemoval > 0) {
      failSpoolRemoval--;
      throw new Error('EBUSY');
    }
    rmSync(d, { recursive: true, force: true });
  });
  clock = 1_000_000;
  process.env.FINALIZE_RUNNER_FLEET_TOKEN = FLEET;
  process.env.FINALIZE_RUNNER_TOKEN_SECRET = 'test-secret';
  app = express()
    .use(express.json())
    .use(
      createRunnerRoutes({
        claimWaitMs: 200,
        leaseMs: 60_000,
        desktopHomeStore: async () => store,
        desktopHomeSpools: () => spools,
        maxDesktopHomeBytes: 64,
      }),
    );
});

afterEach(() => {
  setOrgsDbPathForTests(null);
  __setSecretCryptoKeyFilePathForTests(null);
  __resetSecretCryptoForTests();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FINALIZE_RUNNER_FLEET_TOKEN;
  delete process.env.FINALIZE_RUNNER_TOKEN_SECRET;
});

describe('fleet desktop host', () => {
  it('queues a desktop job only agents with the desktop capability claim', async () => {
    const host = makeHost();
    const { id, jobId } = await startComputer(host);
    expect(await host.status(jobId)).toMatchObject({ state: 'pending' });

    expect((await claim(await register(['environment']))).status).toBe(204);
    const r = await claim(await register(['desktop']));
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBe(jobId);
    expect(r.body.spec).toMatchObject({
      kind: 'desktop',
      image: LIMITS.image,
      desktop: { computerId: id, controlToken: 'tok', memory: '2g', cpus: '1', restoreHome: false },
    });
    expect(await host.status(jobId)).toMatchObject({ state: 'starting' });
  });

  it('reports the agent endpoint, then round-trips the home through stop and resume', async () => {
    const host = makeHost();
    const { id, jobId } = await startComputer(host);
    const token = await register(['desktop']);
    await claim(token);
    const auth = { Authorization: `Bearer ${token}` };

    // Nothing to restore on the first run.
    expect(
      (await request(app).get(`/api/runners/jobs/${jobId}/desktop-home`).set(auth)).status,
    ).toBe(404);
    await request(app)
      .post(`/api/runners/jobs/${jobId}/environment`)
      .set(auth)
      .send({ status: 'ready', host: '10.0.0.5', port: 32001 })
      .expect(204);
    expect(await host.status(jobId)).toEqual({
      state: 'running',
      endpoint: { host: '10.0.0.5', port: 32001 },
      detail: null,
    });

    // Cancelling is only a request: the runner still holds the job.
    expect(await host.stop(jobId, id)).toEqual({ confirmed: false });
    expect(getRunnerJobStatus(jobId)?.state).toBe('cancelled');
    expect(
      (await request(app).post(`/api/runners/jobs/${jobId}/heartbeat`).set(auth).send({})).status,
    ).toBe(410);
    // It saves the home (still owned: the ref is kept until confirmation), then finishes.
    await request(app)
      .put(`/api/runners/jobs/${jobId}/desktop-home`)
      .set(auth)
      .set('content-type', 'application/gzip')
      .send(Buffer.from('home-v1'))
      .expect(204);
    expect(getDesktopComputer(KEY)!.homeRef).toMatch(snapshotOf(id, jobId));
    await finish(token, jobId);
    expect(await host.stop(jobId, id)).toEqual({ confirmed: true });
    recordDesktopStopped({ id, now: clock });

    // Resume: the next job restores that snapshot.
    const next = await startComputer(host);
    const token2 = await register(['desktop']);
    const r = await claim(token2);
    expect(r.body.spec.desktop.restoreHome).toBe(true);
    const got = await request(app)
      .get(`/api/runners/jobs/${next.jobId}/desktop-home`)
      .set({ Authorization: `Bearer ${token2}` })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(got.status).toBe(200);
    expect((got.body as Buffer).toString()).toBe('home-v1');

    // A newer snapshot replaces (and deletes) the old one.
    await request(app)
      .put(`/api/runners/jobs/${next.jobId}/desktop-home`)
      .set({ Authorization: `Bearer ${token2}` })
      .set('content-type', 'application/gzip')
      .send(Buffer.from('home-v2'))
      .expect(204);
    expect(readdirSync(path.join(dir, 'homes', id))).toEqual([
      expect.stringMatching(fileOf(next.jobId)),
    ]);

    // Deleting the computer's home removes every snapshot.
    await host.deleteHome(id);
    expect(existsSync(path.join(dir, 'homes', id))).toBe(false);
  });

  it('an upload whose spool removal fails leaves its copy where the janitor finds it', async () => {
    const host = makeHost();
    const { jobId } = await startComputer(host);
    const token = await register(['desktop']);
    await claim(token);
    failSpoolRemoval = 1;
    await request(app)
      .put(`/api/runners/jobs/${jobId}/desktop-home`)
      .set({ Authorization: `Bearer ${token}` })
      .set('content-type', 'application/gzip')
      .send(Buffer.from('browser logins'))
      .expect(204);
    // The spool (a copy of the home) is still on disk, under the known root.
    expect(readdirSync(path.join(dir, 'spool'))).toHaveLength(1);
    expect(await spools.sweep()).toBe(0);
    expect(readdirSync(path.join(dir, 'spool'))).toEqual([]);
  });

  it('answers 500 (not a hung request) when a transfer spool cannot be set up', async () => {
    const host = makeHost();
    const { jobId } = await startComputer(host);
    const token = await register(['desktop']);
    await claim(token);
    spools.open = async () => {
      throw new Error('ENOSPC: no space left on device');
    };
    const auth = { Authorization: `Bearer ${token}` };
    const put = await request(app)
      .put(`/api/runners/jobs/${jobId}/desktop-home`)
      .set(auth)
      .set('content-type', 'application/gzip')
      .send(Buffer.from('home'));
    expect(put.status).toBe(500);
    expect(put.body.error).toMatch(/spool unavailable: ENOSPC/);
    expect(
      (await request(app).get(`/api/runners/jobs/${jobId}/desktop-home`).set(auth)).status,
    ).toBe(500);
  });

  it('refuses another agent and an oversized home', async () => {
    const host = makeHost();
    const { jobId } = await startComputer(host);
    const token = await register(['desktop']);
    await claim(token);
    const other = await register(['desktop']);
    expect(
      (
        await request(app)
          .get(`/api/runners/jobs/${jobId}/desktop-home`)
          .set({ Authorization: `Bearer ${other}` })
      ).status,
    ).toBe(403);
    const big = await request(app)
      .put(`/api/runners/jobs/${jobId}/desktop-home`)
      .set({ Authorization: `Bearer ${token}` })
      .set('content-type', 'application/gzip')
      .send(Buffer.alloc(100));
    expect(big.status).toBe(413);
  });

  it('confirms a stop at once when no runner ever claimed the job', async () => {
    const host = makeHost();
    const { id, jobId } = await startComputer(host);
    expect(await host.stop(jobId, id)).toEqual({ confirmed: true });
    // Cancelled before the claim: no runner can pick it up afterwards.
    expect((await claim(await register(['desktop']))).status).toBe(204);
  });

  it('never confirms a stop on silence alone (hung inspect or failing removal on a quiet runner)', async () => {
    const host = makeHost();
    const { id, jobId } = await startComputer(host);
    const token = await register(['desktop']);
    await claim(token);
    expect(await host.stop(jobId, id)).toEqual({ confirmed: false });
    // A day of silence: the runner may be stuck in Docker with the desktop alive.
    getOrgsDb()
      .prepare('UPDATE runner_agents SET last_seen_at=?')
      .run(Date.now() - DAY_MS);
    clock = Date.now() + DAY_MS;
    expect(await host.stop(jobId, id)).toEqual({ confirmed: false });
    // Only the runner's finish confirms it.
    await finish(token, jobId);
    expect(await host.stop(jobId, id)).toEqual({ confirmed: true });
  });

  it('confirms once a Spot-reclaimed host has been silent past the grace', async () => {
    const host = makeHost();
    const { id, jobId } = await startComputer(host);
    const token = await register(['desktop']);
    await claim(token);
    const t0 = Date.now();
    getOrgsDb().prepare('UPDATE runner_jobs SET spot_interruption_at=? WHERE id=?').run(t0, jobId);
    getOrgsDb().prepare('UPDATE runner_agents SET last_seen_at=?').run(t0);
    clock = t0 + SPOT_GRACE_MS - 1;
    expect(await host.stop(jobId, id)).toEqual({ confirmed: false });
    clock = t0 + SPOT_GRACE_MS;
    expect(await host.stop(jobId, id)).toEqual({ confirmed: true });
  });

  it('confirms once the runner was retired as dead', async () => {
    const host = makeHost();
    const { id, jobId } = await startComputer(host);
    const token = await register(['desktop']);
    await claim(token);
    expect(await host.stop(jobId, id)).toEqual({ confirmed: false });
    getOrgsDb().prepare("UPDATE runner_agents SET state='dead'").run();
    expect(await host.stop(jobId, id)).toEqual({ confirmed: true });
  });

  it('keeps a lost job as the owner, so its late home upload still lands', async () => {
    const host = makeHost();
    const { id, jobId } = await startComputer(host);
    const token = await register(['desktop']);
    await claim(token);
    const auth = { Authorization: `Bearer ${token}` };
    // The runner reports the container died, then goes on to save the home.
    await request(app)
      .post(`/api/runners/jobs/${jobId}/environment`)
      .set(auth)
      .send({ status: 'lost', detail: 'the desktop container stopped' })
      .expect(204);
    expect(await host.stop(jobId, id)).toEqual({ confirmed: false });
    await request(app)
      .put(`/api/runners/jobs/${jobId}/desktop-home`)
      .set(auth)
      .set('content-type', 'application/gzip')
      .send(Buffer.from('latest'))
      .expect(204);
    expect(getDesktopComputer(KEY)!.homeRef).toMatch(snapshotOf(id, jobId));
    await finish(token, jobId);
    expect(await host.stop(jobId, id)).toEqual({ confirmed: true });
  });

  it('answers 409 when the saved snapshot is gone from the store', async () => {
    const host = makeHost();
    const rec = getOrCreateDesktopComputer(KEY, 'runner-fleet');
    recordDesktopStarted({
      id: rec.id,
      placement: 'runner-fleet',
      runnerRef: 'none',
      controlToken: 't',
      homeRef: `${rec.id}/vanished.tar.gz`,
      now: clock,
    });
    const { jobId } = await startComputer(host);
    const token = await register(['desktop']);
    expect((await claim(token)).body.spec.desktop.restoreHome).toBe(true);
    const r = await request(app)
      .get(`/api/runners/jobs/${jobId}/desktop-home`)
      .set({ Authorization: `Bearer ${token}` });
    expect(r.status).toBe(409);
  });

  it('discards an upload that lost ownership while it was being stored', async () => {
    const host = makeHost();
    const { id, jobId: oldJob } = await startComputer(host);
    const token = await register(['desktop']);
    await claim(token);

    // While the old upload is being written, the Hub presumes that runner
    // gone and a newer run saves its own snapshot.
    const realPut = store.put.bind(store);
    let newJob = '';
    store.put = async (key, file) => {
      await realPut(key, file);
      if (key.includes(`/${oldJob}-`)) {
        recordDesktopStopped({ id, now: clock });
        newJob = (await startComputer(host)).jobId;
        const t2 = await register(['desktop']);
        await claim(t2);
        await request(app)
          .put(`/api/runners/jobs/${newJob}/desktop-home`)
          .set({ Authorization: `Bearer ${t2}` })
          .set('content-type', 'application/gzip')
          .send(Buffer.from('newer'))
          .expect(204);
      }
    };
    const r = await request(app)
      .put(`/api/runners/jobs/${oldJob}/desktop-home`)
      .set({ Authorization: `Bearer ${token}` })
      .set('content-type', 'application/gzip')
      .send(Buffer.from('older'));
    expect(r.status).toBe(410);
    expect(getDesktopComputer(KEY)!.homeRef).toMatch(snapshotOf(id, newJob));
    expect(readdirSync(path.join(dir, 'homes', id))).toEqual([
      expect.stringMatching(fileOf(newJob)),
    ]);
  });

  it('a delayed overlapping upload never deletes the snapshot the next run restores', async () => {
    const host = makeHost();
    const { id, jobId } = await startComputer(host);
    const token = await register(['desktop']);
    await claim(token);
    const auth = { Authorization: `Bearer ${token}` };
    expect(await host.stop(jobId, id)).toEqual({ confirmed: false });

    // Attempt A stalls inside store.put; the runner times out and retries (B).
    const realPut = store.put.bind(store);
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => (releaseA = r));
    let first = true;
    store.put = async (key, file) => {
      if (first) {
        first = false;
        await aGate;
      }
      return realPut(key, file);
    };
    const attemptA = request(app)
      .put(`/api/runners/jobs/${jobId}/desktop-home`)
      .set(auth)
      .set('content-type', 'application/gzip')
      .send(Buffer.from('home-final'))
      .then((r) => r.status);
    await vi.waitFor(() => expect(first).toBe(false));
    await request(app)
      .put(`/api/runners/jobs/${jobId}/desktop-home`)
      .set(auth)
      .set('content-type', 'application/gzip')
      .send(Buffer.from('home-final'))
      .expect(204);
    const committed = getDesktopComputer(KEY)!.homeRef!;

    // B landed, the runner finished, the stop is confirmed, the computer resumes.
    await finish(token, jobId);
    expect(await host.stop(jobId, id)).toEqual({ confirmed: true });
    recordDesktopStopped({ id, now: clock });
    const next = await startComputer(host);
    const token2 = await register(['desktop']);
    await claim(token2);

    // Only now does A's write finish: it lost ownership and must only remove itself.
    releaseA();
    expect(await attemptA).toBe(410);
    expect(getDesktopComputer(KEY)!.homeRef).toBe(committed);
    expect(readdirSync(path.join(dir, 'homes', id))).toEqual([committed.split('/')[1]]);
    const got = await request(app)
      .get(`/api/runners/jobs/${next.jobId}/desktop-home`)
      .set({ Authorization: `Bearer ${token2}` })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(got.status).toBe(200);
    expect((got.body as Buffer).toString()).toBe('home-final');
  });

  describe('Hub restart at the enqueue boundary', () => {
    const runtimeOn = (host: ReturnType<typeof makeHost>) =>
      createContainerDesktopRuntime({
        host,
        client: { healthy: async () => true, op: async () => ({ ok: true }) },
        maxRunning: 1,
        stopConfirmTimeoutMs: 5_000,
        pollMs: 1_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        startTimer: () => ({ stop: () => {} }),
        log: () => {},
      });
    const jobCount = () =>
      (
        getOrgsDb().prepare("SELECT COUNT(*) AS n FROM runner_jobs WHERE kind='desktop'").get() as {
          n: number;
        }
      ).n;

    it("a crash while switching placement never leaves the old placement's home ref behind", async () => {
      const rec = getOrCreateDesktopComputer(KEY, 'hub-docker');
      recordDesktopStarted({
        id: rec.id,
        placement: 'hub-docker',
        runnerRef: 'agent-hub-desktop-x',
        controlToken: 't',
        homeRef: 'agent-hub-desktop-home-x',
        now: clock,
      });
      recordDesktopStopped({ id: rec.id, now: clock });
      // The Hub now runs desktops on the fleet: reserve, then crash before the enqueue.
      const host = makeHost();
      recordDesktopReserved({
        id: rec.id,
        placement: 'runner-fleet',
        runnerRef: host.allocateRef(rec.id),
        controlToken: 't',
      });
      expect(getDesktopComputer(KEY)).toMatchObject({
        placement: 'runner-fleet',
        homeRef: null,
        homePlacements: ['hub-docker', 'runner-fleet'],
      });
      const rt = runtimeOn(makeHost());
      await rt.adopt();
      // The next start does not ask a runner to restore a Docker volume name.
      void rt.ensureStarted(KEY).catch(() => {});
      await vi.waitFor(() => expect(jobCount()).toBe(1));
      const row = getOrgsDb()
        .prepare("SELECT spec_json FROM runner_jobs WHERE kind='desktop'")
        .get() as { spec_json: string };
      expect(JSON.parse(row.spec_json).desktop.restoreHome).toBe(false);
    });

    /** A run whose home the Hub refused: the runner reported it and parked. */
    async function parkOnRejectedHome() {
      const host = makeHost();
      const { id, jobId } = await startComputer(host);
      const token = await register(['desktop']);
      await claim(token);
      const auth = { Authorization: `Bearer ${token}` };
      expect(await host.stop(jobId, id)).toEqual({ confirmed: false });
      const big = await request(app)
        .put(`/api/runners/jobs/${jobId}/desktop-home`)
        .set(auth)
        .set('content-type', 'application/gzip')
        .send(Buffer.alloc(100));
      expect(big.status).toBe(413);
      await request(app)
        .post(`/api/runners/jobs/${jobId}/desktop-home-rejected`)
        .set(auth)
        .send({ detail: 'home snapshot too large; kept on the runner as docker volume v1' })
        .expect(204);
      const decision = async () =>
        (await request(app).get(`/api/runners/jobs/${jobId}/desktop-home-decision`).set(auth)).body
          .decision as string;
      return { id, jobId, token, auth, decision };
    }

    it('a rejected home blocks starts, and profile deletion waits for the runner to remove it', async () => {
      const { id, jobId, token, decision } = await parkOnRejectedHome();
      const rt = runtimeOn(makeHost());
      await rt.adopt();
      // Parked: no container, so no desktop slot; the job (and the data) stay owned.
      expect(rt.runningCount()).toBe(0);
      expect(getDesktopComputer(KEY)!.runnerRef).toBe(jobId);
      await expect(rt.ensureStarted(KEY)).rejects.toThrow(
        /latest home could not be saved \(home snapshot too large; kept on the runner as docker volume v1 \(runner [^)]+\)\), so it was not restarted on an older copy/,
      );
      expect(await decision()).toBe('hold');

      const registry = await import('./desktop-runtime-registry.js');
      registry.registerDesktopRuntime(rt);
      try {
        let profileDeleted = false;
        const deleteProfile = () => {
          profileDeleted = true;
        };
        // First attempt: the runner still holds the user's data, so it is told
        // to discard it and the delete stays pending, profile kept.
        await expect(
          registry.deleteDesktopComputersWithProfile(KEY, deleteProfile),
        ).rejects.toThrow(/kept home is being removed from its runner/);
        expect(profileDeleted).toBe(false);
        expect(getDesktopComputer(KEY)).not.toBeNull();
        expect(await decision()).toBe('discard');

        // The runner removes the volume and finishes; the delete now completes.
        await finish(token, jobId);
        await registry.deleteDesktopComputersWithProfile(KEY, deleteProfile);
        expect(profileDeleted).toBe(true);
        expect(getDesktopComputer(KEY)).toBeNull();
        expect(existsSync(path.join(dir, 'homes', id))).toBe(false);
      } finally {
        registry.resetDesktopRuntimesForTests();
      }
    });

    it('an operator discard resumes the computer from its previous snapshot', async () => {
      const { id, token, jobId, decision } = await parkOnRejectedHome();
      const rt = runtimeOn(makeHost());
      await rt.adopt();
      setDesktopHomeDecision(id, 'discard');
      expect(await decision()).toBe('discard');
      await finish(token, jobId);
      await rt.sweepIdle();
      expect(getDesktopComputer(KEY)).toMatchObject({ runnerRef: null, homeBlocked: null });
      void rt.ensureStarted(KEY).catch(() => {});
      await vi.waitFor(() => expect(jobCount()).toBe(2));
    });

    it('an operator retry lets the parked runner upload again, which ends the block', async () => {
      const { id, auth, jobId, decision } = await parkOnRejectedHome();
      setDesktopHomeDecision(id, 'retry');
      expect(await decision()).toBe('retry');
      await request(app)
        .put(`/api/runners/jobs/${jobId}/desktop-home`)
        .set(auth)
        .set('content-type', 'application/gzip')
        .send(Buffer.from('fits now'))
        .expect(204);
      expect(getDesktopComputer(KEY)).toMatchObject({ homeBlocked: null, homeDecision: null });
    });

    it('ignores a rejection report from a run the computer moved past', async () => {
      const host = makeHost();
      const { id, jobId } = await startComputer(host);
      const token = await register(['desktop']);
      await claim(token);
      await finish(token, jobId);
      await host.stop(jobId, id);
      recordDesktopStopped({ id, now: clock });
      await request(app)
        .post(`/api/runners/jobs/${jobId}/desktop-home-rejected`)
        .set({ Authorization: `Bearer ${token}` })
        .send({ detail: 'stale' })
        .expect(410);
      expect(getDesktopComputer(KEY)!.homeBlocked).toBeNull();
      // Nobody wants a moved-past run's home.
      const d = await request(app)
        .get(`/api/runners/jobs/${jobId}/desktop-home-decision`)
        .set({ Authorization: `Bearer ${token}` });
      expect(d.body.decision).toBe('discard');
    });

    it('a delayed upload landing after the profile was deleted is cleaned up, even when its first delete fails', async () => {
      const host = makeHost();
      const { id, jobId } = await startComputer(host);
      const token = await register(['desktop']);
      await claim(token);
      const auth = { Authorization: `Bearer ${token}` };
      await host.stop(jobId, id);

      // Attempt A stalls in store.put; retry B lands and the runner finishes.
      const realPut = store.put.bind(store);
      let releaseA!: () => void;
      const aGate = new Promise<void>((r) => (releaseA = r));
      let aKey = '';
      store.put = async (key, file) => {
        if (!aKey) {
          aKey = key;
          await aGate;
        }
        return realPut(key, file);
      };
      const attemptA = request(app)
        .put(`/api/runners/jobs/${jobId}/desktop-home`)
        .set(auth)
        .set('content-type', 'application/gzip')
        .send(Buffer.from('home'))
        .then((r) => r.status);
      await vi.waitFor(() => expect(aKey).not.toBe(''));
      await request(app)
        .put(`/api/runners/jobs/${jobId}/desktop-home`)
        .set(auth)
        .set('content-type', 'application/gzip')
        .send(Buffer.from('home'))
        .expect(204);
      await finish(token, jobId);

      // The profile is deleted: the computer and its home prefix are gone.
      const rt = runtimeOn(makeHost());
      await rt.destroy(KEY);
      expect(getDesktopComputer(KEY)).toBeNull();
      expect(existsSync(path.join(dir, 'homes', id))).toBe(false);

      // A's write now finishes, recreating an object, and its delete fails once.
      const realDelete = store.delete.bind(store);
      let failDelete = true;
      store.delete = async (key) => {
        if (failDelete) {
          failDelete = false;
          throw new Error('SlowDown');
        }
        return realDelete(key);
      };
      releaseA();
      expect(await attemptA).toBe(410);
      expect(existsSync(path.join(dir, 'homes', aKey))).toBe(true);

      // Still tracked, so the janitor finishes the job.
      expect(await sweepDesktopHomeObjects(store, () => clock)).toBe(0);
      expect(existsSync(path.join(dir, 'homes', aKey))).toBe(false);
      expect(await sweepDesktopHomeObjects(store, () => clock)).toBe(0);
      expect(getOrgsDb().prepare('SELECT COUNT(*) AS n FROM desktop_home_objects').get()).toEqual({
        n: 0,
      });
    });

    it('a replaced snapshot whose delete fails stays tracked until the janitor removes it', async () => {
      const host = makeHost();
      const { id, jobId } = await startComputer(host);
      const token = await register(['desktop']);
      await claim(token);
      const auth = { Authorization: `Bearer ${token}` };
      const upload = () =>
        request(app)
          .put(`/api/runners/jobs/${jobId}/desktop-home`)
          .set(auth)
          .set('content-type', 'application/gzip')
          .send(Buffer.from('home'))
          .expect(204);
      await upload();
      const first = getDesktopComputer(KEY)!.homeRef!;
      const realDelete = store.delete.bind(store);
      store.delete = async () => {
        throw new Error('AccessDenied');
      };
      await upload();
      expect(getDesktopComputer(KEY)!.homeRef).not.toBe(first);
      expect(existsSync(path.join(dir, 'homes', first))).toBe(true);
      expect(await sweepDesktopHomeObjects(store, () => clock)).toBe(1);
      store.delete = realDelete;
      expect(await sweepDesktopHomeObjects(store, () => clock)).toBe(0);
      expect(readdirSync(path.join(dir, 'homes', id))).toHaveLength(1);
    });

    it('the janitor removes a write the Hub abandoned mid-put, and leaves fresh writes alone', async () => {
      const rec = getOrCreateDesktopComputer(KEY, 'runner-fleet');
      for (const [k, since] of [
        [`${rec.id}/old-attempt.tar.gz`, clock - 7 * 60 * 60_000],
        [`${rec.id}/fresh-attempt.tar.gz`, clock - 60_000],
      ] as const) {
        mkdirSync(path.join(dir, 'homes', rec.id), { recursive: true });
        writeFileSync(path.join(dir, 'homes', k), 'partial');
        recordDesktopHomeObjectWriting(k, rec.id, since);
      }
      expect(await sweepDesktopHomeObjects(store, () => clock)).toBe(0);
      expect(readdirSync(path.join(dir, 'homes', rec.id))).toEqual(['fresh-attempt.tar.gz']);
    });

    it('crash after the reservation, before the enqueue: the ref reads lost and is cleared', async () => {
      const host = makeHost();
      const rec = getOrCreateDesktopComputer(KEY, 'runner-fleet');
      const ref = host.allocateRef(rec.id);
      recordDesktopReserved({
        id: rec.id,
        placement: 'runner-fleet',
        runnerRef: ref,
        controlToken: 't',
      });
      // (Hub dies here.)
      const rt = runtimeOn(makeHost());
      expect(rt.runningCount()).toBe(1);
      await rt.adopt();
      expect(getDesktopComputer(KEY)!.runnerRef).toBeNull();
      expect(rt.runningCount()).toBe(0);
      expect(jobCount()).toBe(0);
    });

    it('crash after the enqueue, before the start is recorded: the claimed job is still owned', async () => {
      const host = makeHost();
      const rec = getOrCreateDesktopComputer(KEY, 'runner-fleet');
      const ref = host.allocateRef(rec.id);
      recordDesktopReserved({
        id: rec.id,
        placement: 'runner-fleet',
        runnerRef: ref,
        controlToken: 't',
      });
      await host.start({
        computerId: rec.id,
        key: KEY,
        controlToken: 't',
        homeRef: null,
        runnerRef: ref,
      });
      // (Hub dies here.) A runner claims the job: it is never unowned.
      const token = await register(['desktop']);
      const claimed = await claim(token);
      expect(claimed.body.jobId).toBe(ref);
      expect(findDesktopComputerByJob(ref)?.id).toBe(rec.id);

      const rt = runtimeOn(makeHost());
      await rt.adopt();
      // Counted, and its stop is pending on the runner: no second desktop.
      expect(getDesktopComputer(KEY)!.runnerRef).toBe(ref);
      expect(rt.runningCount()).toBe(1);
      await expect(rt.ensureStarted(KEY)).rejects.toThrow(/still shutting down/);
      await expect(
        rt.ensureStarted({ userId: 'u2', agentId: 'a1', projectId: 'p1' }),
      ).rejects.toThrow(/All 1 desktop slots/);
      expect(jobCount()).toBe(1);

      // The runner finishes; the next sweep confirms and frees the slot.
      await finish(token, ref);
      await rt.sweepIdle();
      expect(getDesktopComputer(KEY)!.runnerRef).toBeNull();
      expect(rt.runningCount()).toBe(0);
    });
  });
});
