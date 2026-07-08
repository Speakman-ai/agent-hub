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
 */
import { execFile } from 'child_process';
import { resolveDefaultBranch } from '../git-default-branch.js';

const GIT_TIMEOUT_MS = 15_000;

interface GitResult {
  stdout: string;
  code: number;
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
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

export const defaultNetDiffProbe: NetDiffProbe = async (worktreePath) => {
  let base: string | null = null;
  try {
    base = await resolveDefaultBranch(worktreePath);
  } catch {
    base = null;
  }
  const refs = base
    ? [`origin/${base}`, base]
    : ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
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

/**
 * True when the session worktree has changes worth shipping.
 *
 * A dirty worktree always qualifies (it carries an uncommitted diff). Committed
 * -but-unpushed commits qualify only when they produce a real net diff against
 * the base branch — a branch whose commits are net-zero / already integrated is
 * NOT publishable, so Finalize / changes_ready / push are not offered for an
 * empty diff. When the net diff can't be determined the probe returns `null`
 * and we fail open, never worse than the prior reachability-only behavior.
 */
export async function hasPublishableChanges(
  worktreePath: string,
  changes: { hasUncommitted: boolean; hasUnpushed: boolean },
  probe: NetDiffProbe = defaultNetDiffProbe,
): Promise<boolean> {
  if (changes.hasUncommitted) return true;
  if (!changes.hasUnpushed) return false;
  const net = await probe(worktreePath);
  return net !== false;
}
