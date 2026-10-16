import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: vi.fn(),
    listGoogleCalendarEvents: vi.fn(),
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
      expect(mockApi.createGoogleCalendarEvent).toHaveBeenCalledWith({
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
      });
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
});
