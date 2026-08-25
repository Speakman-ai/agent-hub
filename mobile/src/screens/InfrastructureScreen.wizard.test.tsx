import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

const testState = vi.hoisted(() => ({
  app: {
    projects: [] as any[],
    lastInfraAlertEvent: null as any,
    setActiveAgentId: vi.fn(),
    setActiveSessionId: vi.fn(),
  },
  api: {} as Record<string, any>,
}));

// RN primitives as host string tags: each renders as exactly one instance, so
// `findByProps({ testID })` resolves unambiguously.
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: 'ProjectScreenHeader' }));
vi.mock('../context/AppContext', () => ({ useApp: () => testState.app }));
// `utils/config` pulls in AsyncStorage at module load, which has no node build.
vi.mock('../utils/config', () => ({ getServerBaseUrl: () => 'https://hub.example.com' }));
vi.mock('../utils/api', () => ({ api: testState.api }));

const { default: InfrastructureScreen, InfraSetupWizardButton } =
  await import('./InfrastructureScreen');

const EMPTY_DRAFT = { blockers: [], notes: [] };

/** Every read the Overview tab issues, so only the wizard is under test. */
function resetApi(overrides: Record<string, any> = {}) {
  Object.keys(testState.api).forEach((key) => delete testState.api[key]);
  Object.assign(testState.api, {
    getInfraSetupDraft: vi.fn(() => Promise.resolve({ draft: EMPTY_DRAFT })),
    startInfraWizard: vi.fn(() => Promise.resolve({ sessionId: 'sess-1', agentId: 'agent-1' })),
    getInfraScopes: vi.fn(() => Promise.resolve({ scopes: [] })),
    getInfraMonitoringStatus: vi.fn(() => Promise.resolve({ reachable: true })),
    getInfraMetricPacks: vi.fn(() => Promise.resolve({ packs: [] })),
    listInfraAlerts: vi.fn(() => Promise.resolve({ alerts: [], total: 0 })),
    getInfraSpend: vi.fn(() => Promise.resolve({ enabled: false, days: [] })),
    getInfraQuotas: vi.fn(() =>
      Promise.resolve({
        quotas: [],
        summary: { critical: 0, warning: 0, ok: 0, unknown: 0, total: 0 },
        thresholds: { warning: 80, critical: 100 },
        expression: 'm1/SERVICE_QUOTA(m1)*100',
        staleAfterMs: 0,
      }),
    ),
    getInfraHealthEvents: vi.fn(() =>
      Promise.resolve({ events: [], total: 0, ingestConfigured: false }),
    ),
    getInfraHealthIngest: vi.fn(() =>
      Promise.resolve({ token: null, ingestPath: '/api/infra/health/ingest', eventPattern: {} }),
    ),
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await TestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderScreen(navigation: any, params: Record<string, any> = {}) {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <InfrastructureScreen
        navigation={navigation}
        route={{ params: { projectId: 'demo', ...params } }}
      />,
    );
    await Promise.resolve();
  });
  await flush();
  return renderer;
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const control = renderer.root.findByProps({ testID });
  await TestRenderer.act(async () => {
    await control.props.onPress();
  });
}

/** The rendered strings under one testID, flattened. */
function textOf(renderer: ReactTestRenderer, testID: string): string {
  const out: string[] = [];
  const walk = (node: any) => {
    if (node == null || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.props) walk(node.props.children);
  };
  walk(renderer.root.findByProps({ testID }));
  return out.join(' ');
}

function queryByTestID(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAllByProps({ testID })[0] ?? null;
}

beforeEach(() => {
  testState.app.setActiveAgentId = vi.fn();
  testState.app.setActiveSessionId = vi.fn();
  resetApi();
});

describe('InfrastructureScreen — AI setup wizard', () => {
  it('renders the "Set up with AI" control above the tabs', async () => {
    const renderer = await renderScreen({ goBack: vi.fn(), navigate: vi.fn() });
    expect(textOf(renderer, 'infra-setup-wizard-button')).toContain('Set up with AI');
  });

  it('starts the wizard for the current project and focuses the spawned session', async () => {
    const navigation = { goBack: vi.fn(), navigate: vi.fn() };
    const renderer = await renderScreen(navigation);

    await press(renderer, 'infra-setup-wizard-button');

    expect(testState.api.startInfraWizard).toHaveBeenCalledWith('demo');
    expect(testState.app.setActiveAgentId).toHaveBeenCalledWith('agent-1');
    expect(testState.app.setActiveSessionId).toHaveBeenCalledWith('sess-1');
    expect(navigation.navigate).toHaveBeenCalledWith('Chat');
  });

  it('disables the control and says so while the spawn is in flight', async () => {
    const request = deferred<any>();
    resetApi({ startInfraWizard: vi.fn(() => request.promise) });
    const renderer = await renderScreen({ goBack: vi.fn(), navigate: vi.fn() });

    const button = renderer.root.findByProps({ testID: 'infra-setup-wizard-button' });
    TestRenderer.act(() => {
      button.props.onPress();
    });

    expect(textOf(renderer, 'infra-setup-wizard-button')).toContain('Starting…');
    expect(renderer.root.findByProps({ testID: 'infra-setup-wizard-button' }).props.disabled).toBe(
      true,
    );

    await TestRenderer.act(async () => {
      request.resolve({ sessionId: 's', agentId: 'a' });
      await Promise.resolve();
    });
    expect(textOf(renderer, 'infra-setup-wizard-button')).toContain('Set up with AI');
  });

  it('surfaces a spawn failure inline instead of navigating', async () => {
    const navigation = { goBack: vi.fn(), navigate: vi.fn() };
    resetApi({ startInfraWizard: vi.fn(() => Promise.reject(new Error('no monitoring profile'))) });
    const renderer = await renderScreen(navigation);

    await press(renderer, 'infra-setup-wizard-button');

    expect(textOf(renderer, 'infra-setup-wizard-error')).toContain('no monitoring profile');
    expect(navigation.navigate).not.toHaveBeenCalled();
    // Recoverable: the operator can fix the cause and press again.
    expect(renderer.root.findByProps({ testID: 'infra-setup-wizard-button' }).props.disabled).toBe(
      false,
    );
  });

  it('treats a response without a session id as a failure rather than navigating nowhere', async () => {
    const navigation = { goBack: vi.fn(), navigate: vi.fn() };
    resetApi({ startInfraWizard: vi.fn(() => Promise.resolve({ agentId: 'agent-1' })) });
    const renderer = await renderScreen(navigation);

    await press(renderer, 'infra-setup-wizard-button');

    expect(textOf(renderer, 'infra-setup-wizard-error')).toContain('session id');
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(testState.app.setActiveSessionId).not.toHaveBeenCalled();
  });

  it('renders the draft blockers and the server notes as the Overview empty state', async () => {
    resetApi({
      getInfraSetupDraft: vi.fn(() =>
        Promise.resolve({
          draft: {
            blockers: ['only-sso-profiles', 'no-scope'],
            notes: ['Profile "prod" is interactive SSO.'],
          },
        }),
      ),
    });
    const renderer = await renderScreen({ goBack: vi.fn(), navigate: vi.fn() });

    const box = textOf(renderer, 'infra-setup-blockers');
    expect(box).toContain('Infrastructure monitoring is not collecting yet');
    expect(box).toContain('interactive SSO, which cannot run unattended');
    expect(box).toContain('No collection scope is enabled');
    expect(box).toContain('Profile "prod" is interactive SSO.');
    expect(queryByTestID(renderer, 'infra-blocker-only-sso-profiles')).not.toBeNull();
    expect(queryByTestID(renderer, 'infra-blocker-no-scope')).not.toBeNull();
  });

  it('shows no blocker card when the draft reports the project is ready', async () => {
    const renderer = await renderScreen({ goBack: vi.fn(), navigate: vi.fn() });
    expect(queryByTestID(renderer, 'infra-setup-blockers')).toBeNull();
  });

  it('keeps the module usable when the draft read fails', async () => {
    resetApi({ getInfraSetupDraft: vi.fn(() => Promise.reject(new Error('boom'))) });
    const renderer = await renderScreen({ goBack: vi.fn(), navigate: vi.fn() });

    expect(queryByTestID(renderer, 'infra-setup-blockers')).toBeNull();
    expect(queryByTestID(renderer, 'infra-setup-wizard-button')).not.toBeNull();
  });
});

describe('InfraSetupWizardButton', () => {
  function renderButton(props: any) {
    let renderer!: ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(<InfraSetupWizardButton {...props} />);
    });
    return renderer;
  }

  it('renders nothing without an onOpenSession handler', () => {
    const renderer = renderButton({ projectId: 'demo' });
    expect(renderer.toJSON()).toBeNull();
  });

  it('drops a response that lands after the operator switched projects', async () => {
    const request = deferred<any>();
    resetApi({ startInfraWizard: vi.fn(() => request.promise) });
    const onOpenSession = vi.fn();
    const renderer = renderButton({ projectId: 'demo', onOpenSession });

    TestRenderer.act(() => {
      renderer.root.findByProps({ testID: 'infra-setup-wizard-button' }).props.onPress();
    });
    // Separate acts on purpose: the project switch has to be committed (and its
    // effect flushed) before the old request settles, which is the race.
    await TestRenderer.act(async () => {
      renderer.update(<InfraSetupWizardButton projectId="other" onOpenSession={onOpenSession} />);
    });
    await TestRenderer.act(async () => {
      request.resolve({ sessionId: 'sess-1', agentId: 'agent-1' });
      await Promise.resolve();
    });

    // The session belongs to the project the operator left.
    expect(onOpenSession).not.toHaveBeenCalled();
    // And the new project starts with a usable button: the stale request's
    // guarded `finally` never clears the pending flag, so the effect must.
    expect(renderer.root.findByProps({ testID: 'infra-setup-wizard-button' }).props.disabled).toBe(
      false,
    );
    expect(textOf(renderer, 'infra-setup-wizard-button')).toContain('Set up with AI');
  });

  it('drops a failure that lands after the operator switched projects', async () => {
    const request = deferred<any>();
    resetApi({ startInfraWizard: vi.fn(() => request.promise) });
    const onOpenSession = vi.fn();
    const renderer = renderButton({ projectId: 'demo', onOpenSession });

    TestRenderer.act(() => {
      renderer.root.findByProps({ testID: 'infra-setup-wizard-button' }).props.onPress();
    });
    await TestRenderer.act(async () => {
      renderer.update(<InfraSetupWizardButton projectId="other" onOpenSession={onOpenSession} />);
    });
    await TestRenderer.act(async () => {
      request.reject(new Error('old project blew up'));
      await Promise.resolve();
    });

    expect(queryByTestID(renderer, 'infra-setup-wizard-error')).toBeNull();
  });
});
