import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { google, type gmail_v1 } from 'googleapis';
import type { RouteDeps } from '../types.js';
import { getActiveAccessToken, getGoogleConnectionStatus } from '../google-connections-store.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import {
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GMAIL_MODIFY_SCOPE,
  hasGmailReadScope,
  hasGmailModifyScope,
  hasGmailSendScope,
} from '../google-scopes.js';
import { registerComponent, registerPath, z } from '../openapi/registry.js';

/**
 * Gmail proxy routes — server-side Gmail access scoped to the calling user's
 * linked Google connection. Tokens never leave the server (PROXY epic
 * decision): each handler resolves the caller's userId, fetches a fresh access
 * token from the encrypted connection store, calls the googleapis Gmail SDK,
 * and returns shaped JSON.
 *
 * Scopes — least privilege per Google's current Gmail scope table
 * (https://developers.google.com/workspace/gmail/api/auth/scopes):
 *   - reading/listing threads gates on `gmail.readonly` (the NARROWEST read
 *     scope) — `gmail.modify` and the legacy `https://mail.google.com/` also
 *     satisfy it for back-compat, but we never *request* them for this surface;
 *   - sending gates on the sensitive `gmail.send`;
 *   - label add/remove (the modify endpoint) gates on `gmail.modify` (or full),
 *     since readonly cannot mutate the mailbox.
 *
 * NOTE: every Gmail *read* scope (readonly/modify/metadata/full) is classified
 * RESTRICTED by Google, so an inbox-reading feature unavoidably needs restricted
 * OAuth verification (and CASA when restricted-scope data is stored/transmitted).
 * There is no non-restricted way to read mail; requesting `gmail.readonly`
 * instead of `gmail.modify` does NOT avoid that, it just stops over-granting
 * mailbox-mutation power the UI never uses. `gmail.send` is the only Gmail scope
 * here that is merely sensitive (not restricted).
 */

const ErrorResponse = registerComponent(
  'GoogleGmailErrorResponse',
  z.object({
    error: z.string(),
    code: z.string().optional(),
    requiredScopes: z.array(z.string()).optional(),
  }),
);

const GmailThreadSummarySchema = registerComponent(
  'GoogleGmailThreadSummary',
  z.object({
    id: z.string().nullable(),
    snippet: z.string().nullable(),
    historyId: z.string().nullable(),
  }),
);

const GmailMessageSchema = registerComponent(
  'GoogleGmailMessage',
  z.object({
    id: z.string().nullable(),
    threadId: z.string().nullable(),
    labelIds: z.array(z.string()),
    snippet: z.string().nullable(),
    historyId: z.string().nullable(),
    internalDate: z.string().nullable(),
    sizeEstimate: z.number().nullable(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    cc: z.string().nullable(),
    bcc: z.string().nullable(),
    subject: z.string().nullable(),
    date: z.string().nullable(),
    messageIdHeader: z.string().nullable(),
    bodyText: z.string().nullable(),
    bodyHtml: z.string().nullable(),
  }),
);

const GmailThreadSchema = registerComponent(
  'GoogleGmailThread',
  z.object({
    id: z.string().nullable(),
    historyId: z.string().nullable(),
    messages: z.array(GmailMessageSchema),
  }),
);

const ListGmailThreadsQuerySchema = z.object({
  q: z.string().optional().openapi({
    description: 'Gmail search query, e.g. `from:alice is:unread`.',
    example: 'is:unread',
  }),
  labelIds: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .openapi({ description: 'Restrict to threads carrying all of these label ids.' }),
  maxResults: z.coerce.number().int().min(1).max(500).optional(),
  pageToken: z.string().optional(),
  // Parse only the explicit strings "true"/"false". z.coerce.boolean() would
  // turn ANY non-empty query string (including "false") into `true`, which
  // would forward spam/trash threads to a caller that explicitly opted out.
  includeSpamTrash: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

const ReadGmailThreadParamsSchema = z.object({
  threadId: z.string().min(1),
});

const ReadGmailThreadQuerySchema = z.object({
  format: z.enum(['full', 'metadata', 'minimal']).optional(),
});

const EMAIL_LIST_MAX = 50;
const emailList = z.array(z.string().email()).min(1).max(EMAIL_LIST_MAX);

// A header value that is interpolated raw into the RFC2822 message MUST NOT
// contain CR/LF (or a bare NUL) — otherwise a caller could smuggle additional
// headers or break the MIME structure (header injection), e.g. a subject of
// "Hello\r\nBcc: victim@example.com". ASCII values bypass encodeHeaderValue, so
// the only defense for these fields is rejecting line breaks at the edge.
function hasHeaderControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // CR, LF, or NUL: the bytes that enable header injection / truncation.
    if (code === 0x0d || code === 0x0a || code === 0x00) return true;
  }
  return false;
}

const singleLineHeader = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !hasHeaderControlChar(value), {
      message: 'must not contain line breaks',
    });

const SendGmailMessageBodySchema = z
  .object({
    to: emailList,
    cc: z.array(z.string().email()).max(EMAIL_LIST_MAX).optional(),
    bcc: z.array(z.string().email()).max(EMAIL_LIST_MAX).optional(),
    subject: singleLineHeader(998).optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    threadId: z.string().min(1).optional(),
    inReplyTo: singleLineHeader(998).pipe(z.string().min(1)).optional(),
    references: singleLineHeader(998).pipe(z.string().min(1)).optional(),
  })
  .strict()
  .refine((value) => !!value.text || !!value.html, {
    message: 'one of text or html is required',
  });

const ModifyGmailMessageParamsSchema = z.object({
  messageId: z.string().min(1),
});

const ModifyGmailMessageBodySchema = z
  .object({
    addLabelIds: z.array(z.string().min(1)).optional(),
    removeLabelIds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((value) => (value.addLabelIds?.length ?? 0) + (value.removeLabelIds?.length ?? 0) > 0, {
    message: 'addLabelIds or removeLabelIds must contain at least one label',
  });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/google/gmail/threads',
  tags: ['Google'],
  summary: 'List Gmail threads for the calling user',
  request: { query: ListGmailThreadsQuerySchema },
  responses: {
    200: {
      description: 'Matching thread summaries in reverse-chronological order.',
      content: jsonContent(
        z.object({
          threads: z.array(GmailThreadSummarySchema),
          nextPageToken: z.string().nullable(),
          resultSizeEstimate: z.number().nullable(),
        }),
      ),
    },
    400: errorResponse('Invalid query.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Gmail scope has not been granted.'),
    429: errorResponse('Gmail rate limit exceeded.'),
    502: errorResponse('Gmail request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/google/gmail/threads/{threadId}',
  tags: ['Google'],
  summary: 'Read a Gmail thread (with shaped messages) for the calling user',
  request: { params: ReadGmailThreadParamsSchema, query: ReadGmailThreadQuerySchema },
  responses: {
    200: {
      description: 'The thread and its shaped messages.',
      content: jsonContent(GmailThreadSchema),
    },
    400: errorResponse('Invalid thread id or query.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Gmail scope has not been granted.'),
    404: errorResponse('Thread not found.'),
    429: errorResponse('Gmail rate limit exceeded.'),
    502: errorResponse('Gmail request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/google/gmail/messages',
  tags: ['Google'],
  summary: 'Send a Gmail message as the calling user',
  request: { body: { content: jsonContent(SendGmailMessageBodySchema), required: true } },
  responses: {
    201: {
      description: 'The sent message.',
      content: jsonContent(GmailMessageSchema),
    },
    400: errorResponse('Invalid body.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Gmail send scope has not been granted.'),
    429: errorResponse('Gmail rate limit exceeded.'),
    502: errorResponse('Gmail request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/google/gmail/messages/{messageId}/modify',
  tags: ['Google'],
  summary: 'Add or remove labels on a Gmail message for the calling user',
  request: {
    params: ModifyGmailMessageParamsSchema,
    body: { content: jsonContent(ModifyGmailMessageBodySchema), required: true },
  },
  responses: {
    200: {
      description: 'The updated message with refreshed label ids.',
      content: jsonContent(GmailMessageSchema),
    },
    400: errorResponse('Invalid body or message id.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Gmail modify scope has not been granted.'),
    404: errorResponse('Message not found.'),
    429: errorResponse('Gmail rate limit exceeded.'),
    502: errorResponse('Gmail request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
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

/**
 * Resolve the caller, verify Google is configured + connected, and check the
 * surface scope. Returns the resolved userId or null (a response has already
 * been sent). `requiredScopes` drives the 403 payload's affordance hint.
 */
function requireGmailAccess(
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
    bad(res, 403, 'Required Gmail access has not been granted', scopeCode, { requiredScopes });
    return null;
  }
  return uid;
}

async function resolveGmailToken(
  userId: string,
  deps: RouteDeps,
  res: Response,
): Promise<string | null> {
  let token: string | null;
  try {
    token = await getActiveAccessToken(userId, deps.config.googleOAuth ?? null);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[google-gmail] Failed to resolve token for user ${userId}: ${msg}`);
    bad(res, 502, 'Failed to resolve Google access token', 'google_token_resolution_failed');
    return null;
  }
  if (!token) {
    bad(res, 401, 'Google account must be reconnected', 'google_reconnect_required');
    return null;
  }
  return token;
}

function createGmailClient(accessToken: string): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth });
}

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const header of headers) {
    if ((header.name ?? '').toLowerCase() === target) {
      return header.value ?? null;
    }
  }
  return null;
}

/** Recursively pull the first text/plain and text/html bodies out of a MIME tree. */
function extractBodies(payload: gmail_v1.Schema$MessagePart | undefined): {
  text: string | null;
  html: string | null;
} {
  let text: string | null = null;
  let html: string | null = null;

  const decode = (data: string): string => Buffer.from(data, 'base64url').toString('utf-8');

  const walk = (part: gmail_v1.Schema$MessagePart | undefined): void => {
    if (!part) return;
    const mime = (part.mimeType ?? '').toLowerCase();
    const data = part.body?.data;
    if (data) {
      if (mime === 'text/plain' && text === null) {
        text = decode(data);
      } else if (mime === 'text/html' && html === null) {
        html = decode(data);
      }
    }
    for (const child of part.parts ?? []) {
      walk(child);
    }
  };

  walk(payload);
  return { text, html };
}

function shapeMessage(message: gmail_v1.Schema$Message): z.infer<typeof GmailMessageSchema> {
  const headers = message.payload?.headers;
  const { text, html } = extractBodies(message.payload);
  return {
    id: message.id ?? null,
    threadId: message.threadId ?? null,
    labelIds: message.labelIds ?? [],
    snippet: message.snippet ?? null,
    historyId: message.historyId ?? null,
    internalDate: message.internalDate ?? null,
    sizeEstimate: typeof message.sizeEstimate === 'number' ? message.sizeEstimate : null,
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    cc: headerValue(headers, 'Cc'),
    bcc: headerValue(headers, 'Bcc'),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    messageIdHeader: headerValue(headers, 'Message-ID') ?? headerValue(headers, 'Message-Id'),
    bodyText: text,
    bodyHtml: html,
  };
}

function shapeThreadSummary(
  thread: gmail_v1.Schema$Thread,
): z.infer<typeof GmailThreadSummarySchema> {
  return {
    id: thread.id ?? null,
    snippet: thread.snippet ?? null,
    historyId: thread.historyId ?? null,
  };
}

/** RFC 2047 encode a header value when it contains non-ASCII bytes. */
function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function encodeHeaderValue(value: string): string {
  if (isAscii(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

type SendBody = z.infer<typeof SendGmailMessageBodySchema>;

/** Build a base64url-encoded RFC 2822 message for gmail.users.messages.send. */
function buildRawMessage(body: SendBody): string {
  const headers: string[] = [];
  headers.push(`To: ${body.to.join(', ')}`);
  if (body.cc?.length) headers.push(`Cc: ${body.cc.join(', ')}`);
  if (body.bcc?.length) headers.push(`Bcc: ${body.bcc.join(', ')}`);
  if (body.subject) headers.push(`Subject: ${encodeHeaderValue(body.subject)}`);
  if (body.inReplyTo) headers.push(`In-Reply-To: ${body.inReplyTo}`);
  if (body.references) headers.push(`References: ${body.references}`);
  headers.push('MIME-Version: 1.0');

  let mime: string;
  if (body.text && body.html) {
    const boundary = `=_ah_${randomBytes(16).toString('hex')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    mime = [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      body.text,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      body.html,
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else if (body.html) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: 8bit');
    mime = [headers.join('\r\n'), '', body.html].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: 8bit');
    mime = [headers.join('\r\n'), '', body.text ?? ''].join('\r\n');
  }

  return Buffer.from(mime, 'utf-8').toString('base64url');
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
  const nestedReason =
    typeof dataError === 'object' ? dataError.errors?.find((item) => item.reason)?.reason : null;
  const message =
    nestedMessage ||
    e.response?.data?.message ||
    (typeof dataError === 'string' ? dataError : undefined) ||
    e.message ||
    'Gmail request failed';

  if (status === 401) {
    return {
      status: 401,
      code: 'google_gmail_auth_failed',
      error: 'Gmail authorization failed. Reconnect Google in Account settings.',
    };
  }
  if (status === 403) {
    const isRateLimit =
      nestedReason === 'rateLimitExceeded' ||
      nestedReason === 'userRateLimitExceeded' ||
      /rate.?limit|quota/i.test(message);
    if (isRateLimit) {
      return { status: 429, code: 'google_gmail_rate_limited', error: 'Gmail rate limit exceeded' };
    }
    return { status: 403, code: 'google_gmail_forbidden', error: 'Gmail access was denied' };
  }
  if (status === 404) {
    return { status: 404, code: 'google_gmail_not_found', error: 'Gmail resource was not found' };
  }
  if (status === 429) {
    return { status: 429, code: 'google_gmail_rate_limited', error: 'Gmail rate limit exceeded' };
  }
  if (status >= 400 && status < 500) {
    return { status, code: 'google_gmail_bad_request', error: message.split('\n')[0] };
  }
  return { status: 502, code: 'google_gmail_upstream_failed', error: message.split('\n')[0] };
}

function sendGoogleError(res: Response, err: unknown): Response {
  const mapped = extractGoogleError(err);
  return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
}

function normalizeLabelIds(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

export default function createGoogleGmailRoutes(deps: RouteDeps): Router {
  const router = Router();

  router.get('/api/google/gmail/threads', async (req: Request, res: Response) => {
    const parsed = ListGmailThreadsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return bad(res, 400, parsed.error.issues[0]?.message || 'Invalid query', 'invalid_request');
    }
    const uid = requireGmailAccess(
      req,
      res,
      deps,
      hasGmailReadScope,
      [GMAIL_READONLY_SCOPE],
      'google_gmail_scope_required',
    );
    if (!uid) return;
    const token = await resolveGmailToken(uid, deps, res);
    if (!token) return;

    const query = parsed.data;
    try {
      const gmail = createGmailClient(token);
      const result = await gmail.users.threads.list({
        userId: 'me',
        q: query.q,
        labelIds: normalizeLabelIds(query.labelIds),
        maxResults: query.maxResults,
        pageToken: query.pageToken,
        includeSpamTrash: query.includeSpamTrash,
      });
      return res.json({
        threads: (result.data.threads ?? []).map(shapeThreadSummary),
        nextPageToken: result.data.nextPageToken ?? null,
        resultSizeEstimate:
          typeof result.data.resultSizeEstimate === 'number'
            ? result.data.resultSizeEstimate
            : null,
      });
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  router.get('/api/google/gmail/threads/:threadId', async (req: Request, res: Response) => {
    const params = ReadGmailThreadParamsSchema.safeParse(req.params);
    const queryParsed = ReadGmailThreadQuerySchema.safeParse(req.query);
    if (!params.success) {
      return bad(
        res,
        400,
        params.error.issues[0]?.message || 'Invalid thread id',
        'invalid_request',
      );
    }
    if (!queryParsed.success) {
      return bad(
        res,
        400,
        queryParsed.error.issues[0]?.message || 'Invalid query',
        'invalid_request',
      );
    }
    const uid = requireGmailAccess(
      req,
      res,
      deps,
      hasGmailReadScope,
      [GMAIL_READONLY_SCOPE],
      'google_gmail_scope_required',
    );
    if (!uid) return;
    const token = await resolveGmailToken(uid, deps, res);
    if (!token) return;

    try {
      const gmail = createGmailClient(token);
      const result = await gmail.users.threads.get({
        userId: 'me',
        id: params.data.threadId,
        format: queryParsed.data.format ?? 'full',
      });
      return res.json({
        id: result.data.id ?? null,
        historyId: result.data.historyId ?? null,
        messages: (result.data.messages ?? []).map(shapeMessage),
      });
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  router.post('/api/google/gmail/messages', async (req: Request, res: Response) => {
    const parsed = SendGmailMessageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return bad(res, 400, parsed.error.issues[0]?.message || 'Invalid body', 'invalid_request');
    }
    const uid = requireGmailAccess(
      req,
      res,
      deps,
      hasGmailSendScope,
      [GMAIL_SEND_SCOPE],
      'google_gmail_send_scope_required',
    );
    if (!uid) return;
    const token = await resolveGmailToken(uid, deps, res);
    if (!token) return;

    try {
      const gmail = createGmailClient(token);
      const result = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: buildRawMessage(parsed.data),
          ...(parsed.data.threadId ? { threadId: parsed.data.threadId } : {}),
        },
      });
      return res.status(201).json(shapeMessage(result.data));
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  router.post(
    '/api/google/gmail/messages/:messageId/modify',
    async (req: Request, res: Response) => {
      const params = ModifyGmailMessageParamsSchema.safeParse(req.params);
      const body = ModifyGmailMessageBodySchema.safeParse(req.body);
      if (!params.success) {
        return bad(
          res,
          400,
          params.error.issues[0]?.message || 'Invalid message id',
          'invalid_request',
        );
      }
      if (!body.success) {
        return bad(res, 400, body.error.issues[0]?.message || 'Invalid body', 'invalid_request');
      }
      const uid = requireGmailAccess(
        req,
        res,
        deps,
        hasGmailModifyScope,
        [GMAIL_MODIFY_SCOPE],
        'google_gmail_scope_required',
      );
      if (!uid) return;
      const token = await resolveGmailToken(uid, deps, res);
      if (!token) return;

      try {
        const gmail = createGmailClient(token);
        const result = await gmail.users.messages.modify({
          userId: 'me',
          id: params.data.messageId,
          requestBody: {
            addLabelIds: body.data.addLabelIds,
            removeLabelIds: body.data.removeLabelIds,
          },
        });
        return res.json(shapeMessage(result.data));
      } catch (err: unknown) {
        return sendGoogleError(res, err);
      }
    },
  );

  return router;
}
