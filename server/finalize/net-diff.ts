/**
 * Net-change detection for Finalize / push affordances.
 *
 * `checkWorktreeChanges` reports `hasUnpushed` from commit *reachability*
 * (`git log origin/<base>..HEAD`), which is true whenever HEAD carries commits
 * the base ref doesn't — even when those commits produce **no net diff** vs the
 * base (a commit + its later revert, empty commits, or work already integrated
 * as an ancestor). Offering Finalize for such a branch is the "Finalize kicked
 * off for an empty diff" report: the run rebases, drops everything, and ships
 * nothing.
 *
 * This module adds a cheap three-dot diff probe (`git diff --quiet
 * <base>...HEAD`) so the committable/Finalize gate reflects what would actually
 * land on the base branch, matching the merge-base basis the "N files changed"
 * Changes badge already uses (`computeSessionChanges`). The probe is injectable
 * so tests never spawn real `git`.
 *
 * **Base branch = the session's real PR base, not just the repo default.** A
 * stacked session whose card/epic sets a `pr_base_branch` (a feature branch)
 * can be empty vs that feature branch while still being non-empty vs `master`.
 * Probing only against the repo default lets such a branch pass the gate and
 * ship an empty merge (the surveytracker PR #308 "Retire Employee role"
 * zero-diff merge). `makeNetDiffProbe(baseBranch)` targets the caller-resolved
 * base first; `defaultNetDiffProbe` keeps the auto-detect-default behavior for
 * callers with no resolved base.
 */
import { execFile } from 'child_process';
import { resolveDefaultBranch } from '../git-default-branch.js';

const GIT_TIMEOUT_MS = 15_000;

interface GitResult {
  stdout: string;
  code: number;
}

/** Injectable `git` runner — real spawn by default, faked in tests. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

const runGitReal: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code as number)
            : err
              ? 1
              : 0;
        resolve({ stdout: stdout?.toString() ?? '', code });
      },
    );
  });

/**
 * Ordered list of candidate base refs to diff HEAD against.
 *
 * - An explicit `baseBranch` (the session's resolved PR base) is authoritative:
 *   try `origin/<base>` then the local `<base>`, and nothing else. We do NOT
 *   fall back to the repo default here — silently reverting to `master` is the
 *   exact bug this guard exists to close (empty-vs-feature-branch would pass).
 * - With no explicit base, auto-detect the repo default and fall back to the
 *   usual `origin/HEAD` → `main`/`master` chain (legacy behavior).
 */
export function candidateBaseRefs(
  explicitBase: string | null,
  resolvedDefault: string | null,
): string[] {
  if (explicitBase) {
    const b = explicitBase.replace(/^origin\//, '');
    return [`origin/${b}`, b];
  }
  return resolvedDefault
    ? [`origin/${resolvedDefault}`, resolvedDefault]
    : ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
}

/**
 * Probe the branch's net diff against its base.
 *  - `true`  — the branch produces a real net diff vs base (something to ship)
 *  - `false` — the branch is empty vs base (nothing would land)
 *  - `null`  — undeterminable (no base ref, or an unexpected git error)
 *
 * A `null` result fails open: callers treat unpushed commits as publishable so
 * a detection miss can never strand real work behind a disabled button.
 */
export type NetDiffProbe = (worktreePath: string) => Promise<boolean | null>;

export interface NetDiffProbeDeps {
  /** Injectable git runner (tests). */
  runGit?: GitRunner;
  /** Injectable default-branch resolver (tests). */
  resolveDefault?: (cwd: string) => Promise<string | null>;
}

/**
 * Build a net-diff probe. Pass the session's resolved PR base branch so the
 * gate measures what would actually land on that branch; omit it to keep the
 * auto-detect-repo-default behavior.
 */
export function makeNetDiffProbe(
  baseBranch?: string | null,
  deps: NetDiffProbeDeps = {},
): NetDiffProbe {
  const runGit = deps.runGit ?? runGitReal;
  const resolveDefault = deps.resolveDefault ?? resolveDefaultBranch;
  const explicitBase = baseBranch ?? null;
  return async (worktreePath) => {
    let resolvedDefault: string | null = null;
    if (!explicitBase) {
      try {
        resolvedDefault = await resolveDefault(worktreePath);
      } catch {
        resolvedDefault = null;
      }
    }
    const refs = candidateBaseRefs(explicitBase, resolvedDefault);
    for (const ref of refs) {
      const exists = await runGit(['rev-parse', '--verify', '--quiet', ref], worktreePath);
      if (exists.code !== 0 || !exists.stdout.trim()) continue;
      // Three-dot diff = merge-base(ref, HEAD)..HEAD — exactly the PR/Changes-pane
      // view. `--quiet` exits 0 when identical, 1 when differences exist.
      const diff = await runGit(['diff', '--quiet', `${ref}...HEAD`], worktreePath);
      if (diff.code === 0) return false;
      if (diff.code === 1) return true;
      return null; // unexpected git error — undeterminable, fail open
    }
    return null; // no base ref resolvable — undeterminable, fail open
  };
}

/** Repo-default-branch probe (no resolved PR base). */
export const defaultNetDiffProbe: NetDiffProbe = makeNetDiffProbe();

/**
 * Turn a probe verdict into a publish decision, honoring the base's authority.
 *
 *  - `true`  (real net diff)  → publishable
 *  - `false` (empty diff)     → NOT publishable
 *  - `null`  (undeterminable) → the crux: an **explicit** PR base fails CLOSED
 *    (we have NOT proven anything would land on the real target, so blocking is
 *    correct — a stale/missing feature-base fetch must not let an empty stacked
 *    change through), while the legacy repo-default auto-detect path fails OPEN
 *    (never worse than the prior reachability-only behavior).
 */
export function isPublishableVerdict(
  net: boolean | null,
  opts: { explicitBase: boolean },
): boolean {
  if (net === true) return true;
  if (net === false) return false;
  return !opts.explicitBase; // null: fail closed for explicit base, open for default
}

/**
 * True when the session worktree has changes worth shipping.
 *
 * A dirty worktree always qualifies (it carries an uncommitted diff). Committed
 * -but-unpushed commits qualify only when they produce a real net diff against
 * the base branch — a branch whose commits are net-zero / already integrated is
 * NOT publishable, so Finalize / changes_ready / push are not offered for an
 * empty diff. When the net diff can't be determined, `opts.explicitBase`
 * decides: an authoritative PR base fails closed; the repo-default path fails
 * open (see `isPublishableVerdict`).
 */
export async function hasPublishableChanges(
  worktreePath: string,
  changes: { hasUncommitted: boolean; hasUnpushed: boolean },
  probe: NetDiffProbe = defaultNetDiffProbe,
  opts: { explicitBase?: boolean } = {},
): Promise<boolean> {
  if (changes.hasUncommitted) return true;
  if (!changes.hasUnpushed) return false;
  const net = await probe(worktreePath);
  return isPublishableVerdict(net, { explicitBase: opts.explicitBase ?? false });
}
