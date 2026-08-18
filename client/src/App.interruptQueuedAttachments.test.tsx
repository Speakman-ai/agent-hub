/**
 * Regression: in-flight Interrupt on a queued message with persisted attachments
 * must re-send via WS `chat` with `images` refs — never re-upload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  /** @type {Record<string, (value: unknown) => void>} */
  resolveSessionsByAgent: {} as Record<string, any>,
  /** @type {((data: unknown) => void) | null} */
  onMessage: null as any,
  /** @type {unknown[]} */
  sends: [] as any[],
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

(vi as any).mock('./utils/orgs.js', () => ({
  migrateFromLegacy: () => Promise.resolve(),
  fetchOrgs: () => Promise.resolve(),
  getActiveOrg: () => null,
  getOrgs: () => ({ orgs: [] }),
  getActiveOrgApiId: () => 'default',
  switchOrg: () => Promise.resolve(),
  reloadForOrgSwitch: () => {},
}));

(vi as any).mock('./utils/connection.js', () => ({
  getApiBase: () => 'http://localhost:3051',
  getAuthHeaders: () => ({}),
  getServerBase: () => 'http://localhost:3051',
}));

(vi as any).mock('./components/Sidebar.jsx', () => ({
  default: function MockSidebar() {
    return <div data-testid="sidebar-mock" />;
  },
}));

(vi as any).mock('./components/SessionSummarySidebar.jsx', () => ({
  default: function MockSessionSummary() {
    return <div data-testid="session-summary-mock" />;
  },
}));

(vi as any).mock('./components/MessageInput.jsx', () => ({
  default: function MockMessageInput() {
    return <div data-testid="message-input-mock" />;
  },
}));

(vi as any).mock('./components/TopBar.jsx', () => ({
  default: function MockTopBar() {
    return <div data-testid="topbar-mock" />;
  },
}));

(vi as any).mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: (onMessage: any) => {
    ctl.onMessage = onMessage;
    return {
      send: vi.fn((data: any) => {
        ctl.sends.push(data);
        return true;
      }),
      connected: true,
      reconnecting: false,
      wsRef: { current: null },
    };
  },
}));

(vi as any).mock('./hooks/useDesktopNotifications.js', () => ({
  useDesktopNotifications: () => ({ notify: vi.fn() }),
}));

(vi as any).mock('./hooks/useKeyboardShortcuts.js', () => ({
  useKeyboardShortcuts: () => {},
}));

(vi as any).mock('./hooks/useVersionCheck.js', () => ({
  useVersionCheck: () => ({
    updateAvailable: false,
    serverVersion: null,
    clientVersion: '0',
    downloadUrl: '',
    dismiss: vi.fn(),
  }),
}));

(vi as any).mock('./utils/api.js', async (importOriginal: any) => {
  const mod = await importOriginal();
  const empty = { engineDefaultModels: { 'claude-code': 'claude-opus-4-8' } };
  return {
    ...mod,
    api: {
      ...mod.api,
      getModelConfig: vi.fn().mockResolvedValue(empty),
      getProjects: vi.fn(
        () =>
          new Promise((resolve: any) => {
            ctl.resolveProjects = resolve;
          }),
      ),
      getSessions: vi.fn(
        (agentId: any) =>
          new Promise((resolve: any) => {
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
      ensureSessionWorkspace: vi.fn().mockResolvedValue({ ok: true, skipped: true } as any),
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

import App from './App';
import { api } from './utils/api';

function reviewerStreamLabels() {
  return screen
    .queryAllByText('Reviewer')
    .filter((el: any) => String(el.className || '').includes('text-gray-500'));
}

function mockFetch() {
  (globalThis as any).fetch = vi.fn((url: any) => {
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

    await waitFor(() =>
      expect(api.getMessages).toHaveBeenCalledWith(
        's-1',
        expect.objectContaining({ limit: expect.any(Number) }),
      ),
    );

    await waitFor(() => expect(typeof ctl.onMessage).toBe('function'));
    await act(async () => {
      (ctl.onMessage as any)({
        type: 'queue_updated',
        sessionId: 's-1',
        queue: [QUEUED_MESSAGE_ROW],
      });
    });
    await act(async () => {
      (ctl.onMessage as any)({
        type: 'thinking',
        sessionId: 's-1',
        messageId: 'streaming-msg-1',
        engine: 'claude-code',
      });
    });

    const interruptBtn = await screen.findByRole('button', { name: 'Interrupt' });
    await act(async () => {
      fireEvent.click(interruptBtn as any);
    });

    await waitFor(() => {
      const chat = ctl.sends.find((m: any) => m.type === 'chat');
      expect(chat!).toMatchObject({
        type: 'chat',
        sessionId: 's-1',
        agentId: 'agent-1',
        content: 'follow-up while streaming',
        interrupt: true,
        _existingMsgId: 'q-msg-1',
        images: [PERSISTED_ATTACHMENT],
      });
    });

    expect(ctl.sends.find((m: any) => m.type === 'dequeue')).toBeUndefined();

    expect(api.uploadImage).not.toHaveBeenCalled();
    expect(api.uploadFile).not.toHaveBeenCalled();
  });

  // The legacy heavy grey "cross-agent" streaming bubble (a separate
  // StreamingMessage component) was retired — web now always streams through
  // <SessionTail/>. Its thin header is labeled via resolveLiveStreamIdentity
  // with whoever is *actually* producing the turn: an in-session Reviewer
  // stream shows the Reviewer's own identity (its whole point — see
  // App.activeTasksSnapshotClears.test.ts), not the session agent. Once the
  // active-tasks-snapshot swaps the primary agent's run back in, the tail
  // relabels to the session agent and the Reviewer label is gone.
  it('labels the live tail with the streaming agent, then swaps on snapshot', async () => {
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
    await waitFor(() =>
      expect(api.getMessages).toHaveBeenCalledWith(
        's-1',
        expect.objectContaining({ limit: expect.any(Number) }),
      ),
    );
    await screen.findByText('follow-up while streaming');
    await waitFor(() => expect(typeof ctl.onMessage).toBe('function'));

    // A reviewer (cross-agent) begins streaming in the active session.
    await act(async () => {
      (ctl.onMessage as any)({
        type: 'thinking',
        sessionId: 's-1',
        messageId: 'review-stream',
        agentId: 'reviewer-1',
        agentName: 'Reviewer',
        agentColor: '#a855f7',
        engine: 'claude-code',
      });
    });
    // The live tail carries the streamer's identity: the in-session Reviewer,
    // not the session agent. Exactly one grey "Reviewer" label (the SessionTail
    // header) — the retired heavy bubble would have been a second, distinct
    // node. The session agent ("A1") is not shown while the reviewer streams.
    await waitFor(() => expect(reviewerStreamLabels()).toHaveLength(1));
    expect(
      screen
        .queryAllByText('A1')
        .filter((el: any) => String(el.className || '').includes('text-gray-500')),
    ).toHaveLength(0);

    // The active-tasks snapshot swaps in the primary agent's stream.
    await act(async () => {
      (ctl.onMessage as any)({
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
