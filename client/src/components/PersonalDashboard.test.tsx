import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PersonalDashboard from './PersonalDashboard';
import { api, type MeDashboardWire } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: { getMeDashboard: vi.fn() },
}));

function payload(overrides: Partial<MeDashboardWire> = {}): MeDashboardWire {
  return {
    generatedAt: '2026-07-07T12:00:00.000Z',
    work: {
      cards: [
        {
          id: 'c1',
          shortId: 42,
          title: 'Ship the dashboard',
          priority: 'high',
          columnId: 'col1',
          columnName: 'In Progress',
          isDone: false,
          projectId: 'agent-hub',
          projectName: 'Agent Hub',
          boardId: 'b1',
          epicId: null,
          prUrl: null,
          reviewStatus: null,
          sessionId: null,
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      counts: { total: 1, open: 1, byPriority: { urgent: 0, high: 1, medium: 0, low: 0 } },
    },
    todos: {
      open: [
        {
          id: 't1',
          userId: 'u1',
          title: 'Water the plants',
          notes: '',
          status: 'open',
          priority: 'medium',
          doDate: null,
          doStartAt: null,
          doEndAt: null,
          dueAt: null,
          position: 0,
          sourceType: 'manual',
          sourceId: null,
          sourceMeta: null,
          linkedType: null,
          linkedId: null,
          linkedCardId: null,
          linkedProjectId: null,
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      openCount: 1,
    },
    google: {
      configured: true,
      connected: false,
      email: null,
      reconnectRequired: false,
      calendar: { scopeGranted: false, date: null, timeZone: null, events: [], error: null },
      mail: { scopeGranted: false, unread: null, starred: null, important: null, error: null },
    },
    ...overrides,
  };
}

describe('PersonalDashboard', () => {
  const noop = () => {};

  beforeEach(() => {
    vi.mocked(api.getMeDashboard).mockReset();
  });

  it('renders My Work and Todos, and gates the Google panes with a connect affordance when disconnected', async () => {
    vi.mocked(api.getMeDashboard).mockResolvedValue(payload());

    render(
      <PersonalDashboard onNavigate={noop} onOpenAccountSettings={noop} onOpenKanban={noop} />,
    );

    // Non-Google panes render their data regardless of connection.
    await waitFor(() => expect(screen.getByText('Ship the dashboard')).toBeInTheDocument());
    expect(screen.getByText('Water the plants')).toBeInTheDocument();
    expect(screen.getByText('Agent Hub')).toBeInTheDocument();

    // Both Google panes show the connect affordance while disconnected.
    expect(screen.getAllByRole('button', { name: /connect google/i }).length).toBe(2);
    // No live Google data leaks through the gate.
    expect(screen.queryByText(/all day/i)).not.toBeInTheDocument();
  });

  it('renders live Calendar events and Gmail counts when connected with scopes', async () => {
    vi.mocked(api.getMeDashboard).mockResolvedValue(
      payload({
        google: {
          configured: true,
          connected: true,
          email: 'me@example.com',
          reconnectRequired: false,
          calendar: {
            scopeGranted: true,
            date: '2026-07-07',
            timeZone: 'UTC',
            events: [
              {
                id: 'e1',
                summary: 'Standup',
                location: null,
                allDay: false,
                start: '2026-07-07T09:00:00.000Z',
                end: '2026-07-07T09:15:00.000Z',
                htmlLink: null,
                hangoutLink: null,
              },
            ],
            error: null,
          },
          mail: { scopeGranted: true, unread: 7, starred: 2, important: 3, error: null },
        },
      }),
    );

    render(
      <PersonalDashboard onNavigate={noop} onOpenAccountSettings={noop} onOpenKanban={noop} />,
    );

    await waitFor(() => expect(screen.getByText('Standup')).toBeInTheDocument());
    // Gmail summary shows the unread count (also mirrored in the pane header).
    expect(screen.getAllByText('7').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Unread')).toBeInTheDocument();
    // No connect affordance once both surfaces are ready.
    expect(screen.queryByRole('button', { name: /connect google/i })).not.toBeInTheDocument();
  });

  it('shows an Enable affordance when connected but a surface scope is missing', async () => {
    vi.mocked(api.getMeDashboard).mockResolvedValue(
      payload({
        google: {
          configured: true,
          connected: true,
          email: 'me@example.com',
          reconnectRequired: false,
          calendar: { scopeGranted: false, date: null, timeZone: null, events: [], error: null },
          mail: { scopeGranted: false, unread: null, starred: null, important: null, error: null },
        },
      }),
    );

    render(
      <PersonalDashboard onNavigate={noop} onOpenAccountSettings={noop} onOpenKanban={noop} />,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /enable calendar/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /enable gmail/i })).toBeInTheDocument();
  });
});
