/**
 * Session pollers: the card an agent renders from an `agenthub:poller` block
 * posts here once the user confirms the schedule. The scheduler then wakes
 * the session every interval until the window ends.
 *
 * Gated by `userOwnsSession`, so the agent's `x-api-key` can list and stop its
 * own session's pollers too.
 */
import { Router, type Request, type Response } from 'express';
import type { RouteDeps, SessionRow } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { userOwnsSession } from '../session-ownership.js';
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import {
  POLLER_MAX_DURATION_MINUTES,
  POLLER_MAX_INTERVAL_MINUTES,
  POLLER_TASK_MAX_LEN,
} from '../../shared/utils/sessionPoller.js';
import type { SessionPollerStore } from '../session-pollers/session-poller-store.js';
import { SESSION_POLLER_UPDATED_EVENT } from '../session-pollers/session-poller-scheduler.js';

export interface SessionPollerRouteDeps extends RouteDeps {
  getSessionPollerStore: () => SessionPollerStore | null;
  /** Run a scheduler pass now so the first check does not wait for the next tick. */
  kickSessionPollers?: () => void;
}

const SessionIdParam = z.object({
  sessionId: z.string().openapi({ description: 'Chat session id.' }),
});
const PollerIdParam = SessionIdParam.extend({
  id: z.string().openapi({ description: 'Session poller id.' }),
});

const SessionPollerSchema = registerComponent(
  'SessionPoller',
  z
    .object({
      id: z.string(),
      sessionId: z.string(),
      pollerId: z.string().openapi({ description: 'Id from the `agenthub:poller` block.' }),
      task: z.string(),
      intervalMinutes: z.number().int(),
      durationMinutes: z.number().int(),
      notifyEachRun: z.boolean(),
      notifyOnComplete: z.boolean(),
      status: z.enum(['active', 'completed', 'cancelled']),
      runCount: z.number().int(),
      startedAt: z.string(),
      endsAt: z.string(),
      nextRunAt: z.string().nullable(),
      lastRunAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
    })
    .openapi({ description: 'A recurring check that wakes one session until its window ends.' }),
);

export const CreateSessionPollerBody = z.object({
  pollerId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
    .openapi({ description: 'Id from the `agenthub:poller` block; makes the create idempotent.' }),
  task: z.string().trim().min(1).max(POLLER_TASK_MAX_LEN),
  intervalMinutes: z.number().int().positive().max(POLLER_MAX_INTERVAL_MINUTES),
  durationMinutes: z.number().int().positive().max(POLLER_MAX_DURATION_MINUTES),
  notifyEachRun: z.boolean().default(false),
  notifyOnComplete: z.boolean().default(true),
});

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/pollers',
  summary: 'List session pollers',
  tags: ['Sessions'],
  request: { params: SessionIdParam },
  responses: {
    200: {
      description: 'Pollers for the session, oldest first.',
      content: {
        'application/json': { schema: z.object({ pollers: z.array(SessionPollerSchema) }) },
      },
    },
    404: { description: 'Session not found' },
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/pollers',
  summary: 'Start a session poller',
  description:
    'Starts a poller confirmed on an `agenthub:poller` card. The first check runs right away. Repeating the same `pollerId` returns the existing poller with `created: false`.',
  tags: ['Sessions'],
  request: {
    params: SessionIdParam,
    body: { content: { 'application/json': { schema: CreateSessionPollerBody } } },
  },
  responses: {
    200: {
      description: 'A poller with this `pollerId` already existed.',
      content: {
        'application/json': {
          schema: z.object({ poller: SessionPollerSchema, created: z.literal(false) }),
        },
      },
    },
    201: {
      description: 'Poller started.',
      content: {
        'application/json': {
          schema: z.object({ poller: SessionPollerSchema, created: z.literal(true) }),
        },
      },
    },
    400: { description: 'Invalid body' },
    404: { description: 'Session not found' },
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/pollers/{id}/stop',
  summary: 'Stop a session poller',
  tags: ['Sessions'],
  request: { params: PollerIdParam },
  responses: {
    200: {
      description: 'The poller, now cancelled (or already finished).',
      content: { 'application/json': { schema: z.object({ poller: SessionPollerSchema }) } },
    },
    404: { description: 'Session or poller not found' },
  },
});

export default function createSessionPollerRoutes(deps: SessionPollerRouteDeps): Router {
  const { stmts, broadcast, getSessionPollerStore, kickSessionPollers } = deps;
  const router = Router();

  const requireContext = (
    req: Request,
    res: Response,
  ): { session: SessionRow; store: SessionPollerStore } | null => {
    const sessionId = req.params.sessionId as string;
    const session = userOwnsSession(req as AuthenticatedRequest, sessionId)
      ? (stmts.getSession.get(sessionId) as SessionRow | undefined)
      : undefined;
    if (!session || session.deleted_at) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    const store = getSessionPollerStore();
    if (!store) {
      res.status(503).json({ error: 'Session pollers are not available on this server' });
      return null;
    }
    return { session, store };
  };

  router.get('/api/sessions/:sessionId/pollers', (req: Request, res: Response) => {
    const ctx = requireContext(req, res);
    if (!ctx) return;
    res.json({ pollers: ctx.store.listForSession(ctx.session.id) });
  });

  router.post('/api/sessions/:sessionId/pollers', (req: Request, res: Response) => {
    const ctx = requireContext(req, res);
    if (!ctx) return;
    const parsed = CreateSessionPollerBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid poller', issues: parsed.error.issues });
      return;
    }
    const { poller, created } = ctx.store.create({
      ...parsed.data,
      sessionId: ctx.session.id,
      createdBy: (req as AuthenticatedRequest).authUserId ?? null,
    });
    if (created) {
      broadcast({ type: SESSION_POLLER_UPDATED_EVENT, sessionId: ctx.session.id, poller });
      kickSessionPollers?.();
    }
    res.status(created ? 201 : 200).json({ poller, created });
  });

  router.post('/api/sessions/:sessionId/pollers/:id/stop', (req: Request, res: Response) => {
    const ctx = requireContext(req, res);
    if (!ctx) return;
    const existing = ctx.store.get(req.params.id as string);
    if (!existing || existing.sessionId !== ctx.session.id) {
      res.status(404).json({ error: 'Poller not found' });
      return;
    }
    const stopped = ctx.store.finish(existing.id, 'cancelled');
    if (stopped) {
      broadcast({ type: SESSION_POLLER_UPDATED_EVENT, sessionId: ctx.session.id, poller: stopped });
    }
    res.json({ poller: stopped ?? existing });
  });

  return router;
}
