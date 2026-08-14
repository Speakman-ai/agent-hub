import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const testState = vi.hoisted(() => ({
  accountKey: 'sidebarCollapsedProjects:user-a',
  cacheLoad: vi.fn<() => Promise<string[]>>(),
  cacheSaverFactory: vi.fn(),
  api: {
    getHealth: vi.fn(),
    getGoogleStatus: vi.fn(),
    getMySidebarCollapsedProjects: vi.fn(),
    putMySidebarCollapsedProject: vi.fn(),
    deleteProject: vi.fn(),
  },
  app: {
    agents: [{ id: 'agent-1', projectId: 'project-1', name: 'Agent', color: '#fff' }],
    projects: [{ id: 'project-1', name: 'Project One', color: '#fff' }],
    activeAgentId: 'agent-1',
    setActiveAgentId: vi.fn(),
    sessions: [],
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    handleNewSession: vi.fn(),
    handleDeleteSession: vi.fn(),
    archivedSessions: [],
    handleRestoreSession: vi.fn(),
    restoringSessionIds: new Set(),
    handleSwitchOrg: vi.fn(),
    refreshProjects: vi.fn(),
    refreshAgents: vi.fn(),
    cronSessions: [],
    activeTasks: {},
    finalizeStatusBySession: {},
    unreadThreadCounts: {},
    unreadTicketCounts: {},
    openPullCounts: {},
    securityOpenCounts: {},
    reloadMessages: vi.fn(),
    connected: true,
    reconnecting: false,
  },
}));
const sharedSaverState = vi.hoisted(() => ({ savers: [] as any[] }));

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: nativeHost('Pressable'),
  ScrollView: nativeHost('ScrollView'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: nativeHost('SafeAreaView') }));
vi.mock('../context/AppContext', () => ({ useApp: () => testState.app }));
vi.mock('../utils/api', () => ({ api: testState.api }));
vi.mock('../utils/config', () => ({ getApiBaseUrl: () => '', getWsUrl: () => '' }));
vi.mock('../utils/orgs', () => ({ getActiveOrg: () => null, getOrgs: () => null }));
vi.mock('../utils/project-mode', () => ({ isWorkflowProject: () => false }));
vi.mock('../utils/projectMenu', () => ({ projectNavGroups: () => [] }));
vi.mock('../utils/googleSurface', () => ({
  shouldShowCalendarNav: () => false,
  shouldShowGmailNav: () => false,
}));
vi.mock('../utils/time', () => ({ daysUntilPurge: () => null, parseDate: () => null }));
vi.mock('../utils/navGroupCollapse', () => ({
  loadNavGroupCollapsed: () => Promise.resolve({}),
  mergeHydratedNavGroups: (_stored: any, current: any) => current,
  saveNavGroupCollapsed: vi.fn(),
}));
vi.mock('../utils/sidebarProjectCollapse', () => ({
  currentCollapsedProjectsKey: () => testState.accountKey,
  loadCollapsedProjects: () => testState.cacheLoad(),
  createCollapsedProjectsCacheSaver: () => testState.cacheSaverFactory(),
}));
vi.mock('@shared/utils/sidebarProjectCollapse', async () => {
  const actual = await vi.importActual<any>('@shared/utils/sidebarProjectCollapse');
  return {
    ...actual,
    createCollapsedProjectSaver: (put: any) => {
      const saver = actual.createCollapsedProjectSaver(put);
      sharedSaverState.savers.push(saver);
      return saver;
    },
  };
});
vi.mock('./BugReportButton', () => ({ default: nativeHost('BugReportButton') }));
vi.mock('./HubIcon', () => ({ default: nativeHost('HubIcon') }));
vi.mock('./SessionStateIcon', () => ({ default: nativeHost('SessionStateIcon') }));
vi.mock('@shared/utils/humanCron', () => ({ default: () => '' }));

const { default: DrawerContent } = await import('./DrawerContent');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function navigation() {
  return { navigate: vi.fn(), closeDrawer: vi.fn() };
}

async function renderDrawer(nav: any) {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(<DrawerContent navigation={nav} />);
    await Promise.resolve();
  });
  return renderer;
}

async function flush() {
  await TestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('mobile DrawerContent collapsed-project hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedSaverState.savers.length = 0;
    testState.accountKey = 'sidebarCollapsedProjects:user-a';
    testState.cacheLoad.mockResolvedValue([]);
    testState.cacheSaverFactory.mockImplementation(() => ({
      save: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(),
    }));
    testState.api.getHealth.mockResolvedValue({});
    testState.api.getGoogleStatus.mockResolvedValue({ connected: false });
    testState.api.getMySidebarCollapsedProjects.mockResolvedValue({
      sidebarCollapsedProjects: [],
    });
    testState.api.putMySidebarCollapsedProject.mockImplementation(
      () => new Promise<void>((resolve) => putRequests.push({ resolve })),
    );
    putRequests = [];
  });

  let putRequests: Array<{ resolve: () => void }> = [];

  it('does not paint project rows before the AsyncStorage cache resolves', async () => {
    const cache = deferred<string[]>();
    testState.cacheLoad.mockReturnValue(cache.promise);
    const renderer = await renderDrawer(navigation());

    expect(renderer.root.findByProps({ testID: 'drawer-projects-loading' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: 'drawer-project-project-1' })).toHaveLength(0);

    await TestRenderer.act(async () => {
      cache.resolve(['project-1']);
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ testID: 'drawer-project-project-1' })).toBeTruthy();
  });

  it('cancels the old account saver and routes later taps through its replacement', async () => {
    const renderer = await renderDrawer(navigation());
    // The first cache saver is retained through the initial effect and then
    // explicitly retired when the account changes.
    const firstCacheSaver = testState.cacheSaverFactory.mock.results[0].value;

    const header = () => renderer.root.findByProps({ testID: 'drawer-project-project-1' });
    TestRenderer.act(() => header().props.onPress());
    TestRenderer.act(() => header().props.onPress());
    expect(testState.api.putMySidebarCollapsedProject).toHaveBeenCalledTimes(1);

    testState.accountKey = 'sidebarCollapsedProjects:user-b';
    await TestRenderer.act(async () => {
      renderer.update(<DrawerContent navigation={navigation()} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(firstCacheSaver.cancel).toHaveBeenCalled();
    expect(testState.cacheSaverFactory).toHaveBeenCalledTimes(2);
    putRequests[0].resolve();
    await flush();
    // The queued user-A expansion must be discarded, not dispatched after the
    // auth/account change.
    expect(testState.api.putMySidebarCollapsedProject).toHaveBeenCalledTimes(1);

    TestRenderer.act(() => header().props.onPress());
    expect(testState.api.putMySidebarCollapsedProject).toHaveBeenCalledTimes(2);
    expect(testState.api.putMySidebarCollapsedProject).toHaveBeenLastCalledWith('project-1', true);
  });

  it('retires an eager API saver queue when the account changes before hydration', async () => {
    const renderer = await renderDrawer(navigation());
    const eagerSaver = sharedSaverState.savers[0];
    const queued = eagerSaver.save('project-1', true);
    eagerSaver.save('project-1', false);
    expect(testState.api.putMySidebarCollapsedProject).toHaveBeenCalledTimes(1);

    testState.accountKey = 'sidebarCollapsedProjects:user-b';
    await TestRenderer.act(async () => {
      renderer.update(<DrawerContent navigation={navigation()} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    putRequests[0].resolve();
    await queued;
    await flush();
    expect(testState.api.putMySidebarCollapsedProject).toHaveBeenCalledTimes(1);
  });
});

function collectText(node: any, acc: string[] = []): string[] {
  if (!node) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc;
  }
  const children = node.children ?? node.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) collectText(child, acc);
  } else if (children) {
    collectText(children, acc);
  }
  return acc;
}

describe('mobile DrawerContent — retired Designs chrome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedSaverState.savers.length = 0;
    testState.accountKey = 'sidebarCollapsedProjects:user-a';
    testState.cacheLoad.mockResolvedValue([]);
    testState.cacheSaverFactory.mockImplementation(() => ({
      save: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(),
    }));
    testState.api.getHealth.mockResolvedValue({});
    testState.api.getGoogleStatus.mockResolvedValue({ connected: false });
    testState.api.getMySidebarCollapsedProjects.mockResolvedValue({
      sidebarCollapsedProjects: [],
    });
  });

  it('does not render a Designs bottom-nav entry', async () => {
    const nav = navigation();
    const renderer = await renderDrawer(nav);
    const texts = collectText(renderer.toJSON());
    expect(texts).not.toContain('Designs');
    expect(nav.navigate).not.toHaveBeenCalledWith('Designs');
  });
});
