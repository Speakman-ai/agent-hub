/**
 * runner-backend-remote.ts — RunnerBackend that runs a job on the remote fleet.
 *
 * acquire() enqueues the job on the control-plane queue and creates a per-job
 * channel, then waits for a pull-based agent to claim + attach (its first poll).
 * The returned lease's spawnStep pushes each step to the agent over the channel
 * and hands back a RemoteSpawnedStep; release() tells the agent to tear down.
 *
 * Selected only when FINALIZE_RUNNER_BACKEND=remote (+ per-org allowlist); the
 * local DinD backend stays the default. The worktree reaches the agent via an
 * S3 bundle ref added to the wire spec by the worktree-bundle increment.
 */
import { createJobChannel, removeJobChannel } from './runner-job-channel.js';
import { enqueueRunnerJob, reportRunnerJob } from './runner-queue.js';
import { reconcileFleetCapacity } from './runner-fleet-scaler.js';
import type { JobClaimSpec, RunnerBackend, RunnerLease } from './runner-backend.js';
import type { RepoVisibility } from './runner-resource-profile.js';
import type { SpawnStepArgs } from './step-runner.js';
import {
  createWorktreeBundle,
  worktreeBundleKey,
  type BundleStore,
  type WorktreeRef,
} from './worktree-bundle.js';

// How long a dispatched job waits for an agent to claim it before it's marked
// lost. With uncapped Hub dispatch (the remote default) every shard is enqueued
// at once, so a job can legitimately sit behind a busy fleet for a while — this
// is generous (1h) so a job that's just waiting its turn isn't failed; it only
// trips when the fleet is genuinely dead/unscalable. Override with
// FINALIZE_RUNNER_ACQUIRE_TIMEOUT_MS.
const DEFAULT_ACQUIRE_TIMEOUT_MS = 60 * 60_000;

function envAcquireTimeoutMs(): number | undefined {
  const n = Number.parseInt(process.env.FINALIZE_RUNNER_ACQUIRE_TIMEOUT_MS?.trim() ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The job description delivered to the agent (no functions; no Hub-local paths). */
export interface RunnerJobWireSpec {
  orgId: string;
  projectId: string;
  runId: string;
  jobId: string;
  matrixKey: string;
  image: string;
  composeProjectName: string;
  env: Record<string, string>;
  /**
   * The gated repo's GitHub visibility, detected Hub-side. Carried over the wire
   * so the fleet runner-agent caps the container to the same GitHub-parity tier
   * the Hub would (parity seam). Omitted/`'unknown'` keeps the stricter default.
   */
  visibility?: RepoVisibility;
  /** Worktree bundle ref (git bundle in the shared store) the agent fetches. */
  worktreeRef?: WorktreeRef | null;
}

function toEnvRecord(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

export function createRemoteRunnerBackend(opts?: {
  store?: BundleStore | null;
  acquireTimeoutMs?: number;
  now?: () => number;
  /** Injectable for tests; defaults to the real git-bundle producer. */
  createBundle?: typeof createWorktreeBundle;
}): RunnerBackend {
  const now = opts?.now ?? Date.now;
  const acquireTimeoutMs =
    opts?.acquireTimeoutMs ?? envAcquireTimeoutMs() ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const store = opts?.store ?? null;
  const createBundle = opts?.createBundle ?? createWorktreeBundle;
  // One worktree bundle per (run, head SHA): all of a round's matrix shards
  // share it, but a fix-dispatch round that advances HEAD BUSTS the entry so the
  // fleet rebuilds against the new commit. Keying by runId alone caused a silent
  // stale-code livelock — the runId is stable across rounds, so the fleet kept
  // re-testing round 1's code while FINALIZE_HEAD_SHA and the reviewer advanced,
  // failing the gate forever (this backend is a process singleton). Storing one
  // entry per runId (replaced on SHA change) also bounds growth within a run.
  const bundleByRun = new Map<string, { sha: string; pending: Promise<WorktreeRef> }>();

  return {
    kind: 'remote',
    async acquire(spec: JobClaimSpec): Promise<RunnerLease> {
      let worktreeRef: WorktreeRef | null = null;
      if (store) {
        // Bundle once per (run, head SHA) — memoized so a round's shards share
        // it, busted when a new fix-round advances HEAD. Presign per-acquire so
        // each matrix shard gets a fresh-TTL credential-free download URL.
        const headSha = (spec.env?.FINALIZE_HEAD_SHA ?? spec.env?.GIT_COMMIT_SHA ?? '')
          .toString()
          .trim();
        let entry = bundleByRun.get(spec.runId);
        if (!entry || entry.sha !== headSha) {
          const pending = createBundle({
            worktreePath: spec.worktreePath,
            key: worktreeBundleKey(spec.orgId, spec.runId, headSha || undefined),
            store,
            // Pin the bundle to the validated commit so its content provably
            // matches FINALIZE_HEAD_SHA (not just "whatever HEAD is right now").
            rev: headSha || undefined,
          });
          entry = { sha: headSha, pending };
          bundleByRun.set(spec.runId, entry); // replaces any stale prior-round entry
        }
        const baseRef = await entry.pending;
        const getUrl = store.presignGet ? await store.presignGet(baseRef.key) : null;
        worktreeRef = getUrl ? { ...baseRef, getUrl } : baseRef;
      }
      const wire: RunnerJobWireSpec = {
        orgId: spec.orgId,
        projectId: spec.projectId,
        runId: spec.runId,
        jobId: spec.jobId,
        matrixKey: spec.matrixKey,
        image: spec.image,
        composeProjectName: spec.composeProjectName,
        env: toEnvRecord(spec.env),
        visibility: spec.visibility,
        worktreeRef,
      };
      const queueJobId = enqueueRunnerJob({
        orgId: spec.orgId || 'default',
        projectId: spec.projectId || 'default',
        runId: spec.runId,
        jobId: spec.jobId,
        matrixKey: spec.matrixKey,
        image: spec.image,
        specJson: JSON.stringify(wire),
        now: now(),
      });
      // Scale the agent fleet up to meet the new queue depth (fast ramp; the
      // periodic reconcile + scale-down-when-idle is handled by the scaler).
      void reconcileFleetCapacity();
      const channel = createJobChannel(queueJobId);

      // Wait for an agent to claim + make its first poll (attach). Once the
      // fleet has scaled up this is quick; the (generous) timeout only guards
      // against a fleet that never comes up, not one that's merely busy.
      const attached = await Promise.race([
        channel.ready.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), acquireTimeoutMs)),
      ]);
      if (!attached) {
        removeJobChannel(queueJobId);
        reportRunnerJob({
          jobId: queueJobId,
          state: 'lost',
          detail: 'no runner-agent claimed in time',
          now: now(),
        });
        throw new Error(
          `no runner-agent claimed job ${spec.jobId} (${queueJobId}) within ${acquireTimeoutMs}ms`,
        );
      }

      return {
        spawnStep: ({ step, index, env }: SpawnStepArgs) =>
          channel.runStep(index, step.run, toEnvRecord(env)),
        release: async () => {
          channel.finish();
          // Queue-level "the runner completed its lease" — the authoritative
          // pass/fail lives in the per-org run state written by runJobInstance.
          reportRunnerJob({ jobId: queueJobId, state: 'succeeded', now: now() });
          removeJobChannel(queueJobId);
        },
      };
    },
  };
}
