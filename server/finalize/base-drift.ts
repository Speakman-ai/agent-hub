/**
 * base-drift.ts — did the base branch move under a validated Finalize run,
 * in a way that invalidates the checks we already ran?
 *
 * Finalize rebases onto `origin/<base>` once at the top of its loop, then
 * runs the reviewer and the ci.yaml steps, then parks at `ready_to_push`
 * until a push happens (human click, or `push` / `merge` automation). The
 * §9 push gate re-reads local HEAD, so a commit landing on the *feature*
 * branch during that window is caught. Nothing watched the *base*: two
 * sessions on the same project could each rebase onto the same base tip,
 * both go green, and both merge — each validated against a base the other
 * then changed.
 *
 * That is not hypothetical. Two sessions on a Django project each added a
 * migration numbered off the same parent, minutes apart. Both branches were
 * individually green; together they left the migration graph with multiple
 * leaves, `migrate` refused to build it, and production ran new code against
 * an old schema for seven hours.
 *
 * ## Why overlap, not "did the base move at all"
 *
 * Refusing on *any* base movement is wrong: on an active repo the base moves
 * constantly, and a run that re-validated on every unrelated commit would
 * burn its budget re-running checks and might never converge. Merging onto a
 * moved base is the normal case and is usually fine.
 *
 * So we refuse only when the commits added to the base since our rebase
 * touch the same ground the branch touches. "Same ground" is **directory**
 * level, not file level, because the failure class that motivated this never
 * collides on a filename: branch A adds `jobs/migrations/0088_foo.py` while
 * branch B adds `jobs/migrations/0088_bar.py`. Different files, same
 * directory, mutually incompatible.
 *
 * The repository root is excluded from directory matching — otherwise every
 * release version bump touching a root `package.json` would look like it
 * overlaps every branch that edits a root file. Exact same-file hits still
 * count everywhere, root included.
 *
 * ## Fail open
 *
 * Every "we could not determine the base" path resolves to `clear`. A gate
 * that cannot read its own baseline must not red-light every push in the
 * install; the caller logs loudly instead. The cost of a false clear is the
 * status quo, the cost of a false refusal is a wedged Finalize.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Facts the decision needs, gathered from git by {@link collectBaseDriftFacts}. */
export interface BaseDriftFacts {
  /** The base sha this run rebased onto, as recorded at rebase time. */
  validatedBaseSha: string | null;
  /** `origin/<base>` right now. Null when it could not be resolved. */
  currentBaseSha: string | null;
  /** Paths changed on the base between the two shas above. */
  basePaths: string[];
  /** Paths this branch changes relative to {@link validatedBaseSha}. */
  branchPaths: string[];
}

export type BaseDriftOutcome =
  | {
      kind: 'clear';
      /**
       * `unknown_base` — no recorded baseline, or the current base could not
       * be resolved (fail-open).
       * `no_drift` — the base is exactly where we rebased onto.
       * `no_overlap` — the base moved, but not onto ground this branch touches.
       */
      reason: 'unknown_base' | 'no_drift' | 'no_overlap';
      detail: string;
    }
  | {
      kind: 'stale';
      /** Directories (or exact files) both sides touched, sorted, deduped. */
      overlap: string[];
      detail: string;
    };

/** Directory a path lives in; `''` for a repository-root file. */
function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * Ground a change occupies, for collision purposes: the exact path, plus its
 * parent directory when that directory is not the repository root.
 */
function occupiedGround(paths: string[]): Set<string> {
  const ground = new Set<string>();
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    ground.add(path);
    const dir = parentDir(path);
    // Root ('') would match every root-level edit against every other one.
    if (dir) ground.add(`${dir}/`);
  }
  return ground;
}

/**
 * Decide whether the reviewer + step signals this run collected are still
 * trustworthy given where the base branch is now.
 *
 * Pure: all git I/O happens in {@link collectBaseDriftFacts}, so the whole
 * truth table is unit-testable without a repository.
 */
export function evaluateBaseDrift(facts: BaseDriftFacts): BaseDriftOutcome {
  if (!facts.validatedBaseSha) {
    return {
      kind: 'clear',
      reason: 'unknown_base',
      detail: 'no recorded base sha for this run; base drift cannot be evaluated',
    };
  }
  if (!facts.currentBaseSha) {
    return {
      kind: 'clear',
      reason: 'unknown_base',
      detail: 'could not resolve the current base sha; base drift cannot be evaluated',
    };
  }
  if (facts.validatedBaseSha === facts.currentBaseSha) {
    return {
      kind: 'clear',
      reason: 'no_drift',
      detail: `base is still at ${facts.currentBaseSha}`,
    };
  }

  const branchGround = occupiedGround(facts.branchPaths);
  const overlap = new Set<string>();
  for (const ground of occupiedGround(facts.basePaths)) {
    if (branchGround.has(ground)) overlap.add(ground);
  }

  if (overlap.size === 0) {
    return {
      kind: 'clear',
      reason: 'no_overlap',
      detail:
        `base moved ${facts.validatedBaseSha} → ${facts.currentBaseSha}, but the new ` +
        'commits do not touch anything this branch touches',
    };
  }

  const sorted = [...overlap].sort();
  return {
    kind: 'stale',
    overlap: sorted,
    detail:
      `base moved ${facts.validatedBaseSha} → ${facts.currentBaseSha} onto ground this ` +
      `branch also changes (${sorted.slice(0, 5).join(', ')}${
        sorted.length > 5 ? `, +${sorted.length - 5} more` : ''
      }); review and step results are stale`,
  };
}

/** Runs one git command in the worktree and returns stdout. */
export type GitRunner = (args: string[]) => Promise<string>;

/** Production {@link GitRunner}: git in the session worktree. */
export function worktreeGitRunner(worktreePath: string, env?: NodeJS.ProcessEnv): GitRunner {
  return async (args) => {
    const { stdout } = await execFileAsync('git', args, {
      cwd: worktreePath,
      env,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  };
}

/**
 * Collect + decide in one call. Returns `clear` without touching git when the
 * run has no recorded base sha (rows that predate the column, and every unit
 * test that builds a run row by hand).
 */
export async function inspectBaseDrift(args: {
  worktreePath: string;
  baseBranch: string;
  validatedBaseSha: string | null;
  headSha: string;
  env?: NodeJS.ProcessEnv;
  git?: GitRunner;
  onWarn?: (message: string) => void;
}): Promise<BaseDriftOutcome> {
  const facts = await collectBaseDriftFacts({
    baseBranch: args.baseBranch,
    validatedBaseSha: args.validatedBaseSha,
    headSha: args.headSha,
    git: args.git ?? worktreeGitRunner(args.worktreePath, args.env),
    onWarn: args.onWarn,
  });
  return evaluateBaseDrift(facts);
}

/**
 * Resolve the base commit this run's validation actually sits on, for the
 * run to record as its drift baseline. Returns null (never throws) when it
 * cannot be determined — the drift check then fails open for this run.
 *
 * **Merge-base, not `rev-parse origin/<base>`.** Reading the base tip after
 * the rebase returns whatever the tip is *now*, which is not necessarily
 * what the rebase used: if the base advanced in between, the run would
 * record the newer sha, and a later drift check comparing against it would
 * report `no_drift` and wave through validation that ran on the older base.
 * That is the exact hole this module exists to close.
 *
 * `git merge-base <head> origin/<base>` has no such window. After a rebase
 * onto base tip B1, HEAD descends from B1; if the base has since moved to
 * B2 (B1 an ancestor), the merge base is still exactly B1 — the commit the
 * reviewer and steps were validated against. It is derived from the local
 * history, so it cannot be raced by a concurrent fetch.
 */
export async function resolveBaseSha(args: {
  worktreePath: string;
  baseBranch: string;
  /** HEAD as of the post-rebase snapshot. Defaults to `HEAD`. */
  headSha?: string;
  env?: NodeJS.ProcessEnv;
  git?: GitRunner;
  onWarn?: (message: string) => void;
}): Promise<string | null> {
  const git = args.git ?? worktreeGitRunner(args.worktreePath, args.env);
  const head = args.headSha || 'HEAD';
  const failures: string[] = [];
  try {
    const sha = (await git(['merge-base', head, `origin/${args.baseBranch}`])).trim();
    if (sha) return sha;
    failures.push('merge-base returned empty output');
  } catch (err) {
    failures.push(`merge-base failed: ${describeError(err)}`);
  }
  // Fallbacks for a worktree with no remote-tracking ref for the base (the
  // merge-base above cannot resolve there). These carry the race described
  // above, so they are last resort, not the default.
  for (const ref of [`origin/${args.baseBranch}`, 'FETCH_HEAD']) {
    try {
      const sha = (await git(['rev-parse', ref])).trim();
      if (sha) {
        args.onWarn?.(
          `merge-base unavailable (${failures.join('; ')}); fell back to the ${ref} tip, ` +
            'which can race a base that moved since the rebase',
        );
        return sha;
      }
      failures.push(`rev-parse ${ref} returned empty output`);
    } catch (err) {
      failures.push(`rev-parse ${ref} failed: ${describeError(err)}`);
    }
  }
  // Nothing resolved. The run records a null baseline and the drift check
  // will fail open, so this log line is the only evidence the gate was
  // inert for this run. Keep it loud.
  args.onWarn?.(
    `could not resolve a base sha for origin/${args.baseBranch}; base drift will NOT be ` +
      `evaluated for this run (${failures.join('; ')})`,
  );
  return null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read the four facts from git. Never throws: any failure degrades to a
 * fail-open shape ({@link evaluateBaseDrift} then returns `unknown_base`).
 */
export async function collectBaseDriftFacts(args: {
  baseBranch: string;
  validatedBaseSha: string | null;
  headSha: string;
  git: GitRunner;
  onWarn?: (message: string) => void;
}): Promise<BaseDriftFacts> {
  const empty: BaseDriftFacts = {
    validatedBaseSha: args.validatedBaseSha ?? null,
    currentBaseSha: null,
    basePaths: [],
    branchPaths: [],
  };
  if (!args.validatedBaseSha) {
    // Fail open, but never silently: a run with no recorded baseline is one
    // the gate cannot judge, and that has to be visible in the logs rather
    // than looking like a clean pass.
    args.onWarn?.('no recorded base sha for this run; base drift was NOT evaluated for this push');
    return empty;
  }

  let currentBaseSha: string;
  try {
    // FETCH_HEAD rather than refs/remotes/origin/<base>: a session worktree's
    // remote-tracking refs are not guaranteed to be configured, but the ref
    // we just fetched always is.
    await args.git(['fetch', '--no-tags', 'origin', args.baseBranch]);
    currentBaseSha = (await args.git(['rev-parse', 'FETCH_HEAD'])).trim();
  } catch (err) {
    args.onWarn?.(
      `could not resolve origin/${args.baseBranch}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return empty;
  }
  if (!currentBaseSha) return empty;
  if (currentBaseSha === args.validatedBaseSha) {
    return { ...empty, currentBaseSha };
  }

  try {
    const basePaths = splitPaths(
      await args.git(['diff', '--name-only', args.validatedBaseSha, currentBaseSha]),
    );
    const branchPaths = splitPaths(
      await args.git(['diff', '--name-only', args.validatedBaseSha, args.headSha]),
    );
    return { validatedBaseSha: args.validatedBaseSha, currentBaseSha, basePaths, branchPaths };
  } catch (err) {
    args.onWarn?.(
      `could not diff against origin/${args.baseBranch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return empty;
  }
}

function splitPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Stable error code surfaced to API callers and logs when a run goes stale. */
export const BASE_BRANCH_MOVED_ERROR = 'base_branch_moved';

/** Message for a human who clicked push and got refused. */
export const BASE_BRANCH_MOVED_MESSAGE =
  'The base branch changed the same files this branch touches since checks ran. ' +
  'Click Finalize Code Changes again to rebase and re-run review and tests.';
