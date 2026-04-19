/**
 * Container lifecycle & quota-violation detection (W1).
 *
 * When a pooled container exits, the dispatcher needs to know *why* so it
 * can decide whether to reclaim the slot (clean exit), retry the job
 * (transient crash), or hold the slot out of the pool (quota violation
 * needs operator attention). This module is the narrow docker-side of
 * that decision — it runs `docker inspect` on the exited container and
 * returns a structured `ExitReason`.
 *
 * Why an injectable runner:
 *   Production uses `child_process.spawn('docker', ['inspect', ...])` but
 *   tests don't want to spawn anything. `DockerRunner` is a one-method
 *   interface so tests mock the single IO edge; everything above it is
 *   pure.
 *
 * Mapping (spec §3.3 "quota violation behavior"):
 *   State.OOMKilled = true       → kind: 'oom'   (mem_limit hit)
 *   ExitCode = 137               → kind: 'oom'   (SIGKILL, usually OOM)
 *   ExitCode = 139               → kind: 'crash' (SIGSEGV)
 *   Error contains "fork"        → kind: 'pids'  (pids_limit hit)
 *   ExitCode = 0                 → kind: 'clean'
 *   anything else                → kind: 'crash'
 *
 * `kind: 'oom'` and `kind: 'pids'` are both quota violations and route
 * the slot to the `failed` state. `'crash'` is treated as a crash (slot
 * reclaimable, job retry policy is the caller's call). `'clean'` is the
 * happy path — slot becomes free immediately.
 */

/** Single docker-CLI edge the rest of this module goes through. */
export interface DockerRunner {
  /**
   * Run `docker inspect <containerId>` (or equivalent) and return the raw
   * result of the first container. Should resolve with the parsed JSON
   * object (NOT the array docker normally emits) or throw if the
   * container id is unknown / the daemon is unreachable.
   */
  inspect(containerId: string): Promise<DockerInspectResult>;
  /**
   * Force-remove a container by id. Called after a quota-violation exit
   * so the container can't linger and consume disk. No-op if the
   * container is already gone. Errors are swallowed by the caller; we
   * don't want a best-effort reap to block the structured-error return.
   */
  remove(containerId: string): Promise<void>;
}

/**
 * Subset of `docker inspect` output we actually look at. The real object
 * is much larger; narrow it here so we don't leak the whole schema into
 * the type surface and so the test fixtures stay small.
 */
export interface DockerInspectResult {
  Id: string;
  State: {
    Status: string; // 'running' | 'exited' | ...
    ExitCode: number;
    OOMKilled: boolean;
    Error?: string;
    FinishedAt?: string;
  };
  Config?: {
    Labels?: Record<string, string>;
  };
}

/** Discriminant for why a pooled container stopped. */
export type ExitReasonKind = 'clean' | 'oom' | 'pids' | 'crash';

export interface ExitReason {
  kind: ExitReasonKind;
  /** Raw docker exit code, preserved for logs / triage. */
  exitCode: number;
  /** True iff the kernel reported the OOM-killer fired. Authoritative. */
  oomKilled: boolean;
  /** Human-readable one-liner — safe to surface to the user. */
  message: string;
  /** ISO timestamp from docker, if present. */
  finishedAt?: string;
  /** Echoed back so the caller can log {containerId, slotId, reason}. */
  containerId: string;
}

/**
 * True for reasons the pool treats as quota violations — slot goes to
 * `failed` and needs reclaim. Pure predicate, safe in logs / guards.
 */
export function isQuotaViolation(reason: ExitReason): boolean {
  return reason.kind === 'oom' || reason.kind === 'pids';
}

/**
 * Classify a raw docker-inspect result. Pure; no IO. Split out from
 * `classifyExit` so the lifecycle layer can run it against cached or
 * pre-fetched inspect payloads (e.g. a docker events stream that already
 * carries exit metadata).
 */
export function classifyInspect(inspect: DockerInspectResult): ExitReason {
  const state = inspect.State ?? { Status: 'unknown', ExitCode: -1, OOMKilled: false };
  const exitCode = state.ExitCode ?? -1;
  const oomKilled = Boolean(state.OOMKilled);
  const errMsg = state.Error ?? '';
  const finishedAt = state.FinishedAt;

  // OOM is authoritative: the kernel told docker the memcg OOM-killer
  // fired. Trust the flag over the exit code (137 is normal SIGKILL and
  // could also come from an external `docker kill`).
  if (oomKilled) {
    return {
      kind: 'oom',
      exitCode,
      oomKilled: true,
      message: `container OOM-killed (mem_limit exceeded, exit ${exitCode})`,
      finishedAt,
      containerId: inspect.Id,
    };
  }

  // pids_limit violations manifest as fork()→EAGAIN, which the runtime
  // surfaces in State.Error as a string containing "fork" / "EAGAIN".
  // This is a best-effort match — not every Docker version phrases it
  // the same way, so we also catch pids-adjacent errors here.
  if (/\bfork\b|EAGAIN|pids_limit|\bpids\b/i.test(errMsg)) {
    return {
      kind: 'pids',
      exitCode,
      oomKilled: false,
      message: `container hit pids_limit (${errMsg || 'fork failed'})`,
      finishedAt,
      containerId: inspect.Id,
    };
  }

  if (exitCode === 0) {
    return {
      kind: 'clean',
      exitCode: 0,
      oomKilled: false,
      message: 'container exited cleanly',
      finishedAt,
      containerId: inspect.Id,
    };
  }

  // Exit 137 without OOMKilled=true is usually an external `docker kill`
  // or a timeout; we still mark it as a crash because nothing we did
  // forced it and the slot is safe to reclaim.
  return {
    kind: 'crash',
    exitCode,
    oomKilled: false,
    message: errMsg ? `container exited ${exitCode}: ${errMsg}` : `container exited ${exitCode}`,
    finishedAt,
    containerId: inspect.Id,
  };
}

/**
 * Inspect a container via the injected runner and classify its exit. On
 * quota violations, also force-remove the container so it doesn't keep
 * consuming disk while the operator reclaims the slot.
 */
export async function classifyExit(containerId: string, runner: DockerRunner): Promise<ExitReason> {
  const inspect = await runner.inspect(containerId);
  const reason = classifyInspect(inspect);

  if (isQuotaViolation(reason)) {
    try {
      await runner.remove(containerId);
    } catch (err) {
      // Best-effort reap. The slot is still going to `failed` either way
      // and a stuck container gets picked up by the reaper on the next
      // `docker container prune` sweep.
      console.warn('[container-pool] reap failed', containerId, err);
    }
  }

  return reason;
}
