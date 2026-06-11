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

/** How long a push stays "recent" (matches GitHub's ~2h banner window). */
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

interface RecentPush {
  branch: string;
  pushedAt: number;
}

/** projectId → branch → pushedAt */
const pushes = new Map<string, Map<string, number>>();

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
export function listRecentPushes(
  stmts: Stmts,
  projectId: string,
  defaultBranch: string | null,
): RecentPush[] {
  const perProject = pushes.get(projectId);
  if (!perProject) return [];
  const out: RecentPush[] = [];
  for (const [branch, pushedAt] of perProject) {
    if (Date.now() - pushedAt > RECENT_WINDOW_MS) continue;
    if (defaultBranch && branch === defaultBranch) continue;
    const open = stmts.getOpenPullRequestByHeadBranch.get(projectId, branch) as
      | PullRequestRow
      | undefined;
    if (open) continue;
    out.push({ branch, pushedAt });
  }
  return out.sort((a, b) => b.pushedAt - a.pushedAt);
}

/** Test seam. */
export function __clearRecentPushes(): void {
  pushes.clear();
}
