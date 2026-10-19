/**
 * Organization dispatch facade routes. An organization agent (capability credential) asks
 * a linked project's agent to do work; the acting user is always the capability's user.
 * Status lookups are open to the same capability scope or to the acting user's own login,
 * and re-check current project access on every read.
 */
import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { resolveOrganizationCaller } from '../business-organizations-access.js';
import { organizationCapabilityCanReadProject } from '../organization-capabilities.js';
import { scopeForMember } from '../organization-context.js';
import {
  ORGANIZATION_DISPATCH_STATUSES,
  OrganizationDispatchError,
  drainOrganizationDispatchQueue,
  getOrganizationDispatch,
  listOrganizationDispatches,
  requestOrganizationDispatch,
  toDispatchView,
  type OrganizationDispatchRow,
} from '../organization-dispatch.js';
import { getActiveOrgId } from '../orgs.js';

const MAX_PROMPT_CHARS = 50_000;

export const OrganizationDispatchRequestSchema = z
  .object({
    projectId: z.string().min(1).max(200).openapi({
      description: 'Linked project that owns the target agent.',
    }),
    agentId: z.string().min(1).max(200).openapi({ description: 'Target project agent.' }),
    prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS).openapi({
      description: 'Task sent as the first message of the target session.',
    }),
    name: z.string().trim().min(1).max(120).optional(),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\w.:-]+$/)
      .openapi({
        description:
          'Scoped to the initiating organization session. An identical retry returns the same request and target session; reuse with a different payload fails with 409.',
      }),
  })
  .strict()
  .openapi('OrganizationDispatchRequest');

const OrganizationDispatchView = registerComponent(
  'OrganizationDispatch',
  z.object({
    requestId: z.string(),
    status: z.enum(ORGANIZATION_DISPATCH_STATUSES).openapi({
      description:
        '`queued` waits for a busy target and is re-authorized when it runs; `starting` has a reserved session id and is settled by the queue if the Hub stopped mid-start; `accepted` started a session; `rejected` failed authorization or target validation; `failed` could not start (or its first turn failed); `revoked` lost access while queued; `expired` stayed queued too long.',
    }),
    code: z.string().nullable(),
    message: z.string().nullable(),
    serverId: z.string(),
    organizationId: z.string(),
    organizationAgentId: z.string(),
    initiatingSessionId: z.string(),
    actingUserId: z.string(),
    projectId: z.string(),
    agentId: z.string(),
    idempotencyKey: z.string(),
    name: z.string(),
    sessionId: z.string().nullable(),
    ref: z.string().nullable().openapi({
      description: 'Chat ref token for the target session; renders as a live session chip.',
    }),
    sessionState: z.string().nullable(),
    statusPath: z.string(),
    resultPath: z.string().nullable().openapi({
      description: 'Organization context path for the target session status and latest result.',
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
    acceptedAt: z.string().nullable(),
    replayed: z.boolean().optional(),
  }),
);

const ErrorResponse = z.object({
  error: z.string(),
  code: z.string().optional(),
  dispatch: OrganizationDispatchView.optional(),
});
const errorContent = { 'application/json': { schema: ErrorResponse } };
const OrgParams = z.object({ organizationId: z.string().min(1) });
const DispatchParams = OrgParams.extend({ requestId: z.string().min(1) });
const ListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
const DispatchList = z.object({
  dispatches: z.array(OrganizationDispatchView),
  offset: z.number(),
  nextOffset: z.number().nullable(),
});

registerPath({
  method: 'post',
  path: '/api/organizations/{organizationId}/dispatches',
  tags: ['Organizations'],
  summary: 'Dispatch a linked project agent from an organization agent session',
  description:
    'Organization capability only. The target session is owned by the acting user and starts at the project default (manual) Finalize level. Every outcome is recorded with provenance.',
  request: {
    params: OrgParams,
    body: { content: { 'application/json': { schema: OrganizationDispatchRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Identical retry of an accepted request: the same target session.',
      content: { 'application/json': { schema: OrganizationDispatchView } },
    },
    201: {
      description: 'Target session created and first turn started.',
      content: { 'application/json': { schema: OrganizationDispatchView } },
    },
    202: {
      description: 'Target busy; the request is queued and re-authorized when it runs.',
      content: { 'application/json': { schema: OrganizationDispatchView } },
    },
    400: { description: 'Invalid body.', content: errorContent },
    401: { description: 'Capability missing or revoked.', content: errorContent },
    403: { description: 'Dispatch tool not configured for this agent.', content: errorContent },
    404: {
      description: 'Organization, project or agent not found or outside the current scope.',
      content: errorContent,
    },
    409: { description: 'Idempotency key reused with a different payload.', content: errorContent },
    422: {
      description: 'Target agent disabled, ineligible or failed to start.',
      content: errorContent,
    },
    503: { description: 'Session dispatch is not ready.', content: errorContent },
  },
});
registerPath({
  method: 'get',
  path: '/api/organizations/{organizationId}/dispatches',
  tags: ['Organizations'],
  summary: 'List dispatch requests visible to the caller',
  description:
    "A capability sees its own session's requests; a member login sees their own requests. Requests for projects outside current access are omitted.",
  request: { params: OrgParams, query: ListQuery },
  responses: {
    200: {
      description: 'Newest first.',
      content: { 'application/json': { schema: DispatchList } },
    },
    400: { description: 'Invalid pagination.', content: errorContent },
    401: { description: 'Authentication required.', content: errorContent },
    404: { description: 'Organization not found.', content: errorContent },
  },
});
registerPath({
  method: 'get',
  path: '/api/organizations/{organizationId}/dispatches/{requestId}',
  tags: ['Organizations'],
  summary: 'Status of one dispatch request',
  description:
    'A capability reads only requests from its own initiating session; a member login reads their own requests. Requests for projects outside current access return 404.',
  request: { params: DispatchParams },
  responses: {
    200: {
      description: 'Current status, target session reference and result link.',
      content: { 'application/json': { schema: OrganizationDispatchView } },
    },
    401: { description: 'Authentication required.', content: errorContent },
    404: { description: 'Not found or no longer authorized.', content: errorContent },
  },
});

type Reader = (row: OrganizationDispatchRow) => boolean;

/** Who may read dispatch rows of this organization, re-resolved per request. */
function reader(req: Request, res: Response): { read: Reader; sessionId: string | null } | null {
  res.setHeader('Cache-Control', 'no-store');
  const authenticated = req as AuthenticatedRequest;
  const organizationId = String(req.params.organizationId);
  const grant = authenticated.authOrganizationCapability;
  if (grant) {
    if (grant.organizationId !== organizationId) {
      res.status(404).json({ error: 'Organization not found' });
      return null;
    }
    return {
      sessionId: grant.sessionId,
      // Capabilities are session-bound: another session of the same user does not see
      // this session's requests. The user's own login keeps the wider view.
      read: (row) =>
        row.initiating_session_id === grant.sessionId &&
        row.acting_user_id === grant.userId &&
        (organizationCapabilityCanReadProject(grant, row.target_project_id, 'dispatch') ||
          organizationCapabilityCanReadProject(grant, row.target_project_id)),
    };
  }
  if (!authenticated.authUserId || !authenticated.authOrgId) {
    res.status(401).json({ error: 'An authenticated user identity is required' });
    return null;
  }
  const caller = resolveOrganizationCaller(authenticated.authOrgId, authenticated.authUserId);
  const scope = caller && scopeForMember(caller, organizationId);
  if (!scope) {
    res.status(404).json({ error: 'Organization not found' });
    return null;
  }
  return {
    sessionId: null,
    read: (row) =>
      row.acting_user_id === scope.userId && scope.projectIds.includes(row.target_project_id),
  };
}

export default function createOrganizationDispatchRoutes(): Router {
  const router = Router();

  router.post('/api/organizations/:organizationId/dispatches', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const grant = (req as AuthenticatedRequest).authOrganizationCapability;
    if (!grant) {
      res.status(403).json({
        error: 'Organization dispatch runs from an organization agent session',
        code: 'capability_required',
      });
      return;
    }
    const parsed = OrganizationDispatchRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Invalid request',
        code: 'invalid_request',
      });
      return;
    }
    sendDispatchOutcome(res, () =>
      requestOrganizationDispatch(grant, String(req.params.organizationId), parsed.data),
    );
  });

  router.get('/api/organizations/:organizationId/dispatches', (req, res) => {
    const access = reader(req, res);
    if (!access) return;
    const query = ListQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'Invalid pagination' });
      return;
    }
    drainOrganizationDispatchQueue();
    const authenticated = req as AuthenticatedRequest;
    const { limit, offset } = query.data;
    const rows = listOrganizationDispatches({
      serverId: getActiveOrgId(),
      organizationId: String(req.params.organizationId),
      actingUserId: String(authenticated.authUserId),
      initiatingSessionId: access.sessionId,
      limit: limit + 1,
      offset,
    });
    const page = rows.slice(0, limit);
    res.json({
      dispatches: page.filter(access.read).map(toDispatchView),
      offset,
      nextOffset: rows.length > limit ? offset + limit : null,
    });
  });

  router.get('/api/organizations/:organizationId/dispatches/:requestId', (req, res) => {
    const access = reader(req, res);
    if (!access) return;
    drainOrganizationDispatchQueue();
    const row = getOrganizationDispatch(
      getActiveOrgId(),
      String(req.params.organizationId),
      String(req.params.requestId),
    );
    if (!row || !access.read(row)) {
      res.status(404).json({ error: 'Dispatch not found' });
      return;
    }
    res.json(toDispatchView(row));
  });

  return router;
}

/** Shared by the facade route and the capability path of the project dispatch route. */
export function sendDispatchOutcome(
  res: Response,
  run: () => ReturnType<typeof requestOrganizationDispatch>,
): void {
  try {
    const outcome = run();
    const body = { ...outcome.view, replayed: outcome.replayed };
    if (outcome.httpStatus >= 400) {
      res.status(outcome.httpStatus).json({
        error: outcome.view.message ?? 'Dispatch refused',
        code: outcome.view.code ?? undefined,
        dispatch: body,
      });
      return;
    }
    res.status(outcome.httpStatus).json(body);
  } catch (err) {
    if (err instanceof OrganizationDispatchError) {
      res.status(err.httpStatus).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
}
