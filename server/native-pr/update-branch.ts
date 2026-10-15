/**
 * GitHub's "Update branch" for native PRs: merge the base branch INTO the
 * PR head, worktree-free, in the hosted bare repo. Same shape as merge.ts:
 * `merge-tree --write-tree` for the tree, `commit-tree` for the merge
 * commit (parents: head, base), and a compare-and-swap `update-ref` on the
 * head so a concurrent push to the PR branch is never overwritten.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { actorForTrailer } from '../commit-message-redaction.js';
import { git, mergeTree, revParse } from './git-read.js';

const execFileP = promisify(execFile);

const COMMITTER_ENV = {
  GIT_AUTHOR_NAME: 'Agent Hub',
  GIT_AUTHOR_EMAIL: 'agent-hub@localhost',
  GIT_COMMITTER_NAME: 'Agent Hub',
  GIT_COMMITTER_EMAIL: 'agent-hub@localhost',
};

export interface UpdateBranchArgs {
  repoPath: string;
  baseBranch: string;
  headBranch: string;
  /** Recorded in the commit message trailer (userId or username). */
  actor: string;
}

export type UpdateBranchResult =
  | { ok: true; headSha: string; previousHeadSha: string }
  | { ok: false; reason: 'up_to_date'; detail: string }
  | { ok: false; reason: 'conflict'; detail: string }
  | { ok: false; reason: 'missing_ref'; detail: string }
  | { ok: false; reason: 'race'; detail: string };

/** Commits on `base` that `head` does not contain. */
export async function commitsBehind(
  repoPath: string,
  baseSha: string,
  headSha: string,
): Promise<number> {
  const out = await git(repoPath, ['rev-list', '--count', `${headSha}..${baseSha}`]);
  return Number.parseInt(out.trim(), 10) || 0;
}

export async function updatePullRequestBranch(args: UpdateBranchArgs): Promise<UpdateBranchResult> {
  const { repoPath, baseBranch, headBranch } = args;

  const baseSha = await revParse(repoPath, `refs/heads/${baseBranch}`);
  if (!baseSha) {
    return { ok: false, reason: 'missing_ref', detail: `base branch ${baseBranch} not found` };
  }
  const headSha = await revParse(repoPath, `refs/heads/${headBranch}`);
  if (!headSha) {
    return { ok: false, reason: 'missing_ref', detail: `head branch ${headBranch} not found` };
  }
  if ((await commitsBehind(repoPath, baseSha, headSha)) === 0) {
    return {
      ok: false,
      reason: 'up_to_date',
      detail: `${headBranch} already contains ${baseBranch}`,
    };
  }

  const tree = await mergeTree(repoPath, headSha, baseSha);
  if (!tree.mergeable || !tree.treeOid) {
    return { ok: false, reason: 'conflict', detail: tree.conflictDetail ?? 'merge conflicts' };
  }

  const message = `Merge branch '${baseBranch}' into ${headBranch}\n\nUpdated-by: Agent Hub (${actorForTrailer(args.actor)})`;
  const { stdout } = await execFileP(
    'git',
    ['-C', repoPath, 'commit-tree', tree.treeOid, '-p', headSha, '-p', baseSha, '-m', message],
    { timeout: 60_000, env: { ...process.env, ...COMMITTER_ENV } },
  );
  const newHead = stdout.trim();

  try {
    await git(repoPath, ['update-ref', `refs/heads/${headBranch}`, newHead, headSha]);
  } catch (err: unknown) {
    return {
      ok: false,
      reason: 'race',
      detail: `${headBranch} moved while updating; retry (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  return { ok: true, headSha: newHead, previousHeadSha: headSha };
}
