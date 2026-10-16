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
  navGroups: (() => []) as (project?: any, agents?: any) => any[],
  app: {
    agents: [
      { id: 'agent-1', projectId: 'project-1', name: 'Agent', color: '#fff' },
      { id: 'agent-2', projectId: 'project-1', name: 'Second', color: '#fff' },
    ],
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
    unreadTicketCounts: {},
    openPullCounts: {},
    securityOpenCounts: {},
    skillImprovementCounts: {} as Record<string, number>,
    activeReviews: {},
    changesReady: {},
    handleRenameSession: vi.fn(),
    reloadAgentSessions: vi.fn(),
    handleReorderProjects: vi.fn(),
    handleOpenHandoffSession: vi.fn(),
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
vi.mock('../utils/projectMenu', () => ({
  projectNavGroups: (project: any, agents?: any) => testState.navGroups(project, agents),
}));
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
vi.mock('./NotificationBell', () => ({ default: nativeHost('NotificationBell') }));
vi.mock('./BrandLogo', () => ({ default: nativeHost('BrandLogo') }));
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
    testState.navGroups = () => [];
    putRequests = [];
  });

  let putRequests: Array<{ resolve: () => void }> = [];

  it('opens the notification inbox from the header bell', async () => {
    const nav = navigation();
    const renderer = await renderDrawer(nav);
    TestRenderer.act(() =>
      renderer.root.findByProps({ testID: 'drawer-notification-bell' }).props.onPress(),
    );
    expect(nav.navigate).toHaveBeenCalledWith('Notifications');
    expect(nav.closeDrawer).toHaveBeenCalled();
  });

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

describe('mobile DrawerContent — Skills pending-lesson badge', () => {
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
    testState.app.skillImprovementCounts = {};
    testState.navGroups = () => [
      {
        key: 'ai',
        label: 'AI',
        entries: [{ key: 'skills', label: 'Skills', icon: 'Puzzle', screen: 'Skills' }],
      },
    ];
  });

  async function expandSkills(renderer: ReactTestRenderer) {
    const toggle = renderer.root.findByProps({ testID: 'drawer-nav-group-ai-project-1' });
    await TestRenderer.act(async () => {
      toggle.props.onPress();
    });
  }

  it('renders the pending-lesson badge on the project Skills row when > 0', async () => {
    testState.app.skillImprovementCounts = { 'project-1': 3 };
    const renderer = await renderDrawer(navigation());
    await expandSkills(renderer);
    renderer.root.findByProps({ testID: 'skills-pending-badge' });
    expect(collectText(renderer.toJSON())).toContain('3');
  });

  it('caps the badge at 99+', async () => {
    testState.app.skillImprovementCounts = { 'project-1': 150 };
    const renderer = await renderDrawer(navigation());
    await expandSkills(renderer);
    expect(collectText(renderer.toJSON())).toContain('99+');
  });

  it('renders no badge when the pending total is 0', async () => {
    testState.app.skillImprovementCounts = { 'project-1': 0 };
    const renderer = await renderDrawer(navigation());
    await expandSkills(renderer);
    expect(renderer.root.findAllByProps({ testID: 'skills-pending-badge' })).toHaveLength(0);
  });
});

describe('mobile DrawerContent — web sidebar order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedSaverState.savers.length = 0;
    testState.accountKey = 'sidebarCollapsedProjects:user-a';
    testState.cacheLoad.mockResolvedValue([]);
    testState.cacheSaverFactory.mockImplementation(() => ({
      save: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(),
    }));
    testState.api.getHealth.mockResolvedValue({ version: '1.2.3', gitHash: 'abc' });
    testState.api.getMySidebarCollapsedProjects.mockResolvedValue({
      sidebarCollapsedProjects: [],
    });
    testState.navGroups = () => [];
  });

  it('puts New Project under Projects and Chat in the footer', async () => {
    const renderer = await renderDrawer(navigation());
    const texts = collectText(renderer.toJSON());
    const projectsAt = texts.indexOf('PROJECTS');
    const newProjectAt = texts.indexOf('New Project');
    const importAt = texts.indexOf('Import existing project');
    const settingsAt = texts.indexOf('Settings');
    const chatAt = texts.indexOf('Chat');
    expect(projectsAt).toBeGreaterThanOrEqual(0);
    expect(newProjectAt).toBeGreaterThan(projectsAt);
    expect(importAt).toBeGreaterThan(newProjectAt);
    expect(settingsAt).toBeGreaterThan(importAt);
    expect(chatAt).toBeGreaterThan(settingsAt);
    expect(texts).not.toContain("What's new");
    expect(texts.filter((text) => text === 'Skills')).toHaveLength(0);
  });
});

describe('mobile DrawerContent inactive-agent archive and restore', () => {
  const live = { id: 'b-live', agent_id: 'agent-2', name: 'B live', status: 'idle' };
  const archived = {
    id: 'b-archived',
    agent_id: 'agent-2',
    name: 'B archived',
    deleted_at: '2026-10-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
    testState.navGroups = () => [];
    testState.app.activeAgentId = 'agent-1';
    testState.app.reloadAgentSessions.mockImplementation(async (agentId: string) =>
      agentId === 'agent-2'
        ? { sessions: [live], archived: [archived] }
        : { sessions: [], archived: [] },
    );
  });

  const texts = (node: any): string[] =>
    node.findAll((n: any) => n.type === 'Text').flatMap((n: any) => [n.props.children].flat());

  async function expandSecondAgent() {
    const renderer = await renderDrawer(navigation());
    await flush();
    await TestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Expand Second sessions' }).props.onPress();
    });
    await flush();
    return renderer;
  }

  it("moves a deleted inactive-agent session into that agent's archive", async () => {
    testState.app.handleDeleteSession.mockResolvedValue(undefined);
    const { Alert } = (await import('react-native')) as any;
    const renderer = await expandSecondAgent();
    const row = renderer.root
      .findByProps({ testID: 'agent-sessions-list' })
      .findAll((n: any) => n.type === 'TouchableOpacity' && n.props.onLongPress)[0];
    TestRenderer.act(() => row.props.onLongPress());
    const buttons = Alert.alert.mock.calls.at(-1)[2];
    await TestRenderer.act(async () => {
      buttons.find((b: any) => b.text === 'Delete').onPress();
    });
    await flush();

    expect(testState.app.handleDeleteSession).toHaveBeenCalledWith('b-live');
    const list = renderer.root.findAllByProps({ testID: 'agent-sessions-list' });
    expect(list.flatMap(texts)).not.toContain('B live');
    const section = renderer.root.findByProps({ testID: 'archived-sessions-section' });
    expect(texts(section).join('')).toContain('Archived (2)');
  });

  it("moves a restored inactive-agent session back into that agent's live list", async () => {
    testState.app.handleRestoreSession.mockResolvedValue({
      id: 'b-archived',
      agent_id: 'agent-2',
      name: 'B archived',
    });
    const renderer = await expandSecondAgent();
    const section = renderer.root.findByProps({ testID: 'archived-sessions-section' });
    TestRenderer.act(() => {
      section.findAll((n: any) => n.type === 'TouchableOpacity')[0].props.onPress();
    });
    const restore = renderer.root
      .findByProps({ testID: 'archived-sessions-list' })
      .findAll((n: any) => n.type === 'TouchableOpacity')[0];
    await TestRenderer.act(async () => {
      restore.props.onPress();
    });
    await flush();

    expect(testState.app.handleRestoreSession).toHaveBeenCalledWith('b-archived');
    expect(renderer.root.findAllByProps({ testID: 'archived-sessions-section' })).toHaveLength(0);
    const list = renderer.root.findByProps({ testID: 'agent-sessions-list' });
    expect(texts(list)).toEqual(expect.arrayContaining(['B archived', 'B live']));
  });
});

describe('mobile DrawerContent inactive-agent cache refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    testState.navGroups = () => [];
    testState.app.activeAgentId = 'agent-1';
    (testState.app as any).sessions = [];
  });

  const listText = (renderer: ReactTestRenderer) =>
    renderer.root
      .findAllByProps({ testID: 'agent-sessions-list' })
      .flatMap((node: any) =>
        node.findAll((n: any) => n.type === 'Text').flatMap((n: any) => [n.props.children].flat()),
      );

  const toggle = async (renderer: ReactTestRenderer, label: string) => {
    await TestRenderer.act(async () => {
      renderer.root.findByProps({ accessibilityLabel: label }).props.onPress();
    });
    await flush();
  };

  const rerenderDrawer = async (renderer: ReactTestRenderer, nav: any) => {
    await TestRenderer.act(async () => {
      renderer.update(<DrawerContent navigation={nav} />);
    });
    await flush();
  };

  it('refetches an inactive agent on every expand', async () => {
    testState.app.reloadAgentSessions
      .mockResolvedValueOnce({ sessions: [{ id: 'x', name: 'Old row' }], archived: [] })
      .mockResolvedValueOnce({ sessions: [{ id: 'y', name: 'New row' }], archived: [] });
    const renderer = await renderDrawer(navigation());
    await flush();
    await toggle(renderer, 'Expand Second sessions');
    expect(listText(renderer)).toContain('Old row');
    await toggle(renderer, 'Collapse Second sessions');
    await toggle(renderer, 'Expand Second sessions');
    expect(testState.app.reloadAgentSessions).toHaveBeenCalledTimes(2);
    expect(listText(renderer)).toContain('New row');
    expect(listText(renderer)).not.toContain('Old row');
  });

  it('refreshes an open agent list after that agent stops being active', async () => {
    const nav = navigation();
    testState.app.reloadAgentSessions.mockResolvedValueOnce({
      sessions: [{ id: 'x', name: 'Before' }],
      archived: [],
    });
    const renderer = await renderDrawer(nav);
    await flush();
    await toggle(renderer, 'Expand Second sessions');
    expect(listText(renderer)).toContain('Before');

    // Agent 2 becomes active and gains a session through AppContext.
    testState.app.activeAgentId = 'agent-2';
    (testState.app as any).sessions = [{ id: 'z', name: 'Created while active' }];
    await rerenderDrawer(renderer, nav);
    expect(listText(renderer)).toContain('Created while active');

    testState.app.reloadAgentSessions.mockResolvedValueOnce({
      sessions: [
        { id: 'z', name: 'Created while active' },
        { id: 'x', name: 'Before' },
      ],
      archived: [],
    });
    testState.app.activeAgentId = 'agent-1';
    (testState.app as any).sessions = [];
    await rerenderDrawer(renderer, nav);
    expect(testState.app.reloadAgentSessions).toHaveBeenLastCalledWith('agent-2');
    expect(listText(renderer)).toContain('Created while active');
  });
});
