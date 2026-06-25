/**
 * runner-backend.ts — pluggable execution backend for a single Finalize job.
 *
 * `runJobPhase` schedules job instances (honoring `needs`/`warmup` + concurrency)
 * and, for each, asks a `RunnerBackend` to `acquire()` a runner. The returned
 * `RunnerLease` exposes a `SpawnStepFn` (the existing step-execution seam) plus a
 * `release()` for teardown. The scheduler/orchestrator are backend-agnostic:
 *
 *   - `local`  — a privileged DinD container on the Hub host (today's behavior).
 *   - `remote` — enqueue to the multi-tenant control plane; a fleet runner-agent
 *                claims it and streams steps back (added in a later increment).
 *
 * Keeping this seam thin is what lets the remote backend reuse step-runner.ts,
 * the scheduler, and all DB/broadcast persistence unchanged.
 */
import type { SpawnStepFn } from './step-runner.js';
import type { RepoVisibility, RunnerResourceProfileName } from './runner-resource-profile.js';
import { createLocalRunnerBackend } from './runner-backend-local.js';
import { createRemoteRunnerBackend } from './runner-backend-remote.js';
import { LocalDirBundleStore, type BundleStore } from './worktree-bundle.js';
// S3 store lives in its own module so the AWS SDK is pulled in only here (the
// Hub), never into the runner-agent bundle (which imports worktree-bundle but
// not runner-backend) nor the local-default Hub path that never touches it.
import { S3BundleStore } from './worktree-bundle-s3.js';

/** Everything a backend needs to stand up a runner for one job instance. */
export interface JobClaimSpec {
  /** Tenant identity for the multi-tenant queue (local backend ignores these). */
  orgId: string;
  projectId: string;
  runId: string;
  jobId: string;
  matrixKey: string;
  /** Resolved runner image for `runs-on` (e.g. agent-hub finalize runner). */
  image: string;
  /** Hub-local worktree path (the local backend bind-mounts it; remote ships a bundle). */
  worktreePath: string;
  composeProjectName: string;
  /** Merged job env (top + job + matrix + builtins + project secrets). */
  env: NodeJS.ProcessEnv;
  labels: Record<string, string>;
  /**
   * Maximum time to wait for a runner agent to claim this job. The remote
   * backend caps its configured acquire timeout to this per-job remaining
   * budget so queued runner acquisition cannot outlive the Finalize run.
   */
  acquireTimeoutMs?: number;
  /**
   * The gated repo's GitHub visibility, detected Hub-side from the worktree's
   * origin remote. Selects the GitHub-parity resource tier when no explicit
   * FINALIZE_RUNNER_RESOURCE_PROFILE override is in force. Omitted/`'unknown'`
   * keeps the stricter default tier.
   */
  visibility?: RepoVisibility;
  /**
   * Caller-forced runner resource profile that wins over the env override and
   * the visibility tier. The Deployment Module orchestrator forces
   * `'unconstrained'` so deploy jobs run with the full host (deploys are real
   * build/ship work, NOT the GitHub-parity gate; see epic decision
   * `runner-profile`). Finalize gate jobs omit this so visibility/env apply.
   */
  resourceProfile?: RunnerResourceProfileName;
  /**
   * When true, steps run from ONLY this spec's `env` (plus the runner basics the
   * backend always sets), WITHOUT folding the Hub's `process.env`. The
   * Deployment Module sets this so arbitrary `deploy.yaml` commands never see the
   * Hub server's own environment (app/API keys, infra creds). Finalize gate jobs
   * omit it (the trusted gate gets the host toolchain env). Honoured by the local
   * DinD backend; the remote backend already ships only `env` over the wire.
   */
  minimalEnv?: boolean;
}

/** One job's runner, leased for the duration of its steps. */
export interface RunnerLease {
  /** Per-step execution — satisfies the existing SpawnStepFn contract. */
  spawnStep: SpawnStepFn;
  /** Tear the runner down (idempotent; safe on the error/timeout paths). */
  release(): Promise<void>;
}

export interface RunnerBackend {
  readonly kind: string;
  acquire(spec: JobClaimSpec): Promise<RunnerLease>;
}

let cached: RunnerBackend | null = null;

/**
 * Choose the worktree bundle store for the remote backend:
 *   - FINALIZE_WORKTREE_BUCKET set → S3 (cross-host fleet; agent fetches a
 *     presigned URL credential-free). Imported lazily so the agent bundle and
 *     the local-default Hub never pull in the AWS SDK.
 *   - else FINALIZE_RUNNER_BUNDLE_DIR set → local dir (same-host dev / Phase-2a).
 *   - else null (no worktree shipped — control-plane smoke only).
 */
function resolveBundleStore(): BundleStore | null {
  const bucket = process.env.FINALIZE_WORKTREE_BUCKET;
  if (bucket) {
    return new S3BundleStore({
      bucket,
      region:
        process.env.FINALIZE_WORKTREE_BUCKET_REGION ||
        process.env.AWS_REGION ||
        process.env.AWS_DEFAULT_REGION,
    });
  }
  const bundleDir = process.env.FINALIZE_RUNNER_BUNDLE_DIR;
  return bundleDir ? new LocalDirBundleStore(bundleDir) : null;
}

/**
 * Resolve the active backend. `local` (DinD on the Hub host) is the default and
 * permanent fallback; set `FINALIZE_RUNNER_BACKEND=remote` to dispatch to the
 * fleet (worktree shipped via S3 when FINALIZE_WORKTREE_BUCKET is set, else the
 * local-dir store at FINALIZE_RUNNER_BUNDLE_DIR for single-host/2a).
 */
export function resolveRunnerBackend(): RunnerBackend {
  if (cached) return cached;
  if ((process.env.FINALIZE_RUNNER_BACKEND ?? 'local').toLowerCase() === 'remote') {
    cached = createRemoteRunnerBackend({ store: resolveBundleStore() });
  } else {
    cached = createLocalRunnerBackend();
  }
  return cached;
}
