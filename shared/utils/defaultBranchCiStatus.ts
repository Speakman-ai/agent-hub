/**
 * Status of the latest CI-on-push run for a project's default branch, shown
 * at the top of the Repository page (web `RepositoryPage`, mobile
 * `RepositoryScreen`) when the project has CI on push enabled.
 */

export type DefaultBranchCiTone = 'passed' | 'failed' | 'running' | 'cancelled' | 'none';

export interface DefaultBranchCiStatus {
  tone: DefaultBranchCiTone;
  label: string;
  branch: string | null;
  sha: string | null;
  /** Epoch ms of the run's end, or its start while it is still running. */
  at: number | null;
  failingJobs: string[];
}

const PASSED = new Set(['succeeded', 'ready_to_push', 'pushed']);
const FAILED = new Set(['failed', 'timed_out', 'infra_error', 'disputed']);
const IN_FLIGHT_JOB_STATES = new Set(['queued', 'running']);

/** True when the project has CI on push turned on. */
export function ciOnPushEnabled(project: unknown): boolean {
  return (project as { ciOnPush?: { enabled?: unknown } } | null)?.ciOnPush?.enabled === true;
}

/** Newest push-CI run from a `GET /ci-runs` response (array or `{ runs }`). */
export function latestPushRun(raw: unknown): Record<string, any> | null {
  const runs = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { runs?: unknown } | null)?.runs)
      ? (raw as { runs: unknown[] }).runs
      : [];
  const pushRuns = runs.filter(
    (r): r is Record<string, any> =>
      !!r && typeof r === 'object' && (r as any).trigger_source === 'git_push',
  );
  if (pushRuns.length === 0) return null;
  return pushRuns.reduce((a, b) => ((b.started_at ?? 0) > (a.started_at ?? 0) ? b : a));
}

function jobName(job: Record<string, any>): string {
  const key = job.matrix_key;
  return key && key !== 'default' ? `${job.job_id} · ${key}` : String(job.job_id ?? '');
}

export function defaultBranchCiStatus(run: Record<string, any> | null): DefaultBranchCiStatus {
  if (!run) {
    return {
      tone: 'none',
      label: 'No CI run on the default branch yet',
      branch: null,
      sha: null,
      at: null,
      failingJobs: [],
    };
  }
  const branch = typeof run.branch === 'string' && run.branch ? run.branch : null;
  const sha = typeof run.head_sha === 'string' && run.head_sha ? run.head_sha : null;
  const jobs: Record<string, any>[] = Array.isArray(run.jobs) ? run.jobs : [];
  const failingJobs = jobs.filter((j) => j?.state === 'failed').map(jobName);
  const jobsInFlight = jobs.some((j) => IN_FLIGHT_JOB_STATES.has(j?.state));
  const status = String(run.status ?? '');
  const name = branch ?? 'default branch';

  let tone: DefaultBranchCiTone;
  // A run can turn `failed` on the first red shard while others still run;
  // red wins over "running" since the outcome is already decided.
  if (FAILED.has(status)) tone = 'failed';
  else if (PASSED.has(status) && !jobsInFlight) tone = 'passed';
  else if (status === 'cancelled' && !jobsInFlight) tone = 'cancelled';
  else tone = 'running';

  let label: string;
  if (tone === 'failed') {
    const n = failingJobs.length;
    label =
      n > 0
        ? `CI failing on ${name}: ${n} failed job${n === 1 ? '' : 's'}`
        : `CI failing on ${name}`;
  } else if (tone === 'passed') label = `CI passing on ${name}`;
  else if (tone === 'cancelled') label = `CI cancelled on ${name}`;
  else label = `CI running on ${name}`;

  const at =
    tone === 'running'
      ? typeof run.started_at === 'number'
        ? run.started_at
        : null
      : typeof run.ended_at === 'number'
        ? run.ended_at
        : typeof run.started_at === 'number'
          ? run.started_at
          : null;

  return { tone, label, branch, sha, at, failingJobs };
}

/** Poll faster while a run is in flight so the badge flips soon after it settles. */
export const DEFAULT_BRANCH_CI_POLL_MS = 30_000;
export const DEFAULT_BRANCH_CI_RUNNING_POLL_MS = 10_000;
