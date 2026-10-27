import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: vi.fn(),
    listGoogleCalendarEvents: vi.fn(),
    listGoogleCalendars: vi.fn(),
    startGoogleOAuth: vi.fn(),
    createGoogleCalendarEvent: vi.fn(),
    updateGoogleCalendarEvent: vi.fn(),
    createTodo: vi.fn(),
  },
}));

import CalendarAgendaPage, { CALENDAR_EVENTS_SCOPE, MONTH_MAX_RESULTS } from './CalendarAgendaPage';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

// The page issues two list calls: the agenda window and the month grid window.
// Route them by maxResults so ordering between the two doesn't matter.
function routeLists(agendaResponses: any[][], monthEvents: any[] = []) {
  const queue = [...agendaResponses];
  mockApi.listGoogleCalendarEvents.mockImplementation(async (params: any) => {
    if (params.maxResults === MONTH_MAX_RESULTS) return { events: monthEvents };
    return { events: queue.length > 1 ? queue.shift() : queue[0] };
  });
}

const CONNECTED = {
  connected: true,
  email: 'person@example.com',
  grantedScopes: [CALENDAR_EVENTS_SCOPE],
  serverConfigured: true,
};

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CalendarAgendaPage', () => {
  it('renders a connect route when Google is not linked', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: false,
      grantedScopes: [],
      serverConfigured: true,
    });

    render(<CalendarAgendaPage />);

    expect(await screen.findByText('Connect Google to use Calendar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect Google/i })).toBeInTheDocument();
    expect(mockApi.listGoogleCalendarEvents).not.toHaveBeenCalled();
  });

  it('shows an inline Enable Calendar affordance when connected but missing consent', async () => {
    // Connected to Google but the calendar.events scope was never granted →
    // incremental consent. The pane must surface "Enable Calendar" and must NOT
    // try to list events.
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: ['https://www.googleapis.com/auth/gmail.send'],
      serverConfigured: true,
    });

    render(<CalendarAgendaPage />);

    expect(await screen.findByText('Enable Calendar access')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enable Calendar/i })).toBeInTheDocument();
    expect(mockApi.listGoogleCalendarEvents).not.toHaveBeenCalled();
  });

  it('creates an event with local dateTimes and an explicit timeZone', async () => {
    mockApi.getGoogleStatus
      .mockResolvedValueOnce({
        connected: true,
        email: 'person@example.com',
        grantedScopes: [CALENDAR_EVENTS_SCOPE],
        serverConfigured: true,
      })
      .mockResolvedValueOnce({
        connected: true,
        email: 'person@example.com',
        grantedScopes: [CALENDAR_EVENTS_SCOPE],
        serverConfigured: true,
      });
    routeLists([
      [],
      [
        {
          id: 'event-1',
          summary: 'Planning',
          start: { dateTime: '2026-07-01T10:00:00Z' },
          end: { dateTime: '2026-07-01T11:00:00Z' },
        },
      ],
    ]);
    mockApi.createGoogleCalendarEvent.mockResolvedValueOnce({ event: { id: 'event-1' } });

    render(<CalendarAgendaPage />);

    await screen.findByText('No events this week');
    fireEvent.click(screen.getAllByRole('button', { name: /Create event/i })[0]);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Planning' } });
    fireEvent.change(screen.getByLabelText('Starts'), {
      target: { value: '2026-07-01T10:00' },
    });
    fireEvent.change(screen.getByLabelText('Ends'), {
      target: { value: '2026-07-01T11:00' },
    });
    fireEvent.change(screen.getByLabelText('Time zone'), {
      target: { value: 'America/Los_Angeles' },
    });
    const createButtons = screen.getAllByRole('button', { name: /Create event/i });
    fireEvent.click(createButtons[createButtons.length - 1]);

    await waitFor(() => {
      expect(mockApi.createGoogleCalendarEvent).toHaveBeenCalledWith(
        {
          calendarId: 'primary',
          event: expect.objectContaining({
            summary: 'Planning',
            start: {
              dateTime: '2026-07-01T10:00:00',
              timeZone: 'America/Los_Angeles',
            },
            end: {
              dateTime: '2026-07-01T11:00:00',
              timeZone: 'America/Los_Angeles',
            },
          }),
        },
        { account: undefined },
      );
    });
    expect(await screen.findByText('Planning')).toBeInTheDocument();
  });

  it('captures an event into a personal todo with capture provenance', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [CALENDAR_EVENTS_SCOPE],
      serverConfigured: true,
    });
    routeLists([
      [
        {
          id: 'event-42',
          summary: 'Design sync',
          location: 'Room 4',
          htmlLink: 'https://calendar.google.com/event?eid=event-42',
          start: { dateTime: '2026-07-09T10:00:00Z' },
          end: { dateTime: '2026-07-09T11:00:00Z' },
        },
      ],
    ]);
    mockApi.createTodo.mockResolvedValueOnce({ todo: { id: 'todo-1' } });

    render(<CalendarAgendaPage />);

    const captureButton = await screen.findByRole('button', { name: /Todo/i });
    fireEvent.click(captureButton);

    await waitFor(() => {
      expect(mockApi.createTodo).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Design sync',
          notes: 'At Room 4',
          sourceType: 'calendar',
          sourceId: 'event-42',
          sourceMeta: expect.objectContaining({
            kind: 'calendar',
            eventId: 'event-42',
            deepLink: 'https://calendar.google.com/event?eid=event-42',
          }),
        }),
      );
    });
    // The button flips to an "Added" confirmation after a successful capture.
    expect(await screen.findByText('Added')).toBeInTheDocument();
  });

  describe('month view', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 9, 16, 12));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('renders a month grid below the agenda with events on their days', async () => {
      mockApi.getGoogleStatus.mockResolvedValue(CONNECTED);
      routeLists(
        [[]],
        [
          {
            id: 'offsite',
            summary: 'Team offsite',
            start: { date: '2026-10-21' },
            end: { date: '2026-10-23' },
          },
        ],
      );

      render(<CalendarAgendaPage />);

      expect(await screen.findByText('October 2026')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('calendar-day-2026-10-21')).toHaveTextContent('Team offsite');
      });
      expect(screen.getByTestId('calendar-day-2026-10-22')).toHaveTextContent('Team offsite');
      expect(screen.getByTestId('calendar-day-2026-10-23')).not.toHaveTextContent('Team offsite');
      // The agenda empty state and the grid render together.
      expect(screen.getByText('No events this week')).toBeInTheDocument();

      const monthCall = mockApi.listGoogleCalendarEvents.mock.calls.find(
        ([p]) => p.maxResults === MONTH_MAX_RESULTS,
      )?.[0];
      expect(new Date(monthCall.timeMin).getTime()).toBe(new Date(2026, 8, 27).getTime());
      expect(new Date(monthCall.timeMax).getTime()).toBe(new Date(2026, 10, 8).getTime());

      fireEvent.click(screen.getAllByRole('button', { name: 'Team offsite' })[0]);
      expect(await screen.findByText('Edit event')).toBeInTheDocument();
    });

    it('fetches the next month when navigating forward', async () => {
      mockApi.getGoogleStatus.mockResolvedValue(CONNECTED);
      routeLists([[]]);

      render(<CalendarAgendaPage />);
      await screen.findByText('October 2026');
      fireEvent.click(screen.getByRole('button', { name: 'Next month' }));

      expect(await screen.findByText('November 2026')).toBeInTheDocument();
      await waitFor(() => {
        const monthCalls = mockApi.listGoogleCalendarEvents.mock.calls.filter(
          ([p]) => p.maxResults === MONTH_MAX_RESULTS,
        );
        expect(new Date(monthCalls[monthCalls.length - 1][0].timeMin).getTime()).toBe(
          new Date(2026, 10, 1).getTime(),
        );
      });
    });

    it('shows a month-specific error with retry when only the month request fails', async () => {
      mockApi.getGoogleStatus.mockResolvedValue(CONNECTED);
      let monthAttempts = 0;
      mockApi.listGoogleCalendarEvents.mockImplementation(async (params: any) => {
        if (params.maxResults !== MONTH_MAX_RESULTS) {
          return {
            events: [
              {
                id: 'agenda-1',
                summary: 'Agenda item',
                start: { dateTime: '2026-10-17T10:00:00Z' },
              },
            ],
          };
        }
        monthAttempts += 1;
        if (monthAttempts === 1) throw new Error('Google Calendar unavailable');
        return {
          events: [{ id: 'm-1', summary: 'Recovered', start: { date: '2026-10-20' } }],
        };
      });

      render(<CalendarAgendaPage />);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('October 2026');
      expect(alert).toHaveTextContent('Google Calendar unavailable');
      // The agenda loaded fine, so its own error banner stays quiet.
      expect(screen.getAllByText('Agenda item').length).toBeGreaterThan(0);
      expect(screen.getAllByRole('alert')).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: /Retry/i }));

      await waitFor(() => {
        expect(screen.getByTestId('calendar-day-2026-10-20')).toHaveTextContent('Recovered');
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('hides the grid until Calendar access is granted', async () => {
      mockApi.getGoogleStatus.mockResolvedValue({ ...CONNECTED, grantedScopes: [] });

      render(<CalendarAgendaPage />);
      await screen.findByText('Enable Calendar access');
      expect(screen.queryByLabelText('Month view')).not.toBeInTheDocument();
    });
  });

  describe('multiple Google accounts', () => {
    const MULTI = {
      connected: true,
      email: 'me@work.com',
      grantedScopes: [CALENDAR_EVENTS_SCOPE],
      serverConfigured: true,
      defaultAccountId: 'work',
      accounts: [
        {
          accountId: 'work',
          email: 'me@work.com',
          isDefault: true,
          grantedScopes: [CALENDAR_EVENTS_SCOPE],
        },
        {
          accountId: 'home',
          email: 'me@home.com',
          isDefault: false,
          grantedScopes: [CALENDAR_EVENTS_SCOPE],
        },
        { accountId: 'side', email: 'side@x.com', isDefault: false, grantedScopes: [] },
      ],
    };
    const eventsByAccount: Record<string, any[]> = {
      work: [
        {
          id: 'w1',
          summary: 'Work standup',
          start: { dateTime: '2026-07-01T15:00:00Z' },
          end: { dateTime: '2026-07-01T15:15:00Z' },
        },
      ],
      home: [
        {
          id: 'h1',
          summary: 'Dentist',
          start: { dateTime: '2026-07-01T09:00:00Z' },
          end: { dateTime: '2026-07-01T10:00:00Z' },
        },
      ],
    };

    beforeEach(() => {
      window.localStorage.clear();
      mockApi.getGoogleStatus.mockResolvedValue(MULTI);
      mockApi.listGoogleCalendarEvents.mockImplementation(async (params: any) => ({
        events: eventsByAccount[params.account] ?? [],
      }));
    });

    it('merges events from every calendar-enabled account in start order, labelled by account', async () => {
      render(<CalendarAgendaPage />);

      expect(await screen.findByText('Dentist')).toBeInTheDocument();
      const titles = screen
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent)
        .filter((t) => t === 'Dentist' || t === 'Work standup');
      expect(titles).toEqual(['Dentist', 'Work standup']);
      // Only accounts holding the Calendar scope are read.
      const accountsRead = new Set(
        mockApi.listGoogleCalendarEvents.mock.calls.map(([p]: any[]) => p.account),
      );
      expect([...accountsRead].sort()).toEqual(['home', 'work']);
      // The account without Calendar access gets an Enable affordance instead of a toggle.
      expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
      expect(screen.getAllByText('me@home.com').length).toBeGreaterThan(0);
    });

    it('hides an account when its toggle is switched off and remembers it', async () => {
      render(<CalendarAgendaPage />);
      expect(await screen.findByText('Dentist')).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Show me@home.com'));

      expect(screen.queryByText('Dentist')).not.toBeInTheDocument();
      expect(screen.getByText('Work standup')).toBeInTheDocument();
      expect(window.localStorage.getItem('agent-hub.calendar.hiddenAccounts')).toBe('["home"]');
    });

    it('asks which account a new event goes to, preselecting the default', async () => {
      mockApi.createGoogleCalendarEvent.mockResolvedValue({});
      render(<CalendarAgendaPage />);
      expect(await screen.findByText('Dentist')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Create event/i }));
      const select = screen.getByLabelText('Account') as HTMLSelectElement;
      expect(select.value).toBe('work');
      // Only calendar-enabled accounts are offered.
      expect([...select.options].map((o) => o.value)).toEqual(['work', 'home']);

      fireEvent.change(select, { target: { value: 'home' } });
      fireEvent.change(screen.getByRole('textbox', { name: /Title/i }), {
        target: { value: 'Groceries' },
      });
      const createButtons = screen.getAllByRole('button', { name: /Create event/i });
      fireEvent.click(createButtons[createButtons.length - 1]);

      await waitFor(() =>
        expect(mockApi.createGoogleCalendarEvent).toHaveBeenCalledWith(
          expect.objectContaining({ calendarId: 'primary' }),
          { account: 'home' },
        ),
      );
    });

    it('keeps a reopened modal open when an earlier save finishes', async () => {
      let finishSave: (v: unknown) => void = () => {};
      mockApi.updateGoogleCalendarEvent.mockImplementationOnce(
        () => new Promise((resolve) => (finishSave = resolve)),
      );
      render(<CalendarAgendaPage />);
      expect(await screen.findByText('Dentist')).toBeInTheDocument();

      // Save an edit, cancel while it is in flight, then start a new event.
      fireEvent.click(screen.getAllByRole('button', { name: /Edit/i })[0]);
      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: /Create event/i }));
      fireEvent.change(screen.getByRole('textbox', { name: /Title/i }), {
        target: { value: 'Draft' },
      });

      finishSave({});
      await waitFor(() =>
        expect(mockApi.listGoogleCalendarEvents.mock.calls.length).toBeGreaterThan(4),
      );
      expect(screen.getByLabelText('Account')).toBeInTheDocument();
      expect((screen.getByRole('textbox', { name: /Title/i }) as HTMLInputElement).value).toBe(
        'Draft',
      );
    });

    it('saves an edit to the account that owns the event', async () => {
      mockApi.updateGoogleCalendarEvent.mockResolvedValue({});
      render(<CalendarAgendaPage />);
      expect(await screen.findByText('Dentist')).toBeInTheDocument();

      fireEvent.click(screen.getAllByRole('button', { name: /Edit/i })[0]);
      expect(screen.queryByLabelText('Account')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      await waitFor(() =>
        expect(mockApi.updateGoogleCalendarEvent).toHaveBeenCalledWith(
          'h1',
          expect.objectContaining({ calendarId: 'primary' }),
          { account: 'home' },
        ),
      );
    });
  });

  it('ignores a stored hidden account once it is the only one linked', async () => {
    window.localStorage.setItem('agent-hub.calendar.hiddenAccounts', '["work"]');
    mockApi.getGoogleStatus.mockResolvedValue({
      ...CONNECTED,
      defaultAccountId: 'work',
      accounts: [
        {
          accountId: 'work',
          email: 'person@example.com',
          isDefault: true,
          grantedScopes: [CALENDAR_EVENTS_SCOPE],
        },
      ],
    });
    mockApi.listGoogleCalendarEvents.mockResolvedValue({
      events: [
        {
          id: 'w1',
          summary: 'Still visible',
          start: { dateTime: '2026-07-01T15:00:00Z' },
          end: { dateTime: '2026-07-01T16:00:00Z' },
        },
      ],
    });
    render(<CalendarAgendaPage />);
    expect(await screen.findByText('Still visible')).toBeInTheDocument();
    expect(screen.queryByText('All accounts hidden')).not.toBeInTheDocument();
  });
});

describe('CalendarAgendaPage: several calendars', () => {
  const LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
  const WITH_LIST = { ...CONNECTED, grantedScopes: [CALENDAR_EVENTS_SCOPE, LIST_SCOPE] };
  const CALENDARS = [
    {
      id: 'person@example.com',
      summary: 'Ryan',
      primary: true,
      selected: true,
      accessRole: 'owner',
      backgroundColor: '#9fe1e7',
    },
    {
      id: 'spouse@gmail.com',
      summary: 'Sepideh',
      primary: false,
      selected: true,
      accessRole: 'reader',
      backgroundColor: '#16a765',
    },
    {
      id: 'holidays@group.v.calendar.google.com',
      summary: 'Holidays',
      primary: false,
      selected: false,
      accessRole: 'reader',
      backgroundColor: '#cccccc',
    },
  ];
  const EVENTS: Record<string, any[]> = {
    'person@example.com': [
      {
        id: 'mine',
        summary: 'My meeting',
        start: { dateTime: '2026-07-01T10:00:00Z' },
        end: { dateTime: '2026-07-01T11:00:00Z' },
      },
    ],
    'spouse@gmail.com': [
      {
        id: 'hers',
        summary: 'Pure Barre',
        start: { dateTime: '2026-07-01T12:00:00Z' },
        end: { dateTime: '2026-07-01T13:00:00Z' },
      },
    ],
    'holidays@group.v.calendar.google.com': [
      {
        id: 'holiday',
        summary: 'Some holiday',
        start: { date: '2026-07-02' },
        end: { date: '2026-07-03' },
      },
    ],
  };

  beforeEach(() => {
    window.localStorage.clear();
    mockApi.getGoogleStatus.mockResolvedValue(WITH_LIST);
    mockApi.listGoogleCalendars.mockResolvedValue({ calendars: CALENDARS });
    mockApi.listGoogleCalendarEvents.mockImplementation(async (params: any) => {
      if (params.maxResults === MONTH_MAX_RESULTS) return { events: [] };
      return { events: EVENTS[params.calendarId] ?? [] };
    });
  });

  it('shows events from calendars checked in Google and hides unchecked ones', async () => {
    render(<CalendarAgendaPage />);

    expect(await screen.findByText('Pure Barre')).toBeInTheDocument();
    expect(screen.getByText('My meeting')).toBeInTheDocument();
    expect(screen.queryByText('Some holiday')).not.toBeInTheDocument();
    // The primary is read by id from the list; nothing falls back to 'primary'.
    expect(mockApi.listGoogleCalendarEvents).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'spouse@gmail.com' }),
    );
    expect(screen.getByLabelText('Show calendar Sepideh')).toBeChecked();
    expect(screen.getByLabelText('Show calendar Holidays')).not.toBeChecked();
  });

  it('toggles a calendar locally and remembers the choice', async () => {
    render(<CalendarAgendaPage />);
    await screen.findByText('Pure Barre');

    fireEvent.click(screen.getByLabelText('Show calendar Sepideh'));
    expect(screen.queryByText('Pure Barre')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show calendar Holidays'));
    expect(screen.getByText('Some holiday')).toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem('agent-hub.calendar.calendarVisibility') || '{}'),
    ).toEqual({
      '|spouse@gmail.com': false,
      '|holidays@group.v.calendar.google.com': true,
    });
  });

  it('offers no Edit on read-only calendars and saves edits to the calendar they came from', async () => {
    mockApi.listGoogleCalendars.mockResolvedValue({
      calendars: [{ ...CALENDARS[0] }, { ...CALENDARS[1], accessRole: 'writer' }],
    });
    mockApi.updateGoogleCalendarEvent.mockResolvedValue({ event: { id: 'hers' } });
    const { unmount } = render(<CalendarAgendaPage />);
    await screen.findByText('Pure Barre');
    expect(screen.getAllByRole('button', { name: /^Edit$/ })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/ })[1]);
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() =>
      expect(mockApi.updateGoogleCalendarEvent).toHaveBeenCalledWith(
        'hers',
        expect.objectContaining({ calendarId: 'spouse@gmail.com' }),
        expect.anything(),
      ),
    );
    unmount();

    mockApi.listGoogleCalendars.mockResolvedValue({ calendars: CALENDARS });
    render(<CalendarAgendaPage />);
    await screen.findByText('Pure Barre');
    expect(screen.getAllByRole('button', { name: /^Edit$/ })).toHaveLength(1);
  });

  it('shows the sole remaining calendar even if it was hidden while there were two', async () => {
    window.localStorage.setItem(
      'agent-hub.calendar.calendarVisibility',
      JSON.stringify({ '|person@example.com': false }),
    );
    // The other calendar was unsubscribed; only the (hidden) primary is left.
    mockApi.listGoogleCalendars.mockResolvedValue({ calendars: [CALENDARS[0]] });
    render(<CalendarAgendaPage />);

    expect(await screen.findByText('My meeting')).toBeInTheDocument();
    expect(screen.queryByLabelText('Show calendar Ryan')).not.toBeInTheDocument();
    expect(screen.queryByText('All calendars hidden')).not.toBeInTheDocument();
  });

  it('hides a primary calendar the user unchecked in Google', async () => {
    mockApi.listGoogleCalendars.mockResolvedValue({
      calendars: [{ ...CALENDARS[0], selected: false }, CALENDARS[1]],
    });
    render(<CalendarAgendaPage />);

    expect(await screen.findByText('Pure Barre')).toBeInTheDocument();
    expect(screen.queryByText('My meeting')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Show calendar Ryan')).not.toBeChecked();
  });

  it('month events follow calendar changes after Refresh when the ids stay the same', async () => {
    // An event inside the current month so the grid renders it.
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 15, 12).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth(), 15, 13).toISOString();
    const hers = {
      id: 'hers',
      summary: 'Pure Barre',
      start: { dateTime: start },
      end: { dateTime: end },
    };
    mockApi.listGoogleCalendarEvents.mockImplementation(async (params: any) => ({
      events: params.calendarId === 'spouse@gmail.com' ? [hers] : [],
    }));
    mockApi.listGoogleCalendars
      .mockResolvedValueOnce({ calendars: [CALENDARS[0], CALENDARS[1]] })
      .mockResolvedValue({
        calendars: [CALENDARS[0], { ...CALENDARS[1], summary: 'Sepi', accessRole: 'writer' }],
      });
    render(<CalendarAgendaPage />);

    // Read-only at first: the month entry opens without Save.
    fireEvent.click(await screen.findByTitle('Pure Barre'));
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByLabelText('Show calendar Sepi')).toBeInTheDocument();

    // Same calendar id, now writable and renamed: the month entry reflects it.
    fireEvent.click(screen.getByTitle('Pure Barre'));
    expect(screen.getByRole('button', { name: /Save changes/i })).toBeInTheDocument();
    expect(screen.getByText(/^Sepi · person@example.com/)).toBeInTheDocument();
  });

  it('warns when the calendar list fails but the primary still loads', async () => {
    mockApi.listGoogleCalendars.mockRejectedValue(
      Object.assign(new Error('Google Calendar rate limit exceeded'), {
        code: 'google_calendar_rate_limited',
      }),
    );
    mockApi.listGoogleCalendarEvents.mockImplementation(async (params: any) => {
      if (params.maxResults === MONTH_MAX_RESULTS) return { events: [] };
      return { events: params.calendarId ? [] : EVENTS['person@example.com'] };
    });
    render(<CalendarAgendaPage />);

    expect(await screen.findByText('My meeting')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      "Couldn't list calendars for person@example.com (Google Calendar rate limit exceeded); showing its primary calendar only.",
    );
    // Not a scope problem, so no re-consent prompt.
    expect(screen.queryByRole('button', { name: 'Show your other calendars' })).toBeNull();
  });

  it('edits public events on a writerWithoutPrivateAccess calendar but not private ones', async () => {
    mockApi.listGoogleCalendars.mockResolvedValue({
      calendars: [
        { ...CALENDARS[0], accessRole: 'reader' },
        { ...CALENDARS[1], accessRole: 'writerWithoutPrivateAccess' },
      ],
    });
    mockApi.listGoogleCalendarEvents.mockImplementation(async (params: any) => {
      if (params.maxResults === MONTH_MAX_RESULTS) return { events: [] };
      if (params.calendarId !== 'spouse@gmail.com') return { events: [] };
      return {
        events: [
          { ...EVENTS['spouse@gmail.com'][0], visibility: 'default' },
          {
            id: 'secret',
            summary: 'Private thing',
            visibility: 'private',
            start: { dateTime: '2026-07-01T14:00:00Z' },
            end: { dateTime: '2026-07-01T15:00:00Z' },
          },
        ],
      };
    });
    render(<CalendarAgendaPage />);

    await screen.findByText('Pure Barre');
    expect(screen.getByText('Private thing')).toBeInTheDocument();
    // Only the non-private event is editable.
    expect(screen.getAllByRole('button', { name: /^Edit$/ })).toHaveLength(1);
  });

  it('keeps showing the primary and offers to list calendars when the scope is missing', async () => {
    mockApi.getGoogleStatus.mockResolvedValue(CONNECTED);
    mockApi.listGoogleCalendarEvents.mockImplementation(async (params: any) => {
      if (params.maxResults === MONTH_MAX_RESULTS) return { events: [] };
      return { events: params.calendarId ? [] : EVENTS['person@example.com'] };
    });
    mockApi.startGoogleOAuth.mockResolvedValue({ authorizeUrl: 'about:blank' });
    render(<CalendarAgendaPage />);

    expect(await screen.findByText('My meeting')).toBeInTheDocument();
    expect(mockApi.listGoogleCalendars).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show your other calendars' }));
    await waitFor(() =>
      expect(mockApi.startGoogleOAuth).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: [CALENDAR_EVENTS_SCOPE, LIST_SCOPE] }),
      ),
    );
  });
});
