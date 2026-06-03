import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
