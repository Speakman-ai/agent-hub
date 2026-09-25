import { Router, Request, Response } from 'express';
import type { RouteDeps } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { hasAtLeastRole } from '../roles.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { dispatchBackgroundCustomAgent } from '../heartbeat.js';
import { getBackgroundAgentRun, isBackgroundAgentRunning } from '../background-agent-runs.js';

/**
 * Manual "Test run" for a project's custom background agents, plus the
 * last-run readout the settings page polls.
 *
 *   POST /api/projects/:projectId/background-agents/:agentId/run
 *   GET  /api/projects/:projectId/background-agents/:agentId/last-run
 *
 * A test run uses the SAVED config and ignores the enabled toggle. Session
 * runs answer once the session exists (so the UI can link to it); one-shot
 * runs answer immediately and report through `last-run`.
 *
 * Running an agent executes as its configured owner right now, so the caller
 * must be that owner or an org Admin+.
 */

const BackgroundAgentRunComponent = registerComponent(
  'BackgroundAgentRun',
  z
    .object({
      status: z.enum(['running', 'succeeded', 'failed']),
      trigger: z.enum(['manual', 'schedule']),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      output: z.string().nullable().openapi({ description: 'Tail of one-shot output.' }),
      error: z.string().nullable(),
      sessionId: z.string().nullable().openapi({ description: 'Set for session runs.' }),
      sessionAgentId: z.string().nullable(),
    })
    .openapi({ description: 'Latest run of a custom background agent (in-memory).' }),
);

const RunAckComponent = registerComponent(
  'BackgroundAgentRunAck',
  z.object({
    status: z.enum(['running', 'session']),
    sessionId: z.string().optional(),
    agentId: z.string().optional(),
    skippedSkills: z.array(z.string()).optional(),
  }),
);

const ErrorComponent = z.object({ error: z.string() });
const params = z.object({ projectId: z.string(), agentId: z.string() });

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/background-agents/{agentId}/run',
  tags: ['Projects'],
  summary: 'Test-run a custom background agent now',
  description:
    'Runs the saved config regardless of the enabled toggle. Session runs return the new session id; one-shot runs return immediately with status `running`.',
  request: { params },
  responses: {
    200: {
      description: 'Run started.',
      content: { 'application/json': { schema: RunAckComponent } },
    },
    400: {
      description: 'Agent has no prompt.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
    403: {
      description: 'Caller is not the owner or an Admin.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
    404: {
      description: 'Project or agent not found.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
    409: {
      description: 'A run is already in progress.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
    500: {
      description: 'Dispatch failed.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/background-agents/{agentId}/last-run',
  tags: ['Projects'],
  summary: 'Latest run of a custom background agent',
  request: { params },
  responses: {
    200: {
      description: 'Latest run, or null when none since the Hub started.',
      content: { 'application/json': { schema: BackgroundAgentRunComponent.nullable() } },
    },
    404: {
      description: 'Project or agent not found.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
  },
});

export default function createBackgroundAgentRoutes(deps: Pick<RouteDeps, 'findProject'>): Router {
  const router = Router();

  function lookup(req: Request, res: Response) {
    const project = deps.findProject(String(req.params.projectId));
    if (!project || !canViewProject(project, resolveVisibilityCaller(req))) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    const agent = (project.backgroundAgents?.custom ?? []).find(
      (a) => a && a.id === String(req.params.agentId),
    );
    if (!agent) {
      res.status(404).json({ error: 'Background agent not found' });
      return null;
    }
    return { project, agent };
  }

  router.post(
    '/api/projects/:projectId/background-agents/:agentId/run',
    async (req: Request, res: Response) => {
      const found = lookup(req, res);
      if (!found) return;
      const { project, agent } = found;
      const authed = req as AuthenticatedRequest;
      const isOwner = !!authed.authUserId && authed.authUserId === (agent.ownerUserId ?? null);
      if (!isOwner && !hasAtLeastRole(authed.authRole, 'Admin')) {
        return res
          .status(403)
          .json({ error: 'Only the agent’s run-as user or an Admin can test-run it.' });
      }
      if (!agent.prompt?.trim()) {
        return res.status(400).json({ error: 'Add a prompt and save before running.' });
      }

      if (isBackgroundAgentRunning(project.id, agent.id)) {
        return res.status(409).json({ error: 'A run is already in progress.' });
      }

      const pending = dispatchBackgroundCustomAgent(project.id, agent.id, {
        force: true,
        trigger: 'manual',
      });

      if (!agent.runAsSession) {
        // The run is recorded synchronously inside dispatch; the spawn itself
        // can take minutes, so report through `last-run` instead of waiting.
        void pending;
        return res.json({ status: 'running' });
      }

      const result = await pending;
      if (result.status === 'session') {
        return res.json({
          status: 'session',
          sessionId: result.sessionId,
          agentId: result.agentId,
          skippedSkills: result.skippedSkills,
        });
      }
      if (result.status === 'skipped' && result.reason === 'busy') {
        return res.status(409).json({ error: 'A run is already in progress.' });
      }
      const message =
        result.status === 'failed' ? result.error : `Run did not start (${result.status})`;
      return res.status(500).json({ error: message });
    },
  );

  router.get(
    '/api/projects/:projectId/background-agents/:agentId/last-run',
    (req: Request, res: Response) => {
      const found = lookup(req, res);
      if (!found) return;
      res.json(getBackgroundAgentRun(found.project.id, found.agent.id));
    },
  );

  return router;
}
