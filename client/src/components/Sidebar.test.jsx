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

  return {
    projects,
    agents: [],
    activeAgentId: AGENT_ID,
    onSelectAgent: vi.fn(),
    sessions,
    activeSessionId: null,
    onSelectSession: vi.fn(),
    onNewSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onClearAllSessions: vi.fn(),
    onClearInactiveSessions: vi.fn(),
    onRenameSession: vi.fn(),
    onNavigate: vi.fn(),
    currentView: 'chat',
    activeTaskSessionIds: { 's-running': true },
    rooms: [],
    changesReadyBySession: { 's-pr': { branch: 'feat/foo' } },
    ...overrides,
  };
};

describe('Sidebar — actionable session visibility', () => {
  it('shows all sessions (running, PR-ready, idle) when the agent is expanded', () => {
    render(<Sidebar {...buildProps()} />);
    // Default state: active agent is expanded, so all three sessions render.
    expect(screen.getByText('Running task')).toBeInTheDocument();
    expect(screen.getByText('PR ready session')).toBeInTheDocument();
    expect(screen.getByText('Idle session')).toBeInTheDocument();
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
});
