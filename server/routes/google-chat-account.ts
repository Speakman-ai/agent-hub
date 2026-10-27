/**
 * GET/PUT /api/google/chat/account — which linked Google account the caller's
 * Google Chat runs as (see `google-chat-account.ts`).
 *
 * Switching commits the new binding and discards agent replies still
 * awaiting approval in one transaction (`rebind` in google-chat-account.ts),
 * then deletes the old account's push subscription at Google and clears its
 * unread state.
 */
import { Router, type Request, type Response } from 'express';
import type { RouteDeps } from '../types.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import { getActiveAccessToken, listGoogleConnections } from '../google-connections-store.js';
import {
  getChatAccountBinding,
  isWorkspaceAccount,
  setChatAccount,
} from '../google-chat-account.js';
import { hasChatMessagesCreateScope, hasChatMessagesReadScope } from '../google-scopes.js';
import { teardownChatSubscription, type ChatEventsDeps } from '../google-chat-events.js';
import { broadcastDraft } from './google-chat.js';
import { registerComponent, registerPath, z } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'GoogleChatAccountErrorResponse',
  z.object({ error: z.string(), code: z.string() }),
);

const ChatAccountCandidateSchema = z.object({
  accountId: z.string(),
  email: z.string(),
  isDefault: z.boolean(),
  workspace: z.boolean().openapi({
    description:
      'Google Chat only serves Google Workspace accounts; personal accounts cannot be picked.',
  }),
  hasChatScope: z.boolean().openapi({ description: 'Chat access was granted to this account.' }),
});

const ChatAccountStateSchema = registerComponent(
  'GoogleChatAccountState',
  z.object({
    account: z
      .object({ accountId: z.string(), email: z.string() })
      .nullable()
      .openapi({ description: 'The linked account Chat runs as; null when none is usable.' }),
    boundEmail: z.string().nullable().openapi({
      description:
        'Email of the account Chat is set to, even when it is no longer linked (then `account` is null). Null when Chat was never set up.',
    }),
    candidates: z.array(ChatAccountCandidateSchema),
  }),
);

export const SetChatAccountBody = z
  .object({ accountId: z.string().trim().min(1).max(200) })
  .strict();

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponse } },
});

const stateResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ChatAccountStateSchema } },
});

registerPath({
  method: 'get',
  path: '/api/google/chat/account',
  tags: ['Google Chat'],
  summary: 'Get the Google account Google Chat runs as',
  description:
    'Chat is single-account: one linked Workspace account is used for the Chat pane, push notifications, agent reply drafts, and project chat triggers. Lists the linked accounts that could be picked.',
  responses: {
    200: stateResponse('The Chat account and the candidates.'),
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/google/chat/account',
  tags: ['Google Chat'],
  summary: 'Choose the Google account Google Chat runs as',
  description:
    "Moves Chat to another linked Workspace account. The old account's push subscription is removed and its unread state cleared; agent replies waiting for approval are discarded.",
  request: { body: { content: { 'application/json': { schema: SetChatAccountBody } } } },
  responses: {
    200: stateResponse('Chat now runs as the chosen account.'),
    400: errorResponse('Invalid body, or the account is not a Google Workspace account.'),
    401: errorResponse('Authentication required.'),
    404: errorResponse('The account is not linked.'),
  },
});

function bad(res: Response, status: number, error: string, code: string): void {
  res.status(status).json({ error, code });
}

export function chatAccountState(userId: string) {
  const { account, boundEmail } = getChatAccountBinding(userId);
  return {
    account: account ? { accountId: account.accountId, email: account.googleEmail } : null,
    boundEmail,
    candidates: listGoogleConnections(userId).map((c) => ({
      accountId: c.accountId,
      email: c.googleEmail,
      isDefault: c.isDefault,
      workspace: isWorkspaceAccount(c),
      hasChatScope:
        hasChatMessagesReadScope(c.grantedScopes) || hasChatMessagesCreateScope(c.grantedScopes),
    })),
  };
}

export interface GoogleChatAccountRouteOptions {
  eventsDeps?: Partial<ChatEventsDeps>;
}

export default function createGoogleChatAccountRoutes(
  deps: RouteDeps,
  opts: GoogleChatAccountRouteOptions = {},
): Router {
  const router = Router();

  router.get('/api/google/chat/account', (req: Request, res: Response) => {
    const uid = resolveGoogleConnectionUserId(req, deps.stmts);
    if (!uid) return bad(res, 401, 'Authentication required', 'authentication_required');
    res.json(chatAccountState(uid));
  });

  router.put('/api/google/chat/account', async (req: Request, res: Response) => {
    const parsed = SetChatAccountBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, 400, parsed.error.issues[0]?.message || 'Invalid body', 'invalid_request');
    }
    const uid = resolveGoogleConnectionUserId(req, deps.stmts);
    if (!uid) return bad(res, 401, 'Authentication required', 'authentication_required');

    const result = setChatAccount(uid, parsed.data.accountId);
    if (!result.ok) {
      return result.code === 'google_account_not_found'
        ? bad(res, 404, 'Google account not found', result.code)
        : bad(
            res,
            400,
            'Google Chat only works with Google Workspace accounts. Pick a work account.',
            result.code,
          );
    }

    // The switch and the discard of old held replies committed together; tell
    // clients now, before the slower Google teardown.
    for (const draft of result.discarded) broadcastDraft(deps, draft);

    if (result.changed) {
      let previousToken: string | null = null;
      if (result.previous) {
        try {
          previousToken = await getActiveAccessToken(uid, deps.config.googleOAuth ?? null, {
            account: { accountId: result.previous.accountId },
          });
        } catch {
          previousToken = null;
        }
      }
      await teardownChatSubscription(
        uid,
        { config: deps.config, broadcast: deps.broadcast, ...opts.eventsDeps },
        previousToken,
      );
    }
    res.json(chatAccountState(uid));
  });

  return router;
}
