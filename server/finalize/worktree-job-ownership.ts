/**
 * Align a fleet-materialized worktree with the Finalize job container's
 * `runner` account (uid/gid 1000).
 *
 * The runner-agent task and the per-job DinD container can run different image
 * tags during a rollout. Older agent images left `runner` on uid 1001 (ubuntu
 * occupied 1000); current job images pin `runner` to 1000. The agent then
 * materializes `/finalize-ws/repo` as 1001 and the job execs as 1000 → every
 * `npm ci` / `python3 -m venv` fails with EACCES on
 * `/github/workspace/frontend/node_modules` (and `.venv`).
 *
 * Chown after materialize closes the gap regardless of which agent image did
 * the clone. Requires passwordless sudo (granted to `runner` in the Finalize
 * Dockerfile).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Contract: job containers always `docker exec -u runner` with this uid/gid. */
export const FINALIZE_JOB_RUNNER_UID = 1000;
export const FINALIZE_JOB_RUNNER_GID = 1000;

export type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Recursively chown `destPath` to the job-container runner identity.
 * No-op when `destPath` is empty.
 */
export async function chownWorktreeForJobRunner(
  destPath: string,
  opts: {
    uid?: number;
    gid?: number;
    execFile?: ExecFileFn;
  } = {},
): Promise<void> {
  if (!destPath) return;
  const uid = opts.uid ?? FINALIZE_JOB_RUNNER_UID;
  const gid = opts.gid ?? FINALIZE_JOB_RUNNER_GID;
  const run = opts.execFile ?? execFileAsync;
  await run('sudo', ['chown', '-R', `${uid}:${gid}`, destPath]);
}
