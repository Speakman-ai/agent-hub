import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleMock = vi.hoisted(() => {
  const calendarEventsList = vi.fn();
  const gmailThreadsList = vi.fn();
  const gmailThreadsGet = vi.fn();
  const sheetsValuesGet = vi.fn();
  const chatMessagesList = vi.fn();
  const setCredentials = vi.fn();
  return {
    calendarEventsList,
    gmailThreadsList,
    gmailThreadsGet,
    sheetsValuesGet,
    chatMessagesList,
    setCredentials,
    google: {
      auth: {
        OAuth2: vi.fn(function OAuth2() {
          return { setCredentials };
        }),
      },
      calendar: vi.fn(() => ({ events: { list: calendarEventsList } })),
      gmail: vi.fn(() => ({
        users: { threads: { list: gmailThreadsList, get: gmailThreadsGet } },
      })),
      sheets: vi.fn(() => ({ spreadsheets: { values: { get: sheetsValuesGet } } })),
      chat: vi.fn(() => ({ spaces: { messages: { list: chatMessagesList } } })),
    },
  };
});

const storeMock = vi.hoisted(() => ({
  getActiveAccessToken: vi.fn(),
  getGoogleConnectionStatus: vi.fn(),
}));

vi.mock('googleapis', () => ({ google: googleMock.google }));
vi.mock('./google-connections-store.js', () => storeMock);

const { runGoogleReadAction } = await import('./google-react.js');

const OAUTH = { clientId: 'cid', clientSecret: 'secret' } as never;

const ALL_READ_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/chat.messages.readonly',
];

function connected(grantedScopes: string[] = ALL_READ_SCOPES) {
  return {
    connected: true,
    email: 'u@x.com',
    grantedScopes,
    connectedAt: null,
    tokenExpiresAt: null,
  };
}

describe('runGoogleReadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.getGoogleConnectionStatus.mockReturnValue(connected());
    storeMock.getActiveAccessToken.mockResolvedValue('access-token');
  });

  it('returns a not-linked note when the session has no owner', async () => {
    const res = await runGoogleReadAction(
      { surface: 'calendar', from: 'a', to: 'b' },
      { ownerUserId: null, oauthConfig: OAUTH },
    );
    expect(res.markdown).toBe('');
    expect(res.errorMarkdown).toContain('Settings → Account → Google');
    // Expected, user-recoverable state — NOT a host failure.
    expect(res.failed).toBeFalsy();
    expect(storeMock.getActiveAccessToken).not.toHaveBeenCalled();
  });

  it('returns a not-linked note when the owner is not connected', async () => {
    storeMock.getGoogleConnectionStatus.mockReturnValue({ ...connected(), connected: false });
    const res = await runGoogleReadAction(
      { surface: 'gmail' },
      { ownerUserId: 'owner-1', oauthConfig: OAUTH },
    );
    expect(res.errorMarkdown).toContain('has not linked a Google account');
  });

  it('reads calendar events scoped to the owner token', async () => {
    googleMock.calendarEventsList.mockResolvedValue({
      data: {
        items: [
          { summary: 'Standup', start: { dateTime: '2026-06-30T09:00:00Z' }, attendees: [{}, {}] },
          { summary: 'Lunch', start: { dateTime: '2026-06-30T12:00:00Z' } },
        ],
      },
    });
    const res = await runGoogleReadAction(
      { surface: 'calendar', from: '2026-06-30T00:00:00Z', to: '2026-07-01T00:00:00Z' },
      { ownerUserId: 'owner-1', oauthConfig: OAUTH },
    );
    expect(storeMock.getActiveAccessToken).toHaveBeenCalledWith('owner-1', OAUTH);
    expect(googleMock.calendarEventsList).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'primary', timeMin: '2026-06-30T00:00:00Z' }),
    );
    expect(res.markdown).toContain('Standup');
    expect(res.markdown).toContain('2 attendee(s)');
    expect(res.errorMarkdown).toBeUndefined();
  });

  it('requires from/to for a calendar read', async () => {
    const res = await runGoogleReadAction(
      { surface: 'calendar' },
      { ownerUserId: 'owner-1', oauthConfig: OAUTH },
    );
    expect(res.markdown).toBe('');
    expect(res.errorMarkdown).toContain('from');
    // Missing required args is an expected validation state, not a host failure.
    expect(res.failed).toBeFalsy();
    expect(googleMock.calendarEventsList).not.toHaveBeenCalled();
  });

  it('lists gmail threads with a query', async () => {
    googleMock.gmailThreadsList.mockResolvedValue({
      data: { threads: [{ id: 't1', snippet: 'Hello there' }] },
    });
    const res = await runGoogleReadAction(
      { surface: 'gmail', q: 'is:unread', max: 5 },
      { ownerUserId: 'owner-1', oauthConfig: OAUTH },
    );
    expect(googleMock.gmailThreadsList).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'me', q: 'is:unread', maxResults: 5 }),
    );
    expect(res.markdown).toContain('t1');
    expect(res.markdown).toContain('Hello there');
  });

  it('reads sheet values for a range', async () => {
    googleMock.sheetsValuesGet.mockResolvedValue({
      data: {
        values: [
          ['Name', 'Score'],
          ['Alice', 42],
        ],
      },
    });
    const res = await runGoogleReadAction(
      { surface: 'sheets', spreadsheetId: 'sid', range: 'Sheet1!A1:B2' },
      { ownerUserId: 'owner-1', oauthConfig: OAUTH },
    );
    expect(googleMock.sheetsValuesGet).toHaveBeenCalledWith(
      expect.objectContaining({ spreadsheetId: 'sid', range: 'Sheet1!A1:B2' }),
    );
    expect(res.markdown).toContain('Name | Score');
    expect(res.markdown).toContain('Alice | 42');
  });

  it('maps a googleapis throw to an error note (no token leak)', async () => {
    googleMock.calendarEventsList.mockRejectedValue(new Error('insufficient scope'));
    const res = await runGoogleReadAction(
      { surface: 'calendar', from: 'a', to: 'b' },
      { ownerUserId: 'owner-1', oauthConfig: OAUTH },
    );
    expect(res.markdown).toBe('');
    expect(res.errorMarkdown).toContain('calendar read failed');
    // An unexpected googleapis throw IS a genuine host failure.
    expect(res.failed).toBe(true);
    expect(JSON.stringify(res)).not.toContain('access-token');
  });

  it('marks the not-connected case as a recoverable (non-failed) observation', async () => {
    storeMock.getGoogleConnectionStatus.mockReturnValue({ ...connected(), connected: false });
    const res = await runGoogleReadAction(
      { surface: 'sheets', spreadsheetId: 'sid', range: 'A1' },
      { ownerUserId: 'owner-1', oauthConfig: OAUTH },
    );
    expect(res.errorMarkdown).toContain('has not linked a Google account');
    expect(res.failed).toBeFalsy();
  });

  it('connected but missing the surface scope → recoverable enable-surface note (no googleapis call)', async () => {
    // Granted Calendar only; a Sheets read must not fall through to googleapis.
    storeMock.getGoogleConnectionStatus.mockReturnValue(
      connected(['https://www.googleapis.com/auth/calendar.events']),
    );
    const res = await runGoogleReadAction(
      { surface: 'sheets', spreadsheetId: 'sid', range: 'A1:B2' },
      { ownerUserId: 'owner-1', oauthConfig: OAUTH },
    );
    expect(res.markdown).toBe('');
    expect(res.errorMarkdown).toContain('Google Sheets not enabled');
    expect(res.errorMarkdown).toContain('incremental consent');
    expect(res.failed).toBeFalsy();
    expect(storeMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.sheetsValuesGet).not.toHaveBeenCalled();
  });

  it('gmail read accepts a modify-scope grant (no gmail.readonly)', async () => {
    storeMock.getGoogleConnectionStatus.mockReturnValue(
      connected(['https://www.googleapis.com/auth/gmail.modify']),
    );
    googleMock.gmailThreadsList.mockResolvedValue({
      data: { threads: [{ id: 't9', snippet: 'hi' }] },
    });
    const res = await runGoogleReadAction(
      { surface: 'gmail' },
      { ownerUserId: 'owner-1', oauthConfig: OAUTH },
    );
    expect(res.errorMarkdown).toBeUndefined();
    expect(res.markdown).toContain('t9');
  });

  it('maps a late googleapis insufficient-scope error to a recoverable note (not failed)', async () => {
    const err = Object.assign(new Error('Request had insufficient authentication scopes.'), {
      code: 403,
      errors: [{ reason: 'insufficientPermissions', message: 'Insufficient Permission' }],
    });
    googleMock.calendarEventsList.mockRejectedValue(err);
    const res = await runGoogleReadAction(
      { surface: 'calendar', from: '2026-06-30T00:00:00Z', to: '2026-07-01T00:00:00Z' },
      { ownerUserId: 'owner-1', oauthConfig: OAUTH },
    );
    expect(res.markdown).toBe('');
    expect(res.errorMarkdown).toContain('Google Calendar not enabled');
    expect(res.failed).toBeFalsy();
  });

  describe('chat surface', () => {
    const CTX = { ownerUserId: 'owner-1', oauthConfig: OAUTH };

    it('reads recent messages newest-first and renders them oldest-first', async () => {
      googleMock.chatMessagesList.mockResolvedValue({
        data: {
          messages: [
            {
              createTime: '2026-10-08T10:05:00Z',
              text: 'Second',
              sender: { name: 'users/222', type: 'HUMAN' },
              attachment: [{}],
            },
            {
              createTime: '2026-10-08T10:00:00Z',
              text: 'First',
              sender: { name: 'users/111', displayName: 'Ana', type: 'HUMAN' },
            },
          ],
        },
      });
      const res = await runGoogleReadAction(
        { surface: 'chat', spaceId: 'spaces/AAAA', max: 5 },
        CTX,
      );
      expect(googleMock.chatMessagesList).toHaveBeenCalledWith({
        parent: 'spaces/AAAA',
        pageSize: 5,
        orderBy: 'createTime desc',
      });
      expect(res.errorMarkdown).toBeUndefined();
      expect(res.markdown).toContain('## Google Chat spaces/AAAA');
      expect(res.markdown.indexOf('Ana: First')).toBeLessThan(
        res.markdown.indexOf('User 222: Second'),
      );
      expect(res.markdown).toContain('[1 attachment(s)]');
    });

    it('filters by thread and an inclusive from bound', async () => {
      googleMock.chatMessagesList.mockResolvedValue({ data: {} });
      const res = await runGoogleReadAction(
        { surface: 'chat', spaceId: 'AAAA', threadId: 'T1', from: '2026-10-08T10:00:00Z' },
        CTX,
      );
      const call = googleMock.chatMessagesList.mock.calls[0][0];
      expect(call.pageSize).toBe(20);
      expect(call.filter).toContain('thread.name = spaces/AAAA/threads/T1');
      expect(call.filter).toMatch(/createTime > "2026-10-08T09:59:59\.999999999Z"/);
      expect(res.markdown).toContain('No messages since 2026-10-08T10:00:00Z');
    });

    it('rejects a thread from another space without calling googleapis', async () => {
      const res = await runGoogleReadAction(
        { surface: 'chat', spaceId: 'AAAA', threadId: 'spaces/BBBB/threads/T1' },
        CTX,
      );
      expect(res.errorMarkdown).toContain('threadId');
      expect(res.failed).toBeFalsy();
      expect(googleMock.chatMessagesList).not.toHaveBeenCalled();
    });

    it('requires a valid spaceId (recoverable, no path smuggling)', async () => {
      for (const spaceId of [undefined, 'spaces/../x', 'AA/BB']) {
        const res = await runGoogleReadAction({ surface: 'chat', spaceId }, CTX);
        expect(res.errorMarkdown).toContain('spaceId');
        expect(res.failed).toBeFalsy();
      }
      expect(googleMock.chatMessagesList).not.toHaveBeenCalled();
    });

    it('missing the chat messages scope → recoverable enable note, no token fetch', async () => {
      storeMock.getGoogleConnectionStatus.mockReturnValue(
        connected([
          'https://www.googleapis.com/auth/chat.spaces.readonly',
          'https://www.googleapis.com/auth/gmail.modify',
        ]),
      );
      const res = await runGoogleReadAction({ surface: 'chat', spaceId: 'AAAA' }, CTX);
      expect(res.errorMarkdown).toContain('Google Chat not enabled');
      expect(res.failed).toBeFalsy();
      expect(storeMock.getActiveAccessToken).not.toHaveBeenCalled();
      expect(googleMock.chatMessagesList).not.toHaveBeenCalled();
    });

    it('accepts the broader chat.messages scope', async () => {
      storeMock.getGoogleConnectionStatus.mockReturnValue(
        connected(['https://www.googleapis.com/auth/chat.messages']),
      );
      googleMock.chatMessagesList.mockResolvedValue({ data: { messages: [] } });
      const res = await runGoogleReadAction({ surface: 'chat', spaceId: 'AAAA' }, CTX);
      expect(res.errorMarkdown).toBeUndefined();
      expect(res.markdown).toContain('No messages.');
    });
  });
});
