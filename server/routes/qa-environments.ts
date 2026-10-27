/**
 * QA environments REST surface (`/api/projects/:projectId/qa/environments`).
 *
 * Project members can read (passwords come back masked); writes need Admin.
 * The project visibility gate mounted on `/api/projects/:projectId` in
 * `server/index.ts` runs first and scopes the project to the caller's org.
 */
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { requireRole } from '../roles.js';
import {
  createQaEnvironment,
  deleteQaEnvironment,
  listQaEnvironments,
  QaEnvironmentError,
  updateQaEnvironment,
} from '../qa-environments.js';
import type { RouteDeps } from '../types.js';
import {
  CreateQaEnvironmentRequestSchema,
  UpdateQaEnvironmentRequestSchema,
} from './qa-environments.openapi.js';

function parse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

export default function createQaEnvironmentRoutes(
  deps: Pick<RouteDeps, 'findProject' | 'broadcast'>,
): Router {
  const { findProject, broadcast } = deps;
  const router = Router();
  const BASE = '/api/projects/:projectId/qa/environments';

  const handle =
    (fn: (req: Request, res: Response, projectId: string) => void) =>
    (req: Request, res: Response): void => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      try {
        fn(req, res, projectId);
      } catch (e) {
        if (e instanceof QaEnvironmentError) {
          res.status(e.status).json({ error: e.message });
          return;
        }
        console.error('[qa] environment route error:', e);
        res.status(500).json({ error: 'Internal error' });
      }
    };

  const changed = (projectId: string, environmentId: string) =>
    broadcast({ type: 'qa_update', projectId, action: 'environments_updated', environmentId });

  router.get(
    BASE,
    handle((_req, res, projectId) => {
      res.json({ environments: listQaEnvironments(projectId) });
    }),
  );

  router.post(
    BASE,
    requireRole('Admin'),
    handle((req, res, projectId) => {
      const body = parse(CreateQaEnvironmentRequestSchema, req.body, res);
      if (!body) return;
      const environment = createQaEnvironment(projectId, body);
      changed(projectId, environment.id);
      res.status(201).json({ environment });
    }),
  );

  router.patch(
    `${BASE}/:environmentId`,
    requireRole('Admin'),
    handle((req, res, projectId) => {
      const body = parse(UpdateQaEnvironmentRequestSchema, req.body, res);
      if (!body) return;
      const environment = updateQaEnvironment(projectId, req.params.environmentId as string, body);
      changed(projectId, environment.id);
      res.json({ environment });
    }),
  );

  router.delete(
    `${BASE}/:environmentId`,
    requireRole('Admin'),
    handle((req, res, projectId) => {
      const id = req.params.environmentId as string;
      if (!deleteQaEnvironment(projectId, id)) {
        res.status(404).json({ error: 'Environment not found' });
        return;
      }
      changed(projectId, id);
      res.json({ ok: true });
    }),
  );

  return router;
}
