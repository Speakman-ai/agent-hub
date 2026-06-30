import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: vi.fn(),
    listGoogleCalendarEvents: vi.fn(),
    startGoogleOAuth: vi.fn(),
    createGoogleCalendarEvent: vi.fn(),
    updateGoogleCalendarEvent: vi.fn(),
  },
}));

import CalendarAgendaPage, { CALENDAR_EVENTS_SCOPE } from './CalendarAgendaPage';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

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

    render(<CalendarAgendaPage projectId="agent-hub" />);

    expect(await screen.findByText('Connect Google to use Calendar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect Google/i })).toBeInTheDocument();
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
    mockApi.listGoogleCalendarEvents.mockResolvedValueOnce({ events: [] }).mockResolvedValueOnce({
      events: [
        {
          id: 'event-1',
          summary: 'Planning',
          start: { dateTime: '2026-07-01T10:00:00Z' },
          end: { dateTime: '2026-07-01T11:00:00Z' },
        },
      ],
    });
    mockApi.createGoogleCalendarEvent.mockResolvedValueOnce({ event: { id: 'event-1' } });

    render(<CalendarAgendaPage projectId="agent-hub" />);

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
});
