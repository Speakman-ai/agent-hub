/**
 * List and tear down active worktree preview groups for a project (Settings UI).
 */
import type { Database } from 'better-sqlite3';
import type { PreviewComposeRuntime } from './preview-compose-runtime.js';
import type { PreviewRuntime } from './preview-runtime.js';

export type ProjectPreviewInstanceStatus = 'starting' | 'ready' | 'failed';

export interface ProjectPreviewInstance {
  id: string;
  sessionId: string;
  sessionName: string | null;
  status: ProjectPreviewInstanceStatus;
  kind: 'compose' | 'spawn';
  composeProjectName: string | null;
  port: number | null;
  url: string | null;
  worktreePath: string | null;
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
  compose_project_name: string | null;
  worktree_path: string | null;
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
      `SELECT g.id,
              g.session_id,
              g.status,
              g.started_at,
              g.last_active_at,
              g.compose_project_name,
              g.worktree_path,
              s.name AS session_name,
              p.port,
              p.url
         FROM worktree_preview_groups g
         LEFT JOIN sessions s ON s.id = g.session_id
         LEFT JOIN worktree_preview_processes p
                ON p.group_id = g.id AND p.name = 'entry'
        WHERE g.project_id = ?
          AND g.status IN ('starting', 'ready', 'failed')
        ORDER BY g.started_at DESC`,
    )
    .all(projectId) as GroupRow[];

  return {
    previews: rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      sessionName: row.session_name,
      status: row.status,
      kind: row.compose_project_name ? 'compose' : 'spawn',
      composeProjectName: row.compose_project_name,
      port: row.port,
      url: row.url,
      worktreePath: row.worktree_path,
      startedAt: row.started_at,
      lastActiveAt: row.last_active_at,
    })),
  };
}

export type StopProjectPreviewDeps = {
  getPreviewComposeRuntime?: () => PreviewComposeRuntime | null;
  getPreviewRuntime?: () => PreviewRuntime | null;
};

async function stopGroupById(
  db: Database,
  deps: StopProjectPreviewDeps,
  groupId: string,
): Promise<void> {
  const row = db
    .prepare(
      `SELECT id, compose_project_name
         FROM worktree_preview_groups
        WHERE id = ?`,
    )
    .get(groupId) as { id: string; compose_project_name: string | null } | undefined;
  if (!row) return;

  if (row.compose_project_name) {
    const runtime = deps.getPreviewComposeRuntime?.();
    if (!runtime) {
      throw new Error('Compose preview runtime is not available');
    }
    await runtime.stopPreview(groupId);
    return;
  }

  const runtime = deps.getPreviewRuntime?.();
  if (!runtime) {
    throw new Error('Preview runtime is not available');
  }
  await runtime.stopPreview(groupId);
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
