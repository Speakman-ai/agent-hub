/**
 * recent-pushes.ts — the "you just pushed a branch" memory behind the
 * GitHub-style Compare & pull request banner on the Pulls page.
 *
 * Recorded from the post-receive notify endpoint (both smart-HTTP and
 * local file-path pushes fire it). In-memory by design: the banner is
 * ephemeral UX with a short window, so losing it across a server restart
 * is fine (same as GitHub's, which expires after a couple of hours).
 */

import type { PullRequestRow, Stmts } from '../types.js';
import { git, prDiffStat } from '../native-pr/git-read.js';
import { gitHostRepoPath } from './repo-store.js';

/** How long a push stays "recent" (matches GitHub's ~2h banner window). */
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

interface RecentPush {
  branch: string;
  pushedAt: number;
}

/** projectId → branch → pushedAt */
const pushes = new Map<string, Map<string, number>>();
const RECENT_PUSH_DIFF_CONCURRENCY = 4;

export function isAgentHubManagedSessionBranch(branch: string): boolean {
  return /^agent-hub\/[^/]+\/session-[^/]+$/.test(branch);
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const capped = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: capped }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

/** Record branch updates from a push's ref list. Deletes evict. */
export function recordRecentPush(projectId: string, updatedRefs: string[]): void {
  let perProject = pushes.get(projectId);
  if (!perProject) {
    perProject = new Map();
    pushes.set(projectId, perProject);
  }
  for (const ref of updatedRefs) {
    if (!ref.startsWith('refs/heads/')) continue;
    perProject.set(ref.slice('refs/heads/'.length), Date.now());
  }
  // Opportunistic prune so long-lived processes don't accumulate branches.
  for (const [branch, at] of perProject) {
    if (Date.now() - at > RECENT_WINDOW_MS) perProject.delete(branch);
  }
}

/**
 * Recent pushes worth a "Create pull request" prompt: inside the window,
 * not the default branch, and no open native PR already covering the
 * branch. Newest first.
 */
async function branchHasPrFileChanges(
  projectId: string,
  defaultBranch: string | null,
  branch: string,
): Promise<boolean> {
  if (!defaultBranch) return true;
  const repoPath = gitHostRepoPath(projectId);
  try {
    const baseRef = `refs/heads/${defaultBranch}`;
    const headRef = `refs/heads/${branch}`;
    const mergeBaseSha = (await git(repoPath, ['merge-base', baseRef, headRef])).trim();
    const stats = await prDiffStat(repoPath, mergeBaseSha, headRef);
    return stats.changedFiles > 0;
  } catch {
    return true;
  }
}

export async function listRecentPushes(
  stmts: Stmts,
  projectId: string,
  defaultBranch: string | null,
): Promise<RecentPush[]> {
  const perProject = pushes.get(projectId);
  if (!perProject) return [];
  const candidates: RecentPush[] = [];
  for (const [branch, pushedAt] of perProject) {
    if (Date.now() - pushedAt > RECENT_WINDOW_MS) continue;
    if (defaultBranch && branch === defaultBranch) continue;
    if (isAgentHubManagedSessionBranch(branch)) continue;
    const open = stmts.getOpenPullRequestByHeadBranch.get(projectId, branch) as
      | PullRequestRow
      | undefined;
    if (open) continue;
    candidates.push({ branch, pushedAt });
  }
  const checks = await mapWithConcurrency(
    candidates,
    RECENT_PUSH_DIFF_CONCURRENCY,
    async (push) => ({
      push,
      hasChanges: await branchHasPrFileChanges(projectId, defaultBranch, push.branch),
    }),
  );
  return checks
    .filter((check) => check.hasChanges)
    .map((check) => check.push)
    .sort((a, b) => b.pushedAt - a.pushedAt);
}

/** Test seam. */
export function __clearRecentPushes(): void {
  pushes.clear();
}
