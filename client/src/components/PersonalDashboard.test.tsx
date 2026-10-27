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
      mail: {
        scopeGranted: false,
        unread: null,
        starred: null,
        important: null,
        messages: [],
        error: null,
      },
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

  it('renders live Calendar events and a recent-mail list when connected with scopes', async () => {
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
                accountId: 'acc-1',
                accountEmail: 'me@example.com',
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
          mail: {
            scopeGranted: true,
            unread: 7,
            starred: 2,
            important: 3,
            messages: [
              {
                accountId: 'acc-1',
                accountEmail: 'me@example.com',
                id: 'm1',
                threadId: 'th1',
                from: 'Jane Doe <jane@example.com>',
                subject: 'Lunch tomorrow?',
                snippet: 'Are you free…',
                date: 'Tue, 07 Jul 2026 08:00:00 +0000',
                internalDate: '1783065600000',
                unread: true,
              },
              {
                accountId: 'acc-1',
                accountEmail: 'me@example.com',
                id: 'm2',
                threadId: 'th2',
                from: 'billing@stripe.com',
                subject: 'Your receipt',
                snippet: 'Thanks for your payment',
                date: 'Mon, 06 Jul 2026 12:00:00 +0000',
                internalDate: '1782993600000',
                unread: false,
              },
            ],
            error: null,
          },
        },
      }),
    );

    render(
      <PersonalDashboard onNavigate={noop} onOpenAccountSettings={noop} onOpenKanban={noop} />,
    );

    await waitFor(() => expect(screen.getByText('Standup')).toBeInTheDocument());
    // The Gmail pane now lists recent senders + subjects instead of counters.
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Lunch tomorrow?')).toBeInTheDocument();
    expect(screen.getByText('billing@stripe.com')).toBeInTheDocument();
    expect(screen.getByText('Your receipt')).toBeInTheDocument();
    // The old counter labels are gone.
    expect(screen.queryByText('Starred')).not.toBeInTheDocument();
    expect(screen.queryByText('Important')).not.toBeInTheDocument();
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
          mail: {
            scopeGranted: false,
            unread: null,
            starred: null,
            important: null,
            messages: [],
            error: null,
          },
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

  it('renders without crashing when the dashboard payload omits the todos block', async () => {
    // Regression guard: Hub is now the default landing view, so a sparse or
    // partial `/api/me/dashboard` response (here, no `todos`) must not throw
    // out of render and take the whole App tree down. Previously `data?.todos.open`
    // dereferenced `undefined.open`.
    vi.mocked(api.getMeDashboard).mockResolvedValue({} as unknown as MeDashboardWire);

    render(
      <PersonalDashboard onNavigate={noop} onOpenAccountSettings={noop} onOpenKanban={noop} />,
    );

    // The Dashboard heading renders instead of a thrown error.
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    // Todos pane still renders its empty state rather than crashing.
    expect(screen.getByText('Todos')).toBeInTheDocument();
  });

  it('merges events and mail from every linked account and flags the ones left out', async () => {
    const account = (accountId: string, email: string, over = {}) => ({
      accountId,
      email,
      isDefault: accountId === 'work',
      reconnectRequired: false,
      calendarScopeGranted: true,
      mailScopeGranted: true,
      calendarError: null,
      mailError: null,
      unread: null,
      starred: null,
      important: null,
      ...over,
    });
    const event = (accountId: string, accountEmail: string, id: string, summary: string) => ({
      accountId,
      accountEmail,
      id,
      summary,
      location: null,
      allDay: false,
      start: '2026-07-07T09:00:00.000Z',
      end: null,
      htmlLink: null,
      hangoutLink: null,
    });
    vi.mocked(api.getMeDashboard).mockResolvedValue(
      payload({
        google: {
          configured: true,
          connected: true,
          email: 'me@work.com',
          reconnectRequired: false,
          calendar: {
            scopeGranted: true,
            date: '2026-07-07',
            timeZone: 'UTC',
            events: [
              event('work', 'me@work.com', 'e1', 'Work standup'),
              event('home', 'me@home.com', 'e1', 'Dentist'),
            ],
            error: null,
          },
          mail: {
            scopeGranted: true,
            unread: 1,
            starred: 0,
            important: 0,
            messages: [],
            error: null,
          },
          accounts: [
            account('work', 'me@work.com'),
            account('home', 'me@home.com', { mailScopeGranted: false }),
            account('old', 'old@x.com', { reconnectRequired: true }),
          ],
        },
      }),
    );

    render(
      <PersonalDashboard onNavigate={noop} onOpenAccountSettings={noop} onOpenKanban={noop} />,
    );

    await waitFor(() => expect(screen.getByText('Work standup')).toBeInTheDocument());
    // Same event id in two accounts still renders twice, each marked by account.
    expect(screen.getByText('Dentist')).toBeInTheDocument();
    expect(screen.getByLabelText('me@home.com')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-calendar-account-notices')).toHaveTextContent(
      'old@x.com: reconnect to include it',
    );
    expect(screen.getByTestId('dashboard-mail-account-notices')).toHaveTextContent(
      'me@home.com: Gmail access not granted',
    );
  });
});
