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
      { columnName: 'To Do', count: 20 },
      { columnName: 'In Progress', count: 6 },
      { columnName: 'Done', count: 5 },
    ],
    byPriority: { urgent: 2, high: 4, medium: 8, low: 3 },
  },
  recentActivity: [
    {
      type: 'card_created',
      id: 'c1',
      title: 'Add dashboard view',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      meta: { column: 'To Do', priority: 'medium', projectId: 'proj-dash' },
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
    {
      type: 'pr_created',
      id: 'pr1',
      title: 'PR #501: Ship activity feed',
      timestamp: new Date(Date.now() - 45 * 60_000).toISOString(),
      meta: { projectId: 'p1', prUrl: 'https://github.com/acme/app/pull/501', prNumber: 501 },
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
    try {
      if (typeof localStorage !== 'undefined') localStorage.clear();
    } catch {
      /* ignore */
    }
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
    expect(byColumn).toHaveTextContent('To Do');
    expect(byColumn).toHaveTextContent('In Progress');
    expect(byColumn).toHaveTextContent('Done');
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
    expect(feed).toHaveTextContent('PR #501: Ship activity feed');
    // Per-type label
    expect(feed).toHaveTextContent('Card created');
    expect(feed).toHaveTextContent('Session started');
    expect(feed).toHaveTextContent('Escalation');
    expect(feed).toHaveTextContent('PR opened');
  });

  it('calls onNewProject when the dashboard New Project CTA is clicked', async () => {
    const onNewProject = vi.fn();
    render(<DashboardView orgId="org-1" onNewProject={onNewProject} />);

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-new-project-cta')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('dashboard-new-project-cta'));
    expect(onNewProject).toHaveBeenCalledTimes(1);
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

  it('prefers onOpenPulls over onOpenKanban for card rows when both are provided', async () => {
    const onOpenKanban = vi.fn();
    const onOpenPulls = vi.fn();
    render(<DashboardView orgId="org-1" onOpenKanban={onOpenKanban} onOpenPulls={onOpenPulls} />);

    await waitFor(() => {
      expect(screen.getByText('Add dashboard view')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add dashboard view'));
    expect(onOpenPulls).toHaveBeenCalledWith('proj-dash');
    expect(onOpenKanban).not.toHaveBeenCalled();
  });

  it('renders activity type filter chips with counts and an "All" reset', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('recent-activity-filter')).toBeInTheDocument();
    });

    // "All" chip is active by default.
    const allChip = screen.getByTestId('recent-activity-filter-all');
    expect(allChip).toHaveAttribute('aria-pressed', 'true');

    // Every canonical type has a chip and a count badge.
    for (const key of [
      'card_created',
      'card_updated',
      'session_created',
      'escalation',
      'pr_created',
    ]) {
      expect(screen.getByTestId(`recent-activity-filter-${key}`)).toBeInTheDocument();
    }

    // Sample data contains 1 of each of card_created, session_created,
    // escalation, pr_created. Verify the count badges render.
    const cardCreatedChip = screen.getByTestId('recent-activity-filter-card_created');
    expect(cardCreatedChip).toHaveTextContent('1');
    const cardUpdatedChip = screen.getByTestId('recent-activity-filter-card_updated');
    expect(cardUpdatedChip).toHaveTextContent('0');
  });

  it('narrows the visible activity to the selected types', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Add dashboard view')).toBeInTheDocument();
    });

    // Pick the "Session started" filter only.
    fireEvent.click(screen.getByTestId('recent-activity-filter-session_created'));

    const feed = screen.getByTestId('recent-activity');
    // Session row remains visible.
    expect(feed).toHaveTextContent('Hub Frontend session');
    // Other types are filtered out.
    expect(feed).not.toHaveTextContent('Add dashboard view');
    expect(feed).not.toHaveTextContent('PR stuck in review');
    expect(feed).not.toHaveTextContent('PR #501: Ship activity feed');
    // The "All" chip is no longer pressed.
    expect(screen.getByTestId('recent-activity-filter-all')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('supports multi-select and the "All" reset', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Add dashboard view')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('recent-activity-filter-session_created'));
    fireEvent.click(screen.getByTestId('recent-activity-filter-escalation'));

    const feed = screen.getByTestId('recent-activity');
    expect(feed).toHaveTextContent('Hub Frontend session');
    expect(feed).toHaveTextContent('PR stuck in review');
    expect(feed).not.toHaveTextContent('Add dashboard view');
    expect(feed).not.toHaveTextContent('PR #501: Ship activity feed');

    // Clicking "All" clears the narrowing.
    fireEvent.click(screen.getByTestId('recent-activity-filter-all'));
    expect(feed).toHaveTextContent('Add dashboard view');
    expect(feed).toHaveTextContent('PR #501: Ship activity feed');
  });

  it('shows an empty-state message when the filter matches nothing', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Add dashboard view')).toBeInTheDocument();
    });

    // The sample has 0 card_updated events; selecting only that bucket
    // should produce an empty filtered feed.
    fireEvent.click(screen.getByTestId('recent-activity-filter-card_updated'));
    expect(screen.getByTestId('recent-activity')).toHaveTextContent(
      'No activity matches the selected filters.',
    );
  });

  it('persists the filter selection to localStorage', async () => {
    const { unmount } = render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('recent-activity-filter')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('recent-activity-filter-session_created'));

    expect(JSON.parse(localStorage.getItem('dashboard.activityFilter.v1'))).toEqual([
      'session_created',
    ]);

    unmount();

    // Re-mount: the previously-saved filter applies on first render.
    render(<DashboardView orgId="org-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('recent-activity-filter-session_created')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
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

/**
 * The dashboard account chip is the only entry point to Account settings
 * from the dashboard. It reads the username from the cached JWT record
 * (`agent-hub-jwt` in localStorage) and routes to `settings:account`, which
 * App.jsx parses into `initialTab`. A regression on either side would
 * silently send the user to the wrong tab, so guard the contract here.
 */
describe('DashboardView — account profile chip', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(SAMPLE) })),
    );
    try {
      if (typeof localStorage !== 'undefined') localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const setUser = (username) =>
    localStorage.setItem('agent-hub-jwt', JSON.stringify({ token: 't', user: { username } }));

  it('renders the username from the cached auth record', () => {
    setUser('alice');
    render(<DashboardView orgId="org-1" onNavigate={() => {}} />);
    expect(screen.getByTitle('Account settings')).toHaveTextContent('alice');
  });

  it("falls back to 'Account' when the auth record is missing", () => {
    render(<DashboardView orgId="org-1" onNavigate={() => {}} />);
    expect(screen.getByTitle('Account settings')).toHaveTextContent('Account');
  });

  it("navigates to 'settings:account' when the chip is clicked", () => {
    setUser('alice');
    const onNavigate = vi.fn();
    render(<DashboardView orgId="org-1" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTitle('Account settings'));
    expect(onNavigate).toHaveBeenCalledWith('settings:account');
  });
});
