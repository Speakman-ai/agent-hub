/**
 * QaPlanDetailView mounted with react-test-renderer: a case refreshed by a
 * concurrent edit while its form is open must not become the edit's base.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Image: 'Image',
  Linking: { openURL: vi.fn() },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('./SessionArtifactViewerModal', () => ({ default: () => null }));

const qaListeners = new Set<(e: any) => void>();
vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    subscribeQaUpdates: (fn: (e: any) => void) => {
      qaListeners.add(fn);
      return () => qaListeners.delete(fn);
    },
  }),
}));
const emitQa = (e: any) => [...qaListeners].forEach((fn) => fn(e));

const original = { title: 'Login works', steps: '1. Open /login', expected: 'Dashboard shows' };
let savedCase = { ...original };
const updateQaCase = vi.fn(async () => ({}));
const getQaPlanCalls: string[] = [];
vi.mock('../utils/api', () => ({
  api: {
    getQaPlan: vi.fn(async (_p: string, planId: string) => {
      getQaPlanCalls.push(planId);
      return {
        plan: {
          id: 'plan-1',
          projectId: 'p1',
          title: 'Plan',
          goal: '',
          targetUrl: 'https://staging.example.com',
          epicId: null,
          cardId: null,
          deployEnvironment: null,
          status: 'new',
          approved: false,
          approvedAt: null,
          approvedBy: null,
          signedOffAt: null,
          signedOffBy: null,
          autoRerun: true,
          maxIterations: 5,
          authoringSessionId: null,
        },
        links: { epic: null, card: null },
        cases: [{ id: 'c1', planId: 'plan-1', position: 0, version: 1, ...savedCase }],
        runs: [],
        signOffBlocker: null,
        autoRerun: null,
      };
    }),
    getDeployEnvironments: vi.fn(async () => ({ environments: [] })),
    updateQaCase,
  },
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: QaPlanDetailView } = await import('./QaPlanDetailView');
process.env.NODE_ENV = originalNodeEnv;

const flush = () => act(async () => {});

describe('QaPlanDetailView case editing', () => {
  it('keeps the opening text as the edit base when the case refreshes mid-edit', async () => {
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<QaPlanDetailView projectId="p1" planId="plan-1" />);
    });
    await flush();
    await act(async () => {
      tree.root.findByProps({ testID: 'qa-case-edit' }).props.onPress();
    });

    // Another author changes the expected text; the qa_update refresh lands
    // while this form is still open.
    savedCase = { ...original, expected: 'Dashboard shows a welcome banner' };
    await act(async () => {
      emitQa({ projectId: 'p1', planId: 'plan-1' });
    });
    await flush();

    const form = tree.root.findByProps({ testID: 'qa-case-form' });
    const [title, , expected] = form.findAllByType('TextInput');
    await act(async () => {
      title.props.onChangeText('Login works for admins');
      expected.props.onChangeText('Admin dashboard shows');
    });
    const save = form
      .findAllByType('TouchableOpacity')
      .find((b: any) => b.findAllByType('Text').some((t: any) => t.props.children === 'Save'));
    await act(async () => {
      save.props.onPress();
    });
    await flush();

    expect(updateQaCase).toHaveBeenCalledTimes(1);
    const [, , caseId, body] = updateQaCase.mock.calls[0] as any[];
    expect(caseId).toBe('c1');
    expect(body).toEqual({
      title: 'Login works for admins',
      expected: 'Admin dashboard shows',
      // The text the user started from, so the server refuses the stale expected edit.
      expectedBase: { title: original.title, expected: original.expected },
    });
    tree.unmount();
  });

  it('reloads the open plan when its update arrives in a batch with another plan', async () => {
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<QaPlanDetailView projectId="p1" planId="plan-1" />);
    });
    await flush();
    getQaPlanCalls.length = 0;

    // Both broadcasts land before React commits.
    await act(async () => {
      emitQa({ projectId: 'p1', planId: 'plan-1' });
      emitQa({ projectId: 'p1', planId: 'plan-2' });
    });
    await flush();

    expect(getQaPlanCalls).toEqual(['plan-1']);
    tree.unmount();
  });
});
