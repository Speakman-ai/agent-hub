/**
 * Zod schemas + OpenAPI registrations for the org-wide dashboard endpoint.
 *
 * Single endpoint that aggregates project / agent / kanban / activity
 * counters for the active org. The actual SQL lives in
 * `server/routes/dashboard.ts`; this file only owns the wire shape.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { SESSION_STATES } from '../../shared/utils/sessionState.js';

const ErrorResponse = registerComponent(
  'DashboardErrorResponse',
  z
    .object({ error: z.string(), activeOrgId: z.string().optional() })
    .openapi({ description: 'Error envelope for dashboard route.' }),
);

const HeadlineCounts = z.object({
  projects: z.number().int(),
  agents: z.number().int(),
  sessions: z.number().int(),
  activeSessions: z.number().int(),
  openCards: z.number().int(),
  openPRs: z.number().int(),
  escalations: z.number().int(),
});

const KanbanByColumn = z.object({ columnName: z.string(), count: z.number().int() });

const KanbanByPriority = z.object({
  urgent: z.number().int(),
  high: z.number().int(),
  medium: z.number().int(),
  low: z.number().int(),
});

const KanbanBreakdown = z.object({
  totalBoards: z.number().int(),
  totalCards: z.number().int(),
  byColumn: z.array(KanbanByColumn),
  byPriority: KanbanByPriority,
});

const ActiveSessionEntry = z.object({
  sessionId: z.string(),
  sessionName: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  agentColor: z.string().nullable(),
  engine: z.string(),
  model: z.string().nullable(),
  prompt: z.string(),
  // Resolved lifecycle state (shared/utils/sessionState.js). The queue lists
  // every non-deleted session that has not reached `merged`, so this is one
  // of the earlier pipeline states.
  state: z.enum(SESSION_STATES as unknown as [string, ...string[]]),
  // Owning user (sessions.owner_user_id) resolved to a username. Null for
  // pre-auth-phase-4 sessions or when the user record is gone.
  ownerUserId: z.string().nullable(),
  ownerName: z.string().nullable(),
  // Start time of the currently-streaming turn, or null when the session is
  // in-flight but not actively streaming (testing / reviewing / waiting).
  startedAt: z.string().nullable(),
  // Last activity timestamp (sessions.updated_at) — always present, used to
  // order and time-stamp the queue regardless of streaming state.
  lastActivityAt: z.string(),
});

const OpenPrEntry = z.object({
  cardId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  prUrl: z.string(),
  prNumber: z.number().int().nullable(),
  title: z.string(),
  cardTitle: z.string(),
  authorAgent: z.string().nullable(),
  priority: z.string(),
  updatedAt: z.string(),
});

const ActivityEntry = z.object({
  type: z.enum(['card_created', 'card_updated', 'session_created', 'escalation', 'pr_created']),
  id: z.string(),
  title: z.string(),
  timestamp: z.string(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
});

export const DashboardResponseComponent = registerComponent(
  'DashboardResponse',
  z
    .object({
      orgId: z.string(),
      orgName: z.string(),
      isActive: z.boolean(),
      headline: HeadlineCounts,
      kanban: KanbanBreakdown,
      activeSessions: z.array(ActiveSessionEntry),
      openPRs: z.array(OpenPrEntry),
      recentActivity: z.array(ActivityEntry),
    })
    .openapi({
      description:
        'Org-wide dashboard payload. `:id` may be an explicit org id or the alias `active`.',
    }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/orgs/{id}/dashboard',
  tags: ['Dashboard'],
  summary: 'Org-wide dashboard counters + recent activity',
  description:
    'Aggregates project/agent/session/kanban/PR counters for the **active** org. Use `:id = "active"` to ask for the current org without knowing its real id (used by remote-mode clients). Returns 409 if the requested org is not the active one.',
  request: {
    params: z.object({
      id: z.string().openapi({ description: 'Org id, or the literal string `active`.' }),
    }),
  },
  responses: {
    200: { description: 'Dashboard payload.', content: jsonContent(DashboardResponseComponent) },
    401: errorResponse('Authentication required.'),
    403: errorResponse('Caller is not a member of this org.'),
    404: errorResponse('Org not found.'),
    409: errorResponse('Org is not the active one — switch first.'),
  },
});
