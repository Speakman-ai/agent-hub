/**
 * Ancestry checks that stay correct on shallow session worktrees.
 *
 * Session worktrees are cloned and synced at `--depth 1`, so the history
 * behind the base commit is grafted away. `git merge-base --is-ancestor`
 * then answers "not an ancestor" (or "not a valid commit") for any commit
 * older than the base, even when it really is one. Dynamic test selection and
 * inherited-failure classification both ask exactly that question about an
 * older default-branch commit, so on a shallow clone they always fell back.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

/** `git merge-base --is-ancestor`: true / false, or null when git can't tell. */
export type IsAncestorFn = (
  repoDir: string,
  ancestor: string,
  descendant: string,
  env?: NodeJS.ProcessEnv,
) => Promise<boolean | null>;

/**
 * Cumulative `--deepen` steps. Bounded so a commit far in the past can never
 * unshallow a whole repo per session; past the cap the caller treats the
 * answer as "not an ancestor / unknown", which is always the safe direction.
 */
export const ANCESTRY_DEEPEN_STEPS = [128, 512, 2048] as const;

const FETCH_TIMEOUT_MS = 120_000;

export const plainIsAncestor: IsAncestorFn = async (repoDir, ancestor, descendant, env) => {
  if (ancestor === descendant) return true;
  try {
    await execFileP('git', ['-C', repoDir, 'merge-base', '--is-ancestor', ancestor, descendant], {
      timeout: 30_000,
      ...(env ? { env } : {}),
    });
    return true;
  } catch (err) {
    // Exit 1 is "not an ancestor"; anything else (missing object) is unknown.
    return (err as { code?: unknown }).code === 1 ? false : null;
  }
};

async function isShallowRepo(repoDir: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', repoDir, 'rev-parse', '--is-shallow-repository'],
      { timeout: 30_000, ...(env ? { env } : {}) },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Like {@link plainIsAncestor}, but when a shallow clone can't confirm the
 * ancestry it deepens the origin default branch in bounded steps and asks
 * again. Only use it where the expected answer is "yes": a genuine "no" pays
 * for every deepen step before returning.
 */
export const shallowAwareIsAncestor: IsAncestorFn = async (repoDir, ancestor, descendant, env) => {
  let result = await plainIsAncestor(repoDir, ancestor, descendant, env);
  if (result === true) return true;
  for (const step of ANCESTRY_DEEPEN_STEPS) {
    if (!(await isShallowRepo(repoDir, env))) return result;
    try {
      await execFileP(
        'git',
        ['-C', repoDir, 'fetch', '--quiet', '--no-tags', `--deepen=${step}`, 'origin', 'HEAD'],
        { timeout: FETCH_TIMEOUT_MS, ...(env ? { env } : {}) },
      );
    } catch {
      return result;
    }
    result = await plainIsAncestor(repoDir, ancestor, descendant, env);
    if (result === true) return true;
  }
  return result;
};
