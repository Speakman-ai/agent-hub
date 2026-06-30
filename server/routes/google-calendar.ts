import { Router, Request, Response } from 'express';
import { google, type calendar_v3 } from 'googleapis';
import type { RouteDeps } from '../types.js';
import { getActiveAccessToken, getGoogleConnectionStatus } from '../google-connections-store.js';
import { resolveOAuthConnectionUserId } from '../github-connection-user.js';
import { registerComponent, registerPath, z } from '../openapi/registry.js';

const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const CALENDAR_FULL_SCOPE = 'https://www.googleapis.com/auth/calendar';

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339_WITH_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const RFC3339_LOCAL_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isGoogleDate(value: string): boolean {
  const match = DATE_ONLY_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function isRfc3339DateTimeWithOffset(value: string): boolean {
  const match = RFC3339_WITH_OFFSET_RE.exec(value);
  if (!match) return false;
  if (!isGoogleDate(`${match[1]}-${match[2]}-${match[3]}`)) return false;
  return Number.isFinite(Date.parse(value));
}

function isRfc3339LocalDateTime(value: string): boolean {
  const match = RFC3339_LOCAL_DATE_TIME_RE.exec(value);
  if (!match) return false;
  return isGoogleDate(`${match[1]}-${match[2]}-${match[3]}`);
}

function isGoogleEventDateTime(value: string, timeZone: string | undefined): boolean {
  return isRfc3339DateTimeWithOffset(value) || (!!timeZone && isRfc3339LocalDateTime(value));
}

const ErrorResponse = registerComponent(
  'GoogleCalendarErrorResponse',
  z.object({
    error: z.string(),
    code: z.string().optional(),
    requiredScopes: z.array(z.string()).optional(),
  }),
);

const GoogleCalendarDateTimeSchema = registerComponent(
  'GoogleCalendarDateTime',
  z
    .object({
      date: z.string().optional().openapi({ description: 'All-day date in YYYY-MM-DD form.' }),
      dateTime: z.string().optional().openapi({
        description: 'RFC3339 timestamp. Offset is required unless timeZone is specified.',
        example: '2026-06-30T09:00:00-07:00',
      }),
      timeZone: z.string().min(1).optional(),
    })
    .superRefine((value, ctx) => {
      if (!value.date && !value.dateTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'date or dateTime is required',
        });
      }
      if (value.date && value.dateTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'date and dateTime are mutually exclusive',
        });
      }
      if (value.date && !isGoogleDate(value.date)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['date'],
          message: 'date must be in YYYY-MM-DD format',
        });
      }
      if (value.dateTime && !isGoogleEventDateTime(value.dateTime, value.timeZone)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dateTime'],
          message: 'dateTime must be RFC3339 with a timezone offset unless timeZone is specified',
        });
      }
    })
    .strict(),
);

const GoogleCalendarAttendeeSchema = registerComponent(
  'GoogleCalendarAttendee',
  z
    .object({
      email: z.string().email(),
      displayName: z.string().optional(),
      optional: z.boolean().optional(),
      responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']).optional(),
    })
    .strict(),
);

const GoogleCalendarEventInputSchema = registerComponent(
  'GoogleCalendarEventInput',
  z
    .object({
      summary: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      start: GoogleCalendarDateTimeSchema,
      end: GoogleCalendarDateTimeSchema,
      attendees: z.array(GoogleCalendarAttendeeSchema).optional(),
      recurrence: z.array(z.string()).optional(),
      colorId: z.string().optional(),
      transparency: z.enum(['opaque', 'transparent']).optional(),
      visibility: z.enum(['default', 'public', 'private', 'confidential']).optional(),
      reminders: z
        .object({
          useDefault: z.boolean().optional(),
          overrides: z
            .array(
              z
                .object({
                  method: z.enum(['email', 'popup']),
                  minutes: z.number().int().min(0).max(40320),
                })
                .strict(),
            )
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
);

const GoogleCalendarEventPatchSchema = registerComponent(
  'GoogleCalendarEventPatch',
  GoogleCalendarEventInputSchema.partial().refine((value) => Object.keys(value).length > 0, {
    message: 'event patch must include at least one field',
  }),
);

const GoogleCalendarEventSchema = registerComponent(
  'GoogleCalendarEvent',
  z.object({
    id: z.string().nullable(),
    status: z.string().nullable(),
    htmlLink: z.string().nullable(),
    summary: z.string().nullable(),
    description: z.string().nullable(),
    location: z.string().nullable(),
    start: GoogleCalendarDateTimeSchema.nullable(),
    end: GoogleCalendarDateTimeSchema.nullable(),
    creator: z
      .object({ email: z.string().nullable(), displayName: z.string().nullable() })
      .nullable(),
    organizer: z
      .object({ email: z.string().nullable(), displayName: z.string().nullable() })
      .nullable(),
    attendees: z.array(GoogleCalendarAttendeeSchema).optional(),
    created: z.string().nullable(),
    updated: z.string().nullable(),
    etag: z.string().nullable(),
    recurringEventId: z.string().nullable(),
    hangoutLink: z.string().nullable(),
  }),
);

const ListGoogleCalendarEventsQuerySchema = z
  .object({
    calendarId: z.string().min(1).optional().openapi({
      description: 'Calendar identifier. Defaults to Google Calendar `primary`.',
    }),
    timeMin: z.string().min(1).openapi({
      description: 'Lower bound for event end time, as an RFC3339 timestamp with offset.',
      example: '2026-06-30T00:00:00Z',
    }),
    timeMax: z.string().min(1).openapi({
      description: 'Upper bound for event start time, as an RFC3339 timestamp with offset.',
      example: '2026-07-01T00:00:00Z',
    }),
    timeZone: z.string().optional(),
    maxResults: z.coerce.number().int().min(1).max(2500).optional(),
    pageToken: z.string().optional(),
    q: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const validTimeMin = isRfc3339DateTimeWithOffset(value.timeMin);
    const validTimeMax = isRfc3339DateTimeWithOffset(value.timeMax);
    if (!validTimeMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeMin'],
        message: 'timeMin must be an RFC3339 timestamp with a timezone offset',
      });
    }
    if (!validTimeMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeMax'],
        message: 'timeMax must be an RFC3339 timestamp with a timezone offset',
      });
    }
    if (validTimeMin && validTimeMax && Date.parse(value.timeMin) >= Date.parse(value.timeMax)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeMax'],
        message: 'timeMax must be after timeMin',
      });
    }
  });

const CreateGoogleCalendarEventBodySchema = z
  .object({
    calendarId: z.string().min(1).optional(),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
    event: GoogleCalendarEventInputSchema,
  })
  .strict();

const PatchGoogleCalendarEventParamsSchema = z.object({
  eventId: z.string().min(1),
});

const PatchGoogleCalendarEventBodySchema = z
  .object({
    calendarId: z.string().min(1).optional(),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
    event: GoogleCalendarEventPatchSchema,
  })
  .strict();

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/google/calendar/events',
  tags: ['Google'],
  summary: 'List Google Calendar events for the calling user over a time range',
  request: { query: ListGoogleCalendarEventsQuerySchema },
  responses: {
    200: {
      description: 'Calendar events in agenda order.',
      content: jsonContent(
        z.object({
          calendarId: z.string(),
          timeMin: z.string(),
          timeMax: z.string(),
          timeZone: z.string().nullable(),
          nextPageToken: z.string().nullable(),
          nextSyncToken: z.string().nullable(),
          events: z.array(GoogleCalendarEventSchema),
        }),
      ),
    },
    400: errorResponse('Invalid query.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Calendar scope has not been granted.'),
    429: errorResponse('Google Calendar rate limit exceeded.'),
    502: errorResponse('Google Calendar request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/google/calendar/events',
  tags: ['Google'],
  summary: 'Create a Google Calendar event for the calling user',
  request: {
    body: {
      content: jsonContent(CreateGoogleCalendarEventBodySchema),
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Created event.',
      content: jsonContent(z.object({ calendarId: z.string(), event: GoogleCalendarEventSchema })),
    },
    400: errorResponse('Invalid body.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Calendar scope has not been granted.'),
    429: errorResponse('Google Calendar rate limit exceeded.'),
    502: errorResponse('Google Calendar request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

registerPath({
  method: 'patch',
  path: '/api/google/calendar/events/{eventId}',
  tags: ['Google'],
  summary: 'Patch a Google Calendar event for the calling user',
  request: {
    params: PatchGoogleCalendarEventParamsSchema,
    body: {
      content: jsonContent(PatchGoogleCalendarEventBodySchema),
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Updated event.',
      content: jsonContent(z.object({ calendarId: z.string(), event: GoogleCalendarEventSchema })),
    },
    400: errorResponse('Invalid body or event id.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Calendar scope has not been granted.'),
    404: errorResponse('Calendar or event not found.'),
    429: errorResponse('Google Calendar rate limit exceeded.'),
    502: errorResponse('Google Calendar request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

type GoogleCalendarEventInput = z.infer<typeof GoogleCalendarEventInputSchema>;
type GoogleCalendarEventPatch = z.infer<typeof GoogleCalendarEventPatchSchema>;

interface GoogleErrorShape {
  response?: {
    status?: number;
    data?: {
      error?: string | { message?: string; status?: string; errors?: Array<{ reason?: string }> };
      message?: string;
    };
    headers?: Record<string, string | string[] | undefined>;
  };
  code?: number | string;
  message?: string;
}

function bad(res: Response, status: number, error: string, code?: string, extra = {}): void {
  res.status(status).json({ error, ...(code && { code }), ...extra });
}

function calendarIdOrPrimary(calendarId: string | undefined): string {
  return calendarId?.trim() || 'primary';
}

function hasCalendarEventsScope(scopes: string[]): boolean {
  return scopes.includes(CALENDAR_EVENTS_SCOPE) || scopes.includes(CALENDAR_FULL_SCOPE);
}

function requireCalendarAccess(req: Request, res: Response, deps: RouteDeps): string | null {
  const uid = resolveOAuthConnectionUserId(req);
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
  if (!hasCalendarEventsScope(status.grantedScopes)) {
    bad(res, 403, 'Google Calendar access has not been granted', 'google_calendar_scope_required', {
      requiredScopes: [CALENDAR_EVENTS_SCOPE],
    });
    return null;
  }
  return uid;
}

async function resolveCalendarToken(
  userId: string,
  deps: RouteDeps,
  res: Response,
): Promise<string | null> {
  let token: string | null;
  try {
    token = await getActiveAccessToken(userId, deps.config.googleOAuth ?? null);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[google-calendar] Failed to resolve token for user ${userId}: ${msg}`);
    bad(res, 502, 'Failed to resolve Google access token', 'google_token_resolution_failed');
    return null;
  }
  if (!token) {
    bad(res, 401, 'Google account must be reconnected', 'google_reconnect_required');
    return null;
  }
  return token;
}

function createCalendarClient(accessToken: string): calendar_v3.Calendar {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.calendar({ version: 'v3', auth });
}

function person(value: calendar_v3.Schema$Event['creator'] | undefined) {
  if (!value) return null;
  return {
    email: value.email ?? null,
    displayName: value.displayName ?? null,
  };
}

function shapeAttendees(attendees: calendar_v3.Schema$EventAttendee[] | undefined) {
  if (!attendees) return undefined;
  return attendees.map((attendee) => ({
    email: attendee.email ?? '',
    displayName: attendee.displayName ?? undefined,
    optional: attendee.optional ?? undefined,
    responseStatus:
      attendee.responseStatus === 'needsAction' ||
      attendee.responseStatus === 'declined' ||
      attendee.responseStatus === 'tentative' ||
      attendee.responseStatus === 'accepted'
        ? attendee.responseStatus
        : undefined,
  }));
}

function shapeEvent(event: calendar_v3.Schema$Event) {
  return {
    id: event.id ?? null,
    status: event.status ?? null,
    htmlLink: event.htmlLink ?? null,
    summary: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    start: event.start ?? null,
    end: event.end ?? null,
    creator: person(event.creator),
    organizer: person(event.organizer),
    attendees: shapeAttendees(event.attendees),
    created: event.created ?? null,
    updated: event.updated ?? null,
    etag: event.etag ?? null,
    recurringEventId: event.recurringEventId ?? null,
    hangoutLink: event.hangoutLink ?? null,
  };
}

function eventResource(
  event: GoogleCalendarEventInput | GoogleCalendarEventPatch,
): calendar_v3.Schema$Event {
  return event as calendar_v3.Schema$Event;
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
    'Google Calendar request failed';

  if (status === 401) {
    return {
      status: 401,
      code: 'google_calendar_auth_failed',
      error: 'Google Calendar authorization failed. Reconnect Google in Account settings.',
    };
  }
  if (status === 403) {
    const isRateLimit =
      nestedReason === 'rateLimitExceeded' ||
      nestedReason === 'userRateLimitExceeded' ||
      /rate.?limit|quota/i.test(message);
    if (isRateLimit) {
      return {
        status: 429,
        code: 'google_calendar_rate_limited',
        error: 'Google Calendar rate limit exceeded',
      };
    }
    return {
      status: 403,
      code: 'google_calendar_forbidden',
      error: 'Google Calendar access was denied',
    };
  }
  if (status === 404) {
    return {
      status: 404,
      code: 'google_calendar_not_found',
      error: 'Google Calendar or event was not found',
    };
  }
  if (status === 429) {
    return {
      status: 429,
      code: 'google_calendar_rate_limited',
      error: 'Google Calendar rate limit exceeded',
    };
  }
  if (status >= 400 && status < 500) {
    return {
      status,
      code: 'google_calendar_bad_request',
      error: message.split('\n')[0],
    };
  }
  return {
    status: 502,
    code: 'google_calendar_upstream_failed',
    error: message.split('\n')[0],
  };
}

function sendGoogleError(res: Response, err: unknown): Response {
  const mapped = extractGoogleError(err);
  return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
}

export default function createGoogleCalendarRoutes(deps: RouteDeps): Router {
  const router = Router();

  router.get('/api/google/calendar/events', async (req: Request, res: Response) => {
    const parsed = ListGoogleCalendarEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return bad(res, 400, parsed.error.issues[0]?.message || 'Invalid query', 'invalid_request');
    }
    const uid = requireCalendarAccess(req, res, deps);
    if (!uid) return;
    const token = await resolveCalendarToken(uid, deps, res);
    if (!token) return;

    const query = parsed.data;
    const calendarId = calendarIdOrPrimary(query.calendarId);
    try {
      const calendar = createCalendarClient(token);
      const result = await calendar.events.list({
        calendarId,
        timeMin: query.timeMin,
        timeMax: query.timeMax,
        timeZone: query.timeZone,
        maxResults: query.maxResults,
        pageToken: query.pageToken,
        q: query.q,
        singleEvents: true,
        orderBy: 'startTime',
      });
      return res.json({
        calendarId,
        timeMin: query.timeMin,
        timeMax: query.timeMax,
        timeZone: result.data.timeZone ?? query.timeZone ?? null,
        nextPageToken: result.data.nextPageToken ?? null,
        nextSyncToken: result.data.nextSyncToken ?? null,
        events: (result.data.items ?? []).map(shapeEvent),
      });
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  router.post('/api/google/calendar/events', async (req: Request, res: Response) => {
    const parsed = CreateGoogleCalendarEventBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return bad(res, 400, parsed.error.issues[0]?.message || 'Invalid body', 'invalid_request');
    }
    const uid = requireCalendarAccess(req, res, deps);
    if (!uid) return;
    const token = await resolveCalendarToken(uid, deps, res);
    if (!token) return;

    const body = parsed.data;
    const calendarId = calendarIdOrPrimary(body.calendarId);
    try {
      const calendar = createCalendarClient(token);
      const result = await calendar.events.insert({
        calendarId,
        sendUpdates: body.sendUpdates,
        requestBody: eventResource(body.event),
      });
      return res.status(201).json({ calendarId, event: shapeEvent(result.data) });
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  router.patch('/api/google/calendar/events/:eventId', async (req: Request, res: Response) => {
    const params = PatchGoogleCalendarEventParamsSchema.safeParse(req.params);
    const body = PatchGoogleCalendarEventBodySchema.safeParse(req.body);
    if (!params.success) {
      return bad(
        res,
        400,
        params.error.issues[0]?.message || 'Invalid event id',
        'invalid_request',
      );
    }
    if (!body.success) {
      return bad(res, 400, body.error.issues[0]?.message || 'Invalid body', 'invalid_request');
    }
    const uid = requireCalendarAccess(req, res, deps);
    if (!uid) return;
    const token = await resolveCalendarToken(uid, deps, res);
    if (!token) return;

    const calendarId = calendarIdOrPrimary(body.data.calendarId);
    try {
      const calendar = createCalendarClient(token);
      const result = await calendar.events.patch({
        calendarId,
        eventId: params.data.eventId,
        sendUpdates: body.data.sendUpdates,
        requestBody: eventResource(body.data.event),
      });
      return res.json({ calendarId, event: shapeEvent(result.data) });
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  return router;
}
