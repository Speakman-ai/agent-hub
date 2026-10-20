import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import DashboardView from './DashboardView';

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
      mergeable: null,
      reviewDecision: 'REVIEW_REQUIRED',
      reviewStatus: 'awaiting_review',
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
      mergeable: false,
      reviewDecision: null,
      reviewStatus: null,
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
} as Record<string, any>;

/** A copy of SAMPLE whose first active session name is the visible load marker. */
function sampleWithSession(sessionName: string) {
  return {
    ...SAMPLE,
    activeSessions: SAMPLE.activeSessions.map((session: any, index: number) =>
      index === 0 ? { ...session, sessionName } : session,
    ),
  };
}

// Cross-project support tickets returned by `GET /support-tickets`, which the
// dashboard's Support issues panel fetches. Deliberately out of severity order
// so the panel's client-side sort is exercised.
const SUPPORT_SAMPLE = {
  tickets: [
    {
      id: 'tkt-low',
      severity: 'low',
      status: 'new',
      subject: 'Typo in footer',
      project_id: 'proj-other',
      project_name: 'Hub Server',
      created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
    {
      id: 'tkt-critical',
      severity: 'critical',
      status: 'new',
      subject: 'Login is down for everyone',
      project_id: 'proj-dash',
      project_name: 'Hub Web',
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
    {
      id: 'tkt-high',
      severity: 'high',
      status: 'new',
      subject: 'Checkout throws 500',
      project_id: 'proj-dash',
      project_name: 'Hub Web',
      created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    },
  ],
  projects: [
    { id: 'proj-dash', name: 'Hub Web', count: 2 },
    { id: 'proj-other', name: 'Hub Server', count: 1 },
  ],
} as Record<string, any>;

// A fetch stub that routes by URL: the support panel hits `/support-tickets`,
// everything else is the org dashboard payload.
function routedFetch(
  dashboardPayload: any = SAMPLE,
  supportPayload: any = SUPPORT_SAMPLE,
  googleStatus: any = { connected: false, grantedScopes: [], serverConfigured: true },
  calendarPayload: any = { events: [] },
) {
  return vi.fn((url: any) => {
    const u = String(url);
    const body = u.includes('/support-tickets')
      ? supportPayload
      : u.includes('/auth/google/status')
        ? googleStatus
        : u.includes('/google/calendar/events')
          ? calendarPayload
          : dashboardPayload;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
}

describe('DashboardView', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', routedFetch());
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
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-calendar')).not.toBeInTheDocument();

    // The org dashboard payload is fetched exactly once.
    const dashCalls = (fetch as any).mock.calls.filter((c: any) =>
      /\/orgs\/org-1\/dashboard$/.test(String(c[0])),
    );
    expect(dashCalls!).toHaveLength(1);
    expect((fetch as any).mock.calls[0][0]).toMatch(/\/orgs\/org-1\/dashboard$/);
  });

  it('loads under React.StrictMode (mountedRef survives dev remount)', async () => {
    render(
      <React.StrictMode>
        <DashboardView orgId="org-1" />
      </React.StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Loading dashboard/i)).not.toBeInTheDocument();
  });

  it('no longer renders the headline counter tiles', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
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
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('dashboard-new-project-cta')).not.toBeInTheDocument();
  });

  it('renders active sessions above open PRs above recent activity', async () => {
    const { container } = render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('open-prs')).toBeInTheDocument();
    });

    const order = ['active-sessions', 'open-prs', 'recent-activity'];
    const positions = order.map((id: any) =>
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
    expect(panel!).toHaveTextContent('PR #777: Redesign the dashboard');
    expect(panel!).toHaveTextContent('PR #778: Add open PRs panel');
    expect(panel!).toHaveTextContent('Hub Web');
    expect(panel!).toHaveTextContent('Hub Backend');
    // Header count reflects the number of open PRs.
    expect(screen.getByText('2 open PRs')).toBeInTheDocument();
  });

  it('renders review status badges on open PR rows', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('open-pr-status-badge')).toHaveLength(2);
    });

    const badges = screen.getAllByTestId('open-pr-status-badge');
    expect(badges[0]).toHaveTextContent('Awaiting review');
    expect(badges[1]).toHaveTextContent('Conflicts');
  });

  it('renders a native PR row with no linked card and opens the in-app Pulls view on click', async () => {
    const onOpenPulls = vi.fn();
    render(<DashboardView orgId="org-1" onOpenPulls={onOpenPulls} />);

    await waitFor(() => {
      expect(screen.getByText('PR #778: Add open PRs panel')).toBeInTheDocument();
    });

    // The cardId-null row still renders (stable key falls back to the url) and
    // its native url deep-links into the project's Pulls view.
    fireEvent.click(screen.getByText('PR #778: Add open PRs panel' as any) as any);
    expect(onOpenPulls!).toHaveBeenCalledWith('proj-other');
  });

  it('opens the external PR host when an open PR row is clicked', async () => {
    const onOpenExternalUrl = vi.fn();
    render(<DashboardView orgId="org-1" onOpenExternalUrl={onOpenExternalUrl} />);

    await waitFor(() => {
      expect(screen.getByText('PR #777: Redesign the dashboard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('PR #777: Redesign the dashboard' as any) as any);
    expect(onOpenExternalUrl!).toHaveBeenCalledWith('https://github.com/acme/app/pull/777');
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

  it('does not render the kanban breakdown section', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('open-prs')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('kanban-by-column')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kanban-by-priority')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Kanban breakdown')).not.toBeInTheDocument();
  });

  it('renders the recent activity feed with each item title', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('recent-activity')).toBeInTheDocument();
    });

    const feed = screen.getByTestId('recent-activity');
    expect(feed!).toHaveTextContent('Add dashboard view');
    expect(feed!).toHaveTextContent('Hub Frontend session');
    expect(feed!).toHaveTextContent('PR stuck in review');
    expect(feed!).toHaveTextContent('PR #501: Ship activity feed');
    // Per-type label
    expect(feed!).toHaveTextContent('Card created');
    expect(feed!).toHaveTextContent('Session started');
    expect(feed!).toHaveTextContent('Escalation');
    expect(feed!).toHaveTextContent('PR opened');
  });

  it('calls onOpenSession when a session activity row is clicked', async () => {
    const onOpenSession = vi.fn();
    render(<DashboardView orgId="org-1" onOpenSession={onOpenSession} />);

    await waitFor(() => {
      expect(screen.getByText('Hub Frontend session')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Hub Frontend session' as any) as any);
    expect(onOpenSession!).toHaveBeenCalledWith('a1', 's1');
  });

  it('calls onOpenKanban when a card activity row is clicked', async () => {
    const onOpenKanban = vi.fn();
    render(<DashboardView orgId="org-1" onOpenKanban={onOpenKanban} />);

    await waitFor(() => {
      expect(screen.getByText('Add dashboard view')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add dashboard view' as any) as any);
    expect(onOpenKanban!).toHaveBeenCalledWith('proj-dash');
  });

  it('prefers onOpenPulls over onOpenKanban for card rows when both are provided', async () => {
    const onOpenKanban = vi.fn();
    const onOpenPulls = vi.fn();
    render(<DashboardView orgId="org-1" onOpenKanban={onOpenKanban} onOpenPulls={onOpenPulls} />);

    await waitFor(() => {
      expect(screen.getByText('Add dashboard view')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add dashboard view' as any) as any);
    expect(onOpenPulls!).toHaveBeenCalledWith('proj-dash');
    expect(onOpenKanban!).not.toHaveBeenCalled();
  });

  it('renders activity type filter chips with counts and an "All" reset', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('recent-activity-filter')).toBeInTheDocument();
    });

    // "All" chip is active by default.
    const allChip = screen.getByTestId('recent-activity-filter-all');
    expect(allChip!).toHaveAttribute('aria-pressed', 'true');

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
    expect(cardCreatedChip!).toHaveTextContent('1');
    const cardUpdatedChip = screen.getByTestId('recent-activity-filter-card_updated');
    expect(cardUpdatedChip!).toHaveTextContent('0');
  });

  it('narrows the visible activity to the selected types', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Add dashboard view')).toBeInTheDocument();
    });

    // Pick the "Session started" filter only.
    fireEvent.click(screen.getByTestId('recent-activity-filter-session_created' as any) as any);

    const feed = screen.getByTestId('recent-activity');
    // Session row remains visible.
    expect(feed!).toHaveTextContent('Hub Frontend session');
    // Other types are filtered out.
    expect(feed!).not.toHaveTextContent('Add dashboard view');
    expect(feed!).not.toHaveTextContent('PR stuck in review');
    expect(feed!).not.toHaveTextContent('PR #501: Ship activity feed');
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

    fireEvent.click(screen.getByTestId('recent-activity-filter-session_created' as any) as any);
    fireEvent.click(screen.getByTestId('recent-activity-filter-escalation' as any) as any);

    const feed = screen.getByTestId('recent-activity');
    expect(feed!).toHaveTextContent('Hub Frontend session');
    expect(feed!).toHaveTextContent('PR stuck in review');
    expect(feed!).not.toHaveTextContent('Add dashboard view');
    expect(feed!).not.toHaveTextContent('PR #501: Ship activity feed');

    // Clicking "All" clears the narrowing.
    fireEvent.click(screen.getByTestId('recent-activity-filter-all' as any) as any);
    expect(feed!).toHaveTextContent('Add dashboard view');
    expect(feed!).toHaveTextContent('PR #501: Ship activity feed');
  });

  it('shows an empty-state message when the filter matches nothing', async () => {
    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Add dashboard view')).toBeInTheDocument();
    });

    // The sample has 0 card_updated events; selecting only that bucket
    // should produce an empty filtered feed.
    fireEvent.click(screen.getByTestId('recent-activity-filter-card_updated' as any) as any);
    expect(screen.getByTestId('recent-activity')).toHaveTextContent(
      'No activity matches the selected filters.',
    );
  });

  it('persists the filter selection to localStorage', async () => {
    const { unmount } = render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('recent-activity-filter')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('recent-activity-filter-session_created' as any) as any);

    expect(JSON.parse(localStorage.getItem('dashboard.activityFilter.v1')!)).toEqual([
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
    expect(panel!).toHaveTextContent('Hub Backend');
    expect(panel!).toHaveTextContent('claude-code');
    expect(panel!).toHaveTextContent('Split the parser into modules');
    // Owning user is surfaced on the row.
    expect(panel!).toHaveTextContent('alice');
    // A non-streaming, in-flight session stays in the queue (regression guard)
    // and renders its lifecycle state short label.
    expect(panel!).toHaveTextContent('Awaiting review feedback');
    expect(panel!).toHaveTextContent('bob');
    expect(panel!).toHaveTextContent('Reviewing');
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
    expect(working!).toBeInTheDocument();
    expect(reviewing!).toBeInTheDocument();
    expect(working!).toHaveTextContent('Working');
    expect(working!).toHaveTextContent('Refactor stream parser');
    expect(reviewing!).toHaveTextContent('Reviewing');
    expect(reviewing!).toHaveTextContent('Awaiting review feedback');

    // working precedes reviewing in the canonical pipeline order.
    const all = Array.prototype.slice.call(container.querySelectorAll('[data-testid]'));
    expect(all.indexOf(working)).toBeLessThan(all.indexOf(reviewing));
  });

  it('does not render a support issues panel or fetch support tickets', async () => {
    render(<DashboardView orgId="org-1" />);
    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });
    expect(screen.queryByText(/New support issues/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('support-issues')).not.toBeInTheDocument();
    const supportCalls = (fetch as any).mock.calls.filter((c: any) =>
      String(c[0]).includes('/support-tickets'),
    );
    expect(supportCalls).toHaveLength(0);
  });

  it('switches active sessions to a kanban board with one column per status', async () => {
    const onOpenSession = vi.fn();
    const { container } = render(<DashboardView orgId="org-1" onOpenSession={onOpenSession} />);
    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });
    // List view by default.
    expect(screen.queryByTestId('active-sessions-board')).not.toBeInTheDocument();
    expect(screen.getByTestId('active-sessions-view-list')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('active-sessions-view-board'));

    expect(screen.getByTestId('active-sessions-board')).toBeInTheDocument();
    expect(screen.getByTestId('active-sessions-view-board')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const working = container.querySelector('[data-testid="active-sessions-column-working"]');
    const reviewing = container.querySelector('[data-testid="active-sessions-column-reviewing"]');
    expect(working!).toHaveTextContent('Refactor stream parser');
    expect(reviewing!).toHaveTextContent('Awaiting review feedback');
    expect(working!).not.toHaveAttribute('data-collapsed');
    // Empty in-flight states collapse to a narrow strip instead of vanishing.
    const testing = container.querySelector('[data-testid="active-sessions-column-running_tests"]');
    expect(testing!).toHaveAttribute('data-collapsed', 'true');
    expect(testing!).toHaveTextContent('Running tests');
    // Pushed never holds an in-flight session, so it has no column.
    expect(
      container.querySelector('[data-testid="active-sessions-column-pushed"]'),
    ).not.toBeInTheDocument();
    // The board breaks out of the page's max-width column.
    expect(screen.getByRole('region', { name: 'Active sessions' })).toHaveAttribute(
      'data-full-width',
      'true',
    );
    expect(
      container.querySelector('[data-testid="active-sessions-column-merged"]'),
    ).not.toBeInTheDocument();

    fireEvent.click(within(working as HTMLElement).getByTestId('active-session-card'));
    expect(onOpenSession).toHaveBeenCalledWith('a1', 'sess-1');
  });

  it('remembers the board view across remounts', async () => {
    const first = render(<DashboardView orgId="org-1" />);
    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('active-sessions-view-board'));
    first.unmount();

    render(<DashboardView orgId="org-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('active-sessions-board')).toBeInTheDocument();
    });
  });

  it('defaults the active sessions filter to All users', async () => {
    // SAMPLE owns sess-1 by u1 (alice) and sess-2 by u2 (bob).
    localStorage.setItem(
      'agent-hub-jwt',
      JSON.stringify({ token: 't', user: { id: 'u1', username: 'alice' } }),
    );

    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });

    const panel = screen.getByTestId('active-sessions');
    expect(panel!).toHaveTextContent('Refactor stream parser');
    expect(panel!).toHaveTextContent('Awaiting review feedback');
    expect(screen.getByText('2 in flight')).toBeInTheDocument();
    expect(screen.getByTestId('active-sessions-owner-filter')).toHaveValue('__all__');
  });

  it('narrows to one owner when the filter selects a user', async () => {
    localStorage.setItem(
      'agent-hub-jwt',
      JSON.stringify({ token: 't', user: { id: 'u1', username: 'alice' } }),
    );

    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('active-sessions-owner-filter' as any), {
      target: { value: 'id:u1' },
    });

    const panel = screen.getByTestId('active-sessions');
    expect(panel!).toHaveTextContent('Refactor stream parser');
    expect(panel!).not.toHaveTextContent('Awaiting review feedback');
    expect(screen.getByText('1 in flight')).toBeInTheDocument();
  });

  it('shows an owner-specific empty state when the selected user has no in-flight sessions', async () => {
    // carol (u9) owns none of the sample sessions.
    localStorage.setItem(
      'agent-hub-jwt',
      JSON.stringify({ token: 't', user: { id: 'u9', username: 'carol' } }),
    );

    render(<DashboardView orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('active-sessions-owner-filter' as any), {
      target: { value: 'id:u9' },
    });
    expect(screen.getByText('No active sessions for the selected user.')).toBeInTheDocument();
    expect(screen.getByText('0 in flight')).toBeInTheDocument();
  });

  it('opens the session when an active session row is clicked', async () => {
    const onOpenSession = vi.fn();
    render(<DashboardView orgId="org-1" onOpenSession={onOpenSession} />);

    await waitFor(() => {
      expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Refactor stream parser' as any) as any);
    expect(onOpenSession!).toHaveBeenCalledWith('a1', 'sess-1');
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

  const setUser = (username: any) =>
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
    fireEvent.click(screen.getByTitle('Account settings' as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith('settings:account');
  });
});

describe('DashboardView — 5s auto-refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      writable: true,
      value: 'visible',
    });
    try {
      if (typeof localStorage !== 'undefined') localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const dashCalls = () =>
    (fetch as any).mock.calls.filter((c: any) => /\/orgs\/org-1\/dashboard$/.test(String(c[0])));

  it('re-polls the org dashboard every 5s while the tab is visible', async () => {
    vi.stubGlobal('fetch', routedFetch());
    render(<DashboardView orgId="org-1" />);

    // Initial mount load.
    await vi.advanceTimersByTimeAsync(0);
    expect(dashCalls()).toHaveLength(1);

    // Each 5s tick triggers another silent fetch.
    await vi.advanceTimersByTimeAsync(5000);
    expect(dashCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(dashCalls()).toHaveLength(3);
  });

  it('pauses polling while the tab is hidden and refetches when it returns', async () => {
    vi.stubGlobal('fetch', routedFetch());
    render(<DashboardView orgId="org-1" />);

    await vi.advanceTimersByTimeAsync(0);
    expect(dashCalls()).toHaveLength(1);

    // Background the tab: the interval is cleared, so time passing does nothing.
    (document as any).visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(20000);
    expect(dashCalls()).toHaveLength(1);

    // Returning to the foreground triggers an immediate catch-up refetch.
    (document as any).visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(dashCalls()).toHaveLength(2);
  });

  it('skips overlapping polls while a refresh is still in flight (no stacked requests)', async () => {
    let hang = false;
    const pending: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: any) => {
        const u = String(url);
        if (u.includes('/support-tickets')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(SUPPORT_SAMPLE) });
        }
        if (hang) {
          // Dashboard poll hangs until the test releases it.
          return new Promise((resolve) => {
            pending.push(() => resolve({ ok: true, json: () => Promise.resolve(SAMPLE) }));
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(SAMPLE) });
      }),
    );

    render(<DashboardView orgId="org-1" />);
    await vi.advanceTimersByTimeAsync(0);
    expect(dashCalls()).toHaveLength(1); // initial load resolved

    // From now, dashboard polls hang. The first tick fires one request…
    hang = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(dashCalls()).toHaveLength(2);

    // …and while it is still in flight, the in-flight guard skips every later
    // tick instead of stacking concurrent requests.
    await vi.advanceTimersByTimeAsync(15000);
    expect(dashCalls()).toHaveLength(2);

    // Once the pending poll resolves the guard releases and polling resumes.
    pending.forEach((r) => r());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(dashCalls()).toHaveLength(3);
  });

  it('keeps the last-good dashboard (no spinner, no error) when a background poll fails', async () => {
    let failDashboard = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: any) => {
        const u = String(url);
        if (u.includes('/support-tickets')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(SUPPORT_SAMPLE) });
        }
        if (failDashboard) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: 'transient' }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(SAMPLE) });
      }),
    );

    render(<DashboardView orgId="org-1" />);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();

    // Next background poll fails — the dashboard stays on screen and no error
    // banner replaces it.
    failDashboard = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(screen.getByText('Refactor stream parser')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

/**
 * The dashboard polls every 5s. These guard the contracts
 * a reviewer flagged after the polling landed:
 *   1. A stale/superseded response must not overwrite a
 *      newer one — the cancellation/generation guard on every load path.
 *   2. A silent background poll must not clear a foreground error unless it
 *      actually succeeds — so an error can't blink away every 5s.
 */
describe('DashboardView — polling staleness guards', () => {
  function deferred() {
    let resolve!: (v: any) => void;
    const promise = new Promise<any>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  // Resolve a deferred fetch and drain the chained microtasks (fetch → json →
  // setState → re-render) inside act so the panel commits before we assert.
  async function resolveAndFlush(deferredObj: any, payload: any) {
    await act(async () => {
      deferredObj.resolve({ ok: true, json: () => Promise.resolve(payload) });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      writable: true,
      value: 'visible',
    });
    try {
      if (typeof localStorage !== 'undefined') localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ignores a stale dashboard response that resolves after a newer poll', async () => {
    const dashDeferreds: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: any) => {
        const u = String(url);
        if (u.includes('/support-tickets')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ tickets: [] }) });
        }
        const d = deferred();
        dashDeferreds.push(d);
        return d.promise;
      }),
    );

    render(<DashboardView orgId="org-1" />);

    // Mount issues dashboard request #0 (still pending).
    await vi.advanceTimersByTimeAsync(0);
    expect(dashDeferreds.length).toBe(1);

    // A 5s poll issues request #1 while #0 is still in flight.
    await vi.advanceTimersByTimeAsync(5000);
    expect(dashDeferreds.length).toBeGreaterThanOrEqual(2);

    // The newer request (#1) resolves first with fresh data.
    await resolveAndFlush(dashDeferreds[1], sampleWithSession('Fresh session'));
    expect(screen.getByText('Fresh session')).toBeInTheDocument();

    // The older mount request (#0) resolves later — the generation guard must
    // drop it so it can't overwrite the fresher dashboard.
    await resolveAndFlush(dashDeferreds[0], sampleWithSession('Stale session'));
    expect(screen.getByText('Fresh session')).toBeInTheDocument();
    expect(screen.queryByText('Stale session')).not.toBeInTheDocument();
  });

  it('does not commit a previous org response after orgId changes', async () => {
    const byOrg: Record<string, any[]> = { 'org-1': [], 'org-2': [] };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: any) => {
        const u = String(url);
        if (u.includes('/support-tickets')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ tickets: [] }) });
        }
        const m = u.match(/\/orgs\/([^/]+)\/dashboard/);
        const org = m ? m[1] : 'unknown';
        const d = deferred();
        (byOrg[org] ||= []).push(d);
        return d.promise;
      }),
    );

    const { rerender } = render(<DashboardView orgId="org-1" />);
    await vi.advanceTimersByTimeAsync(0);
    expect(byOrg['org-1'].length).toBe(1);

    // Switch orgs before org-1's request resolves.
    rerender(<DashboardView orgId="org-2" />);
    await vi.advanceTimersByTimeAsync(0);
    expect(byOrg['org-2'].length).toBe(1);

    // The previous org (org-1) resolves first — it must NOT be shown in the
    // org-2 view, even though no newer request has committed yet.
    await resolveAndFlush(byOrg['org-1'][0], sampleWithSession('Old session'));
    expect(screen.queryByText('Old session')).not.toBeInTheDocument();

    // org-2 resolves and its data lands.
    await resolveAndFlush(byOrg['org-2'][0], sampleWithSession('New session'));
    expect(screen.getByText('New session')).toBeInTheDocument();
    expect(screen.queryByText('Old session')).not.toBeInTheDocument();
  });

  it('commits a slow foreground dashboard load even if a silent poll failed first', async () => {
    const dashDeferreds: any[] = [];
    let pollShouldFail = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: any) => {
        const u = String(url);
        if (u.includes('/support-tickets')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ tickets: [] }) });
        }
        if (pollShouldFail) {
          pollShouldFail = false; // only the first poll after arming fails
          return Promise.reject(new Error('poll boom'));
        }
        const d = deferred();
        dashDeferreds.push(d);
        return d.promise;
      }),
    );

    render(<DashboardView orgId="org-1" />);

    // Mount foreground load (#1) is issued and stays pending.
    await vi.advanceTimersByTimeAsync(0);
    expect(dashDeferreds.length).toBe(1);

    // The 5s silent poll (#2) fires and fails — it commits nothing.
    pollShouldFail = true;
    await vi.advanceTimersByTimeAsync(5000);

    // The foreground load now succeeds: a failed background poll must NOT have
    // invalidated it, so its data still lands (and no error is surfaced).
    await resolveAndFlush(dashDeferreds[0], sampleWithSession('Foreground session'));
    expect(screen.getByText('Foreground session')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
