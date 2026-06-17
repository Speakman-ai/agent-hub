/**
 * Regression: cross-project session switches must drive header/chat accent from
 * the session owner's project color, not the previously active agent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import App from './App.jsx';

const PROJECTS = [
  {
    id: 'p-hub',
    name: 'Agent Hub',
    color: '#8B5CF6',
    cwd: '/hub',
    agents: [
      { id: 'a-hub', name: 'Hub Lead', color: '#111111', active: true, engine: 'claude-code' },
    ],
  },
  {
    id: 'p-st',
    name: 'Survey Tracker',
    color: '#10B981',
    cwd: '/st',
    agents: [
      { id: 'a-st', name: 'ST Lead', color: '#222222', active: true, engine: 'claude-code' },
    ],
  },
];

const sessionsByAgent = {
  'a-hub': [{ id: 's-hub', name: 'Hub chat', agent_id: 'a-hub', engine: 'claude-code' }],
  'a-st': [{ id: 's-st', name: 'ST chat', agent_id: 'a-st', engine: 'claude-code' }],
};

vi.mock('./utils/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      ...actual.api,
      getProjects: vi.fn(() => Promise.resolve(PROJECTS)),
      getSessions: vi.fn((agentId) => Promise.resolve(sessionsByAgent[agentId] || [])),
      getArchivedSessions: vi.fn(() => Promise.resolve([])),
      getMessages: vi.fn(() => Promise.resolve([])),
      getSessionHandoffs: vi.fn(() => Promise.resolve([])),
      getSessionProgress: vi.fn(() => Promise.resolve({ steps: [] })),
      getConfig: vi.fn(() => Promise.resolve({})),
      getAuthStatus: vi.fn(() =>
        Promise.resolve({ authConfigured: true, firstRun: false, needsMigration: false }),
      ),
      getOrgs: vi.fn(() => Promise.resolve([])),
      getAgents: vi.fn(() => Promise.resolve([])),
      getSkills: vi.fn(() => Promise.resolve([])),
      getDesigns: vi.fn(() => Promise.resolve([])),
      getCronSessions: vi.fn(() => Promise.resolve([])),
      getRooms: vi.fn(() => Promise.resolve([])),
      getModelConfig: vi.fn(() =>
        Promise.resolve({ engineDefaultModels: { 'claude-code': 'claude-opus-4-8' } }),
      ),
    },
  };
});

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({ connected: true, reconnecting: false, send: vi.fn() }),
}));

vi.mock('./components/Sidebar.jsx', () => ({
  default: (props) => {
    if (props.onFocusSession) globalThis.__ahTestFocusSession = props.onFocusSession;
    return <div data-testid="sidebar-stub" />;
  },
}));

vi.mock('./components/TopBar.jsx', () => ({
  default: ({ accentColor, agent }) => (
    <div
      data-testid="topbar-stub"
      data-accent-color={accentColor || ''}
      data-agent-id={agent?.id || ''}
    />
  ),
}));

vi.mock('./components/MessageInput.jsx', () => ({
  default: ({ agentColor }) => (
    <div data-testid="message-input-stub" data-agent-color={agentColor || ''} />
  ),
}));

describe('App — project accent on cross-project session switch', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('activeAgentId', 'a-hub');
    globalThis.__ahTestFocusSession = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('updates TopBar accent when focusing a session in another project', async () => {
    render(<App />);

    await waitFor(() => expect(typeof globalThis.__ahTestFocusSession).toBe('function'));

    await act(async () => {
      globalThis.__ahTestFocusSession('a-hub', 's-hub');
    });

    await waitFor(() => {
      expect(screen.getByTestId('topbar-stub')).toHaveAttribute('data-accent-color', '#8B5CF6');
    });

    await act(async () => {
      globalThis.__ahTestFocusSession('a-st', 's-st');
    });

    await waitFor(() => {
      expect(screen.getByTestId('topbar-stub')).toHaveAttribute('data-accent-color', '#10B981');
      expect(screen.getByTestId('topbar-stub')).toHaveAttribute('data-agent-id', 'a-st');
      expect(screen.getByTestId('message-input-stub')).toHaveAttribute(
        'data-agent-color',
        '#10B981',
      );
    });
  });
});
