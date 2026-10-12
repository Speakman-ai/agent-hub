/**
 * Fires scheduled native PR auto-merges.
 *
 * A PR scheduled for time T has `auto_merge_at = T` and `auto_merge = 0`, so
 * a checks-passed event before T cannot merge it. Once T passes, a tick arms
 * auto-merge and attempts the merge through the same gate the Merge button
 * uses. `auto_merge_at` stays set until the PR merges, closes, or is
 * disarmed, and each attempt stamps `auto_merge_attempted_at`; a failed
 * attempt (transient error, not-ready PR, or a crash mid-attempt) is retried
 * after {@link SCHEDULED_AUTO_MERGE_RETRY_MS}. The checks-passed hook still
 * merges an armed PR sooner when its checks go green.
 */

import type { BroadcastFn, Project, PullRequestRow, Stmts } from '../types.js';
import type { NativePrService } from './service.js';
import { tryAutoMergeArmedNativePr } from './auto-merge-armed.js';
import { isAgentHubHosted } from './host.js';

export const SCHEDULED_AUTO_MERGE_TICK_MS = 30_000;
export const SCHEDULED_AUTO_MERGE_RETRY_MS = 5 * 60_000;

export interface ScheduledAutoMergeDeps {
  stmts: Stmts;
  nativePr: NativePrService;
  broadcast: BroadcastFn;
  getProject: (projectId: string) => Project | null;
  now?: () => number;
}

export interface ScheduledAutoMergeResult {
  projectId: string;
  number: number;
  merged: boolean;
  reason?: string;
}

export async function runDueScheduledAutoMerges(
  deps: ScheduledAutoMergeDeps,
): Promise<ScheduledAutoMergeResult[]> {
  const now = (deps.now ?? Date.now)();
  const retryCutoff = now - SCHEDULED_AUTO_MERGE_RETRY_MS;
  const due = deps.stmts.listDueScheduledAutoMergePrs.all(now, retryCutoff) as PullRequestRow[];
  const results: ScheduledAutoMergeResult[] = [];
  for (const row of due) {
    const project = deps.getProject(row.project_id);
    // A project removed from config (or moved off Hub hosting) leaves the
    // row alone; it fires if the project comes back.
    if (!project || !isAgentHubHosted(project)) continue;
    const claimed = deps.stmts.claimScheduledAutoMergeAttempt.run(
      now,
      now,
      row.id,
      now,
      retryCutoff,
    );
    if (claimed.changes === 0) continue;
    if (row.auto_merge !== 1) {
      deps.broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: row.number,
        action: 'auto_merge_enabled',
      });
    }
    try {
      const outcome = await tryAutoMergeArmedNativePr(
        { stmts: deps.stmts, nativePr: deps.nativePr },
        { project, number: row.number },
      );
      results.push({ projectId: project.id, number: row.number, ...outcome });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[native-pr] scheduled auto-merge failed for ${project.id}#${row.number}: ${reason}`,
      );
      results.push({ projectId: project.id, number: row.number, merged: false, reason });
    }
  }
  return results;
}

export function startScheduledAutoMergeTicker(deps: ScheduledAutoMergeDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runDueScheduledAutoMerges(deps)
      .catch((err: unknown) =>
        console.warn(
          `[native-pr] scheduled auto-merge tick failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      .finally(() => {
        running = false;
      });
  }, SCHEDULED_AUTO_MERGE_TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
