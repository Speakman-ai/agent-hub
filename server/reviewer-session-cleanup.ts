/**
 * reviewer-session-cleanup — Reclaim a reviewer session + its worktree clone
 * the moment the formal GitHub review lands.
 *
 * Wired into both success branches of `POST /api/pr/review`
 * (`server/routes/pr-actions.ts`). Always fire-and-forget — cleanup failure
 * must never alter the review response shape or status.
 *
 * Identification (no schema change):
 *   1. Resolve the project whose `githubRepo` matches `${pr.owner}/${pr.repo}`
 *      (case-insensitive).
 *   2. Find `project.agents.find(a => a.role === 'reviewer')`.
 *   3. Query `getActiveReviewerSessionForPR(reviewer.id, 'Review: PR #<n> %')`
 *      — newest live session whose name matches the deterministic title
 *      written in `runReviewerDispatch`.
 *
 * Cleanup steps (in order):
 *   1. SIGTERM any in-flight CLI tied to the session (mirrors
 *      `server/routes/sessions.ts:548-565`).
 *   2. Soft-delete the row via `softDeleteSession` so the 24h recovery
 *      window is preserved.
 *   3. `removeWorkspace(row.worktree_path)` — guarded by `WORKSPACES_ROOT`
 *      inside the helper.
 *   4. Broadcast `{ type: 'session_deleted', sessionId }` so the sidebar
 *      prunes the row live.
 *
 * The hourly purge in `server/session-purge.ts` is kept as a safety net for
 * sessions that never reached the review-post phase.
 */

import type { ChildProcess } from 'child_process';
import { markSessionTermination } from './process-termination.js';
import type { BroadcastFn, Project, SessionRow, Stmts } from './types.js';

export interface ParsedPR {
  owner: string;
  repo: string;
  number: string;
}

export interface ReviewerSessionCleanupDeps {
  stmts: Pick<Stmts, 'softDeleteSession' | 'getActiveReviewerSessionForPR'>;
  broadcast: BroadcastFn;
  getProjects: () => Project[];
  activeProcesses: Map<string, ChildProcess>;
  removeWorkspace: (workspacePath: string) => boolean;
}

export interface ReviewerSessionCleanupResult {
  /** Why the helper short-circuited, if at all. */
  status: 'cleaned' | 'no-project' | 'no-reviewer' | 'no-session' | 'error';
  /** Session id that was reclaimed (only set when `status === 'cleaned'`). */
  sessionId?: string;
  /** Set when `status === 'cleaned'` and the row carried a worktree path. */
  worktreeRemoved?: boolean;
  /** Set when `status === 'cleaned'` and the CLI was still attached. */
  processKilled?: boolean;
}

/**
 * Find the project whose `githubRepo` matches `${owner}/${repo}`. Case- and
 * trim-insensitive; tolerates accidental whitespace. Returns `null` when no
 * project matches.
 */
export function findProjectByRepo(
  projects: Project[],
  owner: string,
  repo: string,
): Project | null {
  const target = `${owner}/${repo}`.toLowerCase();
  for (const p of projects) {
    const repoStr = typeof p.githubRepo === 'string' ? p.githubRepo.trim().toLowerCase() : '';
    if (repoStr && repoStr === target) return p;
  }
  return null;
}

/**
 * Reclaim the reviewer session (if any) for `pr`. Best-effort — every step
 * is wrapped at its own boundary so a single failure can't cascade. Returns
 * a structured result for tests / logging; production callers ignore it.
 */
export function cleanupReviewerSessionForPR(
  pr: ParsedPR,
  deps: ReviewerSessionCleanupDeps,
): ReviewerSessionCleanupResult {
  try {
    const project = findProjectByRepo(deps.getProjects(), pr.owner, pr.repo);
    if (!project) return { status: 'no-project' };

    const reviewer = (project.agents || []).find((a) => a.role === 'reviewer');
    if (!reviewer) return { status: 'no-reviewer' };

    // The title is deterministic: `Review: PR #<n> <truncated title>`. The
    // upstream parser enforces `<n>` as numeric so the LIKE pattern carries
    // no SQL wildcard hazards. The space after the number is intentional —
    // it prevents `Review: PR #12 …` from matching `Review: PR #123 …`.
    const namePattern = `Review: PR #${pr.number} %`;
    const row = deps.stmts.getActiveReviewerSessionForPR.get(reviewer.id, namePattern) as
      | SessionRow
      | undefined;
    if (!row) return { status: 'no-session' };

    let processKilled = false;
    const proc = deps.activeProcesses.get(row.id);
    if (proc) {
      try {
        markSessionTermination(row.id, 'reviewer_cleanup');
        console.info(`[reviewer-cleanup] reviewer_cleanup: sending SIGTERM session=${row.id}`);
        proc.kill('SIGTERM');
        processKilled = true;
      } catch {
        /* best-effort — soft-delete proceeds regardless */
      }
      deps.activeProcesses.delete(row.id);
    }

    try {
      deps.stmts.softDeleteSession.run(row.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ReviewerCleanup] softDeleteSession(${row.id}) failed: ${msg.split('\n')[0]}`);
      return { status: 'error' };
    }

    let worktreeRemoved = false;
    if (row.worktree_path) {
      try {
        worktreeRemoved = deps.removeWorkspace(row.worktree_path);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[ReviewerCleanup] removeWorkspace(${row.worktree_path}) threw: ${msg.split('\n')[0]}`,
        );
      }
    }

    try {
      deps.broadcast({ type: 'session_deleted', sessionId: row.id });
    } catch {
      /* best-effort */
    }

    console.log(
      `[ReviewerCleanup] Reclaimed reviewer session ${row.id} for PR #${pr.number} (worktreeRemoved=${worktreeRemoved}, processKilled=${processKilled})`,
    );
    return {
      status: 'cleaned',
      sessionId: row.id,
      worktreeRemoved,
      processKilled,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ReviewerCleanup] Unexpected error during cleanup for PR #${pr.number}: ${msg.split('\n')[0]}`,
    );
    return { status: 'error' };
  }
}
