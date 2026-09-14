import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { getDb } from '../db.js';
import config from '../config.js';
import { requireRole } from '../roles.js';
import {
  createAutopilotController,
  type AutopilotController,
  type AutopilotControllerDeps,
} from '../autopilot/controller.js';
import { isAutopilotError } from '../autopilot/errors.js';
import type { AutopilotCancelSideEffects } from '../autopilot/types.js';
import {
  mintAutopilotWorkerCredential,
  revokeMintedAutopilotWorkerCredential,
} from '../autopilot/worker-authority.js';
import type { RouteDeps } from '../types.js';
import {
  CompleteAutopilotOperationRequestSchema,
  PutAutopilotConfigRequestSchema,
  StartAutopilotRequestSchema,
} from './autopilot.openapi.js';

export interface AutopilotRouteOptions {
  isServerEnabled?: () => boolean;
  cancelSideEffects?: AutopilotCancelSideEffects;
  getDeployedRevision?: (targetId: string) => string | null;
  credentialOwnerExists?: (userId: string) => boolean;
  holderId?: string;
  getController?: () => AutopilotController;
  assertContainment?: () => void;
  issueWorkerCredential?: AutopilotControllerDeps['issueWorkerCredential'];
  revokeWorkerCredential?: AutopilotControllerDeps['revokeWorkerCredential'];
}

function sendAutopilotError(res: Response, err: unknown): void {
  if (isAutopilotError(err)) {
    res.status(err.httpStatus).json({ error: err.message, code: err.code });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}

export function buildAutopilotControllerDeps(
  options: AutopilotRouteOptions = {},
): AutopilotControllerDeps {
  return {
    db: getDb(),
    isServerEnabled:
      options.isServerEnabled ?? (() => Boolean(config.experimentalAutopilotEnabled)),
    cancelSideEffects: options.cancelSideEffects,
    getDeployedRevision: options.getDeployedRevision,
    credentialOwnerExists: options.credentialOwnerExists,
    holderId: options.holderId,
    assertContainment: options.assertContainment,
    issueWorkerCredential: options.issueWorkerCredential ?? mintAutopilotWorkerCredential,
    revokeWorkerCredential: options.revokeWorkerCredential ?? revokeMintedAutopilotWorkerCredential,
  };
}

export default function createAutopilotRoutes(
  deps: RouteDeps,
  options: AutopilotRouteOptions = {},
): Router {
  const router = Router();
  const { findProject } = deps;

  const controllerFor = (): AutopilotController =>
    options.getController?.() ?? createAutopilotController(buildAutopilotControllerDeps(options));

  function resolveProject(req: Request, res: Response): string | null {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    return project.id;
  }

  function actor(req: Request): { userId: string | null } {
    return { userId: (req as AuthenticatedRequest).authUserId ?? null };
  }

  router.get(
    '/api/projects/:projectId/autopilot',
    requireRole('User'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      try {
        res.json(controllerFor().getProjectState(projectId));
      } catch (err) {
        sendAutopilotError(res, err);
      }
    },
  );

  router.put(
    '/api/projects/:projectId/autopilot/config',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      const parsed = PutAutopilotConfigRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      try {
        res.json(controllerFor().putConfig(projectId, parsed.data, actor(req)));
      } catch (err) {
        sendAutopilotError(res, err);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/autopilot/start',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      const parsed = StartAutopilotRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      try {
        res.status(201).json(controllerFor().start(projectId, parsed.data, actor(req)));
      } catch (err) {
        sendAutopilotError(res, err);
      }
    },
  );

  router.get(
    '/api/projects/:projectId/autopilot/runs/:runId',
    requireRole('User'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      try {
        res.json(controllerFor().getRun(projectId, req.params.runId as string));
      } catch (err) {
        sendAutopilotError(res, err);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/autopilot/pause',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      try {
        res.json(controllerFor().pause(projectId, actor(req)));
      } catch (err) {
        sendAutopilotError(res, err);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/autopilot/resume',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      try {
        res.json(await controllerFor().resume(projectId, actor(req)));
      } catch (err) {
        sendAutopilotError(res, err);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/autopilot/stop',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      try {
        res.json(await controllerFor().stop(projectId, actor(req)));
      } catch (err) {
        sendAutopilotError(res, err);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/autopilot/disable',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      try {
        res.json(await controllerFor().disable(projectId, actor(req)));
      } catch (err) {
        sendAutopilotError(res, err);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/autopilot/operations/:operationId/complete',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      const parsed = CompleteAutopilotOperationRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      try {
        const op = await controllerFor().completeOperation({
          operationId: req.params.operationId as string,
          fencingGeneration: parsed.data.fencingGeneration,
          outcome: parsed.data.outcome,
          result: parsed.data.result,
        });
        if (op.runId) {
          const snap = controllerFor().getRun(projectId, op.runId);
          if (snap.run.projectId !== projectId) {
            return res.status(404).json({ error: 'Operation not found' });
          }
        }
        res.json(op);
      } catch (err) {
        sendAutopilotError(res, err);
      }
    },
  );

  return router;
}
