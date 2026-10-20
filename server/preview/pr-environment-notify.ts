/**
 * Who to tell when a PR environment becomes ready: the PR's author (native
 * PRs) and the owner of the session whose worktree branch is the PR head.
 * GitHub PRs have no Hub author, so the branch's session is the only link
 * back to a person there.
 */
import type Database from 'better-sqlite3';
import type { PrEnvironmentDto } from './pr-environments.js';

export interface PrEnvironmentNotifyDeps {
  db: Database.Database;
  /** True when `id` is a real Hub user. */
  isUser: (id: string) => boolean;
  /**
   * The project an agent belongs to, or null when unknown. Branch names are
   * not unique across projects, so a branch match only counts for sessions
   * of this environment's project.
   */
  agentProjectId: (agentId: string) => string | null;
}

export function resolvePrEnvironmentNotifyUserIds(
  deps: PrEnvironmentNotifyDeps,
  env: Pick<PrEnvironmentDto, 'projectId' | 'source' | 'prNumber' | 'headBranch'>,
): string[] {
  const ids = new Set<string>();
  let headBranch = env.headBranch;
  if (env.source === 'native') {
    try {
      const row = deps.db
        .prepare(
          'SELECT author, head_branch FROM pull_requests WHERE project_id = ? AND number = ?',
        )
        .get(env.projectId, env.prNumber) as { author: string; head_branch: string } | undefined;
      if (row?.author) ids.add(row.author);
      headBranch = headBranch ?? row?.head_branch ?? null;
    } catch {
      /* table missing in a fresh org db: fall through to the branch lookup */
    }
  }
  if (headBranch) {
    try {
      const rows = deps.db
        .prepare(
          'SELECT agent_id, owner_user_id FROM sessions WHERE worktree_branch = ? AND owner_user_id IS NOT NULL',
        )
        .all(headBranch) as Array<{ agent_id: string; owner_user_id: string }>;
      for (const r of rows) {
        if (deps.agentProjectId(r.agent_id) === env.projectId) ids.add(r.owner_user_id);
      }
    } catch {
      /* older schema without worktree_branch */
    }
  }
  return [...ids].filter((id) => deps.isUser(id));
}
