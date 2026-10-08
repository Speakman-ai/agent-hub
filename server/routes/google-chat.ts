import { Router, Request, Response } from 'express';
import { google, type chat_v1 } from 'googleapis';
import type { RouteDeps } from '../types.js';
import {
  getActiveAccessToken,
  getGoogleConnection,
  getGoogleConnectionStatus,
} from '../google-connections-store.js';
import { resolveChatParticipants } from '../google-chat-participants.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import {
  CHAT_MESSAGES_CREATE_SCOPE,
  CHAT_MESSAGES_READONLY_SCOPE,
  CHAT_SPACES_READONLY_SCOPE,
  hasChatMessagesCreateScope,
  hasChatMembershipsReadScope,
  hasChatMessagesReadScope,
  hasChatSpacesReadScope,
} from '../google-scopes.js';
import { registerComponent, registerPath, z } from '../openapi/registry.js';
import { compareRfc3339, isRfc3339, shiftRfc3339 } from '../../shared/utils/rfc3339.js';

/**
 * Google Chat proxy routes, scoped to the calling user's linked Google
 * connection. Same contract as the Gmail proxy: the handler resolves the
 * caller, fetches a fresh access token server-side, calls the Chat API with
 * user authentication, and returns shaped JSON. Tokens never leave the server.
 *
 * The Chat API only serves Google Workspace accounts, and the OAuth client's
 * Cloud project must have the Chat API enabled with a Chat app configured,
 * even for user-auth calls. Upstream rejections for either case surface as the
 * mapped 403/400 codes below.
 *
 * Scopes (https://developers.google.com/workspace/chat/authenticate-authorize):
 *   - listing spaces gates on `chat.spaces.readonly` (sensitive);
 *   - reading messages gates on `chat.messages.readonly` (restricted);
 *   - posting gates on `chat.messages.create` (sensitive).
 */

const ErrorResponse = registerComponent(
  'GoogleChatErrorResponse',
  z.object({
    error: z.string(),
    code: z.string().optional(),
    requiredScopes: z.array(z.string()).optional(),
  }),
);

const ChatUserSchema = registerComponent(
  'GoogleChatUser',
  z.object({
    name: z.string().nullable(),
    displayName: z.string().nullable(),
    type: z.string().nullable(),
  }),
);

const ChatSpaceSchema = registerComponent(
  'GoogleChatSpace',
  z.object({
    name: z.string().nullable(),
    id: z.string().nullable(),
    displayName: z.string().nullable(),
    spaceType: z.string().nullable(),
    singleUserBotDm: z.boolean(),
    spaceThreadingState: z.string().nullable(),
    supportsThreadReplies: z.boolean().openapi({
      description:
        'True only for named spaces with threaded (or topic-grouped) messages. DMs, group chats, and unthreaded spaces cannot take in-thread replies; a threadName sent to them is ignored.',
    }),
    lastActiveTime: z.string().nullable(),
    spaceUri: z.string().nullable(),
    participants: z.array(z.string()).nullable().openapi({
      description:
        'For DMs and group chats without a display name: the other human members, by name, excluding the caller. Null when not resolved (no chat.memberships.readonly grant, lookup budget reached, or lookup failed).',
    }),
  }),
);

const ChatMessageSchema = registerComponent(
  'GoogleChatMessage',
  z.object({
    name: z.string().nullable(),
    id: z.string().nullable(),
    spaceName: z.string().nullable(),
    threadName: z.string().nullable(),
    threadReply: z.boolean(),
    text: z.string().nullable(),
    createTime: z.string().nullable(),
    lastUpdateTime: z.string().nullable(),
    deleted: z.boolean(),
    attachmentCount: z.number(),
    sender: ChatUserSchema.nullable(),
  }),
);

// Membership pages for participant names: the API maximum, and enough pages
// for any DM or group chat. Past the cap the names are returned uncached.
const MEMBER_PAGE = 1000;
const MAX_MEMBER_PAGES = 10;

// Space ids are system-assigned (e.g. `AAAAAAAAAAA`). Restricting the alphabet
// keeps a caller from smuggling `/` or `..` into the `spaces/{id}` resource name.
const SPACE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const THREAD_NAME_RE = /^spaces\/([A-Za-z0-9_-]{1,128})\/threads\/[A-Za-z0-9_.-]{1,256}$/;

const SpaceParamsSchema = z.object({
  spaceId: z.string().regex(SPACE_ID_RE, 'invalid space id'),
});

const ListSpacesQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(1000).optional(),
  pageToken: z.string().optional(),
});

const rfc3339Param = z.string().refine(isRfc3339, {
  message: 'must be an RFC 3339 timestamp with a zone, e.g. 2026-10-08T10:00:00.123456Z',
});

const ListMessagesQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(1000).optional(),
  pageToken: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional().openapi({
    description: 'Sort by create time. Defaults to `desc` (newest first).',
  }),
  threadName: z.string().regex(THREAD_NAME_RE, 'invalid thread name').optional().openapi({
    description: 'Restrict to one thread, formatted `spaces/{space}/threads/{thread}`.',
  }),
  since: rfc3339Param.optional().openapi({
    description:
      'Only messages created at or after this RFC 3339 time (inclusive, full precision). Used to re-read a loaded range so edits and deletions are picked up.',
  }),
  until: rfc3339Param.optional().openapi({
    description:
      'Only messages created at or before this RFC 3339 time (inclusive, full precision). Anchors an older-history query; continue it with pageToken and unchanged parameters so messages sharing the boundary timestamp are not skipped.',
  }),
});

/**
 * Build the Chat API `filter` for a message list. Google only supports strict
 * `>` and `<` on createTime, so inclusive bounds are widened by exactly one
 * nanosecond. Timestamps never pass through Date, which would round Chat's
 * sub-millisecond createTime values and move the boundary.
 */
export function buildMessagesFilter(opts: {
  threadName?: string;
  since?: string;
  until?: string;
}): string | undefined {
  const parts: string[] = [];
  if (opts.since) parts.push(`createTime > "${shiftRfc3339(opts.since, -1n)}"`);
  if (opts.until) parts.push(`createTime < "${shiftRfc3339(opts.until, 1n)}"`);
  if (opts.threadName) parts.push(`thread.name = ${opts.threadName}`);
  return parts.length ? parts.join(' AND ') : undefined;
}

const SendMessageBodySchema = z
  .object({
    text: z.string().trim().min(1).max(4096),
    threadName: z.string().regex(THREAD_NAME_RE, 'invalid thread name').optional().openapi({
      description:
        'Reply in this thread (`spaces/{space}/threads/{thread}`). Honored only when the space supports thread replies (see GoogleChatSpace.supportsThreadReplies); otherwise the message is sent as an ordinary message. Requires the spaces read scope.',
    }),
  })
  .strict();

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const commonErrors = {
  401: errorResponse('Not authenticated or Google not connected.'),
  429: errorResponse('Google Chat rate limit exceeded.'),
  502: errorResponse('Google Chat request failed.'),
  503: errorResponse('Google OAuth is not configured.'),
};

registerPath({
  method: 'get',
  path: '/api/google/chat/spaces',
  tags: ['Google'],
  summary: 'List Google Chat spaces, group chats, and DMs the calling user belongs to',
  request: { query: ListSpacesQuerySchema },
  responses: {
    200: {
      description: 'Spaces, most recently active first.',
      content: jsonContent(
        z.object({
          spaces: z.array(ChatSpaceSchema),
          nextPageToken: z.string().nullable(),
        }),
      ),
    },
    400: errorResponse('Invalid query.'),
    403: errorResponse('Required Chat scope has not been granted, or Chat API access was denied.'),
    ...commonErrors,
  },
});

registerPath({
  method: 'get',
  path: '/api/google/chat/spaces/{spaceId}/messages',
  tags: ['Google'],
  summary: 'List messages in a Google Chat space for the calling user',
  request: { params: SpaceParamsSchema, query: ListMessagesQuerySchema },
  responses: {
    200: {
      description: 'Shaped messages in the requested order.',
      content: jsonContent(
        z.object({
          messages: z.array(ChatMessageSchema),
          nextPageToken: z.string().nullable(),
        }),
      ),
    },
    400: errorResponse('Invalid space id or query.'),
    403: errorResponse('Required Chat scope has not been granted, or Chat API access was denied.'),
    404: errorResponse('Space not found.'),
    ...commonErrors,
  },
});

registerPath({
  method: 'post',
  path: '/api/google/chat/spaces/{spaceId}/messages',
  tags: ['Google'],
  summary: 'Post a Google Chat message (optionally as a thread reply) as the calling user',
  request: {
    params: SpaceParamsSchema,
    body: { content: jsonContent(SendMessageBodySchema), required: true },
  },
  responses: {
    201: { description: 'The created message.', content: jsonContent(ChatMessageSchema) },
    400: errorResponse('Invalid body or space id.'),
    403: errorResponse('Required Chat send scope has not been granted.'),
    404: errorResponse('Space not found.'),
    ...commonErrors,
  },
});

interface GoogleErrorShape {
  response?: {
    status?: number;
    data?: {
      error?: string | { message?: string; status?: string; errors?: Array<{ reason?: string }> };
      message?: string;
    };
  };
  code?: number | string;
  message?: string;
}

function bad(res: Response, status: number, error: string, code?: string, extra = {}): void {
  res.status(status).json({ error, ...(code && { code }), ...extra });
}

function requireChatAccess(
  req: Request,
  res: Response,
  deps: RouteDeps,
  check: (scopes: string[]) => boolean,
  requiredScopes: string[],
  scopeCode: string,
): string | null {
  const uid = resolveGoogleConnectionUserId(req, deps.stmts);
  if (!uid) {
    bad(res, 401, 'Authentication required', 'authentication_required');
    return null;
  }
  if (!deps.config.googleOAuth?.clientId || !deps.config.googleOAuth?.clientSecret) {
    bad(res, 503, 'Google OAuth is not configured on this server', 'google_oauth_not_configured');
    return null;
  }
  const status = getGoogleConnectionStatus(uid);
  if (!status.connected) {
    bad(res, 401, 'Google account is not connected', 'google_not_connected');
    return null;
  }
  if (!check(status.grantedScopes)) {
    bad(res, 403, 'Required Google Chat access has not been granted', scopeCode, {
      requiredScopes,
    });
    return null;
  }
  return uid;
}

async function resolveChatToken(
  userId: string,
  deps: RouteDeps,
  res: Response,
): Promise<string | null> {
  let token: string | null;
  try {
    token = await getActiveAccessToken(userId, deps.config.googleOAuth ?? null);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[google-chat] Failed to resolve token for user ${userId}: ${msg}`);
    bad(res, 502, 'Failed to resolve Google access token', 'google_token_resolution_failed');
    return null;
  }
  if (!token) {
    bad(res, 401, 'Google account must be reconnected', 'google_reconnect_required');
    return null;
  }
  return token;
}

function createChatClient(accessToken: string): chat_v1.Chat {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.chat({ version: 'v1', auth });
}

/**
 * Whether a conversation accepts in-thread replies. Google documents
 * messageReplyOption as "only supported in named spaces", and only spaces
 * whose threading state is THREADED_MESSAGES (or the topic-based
 * GROUPED_MESSAGES) keep replies in a thread.
 * https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces
 */
export function supportsThreadReplies(space: chat_v1.Schema$Space): boolean {
  return (
    space.spaceType === 'SPACE' &&
    (space.spaceThreadingState === 'THREADED_MESSAGES' ||
      space.spaceThreadingState === 'GROUPED_MESSAGES')
  );
}

function lastSegment(name: string | null | undefined): string | null {
  if (!name) return null;
  const idx = name.lastIndexOf('/');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

export function shapeSpace(space: chat_v1.Schema$Space): z.infer<typeof ChatSpaceSchema> {
  return {
    name: space.name ?? null,
    id: lastSegment(space.name),
    displayName: space.displayName || null,
    spaceType: space.spaceType ?? null,
    singleUserBotDm: space.singleUserBotDm === true,
    spaceThreadingState: space.spaceThreadingState ?? null,
    supportsThreadReplies: supportsThreadReplies(space),
    lastActiveTime: space.lastActiveTime ?? null,
    spaceUri: space.spaceUri ?? null,
    participants: null,
  };
}

/** DMs and group chats with no display name need participants to be told apart. */
function needsParticipants(space: z.infer<typeof ChatSpaceSchema>): boolean {
  return (
    !space.displayName &&
    !!space.name &&
    (space.spaceType === 'DIRECT_MESSAGE' || space.spaceType === 'GROUP_CHAT')
  );
}

export function shapeMessage(message: chat_v1.Schema$Message): z.infer<typeof ChatMessageSchema> {
  const sender = message.sender
    ? {
        name: message.sender.name ?? null,
        displayName: message.sender.displayName || null,
        type: message.sender.type ?? null,
      }
    : null;
  return {
    name: message.name ?? null,
    id: lastSegment(message.name),
    spaceName: message.space?.name ?? null,
    threadName: message.thread?.name ?? null,
    threadReply: message.threadReply === true,
    // Deleted messages carry no content; never surface a stale copy.
    text: message.deleteTime ? null : (message.text ?? message.fallbackText ?? null),
    createTime: message.createTime ?? null,
    lastUpdateTime: message.lastUpdateTime ?? null,
    deleted: !!message.deleteTime,
    attachmentCount: message.attachment?.length ?? 0,
    sender,
  };
}

/** Most recently active first; spaces without activity sink to the bottom. */
export function sortSpacesByActivity<T extends { lastActiveTime: string | null }>(
  spaces: T[],
): T[] {
  return [...spaces].sort((a, b) => compareRfc3339(b.lastActiveTime, a.lastActiveTime));
}

function extractGoogleError(err: unknown): { status: number; error: string; code: string } {
  const e = err as GoogleErrorShape;
  const rawStatus =
    typeof e.response?.status === 'number'
      ? e.response.status
      : typeof e.code === 'number'
        ? e.code
        : Number.parseInt(String(e.code ?? ''), 10);
  const status = Number.isFinite(rawStatus) ? rawStatus : 502;
  const dataError = e.response?.data?.error;
  const nestedMessage = typeof dataError === 'object' ? dataError.message : undefined;
  const message =
    nestedMessage ||
    e.response?.data?.message ||
    (typeof dataError === 'string' ? dataError : undefined) ||
    e.message ||
    'Google Chat request failed';
  const firstLine = message.split('\n')[0];

  if (status === 401) {
    return {
      status: 401,
      code: 'google_chat_auth_failed',
      error: 'Google Chat authorization failed. Reconnect Google in Account settings.',
    };
  }
  if (status === 403) {
    if (/rate.?limit|quota/i.test(message)) {
      return {
        status: 429,
        code: 'google_chat_rate_limited',
        error: 'Google Chat rate limit exceeded',
      };
    }
    // Google's own text explains the common causes (Chat API not enabled,
    // no Chat app configured, consumer account), so pass it through.
    return { status: 403, code: 'google_chat_forbidden', error: firstLine };
  }
  if (status === 404) {
    return {
      status: 404,
      code: 'google_chat_not_found',
      error: 'Google Chat resource was not found',
    };
  }
  if (status === 429) {
    return {
      status: 429,
      code: 'google_chat_rate_limited',
      error: 'Google Chat rate limit exceeded',
    };
  }
  if (status >= 400 && status < 500) {
    return { status, code: 'google_chat_bad_request', error: firstLine };
  }
  return { status: 502, code: 'google_chat_upstream_failed', error: firstLine };
}

function sendGoogleError(res: Response, err: unknown): Response {
  const mapped = extractGoogleError(err);
  return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
}

export default function createGoogleChatRoutes(deps: RouteDeps): Router {
  const router = Router();

  router.get('/api/google/chat/spaces', async (req: Request, res: Response) => {
    const parsed = ListSpacesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return bad(res, 400, parsed.error.issues[0]?.message || 'Invalid query', 'invalid_request');
    }
    const uid = requireChatAccess(
      req,
      res,
      deps,
      hasChatSpacesReadScope,
      [CHAT_SPACES_READONLY_SCOPE],
      'google_chat_scope_required',
    );
    if (!uid) return;
    const token = await resolveChatToken(uid, deps, res);
    if (!token) return;

    try {
      const chat = createChatClient(token);
      const result = await chat.spaces.list({
        pageSize: parsed.data.pageSize ?? 200,
        pageToken: parsed.data.pageToken,
      });
      const spaces = sortSpacesByActivity((result.data.spaces ?? []).map(shapeSpace));
      const status = getGoogleConnectionStatus(uid);
      const unnamed = spaces.filter(needsParticipants);
      if (unnamed.length && hasChatMembershipsReadScope(status.grantedScopes)) {
        const sub = getGoogleConnection(uid)?.googleSub;
        const resolved = await resolveChatParticipants({
          userId: uid,
          // Chat user ids are the Google account id, i.e. the OIDC `sub`.
          selfUserName: sub ? `users/${sub}` : null,
          spaceNames: unnamed.map((s) => s.name as string),
          listMembers: async (spaceName) => {
            // Follow every page with unchanged parameters: a partial member
            // list would undercount "+N" labels and hide people from search.
            const members: chat_v1.Schema$Membership[] = [];
            let pageToken: string | undefined;
            for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
              const { data } = await chat.spaces.members.list({
                parent: spaceName,
                pageSize: MEMBER_PAGE,
                filter: 'member.type = "HUMAN"',
                ...(pageToken ? { pageToken } : {}),
              });
              members.push(...(data.memberships ?? []));
              pageToken = data.nextPageToken || undefined;
              if (!pageToken) return { members, complete: true };
            }
            return { members, complete: false };
          },
        });
        for (const space of unnamed)
          space.participants = resolved.get(space.name as string) ?? null;
      }
      return res.json({ spaces, nextPageToken: result.data.nextPageToken || null });
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  router.get('/api/google/chat/spaces/:spaceId/messages', async (req: Request, res: Response) => {
    const params = SpaceParamsSchema.safeParse(req.params);
    if (!params.success) {
      return bad(
        res,
        400,
        params.error.issues[0]?.message || 'Invalid space id',
        'invalid_request',
      );
    }
    const query = ListMessagesQuerySchema.safeParse(req.query);
    if (!query.success) {
      return bad(res, 400, query.error.issues[0]?.message || 'Invalid query', 'invalid_request');
    }
    const spaceId = params.data.spaceId;
    const threadName = query.data.threadName;
    if (threadName && THREAD_NAME_RE.exec(threadName)?.[1] !== spaceId) {
      return bad(res, 400, 'threadName must belong to the requested space', 'invalid_request');
    }
    const uid = requireChatAccess(
      req,
      res,
      deps,
      hasChatMessagesReadScope,
      [CHAT_MESSAGES_READONLY_SCOPE],
      'google_chat_scope_required',
    );
    if (!uid) return;
    const token = await resolveChatToken(uid, deps, res);
    if (!token) return;

    try {
      const chat = createChatClient(token);
      const filter = buildMessagesFilter({
        threadName,
        since: query.data.since,
        until: query.data.until,
      });
      const result = await chat.spaces.messages.list({
        parent: `spaces/${spaceId}`,
        pageSize: query.data.pageSize ?? 50,
        pageToken: query.data.pageToken,
        orderBy: query.data.order === 'asc' ? 'createTime asc' : 'createTime desc',
        // Deleted messages come back as tombstones (deleteTime set, no content),
        // so a client re-reading a range can tell "deleted" from "unchanged".
        showDeleted: true,
        ...(filter ? { filter } : {}),
      });
      return res.json({
        messages: (result.data.messages ?? []).map(shapeMessage),
        nextPageToken: result.data.nextPageToken || null,
      });
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  router.post('/api/google/chat/spaces/:spaceId/messages', async (req: Request, res: Response) => {
    const params = SpaceParamsSchema.safeParse(req.params);
    if (!params.success) {
      return bad(
        res,
        400,
        params.error.issues[0]?.message || 'Invalid space id',
        'invalid_request',
      );
    }
    const body = SendMessageBodySchema.safeParse(req.body);
    if (!body.success) {
      return bad(res, 400, body.error.issues[0]?.message || 'Invalid body', 'invalid_request');
    }
    const spaceId = params.data.spaceId;
    const threadName = body.data.threadName;
    if (threadName && THREAD_NAME_RE.exec(threadName)?.[1] !== spaceId) {
      return bad(res, 400, 'threadName must belong to the requested space', 'invalid_request');
    }
    const uid = requireChatAccess(
      req,
      res,
      deps,
      hasChatMessagesCreateScope,
      [CHAT_MESSAGES_CREATE_SCOPE],
      'google_chat_send_scope_required',
    );
    if (!uid) return;
    // A thread reply depends on the conversation's capabilities, which need the
    // space itself. Plain sends never read the space.
    if (threadName && !hasChatSpacesReadScope(getGoogleConnectionStatus(uid).grantedScopes)) {
      return bad(
        res,
        403,
        'Replying in a thread needs access to read the space',
        'google_chat_scope_required',
        { requiredScopes: [CHAT_SPACES_READONLY_SCOPE] },
      );
    }
    const token = await resolveChatToken(uid, deps, res);
    if (!token) return;

    try {
      const chat = createChatClient(token);
      let replyThread: string | null = null;
      if (threadName) {
        const space = await chat.spaces.get({ name: `spaces/${spaceId}` });
        // DMs, group chats, and unthreaded spaces don't support reply options;
        // send those as an ordinary message instead of taking the unsupported path.
        if (supportsThreadReplies(space.data)) replyThread = threadName;
      }
      const result = await chat.spaces.messages.create({
        parent: `spaces/${spaceId}`,
        ...(replyThread ? { messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' } : {}),
        requestBody: {
          text: body.data.text,
          ...(replyThread ? { thread: { name: replyThread } } : {}),
        },
      });
      return res.status(201).json(shapeMessage(result.data));
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  return router;
}
