import type { AuthenticatedRequest } from '../auth.js';
import { organizationCapabilityCanReadProject } from '../organization-capabilities.js';
/**
 * POST /api/projects/:projectId/sessions/dispatch — start a chat session on a
 * project agent and send it a first prompt, without opening it in a client.
 *
 * Used by the Hub assistant ("start a session on X to do Y") and by any agent
 * through `sessions.sh dispatch`. The session belongs to the acting user: the
 * JWT / per-user key identity, or, for an agent on the global key, the owner
 * of the calling session. The response carries a ready-made chat ref token so
 * the caller can link the new session in its reply.
 */
import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import type { RouteDeps } from '../types.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import {
  BACKGROUND_SESSION_MODES,
  BackgroundSessionDispatchError,
  dispatchBackgroundAgentSession,
} from '../background-agent-session.js';
import { isInternalSystemProject } from '../../shared/utils/hub.js';
import { formatHubChatRefToken } from '../../shared/utils/hubChatRefTokens.js';

const MAX_PROMPT_CHARS = 50_000;
const MAX_NAME_CHARS = 120;

export const DispatchSessionRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS).openapi({
      description: 'First message sent to the new session.',
    }),
    agentId: z.string().min(1).optional().openapi({
      description:
        "Project agent that hosts the session. Defaults to the project's first agent that can host one (reviewer, docs and Hub agents cannot).",
    }),
    name: z.string().trim().min(1).max(MAX_NAME_CHARS).optional().openapi({
      description: 'Session title. Defaults to the start of the prompt.',
    }),
    mode: z.enum(BACKGROUND_SESSION_MODES).optional().openapi({
      description:
        'Finalize level (`manual`/`review`/`push`/`merge`) or session mode (`consult`/`scoping`/`skill-builder`/`autopilot`). Defaults to the project default.',
    }),
    engine: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    skills: z.array(z.string().min(1)).max(20).optional().openapi({
      description: 'Skills preloaded into the first turn.',
    }),
  })
  .openapi('DispatchSessionRequest');

const DispatchSessionResponse = registerComponent(
  'DispatchSessionResponse',
  z
    .object({
      sessionId: z.string(),
      agentId: z.string(),
      projectId: z.string(),
      name: z.string(),
      skippedSkills: z.array(z.string()),
      ref: z.string().openapi({
        description:
          'Chat ref token (`@[name](session:id)`) that renders as a live session chip in chat and assistant replies.',
      }),
    })
    .openapi({ description: 'The started session. Its first turn streams in the background.' }),
);

const ErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
const errorContent = { 'application/json': { schema: ErrorResponse } };

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/sessions/dispatch',
  tags: ['Sessions'],
  summary: 'Start a session on a project agent with a first prompt',
  description:
    'Creates the session as the acting user (or the calling session owner on the global key), sends the prompt, and returns once the session exists. The turn runs in the background.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: { content: { 'application/json': { schema: DispatchSessionRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Session created and first turn started.',
      content: { 'application/json': { schema: DispatchSessionResponse } },
    },
    400: { description: 'Invalid body, agent or mode.', content: errorContent },
    401: { description: 'No user identity to own the session.', content: errorContent },
    403: {
      description: 'Organization capability scope denied or dispatch override forbidden.',
      content: errorContent,
    },
    404: { description: 'Project not found or not visible.', content: errorContent },
    503: { description: 'Session dispatch is not ready.', content: errorContent },
  },
});

/** Session title from the prompt's first line. */
export function sessionNameFromPrompt(prompt: string): string {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= 60) return line || 'New session';
  return `${line.slice(0, 57).trimEnd()}...`;
}

export default function createSessionDispatchRoutes(
  deps: Pick<RouteDeps, 'findProject' | 'stmts'>,
): Router {
  const router = Router();

  router.post('/api/projects/:projectId/sessions/dispatch', (req: Request, res: Response) => {
    const capability = (req as AuthenticatedRequest).authOrganizationCapability;
    if (
      capability &&
      (!organizationCapabilityCanReadProject(
        capability,
        String(req.params.projectId),
        'dispatch',
      ) ||
        !z
          .object({ prompt: z.string(), agentId: z.string().min(1), name: z.string().optional() })
          .strict()
          .safeParse(req.body).success)
    ) {
      res.status(403).json({
        error:
          'Organization dispatch requires a scoped project and explicit agent; automation overrides are forbidden',
      });
      return;
    }
    const project = deps.findProject(String(req.params.projectId));
    if (
      !project ||
      isInternalSystemProject(project) ||
      (!capability && !canViewProject(project, resolveVisibilityCaller(req)))
    ) {
      res.status(404).json({ error: 'Project not found', code: 'project_not_found' });
      return;
    }
    const parsed = DispatchSessionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Invalid request',
        code: 'invalid_request',
      });
      return;
    }
    const ownerUserId = resolveGoogleConnectionUserId(req, { getSession: deps.stmts?.getSession });
    if (!ownerUserId) {
      res.status(401).json({
        error: 'A user identity is required to own the session',
        code: 'authentication_required',
      });
      return;
    }
    const body = parsed.data;
    const name = body.name ?? sessionNameFromPrompt(body.prompt);
    try {
      const result = dispatchBackgroundAgentSession(
        project,
        {
          id: randomUUID(),
          name,
          prompt: body.prompt,
          ownerUserId,
          sessionAgentId: body.agentId ?? null,
          sessionMode: body.mode ?? null,
          engine: body.engine ?? null,
          model: body.model ?? null,
          skills: body.skills ?? [],
          runAsSession: true,
        },
        { sessionName: name },
      );
      res.status(201).json({
        sessionId: result.sessionId,
        agentId: result.agentId,
        projectId: project.id,
        name,
        skippedSkills: result.skippedSkills,
        ref: formatHubChatRefToken(name, 'session', result.sessionId) ?? '',
      });
    } catch (err) {
      if (err instanceof BackgroundSessionDispatchError) {
        const status = err.code === 'no_hook' ? 503 : 400;
        res.status(status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  return router;
}
