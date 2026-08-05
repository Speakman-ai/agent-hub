/**
 * revert.ts — worktree-free revert of a merged native PR's commit, applied
 * directly in the hosted bare repo:
 *
 *   1. `git diff --binary <merged> <merged>^1` — the reverse patch. Taking
 *      the first parent makes squash commits (one parent) and merge commits
 *      (two parents, `-m 1` semantics) one code path.
 *   2. `git apply --cached --3way` against a throwaway index seeded with
 *      `read-tree <baseTip>` — index-only, so no checkout is needed and a
 *      failed apply leaves the repo untouched. Non-zero exit means the
 *      revert conflicts with work that landed after the merge.
 *   3. `git write-tree` + `git commit-tree` → the revert commit.
 *   4. `git update-ref refs/heads/<base> <new> <oldBase>` — compare-and-swap
 *      so a concurrent base move can't be silently overwritten; on a CAS race
 *      the whole sequence re-runs once from step 1.
 *
 * This adds a commit rather than rewriting history. The base branch is
 * published (clones, the GitHub mirror, deployed tags), the mirror push is
 * non-force by design, and the merge is usually no longer the tip — dropping
 * it in place would mean rewriting every commit after it. Reverting forward
 * is what `git revert` and GitHub's own Revert button do, and it reaches the
 * GitHub mirror through the ordinary fast-forward push.
 */

import { execFile, spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { git, revParse } from './git-read.js';

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
/** Same ceiling git-read.ts uses for diff output. */
const MAX_PATCH_BYTES = 16 * 1024 * 1024;

export interface RevertArgs {
  repoPath: string;
  baseBranch: string;
  /** Commit to revert — the PR's squash or merge commit. */
  mergedSha: string;
  prNumber: number;
  /** Recorded in the commit message trailer (userId or username). */
  actor: string;
}

export type RevertResult =
  | { ok: true; revertSha: string; baseSha: string }
  | { ok: false; reason: 'missing_ref'; detail: string }
  | { ok: false; reason: 'not_on_base'; detail: string }
  | { ok: false; reason: 'conflict'; detail: string }
  | { ok: false; reason: 'empty'; detail: string }
  | { ok: false; reason: 'race'; detail: string };

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: 'Agent Hub',
  GIT_AUTHOR_EMAIL: 'agent-hub@localhost',
  GIT_COMMITTER_NAME: 'Agent Hub',
  GIT_COMMITTER_EMAIL: 'agent-hub@localhost',
};

/** Is `ancestor` reachable from `descendant`? */
async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await execFileP('git', ['-C', repoPath, 'merge-base', '--is-ancestor', ancestor, descendant], {
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

interface ApplyOutcome {
  ok: boolean;
  /** Conflict/refusal text from git, trimmed for the API error. */
  detail: string;
}

/**
 * Pipe `patch` into `git apply` against `indexFile`. Kept as a spawn (not
 * execFile) because the patch can be megabytes and belongs on stdin, not in
 * argv — `spawn E2BIG` territory otherwise.
 */
function applyPatchToIndex(
  repoPath: string,
  indexFile: string,
  patch: string,
): Promise<ApplyOutcome> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repoPath, 'apply', '--cached', '--3way', '-'], {
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const finish = (outcome: ApplyOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, detail: 'git apply timed out' });
    }, GIT_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });
    // Nothing reads stdout, but an unconsumed pipe can stall a large apply.
    child.stdout.resume();
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, detail: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, detail: stderr.trim() });
    });
    // EPIPE when git bails before reading the whole patch — the close
    // handler still reports the real failure.
    child.stdin.on('error', () => {});
    child.stdin.end(patch);
  });
}

export async function revertPullRequest(args: RevertArgs): Promise<RevertResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await tryRevertOnce(args);
    if (result.ok || result.reason !== 'race') return result;
  }
  return {
    ok: false,
    reason: 'race',
    detail: 'base branch kept moving during revert; retry the revert',
  };
}

async function tryRevertOnce(args: RevertArgs): Promise<RevertResult> {
  const { repoPath, baseBranch, mergedSha } = args;

  const baseSha = await revParse(repoPath, `refs/heads/${baseBranch}`);
  if (!baseSha) {
    return { ok: false, reason: 'missing_ref', detail: `base branch ${baseBranch} not found` };
  }
  const commitSha = await revParse(repoPath, mergedSha);
  if (!commitSha) {
    return {
      ok: false,
      reason: 'missing_ref',
      detail: `merge commit ${mergedSha.slice(0, 12)} not found in the hosted repo`,
    };
  }
  if (!(await isAncestor(repoPath, commitSha, baseSha))) {
    return {
      ok: false,
      reason: 'not_on_base',
      detail: `commit ${commitSha.slice(0, 12)} is not on ${baseBranch} — it was already removed or the branch was rewritten`,
    };
  }
  const parentSha = await revParse(repoPath, `${commitSha}^1`);
  if (!parentSha) {
    return {
      ok: false,
      reason: 'missing_ref',
      detail: `commit ${commitSha.slice(0, 12)} has no parent to revert back to`,
    };
  }

  // Reverse patch: diffing the commit against its first parent inverts it.
  let patch: string;
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', repoPath, 'diff', '--binary', commitSha, parentSha],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_PATCH_BYTES },
    );
    patch = stdout;
  } catch (err: unknown) {
    return {
      ok: false,
      reason: 'conflict',
      detail: `could not read the commit's diff: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!patch.trim()) {
    return { ok: false, reason: 'empty', detail: 'the merge commit changed nothing to revert' };
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agent-hub-revert-'));
  const indexFile = path.join(scratch, 'index');
  try {
    await execFileP('git', ['-C', repoPath, 'read-tree', baseSha], {
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
    });

    const applied = await applyPatchToIndex(repoPath, indexFile, patch);
    if (!applied.ok) {
      return {
        ok: false,
        reason: 'conflict',
        detail:
          applied.detail.slice(0, 2000) ||
          'the revert conflicts with changes made after the merge landed',
      };
    }

    const { stdout: treeOut } = await execFileP('git', ['-C', repoPath, 'write-tree'], {
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
    });
    const treeOid = treeOut.trim();
    const baseTree = (await revParse(repoPath, `${baseSha}^{tree}`)) ?? null;
    if (treeOid === baseTree) {
      return {
        ok: false,
        reason: 'empty',
        detail: 'nothing to revert — the merge is already undone on this branch',
      };
    }

    const subject = (await git(repoPath, ['log', '--format=%s', '-n', '1', commitSha])).trim();
    const message =
      `Revert "${subject || `PR #${args.prNumber}`}"\n\n` +
      `This reverts commit ${commitSha}.\n\n` +
      `Reverted-by: Agent Hub (${args.actor})`;

    const { stdout: commitOut } = await execFileP(
      'git',
      ['-C', repoPath, 'commit-tree', treeOid, '-p', baseSha, '-m', message],
      { timeout: GIT_TIMEOUT_MS, env: { ...process.env, ...COMMITTER_ENV } },
    );
    const revertSha = commitOut.trim();

    // CAS: refuse to clobber a base that moved while we built the revert.
    try {
      await git(repoPath, ['update-ref', `refs/heads/${baseBranch}`, revertSha, baseSha]);
    } catch (err: unknown) {
      return {
        ok: false,
        reason: 'race',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    return { ok: true, revertSha, baseSha };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
