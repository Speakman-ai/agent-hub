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
  useWebSocket: () => ({
    send: vi.fn(),
    connected: true,
    reconnecting: false,
    wsRef: { current: null },
  }),
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
    await act(async () => {
      fireEvent.scroll(container);
    });
    await waitFor(() => {
      const indicator = screen.getByTestId('chat-follow-indicator');
      expect(indicator.getAttribute('data-following')).toBe('false');
    });
    const indicator = screen.getByTestId('chat-follow-indicator');
    expect(indicator.textContent).toContain('Scroll to bottom');
  });
});
