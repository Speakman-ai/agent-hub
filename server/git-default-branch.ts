import { exec } from 'child_process';
import { promisify } from 'util';

// Promisify lazily (not at module load): this module is now reachable
// from import chains that tests load with a partial `child_process`
// mock (spawn/execFile only) — a module-level `promisify(exec)` throws
// "No exec export is defined" before the test even runs.
let execAsyncCached: ((cmd: string, opts: { cwd: string }) => Promise<{ stdout: string }>) | null =
  null;
function execAsync(cmd: string, opts: { cwd: string }): Promise<{ stdout: string }> {
  if (!execAsyncCached) {
    execAsyncCached = promisify(exec) as unknown as typeof execAsyncCached;
  }
  return execAsyncCached!(cmd, opts);
}

/**
 * Resolve the repo's default branch from a worktree checkout.
 *
 * Order matches `auto-git.ts` (now shared):
 *   1. `origin/HEAD` symbolic ref
 *   2. local `main`
 *   3. local `master`
 *   4. `null` when unknown
 */
export async function resolveDefaultBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', { cwd });
    const ref = stdout.trim().replace('refs/remotes/origin/', '');
    if (ref) return ref;
  } catch {
    // origin/HEAD not set — try local branches
  }
  for (const candidate of ['main', 'master']) {
    try {
      await execAsync(`git rev-parse --verify ${candidate}`, { cwd });
      return candidate;
    } catch {
      // branch doesn't exist locally
    }
  }
  return null;
}
