import type { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = TestRenderer;

const ctl = vi.hoisted(() => ({
  onMessage: null as null | ((data: any) => void),
  getProjectBoard: vi.fn(),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: () => null }));
vi.mock('../components/LinkedTodosPanel', () => ({ default: () => null }));
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: (handler: (data: any) => void) => {
    ctl.onMessage = handler;
    return { send: vi.fn(), connected: true, reconnecting: false, reconnect: vi.fn() };
  },
}));
vi.mock('../utils/config', () => ({
  // Keep device bootstrap pending; this test drives the live provider directly.
  loadConnectionConfig: () => new Promise(() => {}),
  getApiBaseUrl: () => '',
}));
vi.mock('../utils/orgs', () => ({
  loadOrgs: vi.fn(),
  migrateFromLegacy: vi.fn(),
  getOrgs: () => ({ orgs: [] }),
}));
vi.mock('../utils/auth', () => ({
  loadAuthToken: vi.fn(),
  isAuthenticated: () => false,
  getAuthStatus: vi.fn(),
  getAuthRecord: () => null,
  needsEmailUpdate: () => false,
}));
vi.mock('../utils/setupState', () => ({
  loadSetupDismissed: vi.fn(),
  saveSetupDismissed: vi.fn(),
  shouldShowWizard: vi.fn(),
  shouldGateLoginAfterSetup: vi.fn(),
  shouldGateAuthFromStatus: vi.fn(),
}));
vi.mock('../utils/push', () => ({
  registerForPushNotifications: vi.fn(),
  presentLocalNotification: vi.fn(),
}));
vi.mock('../utils/uploadAttachments', () => ({ uploadAttachments: vi.fn() }));
vi.mock('../utils/api', () => ({
  api: {
    getProjectBoard: ctl.getProjectBoard,
    getModelConfig: vi.fn().mockResolvedValue({}),
    getSecurityFindings: vi.fn().mockResolvedValue({}),
    getProjectPulls: vi.fn().mockResolvedValue({ pulls: [] }),
  },
}));

const { AppProvider } = await import('../context/AppContext');
const { default: EpicDetailScreen } = await import('./EpicDetailScreen');

const initialBoard = {
  columns: [],
  cards: [],
  epics: [{ id: 'e-1', name: 'Project Autopilot' }],
  phases: [{ id: 'phase-1', epic_id: 'e-1', name: 'Initial build', position: 0 }],
  specItems: [
    {
      id: 'spec-1',
      epic_id: 'e-1',
      tag: 'storage',
      title: 'Where to store data?',
      status: 'chosen',
      decision: 'Use local files',
    },
  ],
};

function visibleText(node: any): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(visibleText).join(' ');
  return node?.children ? visibleText(node.children) : '';
}

describe('mobile scope content refresh', () => {
  let renderer: ReactTestRenderer;
  const navigation = { navigate: vi.fn(), goBack: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    ctl.getProjectBoard.mockResolvedValue(initialBoard);
  });

  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('refreshes phases and decisions from kanban_update without navigating', async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        <AppProvider>
          <EpicDetailScreen
            route={{ params: { projectId: 'proj-1', epicId: 'e-1' } }}
            navigation={navigation}
          />
        </AppProvider>,
      );
    });
    expect(visibleText(renderer.toJSON())).toContain('Initial build');
    expect(visibleText(renderer.toJSON())).toContain('Use local files');
    expect(ctl.getProjectBoard).toHaveBeenCalledTimes(1);

    ctl.getProjectBoard.mockResolvedValue({
      ...initialBoard,
      phases: [{ ...initialBoard.phases[0], name: 'Build persistence' }],
      specItems: [{ ...initialBoard.specItems[0], decision: 'Use SQLite' }],
    });
    await act(async () => {
      ctl.onMessage!({ type: 'kanban_update', projectId: 'other-project' });
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(ctl.getProjectBoard).toHaveBeenCalledTimes(1);
    expect(visibleText(renderer.toJSON())).toContain('Use local files');

    await act(async () => {
      for (let i = 0; i < 10; i++) {
        ctl.onMessage!({ type: 'kanban_update', projectId: 'proj-1' });
      }
      await vi.advanceTimersByTimeAsync(150);
    });
    const text = visibleText(renderer.toJSON());
    expect(text).toContain('Build persistence');
    expect(text).toContain('Use SQLite');
    expect(text).not.toContain('Initial build');
    expect(text).not.toContain('Use local files');
    expect(ctl.getProjectBoard).toHaveBeenCalledTimes(2);
    expect(ctl.getProjectBoard).toHaveBeenLastCalledWith('proj-1', { limit: 'all' });
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.goBack).not.toHaveBeenCalled();
  });
});
