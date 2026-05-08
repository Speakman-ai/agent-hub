import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import Sidebar from './Sidebar.jsx';

// OrgSwitcher hits the server on mount; stub it so we can render Sidebar standalone.
vi.mock('./OrgSwitcher.jsx', () => ({
  default: () => <div data-testid="org-switcher-stub" />,
}));

// getServerBase is invoked from a useEffect that fetches /api/health. Stub fetch.
beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ version: 'test', gitHash: 'abc' }),
  });
});

const PROJECT_ID = 'proj-1';
const AGENT_ID = 'agent-1';
const OTHER_AGENT_ID = 'agent-2';

const buildProps = (overrides = {}) => {
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
  const onSelectSession = overrides.onSelectSession || vi.fn();
  const onNavigate = overrides.onNavigate || vi.fn();
  return {
    projects,
    agents: [],
    activeAgentId: AGENT_ID,
    onSelectAgent,
    onFocusSession:
      overrides.onFocusSession ||
      ((agentId, sessionId) => {
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
    onClearInactiveSessions: vi.fn(),
    onRenameSession: vi.fn(),
    onNavigate,
    currentView: 'chat',
    activeTaskSessionIds: { 's-running': true },
    rooms: [],
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

describe('Sidebar — actionable session visibility', () => {
  it('shows all sessions (running, PR-ready, idle) when the agent is expanded', () => {
    render(<Sidebar {...buildProps()} />);
    // Default state: active agent is expanded, so all three sessions render.
    expect(screen.getByText('Running task')).toBeInTheDocument();
    expect(screen.getByText('PR ready session')).toBeInTheDocument();
    expect(screen.getByText('Idle session')).toBeInTheDocument();
  });

  it('invokes onFocusSession with agent and session id when a session row is clicked', () => {
    const onFocusSession = vi.fn();
    render(<Sidebar {...buildProps({ onFocusSession })} />);
    fireEvent.click(screen.getByText('PR ready session'));
    expect(onFocusSession).toHaveBeenCalledWith(AGENT_ID, 's-pr');
  });

  it('hides idle sessions but keeps running and PR-ready ones when the agent is collapsed', () => {
    render(<Sidebar {...buildProps()} />);

    // Collapse the active agent by clicking its ▾ chevron.
    const collapseBtn = screen.getByRole('button', { name: '▾' });
    fireEvent.click(collapseBtn);

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

    const collapseBtn = screen.getByRole('button', { name: '▾' });
    fireEvent.click(collapseBtn);

    expect(screen.queryByText('Only idle session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-sessions-list')).not.toBeInTheDocument();
  });

  it('renders an actionable-only branch when the project is collapsed', () => {
    render(<Sidebar {...buildProps()} />);

    // The project row is a button containing the project name + chevron span.
    // Click it to toggle project collapse.
    fireEvent.click(screen.getByText('Test Project'));

    // Project-collapsed fallback should render with only actionable sessions.
    const collapsedPanel = screen.getByTestId('project-collapsed-actionable');
    expect(within(collapsedPanel).getByText('Running task')).toBeInTheDocument();
    expect(within(collapsedPanel).getByText('PR ready session')).toBeInTheDocument();
    expect(within(collapsedPanel).queryByText('Idle session')).not.toBeInTheDocument();

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

    fireEvent.click(screen.getByText('Test Project')); // collapse project

    expect(screen.queryByTestId('project-collapsed-actionable')).not.toBeInTheDocument();
    expect(screen.queryByText('Only idle session')).not.toBeInTheDocument();
  });

  it('treats Resolve PR sessions with only changes_ready as non-actionable when agent is collapsed', () => {
    const props = buildProps({
      sessions: [{ id: 's-resolve', name: '[Resolve PR #77] Fix thing' }],
      activeTaskSessionIds: {},
      changesReadyBySession: { 's-resolve': { branch: 'fix/77' } },
    });
    render(<Sidebar {...props} />);

    expect(screen.getByText('[Resolve PR #77] Fix thing')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '▾' }));

    expect(screen.queryByText('[Resolve PR #77] Fix thing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-sessions-list')).not.toBeInTheDocument();
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

    expect(newProjectCta).toHaveTextContent('New Project');
    expect(importCta).toHaveTextContent('Import existing project');

    fireEvent.click(newProjectCta);
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(onImportProject).not.toHaveBeenCalled();

    fireEvent.click(importCta);
    expect(onImportProject).toHaveBeenCalledTimes(1);
    // Primary CTA wasn't triggered a second time.
    expect(onOpenProject).toHaveBeenCalledTimes(1);
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

    fireEvent.click(within(section).getByText(/Archived \(1\)/));
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
    fireEvent.click(screen.getByText(/Archived \(1\)/));
    fireEvent.click(screen.getByRole('button', { name: /Restore/i }));
    expect(onRestoreSession).toHaveBeenCalledWith('arch-1');
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
    fireEvent.click(screen.getByText(/Archived \(1\)/));
    const btn = screen.getByRole('button', { name: /Restore/i });
    expect(btn).toBeDisabled();
  });
});
