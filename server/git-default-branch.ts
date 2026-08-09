import { exec } from 'child_process';
import { promisify } from 'util';
import type { SessionWorktreeIo } from './session-env/worktree-io.js';

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

/** Run git and report success separately from output, however git is reached. */
type DefaultBranchGit = (args: string[]) => Promise<{ stdout: string; ok: boolean }>;

/**
 * Resolve the repo's default branch.
 *
 * Order matches `auto-git.ts` (now shared):
 *   1. `origin/HEAD` symbolic ref
 *   2. local `main`
 *   3. local `master`
 *   4. `null` when unknown
 */
async function resolveDefaultBranchVia(git: DefaultBranchGit): Promise<string | null> {
  const symbolic = await git(['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (symbolic.ok) {
    const ref = symbolic.stdout.trim().replace('refs/remotes/origin/', '');
    if (ref) return ref;
  }
  for (const candidate of ['main', 'master']) {
    if ((await git(['rev-parse', '--verify', candidate])).ok) return candidate;
  }
  return null;
}

/**
 * Resolve the default branch of a checkout at a host path.
 *
 * For a *session* worktree prefer {@link resolveDefaultBranchIn}: under an
 * `env-owned` env the host path is a boot-time seed, so its refs can be stale.
 * This overload remains correct for project checkouts and bare repos, which
 * always live on the host.
 */
export async function resolveDefaultBranch(cwd: string): Promise<string | null> {
  return resolveDefaultBranchVia(async (args) => {
    try {
      const { stdout } = await execAsync(`git ${args.join(' ')}`, { cwd });
      return { stdout, ok: true };
    } catch {
      return { stdout: '', ok: false };
    }
  });
}

/** Resolve the default branch of a session worktree, wherever it lives. */
export async function resolveDefaultBranchIn(io: SessionWorktreeIo): Promise<string | null> {
  return resolveDefaultBranchVia(async (args) => {
    const { stdout, exitCode } = await io.git(args);
    return { stdout, ok: exitCode === 0 };
  });
}
