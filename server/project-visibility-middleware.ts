/**
 * Project-scoped route gate.
 *
 * Mounted at `/api/projects/:projectId` ahead of every project sub-router
 * (board, wiki, sessions, agents, webhooks, preview, …). A single mount
 * means we don't have to remember to gate each route individually — adding
 * a new `/api/projects/:projectId/<thing>` endpoint inherits the visibility
 * check for free.
 *
 * Behavior:
 *   - Project missing → fall through with no 404 here. The downstream
 *     route is responsible for shape-specific not-found messages; we
 *     don't want to break tests that probe non-existent ids on purpose.
 *   - Caller cannot view → mask as 404 (same shape the route would have
 *     returned if the project were genuinely missing) so we don't leak
 *     existence of private projects.
 *
 * Exceptions handled INSIDE this gate:
 *   - GitHub webhook routes are unauthenticated by design and live on
 *     `/api/webhooks/*` (no projectId in the path), so they don't trip
 *     this mount.
 *   - `DELETE /api/projects/:projectId` — the route handler owns the Owner
 *     kill-switch (`canDeleteProject`). If the gate returned 404 here the
 *     kill-switch would never run, so we detect the pattern with `isDeleteSelf`
 *     and call `next()` directly, letting the route handler make the final call.
 */

import type { Request, Response, NextFunction } from 'express';
import type { Project } from './types.js';
import { canViewProject, type VisibilityCaller } from './project-visibility.js';
import type { AuthenticatedRequest } from './auth.js';

export interface VisibilityGateDeps {
  findProject: (projectId: string) => Project | null;
}

export function createProjectVisibilityGate(
  deps: VisibilityGateDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  return function visibilityGate(req: Request, res: Response, next: NextFunction): void {
    const rawProjectId = req.params.projectId;
    // Express params can be string | string[] when an :id appears more than
    // once in the mounted path. The gate only ever uses a single
    // `:projectId` segment, so we collapse to a single string here.
    const projectId = Array.isArray(rawProjectId) ? rawProjectId[0] : rawProjectId;
    if (!projectId) {
      next();
      return;
    }
    const project = deps.findProject(projectId);
    if (!project) {
      next();
      return;
    }
    const areq = req as AuthenticatedRequest;
    // Match the bypass logic in routes/projects.ts `resolveVisibilityCaller`:
    // single-tenant local mode, the global apiKey break-glass, and the
    // no-auth-configured fresh-install/dev/unit-test mode (Owner role
    // stamped without any user id) all see every project.
    const noAuthConfigured = !areq.authUserId && !areq.authUser && areq.authRole === 'Owner';
    const caller: VisibilityCaller = {
      userId: areq.authUserId ?? null,
      role: areq.authRole,
      localBypass: Boolean(areq.authLocalOrgBypass || areq.authViaApiKey || noAuthConfigured),
    };
    if (!canViewProject(project, caller)) {
      // Two exceptions where we let the request through to its handler
      // and let the handler enforce its own deeper auth:
      //   1. DELETE /api/projects/:projectId — Owners get the kill-switch
      //      bypass via `canDeleteProject` inside the route handler.
      //      Blocking here would 404 before that check ever runs.
      //   2. GitHub webhook delivery routes — none currently live under
      //      this prefix, but if any are added they MUST be allowed
      //      through (webhooks have no `authUserId` to compare). The
      //      check is on req.path so a future move is caught.
      const originalUrl = typeof req.originalUrl === 'string' ? req.originalUrl.split('?')[0] : '';
      const isDeleteSelf =
        req.method === 'DELETE' &&
        (req.baseUrl + req.path === `/api/projects/${projectId}` ||
          originalUrl === `/api/projects/${projectId}`);
      if (isDeleteSelf) {
        next();
        return;
      }
      // Mask as 404 to avoid leaking private project existence.
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    next();
  };
}
