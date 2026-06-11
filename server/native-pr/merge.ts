/**
 * merge.ts — worktree-free merge of a native PR into its base branch,
 * performed directly in the hosted bare repo:
 *
 *   1. `git merge-tree --write-tree` — dry-run merge → tree OID or
 *      conflicts (no checkout, git >= 2.38).
 *   2. `git commit-tree` — build the squash/merge commit from that tree.
 *   3. `git update-ref refs/heads/<base> <new> <oldBase>` — compare-and-
 *      swap so a concurrent base move can't be silently overwritten; on
 *      a CAS race the whole sequence re-runs once from step 1.
 *
 * No scratch clones: atomic (the CAS either lands or doesn't), no
 * cleanup path, and trivially testable against fixture bare repos.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { git, mergeTree, revParse } from './git-read.js';

const execFileP = promisify(execFile);

export type MergeMethod = 'squash' | 'merge';

export interface MergeArgs {
  repoPath: string;
  baseBranch: string;
  headBranch: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  method: MergeMethod;
  /** Recorded in the commit message trailer (userId or username). */
  actor: string;
  /** Expected head sha (refuse if the branch moved past the PR record). */
  expectedHeadSha?: string | null;
  /** Delete the head branch after merging (default true, GitHub-style). */
  deleteHeadBranch?: boolean;
}

export type MergeResult =
  | { ok: true; mergedSha: string; headSha: string }
  | { ok: false; reason: 'conflict'; detail: string }
  | { ok: false; reason: 'missing_ref'; detail: string }
  | { ok: false; reason: 'head_moved'; detail: string }
  | { ok: false; reason: 'race'; detail: string };

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: 'Agent Hub',
  GIT_AUTHOR_EMAIL: 'agent-hub@localhost',
  GIT_COMMITTER_NAME: 'Agent Hub',
  GIT_COMMITTER_EMAIL: 'agent-hub@localhost',
};

async function commitTree(
  repoPath: string,
  treeOid: string,
  parents: string[],
  message: string,
): Promise<string> {
  const args = ['-C', repoPath, 'commit-tree', treeOid];
  for (const parent of parents) args.push('-p', parent);
  args.push('-m', message);
  const { stdout } = await execFileP('git', args, {
    timeout: 60_000,
    env: { ...process.env, ...COMMITTER_ENV },
  });
  return stdout.trim();
}

export async function mergePullRequest(args: MergeArgs): Promise<MergeResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await tryMergeOnce(args);
    if (result.ok || result.reason !== 'race') return result;
  }
  return {
    ok: false,
    reason: 'race',
    detail: 'base branch kept moving during merge; retry the merge',
  };
}

async function tryMergeOnce(args: MergeArgs): Promise<MergeResult> {
  const { repoPath, baseBranch, headBranch, method } = args;

  const baseSha = await revParse(repoPath, `refs/heads/${baseBranch}`);
  if (!baseSha) {
    return { ok: false, reason: 'missing_ref', detail: `base branch ${baseBranch} not found` };
  }
  const headSha = await revParse(repoPath, `refs/heads/${headBranch}`);
  if (!headSha) {
    return { ok: false, reason: 'missing_ref', detail: `head branch ${headBranch} not found` };
  }
  if (args.expectedHeadSha && args.expectedHeadSha !== headSha) {
    return {
      ok: false,
      reason: 'head_moved',
      detail: `head branch advanced past the PR record (expected ${args.expectedHeadSha.slice(0, 12)}, found ${headSha.slice(0, 12)})`,
    };
  }

  const tree = await mergeTree(repoPath, baseSha, headSha);
  if (!tree.mergeable || !tree.treeOid) {
    return { ok: false, reason: 'conflict', detail: tree.conflictDetail ?? 'merge conflicts' };
  }

  const trailer = `\n\nMerged-by: Agent Hub (${args.actor})`;
  let mergedSha: string;
  if (method === 'squash') {
    const body = args.prBody.trim();
    const message = `${args.prTitle} (#${args.prNumber})${body ? `\n\n${body}` : ''}${trailer}`;
    mergedSha = await commitTree(repoPath, tree.treeOid, [baseSha], message);
  } else {
    const message = `Merge pull request #${args.prNumber} from ${headBranch}\n\n${args.prTitle}${trailer}`;
    mergedSha = await commitTree(repoPath, tree.treeOid, [baseSha, headSha], message);
  }

  // CAS: refuse to clobber a base that moved since we computed the merge.
  try {
    await git(repoPath, ['update-ref', `refs/heads/${baseBranch}`, mergedSha, baseSha]);
  } catch (err: unknown) {
    return {
      ok: false,
      reason: 'race',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Best-effort head-branch cleanup — GitHub's "automatically delete head
  // branches". Opt-out via Project.deleteBranchOnMerge=false; a failure
  // here never fails the merge.
  if (args.deleteHeadBranch !== false) {
    try {
      await git(repoPath, ['update-ref', '-d', `refs/heads/${headBranch}`, headSha]);
    } catch {
      /* branch advanced or already gone — leave it */
    }
  }

  return { ok: true, mergedSha, headSha };
}
