/**
 * deploy-acquire-retry.ts — bounded auto-retry for the deploy runner-acquire
 * step.
 *
 * A deploy runs on the SAME runner backend as Finalize (local DinD or the
 * remote fleet). The FIRST thing `runDeployment` does after transitioning to
 * `running` is `backend.acquire(spec)` — enqueue a runner job and wait for a
 * fleet agent to claim it and attach. That acquire can fail transiently before
 * any deploy step has executed:
 *
 *   - `runner-agent lost before attach ... lease expired with no heartbeat`
 *     — an agent claimed the job then crashed / was OOM-killed / lost contact
 *     with the Hub, or its EC2 Spot instance was reclaimed mid-bring-up.
 *   - `no runner-agent claimed job ... within <n>ms` — the fleet had no
 *     capacity for this job class inside the acquire window.
 *
 * Finalize already treats this exact class as infra and auto-retries it on a
 * fresh agent ({@link ../finalize/infra-retry}). Deploys historically did not:
 * a single transient blip terminalized the whole deployment as `error` and
 * forced a manual re-trigger. This module closes that gap for the acquire path
 * ONLY — retrying the acquire is safe because it runs BEFORE any deploy step,
 * so a retry can never cause a partial or double deploy. (The riskier mid-run
 * "runner died under a step" case is tracked separately.)
 *
 * The retry is DELIBERATELY narrow:
 *   - It only wraps the `backend.acquire()` call. Deterministic setup that runs
 *     before acquire (bad runs-on image, secret / GitHub-token resolution) is
 *     never re-run — those recur identically and are handled by the caller.
 *   - A KNOWN-deterministic acquire failure (a `git bundle` failure while
 *     shipping the worktree to a remote runner — "Refusing to create empty
 *     bundle") short-circuits immediately: re-acquiring re-runs the same broken
 *     bundle, so retrying would only livelock the fleet. This mirrors
 *     `job-runner.ts`'s `worktree_bundle_failed` classification.
 *   - Everything else from acquire is treated as transient infra and retried up
 *     to a bounded number of attempts, then re-thrown so the caller terminalizes
 *     the deployment (releasing the env lock).
 */
import type { JobClaimSpec, RunnerBackend, RunnerLease } from '../finalize/runner-backend.js';
import { isWorktreeBundleFailureMessage } from '../finalize/worktree-bundle.js';

/**
 * Total acquire attempts (the original try + retries) for a transient failure.
 * Small by design: the transient causes (Spot reclaim, agent crash, momentary
 * no-capacity) clear quickly once the fleet scaler brings up a fresh agent, so
 * a few attempts recover the common case without dragging a doomed deploy on.
 * Env-overridable for ops tuning; read at call time so a deploy or a test can
 * tune it without a re-import. Values below 1 coerce to 1 (always at least the
 * historical single attempt); a non-finite / empty env falls back to the
 * default.
 */
export const DEFAULT_DEPLOY_ACQUIRE_ATTEMPTS = 3;

/** Backoff between acquire attempts, in ms. Env-overridable. */
export const DEFAULT_DEPLOY_ACQUIRE_BACKOFF_MS = 2_000;

function readPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  dflt: number,
  floor: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return dflt;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(floor, n);
}

/** Resolve the configured attempt count (>= 1). */
export function resolveDeployAcquireAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv(env, 'DEPLOY_ACQUIRE_MAX_ATTEMPTS', DEFAULT_DEPLOY_ACQUIRE_ATTEMPTS, 1);
}

/** Resolve the configured backoff (>= 0 ms). */
export function resolveDeployAcquireBackoffMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv(env, 'DEPLOY_ACQUIRE_BACKOFF_MS', DEFAULT_DEPLOY_ACQUIRE_BACKOFF_MS, 0);
}

/**
 * Is this acquire error transient (worth retrying) rather than deterministic?
 *
 * Mirrors `job-runner.ts`: a generic acquire failure is transient infra
 * (Spot reclaim, lost agent, momentary no-capacity), EXCEPT a deterministic
 * `git bundle` failure which recurs identically on retry. Keeping the
 * deterministic list explicit (rather than an allowlist of transient strings)
 * means a novel transient loss message is still retried, while the one known
 * livelock case is excluded.
 */
export function isRetryableAcquireError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (isWorktreeBundleFailureMessage(msg)) return false;
  return true;
}

export interface AcquireRetryOptions {
  /** Total attempts (original + retries). Defaults to the env-resolved value. */
  attempts?: number;
  /** Backoff between attempts, in ms. Defaults to the env-resolved value. */
  backoffMs?: number;
  /** Sleep injection for deterministic tests. Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Abort the retry loop early (e.g. the deployment was cancelled). Checked
   * BEFORE every `backend.acquire` attempt (including the first) and before
   * each backoff retry. When it returns true the loop stops immediately without
   * acquiring — a cancelled deployment never stands up a runner — and throws
   * the prior transient error (or a synthetic cancellation error at entry).
   */
  isCancelled?: () => boolean;
  /** Called before each retry (2nd attempt onward) with the 1-based retry #. */
  onRetry?: (retry: number, attempts: number, detail: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire a runner lease with bounded retry on transient failures.
 *
 * Resolves with the lease on the first successful acquire. Re-throws the last
 * error when: attempts are exhausted, the failure is deterministic
 * ({@link isRetryableAcquireError} → false), or the deployment was cancelled
 * mid-retry. The caller's existing catch then terminalizes the deployment and
 * releases the env lock — so a give-up leaks nothing.
 */
export async function acquireRunnerWithRetry(
  backend: RunnerBackend,
  spec: JobClaimSpec,
  opts: AcquireRetryOptions = {},
): Promise<RunnerLease> {
  const attempts = Math.max(1, opts.attempts ?? resolveDeployAcquireAttempts());
  const backoffMs = Math.max(0, opts.backoffMs ?? resolveDeployAcquireBackoffMs());
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Pre-attempt cancellation guard. Checked BEFORE `backend.acquire` on every
    // attempt — including the first — so a deployment that was already cancelled
    // (at entry, or between a prior failure's backoff and this attempt) never
    // enqueues/acquires a runner. Without this, a cancelled deploy could still
    // stand up a live lease. Re-throw the prior transient error when we have one
    // (matches the surfaced cause), else a synthetic cancellation error.
    if (opts.isCancelled?.()) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error('deploy runner acquire aborted: deployment cancelled before first attempt');
    }
    try {
      return await backend.acquire(spec);
    } catch (err) {
      lastErr = err;
      const detail = err instanceof Error ? err.message : String(err);
      const isLast = attempt >= attempts;
      // Deterministic failures recur identically — never retry them.
      if (!isRetryableAcquireError(err)) throw err;
      // No point sleeping+retrying if we've run out of attempts or the deploy
      // was cancelled underneath us.
      if (isLast || opts.isCancelled?.()) throw err;
      opts.onRetry?.(attempt, attempts, detail);
      if (backoffMs > 0) await sleep(backoffMs);
      // The next iteration's pre-attempt guard re-checks cancellation, so a
      // cancel that arrives during the backoff stops us before the next acquire.
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the type.
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
