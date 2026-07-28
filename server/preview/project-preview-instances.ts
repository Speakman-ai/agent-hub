/**
 * List and tear down active worktree preview groups for a project (Settings UI).
 */
import type { Database } from 'better-sqlite3';
import type { PreviewComposeRuntime } from './preview-compose-runtime.js';
import type { PreviewRuntime } from './preview-runtime.js';
import type { DevServerRuntime } from './dev-server-runtime.js';
import { DEV_SERVER_RUNTIME_KIND } from './preview-schema.js';

export type ProjectPreviewInstanceStatus = 'starting' | 'ready' | 'failed';

export type ProjectPreviewInstanceKind = 'compose' | 'spawn' | 'dev-server';

export interface ProjectPreviewInstance {
  id: string;
  sessionId: string;
  sessionName: string | null;
  status: ProjectPreviewInstanceStatus;
  kind: ProjectPreviewInstanceKind;
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
  runtime: string | null;
  worktree_path: string | null;
  session_name: string | null;
  port: number | null;
  url: string | null;
};

/**
 * Which runtime owns a group row. The `runtime` discriminator wins:
 * compose never writes it, so a `dev-server` value is unambiguous. Only
 * when it is absent do we fall back to `compose_project_name` (compose)
 * and finally to the legacy spawn runtime.
 */
export function resolvePreviewInstanceKind(row: {
  runtime: string | null;
  compose_project_name: string | null;
}): ProjectPreviewInstanceKind {
  if (row.runtime === DEV_SERVER_RUNTIME_KIND) return 'dev-server';
  return row.compose_project_name ? 'compose' : 'spawn';
}

export function listProjectPreviewInstances(
  db: Database,
  projectId: string,
): ListProjectPreviewInstancesResult {
  const rows = db
    .prepare(
      // The port/url shown for a group comes from its entry process.
      // Compose names that row 'entry'; the dev-server runtime names its
      // rows after the project's portMap keys and flags one is_primary.
      // Pick by subquery (not a join predicate) so a group can never
      // fan out into duplicate rows.
      `SELECT g.id,
              g.session_id,
              g.status,
              g.started_at,
              g.last_active_at,
              g.compose_project_name,
              g.runtime,
              g.worktree_path,
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
                     AND (pp.name = 'entry' OR pp.is_primary = 1)
                   ORDER BY (pp.name = 'entry') DESC, pp.port ASC
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
      sessionName: row.session_name,
      status: row.status,
      kind: resolvePreviewInstanceKind(row),
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
  getDevServerRuntime?: () => DevServerRuntime | null;
};

async function stopGroupById(
  db: Database,
  deps: StopProjectPreviewDeps,
  groupId: string,
): Promise<void> {
  const row = db
    .prepare(
      `SELECT id, compose_project_name, runtime
         FROM worktree_preview_groups
        WHERE id = ?`,
    )
    .get(groupId) as
    | { id: string; compose_project_name: string | null; runtime: string | null }
    | undefined;
  if (!row) return;

  // Dispatch on the owning runtime. `PreviewRuntime.stopPreview` bails
  // out on dev-server rows by design, so routing them there would
  // report success while leaving the process and its host port alive.
  const kind = resolvePreviewInstanceKind(row);

  if (kind === 'dev-server') {
    const runtime = deps.getDevServerRuntime?.();
    if (!runtime) {
      throw new Error('Dev server runtime is not available');
    }
    await runtime.stop(groupId);
    return;
  }

  if (kind === 'compose') {
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
