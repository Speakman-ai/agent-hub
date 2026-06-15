/**
 * AI RUM (real user monitoring) instrumentation wizard routes.
 *
 *   GET /api/projects/:projectId/rum/setup-draft
 *     Admin+. Scans the project's working copy for the signal the
 *     recorder-injection wizard needs before touching code: frontend
 *     framework, injection-target candidates, existing CSP locations, and
 *     whether the rrweb recorder is already wired. Returns
 *     `{ projectId, draft }` — read-only, no session spawn, no file
 *     writes.
 *
 * This is the detection backbone for the broader "Hub as RUM vendor"
 * wizard. The worktree-backed injection session, the per-project client
 * token, and the PR-opening step are tracked as separate follow-up
 * slices; this endpoint deliberately only reads.
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../roles.js';
import { collectRumSetupDraft } from '../rum-setup-draft.js';
import type { RouteDeps } from '../types.js';

/** Derive a bare origin from a configured public URL, if parseable. */
function ingestOriginFromConfig(publicUrl: unknown): string | undefined {
  if (typeof publicUrl !== 'string' || !publicUrl.trim()) return undefined;
  try {
    return new URL(publicUrl).origin;
  } catch {
    return undefined;
  }
}

export default function createRumWizardRoutes(deps: RouteDeps): Router {
  const { findProject, config } = deps;
  const router = Router();

  router.get(
    '/api/projects/:projectId/rum/setup-draft',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const cwd = project.cwd;
      if (!cwd || typeof cwd !== 'string') {
        res.status(400).json({ error: 'Project has no cwd configured' });
        return;
      }
      const draft = collectRumSetupDraft(cwd, {
        ingestOrigin: ingestOriginFromConfig(config?.publicUrl),
      });
      res.json({ projectId: project.id, draft });
    },
  );

  return router;
}
