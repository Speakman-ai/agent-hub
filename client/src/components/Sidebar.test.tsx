import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import Sidebar from './Sidebar';

// OrgSwitcher hits the server on mount; stub it so we can render Sidebar standalone.
(vi as any).mock('./OrgSwitcher.jsx', () => ({
  default: () => <div data-testid="org-switcher-stub" />,
}));

(vi as any).mock('./KanbanSidebarEpicsPanel.jsx', () => ({
  default: () => <div data-testid="kanban-sidebar-epics-panel" />,
}));

// getServerBase is invoked from a useEffect that fetches /api/health. Stub fetch.
beforeEach(() => {
  (globalThis as any).fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ version: 'test', gitHash: 'abc' }) as any,
  });
});

const PROJECT_ID = 'proj-1';
const AGENT_ID = 'agent-1';
const OTHER_AGENT_ID = 'agent-2';

const buildProps = (overrides: any = {}) => {
  const sessions = overrides.sessions || [
    { id: 's-running', name: 'Running task' },
    { id: 's-pr', name: 'PR ready session' },
    { id: 's-idle', name: 'Idle session' },
  ];

  // Two agents so the project offers a collapse chevron
  const projects = overrides.projects || [
    {
      id: PROJECT_ID,
      name: 'Test Project',
      color: '#22d3ee',
      agents: [
        { id: AGENT_ID, name: 'Primary Agent', color: '#22d3ee', active: true },
        { id: OTHER_AGENT_ID, name: 'Secondary Agent', color: '#a78bfa', active: true },
      ],
    },
  ];

  const onSelectAgent = overrides.onSelectAgent || vi.fn();
  const onExpandAgent = overrides.onExpandAgent || vi.fn();
  const onSelectSession = overrides.onSelectSession || vi.fn();
  const onNavigate = overrides.onNavigate || vi.fn();
  const sessionsByAgentId = overrides.sessionsByAgentId || {
    [AGENT_ID]: sessions,
  };
  return {
    projects,
    agents: [],
    activeAgentId: AGENT_ID,
    // Steady state: the live `sessions`/`archivedSessions` arrays were loaded for
    // the active agent. Tests simulating a mid-switch override loadedSessionsAgentId.
    loadedSessionsAgentId: AGENT_ID,
    loadedArchivedAgentId: AGENT_ID,
    onSelectAgent,
    onExpandAgent,
    sessionsByAgentId,
    archivedSessionsByAgentId: overrides.archivedSessionsByAgentId || {},
    onFocusSession:
      overrides.onFocusSession ||
      ((agentId: any, sessionId: any) => {
        onSelectAgent(agentId);
        onSelectSession(sessionId);
        onNavigate('chat');
      }),
    sessions,
    activeSessionId: null,
    onSelectSession,
    onNewSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onClearAllSessions: vi.fn(),
    onClearMergedSessions: vi.fn(),
    onRenameSession: vi.fn(),
    onNavigate,
    currentView: 'chat',
    activeTaskSessionIds: { 's-running': true },
    changesReadyBySession: { 's-pr': { branch: 'feat/foo' } },
    ...overrides,
  };
};

describe('Sidebar — loading overlay', () => {
  it('renders a loading indicator when isLoading is true', () => {
    render(<Sidebar {...buildProps({ isLoading: true })} />);
    expect(screen.getByTestId('sidebar-loading')).toBeInTheDocument();
  });

  it('does not show the loading overlay when isLoading is false', () => {
    render(<Sidebar {...buildProps({ isLoading: false })} />);
    expect(screen.queryByTestId('sidebar-loading')).not.toBeInTheDocument();
  });
});

describe('Sidebar — bulk clear affordance', () => {
  it('renders a single "Clear pushed" button and no "Clear merged" button', () => {
    render(<Sidebar {...buildProps()} />);
    expect(screen.getByRole('button', { name: 'Clear pushed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear merged' })).not.toBeInTheDocument();
  });

  it('"Clear pushed" confirms then runs the merged-clear action (the correct action)', async () => {
    const onClearMergedSessions = vi.fn();
    const onClearPushedSessions = vi.fn();
    render(<Sidebar {...buildProps({ onClearMergedSessions, onClearPushedSessions })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear pushed' } as any) as any);
    // Confirmation dialog uses pushed wording.
    expect(screen.getByText(/Delete all sessions with pushed changes\?/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Pushed' } as any) as any);
    await waitFor(() => expect(onClearMergedSessions!).toHaveBeenCalledTimes(1));
    // The abandoned pushed-clear action must never fire from this button.
    expect(onClearPushedSessions!).not.toHaveBeenCalled();
  });

  it('scopes the confirm dialog to the triggering agent when two agents are expanded', async () => {
    // Regression: the confirm state is global. Without a `confirmAgentId === agent.id`
    // guard the dialog renders under EVERY expanded agent, and confirming under the
    // wrong one would clear the other agent's sessions.
    const onClearMergedSessions = vi.fn();
    render(
      <Sidebar
        {...buildProps({
          onClearMergedSessions,
          sessionsByAgentId: {
            [AGENT_ID]: [{ id: 'a-s1', name: 'A session' }],
            [OTHER_AGENT_ID]: [{ id: 'b-s1', name: 'B session' }],
          },
        })}
      />,
    );

    // The active agent (A) is expanded by default; expand the second agent (B)
    // via its chevron control (the row click now selects/navigates instead).
    fireEvent.click(
      screen.getByRole('button', { name: /Expand Secondary Agent sessions/i } as any) as any,
    );

    // Both expanded agents now offer a "Clear pushed" button.
    const clearButtons = screen.getAllByRole('button', { name: 'Clear pushed' });
    expect(clearButtons.length).toBe(2);

    // Trigger the bulk-clear under agent A (first in DOM order).
    fireEvent.click(clearButtons[0] as any);

    // The confirmation must render exactly once — only under agent A.
    expect(screen.getAllByText(/Delete all sessions with pushed changes\?/i)).toHaveLength(1);

    // Confirming clears A's sessions, not B's.
    fireEvent.click(screen.getByRole('button', { name: 'Delete Pushed' } as any) as any);
    await waitFor(() => expect(onClearMergedSessions!).toHaveBeenCalledTimes(1));
    expect(onClearMergedSessions!).toHaveBeenCalledWith(AGENT_ID);
  });
});

describe('Sidebar — agent row select vs expand', () => {
  it('clicking the agent row selects the agent and navigates to chat', () => {
    const onSelectAgent = vi.fn();
    const onNavigate = vi.fn();
    render(<Sidebar {...buildProps({ onSelectAgent, onNavigate })} />);

    // The row (named exactly after the agent) is the primary switch affordance;
    // the chevron's accessible name ("Expand …") is excluded by the exact match.
    fireEvent.click(screen.getByRole('button', { name: 'Secondary Agent' } as any) as any);
    expect(onSelectAgent).toHaveBeenCalledWith(OTHER_AGENT_ID);
    expect(onNavigate).toHaveBeenCalledWith('chat');
  });

  it('the expand chevron toggles the session list without selecting the agent', () => {
    const onSelectAgent = vi.fn();
    const onNavigate = vi.fn();
    const onExpandAgent = vi.fn();
    render(
      <Sidebar
        {...buildProps({
          onSelectAgent,
          onNavigate,
          onExpandAgent,
          sessionsByAgentId: {
            [AGENT_ID]: [{ id: 'a-s1', name: 'A session' }],
            [OTHER_AGENT_ID]: [{ id: 'b-only', name: 'B only session' }],
          },
        })}
      />,
    );

    // B is not active and collapsed; its session is hidden initially.
    expect(screen.queryByText('B only session')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Expand Secondary Agent sessions/i } as any) as any,
    );

    // Expanding reveals B's sessions and warms its cache, but does NOT switch.
    expect(screen.getByText('B only session')).toBeInTheDocument();
    expect(onExpandAgent).toHaveBeenCalledWith(OTHER_AGENT_ID);
    expect(onSelectAgent).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalledWith('chat');
  });
});

describe('Sidebar — live sessions fallback keyed by loaded agent', () => {
  it('does NOT show the live `sessions` for the active agent when those rows belong to another agent (mid-switch)', () => {
    // Mid-switch: agent A is active, but `sessions` still holds the rows fetched
    // for agent B (its fetch hasn't resolved). The active agent must not render
    // B's stale rows via the fallback, or they could feed the clear controls.
    render(
      <Sidebar
        {...buildProps({
          activeAgentId: AGENT_ID,
          loadedSessionsAgentId: OTHER_AGENT_ID,
          sessions: [{ id: 'stale-b', name: 'Stale B session' }],
          sessionsByAgentId: {}, // no per-agent cache yet for the active agent
        })}
      />,
    );

    // Active agent (auto-expanded) shows nothing — the stale rows belong to B.
    expect(screen.queryByText('Stale B session')).not.toBeInTheDocument();
  });

  it('shows the live `sessions` for the active agent when they were loaded for it', () => {
    render(
      <Sidebar
        {...buildProps({
          activeAgentId: AGENT_ID,
          loadedSessionsAgentId: AGENT_ID,
          sessions: [{ id: 'live-a', name: 'Live A session' }],
          sessionsByAgentId: {}, // fallback to `sessions` for the loaded agent
        })}
      />,
    );

    expect(screen.getByText('Live A session')).toBeInTheDocument();
  });
});

describe('Sidebar — actionable session visibility', () => {
  it('shows all sessions (running, PR-ready, idle) when the agent is expanded', () => {
    render(<Sidebar {...buildProps()} />);
    // Default state: active agent is expanded, so all three sessions render.
    expect(screen.getByText('Running task')).toBeInTheDocument();
    expect(screen.getByText('PR ready session')).toBeInTheDocument();
    expect(screen.getByText('Idle session')).toBeInTheDocument();
  });

  it('does not render the legacy purple PR-ready glyph for changes-ready sessions', () => {
    render(<Sidebar {...buildProps()} />);

    expect(screen.getByText('PR ready session')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-ready-indicator')).not.toBeInTheDocument();
  });

  it('invokes onFocusSession with agent and session id when a session row is clicked', () => {
    const onFocusSession = vi.fn();
    render(<Sidebar {...buildProps({ onFocusSession })} />);
    fireEvent.click(screen.getByText('PR ready session' as any) as any);
    expect(onFocusSession!).toHaveBeenCalledWith(AGENT_ID, 's-pr');
  });

  it('hides idle sessions but keeps running and PR-ready ones when the agent is collapsed', () => {
    render(<Sidebar {...buildProps()} />);

    // Collapse to actionable-only via the filter toggle (not the agent expand chevron).
    fireEvent.click(screen.getByTitle('Show actionable only') as any);

    // Actionable sessions remain visible.
    expect(screen.getByText('Running task')).toBeInTheDocument();
    expect(screen.getByText('PR ready session')).toBeInTheDocument();
    // Idle session is hidden.
    expect(screen.queryByText('Idle session')).not.toBeInTheDocument();
    // "New Session" utility row is also hidden.
    expect(screen.queryByText('+ New Session')).not.toBeInTheDocument();
  });

  it('hides the session panel entirely when the agent is collapsed and no sessions are actionable', () => {
    const props = buildProps({
      sessions: [{ id: 's-idle-only', name: 'Only idle session' }],
      activeTaskSessionIds: {},
      changesReadyBySession: {},
    });
    render(<Sidebar {...props} />);

    // Before collapse — session is visible.
    expect(screen.getByText('Only idle session')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Show actionable only') as any);

    expect(screen.queryByText('Only idle session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-sessions-list')).not.toBeInTheDocument();
  });

  it('renders an actionable-only branch when the project is collapsed', () => {
    render(<Sidebar {...buildProps()} />);

    // The project row is a button containing the project name + chevron span.
    // Click it to toggle project collapse.
    fireEvent.click(screen.getByText('Test Project' as any) as any);

    // Project-collapsed fallback should render with only actionable sessions.
    const collapsedPanel = screen.getByTestId('project-collapsed-actionable');
    expect(within(collapsedPanel).getByText('Running task')).toBeInTheDocument();
    expect(within(collapsedPanel).getByText('PR ready session')).toBeInTheDocument();
    expect(within(collapsedPanel).queryByText('Idle session')).not.toBeInTheDocument();
    expect(within(collapsedPanel).queryByTestId('pr-ready-indicator')).not.toBeInTheDocument();

    // Standard sessions list should be gone.
    expect(screen.queryByTestId('agent-sessions-list')).not.toBeInTheDocument();
  });

  it('does not render the project-collapsed fallback when there are no actionable sessions', () => {
    const props = buildProps({
      sessions: [{ id: 's-idle-only', name: 'Only idle session' }],
      activeTaskSessionIds: {},
      changesReadyBySession: {},
    });
    render(<Sidebar {...props} />);

    fireEvent.click(screen.getByText('Test Project' as any) as any); // collapse project

    expect(screen.queryByTestId('project-collapsed-actionable')).not.toBeInTheDocument();
    expect(screen.queryByText('Only idle session')).not.toBeInTheDocument();
  });

  it('keeps Resolve PR sessions with changes_ready visible when the agent is collapsed', () => {
    // Reviewer feedback (PR #839): Resolve-PR sessions that only have
    // `changes_ready` must stay visible in the collapsed sidebar so users can
    // reopen them without expanding. The misleading "create PR" purple glyph
    // is suppressed independently (see other tests) — visibility and glyph
    // semantics are decoupled.
    const props = buildProps({
      sessions: [{ id: 's-resolve', name: '[Resolve PR #77] Fix thing' }],
      activeTaskSessionIds: {},
      changesReadyBySession: { 's-resolve': { branch: 'fix/77' } },
    });
    render(<Sidebar {...props} />);

    expect(screen.getByText('[Resolve PR #77] Fix thing')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Show actionable only') as any);

    // Session row remains rendered after collapse.
    expect(screen.getByText('[Resolve PR #77] Fix thing')).toBeInTheDocument();
    expect(screen.getByTestId('agent-sessions-list')).toBeInTheDocument();
    // But the misleading "create PR" pulse must not appear for the Resolve PR title.
    expect(screen.queryByTestId('pr-ready-indicator')).not.toBeInTheDocument();
  });

  it('keeps Resolve PR sessions with changes_ready visible in the project-collapsed actionable list', () => {
    const props = buildProps({
      sessions: [{ id: 's-resolve', name: '[Resolve PR #77] Fix thing' }],
      activeTaskSessionIds: {},
      changesReadyBySession: { 's-resolve': { branch: 'fix/77' } },
    });
    render(<Sidebar {...props} />);

    fireEvent.click(screen.getByText('Test Project' as any) as any); // collapse project

    const collapsedPanel = screen.getByTestId('project-collapsed-actionable');
    expect(within(collapsedPanel).getByText('[Resolve PR #77] Fix thing')).toBeInTheDocument();
    // No misleading "create PR" pulse on the Resolve PR row.
    expect(within(collapsedPanel).queryByTestId('pr-ready-indicator')).not.toBeInTheDocument();
  });

  it('shows external-link control for Resolve PR sessions with changes_ready when githubRepo is set', () => {
    const props = buildProps({
      sessions: [{ id: 's-resolve', name: '[Resolve PR #77] Fix thing' }],
      activeTaskSessionIds: {},
      changesReadyBySession: { 's-resolve': { branch: 'fix/77' } },
      projects: [
        {
          id: PROJECT_ID,
          name: 'Test Project',
          color: '#22d3ee',
          githubRepo: 'acme/widgets',
          agents: [
            { id: AGENT_ID, name: 'Primary Agent', color: '#22d3ee', active: true },
            { id: OTHER_AGENT_ID, name: 'Secondary Agent', color: '#a78bfa', active: true },
          ],
        },
      ],
    });
    render(<Sidebar {...props} />);

    expect(screen.getByTestId('resolve-pr-external-link')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-ready-indicator')).not.toBeInTheDocument();
  });

  it('omits the create-PR pulse for Resolve PR titles when githubRepo is missing and no URL is embedded', () => {
    const props = buildProps({
      sessions: [{ id: 's-resolve', name: '[Resolve PR #88] Fix thing' }],
      activeTaskSessionIds: {},
      changesReadyBySession: { 's-resolve': { branch: 'fix/88' } },
    });
    render(<Sidebar {...props} />);

    const list = screen.getByTestId('agent-sessions-list');
    expect(within(list).getByText('[Resolve PR #88] Fix thing')).toBeInTheDocument();
    expect(within(list).queryByTestId('pr-ready-indicator')).not.toBeInTheDocument();
    expect(within(list).queryByTestId('resolve-pr-external-link')).not.toBeInTheDocument();
  });

  it('omits the create-PR pulse in project-collapsed actionable rows for Resolve PR + changes_ready without a PR URL', () => {
    const props = buildProps({
      sessions: [{ id: 's-resolve-run', name: '[Resolve PR #3] work' }],
      activeTaskSessionIds: { 's-resolve-run': true },
      changesReadyBySession: { 's-resolve-run': { branch: 'fix/3' } },
    });
    render(<Sidebar {...props} />);

    fireEvent.click(screen.getByText('Test Project' as any) as any);

    const collapsedPanel = screen.getByTestId('project-collapsed-actionable');
    expect(within(collapsedPanel).getByText('[Resolve PR #3] work')).toBeInTheDocument();
    expect(within(collapsedPanel).queryByTestId('pr-ready-indicator')).not.toBeInTheDocument();
    expect(
      within(collapsedPanel).queryByTestId('resolve-pr-external-link'),
    ).not.toBeInTheDocument();
  });
});

describe('Sidebar — always-on session state icon', () => {
  it('renders a state icon on every session row (idle and awaiting both resolve to waiting)', () => {
    const props = buildProps({
      sessions: [
        { id: 's-ask', name: 'Picker session' },
        { id: 's-idle', name: 'Idle session' },
      ],
      activeTaskSessionIds: {},
      changesReadyBySession: {},
      awaitingInputBySession: { 's-ask': { askIds: ['ask-1'] } },
    });
    render(<Sidebar {...props} />);

    // The icon is ALWAYS present now — idle and awaiting collapse into the
    // single "Waiting for user input" state.
    const askIcon = screen.getByTestId('session-state-icon-s-ask');
    const idleIcon = screen.getByTestId('session-state-icon-s-idle');
    expect(askIcon!).toHaveAttribute('data-session-state', 'waiting_for_user_input');
    expect(idleIcon!).toHaveAttribute('data-session-state', 'waiting_for_user_input');
    expect(askIcon!).toHaveAttribute('aria-label', 'Waiting for user input');
  });

  it('shows the working state for sessions with an active task', () => {
    const props = buildProps({
      sessions: [{ id: 's-running', name: 'Running session' }],
      activeTaskSessionIds: { 's-running': true },
      changesReadyBySession: {},
      awaitingInputBySession: {},
    });
    render(<Sidebar {...props} />);

    expect(screen.getByTestId('session-state-icon-s-running')).toHaveAttribute(
      'data-session-state',
      'working',
    );
  });

  it('renders the shared state icon on scheduled-task rows', () => {
    const props = buildProps({
      sessions: [],
      activeTaskSessionIds: { 'cron-sess': true },
      changesReadyBySession: {},
      cronSessions: [
        {
          id: 'cron-sess',
          agent_id: AGENT_ID,
          cron_name: 'Nightly reconcile',
          cron_schedule: '0 0 * * *',
        },
      ],
    });
    render(<Sidebar {...props} />);

    expect(screen.getByTestId('session-state-icon-cron-sess')).toHaveAttribute(
      'data-session-state',
      'working',
    );
  });

  it('prefers working over waiting when an active task and a stale ask overlap', () => {
    const props = buildProps({
      sessions: [{ id: 's-overlap', name: 'Resuming session' }],
      activeTaskSessionIds: { 's-overlap': true },
      changesReadyBySession: {},
      awaitingInputBySession: { 's-overlap': { askIds: ['ask-stale'] } },
    });
    render(<Sidebar {...props} />);

    expect(screen.getByTestId('session-state-icon-s-overlap')).toHaveAttribute(
      'data-session-state',
      'working',
    );
  });

  it('keeps awaiting-input sessions visible when the agent row is collapsed', () => {
    const props = buildProps({
      sessions: [
        { id: 's-ask', name: 'Awaiting input' },
        { id: 's-idle', name: 'Idle session' },
      ],
      activeTaskSessionIds: {},
      changesReadyBySession: {},
      awaitingInputBySession: { 's-ask': { askIds: ['ask-1'] } },
    });
    render(<Sidebar {...props} />);

    // Collapse the active agent.
    fireEvent.click(screen.getByTitle('Show actionable only') as any);

    // The awaiting-input session must remain visible, idle one is hidden.
    expect(screen.getByText('Awaiting input')).toBeInTheDocument();
    expect(screen.queryByText('Idle session')).not.toBeInTheDocument();
  });
});

describe('Sidebar — finalize-driven session states', () => {
  it('maps finalize statuses to the right state icon per row', () => {
    const props = buildProps({
      sessions: [
        { id: 's-ready', name: 'Finalized session' },
        { id: 's-review', name: 'Reviewing session' },
      ],
      activeTaskSessionIds: {},
      changesReadyBySession: {},
      finalizeStatusBySession: { 's-ready': 'ready_to_push', 's-review': 'reviewing' },
    });
    render(<Sidebar {...props} />);

    // ready_to_push collapses into the "pending push" state.
    expect(screen.getByTestId('session-state-icon-s-ready')).toHaveAttribute(
      'data-session-state',
      'pending_push',
    );
    expect(screen.getByTestId('session-state-icon-s-review')).toHaveAttribute(
      'data-session-state',
      'reviewing',
    );
  });

  it('falls back to waiting when finalizeStatusBySession is empty', () => {
    const props = buildProps({
      sessions: [{ id: 's-1', name: 'Plain session' }],
      activeTaskSessionIds: {},
      changesReadyBySession: {},
      finalizeStatusBySession: {},
    });
    render(<Sidebar {...props} />);
    expect(screen.getByTestId('session-state-icon-s-1')).toHaveAttribute(
      'data-session-state',
      'waiting_for_user_input',
    );
  });

  it('keeps the state icon in the project-collapsed actionable list', () => {
    const props = buildProps({
      sessions: [{ id: 's-ready', name: 'Finalized session' }],
      activeTaskSessionIds: {},
      changesReadyBySession: {},
      finalizeStatusBySession: { 's-ready': 'ready_to_push' },
    });
    render(<Sidebar {...props} />);

    fireEvent.click(screen.getByText('Test Project' as any) as any); // collapse project

    const collapsedPanel = screen.getByTestId('project-collapsed-actionable');
    expect(within(collapsedPanel).getByTestId('session-state-icon-s-ready')).toHaveAttribute(
      'data-session-state',
      'pending_push',
    );
  });
});

describe('Sidebar — New Project + Import existing project CTAs', () => {
  it('renders only the primary "+ New Project" CTA when onImportProject is not provided', () => {
    const onOpenProject = vi.fn();
    render(<Sidebar {...buildProps({ onOpenProject })} />);

    expect(screen.getByTestId('sidebar-new-project-cta')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-import-project-cta')).not.toBeInTheDocument();
  });

  it('renders both CTAs and wires them to independent callbacks', () => {
    const onOpenProject = vi.fn();
    const onImportProject = vi.fn();
    render(<Sidebar {...buildProps({ onOpenProject, onImportProject })} />);

    const newProjectCta = screen.getByTestId('sidebar-new-project-cta');
    const importCta = screen.getByTestId('sidebar-import-project-cta');

    expect(newProjectCta!).toHaveTextContent('New Project');
    expect(importCta!).toHaveTextContent('Import existing project');

    fireEvent.click(newProjectCta as any);
    expect(onOpenProject!).toHaveBeenCalledTimes(1);
    expect(onImportProject!).not.toHaveBeenCalled();

    fireEvent.click(importCta as any);
    expect(onImportProject!).toHaveBeenCalledTimes(1);
    // Primary CTA wasn't triggered a second time.
    expect(onOpenProject!).toHaveBeenCalledTimes(1);
  });
});

describe('Sidebar — archived sessions', () => {
  it('omits the Archived section when the list is empty', () => {
    render(<Sidebar {...buildProps({ archivedSessions: [] })} />);
    expect(screen.queryByTestId('archived-sessions-section')).not.toBeInTheDocument();
  });

  it('shows the collapsed Archived header with a count and hides rows until expanded', () => {
    const archived = [
      {
        id: 'arch-1',
        name: 'Deleted yesterday',
        deleted_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        message_count: 4,
      },
    ];
    render(<Sidebar {...buildProps({ archivedSessions: archived })} />);

    const section = screen.getByTestId('archived-sessions-section');
    expect(within(section).getByText(/Archived \(1\)/)).toBeInTheDocument();
    // Rows are hidden behind the chevron.
    expect(screen.queryByTestId('archived-sessions-list')).not.toBeInTheDocument();

    fireEvent.click(within(section as any).getByText(/Archived \(1\)/));
    expect(screen.getByTestId('archived-sessions-list')).toBeInTheDocument();
    expect(screen.getByText('Deleted yesterday')).toBeInTheDocument();
    // "purges in Nd" countdown should be visible.
    expect(screen.getByText(/purges in/i)).toBeInTheDocument();
  });

  it('invokes onRestoreSession when the Restore button is clicked', () => {
    const onRestoreSession = vi.fn();
    const archived = [
      {
        id: 'arch-1',
        name: 'Deleted yesterday',
        deleted_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        message_count: 4,
      },
    ];
    render(<Sidebar {...buildProps({ archivedSessions: archived, onRestoreSession })} />);
    // Expand the section first.
    fireEvent.click(screen.getByText(/Archived \(1\)/) as any);
    fireEvent.click(screen.getByRole('button', { name: /Restore/i }) as any);
    expect(onRestoreSession!).toHaveBeenCalledWith('arch-1');
  });

  it('disables the Restore button while the row is being restored', () => {
    const archived = [
      {
        id: 'arch-1',
        name: 'Deleted yesterday',
        deleted_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        message_count: 4,
      },
    ];
    render(
      <Sidebar
        {...buildProps({
          archivedSessions: archived,
          restoringSessionIds: new Set(['arch-1']),
        })}
      />,
    );
    fireEvent.click(screen.getByText(/Archived \(1\)/) as any);
    const btn = screen.getByRole('button', { name: /Restore/i });
    expect(btn!).toBeDisabled();
  });
});

describe('Sidebar — version footer (server-only in browser)', () => {
  // /api/health is mocked in the global beforeEach to return
  //   { version: 'test', gitHash: 'abc' }
  // In Electron the footer shows v{clientVersion} as primary with a
  // server-mismatch chip; in a plain browser the client and server are
  // the same artifact, so only the server version renders.

  it('opens the releases page when the version label is clicked', async () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...buildProps({ onNavigate })} />);
    const serverVersion = await screen.findByRole('button', { name: 'vtest' });
    fireEvent.click(serverVersion as any);
    expect(onNavigate!).toHaveBeenCalledWith('releases');
  });

  it('shows ONLY the server version in a plain browser (no client v-prefix, no mismatch chip)', async () => {
    render(<Sidebar {...buildProps()} />);
    // Wait for the /api/health useEffect to land.
    const serverVersion = await screen.findByRole('button', { name: 'vtest' });
    expect(serverVersion!).toBeInTheDocument();
    // The mismatch chip is the only other place the literal "server v…"
    // appears — it MUST NOT render in the browser path.
    expect(screen.queryByText(/server v/)).not.toBeInTheDocument();
  });

  it('renders the build hash (server hash) as plain text in the browser', async () => {
    render(<Sidebar {...buildProps()} />);
    await waitFor(() => {
      expect(screen.getByText('abc')).toBeInTheDocument();
    });
    // No mismatch-style "server abc" chip should appear.
    expect(screen.queryByText(/server abc/)).not.toBeInTheDocument();
  });

  it('in Electron, keeps the client-primary line with the server-mismatch chip', async () => {
    const origElectronAPI = globalThis.window.electronAPI;
    globalThis.window.electronAPI = { isElectron: true };
    try {
      render(<Sidebar {...buildProps()} />);
      // useClientBuildVersion() returns 'unknown' in the test bundle (no
      // VITE_APP_VERSION baked in), so the primary line reads "vunknown".
      // The server returned "test" via the mocked fetch, so the chip
      // appears because the two values differ.
      await screen.findByText('vunknown');
      await screen.findByText(/server vtest/);
    } finally {
      if (origElectronAPI === undefined) {
        delete (globalThis as any).window.electronAPI;
      } else {
        globalThis.window.electronAPI = origElectronAPI;
      }
    }
  });
});

describe('Sidebar — org switcher gating (Electron-only)', () => {
  // The web app is locked to a single Hub server, so the org switcher
  // (which manages remote Hub-server bookmarks) only renders in Electron.

  it('does NOT render the OrgSwitcher when window.electronAPI is missing (browser)', () => {
    // jsdom default: no electronAPI bridge.
    render(<Sidebar {...buildProps()} />);
    expect(screen.queryByTestId('org-switcher-stub')).not.toBeInTheDocument();
  });

  it('renders the OrgSwitcher when window.electronAPI.isElectron is true', () => {
    const origElectronAPI = globalThis.window.electronAPI;
    globalThis.window.electronAPI = { isElectron: true };
    try {
      render(<Sidebar {...buildProps()} />);
      expect(screen.getByTestId('org-switcher-stub')).toBeInTheDocument();
    } finally {
      if (origElectronAPI === undefined) {
        delete (globalThis as any).window.electronAPI;
      } else {
        globalThis.window.electronAPI = origElectronAPI;
      }
    }
  });
});

describe('Sidebar — reviewer agents are hidden from the agent list', () => {
  it('does not render the reviewer agent row, but exposes the per-project Reviewer page link', () => {
    const reviewerId = 'reviewer-agent';
    const props = buildProps({
      projects: [
        {
          id: PROJECT_ID,
          name: 'Test Project',
          color: '#22d3ee',
          agents: [
            { id: AGENT_ID, name: 'Primary Agent', color: '#22d3ee', role: 'lead', active: true },
            {
              id: reviewerId,
              name: 'PR Reviewer Bot',
              color: '#a78bfa',
              role: 'reviewer',
              active: true,
            },
          ],
        },
      ],
    });
    render(<Sidebar {...props} />);
    // Non-reviewer agent still renders.
    expect(screen.getByText('Primary Agent')).toBeInTheDocument();
    // The reviewer agent row is suppressed entirely (it runs as an in-session advisor).
    expect(screen.queryByText('PR Reviewer Bot')).not.toBeInTheDocument();
    // The dedicated per-project Reviewer page link lives in the project menu.
    fireEvent.click(screen.getByTestId(`sidebar-project-menu-toggle-${PROJECT_ID}` as any) as any);
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
  });

  it('does not show the Reviewer page link for a project without a reviewer agent', () => {
    const props = buildProps({
      projects: [
        {
          id: PROJECT_ID,
          name: 'Test Project',
          color: '#22d3ee',
          agents: [
            { id: AGENT_ID, name: 'Primary Agent', color: '#22d3ee', role: 'lead', active: true },
          ],
        },
      ],
    });
    render(<Sidebar {...props} />);
    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument();
  });

  it('still shows "+ New Session" for a non-reviewer agent in the same project', () => {
    const props = buildProps({
      projects: [
        {
          id: PROJECT_ID,
          name: 'Test Project',
          color: '#22d3ee',
          agents: [
            { id: AGENT_ID, name: 'Primary Agent', color: '#22d3ee', role: 'lead', active: true },
          ],
        },
      ],
    });
    render(<Sidebar {...props} />);
    expect(screen.getByText('+ New Session')).toBeInTheDocument();
  });
});

describe('Sidebar — project reordering (drag & drop)', () => {
  const THREE_PROJECTS = [
    {
      id: 'p-alpha',
      name: 'Alpha',
      color: '#22d3ee',
      agents: [{ id: 'p-alpha-a', name: 'Alpha A', color: '#22d3ee', active: true }],
    },
    {
      id: 'p-beta',
      name: 'Beta',
      color: '#a78bfa',
      agents: [{ id: 'p-beta-a', name: 'Beta A', color: '#a78bfa', active: true }],
    },
    {
      id: 'p-gamma',
      name: 'Gamma',
      color: '#fb7185',
      agents: [{ id: 'p-gamma-a', name: 'Gamma A', color: '#fb7185', active: true }],
    },
  ];

  // Helper: fire a drag sequence that mirrors what the browser does.
  // jsdom's DataTransfer is incomplete, so we stub setData/getData via a
  // shared Map and pass that through every event's dataTransfer.
  const buildDataTransfer = () => {
    const store = new Map();
    return {
      setData: (k: any, v: any) => store.set(k, v),
      getData: (k: any) => store.get(k) || '',
      effectAllowed: '',
      dropEffect: '',
    };
  };

  it('exposes a draggable grip handle on each project when onReorderProjects is provided', () => {
    render(<Sidebar {...buildProps({ projects: THREE_PROJECTS, onReorderProjects: vi.fn() })} />);
    const grip = screen.getByTestId('sidebar-project-drag-handle-p-alpha');
    expect(grip.getAttribute('draggable')).toBe('true');
    expect(grip.getAttribute('data-drag-handle')).not.toBeNull();
    // The row itself stays non-draggable so clicks on agent links and the
    // collapse chevron don't accidentally initiate a reorder gesture.
    const alphaRow = screen.getByTestId('sidebar-project-row-p-alpha');
    expect(alphaRow.getAttribute('draggable')).not.toBe('true');
  });

  it('does not render the grip handle when onReorderProjects is omitted', () => {
    render(<Sidebar {...buildProps({ projects: THREE_PROJECTS })} />);
    expect(screen.queryByTestId('sidebar-project-drag-handle-p-alpha')).not.toBeInTheDocument();
  });

  it('invokes onReorderProjects with the new id order when a project is dragged onto another', () => {
    const onReorderProjects = vi.fn();
    render(<Sidebar {...buildProps({ projects: THREE_PROJECTS, onReorderProjects })} />);
    const alphaHandle = screen.getByTestId('sidebar-project-drag-handle-p-alpha');
    const gammaRow = screen.getByTestId('sidebar-project-row-p-gamma');

    const dt = buildDataTransfer();
    fireEvent.dragStart(alphaHandle, { dataTransfer: dt });
    fireEvent.dragOver(gammaRow, { dataTransfer: dt });
    fireEvent.drop(gammaRow, { dataTransfer: dt });

    // Drop-on semantics: dropping Alpha onto Gamma inserts Alpha at
    // Gamma's slot (Gamma shifts down). Source travelling forward (idx 0
    // → idx 2) so insertIdx = 2 - 1 = 1. Result: [beta, alpha, gamma].
    expect(onReorderProjects!).toHaveBeenCalledTimes(1);
    expect(onReorderProjects!).toHaveBeenCalledWith(['p-beta', 'p-alpha', 'p-gamma']);
  });

  it('inserts at the target slot when dragging backward', () => {
    const onReorderProjects = vi.fn();
    render(<Sidebar {...buildProps({ projects: THREE_PROJECTS, onReorderProjects })} />);
    const gammaHandle = screen.getByTestId('sidebar-project-drag-handle-p-gamma');
    const alphaRow = screen.getByTestId('sidebar-project-row-p-alpha');

    const dt = buildDataTransfer();
    fireEvent.dragStart(gammaHandle, { dataTransfer: dt });
    fireEvent.dragOver(alphaRow, { dataTransfer: dt });
    fireEvent.drop(alphaRow, { dataTransfer: dt });

    // Source travelling backward (idx 2 → idx 0) so insertIdx stays at 0.
    // Result: [gamma, alpha, beta].
    expect(onReorderProjects!).toHaveBeenCalledWith(['p-gamma', 'p-alpha', 'p-beta']);
  });

  it('is a no-op when a project is dropped on itself', () => {
    const onReorderProjects = vi.fn();
    render(<Sidebar {...buildProps({ projects: THREE_PROJECTS, onReorderProjects })} />);
    const betaHandle = screen.getByTestId('sidebar-project-drag-handle-p-beta');
    const betaRow = screen.getByTestId('sidebar-project-row-p-beta');
    const dt = buildDataTransfer();
    fireEvent.dragStart(betaHandle, { dataTransfer: dt });
    // The row's onDragOver early-returns when source === target, so the
    // drop indicator never lights up and onReorderProjects stays unused.
    fireEvent.dragOver(betaRow, { dataTransfer: dt });
    fireEvent.drop(betaRow, { dataTransfer: dt });
    expect(onReorderProjects!).not.toHaveBeenCalled();
  });

  it('exposes an end-of-list drop zone only while a drag is in progress', () => {
    const onReorderProjects = vi.fn();
    const { rerender: _rerender } = render(
      <Sidebar {...buildProps({ projects: THREE_PROJECTS, onReorderProjects })} />,
    );
    // No drag yet → no sentinel.
    expect(screen.queryByTestId('sidebar-project-drop-zone-end')).not.toBeInTheDocument();

    const alphaHandle = screen.getByTestId('sidebar-project-drag-handle-p-alpha');
    const dt = buildDataTransfer();
    fireEvent.dragStart(alphaHandle, { dataTransfer: dt });

    // Mid-drag → sentinel is present.
    expect(screen.getByTestId('sidebar-project-drop-zone-end')).toBeInTheDocument();
  });

  it('moves the dragged project to the last position when dropped on the end-of-list zone', () => {
    const onReorderProjects = vi.fn();
    render(<Sidebar {...buildProps({ projects: THREE_PROJECTS, onReorderProjects })} />);
    const alphaHandle = screen.getByTestId('sidebar-project-drag-handle-p-alpha');
    const dt = buildDataTransfer();
    fireEvent.dragStart(alphaHandle, { dataTransfer: dt });

    const endZone = screen.getByTestId('sidebar-project-drop-zone-end');
    fireEvent.dragOver(endZone, { dataTransfer: dt });
    fireEvent.drop(endZone, { dataTransfer: dt });

    // Alpha removed from slot 0, pushed to the back. Result: [beta, gamma, alpha].
    expect(onReorderProjects!).toHaveBeenCalledTimes(1);
    expect(onReorderProjects!).toHaveBeenCalledWith(['p-beta', 'p-gamma', 'p-alpha']);
  });

  it('survives a dragLeave whose relatedTarget is a descendant (no throw, drop still wires)', () => {
    // Reviewer feedback (3/10 non-blocking): leaving the project row into
    // a child (e.g. an agent link in the same row) used to clear
    // `dragOverProjectId`, making the drop indicator flicker. The
    // handler now guards with `currentTarget.contains(relatedTarget)`.
    //
    // Verifying the flicker visually requires React state to propagate
    // across separate `fireEvent` calls, which it does not reliably do
    // in jsdom under React 18's auto-batching. Instead this test pins
    // the handler's surface contract: passing a Node-valued
    // relatedTarget must not throw and must not break the subsequent
    // drop. The visual behaviour is exercised by the production code
    // path (`currentTarget.contains(relatedTarget)`) and is small enough
    // to verify by reading.
    const onReorderProjects = vi.fn();
    render(<Sidebar {...buildProps({ projects: THREE_PROJECTS, onReorderProjects })} />);
    const alphaHandle = screen.getByTestId('sidebar-project-drag-handle-p-alpha');
    const gammaRow = screen.getByTestId('sidebar-project-row-p-gamma');
    const dt = buildDataTransfer();
    fireEvent.dragStart(alphaHandle, { dataTransfer: dt });
    fireEvent.dragOver(gammaRow, { dataTransfer: dt });

    // Simulate the pointer crossing into a child element of gammaRow.
    const childOfGamma = gammaRow.querySelector('button');
    expect(childOfGamma!).not.toBeNull();
    expect(() => {
      fireEvent.dragLeave(gammaRow, { relatedTarget: childOfGamma, dataTransfer: dt });
    }).not.toThrow();

    // Drop still routes through dataTransfer and produces the expected reorder.
    fireEvent.drop(gammaRow, { dataTransfer: dt });
    expect(onReorderProjects!).toHaveBeenCalledWith(['p-beta', 'p-alpha', 'p-gamma']);
  });
});

describe('Sidebar — per-project settings menu', () => {
  const expandMenu = () => {
    fireEvent.click(screen.getByTestId(`sidebar-project-menu-toggle-${PROJECT_ID}` as any) as any);
  };

  it('keeps project agents above the project menu in the sidebar', () => {
    render(<Sidebar {...buildProps()} />);

    expect(screen.getByTestId(`sidebar-project-row-${PROJECT_ID}`)).toHaveClass('flex-col');
    expect(screen.getByTestId(`sidebar-project-agents-${PROJECT_ID}`)).toHaveClass('order-1');
    expect(screen.getByTestId(`sidebar-project-menu-wrap-${PROJECT_ID}`)).toHaveClass('order-2');
  });

  it('shows lifecycle links top-level and keeps configuration collapsed by default', () => {
    render(<Sidebar {...buildProps()} />);
    expect(screen.getByRole('button', { name: 'Test Project Settings' })).toBeInTheDocument();

    // Lifecycle links are always visible (no Settings expand needed).
    expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Epics' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Skills' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Threads' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wiki' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pulls' })).toBeInTheDocument();

    // Configuration items stay hidden until the Settings menu is expanded.
    expect(screen.queryByRole('button', { name: 'Runners' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Agents' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Project Configuration' })).toBeNull();
  });

  it('navigates from the top-level lifecycle links without expanding Settings', () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...buildProps({ onNavigate })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Board' } as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith(`kanban:${PROJECT_ID}`);

    fireEvent.click(screen.getByRole('button', { name: 'Skills' } as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith(`skills:${PROJECT_ID}`);

    fireEvent.click(screen.getByRole('button', { name: 'Threads' } as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith('threads', PROJECT_ID);

    fireEvent.click(screen.getByRole('button', { name: 'Wiki' } as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith('wiki', PROJECT_ID);

    fireEvent.click(screen.getByRole('button', { name: 'Pulls' } as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith('pulls', PROJECT_ID);

    // Settings stays collapsed — config links never rendered.
    expect(screen.queryByRole('button', { name: 'Runners' })).toBeNull();
  });

  // Regression: Notes had no sidebar entry (keyboard-only) before this.
  it('renders a top-level Notes link that navigates to the notes view', () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...buildProps({ onNavigate })} />);

    const notes = screen.getByRole('button', { name: 'Notes' });
    expect(notes!).toBeInTheDocument();
    fireEvent.click(notes as any);
    expect(onNavigate!).toHaveBeenCalledWith('notes', PROJECT_ID);
  });

  it('renders a top-level Wiki link that navigates to the wiki view', () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...buildProps({ onNavigate })} />);

    const wiki = screen.getByRole('button', { name: 'Wiki' });
    expect(wiki!).toBeInTheDocument();
    fireEvent.click(wiki as any);
    expect(onNavigate!).toHaveBeenCalledWith('wiki', PROJECT_ID);
  });

  it('renders a top-level Skills link that navigates to the project skills view', () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...buildProps({ onNavigate })} />);

    const skills = screen.getByRole('button', { name: 'Skills' });
    expect(skills!).toBeInTheDocument();
    fireEvent.click(skills as any);
    expect(onNavigate!).toHaveBeenCalledWith(`skills:${PROJECT_ID}`);
  });

  it('highlights the Skills link only on the matching project skills view', () => {
    const { rerender } = render(
      <Sidebar {...buildProps({ currentView: `skills:${PROJECT_ID}` })} />,
    );
    expect(screen.getByRole('button', { name: 'Skills' }).className).toContain('text-white');

    rerender(<Sidebar {...buildProps({ currentView: 'skills:other-project' })} />);
    expect(screen.getByRole('button', { name: 'Skills' }).className).not.toContain('text-white');
  });

  it('highlights the Wiki link only on the matching project wiki view', () => {
    const { rerender } = render(
      <Sidebar {...buildProps({ currentView: 'wiki', wikiProjectId: PROJECT_ID })} />,
    );
    expect(screen.getByRole('button', { name: 'Wiki' }).className).toContain('text-white');

    rerender(<Sidebar {...buildProps({ currentView: 'wiki', wikiProjectId: 'other-project' })} />);
    expect(screen.getByRole('button', { name: 'Wiki' }).className).not.toContain('text-white');
  });

  // Regression: the Notes active highlight depends on the `notesProjectId` prop
  // being threaded from the parent (App.jsx). Lock in that the row highlights on
  // the notes view for this project, and does NOT highlight for other views or
  // a different project's notes.
  it('highlights the Notes link only on the matching project notes view', () => {
    // `text-white` is applied only by the active branch of projectMenuLinkClass
    // (the inactive branch uses text-gray-500 + hover:bg-gray-800/50).
    const { rerender } = render(
      <Sidebar {...buildProps({ currentView: 'notes', notesProjectId: PROJECT_ID })} />,
    );
    expect(screen.getByRole('button', { name: 'Notes' }).className).toContain('text-white');

    // Notes view, but for a different project → not highlighted here.
    rerender(
      <Sidebar {...buildProps({ currentView: 'notes', notesProjectId: 'other-project' })} />,
    );
    expect(screen.getByRole('button', { name: 'Notes' }).className).not.toContain('text-white');

    // Different view entirely → not highlighted.
    rerender(<Sidebar {...buildProps({ currentView: 'chat', notesProjectId: PROJECT_ID })} />);
    expect(screen.getByRole('button', { name: 'Notes' }).className).not.toContain('text-white');
  });

  it('expands the Settings menu to reveal configuration links', () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...buildProps({ onNavigate })} />);
    expandMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Project Configuration' } as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith(`project-settings:${PROJECT_ID}`);

    fireEvent.click(screen.getByRole('button', { name: 'Runners' } as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith(`runners:${PROJECT_ID}`);

    fireEvent.click(screen.getByRole('button', { name: 'Previews' } as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith(`preview:${PROJECT_ID}`);

    fireEvent.click(screen.getByRole('button', { name: 'Agents' } as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith(`project-agents:${PROJECT_ID}`);

    fireEvent.click(screen.getByRole('button', { name: 'Cron Jobs' } as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith(`project-crons:${PROJECT_ID}`);
  });

  // Regression: every configuration route (including Cron Jobs) must mark the
  // "<project> Settings" toggle active, so the active page isn't hidden under a
  // collapsed, inactive-looking group on initial render / reload. `text-gray-200`
  // is applied only by the active branch of the toggle's class (inactive uses
  // text-gray-500).
  it('marks the Settings toggle active for every configuration route', () => {
    const configRoutes = [
      `project-settings:${PROJECT_ID}`,
      `project-agents:${PROJECT_ID}`,
      `runners:${PROJECT_ID}`,
      `preview:${PROJECT_ID}`,
      `project-crons:${PROJECT_ID}`,
    ];
    const { rerender } = render(<Sidebar {...buildProps({ currentView: configRoutes[0] })} />);
    for (const view of configRoutes) {
      rerender(<Sidebar {...buildProps({ currentView: view })} />);
      const toggle = screen.getByTestId(`sidebar-project-menu-toggle-${PROJECT_ID}`);
      expect(toggle.className, `expected toggle active for ${view}`).toContain('text-gray-200');
    }

    // A lifecycle (top-level) route must NOT activate the Settings toggle.
    rerender(<Sidebar {...buildProps({ currentView: `kanban:${PROJECT_ID}` })} />);
    expect(screen.getByTestId(`sidebar-project-menu-toggle-${PROJECT_ID}`).className).not.toContain(
      'text-gray-200',
    );
  });

  it('does not render the Workflows entry (temporarily hidden)', () => {
    render(<Sidebar {...buildProps()} />);
    expect(screen.queryByRole('button', { name: 'Workflows' })).toBeNull();
  });

  it('hides AWS inside the menu when the project has not enabled AWS', () => {
    render(<Sidebar {...buildProps()} />);
    expandMenu();
    expect(screen.queryByRole('button', { name: 'AWS' })).toBeNull();
  });

  it('renders AWS inside the menu when awsEnabled', () => {
    const onNavigate = vi.fn();
    const projects = [
      {
        id: PROJECT_ID,
        name: 'Test Project',
        color: '#22d3ee',
        awsEnabled: true,
        agents: [{ id: AGENT_ID, name: 'Primary Agent', color: '#22d3ee', active: true }],
      },
    ];
    render(<Sidebar {...buildProps({ projects, onNavigate })} />);
    expandMenu();

    fireEvent.click(screen.getByRole('button', { name: 'AWS' } as any) as any);
    expect(onNavigate!).toHaveBeenCalledWith(`aws:${PROJECT_ID}`);
  });
});

describe('Sidebar kanban board mode', () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: 'test', gitHash: 'abc' }) as any,
    });
  });

  it('shows the kanban board panel above the Projects section', () => {
    render(
      <Sidebar
        {...buildProps({
          currentView: 'kanban:proj-1',
          kanbanProjectId: 'proj-1',
          kanbanProjectName: 'Test Project',
          kanbanSearchQuery: '',
          onKanbanSearchChange: vi.fn(),
          kanbanSelectedEpicIds: new Set(),
          onKanbanSelectedEpicIdsChange: vi.fn(),
          onOpenKanbanEpics: vi.fn(),
          onOpenProject: vi.fn(),
        })}
      />,
    );

    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-new-project-cta')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-sidebar-epics-panel')).toBeInTheDocument();
  });

  it('scrolls the board filters into view when the board opens', async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      render(
        <Sidebar
          {...buildProps({
            currentView: 'kanban:proj-1',
            kanbanProjectId: 'proj-1',
            kanbanProjectName: 'Test Project',
            kanbanSearchQuery: '',
            onKanbanSearchChange: vi.fn(),
            kanbanSelectedEpicIds: new Set(),
            onKanbanSelectedEpicIdsChange: vi.fn(),
          })}
        />,
      );

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', inline: 'nearest' });
      expect(screen.getByTestId('kanban-sidebar-filters-anchor')).toBeInTheDocument();
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
