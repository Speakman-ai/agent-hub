/**
 * Regression: in-flight Interrupt on a queued message with persisted attachments
 * must re-send via WS `chat` with `images` refs — never re-upload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null,
  /** @type {Record<string, (value: unknown) => void>} */
  resolveSessionsByAgent: {},
  /** @type {((data: unknown) => void) | null} */
  onMessage: null,
  /** @type {unknown[]} */
  sends: [],
}));

const { PERSISTED_ATTACHMENT, QUEUED_MESSAGE_ROW } = vi.hoisted(() => {
  const att = {
    id: 'img-existing',
    filename: 'existing.png',
    originalName: 'existing.png',
    contentType: 'image/png',
    url: '/uploads/existing.png',
  };
  return {
    PERSISTED_ATTACHMENT: att,
    QUEUED_MESSAGE_ROW: {
      id: 'q-msg-1',
      session_id: 's-1',
      role: 'user',
      content: 'follow-up while streaming',
      attachments: JSON.stringify([att]),
      queued: true,
      created_at: new Date().toISOString(),
    },
  };
});

vi.mock('./utils/orgs.js', () => ({
  migrateFromLegacy: () => Promise.resolve(),
  fetchOrgs: () => Promise.resolve(),
  getActiveOrg: () => null,
  getOrgs: () => ({ orgs: [] }),
  getActiveOrgApiId: () => 'default',
  switchOrg: () => Promise.resolve(),
  reloadForOrgSwitch: () => {},
}));

vi.mock('./utils/connection.js', () => ({
  getApiBase: () => 'http://localhost:3051',
  getAuthHeaders: () => ({}),
  getServerBase: () => 'http://localhost:3051',
}));

vi.mock('./components/Sidebar.jsx', () => ({
  default: function MockSidebar() {
    return <div data-testid="sidebar-mock" />;
  },
}));

vi.mock('./components/SessionSummarySidebar.jsx', () => ({
  default: function MockSessionSummary() {
    return <div data-testid="session-summary-mock" />;
  },
}));

vi.mock('./components/MessageInput.jsx', () => ({
  default: function MockMessageInput() {
    return <div data-testid="message-input-mock" />;
  },
}));

vi.mock('./components/TopBar.jsx', () => ({
  default: function MockTopBar() {
    return <div data-testid="topbar-mock" />;
  },
}));

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: (onMessage) => {
    ctl.onMessage = onMessage;
    return {
      send: vi.fn((data) => {
        ctl.sends.push(data);
        return true;
      }),
      connected: true,
      reconnecting: false,
      wsRef: { current: null },
    };
  },
}));

vi.mock('./hooks/useDesktopNotifications.js', () => ({
  useDesktopNotifications: () => ({ notify: vi.fn() }),
}));

vi.mock('./hooks/useKeyboardShortcuts.js', () => ({
  useKeyboardShortcuts: () => {},
}));

vi.mock('./hooks/useVersionCheck.js', () => ({
  useVersionCheck: () => ({
    updateAvailable: false,
    serverVersion: null,
    clientVersion: '0',
    downloadUrl: '',
    dismiss: vi.fn(),
  }),
}));

vi.mock('./utils/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  const empty = { engineDefaultModels: { 'claude-code': 'claude-opus-4-8' } };
  return {
    ...mod,
    api: {
      ...mod.api,
      getModelConfig: vi.fn().mockResolvedValue(empty),
      getProjects: vi.fn(
        () =>
          new Promise((resolve) => {
            ctl.resolveProjects = resolve;
          }),
      ),
      getSessions: vi.fn(
        (agentId) =>
          new Promise((resolve) => {
            ctl.resolveSessionsByAgent[agentId] = resolve;
          }),
      ),
      getArchivedSessions: vi.fn().mockResolvedValue([]),
      getSkills: vi.fn().mockResolvedValue([]),
      getRooms: vi.fn().mockResolvedValue([]),
      getDesigns: vi.fn().mockResolvedValue([]),
      getCronSessions: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([QUEUED_MESSAGE_ROW]),
      getSessionHandoffs: vi.fn().mockResolvedValue([]),
      getSessionProgress: vi.fn().mockResolvedValue({ steps: [] }),
      ensureSessionWorkspace: vi.fn().mockResolvedValue({ ok: true, skipped: true }),
      uploadImage: vi.fn(),
      uploadFile: vi.fn(),
    },
  };
});

const PROJECT_FIXTURE = [
  {
    id: 'proj-1',
    name: 'Project',
    color: '#3b82f6',
    cwd: '/tmp/w',
    ahw: '/tmp/w',
    agents: [
      { id: 'agent-1', name: 'A1', color: '#3b82f6', engine: 'claude-code' },
      {
        id: 'reviewer-1',
        name: 'Reviewer',
        color: '#a855f7',
        engine: 'claude-code',
        role: 'reviewer',
      },
    ],
  },
];

const ONE_SESSION = [{ id: 's-1', name: 'S1', agent_id: 'agent-1', engine: 'claude-code' }];

import App from './App.jsx';
import { api } from './utils/api.js';

function reviewerStreamLabels() {
  return screen
    .queryAllByText('Reviewer')
    .filter((el) => String(el.className || '').includes('text-gray-500'));
}

function mockFetch() {
  globalThis.fetch = vi.fn((url) => {
    const u = String(url);
    if (u.includes('/setup/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ firstRun: false }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('App — interrupt queued message with persisted attachments', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.onMessage = null;
    ctl.sends = [];
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('re-sends chat with persisted images and never calls /api/upload', async () => {
    render(<App initialView="chat" />);

    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(PROJECT_FIXTURE);
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
      timeout: 3000,
    });
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](ONE_SESSION);
    });

    await waitFor(() => expect(api.getMessages).toHaveBeenCalledWith('s-1'));

    await waitFor(() => expect(typeof ctl.onMessage).toBe('function'));
    await act(async () => {
      ctl.onMessage({ type: 'queue_updated', sessionId: 's-1', queue: [QUEUED_MESSAGE_ROW] });
    });
    await act(async () => {
      ctl.onMessage({
        type: 'thinking',
        sessionId: 's-1',
        messageId: 'streaming-msg-1',
        engine: 'claude-code',
      });
    });

    const interruptBtn = await screen.findByRole('button', { name: 'Interrupt' });
    await act(async () => {
      fireEvent.click(interruptBtn);
    });

    await waitFor(() => {
      const chat = ctl.sends.find((m) => m.type === 'chat');
      expect(chat).toMatchObject({
        type: 'chat',
        sessionId: 's-1',
        agentId: 'agent-1',
        content: 'follow-up while streaming',
        interrupt: true,
        _existingMsgId: 'q-msg-1',
        images: [PERSISTED_ATTACHMENT],
      });
    });

    expect(ctl.sends.find((m) => m.type === 'dequeue')).toBeUndefined();

    expect(api.uploadImage).not.toHaveBeenCalled();
    expect(api.uploadFile).not.toHaveBeenCalled();
  });

  // The legacy heavy grey "cross-agent" streaming bubble (which rendered the
  // *other* agent's name as a `text-gray-500` label whenever the streaming
  // agent differed from the active agent) was retired from the web client —
  // it kept mistriggering. Web now always streams through <SessionTail/>, whose
  // header is labeled with the ACTIVE session's agent (never a cross-agent
  // streamer). This guards that a cross-agent reviewer stream never resurrects a
  // grey "Reviewer" streaming label, while the active-tasks-snapshot swap into
  // the primary agent's output still works.
  it('never renders a grey cross-agent streaming label (retired bubble)', async () => {
    localStorage.setItem('activeAgentId', 'agent-1');

    render(<App initialView="chat" />);

    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(PROJECT_FIXTURE);
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
      timeout: 3000,
    });
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](ONE_SESSION);
    });
    await waitFor(() => expect(api.getMessages).toHaveBeenCalledWith('s-1'));
    await screen.findByText('follow-up while streaming');
    await waitFor(() => expect(typeof ctl.onMessage).toBe('function'));

    // A reviewer (cross-agent) begins streaming in the active session.
    await act(async () => {
      ctl.onMessage({
        type: 'thinking',
        sessionId: 's-1',
        messageId: 'review-stream',
        agentId: 'reviewer-1',
        agentName: 'Reviewer',
        agentColor: '#a855f7',
        engine: 'claude-code',
      });
    });
    // No grey "Reviewer" streaming label — the bubble is gone. The live tail is
    // labeled with the active session's agent ("A1"), never the cross-agent
    // streamer ("Reviewer").
    await waitFor(() => expect(reviewerStreamLabels()).toHaveLength(0));
    expect(
      screen
        .queryAllByText('A1')
        .filter((el) => String(el.className || '').includes('text-gray-500')),
    ).toHaveLength(1);

    // The active-tasks snapshot swaps in the primary agent's stream.
    await act(async () => {
      ctl.onMessage({
        type: 'active-tasks-snapshot',
        tasks: [
          {
            sessionId: 's-1',
            messageId: 'agent-stream',
            agentId: 'agent-1',
            content: 'primary agent output',
            engine: 'claude-code',
            model: null,
          },
        ],
      });
    });

    await waitFor(() => {
      expect(reviewerStreamLabels()).toHaveLength(0);
      expect(screen.getByText(/primary agent output/)).toBeTruthy();
    });
  });
});
