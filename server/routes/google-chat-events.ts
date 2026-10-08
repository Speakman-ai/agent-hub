import { Router, Request, Response } from 'express';
import type { RouteDeps } from '../types.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import { CHAT_MESSAGES_READONLY_SCOPE, hasChatMessagesReadScope } from '../google-scopes.js';
import {
  ChatEventsAccessLostError,
  ChatEventsNotConfiguredError,
  ChatEventsTokenError,
  emitUnread,
  ensureChatSubscription,
  errorMessage,
  handleChatPushEvent,
  publicSubscription,
  verifyPushToken,
  type ChatEventsDeps,
  type PubSubPushEnvelope,
  type PushTokenVerifier,
} from '../google-chat-events.js';
import {
  currentChatSeq,
  getChatSubscription,
  getUnreadSnapshot,
  markSpaceRead,
} from '../google-chat-events-store.js';
import { requireChatAccess, sendGoogleError } from './google-chat.js';
import { GOOGLE_CHAT_EVENTS_PUSH_PATH } from '../google-chat-events-config.js';
import { registerComponent, registerPath, z } from '../openapi/registry.js';
import { isRfc3339 } from '../../shared/utils/rfc3339.js';

/**
 * Google Chat push: Pub/Sub intake plus the per-user subscription and unread
 * surfaces the Chat pane uses. Lifecycle and fan-out live in
 * server/google-chat-events.ts.
 */

const ErrorResponse = registerComponent(
  'GoogleChatEventsErrorResponse',
  z.object({ error: z.string(), code: z.string().optional() }),
);

const SubscriptionSchema = registerComponent(
  'GoogleChatEventSubscription',
  z.object({
    state: z.enum(['ACTIVE', 'SUSPENDED', 'EXPIRED', 'ERROR']),
    expireTime: z.string().nullable(),
    suspensionReason: z.string().nullable().openapi({
      description: 'Google ErrorType that suspended the subscription, e.g. USER_SCOPE_REVOKED.',
    }),
    lastError: z.string().nullable(),
  }),
);

const PushStatusSchema = registerComponent(
  'GoogleChatPushStatus',
  z.object({
    configured: z.boolean().openapi({
      description: 'False when the server has no Pub/Sub topic set up; the pane polls instead.',
    }),
    subscription: SubscriptionSchema.nullable(),
    version: z.number().int().openapi({
      description:
        "The user's push-state sequence number as of this response. WebSocket status events carry one too; apply whichever is newer.",
    }),
  }),
);

const SpaceUnreadSchema = registerComponent(
  'GoogleChatSpaceUnread',
  z.object({
    spaceName: z.string(),
    count: z.number().int(),
    lastMessageTime: z.string().nullable(),
    version: z.number().int().openapi({
      description:
        "The user's unread version when this space last changed. Every unread payload (WebSocket events, this response, the list) carries one; apply only versions newer than the one held.",
    }),
  }),
);

const SPACE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SpaceParamsSchema = z.object({
  spaceId: z.string().regex(SPACE_ID_RE, 'invalid space id'),
});

const MarkReadBodySchema = z
  .object({
    readThrough: z
      .string()
      .refine(isRfc3339, { message: 'must be an RFC 3339 timestamp with a zone' })
      .optional()
      .openapi({
        description:
          'Create time of the newest message the user has seen (inclusive). Omit to clear every unread message in the space.',
      }),
  })
  .strict();

const PushEnvelopeSchema = z.object({
  message: z
    .object({
      attributes: z.record(z.string(), z.string()).optional(),
      data: z.string().optional(),
      messageId: z.string().optional(),
    })
    .passthrough(),
  subscription: z.string().optional(),
});

const json = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const err = (description: string) => ({ description, content: json(ErrorResponse) });

registerPath({
  method: 'post',
  path: GOOGLE_CHAT_EVENTS_PUSH_PATH,
  tags: ['Google'],
  summary: 'Pub/Sub push intake for Google Workspace Events (Chat messages)',
  description:
    'Called by Google Cloud Pub/Sub, not by clients. Requires the OIDC bearer token Pub/Sub mints for the configured push service account and audience. Events for unknown subscriptions and malformed payloads are acknowledged and dropped.',
  security: [],
  request: { body: { content: json(PushEnvelopeSchema), required: true } },
  responses: {
    204: { description: 'Acknowledged.' },
    401: err('Missing or invalid push token.'),
    503: err('Chat push is not configured.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/google/chat/events/status',
  tags: ['Google'],
  summary: "The calling user's Google Chat push subscription",
  responses: {
    200: { description: 'Push status.', content: json(PushStatusSchema) },
    401: err('Not authenticated.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/google/chat/events/subscription',
  tags: ['Google'],
  summary: 'Create or renew the calling user’s Google Chat push subscription',
  description:
    'Idempotent. Subscribes the user to message created, updated, and deleted events in every Chat space they belong to (Workspace Events API, user auth) and renews it when it is close to expiry. Reads the current state from Google at most once a minute per user (so a missed suspension is found on reconnect), otherwise answers from the stored state.',
  responses: {
    200: {
      description: 'Subscription is active (or its current state).',
      content: json(PushStatusSchema),
    },
    401: err('Not authenticated, or Google not connected / must be reconnected.'),
    403: err('Chat read scope not granted, or Google refused the subscription.'),
    429: err('Google rate limit.'),
    502: err('Google request failed.'),
    503: err('Chat push or Google OAuth is not configured.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/google/chat/unread',
  tags: ['Google'],
  summary: 'Unread Google Chat messages per space for the calling user',
  responses: {
    200: {
      description: 'Spaces with unread messages, most recent first.',
      content: json(
        z.object({
          spaces: z.array(SpaceUnreadSchema),
          total: z.number().int(),
          version: z.number().int().openapi({
            description:
              'Latest unread version for the user. The list reflects every change up to it; spaces absent from it have no unread messages as of this version.',
          }),
        }),
      ),
    },
    401: err('Not authenticated.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/google/chat/spaces/{spaceId}/read',
  tags: ['Google'],
  summary: 'Mark a Google Chat space read for the calling user',
  request: {
    params: SpaceParamsSchema,
    body: { content: json(MarkReadBodySchema), required: false },
  },
  responses: {
    200: { description: 'Remaining unread state for the space.', content: json(SpaceUnreadSchema) },
    400: err('Invalid space id or body.'),
    401: err('Not authenticated.'),
  },
});

const VERIFY_MIN_INTERVAL_MS = 60_000;

export interface GoogleChatEventsRouteOptions {
  verifier?: PushTokenVerifier;
  eventsDeps?: Partial<ChatEventsDeps>;
}

export default function createGoogleChatEventsRoutes(
  deps: RouteDeps,
  opts: GoogleChatEventsRouteOptions = {},
): Router {
  const router = Router();
  const eventsDeps = (): ChatEventsDeps => ({
    config: deps.config,
    broadcast: deps.broadcast,
    ...opts.eventsDeps,
  });

  const callerId = (req: Request, res: Response): string | null => {
    const uid = resolveGoogleConnectionUserId(req, deps.stmts);
    if (!uid)
      res.status(401).json({ error: 'Authentication required', code: 'authentication_required' });
    return uid;
  };

  router.post(GOOGLE_CHAT_EVENTS_PUSH_PATH, async (req: Request, res: Response) => {
    const cfg = deps.config.googleChatEvents;
    if (!cfg) {
      res.status(503).json({
        error: 'Google Chat push is not configured',
        code: 'google_chat_push_not_configured',
      });
      return;
    }
    if (!(await verifyPushToken(req.get('authorization'), cfg, opts.verifier))) {
      res.status(401).json({ error: 'Invalid push token', code: 'invalid_push_token' });
      return;
    }
    const parsed = PushEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      console.warn('[google-chat-events] Dropping malformed push envelope');
      res.status(204).end();
      return;
    }
    try {
      const result = handleChatPushEvent(parsed.data as PubSubPushEnvelope, eventsDeps());
      if (result.ignored && result.ignored !== 'unknown_subscription') {
        console.warn(`[google-chat-events] Dropped push (${result.ignored})`);
      }
    } catch (e) {
      // A failure here is ours (DB), so let Pub/Sub retry.
      console.error(`[google-chat-events] Push handling failed: ${errorMessage(e)}`);
      res.status(500).json({ error: 'Push handling failed' });
      return;
    }
    res.status(204).end();
  });

  router.get('/api/google/chat/events/status', (req: Request, res: Response) => {
    const uid = callerId(req, res);
    if (!uid) return;
    res.json({
      configured: !!deps.config.googleChatEvents,
      subscription: publicSubscription(getChatSubscription(uid)),
      version: currentChatSeq(uid),
    });
  });

  router.post('/api/google/chat/events/subscription', async (req: Request, res: Response) => {
    const uid = requireChatAccess(
      req,
      res,
      deps,
      hasChatMessagesReadScope,
      [CHAT_MESSAGES_READONLY_SCOPE],
      'google_chat_scope_required',
    );
    if (!uid) return;
    if (!deps.config.googleChatEvents) {
      res.json({ configured: false, subscription: null, version: currentChatSeq(uid) });
      return;
    }
    try {
      // Clients call this on load and on reconnect, when an event (such as a
      // suspension) may have been missed: check Google, at most once a
      // minute per user.
      const sub = await ensureChatSubscription(uid, eventsDeps(), {
        verify: { maxAgeMs: VERIFY_MIN_INTERVAL_MS },
      });
      res.json({ configured: true, subscription: publicSubscription(sub), version: sub.version });
    } catch (e) {
      if (e instanceof ChatEventsNotConfiguredError) {
        res.json({ configured: false, subscription: null, version: currentChatSeq(uid) });
        return;
      }
      if (e instanceof ChatEventsAccessLostError) {
        res.status(403).json({
          error: e.message,
          code: e.code,
          requiredScopes: [CHAT_MESSAGES_READONLY_SCOPE],
        });
        return;
      }
      if (e instanceof ChatEventsTokenError) {
        res.status(401).json({ error: e.message, code: e.code });
        return;
      }
      const msg = errorMessage(e);
      if (/workspaceevents\.googleapis\.com|Workspace Events API/i.test(msg)) {
        res.status(403).json({
          error:
            "The Google Workspace Events API is turned off for this Hub's Google Cloud project. A Hub admin must enable it (APIs & Services → Library → Google Workspace Events API).",
          code: 'google_chat_events_api_disabled',
        });
        return;
      }
      sendGoogleError(res, e);
    }
  });

  router.get('/api/google/chat/unread', (req: Request, res: Response) => {
    const uid = callerId(req, res);
    if (!uid) return;
    const { spaces, version } = getUnreadSnapshot(uid);
    res.json({ spaces, total: spaces.reduce((n, s) => n + s.count, 0), version });
  });

  router.post('/api/google/chat/spaces/:spaceId/read', (req: Request, res: Response) => {
    const params = SpaceParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'invalid space id', code: 'invalid_request' });
      return;
    }
    const body = MarkReadBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({
        error: body.error.issues[0]?.message ?? 'invalid body',
        code: 'invalid_request',
      });
      return;
    }
    const uid = callerId(req, res);
    if (!uid) return;
    const spaceName = `spaces/${params.data.spaceId}`;
    const unread = markSpaceRead({ userId: uid, spaceName, readThrough: body.data.readThrough });
    // Other tabs and devices of the same user clear their badges too.
    emitUnread(deps, uid, unread);
    res.json(unread);
  });

  return router;
}
