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
import { createHash, randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import type { Project, RouteDeps, SessionRow } from '../types.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import {
  BACKGROUND_SESSION_MODES,
  type BackgroundSessionMode,
  BackgroundSessionDispatchError,
  dispatchBackgroundAgentSession,
  resolveOrchestrateForwardAgent,
} from '../background-agent-session.js';
import { isInternalSystemProject } from '../../shared/utils/hub.js';
import { formatHubChatRefToken } from '../../shared/utils/hubChatRefTokens.js';
import { requestOrganizationDispatch } from '../organization-dispatch.js';
import { sendDispatchOutcome } from './organization-dispatch.js';
import { parseSessionForwardDispatchKey } from '../../shared/utils/sessionForwardDispatchKey.js';
import { SESSION_FORWARD_STARTED_EVENT } from '../../shared/utils/orchestrateLaunchClient.js';
import { publishSessionNeedsInput } from '../session-needs-input.js';
import { orchestrateParentLinkError, orchestrateSpawnParentId } from '../session-mode.js';

const MAX_PROMPT_CHARS = 50_000;
const MAX_NAME_CHARS = 120;
const MAX_IDEMPOTENCY_KEY_CHARS = 512;

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
    idempotencyKey: z.string().trim().min(1).max(MAX_IDEMPOTENCY_KEY_CHARS).optional().openapi({
      description:
        'At most one session per acting user and key. A repeat with the same project, prompt and agent returns the session the first request started (200); a different payload is refused (409 `idempotency_key_reused`). Session forward cards send one per card so two tabs or devices cannot both start it.',
    }),
  })
  .openapi('DispatchSessionRequest');

export type DispatchSessionRequest = z.infer<typeof DispatchSessionRequestSchema>;

const DispatchSessionResponse = registerComponent(
  'DispatchSessionResponse',
  z
    .object({
      sessionId: z.string(),
      agentId: z.string(),
      projectId: z.string(),
      name: z.string(),
      mode: z.enum(BACKGROUND_SESSION_MODES).openapi({
        description:
          "The control the session actually started with. On an `idempotencyKey` repeat this is the first request's mode, which can differ from the mode this request asked for.",
      }),
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
    headers: z.object({
      'Idempotency-Key': z.string().optional().openapi({
        description:
          'Organization capabilities only: retries with the same key and payload return the same request (see POST /api/organizations/{organizationId}/dispatches).',
      }),
    }),
    body: { content: { 'application/json': { schema: DispatchSessionRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Session created and first turn started.',
      content: { 'application/json': { schema: DispatchSessionResponse } },
    },
    200: {
      description:
        'A repeat of an `idempotencyKey` already used by this user: the session the first request started (DispatchSessionResponse body). For an organization capability retry, the same target session (OrganizationDispatch body).',
    },
    202: {
      description:
        'Organization capability request queued behind a busy target (OrganizationDispatch body).',
    },
    400: { description: 'Invalid body, agent or mode.', content: errorContent },
    401: { description: 'No user identity to own the session.', content: errorContent },
    403: {
      description:
        'Organization capability scope denied or dispatch override forbidden, or the calling Orchestrate session belongs to another user (`parent_session_forbidden`).',
      content: errorContent,
    },
    404: { description: 'Project not found or not visible.', content: errorContent },
    409: {
      description:
        'Organization capability reused an Idempotency-Key with a different payload, `idempotencyKey` reused with a different payload (`idempotency_key_reused`), or the calling Orchestrate session is archived (`parent_session_archived`).',
      content: errorContent,
    },
    422: {
      description: 'Organization capability target agent disabled, ineligible or failed to start.',
      content: errorContent,
    },
    503: { description: 'Session dispatch is not ready.', content: errorContent },
  },
});

interface DispatchKeyRow {
  request_hash: string;
  session_id: string | null;
  agent_id: string | null;
  project_id: string | null;
  name: string | null;
  skipped_skills: string | null;
  mode: string | null;
}

function parseSkippedSkills(raw: string | null): string[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Session title from the prompt's first line. */
export function sessionNameFromPrompt(prompt: string): string {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= 60) return line || 'New session';
  return `${line.slice(0, 57).trimEnd()}...`;
}

export type SessionDispatchDeps = Pick<RouteDeps, 'stmts'> & Partial<Pick<RouteDeps, 'broadcast'>>;

export default function createSessionDispatchRoutes(
  deps: Pick<RouteDeps, 'findProject'> & SessionDispatchDeps,
): Router {
  const router = Router();

  router.post('/api/projects/:projectId/sessions/dispatch', (req: Request, res: Response) => {
    const capability = (req as AuthenticatedRequest).authOrganizationCapability;
    const organizationBody = z
      .object({
        prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS),
        agentId: z.string().min(1),
        name: z.string().trim().min(1).max(MAX_NAME_CHARS).optional(),
      })
      .strict()
      .safeParse(req.body);
    if (
      capability &&
      (!organizationCapabilityCanReadProject(
        capability,
        String(req.params.projectId),
        'dispatch',
      ) ||
        !organizationBody.success)
    ) {
      res.status(403).json({
        error:
          'Organization dispatch requires a scoped project and explicit agent; automation overrides are forbidden',
      });
      return;
    }
    if (capability && organizationBody.success) {
      // Same facade as /api/organizations/:id/dispatches, so provenance is always recorded.
      // Without an Idempotency-Key header every call is a new request.
      const header = req.get('Idempotency-Key')?.trim();
      if (header && !/^[\w.:-]{1,200}$/.test(header)) {
        res.status(400).json({ error: 'Invalid Idempotency-Key header', code: 'invalid_request' });
        return;
      }
      sendDispatchOutcome(res, () =>
        requestOrganizationDispatch(capability, capability.organizationId, {
          projectId: String(req.params.projectId),
          agentId: organizationBody.data.agentId,
          prompt: organizationBody.data.prompt,
          name: organizationBody.data.name ?? null,
          idempotencyKey: header || randomUUID(),
        }),
      );
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
    // The spawn-bound session id wins over the caller-controlled header, the
    // same precedence the owner resolution above uses.
    const callingSessionId =
      (req as AuthenticatedRequest).authSpawnSessionId?.trim() ||
      req.get('X-Agent-Hub-Session-Id')?.trim() ||
      '';
    const callingSession = callingSessionId
      ? (deps.stmts.getSession.get(callingSessionId) as SessionRow | undefined)
      : undefined;
    const outcome = dispatchProjectSession(deps, {
      project,
      body: parsed.data,
      ownerUserId,
      callingSession,
    });
    res.status(outcome.status).json(outcome.body);
  });

  return router;
}

/**
 * Tell the owner's clients a forward card started a session, whoever started
 * it (a press on any device, or the server's Auto start countdown), so every
 * open copy of the card stops counting down and shows the session.
 */
function publishForwardStarted(
  deps: SessionDispatchDeps,
  idempotencyKey: string,
  ownerUserId: string,
  started: { sessionId: string; agentId: string; name: string; mode: string },
): void {
  const forwardedFrom = parseSessionForwardDispatchKey(idempotencyKey);
  if (!forwardedFrom || !deps.broadcast) return;
  deps.broadcast({
    type: SESSION_FORWARD_STARTED_EVENT,
    sessionId: forwardedFrom.sessionId,
    ownerUserId,
    dispatchKey: idempotencyKey,
    started,
  });
}

export interface SessionDispatchOutcome {
  status: number;
  body: Record<string, unknown>;
}

const reply = (status: number, body: Record<string, unknown>): SessionDispatchOutcome => ({
  status,
  body,
});

/**
 * Start a session on a project agent as `ownerUserId`. Shared by the dispatch
 * route and the server-side Orchestrate auto start, so both honor the same
 * idempotency key and Orchestrate parent rules. `callingSession` is the chat
 * the request came from; an Orchestrate chat becomes the worker's parent.
 */
export function dispatchProjectSession(
  deps: SessionDispatchDeps,
  args: {
    project: Project;
    body: DispatchSessionRequest;
    ownerUserId: string;
    callingSession: SessionRow | undefined;
  },
): SessionDispatchOutcome {
  const { project, body, ownerUserId, callingSession } = args;
  const name = body.name ?? sessionNameFromPrompt(body.prompt);
  const spawnedFromSessionId = orchestrateSpawnParentId(callingSession);
  if (spawnedFromSessionId && callingSession) {
    const parentError = orchestrateParentLinkError(callingSession, ownerUserId);
    if (parentError) {
      return reply(parentError.status, { error: parentError.error, code: parentError.code });
    }
  }
  let sessionAgentId = body.agentId ?? null;
  if (spawnedFromSessionId) {
    const resolved = resolveOrchestrateForwardAgent(project.agents, sessionAgentId);
    if ('error' in resolved) {
      return reply(400, { error: resolved.error, code: 'no_session_agent' });
    }
    sessionAgentId = resolved.agentId;
  }
  // Claim the key before dispatching. Dispatch runs synchronously, so a
  // second request for the key always finds the claim already completed.
  const idempotencyKey = body.idempotencyKey ?? null;
  if (idempotencyKey) {
    const requestHash = createHash('sha256')
      .update(JSON.stringify([project.id, body.prompt, body.agentId ?? null]))
      .digest('hex');
    deps.stmts.pruneSessionDispatchKeys.run();
    const claimed =
      deps.stmts.claimSessionDispatchKey.run(ownerUserId, idempotencyKey, requestHash).changes > 0;
    if (!claimed) {
      const prior = deps.stmts.getSessionDispatchKey.get(ownerUserId, idempotencyKey) as
        | DispatchKeyRow
        | undefined;
      if (!prior || prior.request_hash !== requestHash) {
        return reply(409, {
          error: 'This idempotency key was already used for a different request',
          code: 'idempotency_key_reused',
        });
      }
      if (!prior.session_id) {
        return reply(409, {
          error: 'A session for this request is already starting',
          code: 'dispatch_in_progress',
        });
      }
      const priorName = prior.name || name;
      publishForwardStarted(deps, idempotencyKey, ownerUserId, {
        sessionId: prior.session_id,
        agentId: prior.agent_id || '',
        name: priorName,
        mode: prior.mode ?? 'manual',
      });
      return reply(200, {
        sessionId: prior.session_id,
        agentId: prior.agent_id || '',
        projectId: prior.project_id || project.id,
        name: priorName,
        mode: prior.mode as BackgroundSessionMode,
        skippedSkills: parseSkippedSkills(prior.skipped_skills),
        ref: formatHubChatRefToken(priorName, 'session', prior.session_id) ?? '',
      });
    }
  }
  try {
    const result = dispatchBackgroundAgentSession(
      project,
      {
        id: randomUUID(),
        name,
        prompt: body.prompt,
        ownerUserId,
        sessionAgentId,
        sessionMode: body.mode ?? null,
        engine: body.engine ?? null,
        model: body.model ?? null,
        skills: body.skills ?? [],
        runAsSession: true,
      },
      {
        sessionName: name,
        ...(spawnedFromSessionId ? { spawnedFromSessionId } : {}),
      },
    );
    if (idempotencyKey) {
      deps.stmts.completeSessionDispatchKey.run(
        result.sessionId,
        result.agentId,
        project.id,
        name,
        JSON.stringify(result.skippedSkills ?? []),
        result.mode,
        ownerUserId,
        idempotencyKey,
      );
      // A launched forward card no longer needs the human, so the chat
      // that posted it can leave "Needs your input".
      const forwardedFrom = parseSessionForwardDispatchKey(idempotencyKey);
      if (forwardedFrom && deps.broadcast) {
        publishSessionNeedsInput(forwardedFrom.sessionId, deps.stmts, deps.broadcast);
      }
      publishForwardStarted(deps, idempotencyKey, ownerUserId, {
        sessionId: result.sessionId,
        agentId: result.agentId,
        name,
        mode: result.mode,
      });
    }
    return reply(201, {
      sessionId: result.sessionId,
      agentId: result.agentId,
      projectId: project.id,
      name,
      mode: result.mode,
      skippedSkills: result.skippedSkills,
      ref: formatHubChatRefToken(name, 'session', result.sessionId) ?? '',
    });
  } catch (err) {
    if (idempotencyKey) {
      deps.stmts.releaseSessionDispatchKey.run(ownerUserId, idempotencyKey);
    }
    if (err instanceof BackgroundSessionDispatchError) {
      const status = err.code === 'no_hook' ? 503 : 400;
      return reply(status, { error: err.message, code: err.code });
    }
    throw err;
  }
}
