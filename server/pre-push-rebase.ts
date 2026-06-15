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
import { existsSync } from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Time budget for `git fetch origin <base>` — short, so a wedged remote doesn't stall pushes. */
export const PRE_PUSH_FETCH_TIMEOUT_MS = 60_000;
/** Time budget for the rebase itself; can take a few seconds on deep stacks. */
export const PRE_PUSH_REBASE_TIMEOUT_MS = 120_000;
const FALLBACK_GIT_USER_NAME = 'Agent Hub Finalize';
const FALLBACK_GIT_USER_EMAIL = 'agent-hub-finalize@example.invalid';

/** Same regex the rest of auto-git.ts uses to validate branch refs before exec. */
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * `expectedRemoteSha` is the authoritative current value of
 * `refs/heads/<featureBranch>` on origin, captured right before the rebase
 * via `git ls-remote`. The caller uses it to pin `--force-with-lease` —
 * `--force-with-lease=<branch>:<sha>` — so the lease check doesn't depend
 * on the local `refs/remotes/origin/<branch>` cache (which our pre-push
 * fetch never refreshes for the feature branch and which therefore goes
 * stale whenever any other actor — reviewer agent, second Hub session,
 * human, parallel autonomous worker — pushes the same branch in between).
 *
 * `null` means the helper was asked for an expected SHA but the feature
 * branch does not exist on origin (brand-new branch). The caller can then
 * use a bare `--force-with-lease`, which git correctly treats as
 * "expect empty" for absent remote refs.
 *
 * `undefined` (omitted) means the caller didn't ask for an expected SHA —
 * the legacy contract from before the lease pinning was added. Existing
 * callers that don't pass `featureBranch` get the original outcome shape.
 */
export type RebaseOutcome =
  | { kind: 'noop'; expectedRemoteSha?: string | null }
  | { kind: 'rebased'; commitsBehind: number; expectedRemoteSha?: string | null }
  | { kind: 'conflict'; detail: string }
  | { kind: 'skipped'; reason: string; expectedRemoteSha?: string | null };

export interface RebaseOntoBaseOptions {
  cwd: string;
  /**
   * Required. Pre-resolved by the caller (e.g. `commitPushAndCreatePR`
   * walks card.pr_base_branch → epic.pr_base_branch → repo default). The
   * helper does NOT re-resolve the default branch — passing an empty
   * string or an obviously-unsafe value is treated as `skipped` so the
   * caller never accidentally rebases onto `main` when the configured
   * integration branch is some `release/*` line.
   */
  baseBranch: string;
  /**
   * Optional. The branch the caller is about to push (typically the
   * current HEAD branch in the worktree). When supplied, the helper
   * resolves the authoritative origin SHA for this branch via
   * `git ls-remote origin refs/heads/<featureBranch>` and returns it as
   * `expectedRemoteSha` so the caller can pin `--force-with-lease`.
   *
   * Why `ls-remote` instead of `git fetch <feature>` + `rev-parse`:
   *   - `ls-remote` gives the authoritative server value in one round trip
   *     without modifying any local refs, so it can't race with concurrent
   *     local git activity.
   *   - `git fetch origin <feature>` would error out if the branch is
   *     brand-new on origin (no such ref), and we'd lose the base-branch
   *     fetch we just did. `ls-remote` returns empty stdout for missing
   *     branches with exit 0 — cleanly distinguishable from a network
   *     failure.
   */
  featureBranch?: string;
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
  /**
   * Hook for tests that need to override the mid-rebase-state probe. In
   * production this defaults to checking `.git/rebase-merge` /
   * `.git/rebase-apply` directly on disk via `fs.existsSync`.
   */
  isRebaseInProgress?: (cwd: string) => boolean;
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
 * Detect leftover state from a prior aborted/killed rebase. Git records
 * an in-progress rebase by creating either `.git/rebase-merge` (the
 * default merge backend) or `.git/rebase-apply` (the legacy "am"
 * backend). When the parent process is killed mid-rebase the worktree
 * is left with conflict markers and the next `git rebase` invocation
 * refuses with "It seems that there is already a rebase-merge directory".
 * Cheaper to probe the filesystem than to spawn a `git status` just for
 * this — the dirs are sentinels git itself uses.
 */
function isRebaseInProgressOnDisk(cwd: string): boolean {
  const gitDir = path.join(cwd, '.git');
  return (
    existsSync(path.join(gitDir, 'rebase-merge')) || existsSync(path.join(gitDir, 'rebase-apply'))
  );
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
  const { cwd, baseBranch, featureBranch, env, prLog } = opts;
  const runGit = opts.runGit ?? defaultRunGit;
  const isRebaseInProgress = opts.isRebaseInProgress ?? isRebaseInProgressOnDisk;
  const wantExpectedSha = typeof featureBranch === 'string' && featureBranch.length > 0;
  // True iff the caller asked for an expected SHA AND the supplied branch
  // name passes our argv-safety regex. Single source of truth for the
  // ls-remote gate below — keeps the `as string` cast and the regex out of
  // multiple call sites. When false we just fall through to a bare
  // `--force-with-lease` at the caller (the rebase itself is unaffected).
  const featureBranchIsSafe = wantExpectedSha && SAFE_BRANCH_RE.test(featureBranch as string);

  if (!baseBranch || !SAFE_BRANCH_RE.test(baseBranch)) {
    return wantExpectedSha
      ? { kind: 'skipped', reason: `unsafe base branch "${baseBranch}"`, expectedRemoteSha: null }
      : { kind: 'skipped', reason: `unsafe base branch "${baseBranch}"` };
  }
  if (wantExpectedSha && !featureBranchIsSafe) {
    // Treat as "no expected SHA" rather than aborting the rebase entirely —
    // the rebase itself doesn't depend on the feature branch name, and the
    // caller will fall back to a bare `--force-with-lease`.
    prLog?.(`  (feature branch name failed validation — skipping ls-remote)\n`);
  }

  // Defensive cleanup: a prior rebase invocation that got SIGTERM'd or
  // timed out can leave `.git/rebase-merge` behind. Git will then refuse
  // the new `git rebase` with "there is already a rebase-merge
  // directory", and the subsequent `git status --porcelain` upstream of
  // us sees `UU` markers and triggers a misleading `commit_failed`.
  // Abort any leftover state before the new attempt so we always start
  // from a known-clean rebase position.
  if (isRebaseInProgress(cwd)) {
    prLog?.(
      `\n  (detected leftover rebase state in .git — running \`git rebase --abort\` before continuing)\n`,
    );
    try {
      await runGit(['rebase', '--abort'], {
        cwd,
        env,
        timeoutMs: PRE_PUSH_FETCH_TIMEOUT_MS,
      });
    } catch {
      // `git rebase --abort` exits non-zero when no rebase is in progress.
      // Both branches of the on-disk probe ↔ git's idea of state can drift
      // (e.g. a manually deleted dir), so a failed abort here is informational.
    }
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
    return wantExpectedSha
      ? { kind: 'skipped', reason: `fetch failed: ${msg.split('\n')[0]}`, expectedRemoteSha: null }
      : { kind: 'skipped', reason: `fetch failed: ${msg.split('\n')[0]}` };
  }

  await ensureGitCommitterIdentity(runGit, cwd, env, prLog);

  // Resolve the authoritative origin SHA for the feature branch via
  // `ls-remote`. This is what the caller pins `--force-with-lease` to so the
  // lease check doesn't depend on the local `refs/remotes/origin/<branch>`
  // cache (which our pre-push fetch above doesn't refresh for the feature
  // branch). See `RebaseOntoBaseOptions.featureBranch` for the full rationale.
  //
  // Failures here are non-fatal: the lease just falls back to bare
  // `--force-with-lease`, which is the legacy behavior. We do NOT bubble the
  // ls-remote error into the rebase outcome because the rebase itself is
  // unaffected — the only cost of a missed expected SHA is the original
  // `(stale info)` failure mode, which is what the rest of the system
  // already handles.
  let expectedRemoteSha: string | null = null;
  if (featureBranchIsSafe) {
    const featureRef = `refs/heads/${featureBranch as string}`;
    prLog?.(`$ git ls-remote origin ${featureRef}\n`);
    try {
      const lsRes = await runGit(['ls-remote', 'origin', featureRef], {
        cwd,
        env,
        timeoutMs: PRE_PUSH_FETCH_TIMEOUT_MS,
      });
      const firstLine = lsRes.stdout.split(/\r?\n/, 1)[0]?.trim() ?? '';
      // ls-remote output for an existing ref looks like:
      //   `<sha>\trefs/heads/<branch>`
      // For a missing branch the stdout is empty (exit 0). Match a 40- or
      // 64-hex SHA prefix to be safe across SHA-1 and SHA-256 repos.
      const shaMatch = firstLine.match(/^([0-9a-f]{40,64})\s/i);
      expectedRemoteSha = shaMatch ? shaMatch[1] : null;
      if (expectedRemoteSha) {
        prLog?.(`  expected origin/${featureBranch as string} = ${expectedRemoteSha}\n`);
      } else {
        prLog?.(
          `  origin has no ${featureRef} (brand-new branch) — bare --force-with-lease will be used\n`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      prLog?.(`  (ls-remote failed: ${msg.split('\n')[0]} — falling back to bare lease)\n`);
      expectedRemoteSha = null;
    }
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
    return wantExpectedSha
      ? {
          kind: 'skipped',
          reason: `drift check failed: ${msg.split('\n')[0]}`,
          expectedRemoteSha,
        }
      : { kind: 'skipped', reason: `drift check failed: ${msg.split('\n')[0]}` };
  }

  if (mergeBase === baseTip) {
    return wantExpectedSha ? { kind: 'noop', expectedRemoteSha } : { kind: 'noop' };
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

  // Attempt the rebase. `--empty=drop`: if a branch commit becomes empty against
  // an advanced base (its change already upstream, or a redundant 3-way result),
  // drop it and continue instead of pausing with "no conflicted files (possibly
  // an empty commit)" — which otherwise wedges the rebase and blocks Finalize.
  prLog?.(`$ git rebase --empty=drop origin/${baseBranch}  (${commitsBehind} commit(s) behind)\n`);
  try {
    await runGit(['rebase', '--empty=drop', `origin/${baseBranch}`], {
      cwd,
      env,
      timeoutMs: PRE_PUSH_REBASE_TIMEOUT_MS,
    });
    return wantExpectedSha
      ? { kind: 'rebased', commitsBehind, expectedRemoteSha }
      : { kind: 'rebased', commitsBehind };
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

async function ensureGitCommitterIdentity(
  runGit: NonNullable<RebaseOntoBaseOptions['runGit']>,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  prLog: ((text: string) => void) | undefined,
): Promise<void> {
  const hasName = await hasGitConfigValue(runGit, cwd, env, 'user.name');
  const hasEmail = await hasGitConfigValue(runGit, cwd, env, 'user.email');
  if (hasName && hasEmail) return;

  prLog?.('  (git committer identity missing — setting repo-local Finalize fallback)\n');
  try {
    if (!hasName) {
      await runGit(['config', 'user.name', FALLBACK_GIT_USER_NAME], {
        cwd,
        env,
        timeoutMs: PRE_PUSH_FETCH_TIMEOUT_MS,
      });
    }
    if (!hasEmail) {
      await runGit(['config', 'user.email', FALLBACK_GIT_USER_EMAIL], {
        cwd,
        env,
        timeoutMs: PRE_PUSH_FETCH_TIMEOUT_MS,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    prLog?.(`  (failed to set fallback git identity: ${msg.split('\n')[0]})\n`);
  }
}

async function hasGitConfigValue(
  runGit: NonNullable<RebaseOntoBaseOptions['runGit']>,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  key: 'user.name' | 'user.email',
): Promise<boolean> {
  try {
    const { stdout } = await runGit(['config', '--get', key], {
      cwd,
      env,
      timeoutMs: PRE_PUSH_FETCH_TIMEOUT_MS,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// Re-export the internals only via a __test bag, matching the project pattern.
export const __test = {
  defaultRunGit,
  ensureGitCommitterIdentity,
  hasGitConfigValue,
  isRebaseInProgressOnDisk,
  SAFE_BRANCH_RE,
};
