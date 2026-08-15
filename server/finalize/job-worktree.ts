/**
 * Per-job worktree copies for Hub-local Finalize runners.
 *
 * GitHub Actions gives every job a fresh checkout. The local DinD backend
 * used to bind-mount the *same* host directory into every parallel job
 * container. Survey Tracker (and any other repo) then races
 * `python3 -m venv .venv` and `npm ci` across shards — mkdir of
 * `.venv` / `frontend/node_modules` fails with EACCES even though unix
 * perms look fine, because a sibling job is deleting/recreating the tree.
 *
 * Each local job therefore clones into `.finalize-source/<runId>.job.<slug>`
 * and bind-mounts that copy. The remote fleet already isolates per agent box.
 */
import { execFile } from 'child_process';
import { cp, mkdir, rm } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const CLONE_TIMEOUT_MS = 180_000;

export function sanitizeJobWorktreeSlug(jobId: string, matrixKey: string): string {
  const raw = `${jobId}-${matrixKey || 'default'}`;
  const slug = raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'job').slice(0, 80);
}

/** Sibling of the run's staging checkout, still under `.finalize-source`. */
export function jobWorktreePath(
  root: string,
  runId: string,
  jobId: string,
  matrixKey: string,
): string {
  return path.join(root, `${runId}.job.${sanitizeJobWorktreeSlug(jobId, matrixKey)}`);
}

/**
 * Materialise an independent working tree at `dest` from `src`.
 *
 * Prefers `git clone --local --no-hardlinks` (copied objects + worktree).
 * `--local` skips the git-aware transport for a same-host path; `--no-hardlinks`
 * is required because the job container's entrypoint `chown -R`s the bind
 * mount to `runner`. Hardlinked `.git/objects` would also rewrite ownership
 * of the session/staging repo those inodes still name. Falls back to a
 * recursive copy when `src` is not a git checkout.
 */
export async function materializeJobWorktree(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await execFileAsync('git', ['clone', '--local', '--no-hardlinks', '--quiet', src, dest], {
      timeout: CLONE_TIMEOUT_MS,
    });
  } catch {
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true, force: true, errorOnExist: false });
  }
}
