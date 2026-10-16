/**
 * Runner-fleet placement for container desktops (FINALIZE_RUNNER_BACKEND=remote).
 *
 * A desktop is a `desktop` job on the runner queue. The claiming agent pulls
 * the last home snapshot from the Hub, runs the desktop image, reports its
 * control endpoint, and holds it until the row is cancelled. On cancel it
 * removes the container, uploads the home, and only then finishes the job.
 *
 * Cancelling the row is a request, not a stop: `stop` reports `confirmed`
 * only once the runner finished the job (container gone, home accepted) or
 * has been silent long enough that the runner contract in
 * desktop-fleet-contract.ts guarantees its container is gone. Until then the
 * runtime keeps the job as the computer's runner ref and holds its slot.
 */
import { randomUUID } from 'crypto';
import { getOrgsDb } from '../orgs.js';
import {
  cancelRunnerJob,
  enqueueRunnerJob,
  getRunnerJobStatus,
  type RunnerJobStatus,
} from '../finalize/runner-queue.js';
import { reconcileFleetCapacity } from '../finalize/runner-fleet-scaler.js';
import { DEFAULT_RUNNER_CLASS } from '../finalize/runner-images.js';
import type { RunnerJobWireSpec } from '../finalize/runner-backend-remote.js';
import type { DesktopContainerHost, DesktopHostStatus } from './container-desktop-host.js';
import {
  resolveDesktopContainerLimits,
  type DesktopContainerLimits,
} from './desktop-container-args.js';
import { DESKTOP_SPOT_RECLAIM_GRACE_MS } from './desktop-fleet-contract.js';
import {
  findDesktopComputerByJob,
  forgetDesktopHomeObject,
  listDesktopHomeObjectsToDelete,
  markDesktopHomeObjectOrphan,
  recordDesktopHomeObjectWriting,
  recordDesktopHomeSnapshot,
} from './desktop-containers-store.js';
import { homeSnapshotKey, type DesktopHomeStore } from './desktop-home-store.js';

/** Wire payload of a `desktop` job (RunnerJobWireSpec.desktop). */
export interface RunnerDesktopSpec {
  computerId: string;
  controlToken: string;
  memory: string;
  cpus: string;
  /** True when the Hub holds a home snapshot for the agent to restore. */
  restoreHome: boolean;
}

export interface FleetDesktopHostDeps {
  homeStore: () => Promise<DesktopHomeStore>;
  orgId: () => string;
  limits?: DesktopContainerLimits;
  /** Silence after a Spot interruption notice that proves the host was reclaimed. */
  spotReclaimGraceMs?: number;
  now?: () => number;
  scale?: () => void;
  log?: (msg: string) => void;
}

export function mapDesktopJobStatus(row: RunnerJobStatus | null): DesktopHostStatus {
  if (!row) return { state: 'lost', endpoint: null, detail: 'runner job record is gone' };
  switch (row.state) {
    case 'queued':
      return { state: 'pending', endpoint: null, detail: null };
    case 'claimed':
    case 'running':
      return row.endpoint
        ? { state: 'running', endpoint: row.endpoint, detail: null }
        : { state: 'starting', endpoint: null, detail: null };
    case 'failed':
    case 'lost':
      return { state: 'lost', endpoint: null, detail: row.detail ?? 'runner lost' };
    default:
      return { state: 'stopped', endpoint: null, detail: row.detail };
  }
}

export function createFleetDesktopHost(deps: FleetDesktopHostDeps): DesktopContainerHost {
  const limits = deps.limits ?? resolveDesktopContainerLimits();
  const now = deps.now ?? Date.now;
  const scale = deps.scale ?? (() => void reconcileFleetCapacity());
  const log = deps.log ?? ((m: string) => console.log(`[desktop] ${m}`));
  const spotReclaimGraceMs = deps.spotReclaimGraceMs ?? DESKTOP_SPOT_RECLAIM_GRACE_MS;

  return {
    placement: 'runner-fleet',
    async start(req) {
      const orgId = deps.orgId() || 'default';
      const desktop: RunnerDesktopSpec = {
        computerId: req.computerId,
        controlToken: req.controlToken,
        memory: limits.memory,
        cpus: limits.cpus,
        restoreHome: req.homeRef !== null,
      };
      const wire: RunnerJobWireSpec = {
        orgId,
        projectId: req.key.projectId,
        runId: `desktop-${req.computerId}`,
        jobId: 'desktop',
        matrixKey: 'desktop',
        image: limits.image,
        composeProjectName: '',
        env: {},
        resourceProfile: 'unconstrained',
        minimalEnv: true,
        kind: 'desktop',
        desktop,
      };
      // The runtime recorded req.runnerRef before this call; the row is
      // created under that id, so it is never claimable without an owner.
      enqueueRunnerJob({
        id: req.runnerRef,
        orgId,
        projectId: req.key.projectId,
        runId: wire.runId,
        jobId: wire.jobId,
        matrixKey: wire.matrixKey,
        image: limits.image,
        runnerClass: DEFAULT_RUNNER_CLASS,
        kind: 'desktop',
        specJson: JSON.stringify(wire),
        now: now(),
      });
      scale();
      return { homeRef: req.homeRef };
    },
    allocateRef: () => randomUUID(),
    async status(ref) {
      return mapDesktopJobStatus(getRunnerJobStatus(ref));
    },
    async stop(ref) {
      if (cancelRunnerJob({ jobId: ref, detail: 'desktop stopped', now: now() })) scale();
      // Evidence only (see desktop-fleet-contract.ts); silence alone is not.
      const holder = runnerHolding(ref);
      if (!holder) return { confirmed: true };
      if (holder.agentState === 'dead') {
        log(`desktop job ${ref}: its runner was retired as dead; container gone with its host`);
        return { confirmed: true };
      }
      const quietSince = Math.max(holder.lastSeenAt ?? 0, holder.spotInterruptionAt ?? 0);
      if (holder.spotInterruptionAt !== null && now() - quietSince >= spotReclaimGraceMs) {
        log(`desktop job ${ref}: its Spot host was reclaimed; container gone with it`);
        return { confirmed: true };
      }
      return { confirmed: false };
    },
    async deleteHome(computerId) {
      const store = await deps.homeStore();
      await store.deletePrefix(`${computerId}/`);
    },
  };
}

/**
 * The runner still working the job (it has not finished it), with the
 * evidence `stop` weighs; null once it finished or for a job never claimed.
 */
export function runnerHolding(jobId: string): {
  agentId: string;
  agentState: string;
  lastSeenAt: number | null;
  spotInterruptionAt: number | null;
} | null {
  const row = getOrgsDb()
    .prepare(
      `SELECT a.id AS agentId, a.state AS agentState, a.last_seen_at AS lastSeenAt,
              j.spot_interruption_at AS spotInterruptionAt
         FROM runner_jobs j JOIN runner_agents a ON a.id = j.claimed_by
        WHERE j.id = ? AND a.current_job_id = j.id`,
    )
    .get(jobId) as
    | {
        agentId: string;
        agentState: string;
        lastSeenAt: number | null;
        spotInterruptionAt: number | null;
      }
    | undefined;
  return row ?? null;
}

/**
 * Agent download of the computer's last home snapshot, for the job it is
 * running. `none` when the computer has no snapshot yet; `missing` when it
 * has one the store can't produce (the agent must not start on a fresh home
 * then, or its upload would replace the real one).
 */
export async function readDesktopHomeForJob(
  jobId: string,
  store: DesktopHomeStore,
  destPath: string,
): Promise<'ok' | 'none' | 'missing'> {
  const rec = findDesktopComputerByJob(jobId);
  if (!rec || rec.runnerRef !== jobId || !rec.homeRef) return 'none';
  return (await store.get(rec.homeRef, destPath)) ? 'ok' : 'missing';
}

/**
 * Agent upload of the home at the end of a run. Each request stores its own
 * object (a fresh key per attempt, so overlapping retries never share one),
 * then commits it as the computer's home in one transaction, but only while
 * the job still owns the computer. The object is tracked before it is written
 * and until it is either that home or confirmed deleted, so neither a losing
 * attempt (one finishing after its computer moved on or was deleted) nor the
 * snapshot a commit replaces can be left behind: a failed delete stays
 * tracked and the janitor retries it. False when this attempt was not adopted.
 */
export async function saveDesktopHomeForJob(
  jobId: string,
  store: DesktopHomeStore,
  filePath: string,
  now: () => number = Date.now,
): Promise<boolean> {
  const rec = findDesktopComputerByJob(jobId);
  if (!rec) return false;
  const key = homeSnapshotKey(rec.id, jobId, randomUUID());
  recordDesktopHomeObjectWriting(key, rec.id, now());
  try {
    await store.put(key, filePath);
  } catch (err) {
    // A partial object may exist; it must not outlive this failure.
    markDesktopHomeObjectOrphan(key, rec.id, now(), (err as Error).message);
    await deleteTrackedHomeObject(store, key, rec.id, now);
    throw err;
  }
  const result = recordDesktopHomeSnapshot({ id: rec.id, jobId, homeRef: key, now: now() });
  if (!result.committed) {
    await deleteTrackedHomeObject(store, key, rec.id, now);
    return false;
  }
  if (result.previous) await deleteTrackedHomeObject(store, result.previous, rec.id, now);
  return true;
}

/** Delete a tracked object; forget it only once the delete succeeded. */
async function deleteTrackedHomeObject(
  store: DesktopHomeStore,
  key: string,
  computerId: string,
  now: () => number,
): Promise<boolean> {
  try {
    await store.delete(key);
    forgetDesktopHomeObject(key);
    return true;
  } catch (err) {
    markDesktopHomeObjectOrphan(key, computerId, now(), (err as Error).message);
    console.warn(
      `[desktop] could not delete home object ${key} (will retry): ${(err as Error).message}`,
    );
    return false;
  }
}

/** A put still unresolved after this long means the Hub died during it. */
export const DESKTOP_HOME_WRITE_ABANDONED_MS = 6 * 60 * 60_000;

/**
 * Retry deleting every home object that must go: orphans, and writes the Hub
 * abandoned mid-put. Returns how many are still pending.
 */
export async function sweepDesktopHomeObjects(
  store: DesktopHomeStore,
  now: () => number = Date.now,
): Promise<number> {
  let pending = 0;
  for (const { key, computerId } of listDesktopHomeObjectsToDelete(
    now() - DESKTOP_HOME_WRITE_ABANDONED_MS,
  )) {
    if (!(await deleteTrackedHomeObject(store, key, computerId, now))) pending++;
  }
  return pending;
}
