/**
 * Per-job runner startup phases: how long a Finalize job spends between
 * "job started" and "runner ready for its first step", split by phase.
 *
 * Both backends report the phases they own through `RunnerLease.startup`; the
 * job runner adds the Hub-side ones (repo visibility, cache restore, total) and
 * the orchestrator writes each as a `finalize_job_startup_seconds` sample.
 *
 * Phases, by where they happen:
 *   - Hub, both backends: `repo_visibility`, `total`, `cache_restore`
 *   - Hub-local backend:  `worktree` (per-job clone), `container_start`
 *     (`docker run` until the inner dockerd answers)
 *   - Remote backend, Hub-observed: `bundle` (git bundle + upload, or the wait
 *     on a sibling shard's bundle), `queue_wait` (enqueue until an agent
 *     claims), `bringup` (claim until the first step reaches the agent)
 *   - Remote backend, agent-reported: `clear_workspace`, `materialize`,
 *     `chown`, `container_start`
 */

export const JOB_STARTUP_PHASES = [
  'repo_visibility',
  'bundle',
  'queue_wait',
  'bringup',
  'clear_workspace',
  'materialize',
  'chown',
  'worktree',
  'container_start',
  'cache_restore',
  'total',
] as const;

export type JobStartupPhase = (typeof JOB_STARTUP_PHASES)[number];

/** Phase durations in milliseconds. Absent phases did not run. */
export type JobStartupTimings = Partial<Record<JobStartupPhase, number>>;

/** The bring-up phases a runner agent measures on its own host. */
export const AGENT_BRINGUP_PHASES = [
  'clear_workspace',
  'materialize',
  'chown',
  'container_start',
] as const satisfies readonly JobStartupPhase[];

export type AgentBringupPhase = (typeof AGENT_BRINGUP_PHASES)[number];
export type AgentBringupTimings = Partial<Record<AgentBringupPhase, number>>;

// A phase longer than a day is a clock bug, not a measurement.
const MAX_PHASE_MS = 24 * 60 * 60 * 1000;

function isPhaseMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PHASE_MS;
}

/**
 * Validate the untrusted bring-up timings an agent POSTs. Unknown keys and
 * out-of-range values are dropped; returns null when nothing usable is left.
 */
export function parseAgentBringupTimings(raw: unknown): AgentBringupTimings | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: AgentBringupTimings = {};
  for (const phase of AGENT_BRINGUP_PHASES) {
    const v = r[phase];
    if (isPhaseMs(v)) out[phase] = Math.round(v);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Run `fn`, adding its wall time (ms) to `timings[phase]` whether it resolves or throws. */
export async function timePhase<T, P extends string>(
  timings: Partial<Record<P, number>>,
  phase: P,
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const start = now();
  try {
    return await fn();
  } finally {
    timings[phase] = (timings[phase] ?? 0) + (now() - start);
  }
}
