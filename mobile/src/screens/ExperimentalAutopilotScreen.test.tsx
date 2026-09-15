import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer needs the development build to run act()/effects.
process.env.NODE_ENV = 'development';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const act = TestRenderer.act as (cb: () => unknown) => Promise<void>;
const create = TestRenderer.create as (el: any) => { root: any; update: (el: any) => void };

// Mutable WebSocket connectivity + API state the mocks read, so tests can
// drive reconnect and changing server responses.
const ws = vi.hoisted(() => ({ connected: false, projects: [] as any[] }));
const apiMock = vi.hoisted(() => ({
  state: null as any,
  getAutopilot: vi.fn(),
  putAutopilotConfig: vi.fn(),
  startAutopilot: vi.fn(),
  pauseAutopilot: vi.fn(),
  resumeAutopilot: vi.fn(),
  stopAutopilot: vi.fn(),
  disableAutopilot: vi.fn(),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({ connected: ws.connected, projects: ws.projects }),
}));
vi.mock('../utils/auth', () => ({ hasRole: () => true }));
vi.mock('../utils/api', () => ({ api: apiMock }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: 'ProjectScreenHeader' }));

const RN = (await import('react-native')) as any;
const Alert = RN.Alert;
const mod = await import('./ExperimentalAutopilotScreen');
const ExperimentalAutopilotScreen = mod.default;
const { formFromState, buildConfigBody } = mod;

const LIMITS = {
  cycleMode: 'continuous' as const,
  maxCycles: null,
  maxWallTimeMs: 4 * 60 * 60 * 1000,
  maxStageTimeoutMs: 30 * 60 * 1000,
  maxRetriesPerStage: 2,
  maxCostUsd: null,
};

function readyConfig(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'p1',
    enabled: true,
    disabling: false,
    briefId: 'b1',
    brief: 'Build a todo app.',
    briefRevision: 1,
    target: {
      targetId: 'local',
      origin: 'http://127.0.0.1:8080',
      readinessProbeUrl: 'http://127.0.0.1:8080/health',
    },
    limits: LIMITS,
    credentialOwnerUserId: 'user-1',
    updatedAt: 'now',
    updatedBy: 'user-1',
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    projectId: 'p1',
    controlState: 'running',
    stage: 'implementing',
    cycleNumber: 1,
    pauseReason: null,
    failureReason: null,
    lastVerifiedSha: 'abcdef1234567890',
    lastDeploymentId: 'dep-1',
    targetId: 'local',
    limits: LIMITS,
    usage: { wallTimeMs: 0, costUsd: null, costAvailable: false },
    startedBy: 'user-1',
    startedAt: 'now',
    stoppedAt: null,
    updatedAt: 'now',
    ...overrides,
  };
}

const ROUTE = { params: { projectId: 'p1', project: { id: 'p1', name: 'Demo' } } };
const NAV = { goBack: vi.fn() };

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
// Match only host nodes (string type). A composite component that receives a
// `testID` prop (e.g. ActionBtn) would otherwise double-count with its inner
// host element.
const byTestID = (renderer: any, id: string): any[] =>
  renderer.root.findAll((n: any) => n.props && n.props.testID === id && typeof n.type === 'string');
const hasText = (renderer: any, s: string): boolean =>
  renderer.root.findAll((n: any) =>
    Array.isArray(n.children) ? n.children.includes(s) : n.children === s,
  ).length > 0;
async function pressByTestID(renderer: any, id: string) {
  const [node] = byTestID(renderer, id);
  await act(async () => {
    node.props.onPress();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ws.connected = false;
  ws.projects = [];
  apiMock.state = null;
  apiMock.getAutopilot.mockImplementation(async () => apiMock.state);
  apiMock.putAutopilotConfig.mockResolvedValue({});
  apiMock.startAutopilot.mockResolvedValue({});
  apiMock.pauseAutopilot.mockResolvedValue({});
  apiMock.resumeAutopilot.mockResolvedValue({});
  apiMock.stopAutopilot.mockResolvedValue({});
  apiMock.disableAutopilot.mockResolvedValue({});
});

describe('formFromState', () => {
  it('defaults sensible limits when the project has no saved config', () => {
    const f = formFromState(null);
    expect(f.cycleMode).toBe('continuous');
    expect(f.maxWallTimeHours).toBe('4');
    expect(f.maxStageTimeoutMinutes).toBe('30');
    expect(f.maxRetriesPerStage).toBe('2');
    expect(f.brief).toBe('');
    expect(f.targetId).toBe('');
  });

  it('hydrates from a saved config, converting limit units', () => {
    const f = formFromState({
      activeRun: null,
      config: readyConfig({
        brief: 'Ship it',
        target: {
          targetId: 'local',
          origin: 'http://127.0.0.1:9',
          readinessProbeUrl: 'http://127.0.0.1:9/h',
        },
        limits: {
          cycleMode: 'finite',
          maxCycles: 3,
          maxWallTimeMs: 2 * 3_600_000,
          maxStageTimeoutMs: 15 * 60_000,
          maxRetriesPerStage: 1,
          maxCostUsd: 5,
        },
      }),
    } as any);
    expect(f.brief).toBe('Ship it');
    expect(f.cycleMode).toBe('finite');
    expect(f.maxCycles).toBe('3');
    expect(f.maxWallTimeHours).toBe('2');
    expect(f.maxStageTimeoutMinutes).toBe('15');
    expect(f.maxRetriesPerStage).toBe('1');
    expect(f.maxCostUsd).toBe('5');
  });
});

describe('buildConfigBody', () => {
  const base = {
    brief: 'Build',
    targetId: 'local',
    origin: 'http://127.0.0.1:8080',
    readinessProbeUrl: 'http://127.0.0.1:8080/health',
    cycleMode: 'continuous' as const,
    maxCycles: '',
    maxWallTimeHours: '4',
    maxStageTimeoutMinutes: '30',
    maxRetriesPerStage: '2',
    maxCostUsd: '',
    credentialOwnerUserId: 'u1',
    isolationAdapter: 'auto' as const,
    hostAdapterAck: false,
  };

  it('builds a PUT body without changing project enablement', () => {
    const body = buildConfigBody(base);
    expect(body).not.toHaveProperty('enabled');
    expect(body.target.origin).toBe('http://127.0.0.1:8080');
    expect(body.limits.maxWallTimeMs).toBe(4 * 3_600_000);
    expect(body.limits.maxStageTimeoutMs).toBe(30 * 60_000);
    expect(body.credentialOwnerUserId).toBe('u1');
    expect(body.isolationAdapter).toBe('auto');
    expect(body.hostAdapterAck).toBe(false);
  });

  it('sends the host acknowledgment only when the host adapter is selected', () => {
    expect(
      buildConfigBody({ ...base, isolationAdapter: 'host', hostAdapterAck: true }).hostAdapterAck,
    ).toBe(true);
    // Ack is dropped when a non-host adapter is selected, even if left checked.
    expect(
      buildConfigBody({ ...base, isolationAdapter: 'sysbox', hostAdapterAck: true }).hostAdapterAck,
    ).toBe(false);
  });

  it('requires a positive maxCycles in finite mode and clamps retries', () => {
    const finite = buildConfigBody({
      ...base,
      cycleMode: 'finite',
      maxCycles: '0',
      maxRetriesPerStage: '9',
    });
    expect(finite.limits.maxCycles).toBe(1);
    expect(finite.limits.maxRetriesPerStage).toBe(2);
  });

  it('nulls out empty optional fields', () => {
    const body = buildConfigBody({
      ...base,
      brief: '  ',
      credentialOwnerUserId: '',
      maxCostUsd: '',
    });
    expect(body.brief).toBeNull();
    expect(body.credentialOwnerUserId).toBeNull();
    expect(body.limits.maxCostUsd).toBeNull();
  });
});

describe('ExperimentalAutopilotScreen interactions', () => {
  it('saves setup without changing project enablement', async () => {
    apiMock.state = { config: readyConfig(), activeRun: null };
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();

    expect(byTestID(renderer, 'autopilot-save-config').length).toBe(1);
    await pressByTestID(renderer, 'autopilot-save-config');

    expect(apiMock.putAutopilotConfig).toHaveBeenCalled();
    expect(apiMock.putAutopilotConfig.mock.calls[0][1]).not.toHaveProperty('enabled');
  });

  it('discards a deferred mutation completion after switching projects', async () => {
    apiMock.getAutopilot.mockImplementation(async (pid: string) => ({
      config: readyConfig({ projectId: pid, brief: `brief ${pid}` }),
      activeRun: null,
    }));
    let resolvePut: (v: any) => void = () => {};
    apiMock.putAutopilotConfig.mockReturnValue(
      new Promise((r) => {
        resolvePut = r;
      }),
    );

    const routeA = { params: { projectId: 'projA', project: { id: 'projA', name: 'A' } } };
    const routeB = { params: { projectId: 'projB', project: { id: 'projB', name: 'B' } } };
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={routeA} navigation={NAV} />);
    });
    await flush();
    // Start enable on A (mutation stays pending), then switch to B.
    await pressByTestID(renderer, 'autopilot-save-config');
    await act(async () => {
      renderer.update(<ExperimentalAutopilotScreen route={routeB} navigation={NAV} />);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(byTestID(renderer, 'autopilot-brief')[0].props.value).toBe('brief projB');

    const getCallsBefore = apiMock.getAutopilot.mock.calls.length;
    // A's mutation resolves after the switch — completion must be discarded.
    await act(async () => {
      resolvePut(readyConfig({ projectId: 'projA', enabled: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const projAReloads = apiMock.getAutopilot.mock.calls
      .slice(getCallsBefore)
      .filter((c: any[]) => c[0] === 'projA');
    expect(projAReloads).toHaveLength(0);
    expect(byTestID(renderer, 'autopilot-brief')[0].props.value).toBe('brief projB');
  });

  it('serializes repeated Save — no overlapping config PUTs', async () => {
    apiMock.getAutopilot.mockImplementation(async () => ({
      config: readyConfig({ enabled: true }),
      activeRun: null,
    }));
    apiMock.putAutopilotConfig.mockReturnValue(new Promise(() => {}));

    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    const save = () => byTestID(renderer, 'autopilot-save-config')[0];
    await act(async () => {
      save().props.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    // Second submit while the first is pending must be refused.
    await act(async () => {
      save().props.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(apiMock.putAutopilotConfig).toHaveBeenCalledTimes(1);
    expect(save().props.disabled).toBe(true);
  });

  it('hides setup and controls for disabled project deep links', async () => {
    apiMock.getAutopilot.mockResolvedValue({
      config: readyConfig({ enabled: false }),
      activeRun: null,
    });
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    expect(byTestID(renderer, 'autopilot-disabled')).toHaveLength(1);
    expect(byTestID(renderer, 'autopilot-setup')).toHaveLength(0);
    expect(byTestID(renderer, 'autopilot-controls')).toHaveLength(0);
    expect(byTestID(renderer, 'autopilot-enable-toggle')).toHaveLength(0);
  });

  it('a stale Save from a prior visit cannot release the current Save slot (A→B→A)', async () => {
    apiMock.getAutopilot.mockImplementation(async (pid: string) => ({
      config: readyConfig({ projectId: pid, enabled: true, brief: `brief ${pid}` }),
      activeRun: null,
    }));
    const resolvers: ((v: any) => void)[] = [];
    apiMock.putAutopilotConfig.mockImplementation(
      () =>
        new Promise((r) => {
          resolvers.push(r);
        }),
    );
    const routeA = { params: { projectId: 'projA', project: { id: 'projA', name: 'A' } } };
    const routeB = { params: { projectId: 'projB', project: { id: 'projB', name: 'B' } } };
    const upd = async (route: any) => {
      await act(async () => {
        renderer.update(<ExperimentalAutopilotScreen route={route} navigation={NAV} />);
        await new Promise((r) => setTimeout(r, 0));
      });
    };

    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={routeA} navigation={NAV} />);
    });
    await flush();
    const brief = () => byTestID(renderer, 'autopilot-brief')[0];
    const save = () => byTestID(renderer, 'autopilot-save-config')[0];
    expect(brief().props.value).toBe('brief projA');

    // Save #1 on A (deferred).
    await act(async () => {
      save().props.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(save().props.disabled).toBe(true);

    // A → B → A while Save #1 is still pending.
    await upd(routeB);
    expect(brief().props.value).toBe('brief projB');
    await upd(routeA);
    expect(brief().props.value).toBe('brief projA');

    // Save #2 on A (same key), also deferred.
    await act(async () => {
      save().props.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(apiMock.putAutopilotConfig).toHaveBeenCalledTimes(2);
    expect(save().props.disabled).toBe(true);

    // Original Save #1 resolves — must not free Save #2's slot.
    await act(async () => {
      resolvers[0](readyConfig({ projectId: 'projA', enabled: true, brief: 'stale' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(save().props.disabled).toBe(true);
    expect(apiMock.putAutopilotConfig).toHaveBeenCalledTimes(2);

    // Save #2 resolves — slot releases normally.
    await act(async () => {
      resolvers[1](readyConfig({ projectId: 'projA', enabled: true, brief: 'brief projA' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(save().props.disabled).toBe(false);
  });

  it('pins the concurrency revision to the edited form, not a background load', async () => {
    let rev = 1;
    let serverBrief = 'server v1';
    apiMock.getAutopilot.mockImplementation(async () => ({
      config: readyConfig({ revision: rev, brief: serverBrief }),
      activeRun: null,
    }));
    apiMock.putAutopilotConfig.mockResolvedValue(readyConfig({ revision: 3 }));

    ws.connected = false;
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    const brief = () => byTestID(renderer, 'autopilot-brief')[0];
    const save = () => byTestID(renderer, 'autopilot-save-config')[0];
    expect(brief().props.value).toBe('server v1');

    // Operator edits (dirty, based on revision 1).
    await act(async () => {
      brief().props.onChangeText('my edit');
    });

    // Another client advances to revision 2; a reconnect refetch brings it in.
    rev = 2;
    serverBrief = 'server v2';
    ws.connected = true;
    await act(async () => {
      renderer.update(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(brief().props.value).toBe('my edit');

    // Save submits the form's base revision (1), not the loaded 2.
    await act(async () => {
      save().props.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    const body = apiMock.putAutopilotConfig.mock.calls[0][1];
    expect(body.expectedRevision).toBe(1);
    expect(body.brief).toBe('my edit');
  });

  it('does not advance the base revision when the form is reloaded mid-save', async () => {
    let rev = 1;
    let serverBrief = 'A';
    apiMock.getAutopilot.mockImplementation(async () => ({
      config: readyConfig({ revision: rev, brief: serverBrief }),
      activeRun: null,
    }));
    const resolvers: ((v: any) => void)[] = [];
    apiMock.putAutopilotConfig.mockImplementation(
      () =>
        new Promise((r) => {
          resolvers.push(r);
        }),
    );

    ws.connected = false;
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    const brief = () => byTestID(renderer, 'autopilot-brief')[0];
    const save = () => byTestID(renderer, 'autopilot-save-config')[0];
    expect(brief().props.value).toBe('A');

    // Save (no edits) at base revision 1 — PUT stays pending.
    await act(async () => {
      save().props.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(apiMock.putAutopilotConfig.mock.calls[0][1].expectedRevision).toBe(1);

    // External advance to revision 3; a reconnect reload replaces the form.
    rev = 3;
    serverBrief = 'server v3';
    ws.connected = true;
    await act(async () => {
      renderer.update(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(brief().props.value).toBe('server v3');
    // Edit the reloaded form so the reconcile load won't repopulate it.
    await act(async () => {
      brief().props.onChangeText('server v3 edited');
    });

    // The original save succeeds at revision 2 — it must NOT advance the base,
    // which the reload pinned to 3.
    await act(async () => {
      resolvers[0](readyConfig({ revision: 2, brief: 'A' }));
      await new Promise((r) => setTimeout(r, 0));
    });

    // Next save carries the reloaded base (3), not the stale save's 2.
    await act(async () => {
      save().props.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(apiMock.putAutopilotConfig.mock.calls[1][1].expectedRevision).toBe(3);
  });

  it('ignores an out-of-order lifecycle response that would regress a newer one', async () => {
    apiMock.getAutopilot.mockResolvedValueOnce({
      config: readyConfig({ enabled: true }),
      activeRun: { run: run({ controlState: 'running' }), cycle: null, stateVersion: 1 },
      stateVersion: 1,
    });
    apiMock.getAutopilot.mockRejectedValue(new Error('reconcile GET fails'));
    let resolvePause: (v: any) => void = () => {};
    let resolveStop: (v: any) => void = () => {};
    apiMock.pauseAutopilot.mockReturnValue(
      new Promise((r) => {
        resolvePause = r;
      }),
    );
    apiMock.stopAutopilot.mockReturnValue(
      new Promise((r) => {
        resolveStop = r;
      }),
    );

    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();

    // Pause first (earlier op token), then Stop (later op token).
    await pressByTestID(renderer, 'autopilot-pause');
    await pressByTestID(renderer, 'autopilot-stop');
    const buttons = Alert.alert.mock.calls.at(-1)[2] as any[];
    const stopBtn = buttons.find((b) => b.text === 'Stop');
    await act(async () => {
      stopBtn.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });

    // Stop returns first → Stopping (higher server version).
    await act(async () => {
      resolveStop({ run: run({ controlState: 'stopping' }), cycle: null, stateVersion: 6 });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(hasText(renderer, 'Stopping')).toBe(true);

    // The earlier Pause returns afterwards with an older server version; the
    // failed reconcile can't correct it, so the stale paused snapshot is ignored.
    await act(async () => {
      resolvePause({ run: run({ controlState: 'paused' }), cycle: null, stateVersion: 5 });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(hasText(renderer, 'Stopping')).toBe(true);
    expect(hasText(renderer, 'Paused')).toBe(false);
  });

  it('discards a mutation response that a newer successful GET has superseded', async () => {
    apiMock.getAutopilot.mockResolvedValueOnce({
      config: readyConfig({ enabled: true }),
      activeRun: { run: run({ controlState: 'running' }), cycle: null, stateVersion: 1 },
      stateVersion: 1,
    });
    let resolvePause: (v: any) => void = () => {};
    apiMock.pauseAutopilot.mockReturnValue(
      new Promise((r) => {
        resolvePause = r;
      }),
    );

    ws.connected = false;
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();

    // Pause issued (delayed).
    await pressByTestID(renderer, 'autopilot-pause');

    // External stop; a reconnect GET loads the newer state (no active run) at a
    // higher server version, then later GETs fail.
    apiMock.getAutopilot.mockResolvedValueOnce({
      config: readyConfig({ enabled: true }),
      activeRun: null,
      stateVersion: 3,
    });
    apiMock.getAutopilot.mockRejectedValue(new Error('reconcile GET fails'));
    ws.connected = true;
    await act(async () => {
      renderer.update(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(byTestID(renderer, 'autopilot-run').length).toBe(0);

    // Older-version Pause response arrives; superseded by the newer GET → discarded.
    await act(async () => {
      resolvePause({ run: run({ controlState: 'paused' }), cycle: null, stateVersion: 2 });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(byTestID(renderer, 'autopilot-run').length).toBe(0);
  });

  it('applies a successful Start even if a stale pre-Start GET completed first', async () => {
    apiMock.getAutopilot.mockResolvedValueOnce({
      config: readyConfig({ enabled: true }),
      activeRun: null,
      stateVersion: 1,
    });
    let resolveStart: (v: any) => void = () => {};
    apiMock.startAutopilot.mockReturnValue(
      new Promise((r) => {
        resolveStart = r;
      }),
    );

    ws.connected = false;
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    await pressByTestID(renderer, 'autopilot-start');

    // Reconnect GET returns the pre-Start state (no run, version 1); later fail.
    apiMock.getAutopilot.mockResolvedValueOnce({
      config: readyConfig({ enabled: true }),
      activeRun: null,
      stateVersion: 1,
    });
    apiMock.getAutopilot.mockRejectedValue(new Error('reconcile GET fails'));
    ws.connected = true;
    await act(async () => {
      renderer.update(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
      await new Promise((r) => setTimeout(r, 0));
    });

    // Start resolves with a newer server version — must be applied despite the
    // stale GET, surviving the failed reconcile.
    await act(async () => {
      resolveStart({ run: run({ controlState: 'running' }), cycle: null, stateVersion: 5 });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(byTestID(renderer, 'autopilot-run').length).toBe(1);
    expect(byTestID(renderer, 'autopilot-stop').length).toBe(1);
  });

  it('rejects an invalid cost cap instead of clearing the saved cap', async () => {
    apiMock.getAutopilot.mockResolvedValue({
      config: readyConfig({ enabled: true, limits: { ...LIMITS, maxCostUsd: 5 } }),
      activeRun: null,
    });
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    const cap = () => byTestID(renderer, 'autopilot-cost-cap')[0];
    expect(cap().props.value).toBe('5');

    await act(async () => {
      cap().props.onChangeText('0'); // invalid
    });
    await pressByTestID(renderer, 'autopilot-save-config');
    expect(apiMock.putAutopilotConfig).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      expect.stringMatching(/invalid limits/i),
      expect.stringMatching(/cost cap/i),
    );

    // A valid cap saves and is sent through.
    await act(async () => {
      cap().props.onChangeText('10');
    });
    await pressByTestID(renderer, 'autopilot-save-config');
    expect(apiMock.putAutopilotConfig).toHaveBeenCalled();
    expect(apiMock.putAutopilotConfig.mock.calls[0][1].limits.maxCostUsd).toBe(10);
  });

  it('rejects an invalid wall-time budget instead of silently defaulting', async () => {
    apiMock.getAutopilot.mockResolvedValue({
      config: readyConfig({ enabled: true }),
      activeRun: null,
    });
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    const wall = () => byTestID(renderer, 'autopilot-wall-time')[0];
    expect(wall().props.value).toBe('4');

    await act(async () => {
      wall().props.onChangeText('0'); // invalid
    });
    await pressByTestID(renderer, 'autopilot-save-config');
    expect(apiMock.putAutopilotConfig).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      expect.stringMatching(/invalid limits/i),
      expect.stringMatching(/wall-time/i),
    );
  });

  it('keeps a pending Save owned across a Stop completion', async () => {
    apiMock.getAutopilot.mockImplementation(async () => ({
      config: readyConfig({ enabled: true }),
      activeRun: { run: run({ controlState: 'running' }), cycle: null },
    }));
    apiMock.putAutopilotConfig.mockReturnValue(new Promise(() => {})); // pending forever
    apiMock.stopAutopilot.mockResolvedValue({ run: run({ controlState: 'stopping' }) });

    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    const save = () => byTestID(renderer, 'autopilot-save-config')[0];
    await act(async () => {
      save().props.onPress(); // ordinary mutation now pending
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(save().props.disabled).toBe(true);

    // Stop completes while Save is still pending.
    await act(async () => {
      byTestID(renderer, 'autopilot-stop')[0].props.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    const buttons = Alert.alert.mock.calls.at(-1)[2] as any[];
    const stopBtn = buttons.find((b) => b.text === 'Stop');
    await act(async () => {
      stopBtn.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(apiMock.stopAutopilot).toHaveBeenCalledWith('p1');

    // A second Save must not start — the first still owns the slot.
    await act(async () => {
      save().props.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(apiMock.putAutopilotConfig).toHaveBeenCalledTimes(1);
    expect(save().props.disabled).toBe(true);
  });

  it('does not erase edits typed while a save is in flight', async () => {
    apiMock.getAutopilot.mockImplementation(async () => ({
      config: readyConfig({ brief: 'saved brief' }),
      activeRun: null,
    }));
    let resolvePut: (v: any) => void = () => {};
    apiMock.putAutopilotConfig.mockReturnValue(
      new Promise((r) => {
        resolvePut = r;
      }),
    );

    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    const brief = () => byTestID(renderer, 'autopilot-brief')[0];
    expect(brief().props.value).toBe('saved brief');

    await act(async () => {
      brief().props.onChangeText('wip');
    });
    await pressByTestID(renderer, 'autopilot-save-config'); // save submitted, PUT pending
    await act(async () => {
      brief().props.onChangeText('wip + more'); // typed during the PUT
    });

    await act(async () => {
      resolvePut(readyConfig({ brief: 'wip' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(brief().props.value).toBe('wip + more');
  });

  it('keeps the started run visible when the reconciling refresh fails', async () => {
    apiMock.getAutopilot.mockResolvedValueOnce({
      config: readyConfig({ enabled: true }),
      activeRun: null,
    });
    apiMock.startAutopilot.mockResolvedValue({
      run: run({ controlState: 'running' }),
      cycle: null,
    });
    apiMock.getAutopilot.mockRejectedValue(new Error('network blip'));

    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    expect(byTestID(renderer, 'autopilot-start').length).toBe(1);

    await pressByTestID(renderer, 'autopilot-start');

    // Started run is visible from the mutation response despite the failed GET.
    expect(byTestID(renderer, 'autopilot-run').length).toBe(1);
    expect(byTestID(renderer, 'autopilot-stop').length).toBe(1);
  });

  it('refetches changed server state on websocket reconnect', async () => {
    apiMock.state = {
      config: readyConfig({ enabled: true }),
      activeRun: { run: run({ controlState: 'running' }), cycle: null },
    };
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    // Running: pause offered, resume not.
    expect(byTestID(renderer, 'autopilot-pause').length).toBe(1);
    expect(byTestID(renderer, 'autopilot-resume').length).toBe(0);

    // Server state changes while disconnected; reconnect refetches it.
    apiMock.state = {
      config: readyConfig({ enabled: true }),
      activeRun: { run: run({ controlState: 'paused', stage: null }), cycle: null },
    };
    ws.connected = true;
    await act(async () => {
      renderer.update(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(byTestID(renderer, 'autopilot-resume').length).toBe(1);
    expect(byTestID(renderer, 'autopilot-pause').length).toBe(0);
  });

  it('Stop stays stopping until settlement, then renders the settled state', async () => {
    apiMock.state = {
      config: readyConfig({ enabled: true }),
      activeRun: { run: run({ controlState: 'running' }), cycle: null },
    };
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    expect(hasText(renderer, 'Stop')).toBe(true);

    // Press Stop → confirmation dialog; accept the destructive button.
    // The next refetch reports `stopping`.
    apiMock.state = {
      config: readyConfig({ enabled: true }),
      activeRun: { run: run({ controlState: 'stopping' }), cycle: null },
    };
    await pressByTestID(renderer, 'autopilot-stop');
    const buttons = Alert.alert.mock.calls.at(-1)[2] as any[];
    const stopBtn = buttons.find((b) => b.text === 'Stop');
    await act(async () => {
      stopBtn.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(apiMock.stopAutopilot).toHaveBeenCalledWith('p1');
    expect(hasText(renderer, 'Stopping…')).toBe(true);
    expect(byTestID(renderer, 'autopilot-stopping').length).toBe(1);

    // Settlement: the run is gone; a reconnect refetch renders the settled UI.
    apiMock.state = {
      config: readyConfig({ enabled: true }),
      activeRun: null,
    };
    ws.connected = true;
    await act(async () => {
      renderer.update(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(byTestID(renderer, 'autopilot-run').length).toBe(0);
    expect(byTestID(renderer, 'autopilot-stop').length).toBe(0);
  });

  it('renders verification evidence and documentation for a run', async () => {
    apiMock.state = {
      config: readyConfig({ enabled: true }),
      activeRun: {
        run: run({ controlState: 'failed', stage: 'verifying' }),
        cycle: {
          cycleNumber: 1,
          selectedImprovement: 'Speed up list',
          verification: {
            judgement: { ok: false, reason: 'baseline_regression', detail: 'home broke' },
            evidence: {
              origin: 'http://127.0.0.1:8080',
              observedSha: 'abcdef1234567890',
              criteria: [
                {
                  criterionId: 'home',
                  passed: false,
                  kind: 'browser',
                  observed: 'blank',
                  tracePath: '/tmp/h.zip',
                },
              ],
            },
          },
          documentation: {
            expectedBenefit: 'faster paint',
            actualChange: 'memoized rows',
            outcome: 'failed',
            links: { deploymentOrigin: 'http://127.0.0.1:8080' },
            evidence: [{ kind: 'screenshot', path: '/tmp/a.png' }],
            journalSlug: 'autopilot-journal',
            wikiSlugs: [],
          },
          outcome: 'failed',
          status: 'failed',
          testedCommitSha: 'abcdef1234567890',
          deploymentId: 'dep-1',
        },
      },
    };
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();

    expect(byTestID(renderer, 'autopilot-evidence').length).toBe(1);
    expect(byTestID(renderer, 'autopilot-evidence-failure').length).toBe(1);
    expect(hasText(renderer, 'home broke')).toBe(true);
    expect(byTestID(renderer, 'autopilot-documentation').length).toBe(1);
    expect(hasText(renderer, 'faster paint')).toBe(true);
  });

  it('resumes a paused run through the resume control', async () => {
    apiMock.state = {
      config: readyConfig({ enabled: true }),
      activeRun: { run: run({ controlState: 'paused', stage: null }), cycle: null },
    };
    apiMock.resumeAutopilot.mockResolvedValue({
      run: run({ controlState: 'running' }),
      cycle: null,
      stateVersion: 5,
    });
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    expect(byTestID(renderer, 'autopilot-resume').length).toBe(1);
    expect(byTestID(renderer, 'autopilot-pause').length).toBe(0);
    await pressByTestID(renderer, 'autopilot-resume');
    expect(apiMock.resumeAutopilot).toHaveBeenCalledWith('p1');
  });

  it('hides a mounted module when refreshed projects show it disabled', async () => {
    apiMock.state = { config: readyConfig(), activeRun: null };
    ws.projects = [{ id: 'p1', autopilotEnabled: true }];
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    expect(byTestID(renderer, 'autopilot-setup')).toHaveLength(1);
    ws.projects = [{ id: 'p1', autopilotEnabled: false }];
    await act(async () =>
      renderer.update(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />),
    );
    expect(byTestID(renderer, 'autopilot-setup')).toHaveLength(0);
    expect(byTestID(renderer, 'autopilot-disabled')).toHaveLength(1);
  });

  it('keeps enablement controls in Project Configuration', async () => {
    apiMock.state = { config: readyConfig(), activeRun: null };
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    expect(byTestID(renderer, 'autopilot-setup')).toHaveLength(1);
    expect(byTestID(renderer, 'autopilot-disable')).toHaveLength(0);
    expect(byTestID(renderer, 'autopilot-enable-toggle')).toHaveLength(0);
  });

  it('surfaces an alert when a run-control action fails', async () => {
    apiMock.state = {
      config: readyConfig({ enabled: true }),
      activeRun: { run: run({ controlState: 'running' }), cycle: null },
    };
    apiMock.pauseAutopilot.mockRejectedValue(new Error('pause rejected by server'));
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    await pressByTestID(renderer, 'autopilot-pause');
    expect(apiMock.pauseAutopilot).toHaveBeenCalledWith('p1');
    expect(Alert.alert.mock.calls.some((c: any[]) => c[0] === 'Action failed')).toBe(true);
  });

  it('marks a run-control action busy while it is pending', async () => {
    apiMock.state = {
      config: readyConfig({ enabled: true }),
      activeRun: { run: run({ controlState: 'running' }), cycle: null },
    };
    // Pause never resolves, so it stays in flight for the whole test.
    apiMock.pauseAutopilot.mockReturnValue(new Promise(() => {}));
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();
    await pressByTestID(renderer, 'autopilot-pause');
    // A second Pause while the first is pending must be refused.
    await pressByTestID(renderer, 'autopilot-pause');
    expect(apiMock.pauseAutopilot).toHaveBeenCalledTimes(1);
    expect(byTestID(renderer, 'autopilot-pause')[0].props.disabled).toBe(true);
  });

  it('surfaces the evaluator-score and code-only-rollback limits in the run view', async () => {
    apiMock.state = {
      config: readyConfig({ enabled: true }),
      activeRun: { run: run({ controlState: 'running' }), cycle: null },
    };
    let renderer: any;
    await act(async () => {
      renderer = create(<ExperimentalAutopilotScreen route={ROUTE} navigation={NAV} />);
    });
    await flush();

    const [caveats] = byTestID(renderer, 'autopilot-run-caveats');
    expect(caveats).toBeTruthy();
    const text = Array.isArray(caveats.children)
      ? caveats.children.join('')
      : String(caveats.children);
    expect(text).toMatch(/do not prove product value/i);
    expect(text).toMatch(/monotonic improvement/i);
    expect(text).toMatch(/code rollback is not a database rollback/i);
    expect(text).toContain('docs/guides/experimental-autopilot.md');
  });
});
