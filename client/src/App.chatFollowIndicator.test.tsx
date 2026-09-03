/**
 * App: the chat footer renders a live follow-state indicator. While the viewport
 * is pinned to the tail it shows a "Following" pill (data-following="true"); once
 * the user scrolls up and detaches, it becomes the "Scroll to bottom" button
 * (data-following="false"). This is the user-visible signal for "is the session
 * still following the scroll" — guard its wiring to the scroll handler here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup, screen, fireEvent } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  resolveSessionsByAgent: {} as Record<string, any>,
  wsMessage: null as any,
}));

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
    return <div data-testid="sidebar-scroll-anchor" aria-label="mock sidebar" />;
  },
}));

(vi as any).mock('./components/SessionSummarySidebar.jsx', () => ({
  default: function MockSessionSummary() {
    return <div data-testid="session-summary-mock" />;
  },
}));

(vi as any).mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: (onMessage: any) => {
    ctl.wsMessage = onMessage;
    return {
      send: vi.fn(),
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
      getDesigns: vi.fn().mockResolvedValue([]),
      getCronSessions: vi.fn().mockResolvedValue([]),
      getMessages: vi
        .fn()
        .mockResolvedValue([{ id: 'm-a', role: 'user', content: 'from-a', created_at: '' }]),
      getSessionHandoffs: vi.fn().mockResolvedValue([]),
      getSessionProgress: vi.fn().mockResolvedValue({ steps: [] }),
      ensureSessionWorkspace: vi.fn().mockResolvedValue({ ok: true, skipped: true } as any),
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
    agents: [{ id: 'agent-1', name: 'A1', color: '#3b82f6', engine: 'claude-code' }],
  },
];

const ONE_SESSION = [{ id: 's-a', name: 'SA', engine: 'claude-code' }];

import App from './App';
import { api } from './utils/api';

function mockFetch() {
  (globalThis as any).fetch = vi.fn((url: any) => {
    const u = String(url);
    if (u.includes('/setup/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ firstRun: false }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

/** Give a jsdom element real scroll geometry (jsdom lays nothing out). */
function setGeometry(
  el: HTMLElement,
  {
    scrollTop,
    scrollHeight,
    clientHeight,
  }: { scrollTop: number; scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop });
}

async function mountChat() {
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
  await waitFor(() => expect(api.getMessages).toHaveBeenCalled());
  return screen.findByTestId('chat-scroll-container');
}

describe('App — chat follow-state indicator', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.wsMessage = null;
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('shows the "Following" indicator while pinned to the tail', async () => {
    await mountChat();
    const indicator = await screen.findByTestId('chat-follow-indicator');
    expect(indicator.getAttribute('data-following')).toBe('true');
    expect(indicator.textContent).toContain('Following');
  });

  it('flips to the "Scroll to bottom" button after an upward scroll detaches the tail', async () => {
    const container = await mountChat();
    // Detached geometry: gap = 2000 - 500 - 300 = 1200px (> 150px threshold),
    // and scrollTop rose from the reset 0 without a downward move, so the
    // handler treats the container as no longer following the tail.
    setGeometry(container, { scrollTop: 500, scrollHeight: 2000, clientHeight: 300 });
    // A real user scroll is a burst of events, not a single one. The handler
    // deliberately ignores scroll events while `programmaticScrollRef` is set
    // (the initial tail pin clears it on the next animation frame, and a second
    // pin is scheduled 100ms after mount), so a lone synthetic event can land in
    // that window and be dropped — which made this assertion timing-dependent
    // (green in isolation, red after the previous test warmed the module cache).
    // Re-fire inside waitFor so the assertion tracks the first event that
    // reaches the handler, exactly like a continuing wheel/trackpad scroll.
    await waitFor(() => {
      fireEvent.scroll(container);
      const indicator = screen.getByTestId('chat-follow-indicator');
      expect(indicator.getAttribute('data-following')).toBe('false');
    });
    const indicator = screen.getByTestId('chat-follow-indicator');
    expect(indicator.textContent).toContain('Scroll to bottom');
  });

  it('stays following when a content shrink clamps scrollTop down at a turn boundary', async () => {
    // Regression: "new turns stop the session from auto-scrolling". When the
    // thinking indicator unmounts or the streaming tail is swapped for the final
    // message, the column shrinks, the browser clamps scrollTop to the new max
    // and fires a scroll event. scrollTop < lastScrollTop was misread as the
    // user scrolling up, so follow detached on nearly every turn.
    const container = await mountChat();
    // Detach once via a real scroll-up so we know the handler is processing
    // events (the programmatic guard is clear from here on).
    setGeometry(container, { scrollTop: 500, scrollHeight: 2000, clientHeight: 300 });
    await waitFor(() => {
      fireEvent.scroll(container);
      expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe(
        'false',
      );
    });
    // User scrolls back to the tail → following again, lastScrollTop = 1700.
    setGeometry(container, { scrollTop: 1700, scrollHeight: 2000, clientHeight: 300 });
    await act(async () => {
      fireEvent.scroll(container);
    });
    expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe('true');
    // Content shrinks by 200px: the browser clamps scrollTop 1700 → 1500 and the
    // viewport is still flush with the bottom. This must not detach.
    setGeometry(container, { scrollTop: 1500, scrollHeight: 1800, clientHeight: 300 });
    await act(async () => {
      fireEvent.scroll(container);
    });
    expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe('true');
    // A genuine scroll-up afterwards still detaches.
    setGeometry(container, { scrollTop: 1400, scrollHeight: 1800, clientHeight: 300 });
    await act(async () => {
      fireEvent.scroll(container);
    });
    expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe(
      'false',
    );
  });

  it('re-arms follow when a new turn starts after the viewport detached', async () => {
    const container = await mountChat();
    setGeometry(container, { scrollTop: 500, scrollHeight: 2000, clientHeight: 300 });
    await waitFor(() => {
      fireEvent.scroll(container);
      expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe(
        'false',
      );
    });

    act(() => {
      ctl.wsMessage({
        type: 'thinking',
        sessionId: 's-a',
        messageId: 'turn-2',
        engine: 'claude-code',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe(
        'true',
      );
    });
    expect(container.scrollTop).toBe(container.scrollHeight);
  });

  it('re-arms follow as soon as the new user message arrives', async () => {
    const container = await mountChat();
    setGeometry(container, { scrollTop: 500, scrollHeight: 2000, clientHeight: 300 });
    await waitFor(() => {
      fireEvent.scroll(container);
      expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe(
        'false',
      );
    });

    act(() => {
      ctl.wsMessage({
        type: 'message',
        message: {
          id: 'turn-2',
          session_id: 's-a',
          role: 'user',
          content: 'continue',
          created_at: '',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe(
        'true',
      );
    });
    expect(container.scrollTop).toBe(container.scrollHeight);
  });

  it('does not re-arm again on thinking after the user detached during the same turn', async () => {
    const container = await mountChat();
    setGeometry(container, { scrollTop: 500, scrollHeight: 2000, clientHeight: 300 });
    await waitFor(() => {
      fireEvent.scroll(container);
      expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe(
        'false',
      );
    });

    act(() => {
      ctl.wsMessage({
        type: 'message',
        message: {
          id: 'turn-2-user',
          session_id: 's-a',
          role: 'user',
          content: 'continue',
          created_at: '',
        },
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe(
        'true',
      );
    });

    setGeometry(container, { scrollTop: 500, scrollHeight: 2000, clientHeight: 300 });
    await waitFor(() => {
      fireEvent.scroll(container);
      expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe(
        'false',
      );
    });

    act(() => {
      ctl.wsMessage({
        type: 'thinking',
        sessionId: 's-a',
        messageId: 'turn-2-assistant',
        engine: 'claude-code',
      });
    });

    expect(screen.getByTestId('chat-follow-indicator').getAttribute('data-following')).toBe(
      'false',
    );
    expect(container.scrollTop).toBe(500);
  });
});
