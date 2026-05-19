/**
 * pre-push-rebase.ts — fold `origin/<base>` into a clean session worktree
 * right before the session pushes.
 *
 * Why this exists: `worktree.ts#detectAndHandleBaseBranchDrift` already
 * auto-rebases at the **start** of a chat turn so the agent works against
 * the latest base. But hours can pass between that check and the push —
 * sibling PRs land, the base drifts again, and our PR opens already
 * conflicting. The user only finds out when CI flares red or they
 * eyeball the board. Pre-push rebase catches it at the latest possible
 * moment when we still have the worktree, the agent, and the option
 * to abort cleanly.
 *
 * Contract:
 * - The tree must be clean when called (we just committed in `auto-git.ts`).
 * - Returns one of four kinds; never throws on git failure (callers must
 *   decide whether a conflict blocks the push or just gets surfaced).
 * - On conflict, ALWAYS issues `git rebase --abort` so the worktree is
 *   restored to the pre-rebase state — never leave the agent's tree in
 *   "rebase in progress" limbo.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Time budget for `git fetch origin <base>` — short, so a wedged remote doesn't stall pushes. */
export const PRE_PUSH_FETCH_TIMEOUT_MS = 60_000;
/** Time budget for the rebase itself; can take a few seconds on deep stacks. */
export const PRE_PUSH_REBASE_TIMEOUT_MS = 120_000;

/** Same regex the rest of auto-git.ts uses to validate branch refs before exec. */
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export type RebaseOutcome =
  | { kind: 'noop' }
  | { kind: 'rebased'; commitsBehind: number }
  | { kind: 'conflict'; detail: string }
  | { kind: 'skipped'; reason: string };

export interface RebaseOntoBaseOptions {
  cwd: string;
  baseBranch: string;
  /** Env to inject (so `git fetch` over HTTPS uses the session's GitHub token). */
  env?: NodeJS.ProcessEnv;
  /** Optional log sink — used to stream `$ git …` lines into the create-PR drawer. */
  prLog?: (text: string) => void;
  /**
   * Hook for the rare case where the caller needs to swap out spawn behavior
   * for tests. When supplied, the helper uses this instead of `execFile`.
   */
  runGit?: (
    args: string[],
    opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

interface GitRunResult {
  stdout: string;
  stderr: string;
}

function defaultRunGit(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<GitRunResult> {
  return execFileAsync('git', args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    env: opts.env,
    maxBuffer: 10 * 1024 * 1024,
  }).then(({ stdout, stderr }) => ({ stdout, stderr }));
}

/**
 * Rebase the current branch onto `origin/<baseBranch>` and return a
 * structured outcome.
 *
 * Steps:
 *   1. Validate `baseBranch` against `SAFE_BRANCH_RE` — refuse to spawn
 *      git with anything else.
 *   2. `git fetch origin <baseBranch>` — short timeout.
 *   3. Compare `HEAD` to merge-base with `origin/<baseBranch>` — if
 *      equal, no commits to fold in: return `noop`.
 *   4. `git rebase origin/<baseBranch>` — on success report `rebased`,
 *      on failure run `git rebase --abort` and return `conflict` with
 *      the rebase stderr/stdout as `detail`.
 */
export async function rebaseOntoBase(opts: RebaseOntoBaseOptions): Promise<RebaseOutcome> {
  const { cwd, baseBranch, env, prLog } = opts;
  const runGit = opts.runGit ?? defaultRunGit;

  if (!baseBranch || !SAFE_BRANCH_RE.test(baseBranch)) {
    return { kind: 'skipped', reason: `unsafe base branch "${baseBranch}"` };
  }

  // Fetch the latest tip of the base branch.
  prLog?.(`\n$ git fetch origin ${baseBranch}\n`);
  try {
    await runGit(['fetch', '--no-tags', 'origin', baseBranch], {
      cwd,
      env,
      timeoutMs: PRE_PUSH_FETCH_TIMEOUT_MS,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    prLog?.(`  (fetch failed: ${msg.split('\n')[0]} — skipping pre-push rebase)\n`);
    return { kind: 'skipped', reason: `fetch failed: ${msg.split('\n')[0]}` };
  }

  // Cheap drift check before paying for a rebase invocation.
  let mergeBase = '';
  let baseTip = '';
  try {
    const [mbRes, tipRes] = await Promise.all([
      runGit(['merge-base', 'HEAD', `origin/${baseBranch}`], {
        cwd,
        env,
        timeoutMs: PRE_PUSH_FETCH_TIMEOUT_MS,
      }),
      runGit(['rev-parse', `origin/${baseBranch}`], {
        cwd,
        env,
        timeoutMs: PRE_PUSH_FETCH_TIMEOUT_MS,
      }),
    ]);
    mergeBase = mbRes.stdout.trim();
    baseTip = tipRes.stdout.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    prLog?.(`  (drift check failed: ${msg.split('\n')[0]} — skipping pre-push rebase)\n`);
    return { kind: 'skipped', reason: `drift check failed: ${msg.split('\n')[0]}` };
  }

  if (mergeBase === baseTip) {
    return { kind: 'noop' };
  }

  let commitsBehind = 0;
  try {
    const countRes = await runGit(['rev-list', '--count', `${mergeBase}..${baseTip}`], {
      cwd,
      env,
      timeoutMs: PRE_PUSH_FETCH_TIMEOUT_MS,
    });
    commitsBehind = Number.parseInt(countRes.stdout.trim(), 10) || 0;
  } catch {
    /* informational; never block the rebase on this */
  }

  // Attempt the rebase.
  prLog?.(`$ git rebase origin/${baseBranch}  (${commitsBehind} commit(s) behind)\n`);
  try {
    await runGit(['rebase', `origin/${baseBranch}`], {
      cwd,
      env,
      timeoutMs: PRE_PUSH_REBASE_TIMEOUT_MS,
    });
    return { kind: 'rebased', commitsBehind };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderrOut =
      typeof (err as { stderr?: unknown }).stderr === 'string'
        ? ((err as { stderr?: string }).stderr as string)
        : '';
    const stdoutOut =
      typeof (err as { stdout?: unknown }).stdout === 'string'
        ? ((err as { stdout?: string }).stdout as string)
        : '';
    const detail = [stderrOut, stdoutOut, msg]
      .map((s) => (s ?? '').toString().trim())
      .filter(Boolean)
      .join('\n');

    // Always abort to unstick the worktree. `git rebase --abort` exits
    // non-zero when there is no rebase in progress; tolerate that.
    prLog?.(`  rebase failed — aborting\n`);
    try {
      await runGit(['rebase', '--abort'], {
        cwd,
        env,
        timeoutMs: PRE_PUSH_FETCH_TIMEOUT_MS,
      });
    } catch {
      /* best-effort */
    }
    return { kind: 'conflict', detail };
  }
}

// Re-export the internals only via a __test bag, matching the project pattern.
export const __test = {
  defaultRunGit,
  SAFE_BRANCH_RE,
};
