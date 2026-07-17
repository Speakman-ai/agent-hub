/**
 * finalize-ci-config.ts — REST surface for a project's SERVER-STORED Finalize
 * CI config (the fallback used when a repo does not commit `.agent-hub/ci.yaml`).
 *
 *   - `GET    /api/projects/:projectId/finalize/ci-config`
 *       Return the project-scoped config and (if the caller has one) their
 *       personal override. `null` for a scope with nothing stored.
 *
 *   - `PUT    /api/projects/:projectId/finalize/ci-config`
 *       `{ ci_yaml_content, scope?: 'project' | 'personal' }`. Validates against
 *       the ci.yaml schema, then upserts. `personal` writes an override keyed to
 *       the caller's user id.
 *
 *   - `DELETE /api/projects/:projectId/finalize/ci-config?scope=project|personal`
 *       Remove one scope's config.
 *
 * Admin+ gated on every verb — a server-stored config runs arbitrary commands
 * in the Finalize runner and, unlike a committed ci.yaml, never passes through
 * code review. The resolution precedence (committed file > personal > project)
 * lives in `server/finalize/ci-config-source.ts`; this file is the thin HTTP
 * shell over `server/finalize/ci-config-store.ts`.
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../roles.js';
import { resolveOwnerUserId } from '../session-ownership.js';
import { parseCiConfig } from '../finalize/ci-config.js';
import {
  getServerCiConfig,
  upsertServerCiConfig,
  deleteServerCiConfig,
  type ServerCiConfigRow,
  type ServerCiScope,
} from '../finalize/ci-config-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';

interface ServerCiConfigView {
  scope: ServerCiScope;
  ci_yaml_content: string;
  updated_by: string | null;
  updated_at: number;
}

function toView(row: ServerCiConfigRow): ServerCiConfigView {
  return {
    scope: row.owner_user_id ? 'personal' : 'project',
    ci_yaml_content: row.yaml_text,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}

function parseScope(raw: unknown): ServerCiScope | null {
  if (raw === undefined || raw === null || raw === '') return 'project';
  if (raw === 'project' || raw === 'personal') return raw;
  return null;
}

export default function createFinalizeCiConfigRoutes(deps: RouteDeps): Router {
  const { stmts, findProject } = deps;
  const router = Router();

  // ── GET stored config(s) ────────────────────────────────────────────
  router.get(
    '/api/projects/:projectId/finalize/ci-config',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const uid = resolveOwnerUserId(req as AuthenticatedRequest);
      const projectRow = getServerCiConfig(stmts, project.id, null);
      const personalRow = uid ? getServerCiConfig(stmts, project.id, uid) : null;
      return res.json({
        project_id: project.id,
        project: projectRow ? toView(projectRow) : null,
        personal: personalRow ? toView(personalRow) : null,
      });
    },
  );

  // ── PUT (upsert) a stored config ────────────────────────────────────
  router.put(
    '/api/projects/:projectId/finalize/ci-config',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const content = typeof body.ci_yaml_content === 'string' ? body.ci_yaml_content : '';
      if (!content.trim()) {
        return res.status(400).json({ error: 'ci_yaml_content must be a non-empty string' });
      }
      const scope = parseScope(body.scope);
      if (!scope) {
        return res.status(400).json({ error: "scope must be 'project' or 'personal'" });
      }

      // Validate against the ci.yaml schema BEFORE persisting — a malformed
      // config never lands in the store (mirrors the setup-apply commit path).
      const parsed = parseCiConfig(content);
      if (!parsed.ok) {
        return res.status(400).json({
          error: 'ci_config_invalid',
          code: parsed.error.code,
          message: parsed.error.message,
          path: parsed.error.path ?? null,
        });
      }

      const uid = resolveOwnerUserId(req as AuthenticatedRequest);
      if (scope === 'personal' && !uid) {
        return res.status(400).json({
          error: 'no_user',
          message:
            'A personal config requires an authenticated user; none resolved for this request.',
        });
      }
      const ownerUserId = scope === 'personal' ? uid : null;

      try {
        const row = upsertServerCiConfig(stmts, {
          projectId: project.id,
          ownerUserId,
          yamlText: content,
          updatedBy: uid,
        });
        return res.json({ ok: true, project_id: project.id, config: toView(row) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[finalize-ci-config] upsert failed for project=${project.id}: ${message}`);
        return res.status(500).json({ error: 'ci_config_store_failed', message });
      }
    },
  );

  // ── DELETE a stored config ──────────────────────────────────────────
  router.delete(
    '/api/projects/:projectId/finalize/ci-config',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const scope = parseScope(req.query.scope);
      if (!scope) {
        return res.status(400).json({ error: "scope must be 'project' or 'personal'" });
      }
      const uid = resolveOwnerUserId(req as AuthenticatedRequest);
      if (scope === 'personal' && !uid) {
        return res.status(400).json({ error: 'no_user' });
      }
      const ownerUserId = scope === 'personal' ? uid : null;
      const deleted = deleteServerCiConfig(stmts, project.id, ownerUserId);
      return res.json({ ok: true, project_id: project.id, scope, deleted });
    },
  );

  return router;
}
