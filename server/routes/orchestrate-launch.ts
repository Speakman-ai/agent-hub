/**
 * Orchestrate launch settings for one chat (Default build and Auto start),
 * the forward cards it already started, and per-card auto-start cancels.
 *
 * Clients mirror their rail switches here so the server can start forward
 * cards from turns that run while nobody has the chat open. Gated by
 * `userOwnsSession`.
 */
import { Router, type Request, type Response } from 'express';
import type { RouteDeps, SessionRow } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { userOwnsSession } from '../session-ownership.js';
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { sessionForwardDispatchKey } from '../../shared/utils/sessionForwardDispatchKey.js';
import type { OrchestrateLaunchStore } from '../orchestrate-launch-store.js';
import {
  ORCHESTRATE_AUTO_START_CANCELLED_EVENT,
  ORCHESTRATE_LAUNCH_UPDATED_EVENT,
  type OrchestrateAutoStarter,
} from '../orchestrate-auto-start.js';

export interface OrchestrateLaunchRouteDeps extends Pick<RouteDeps, 'stmts'> {
  broadcast?: RouteDeps['broadcast'];
  getOrchestrateLaunchStore: () => OrchestrateLaunchStore | null;
  getOrchestrateAutoStarter: () => OrchestrateAutoStarter | null;
}

const SessionIdParam = z.object({
  sessionId: z.string().openapi({ description: 'Orchestrate chat session id.' }),
});

const BUILD_MODES = ['manual', 'review', 'push', 'merge'] as const;

const OrchestrateLaunchSettingsSchema = registerComponent(
  'OrchestrateLaunchSettings',
  z
    .object({
      mode: z.enum(BUILD_MODES).openapi({ description: 'Default build for forward cards.' }),
      autoStart: z.boolean().openapi({
        description: 'Forward cards start on their own after a 30 second countdown.',
      }),
      configured: z
        .boolean()
        .openapi({ description: 'False until settings were saved for this chat.' }),
      revision: z.number().int().openapi({
        description:
          'Bumped on every save (0 before the first). Clients ignore a value older than one they already have.',
      }),
    })
    .openapi({ description: "An Orchestrate chat's launch settings." }),
);

const LaunchedForwardSchema = z.object({
  dispatchKey: z.string().openapi({ description: "The card's dispatch idempotency key." }),
  sessionId: z.string(),
  agentId: z.string(),
  name: z.string(),
  mode: z.string(),
});

const OrchestrateLaunchResponse = z.object({
  settings: OrchestrateLaunchSettingsSchema,
  launched: z.array(LaunchedForwardSchema).openapi({
    description: 'Forward cards in this chat that already started a session.',
  }),
  cancelled: z.array(z.string()).openapi({
    description: 'Dispatch keys of cards whose auto start was cancelled on any device.',
  }),
  pending: z.array(z.object({ dispatchKey: z.string(), remainingMs: z.number().int() })).openapi({
    description:
      'Cards the server will start on its own, with the time left before it does. Clients count down to this, not to their own 30 seconds.',
  }),
});

export const UpdateOrchestrateLaunchBody = z
  .object({
    mode: z.enum(BUILD_MODES).optional(),
    autoStart: z.boolean().optional(),
  })
  .strict();

export const CancelOrchestrateAutoStartBody = z
  .object({
    messageId: z.union([z.string().min(1), z.number().int()]),
    forwardId: z.string().min(1).max(256),
    occurrence: z.number().int().min(0).max(1000),
  })
  .strict();

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/orchestrate-launch',
  summary: 'Get Orchestrate launch settings',
  tags: ['Sessions'],
  request: { params: SessionIdParam },
  responses: {
    200: {
      description: 'Settings and the forward cards already started.',
      content: { 'application/json': { schema: OrchestrateLaunchResponse } },
    },
    404: { description: 'Session not found' },
  },
});

registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/orchestrate-launch',
  summary: 'Update Orchestrate launch settings',
  description:
    'Saves Default build and Auto start and broadcasts `orchestrate_launch_updated` to open clients. With Auto start on, the server starts each forward card posted from then on 30 seconds after its turn ends (cards posted earlier are never started automatically); turning it off stops the running countdowns.',
  tags: ['Sessions'],
  request: {
    params: SessionIdParam,
    body: { content: { 'application/json': { schema: UpdateOrchestrateLaunchBody } } },
  },
  responses: {
    200: {
      description: 'Saved settings.',
      content: {
        'application/json': {
          schema: z.object({
            settings: OrchestrateLaunchSettingsSchema,
          }),
        },
      },
    },
    400: { description: 'Invalid body' },
    404: { description: 'Session not found' },
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/orchestrate-launch/cancel',
  summary: "Cancel a forward card's auto start",
  description:
    'Stops the server countdown for the card for good (a manual press still starts it) and broadcasts `orchestrate_auto_start_cancelled` so open clients update the card.',
  tags: ['Sessions'],
  request: {
    params: SessionIdParam,
    body: { content: { 'application/json': { schema: CancelOrchestrateAutoStartBody } } },
  },
  responses: {
    200: {
      description: 'Cancelled.',
      content: { 'application/json': { schema: z.object({ dispatchKey: z.string() }) } },
    },
    400: { description: 'Invalid body' },
    404: { description: 'Session not found' },
  },
});

export default function createOrchestrateLaunchRoutes(deps: OrchestrateLaunchRouteDeps): Router {
  const { stmts, broadcast, getOrchestrateLaunchStore, getOrchestrateAutoStarter } = deps;
  const router = Router();

  const requireContext = (
    req: Request,
    res: Response,
  ): { session: SessionRow; store: OrchestrateLaunchStore } | null => {
    const sessionId = req.params.sessionId as string;
    const session = userOwnsSession(req as AuthenticatedRequest, sessionId)
      ? (stmts.getSession.get(sessionId) as SessionRow | undefined)
      : undefined;
    if (!session || session.deleted_at) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    const store = getOrchestrateLaunchStore();
    if (!store) {
      res.status(503).json({ error: 'Orchestrate launch settings are not available' });
      return null;
    }
    return { session, store };
  };

  router.get('/api/sessions/:sessionId/orchestrate-launch', (req: Request, res: Response) => {
    const ctx = requireContext(req, res);
    if (!ctx) return;
    res.json({
      settings: ctx.store.getSettings(ctx.session.id),
      launched: ctx.store.listLaunched(ctx.session.id, ctx.session.owner_user_id ?? null),
      cancelled: ctx.store.listCancelled(ctx.session.id),
      pending: getOrchestrateAutoStarter()?.pendingCountdowns(ctx.session.id) ?? [],
    });
  });

  router.put('/api/sessions/:sessionId/orchestrate-launch', (req: Request, res: Response) => {
    const ctx = requireContext(req, res);
    if (!ctx) return;
    const parsed = UpdateOrchestrateLaunchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid settings', issues: parsed.error.issues });
      return;
    }
    const settings = ctx.store.setSettings(ctx.session.id, parsed.data);
    const starter = getOrchestrateAutoStarter();
    if (settings.autoStart) starter?.noteTurnEnded(ctx.session.id);
    else starter?.stopSession(ctx.session.id);
    // Other open clients show the change.
    broadcast?.({
      type: ORCHESTRATE_LAUNCH_UPDATED_EVENT,
      sessionId: ctx.session.id,
      ownerUserId: ctx.session.owner_user_id ?? null,
      settings,
    });
    res.json({ settings });
  });

  router.post(
    '/api/sessions/:sessionId/orchestrate-launch/cancel',
    (req: Request, res: Response) => {
      const ctx = requireContext(req, res);
      if (!ctx) return;
      const parsed = CancelOrchestrateAutoStartBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid card', issues: parsed.error.issues });
        return;
      }
      const dispatchKey = sessionForwardDispatchKey({ sessionId: ctx.session.id, ...parsed.data });
      if (!dispatchKey) {
        res.status(400).json({ error: 'Invalid card' });
        return;
      }
      const starter = getOrchestrateAutoStarter();
      if (starter) starter.cancel(dispatchKey);
      else ctx.store.cancel(dispatchKey);
      broadcast?.({
        type: ORCHESTRATE_AUTO_START_CANCELLED_EVENT,
        sessionId: ctx.session.id,
        ownerUserId: ctx.session.owner_user_id ?? null,
        dispatchKey,
      });
      res.json({ dispatchKey });
    },
  );

  return router;
}
