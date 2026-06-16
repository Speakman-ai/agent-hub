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
      { columnName: 'Review', count: 5 },
    ],
    byPriority: { urgent: 2, high: 4, medium: 8, low: 3 },
  },
  activeSessions: [
    {
      sessionId: 'sess-1',
      sessionName: 'Refactor stream parser',
      agentId: 'a1',
      agentName: 'Hub Backend',
      agentColor: '#22D3EE',
      engine: 'claude-code',
      model: 'claude-sonnet-4',
      prompt: 'Split the parser into modules',
      state: 'working',
      ownerUserId: 'u1',
      ownerName: 'alice',
      startedAt: new Date(Date.now() - 90_000).toISOString(),
      lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      sessionId: 'sess-2',
      sessionName: 'Awaiting review feedback',
      agentId: 'a2',
      agentName: 'Hub Frontend',
      agentColor: '#A78BFA',
      engine: 'claude-code',
      model: 'claude-sonnet-4',
      prompt: '',
      state: 'reviewing',
      ownerUserId: 'u2',
      ownerName: 'bob',
      startedAt: null,
      lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
  ],
  openPRs: [
    {
      key: 'card-pr-1',
      cardId: 'card-pr-1',
      projectId: 'proj-dash',
      projectName: 'Hub Web',
      prUrl: 'https://github.com/acme/app/pull/777',
      prNumber: 777,
      title: 'PR #777: Redesign the dashboard',
      cardTitle: 'Redesign the dashboard',
      authorAgent: 'Hub Frontend',
      priority: 'high',
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    },
    {
      // Native PR with no linked kanban card: cardId is null and the render
      // key falls back to the (unique) PR url.
      key: '/projects/proj-other/pulls/778',
      cardId: null,
      projectId: 'proj-other',
      projectName: 'Hub Server',
      prUrl: '/projects/proj-other/pulls/778',
      prNumber: 778,
      title: 'PR #778: Add open PRs panel',
      cardTitle: null,
      authorAgent: 'Hub Backend',
      priority: null,
      updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    },
  ],
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

  it('fetches the dashboard for the active org once data loads', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      // The dashboard's section heading appears once data has loaded.
      expect(screen.getByText('Acme')).toBeInTheDocument();
    });

    // fetch called against /orgs/:id/dashboard
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toMatch(/\/orgs\/org-1\/dashboard$/);
  });

  it('no longer renders the headline counter tiles', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Acme')).toBeInTheDocument();
    });

    // The counter cards were removed in the redesign.
    expect(screen.queryByTestId('headline-projects')).not.toBeInTheDocument();
    expect(screen.queryByTestId('headline-openPRs')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Headline counters')).not.toBeInTheDocument();
  });

  it('no longer renders the new project banner', async () => {
    const onNewProject = vi.fn();
    render(<DashboardView orgId="org-1" onNewProject={onNewProject} />);

    await waitFor(() => {
      expect(screen.getByText('Acme')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('dashboard-new-project-cta')).not.toBeInTheDocument();
  });

  it('renders active sessions above open PRs above the kanban breakdown', async () => {
    const { container } = render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('open-prs')).toBeInTheDocument();
    });

    const order = ['active-sessions', 'open-prs', 'kanban-by-column', 'recent-activity'];
    const positions = order.map((id) =>
      Array.prototype.indexOf.call(
        container.querySelectorAll('[data-testid]'),
        container.querySelector(`[data-testid="${id}"]`),
      ),
    );
    // Each section appears strictly before the next in DOM order.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i - 1]).toBeLessThan(positions[i]);
    }
  });

  it('renders the open PRs panel with each PR title, project, and author', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('open-prs')).toBeInTheDocument();
    });

    const panel = screen.getByTestId('open-prs');
    expect(panel).toHaveTextContent('PR #777: Redesign the dashboard');
    expect(panel).toHaveTextContent('PR #778: Add open PRs panel');
    expect(panel).toHaveTextContent('Hub Web');
    expect(panel).toHaveTextContent('Hub Backend');
    // Header count reflects the number of open PRs.
    expect(screen.getByText('2 open PRs')).toBeInTheDocument();
  });

  it('renders a native PR row with no linked card and opens the in-app Pulls view on click', async () => {
    const onOpenPulls = vi.fn();
    render(<DashboardView orgId="org-1" onOpenPulls={onOpenPulls} />);

    await waitFor(() => {
      expect(screen.getByText('PR #778: Add open PRs panel')).toBeInTheDocument();
    });

    // The cardId-null row still renders (stable key falls back to the url) and
    // its native url deep-links into the project's Pulls view.
    fireEvent.click(screen.getByText('PR #778: Add open PRs panel'));
    expect(onOpenPulls).toHaveBeenCalledWith('proj-other');
  });

  it('opens the external PR host when an open PR row is clicked', async () => {
    const onOpenExternalUrl = vi.fn();
    render(<DashboardView orgId="org-1" onOpenExternalUrl={onOpenExternalUrl} />);

    await waitFor(() => {
      expect(screen.getByText('PR #777: Redesign the dashboard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('PR #777: Redesign the dashboard'));
    expect(onOpenExternalUrl).toHaveBeenCalledWith('https://github.com/acme/app/pull/777');
  });

  it('shows an empty state when there are no open PRs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...SAMPLE, openPRs: [] }),
        }),
      ),
    );

    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('open-prs')).toBeInTheDocument();
    });
    expect(screen.getByText('No open pull requests.')).toBeInTheDocument();
    expect(screen.getByText('0 open PRs')).toBeInTheDocument();
  });

  it('renders the kanban breakdown bars and priority counts', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('kanban-by-column')).toBeInTheDocument();
    });

    const byColumn = screen.getByTestId('kanban-by-column');
    expect(byColumn).toHaveTextContent('To Do');
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
    expect(feed).toHaveTextContent('PR #501: Ship activity feed');
    // Per-type label
    expect(feed).toHaveTextContent('Card created');
    expect(feed).toHaveTextContent('Session started');
    expect(feed).toHaveTextContent('Escalation');
    expect(feed).toHaveTextContent('PR opened');
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

  it('renders the active sessions queue with in-flight session rows, owner, and state', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });
    const panel = screen.getByTestId('active-sessions');
    expect(panel).toHaveTextContent('Hub Backend');
    expect(panel).toHaveTextContent('claude-code');
    expect(panel).toHaveTextContent('Split the parser into modules');
    // Owning user is surfaced on the row.
    expect(panel).toHaveTextContent('alice');
    // A non-streaming, in-flight session stays in the queue (regression guard)
    // and renders its lifecycle state short label.
    expect(panel).toHaveTextContent('Awaiting review feedback');
    expect(panel).toHaveTextContent('bob');
    expect(panel).toHaveTextContent('Reviewing');
    // Header count reflects every in-flight session, not just streaming ones.
    expect(screen.getByText('2 in flight')).toBeInTheDocument();
  });

  it('divides the active sessions into per-status groups in pipeline order', async () => {
    const { container } = render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });

    // One group section per distinct state, each labelled and counted.
    const working = container.querySelector('[data-testid="active-sessions-group-working"]');
    const reviewing = container.querySelector('[data-testid="active-sessions-group-reviewing"]');
    expect(working).toBeInTheDocument();
    expect(reviewing).toBeInTheDocument();
    expect(working).toHaveTextContent('Working');
    expect(working).toHaveTextContent('Refactor stream parser');
    expect(reviewing).toHaveTextContent('Reviewing');
    expect(reviewing).toHaveTextContent('Awaiting review feedback');

    // working precedes reviewing in the canonical pipeline order.
    const all = Array.prototype.slice.call(container.querySelectorAll('[data-testid]'));
    expect(all.indexOf(working)).toBeLessThan(all.indexOf(reviewing));
  });

  it('defaults the active sessions filter to the current user and hides other owners', async () => {
    // SAMPLE owns sess-1 by u1 (alice) and sess-2 by u2 (bob).
    localStorage.setItem(
      'agent-hub-jwt',
      JSON.stringify({ token: 't', user: { id: 'u1', username: 'alice' } }),
    );

    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });

    // Default shows only the current user's in-flight work.
    const panel = screen.getByTestId('active-sessions');
    expect(panel).toHaveTextContent('Refactor stream parser');
    expect(panel).not.toHaveTextContent('Awaiting review feedback');
    // Count reflects the filtered list.
    expect(screen.getByText('1 in flight')).toBeInTheDocument();
    // The filter control defaults to the current user's key.
    expect(screen.getByTestId('active-sessions-owner-filter')).toHaveValue('id:u1');
  });

  it('reveals every owner when the filter switches to All users', async () => {
    localStorage.setItem(
      'agent-hub-jwt',
      JSON.stringify({ token: 't', user: { id: 'u1', username: 'alice' } }),
    );

    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('active-sessions-owner-filter'), {
      target: { value: '__all__' },
    });

    const panel = screen.getByTestId('active-sessions');
    expect(panel).toHaveTextContent('Refactor stream parser');
    expect(panel).toHaveTextContent('Awaiting review feedback');
    expect(screen.getByText('2 in flight')).toBeInTheDocument();
  });

  it('shows an owner-specific empty state when you have no in-flight sessions', async () => {
    // carol (u9) owns none of the sample sessions.
    localStorage.setItem(
      'agent-hub-jwt',
      JSON.stringify({ token: 't', user: { id: 'u9', username: 'carol' } }),
    );

    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('active-sessions-owner-filter')).toBeInTheDocument();
    });

    expect(screen.getByText('No active sessions for the selected user.')).toBeInTheDocument();
    expect(screen.getByText('0 in flight')).toBeInTheDocument();
    // You can still flip to All users to see the rest.
    fireEvent.change(screen.getByTestId('active-sessions-owner-filter'), {
      target: { value: '__all__' },
    });
    expect(screen.getByTestId('active-sessions')).toHaveTextContent('Refactor stream parser');
  });

  it('opens the session when an active session row is clicked', async () => {
    const onOpenSession = vi.fn();
    render(<DashboardView orgId="org-1" onOpenSession={onOpenSession} />);

    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Refactor stream parser'));
    expect(onOpenSession).toHaveBeenCalledWith('a1', 'sess-1');
  });

  it('shows an empty state when there are no in-flight sessions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...SAMPLE, activeSessions: [] }),
        }),
      ),
    );

    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('active-sessions')).toBeInTheDocument();
    });
    expect(
      screen.getByText('No active sessions. Everything has merged or there is no work in flight.'),
    ).toBeInTheDocument();
    expect(screen.getByText('0 in flight')).toBeInTheDocument();
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
