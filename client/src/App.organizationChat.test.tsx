import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

/**
 * Organization chats reuse the normal streaming chat view. The organization agent is not in the
 * project agent list, so App must take it from the Organizations page, send turns as that agent,
 * keep it out of localStorage, and only stream the session that is open.
 */
const ctl: any = { wsHandler: null, openChat: null };

(vi as any).mock('./utils/orgs.js', () => ({
  migrateFromLegacy: () => Promise.resolve(),
  fetchOrgs: () => Promise.resolve(),
  getActiveOrg: () => ({ id: 'server-a' }),
  getOrgs: () => ({ orgs: [] }),
  getActiveOrgApiId: () => 'server-a',
  switchOrg: () => Promise.resolve(),
  reloadForOrgSwitch: () => {},
}));
(vi as any).mock('./utils/connection.js', () => ({
  getApiBase: () => 'http://localhost:3051',
  getAuthHeaders: () => ({}),
  getServerBase: () => 'http://localhost:3051',
}));
(vi as any).mock('./components/Sidebar.jsx', () => ({ default: () => <div /> }));
(vi as any).mock('./components/SessionSummarySidebar.jsx', () => ({ default: () => <div /> }));
(vi as any).mock('./components/OrganizationsPage', () => ({
  default: (props: any) => {
    ctl.openChat = props.onOpenChat;
    ctl.pageProps = props;
    return <div data-testid="organizations-page" />;
  },
}));
const wsSend = vi.fn();
(vi as any).mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: (handler: any) => {
    ctl.wsHandler = handler;
    return { send: wsSend, connected: true, reconnecting: false, wsRef: { current: null } };
  },
}));
(vi as any).mock('./hooks/useDesktopNotifications.js', () => ({
  useDesktopNotifications: () => ({ notify: vi.fn() }),
}));
(vi as any).mock('./hooks/useKeyboardShortcuts.js', () => ({ useKeyboardShortcuts: () => {} }));
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
  return {
    ...mod,
    api: {
      ...mod.api,
      getModelConfig: vi
        .fn()
        .mockResolvedValue({ engineDefaultModels: { 'claude-code': 'claude-opus-4-8' } }),
      getProjects: vi.fn().mockResolvedValue([
        {
          id: 'proj-1',
          name: 'Project',
          color: '#3b82f6',
          cwd: '/tmp/w',
          ahw: '/tmp/w',
          agents: [{ id: 'agent-1', name: 'Frontend', engine: 'claude-code' }],
        },
      ]),
      getSessions: vi.fn((agentId: string) =>
        Promise.resolve(
          agentId.startsWith('__organization_')
            ? [
                { id: 'org-sess-1', agent_id: ORG_AGENT.id, name: 'Plan', engine: 'claude-code' },
                { id: 'org-sess-2', agent_id: ORG_AGENT.id, name: 'Old', engine: 'claude-code' },
              ]
            : [{ id: 'proj-sess-1', name: 'P1', engine: 'claude-code' }],
        ),
      ),
      getArchivedSessions: vi.fn().mockResolvedValue([]),
      getSkills: vi.fn().mockResolvedValue([]),
      getDesigns: vi.fn().mockResolvedValue([]),
      getCronSessions: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      getSessionHandoffs: vi.fn().mockResolvedValue([]),
      getSessionProgress: vi.fn().mockResolvedValue({ steps: [] }),
      ensureSessionWorkspace: vi.fn().mockResolvedValue({ ok: true, skipped: true }),
      getMeDashboard: vi.fn().mockResolvedValue({}),
      getHubSession: vi.fn(() => new Promise(() => undefined)),
    },
  };
});

const ORG_AGENT = {
  id: '__organization_abc__agent_1',
  name: 'Marketing',
  engine: 'claude-code',
  model: 'claude-opus-4-8',
  organizationScope: { enabled: true, archivedAt: null, projects: 'all-linked', tools: [] },
};

import App from './App';

beforeEach(() => {
  vi.clearAllMocks();
  ctl.wsHandler = null;
  ctl.openChat = null;
  localStorage.clear();
  (globalThis as any).window.electronAPI = undefined;
  (globalThis as any).fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ firstRun: false }) }),
  );
  window.history.replaceState(null, '', '/');
});

async function openOrganizationChat(sessionId: string) {
  await act(async () => {
    ctl.openChat({
      organizationId: 'org',
      agentId: ORG_AGENT.id,
      sessionId,
      agent: ORG_AGENT,
      session: { id: sessionId, agent_id: ORG_AGENT.id, name: 'Plan', engine: 'claude-code' },
    });
  });
}

describe('App organization chat', () => {
  it('opens the chat, sends as the organization agent and never persists its id', async () => {
    render(<App initialView="organizations" />);
    await waitFor(() => expect(typeof ctl.openChat).toBe('function'), { timeout: 3000 });
    await openOrganizationChat('org-sess-1');
    const textarea = await screen.findByRole('textbox');
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'summarize priorities' } });
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    });
    await waitFor(() =>
      expect(wsSend.mock.calls.some(([m]: any[]) => m?.type === 'chat')).toBe(true),
    );
    const chat = wsSend.mock.calls.map(([m]: any[]) => m).find((m: any) => m?.type === 'chat');
    expect(chat).toMatchObject({ agentId: ORG_AGENT.id, sessionId: 'org-sess-1' });
    expect(localStorage.getItem('activeAgentId')).not.toBe(ORG_AGENT.id);
  });

  it('streams only the open organization session', async () => {
    render(<App initialView="organizations" />);
    await waitFor(() => expect(typeof ctl.openChat).toBe('function'), { timeout: 3000 });
    await openOrganizationChat('org-sess-1');
    await screen.findByRole('textbox');
    const stream = (sessionId: string, content: string) =>
      act(async () => {
        ctl.wsHandler({ type: 'thinking', sessionId, messageId: `m-${sessionId}` });
        ctl.wsHandler({
          type: 'stream',
          sessionId,
          messageId: `m-${sessionId}`,
          content,
          agentId: ORG_AGENT.id,
        });
      });
    await stream('org-sess-2', 'stale stream from another chat');
    expect(document.body.textContent).not.toContain('stale stream from another chat');
    await stream('org-sess-1', 'live organization reply');
    await waitFor(() => expect(document.body.textContent).toContain('live organization reply'));
  });

  it('opens an organization deep link only on the Server it names', async () => {
    window.history.replaceState(null, '', '/#/organizations?organization=o1&server=server-a');
    const first = render(<App />);
    await waitFor(() => expect(ctl.pageProps?.initialOrganizationId).toBe('o1'));
    first.unmount();
    ctl.pageProps = null;
    window.history.replaceState(null, '', '/#/organizations?organization=o1&server=server-b');
    render(<App />);
    await waitFor(() => expect(ctl.pageProps).toBeTruthy());
    expect(ctl.pageProps.initialOrganizationId).toBeNull();
  });

  it('passes Back/Forward organization routes to the mounted page', async () => {
    window.history.replaceState(null, '', '/#/organizations?organization=o1&server=server-a');
    render(<App />);
    await waitFor(() => expect(ctl.pageProps?.initialOrganizationId).toBe('o1'));
    const page = ctl.pageProps;
    await act(async () => page.onSelectOrganization('o2'));
    await waitFor(() => expect(window.location.hash).toContain('organization=o2'));
    expect(ctl.pageProps.initialOrganizationId).toBe('o2');
    await act(async () => {
      window.history.replaceState(null, '', '/#/organizations?organization=o1&server=server-a');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(ctl.pageProps.initialOrganizationId).toBe('o1'));
    await act(async () => {
      window.history.replaceState(null, '', '/#/organizations?organization=o3&server=server-b');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(ctl.pageProps.initialOrganizationId).toBeNull());
  });
});
