/**
 * Mobile "Run QA Tests": checkbox before merge, button after, plan link once
 * a plan exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (s: any) => s },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('./AppIcon', () => ({ default: 'AppIcon' }));
const qaListeners = new Set<(e: any) => void>();
vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    subscribeQaUpdates: (fn: (e: any) => void) => {
      qaListeners.add(fn);
      return () => qaListeners.delete(fn);
    },
  }),
}));
const getSessionQaRequest = vi.fn();
const setSessionQaRequestArmed = vi.fn();
const runSessionQaRequest = vi.fn();
vi.mock('../utils/api', () => ({
  api: {
    getSessionQaRequest: (...a: unknown[]) => getSessionQaRequest(...a),
    setSessionQaRequestArmed: (...a: unknown[]) => setSessionQaRequestArmed(...a),
    runSessionQaRequest: (...a: unknown[]) => runSessionQaRequest(...a),
  },
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: SessionQaControl } = await import('./SessionQaControl');

/** The mutation changes server state, so the GET that follows returns `next`. */
function serverMovesTo(fn: ReturnType<typeof vi.fn>, next: unknown) {
  fn.mockImplementation(async () => {
    getSessionQaRequest.mockResolvedValue(next);
    return next;
  });
}
process.env.NODE_ENV = originalNodeEnv;

const state = (over: Record<string, unknown> = {}) => ({
  request: null,
  merged: false,
  defaultEnvironment: { id: 'e', name: 'Staging', baseUrl: 'https://s.example.com' },
  delayMinutes: 0,
  hasQaAgent: true,
  ...over,
});
const req = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  projectId: 'p',
  status: 'armed',
  planId: null,
  planTitle: null,
  runId: null,
  dueAt: null,
  error: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});
const byId = (tree: any, id: string) => tree.root.find((n: any) => n.props?.testID === id);

beforeEach(() => vi.clearAllMocks());

describe('mobile SessionQaControl', () => {
  it('arms from the checkbox before merge', async () => {
    getSessionQaRequest.mockResolvedValue(state());
    serverMovesTo(setSessionQaRequestArmed, state({ request: req() }));
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<SessionQaControl sessionId="s1" />);
    });
    const box = byId(tree, 'session-qa-checkbox');
    expect(box.props.accessibilityState.checked).toBe(false);
    await act(async () => box.props.onPress());
    expect(setSessionQaRequestArmed).toHaveBeenCalledWith('s1', true);
    expect(byId(tree, 'session-qa-checkbox').props.accessibilityState.checked).toBe(true);
  });

  it('runs from the button after merge and opens the plan', async () => {
    getSessionQaRequest.mockResolvedValue(state({ merged: true }));
    serverMovesTo(
      runSessionQaRequest,
      state({ merged: true, request: req({ status: 'authoring', planId: 'plan-1' }) }),
    );
    const onOpenPlan = vi.fn();
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<SessionQaControl sessionId="s1" onOpenPlan={onOpenPlan} />);
    });
    await act(async () => byId(tree, 'session-qa-run-button').props.onPress());
    expect(runSessionQaRequest).toHaveBeenCalledWith('s1');
    await act(async () => byId(tree, 'session-qa-plan-link').props.onPress());
    expect(onOpenPlan).toHaveBeenCalledWith('plan-1');
  });

  it('ignores a mutation that resolves after switching to another session', async () => {
    getSessionQaRequest.mockResolvedValue(state({ merged: true }));
    let resolveRun!: (v: unknown) => void;
    runSessionQaRequest.mockImplementation(() => new Promise((r) => (resolveRun = r)));
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<SessionQaControl sessionId="a" />);
    });
    await act(async () => {
      byId(tree, 'session-qa-run-button').props.onPress();
    });
    await act(async () => tree.update(<SessionQaControl sessionId="b" />));
    expect(getSessionQaRequest).toHaveBeenCalledWith('b');
    expect(byId(tree, 'session-qa-run-button').props.disabled).toBe(false);
    await act(async () =>
      resolveRun(state({ merged: true, request: req({ status: 'authoring', planId: 'plan-a' }) })),
    );
    expect(tree.root.findAll((n: any) => n.props?.testID === 'session-qa-plan-link')).toHaveLength(
      0,
    );
    expect(byId(tree, 'session-qa-run-button').props.disabled).toBe(false);
  });

  it('lets an armed request be unticked after the QA agent is removed', async () => {
    getSessionQaRequest.mockResolvedValue(state({ hasQaAgent: false, request: req() }));
    serverMovesTo(setSessionQaRequestArmed, state({ hasQaAgent: false }));
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<SessionQaControl sessionId="s1" />);
    });
    const box = byId(tree, 'session-qa-checkbox');
    expect(box.props.disabled).toBe(false);
    await act(async () => box.props.onPress());
    expect(setSessionQaRequestArmed).toHaveBeenCalledWith('s1', false);
    expect(byId(tree, 'session-qa-checkbox').props.disabled).toBe(true);
  });

  it('a mutation response that arrives after a newer update does not overwrite it', async () => {
    getSessionQaRequest.mockResolvedValue(state({ merged: true }));
    let resolveRun!: (v: unknown) => void;
    runSessionQaRequest.mockImplementation(() => new Promise((r) => (resolveRun = r)));
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<SessionQaControl sessionId="s1" />);
    });
    await act(async () => {
      byId(tree, 'session-qa-run-button').props.onPress();
    });
    getSessionQaRequest.mockResolvedValue(
      state({
        merged: true,
        request: req({ status: 'waiting', planId: 'p1', dueAt: '2999-01-01T00:00:00Z' }),
      }),
    );
    await act(async () => {
      for (const fn of qaListeners) fn({ sessionId: 's1', action: 'session_request_updated' });
    });
    const status = () => byId(tree, 'session-qa-status').props.children as string;
    expect(status()).toMatch(/QA run starts/);
    await act(async () =>
      resolveRun(state({ merged: true, request: req({ status: 'authoring', planId: 'p1' }) })),
    );
    expect(status()).toMatch(/QA run starts/);
  });
});
