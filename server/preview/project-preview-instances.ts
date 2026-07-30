/**
 * List and tear down active worktree preview groups for a project (Settings UI).
 */
import type { Database } from 'better-sqlite3';
import type { DevServerRuntime } from './dev-server-runtime.js';

export type ProjectPreviewInstanceStatus = 'starting' | 'ready' | 'failed';

export interface ProjectPreviewInstance {
  id: string;
  sessionId: string;
  agentId: string | null;
  sessionName: string | null;
  status: ProjectPreviewInstanceStatus;
  port: number | null;
  url: string | null;
  startedAt: string;
  lastActiveAt: string;
}

export interface ListProjectPreviewInstancesResult {
  previews: ProjectPreviewInstance[];
}

type GroupRow = {
  id: string;
  session_id: string;
  status: ProjectPreviewInstanceStatus;
  started_at: string;
  last_active_at: string;
  agent_id: string | null;
  session_name: string | null;
  port: number | null;
  url: string | null;
};

export function listProjectPreviewInstances(
  db: Database,
  projectId: string,
): ListProjectPreviewInstancesResult {
  const rows = db
    .prepare(
      // The port/url shown for a group comes from its primary process —
      // the dev-server runtime names its rows after the project's portMap
      // labels and flags one `is_primary`. Pick by subquery (not a join
      // predicate) so a group can never fan out into duplicate rows.
      `SELECT g.id,
              g.session_id,
              g.status,
              g.started_at,
              g.last_active_at,
              s.agent_id,
              s.name AS session_name,
              p.port,
              p.url
         FROM worktree_preview_groups g
         LEFT JOIN sessions s ON s.id = g.session_id
         LEFT JOIN worktree_preview_processes p
                ON p.id = (
                  SELECT pp.id
                    FROM worktree_preview_processes pp
                   WHERE pp.group_id = g.id
                     AND pp.is_primary = 1
                   ORDER BY pp.port ASC
                   LIMIT 1
                )
        WHERE g.project_id = ?
          AND g.status IN ('starting', 'ready', 'failed')
        ORDER BY g.started_at DESC`,
    )
    .all(projectId) as GroupRow[];

  return {
    previews: rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      sessionName: row.session_name,
      status: row.status,
      port: row.port,
      url: row.url,
      startedAt: row.started_at,
      lastActiveAt: row.last_active_at,
    })),
  };
}

export type StopProjectPreviewDeps = {
  getDevServerRuntime?: () => DevServerRuntime | null;
};

async function stopGroupById(
  db: Database,
  deps: StopProjectPreviewDeps,
  groupId: string,
): Promise<void> {
  const row = db.prepare(`SELECT id FROM worktree_preview_groups WHERE id = ?`).get(groupId) as
    | { id: string }
    | undefined;
  if (!row) return;

  const runtime = deps.getDevServerRuntime?.();
  if (!runtime) {
    throw new Error('Dev server runtime is not available');
  }
  await runtime.stop(groupId);
}

export async function stopProjectPreviewInstance(
  db: Database,
  deps: StopProjectPreviewDeps,
  projectId: string,
  groupId: string,
): Promise<{ ok: true; stopped: boolean }> {
  const row = db
    .prepare(`SELECT id FROM worktree_preview_groups WHERE id = ? AND project_id = ?`)
    .get(groupId, projectId) as { id: string } | undefined;
  if (!row) {
    return { ok: true, stopped: false };
  }
  await stopGroupById(db, deps, groupId);
  return { ok: true, stopped: true };
}

export async function purgeProjectPreviewInstances(
  db: Database,
  deps: StopProjectPreviewDeps,
  projectId: string,
): Promise<{ ok: true; stopped: number; failed: Array<{ id: string; error: string }> }> {
  const { previews } = listProjectPreviewInstances(db, projectId);
  const failed: Array<{ id: string; error: string }> = [];
  let stopped = 0;

  for (const preview of previews) {
    try {
      await stopGroupById(db, deps, preview.id);
      stopped += 1;
    } catch (err) {
      failed.push({
        id: preview.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: true, stopped, failed };
}
