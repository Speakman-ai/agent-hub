import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const googleMock = vi.hoisted(() => {
  const events = {
    list: vi.fn(),
    insert: vi.fn(),
    patch: vi.fn(),
  };
  const setCredentials = vi.fn();
  return {
    events,
    setCredentials,
    calendar: vi.fn(() => ({ events })),
    OAuth2: vi.fn(function OAuth2() {
      return { setCredentials };
    }),
  };
});

const connectionStoreMock = vi.hoisted(() => ({
  getActiveAccessToken: vi.fn(),
  getGoogleConnectionStatus: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: googleMock.OAuth2,
    },
    calendar: googleMock.calendar,
  },
}));

vi.mock('../google-connections-store.js', () => connectionStoreMock);

const createGoogleCalendarRoutes = (await import('./google-calendar.js')).default;

interface FakeAuth {
  authUserId?: string;
}

function buildDeps(overrides: Record<string, unknown> = {}): RouteDeps {
  return {
    config: {
      googleOAuth: {
        clientId: 'goog-client-id.apps.googleusercontent.com',
        clientSecret: 'goog-secret',
      },
      ...((overrides.config as object) || {}),
    },
  } as unknown as RouteDeps;
}

function makeApp(deps: RouteDeps, opts: FakeAuth = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const r = req as Request & FakeAuth;
    if (opts.authUserId) r.authUserId = opts.authUserId;
    next();
  });
  app.use(createGoogleCalendarRoutes(deps));
  return app;
}

function connectedStatus(scopes = [CALENDAR_EVENTS_SCOPE]) {
  return {
    connected: true,
    email: 'user@example.com',
    grantedScopes: scopes,
    connectedAt: '2026-06-30T00:00:00.000Z',
    tokenExpiresAt: '2026-06-30T01:00:00.000Z',
  };
}

describe('Google Calendar proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(connectedStatus());
    connectionStoreMock.getActiveAccessToken.mockResolvedValue('fresh-access-token');
  });

  it('GET /api/google/calendar/events resolves the caller token and returns shaped events without tokens', async () => {
    googleMock.events.list.mockResolvedValue({
      data: {
        timeZone: 'America/Los_Angeles',
        nextPageToken: 'next-page',
        nextSyncToken: 'next-sync',
        items: [
          {
            id: 'event-1',
            status: 'confirmed',
            htmlLink: 'https://calendar.google.com/event?eid=event-1',
            summary: 'Planning',
            start: { dateTime: '2026-06-30T09:00:00-07:00' },
            end: { dateTime: '2026-06-30T09:30:00-07:00' },
            creator: { email: 'creator@example.com' },
            organizer: { email: 'organizer@example.com' },
            attendees: [{ email: 'guest@example.com', responseStatus: 'accepted' }],
            created: '2026-06-29T10:00:00.000Z',
            updated: '2026-06-29T11:00:00.000Z',
            etag: '"abc"',
          },
        ],
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/calendar/events').query({
      calendarId: 'primary',
      timeMin: '2026-06-30T00:00:00Z',
      timeMax: '2026-07-01T00:00:00Z',
      maxResults: '25',
    });

    expect(res.status).toBe(200);
    expect(connectionStoreMock.getActiveAccessToken).toHaveBeenCalledWith('user-123', {
      clientId: 'goog-client-id.apps.googleusercontent.com',
      clientSecret: 'goog-secret',
    });
    expect(googleMock.setCredentials).toHaveBeenCalledWith({ access_token: 'fresh-access-token' });
    expect(googleMock.events.list).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'primary',
        timeMin: '2026-06-30T00:00:00Z',
        timeMax: '2026-07-01T00:00:00Z',
        maxResults: 25,
        singleEvents: true,
        orderBy: 'startTime',
      }),
    );
    expect(res.body).toEqual({
      calendarId: 'primary',
      timeMin: '2026-06-30T00:00:00Z',
      timeMax: '2026-07-01T00:00:00Z',
      timeZone: 'America/Los_Angeles',
      nextPageToken: 'next-page',
      nextSyncToken: 'next-sync',
      events: [
        expect.objectContaining({
          id: 'event-1',
          summary: 'Planning',
          creator: { email: 'creator@example.com', displayName: null },
          organizer: { email: 'organizer@example.com', displayName: null },
          attendees: [{ email: 'guest@example.com', responseStatus: 'accepted' }],
        }),
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain('fresh-access-token');
  });

  it('POST /api/google/calendar/events creates an event through googleapis', async () => {
    googleMock.events.insert.mockResolvedValue({
      data: {
        id: 'created-1',
        summary: 'Created event',
        start: { dateTime: '2026-06-30T10:00:00Z' },
        end: { dateTime: '2026-06-30T11:00:00Z' },
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .post('/api/google/calendar/events')
      .send({
        calendarId: 'work@example.com',
        sendUpdates: 'all',
        event: {
          summary: 'Created event',
          start: { dateTime: '2026-06-30T10:00:00Z' },
          end: { dateTime: '2026-06-30T11:00:00Z' },
          attendees: [{ email: 'guest@example.com' }],
        },
      });

    expect(res.status).toBe(201);
    expect(googleMock.events.insert).toHaveBeenCalledWith({
      calendarId: 'work@example.com',
      sendUpdates: 'all',
      requestBody: {
        summary: 'Created event',
        start: { dateTime: '2026-06-30T10:00:00Z' },
        end: { dateTime: '2026-06-30T11:00:00Z' },
        attendees: [{ email: 'guest@example.com' }],
      },
    });
    expect(res.body.event.id).toBe('created-1');
    expect(JSON.stringify(res.body)).not.toContain('fresh-access-token');
  });

  it('accepts event dateTime without an offset when timeZone is provided', async () => {
    googleMock.events.insert.mockResolvedValue({
      data: {
        id: 'created-local-time',
        summary: 'Local time event',
        start: { dateTime: '2026-06-30T10:00:00', timeZone: 'America/Los_Angeles' },
        end: { dateTime: '2026-06-30T11:00:00', timeZone: 'America/Los_Angeles' },
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .post('/api/google/calendar/events')
      .send({
        event: {
          summary: 'Local time event',
          start: { dateTime: '2026-06-30T10:00:00', timeZone: 'America/Los_Angeles' },
          end: { dateTime: '2026-06-30T11:00:00', timeZone: 'America/Los_Angeles' },
        },
      });

    expect(res.status).toBe(201);
    expect(googleMock.events.insert).toHaveBeenCalledWith({
      calendarId: 'primary',
      sendUpdates: undefined,
      requestBody: {
        summary: 'Local time event',
        start: { dateTime: '2026-06-30T10:00:00', timeZone: 'America/Los_Angeles' },
        end: { dateTime: '2026-06-30T11:00:00', timeZone: 'America/Los_Angeles' },
      },
    });
  });

  it('rejects non-RFC3339 list ranges before resolving a token', async () => {
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });

    for (const query of [
      { timeMin: '2026-06-30', timeMax: '2026-07-01T00:00:00Z' },
      { timeMin: '2026-06-30T00:00:00', timeMax: '2026-07-01T00:00:00Z' },
      { timeMin: '2026-06-30T00:00:00Z', timeMax: 'not-a-date' },
    ]) {
      const res = await request(app).get('/api/google/calendar/events').query(query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    }

    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.events.list).not.toHaveBeenCalled();
  });

  it('rejects invalid event date and dateTime values before calling Google', async () => {
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });

    const invalidAllDay = await request(app)
      .post('/api/google/calendar/events')
      .send({
        event: {
          summary: 'Bad all-day event',
          start: { date: 'tomorrow' },
          end: { date: '2026-07-01' },
        },
      });
    expect(invalidAllDay.status).toBe(400);
    expect(invalidAllDay.body.error).toMatch(/YYYY-MM-DD/);

    const invalidCalendarDate = await request(app)
      .post('/api/google/calendar/events')
      .send({
        event: {
          summary: 'Bad calendar date',
          start: { date: '2026-02-30' },
          end: { date: '2026-03-01' },
        },
      });
    expect(invalidCalendarDate.status).toBe(400);
    expect(invalidCalendarDate.body.error).toMatch(/YYYY-MM-DD/);

    const missingOffset = await request(app)
      .patch('/api/google/calendar/events/event-1')
      .send({ event: { start: { dateTime: '2026-06-30T10:00:00' } } });
    expect(missingOffset.status).toBe(400);
    expect(missingOffset.body.error).toMatch(/RFC3339/);

    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.events.insert).not.toHaveBeenCalled();
    expect(googleMock.events.patch).not.toHaveBeenCalled();
  });

  it('rejects unsupported conference data fields instead of silently dropping them', async () => {
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });

    const topLevelVersion = await request(app)
      .post('/api/google/calendar/events')
      .send({
        conferenceDataVersion: 1,
        event: {
          summary: 'Meet',
          start: { dateTime: '2026-06-30T10:00:00Z' },
          end: { dateTime: '2026-06-30T11:00:00Z' },
        },
      });
    expect(topLevelVersion.status).toBe(400);
    expect(topLevelVersion.body.code).toBe('invalid_request');

    const nestedConferenceData = await request(app)
      .post('/api/google/calendar/events')
      .send({
        event: {
          summary: 'Meet',
          start: { dateTime: '2026-06-30T10:00:00Z' },
          end: { dateTime: '2026-06-30T11:00:00Z' },
          conferenceData: {
            createRequest: {
              requestId: 'meet-1',
            },
          },
        },
      });
    expect(nestedConferenceData.status).toBe(400);
    expect(nestedConferenceData.body.code).toBe('invalid_request');

    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.events.insert).not.toHaveBeenCalled();
  });

  it('returns 403 before calling Google when the incremental Calendar scope is missing', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(connectedStatus(['openid']));

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .post('/api/google/calendar/events')
      .send({
        event: {
          summary: 'No scope',
          start: { dateTime: '2026-06-30T10:00:00Z' },
          end: { dateTime: '2026-06-30T11:00:00Z' },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'google_calendar_scope_required',
      requiredScopes: [CALENDAR_EVENTS_SCOPE],
    });
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.events.insert).not.toHaveBeenCalled();
  });

  it('maps token resolution failures to JSON errors before calling Google', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    connectionStoreMock.getActiveAccessToken.mockRejectedValueOnce(new Error('database is locked'));

    try {
      const app = makeApp(buildDeps(), { authUserId: 'user-123' });
      const res = await request(app).get('/api/google/calendar/events').query({
        timeMin: '2026-06-30T00:00:00Z',
        timeMax: '2026-07-01T00:00:00Z',
      });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        error: 'Failed to resolve Google access token',
        code: 'google_token_resolution_failed',
      });
      expect(googleMock.events.list).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('PATCH /api/google/calendar/events/:eventId updates an event and maps Google quota errors to 429', async () => {
    googleMock.events.patch.mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          error: {
            message: 'Rate Limit Exceeded',
            errors: [{ reason: 'rateLimitExceeded' }],
          },
        },
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const rateLimited = await request(app)
      .patch('/api/google/calendar/events/event-1')
      .send({ event: { summary: 'Updated title' } });

    expect(rateLimited.status).toBe(429);
    expect(rateLimited.body.code).toBe('google_calendar_rate_limited');

    googleMock.events.patch.mockResolvedValueOnce({
      data: {
        id: 'event-1',
        summary: 'Updated title',
        start: { dateTime: '2026-06-30T10:00:00Z' },
        end: { dateTime: '2026-06-30T11:00:00Z' },
      },
    });
    const updated = await request(app)
      .patch('/api/google/calendar/events/event-1')
      .send({ calendarId: 'primary', event: { summary: 'Updated title' } });

    expect(updated.status).toBe(200);
    expect(googleMock.events.patch).toHaveBeenLastCalledWith({
      calendarId: 'primary',
      eventId: 'event-1',
      sendUpdates: undefined,
      requestBody: { summary: 'Updated title' },
    });
    expect(updated.body.event.summary).toBe('Updated title');
  });

  it('returns 401 when no request user can be resolved', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).get('/api/google/calendar/events').query({
      timeMin: '2026-06-30T00:00:00Z',
      timeMax: '2026-07-01T00:00:00Z',
    });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('authentication_required');
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
  });
});
