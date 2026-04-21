import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import DashboardView from './DashboardView.jsx';

const SAMPLE = {
  orgId: 'org-1',
  orgName: 'Acme',
  isActive: true,
  headline: {
    projects: 4,
    agents: 9,
    sessions: 123,
    activeSessions: 2,
    openCards: 17,
    openPRs: 3,
    escalations: 1,
  },
  kanban: {
    totalBoards: 4,
    totalCards: 42,
    byColumn: [
      { columnName: 'Backlog', count: 20 },
      { columnName: 'In Progress', count: 6 },
      { columnName: 'Review', count: 5 },
    ],
    byPriority: { urgent: 2, high: 4, medium: 8, low: 3 },
  },
  recentActivity: [
    {
      type: 'card_created',
      id: 'c1',
      title: 'Add dashboard view',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      meta: { column: 'Backlog', priority: 'medium', projectId: 'proj-dash' },
    },
    {
      type: 'session_created',
      id: 's1',
      title: 'Hub Frontend session',
      timestamp: new Date(Date.now() - 30 * 60_000).toISOString(),
      meta: { agentId: 'a1' },
    },
    {
      type: 'escalation',
      id: 'e1',
      title: 'PR stuck in review',
      timestamp: new Date(Date.now() - 2 * 3600_000).toISOString(),
      meta: { projectId: 'p1', escalationType: 'pr_stuck' },
    },
  ],
};

describe('DashboardView', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(SAMPLE),
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the dashboard for the active org and renders the headline counters', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      // The dashboard's section heading appears once data has loaded.
      expect(screen.getByText('Acme')).toBeInTheDocument();
    });

    // fetch called against /orgs/:id/dashboard
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toMatch(/\/orgs\/org-1\/dashboard$/);

    // All seven headline tiles render with their values.
    expect(screen.getByTestId('headline-projects')).toHaveTextContent('4');
    expect(screen.getByTestId('headline-agents')).toHaveTextContent('9');
    expect(screen.getByTestId('headline-sessions')).toHaveTextContent('123');
    expect(screen.getByTestId('headline-activeSessions')).toHaveTextContent('2');
    expect(screen.getByTestId('headline-openCards')).toHaveTextContent('17');
    expect(screen.getByTestId('headline-openPRs')).toHaveTextContent('3');
    expect(screen.getByTestId('headline-escalations')).toHaveTextContent('1');
  });

  it('renders the kanban breakdown bars and priority counts', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('kanban-by-column')).toBeInTheDocument();
    });

    const byColumn = screen.getByTestId('kanban-by-column');
    expect(byColumn).toHaveTextContent('Backlog');
    expect(byColumn).toHaveTextContent('In Progress');
    expect(byColumn).toHaveTextContent('Review');
    // Largest count should be visible verbatim
    expect(byColumn).toHaveTextContent('20');

    const byPriority = screen.getByTestId('kanban-by-priority');
    // All four buckets always render even when zero — sanity check the
    // counts come through.
    expect(byPriority).toHaveTextContent('urgent');
    expect(byPriority).toHaveTextContent('high');
    expect(byPriority).toHaveTextContent('medium');
    expect(byPriority).toHaveTextContent('low');
    expect(byPriority).toHaveTextContent('2');
    expect(byPriority).toHaveTextContent('4');
    expect(byPriority).toHaveTextContent('8');
  });

  it('renders the recent activity feed with each item title', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('recent-activity')).toBeInTheDocument();
    });

    const feed = screen.getByTestId('recent-activity');
    expect(feed).toHaveTextContent('Add dashboard view');
    expect(feed).toHaveTextContent('Hub Frontend session');
    expect(feed).toHaveTextContent('PR stuck in review');
    // Per-type label
    expect(feed).toHaveTextContent('Card created');
    expect(feed).toHaveTextContent('Session started');
    expect(feed).toHaveTextContent('Escalation');
  });

  it('calls onOpenSession when a session activity row is clicked', async () => {
    const onOpenSession = vi.fn();
    render(<DashboardView orgId="org-1" onOpenSession={onOpenSession} />);

    await waitFor(() => {
      expect(screen.getByText('Hub Frontend session')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Hub Frontend session'));
    expect(onOpenSession).toHaveBeenCalledWith('a1', 's1');
  });

  it('calls onOpenKanban when a card activity row is clicked', async () => {
    const onOpenKanban = vi.fn();
    render(<DashboardView orgId="org-1" onOpenKanban={onOpenKanban} />);

    await waitFor(() => {
      expect(screen.getByText('Add dashboard view')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add dashboard view'));
    expect(onOpenKanban).toHaveBeenCalledWith('proj-dash');
  });

  it('shows an error message when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 409,
          json: () =>
            Promise.resolve({
              error: 'Org not active.',
              activeOrgId: 'other',
            }),
        }),
      ),
    );

    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Org not active.');
  });
});
