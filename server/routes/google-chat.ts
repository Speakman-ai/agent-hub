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
  createChatMessageLink,
  listChatMessageLinks,
  recordSessionChatPost,
  sessionExists,
} from '../google-chat-message-links-store.js';
import { AGENT_HUB_SESSION_ID_HEADER } from '../kanban-caller-session.js';
import type { AuthenticatedRequest } from '../auth.js';
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
    helpUrl: z.string().optional().openapi({
      description:
        'Where to fix a setup problem (Cloud console page or Google sign-in), for the setup error codes google_chat_workspace_required, google_chat_api_disabled, and google_chat_app_not_configured.',
    }),
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

const MESSAGE_NAME_RE = /^spaces\/([A-Za-z0-9_-]{1,128})\/messages\/[A-Za-z0-9_.-]{1,256}$/;

const ChatMessageLinkSchema = registerComponent(
  'GoogleChatMessageLink',
  z.object({
    id: z.string(),
    messageName: z.string(),
    spaceName: z.string(),
    threadName: z.string().nullable().openapi({
      description:
        'Set only when the space keeps replies in threads; the link is marked replied when its session posts in this thread. Null links are marked by any post from the session into the space.',
    }),
    sessionId: z.string(),
    sessionName: z.string().nullable(),
    agentId: z.string().nullable(),
    userId: z.string().nullable().openapi({ description: 'Hub user who sent it to the agent.' }),
    createdAt: z.string(),
    repliedAt: z.string().nullable().openapi({
      description: 'When the session first posted back through the Chat proxy, else null.',
    }),
    replyMessageName: z.string().nullable(),
  }),
);

const CreateMessageLinkBodySchema = z
  .object({
    messageName: z.string().regex(MESSAGE_NAME_RE, 'invalid message name').openapi({
      description: 'Chat message resource name, `spaces/{space}/messages/{message}`.',
    }),
    threadName: z.string().regex(THREAD_NAME_RE, 'invalid thread name').nullable().optional(),
    sessionId: z.string().trim().min(1).max(128),
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

registerPath({
  method: 'get',
  path: '/api/google/chat/spaces/{spaceId}/message-links',
  tags: ['Google'],
  summary: 'List which messages in a Google Chat space were sent to an agent session',
  description:
    'Links from every Hub user are returned, so an operator can see a message another operator already handed to an agent. The caller must be able to read the space through their own Google account.',
  request: { params: SpaceParamsSchema },
  responses: {
    200: {
      description: 'Links for the space, oldest first.',
      content: jsonContent(z.object({ links: z.array(ChatMessageLinkSchema) })),
    },
    400: errorResponse('Invalid space id.'),
    403: errorResponse(
      'Required Chat read scope has not been granted, or the caller cannot read the space.',
    ),
    404: errorResponse('Space not found for the caller.'),
    ...commonErrors,
  },
});

registerPath({
  method: 'post',
  path: '/api/google/chat/spaces/{spaceId}/message-links',
  tags: ['Google'],
  summary: 'Record that a Google Chat message was sent to an agent session',
  request: {
    params: SpaceParamsSchema,
    body: { content: jsonContent(CreateMessageLinkBodySchema), required: true },
  },
  responses: {
    200: {
      description: 'The message was already linked to this session; nothing changed.',
      content: jsonContent(
        z.object({ link: ChatMessageLinkSchema, existing: z.array(ChatMessageLinkSchema) }),
      ),
    },
    201: {
      description:
        'The link was created. `existing` lists links to other sessions that were already on the message.',
      content: jsonContent(
        z.object({ link: ChatMessageLinkSchema, existing: z.array(ChatMessageLinkSchema) }),
      ),
    },
    400: errorResponse('Invalid body or space id, or the message is not in the space.'),
    403: errorResponse(
      'Required Chat read scope has not been granted, or the caller cannot read the message.',
    ),
    404: errorResponse('Session not found, or message not found for the caller.'),
    ...commonErrors,
  },
});

interface GoogleErrorDetail {
  '@type'?: string;
  reason?: string;
  metadata?: Record<string, string>;
}

interface GoogleErrorShape {
  response?: {
    status?: number;
    data?: {
      error?:
        | string
        | {
            message?: string;
            status?: string;
            errors?: Array<{ reason?: string }>;
            details?: GoogleErrorDetail[];
          };
      message?: string;
    };
  };
  errors?: Array<{ reason?: string }>;
  code?: number | string;
  message?: string;
}

interface MappedChatError {
  status: number;
  error: string;
  code: string;
  helpUrl?: string;
}

const CHAT_API_LIBRARY_URL = 'https://console.cloud.google.com/apis/library/chat.googleapis.com';
const CHAT_APP_CONFIG_URL =
  'https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat';
const WORKSPACE_HELP_URL = 'https://support.google.com/chat/answer/7655820';

/**
 * Recognize the three setup failures a Chat call hits before any data is
 * involved, and replace Google's text with copy that says who fixes it and
 * where. Google reports them inconsistently:
 *   - personal account: "Google Chat API is only available to Google Workspace users";
 *   - API off in the OAuth client's project: 403 with reason SERVICE_DISABLED
 *     (ErrorInfo detail) or accessNotConfigured (legacy `errors[]`), text
 *     "... has not been used in project N before or it is disabled";
 *   - API on but no Chat app configured: 404 "Google Chat app not found. To
 *     create a Chat app, you must turn on the Chat API and configure the app
 *     in the Google Cloud console." (a plain 404 would read as a missing space).
 * https://developers.google.com/workspace/chat/troubleshoot-chat-apps
 */
export function classifyChatSetupError(err: unknown, message: string): MappedChatError | null {
  const e = err as GoogleErrorShape;
  const dataError = e.response?.data?.error;
  const details = typeof dataError === 'object' ? (dataError.details ?? []) : [];
  const reasons = [
    ...details.map((d) => d.reason),
    ...(typeof dataError === 'object' ? (dataError.errors ?? []).map((r) => r.reason) : []),
    ...(e.errors ?? []).map((r) => r.reason),
  ].filter((r): r is string => !!r);

  if (/only available to Google Workspace|Workspace users|consumer account/i.test(message)) {
    return {
      status: 403,
      code: 'google_chat_workspace_required',
      error:
        'Google Chat only works with Google Workspace accounts, and the connected Google account is a personal one. Reconnect with a work account in Settings → Account → Google.',
      helpUrl: WORKSPACE_HELP_URL,
    };
  }
  if (/Chat app not found/i.test(message)) {
    return {
      status: 403,
      code: 'google_chat_app_not_configured',
      error:
        "The Google Chat API is on, but no Chat app is configured for this Hub's Google Cloud project. A Hub admin must open the Chat API Configuration page and save an app name, avatar URL, and description.",
      helpUrl: CHAT_APP_CONFIG_URL,
    };
  }
  if (
    reasons.some((r) => r === 'SERVICE_DISABLED' || r === 'accessNotConfigured') ||
    /has not been used in project|API has not been enabled|chat\.googleapis\.com[^\n]*disabled/i.test(
      message,
    )
  ) {
    const activation = details.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl;
    return {
      status: 403,
      code: 'google_chat_api_disabled',
      error:
        "The Google Chat API is turned off for this Hub's Google Cloud project. A Hub admin must enable it (APIs & Services → Library → Google Chat API) and configure a Chat app.",
      helpUrl:
        activation && /^https:\/\/console\.(cloud|developers)\.google\.com\//.test(activation)
          ? activation
          : CHAT_API_LIBRARY_URL,
    };
  }
  return null;
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

/**
 * The Hub session a proxy call acts for, with the same precedence as
 * `resolveGoogleConnectionUserId`: the server-bound spawn key wins over the
 * raw header, so a spawn can't claim another session's links.
 */
function actingSessionId(req: Request): string | null {
  const authed = req as AuthenticatedRequest;
  const bound = authed.authSpawnSessionId?.trim();
  if (bound) return bound;
  const header = req.get(AGENT_HUB_SESSION_ID_HEADER)?.trim();
  return header || null;
}

// Links are shared across Hub users, so each read proves the caller can read
// the space through Google first. A confirmed (user, space) pair is trusted
// for a few minutes so the pane's 30s poll doesn't double its Chat API reads.
const SPACE_ACCESS_TTL_MS = 5 * 60 * 1000;
const MAX_SPACE_ACCESS_ENTRIES = 5000;
const spaceAccessCache = new Map<string, number>();

export function clearChatSpaceAccessCache(): void {
  spaceAccessCache.clear();
}

/**
 * Throws the Google error when the caller can't read messages in the space
 * (not a member, space doesn't exist), which `sendGoogleError` maps to 403/404.
 */
async function assertCanReadSpace(
  chat: chat_v1.Chat,
  userId: string,
  spaceName: string,
): Promise<void> {
  const key = `${userId}\u0000${spaceName}`;
  const until = spaceAccessCache.get(key);
  if (until && until > Date.now()) return;
  await chat.spaces.messages.list({ parent: spaceName, pageSize: 1 });
  if (spaceAccessCache.size >= MAX_SPACE_ACCESS_ENTRIES) spaceAccessCache.clear();
  spaceAccessCache.set(key, Date.now() + SPACE_ACCESS_TTL_MS);
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

export function extractGoogleError(err: unknown): MappedChatError {
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

  const setup = classifyChatSetupError(err, message);
  if (setup) return setup;

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
  return res.status(mapped.status).json({
    error: mapped.error,
    code: mapped.code,
    ...(mapped.helpUrl ? { helpUrl: mapped.helpUrl } : {}),
  });
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
      const sent = shapeMessage(result.data);
      const sessionId = actingSessionId(req);
      if (sessionId) {
        try {
          recordSessionChatPost({
            sessionId,
            spaceName: `spaces/${spaceId}`,
            threadName: sent.threadName,
            replyMessageName: sent.name,
          });
        } catch (err: unknown) {
          // The message is already posted; a bookkeeping failure must not turn
          // that into an error the agent would retry.
          console.warn(
            `[google-chat] Failed to record Chat post for session ${sessionId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return res.status(201).json(sent);
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  router.get(
    '/api/google/chat/spaces/:spaceId/message-links',
    async (req: Request, res: Response) => {
      const params = SpaceParamsSchema.safeParse(req.params);
      if (!params.success) {
        return bad(
          res,
          400,
          params.error.issues[0]?.message || 'Invalid space id',
          'invalid_request',
        );
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
      const spaceName = `spaces/${params.data.spaceId}`;
      try {
        await assertCanReadSpace(createChatClient(token), uid, spaceName);
      } catch (err: unknown) {
        return sendGoogleError(res, err);
      }
      return res.json({ links: listChatMessageLinks(spaceName) });
    },
  );

  router.post(
    '/api/google/chat/spaces/:spaceId/message-links',
    async (req: Request, res: Response) => {
      const params = SpaceParamsSchema.safeParse(req.params);
      if (!params.success) {
        return bad(
          res,
          400,
          params.error.issues[0]?.message || 'Invalid space id',
          'invalid_request',
        );
      }
      const body = CreateMessageLinkBodySchema.safeParse(req.body);
      if (!body.success) {
        return bad(res, 400, body.error.issues[0]?.message || 'Invalid body', 'invalid_request');
      }
      const spaceId = params.data.spaceId;
      const { messageName, sessionId } = body.data;
      const threadName = body.data.threadName ?? null;
      if (MESSAGE_NAME_RE.exec(messageName)?.[1] !== spaceId) {
        return bad(res, 400, 'messageName must belong to the requested space', 'invalid_request');
      }
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
      // The caller must be able to read the message itself; this also rules
      // out links to messages that don't exist.
      let source: chat_v1.Schema$Message;
      try {
        source = (await createChatClient(token).spaces.messages.get({ name: messageName })).data;
      } catch (err: unknown) {
        return sendGoogleError(res, err);
      }
      if (threadName && source.thread?.name && source.thread.name !== threadName) {
        return bad(res, 400, 'threadName does not match the message thread', 'invalid_request');
      }
      if (!sessionExists(sessionId)) {
        return bad(res, 404, 'Session not found', 'session_not_found');
      }
      const result = createChatMessageLink({
        messageName,
        spaceName: `spaces/${spaceId}`,
        threadName,
        sessionId,
        userId: uid,
      });
      return res
        .status(result.created ? 201 : 200)
        .json({ link: result.link, existing: result.existing });
    },
  );

  return router;
}
