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
let planOverrides: Record<string, unknown> = {};
let runs: unknown[] = [];
const troubleshootQaResult = vi.fn(async () => ({ sessionId: 's7', agentId: 'p1-dev' }));
const updateQaPlan = vi.fn(async () => ({}));
const overrideQaResult = vi.fn(async () => ({}));
const getProjectBranches = vi.fn(async () => ({
  branches: [{ name: 'main' }, { name: 'release' }],
}));
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
          autoFix: false,
          autoRerunTrigger: 'deployment',
          autoRerunBranch: null,
          autoRerunDelayMinutes: 0,
          maxIterations: 5,
          authoringSessionId: null,
          ...planOverrides,
        },
        links: { epic: null, card: null },
        cases: [{ id: 'c1', planId: 'plan-1', position: 0, version: 1, ...savedCase }],
        runs,
        signOffBlocker: null,
        autoRerun: null,
      };
    }),
    getDeployEnvironments: vi.fn(async () => ({ environments: [] })),
    getProjectBranches,
    updateQaPlan,
    updateQaCase,
    troubleshootQaResult,
    overrideQaResult,
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

describe('QaPlanDetailView rerun triggers', () => {
  it('saves the trigger, and with the merge trigger the branch and delay', async () => {
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<QaPlanDetailView projectId="p1" planId="plan-1" />);
    });
    await flush();
    expect(tree.root.findAllByProps({ testID: 'qa-auto-rerun-branch' })).toHaveLength(0);
    await act(async () => {
      tree.root.findByProps({ testID: 'qa-auto-rerun-trigger-merge' }).props.onPress();
    });
    await flush();
    expect(updateQaPlan).toHaveBeenCalledWith('p1', 'plan-1', { autoRerunTrigger: 'merge' });
    tree.unmount();

    planOverrides = { autoRerunTrigger: 'merge' };
    await act(async () => {
      tree = TestRenderer.create(<QaPlanDetailView projectId="p1" planId="plan-1" />);
    });
    await flush();
    expect(getProjectBranches).toHaveBeenCalledWith('p1');
    expect(tree.root.findAllByProps({ testID: 'qa-deploy-environment' })).toHaveLength(0);
    await act(async () => {
      tree.root.findByProps({ testID: 'qa-auto-rerun-branch-release' }).props.onPress();
    });
    await flush();
    expect(updateQaPlan).toHaveBeenCalledWith('p1', 'plan-1', { autoRerunBranch: 'release' });
    await act(async () => {
      tree.root.findByProps({ testID: 'qa-auto-rerun-delay-15' }).props.onPress();
    });
    await flush();
    expect(updateQaPlan).toHaveBeenCalledWith('p1', 'plan-1', { autoRerunDelayMinutes: 15 });
    planOverrides = {};
    tree.unmount();
  });

  it('with the fixes-merged trigger, offers the delay but no branch or environment', async () => {
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<QaPlanDetailView projectId="p1" planId="plan-1" />);
    });
    await flush();
    await act(async () => {
      tree.root.findByProps({ testID: 'qa-auto-rerun-trigger-fixes_merged' }).props.onPress();
    });
    await flush();
    expect(updateQaPlan).toHaveBeenCalledWith('p1', 'plan-1', { autoRerunTrigger: 'fixes_merged' });
    tree.unmount();

    planOverrides = { autoRerunTrigger: 'fixes_merged' };
    await act(async () => {
      tree = TestRenderer.create(<QaPlanDetailView projectId="p1" planId="plan-1" />);
    });
    await flush();
    expect(tree.root.findAllByProps({ testID: 'qa-auto-rerun-branch' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'qa-deploy-environment' })).toHaveLength(0);
    await act(async () => {
      tree.root.findByProps({ testID: 'qa-auto-rerun-delay-30' }).props.onPress();
    });
    await flush();
    expect(updateQaPlan).toHaveBeenCalledWith('p1', 'plan-1', { autoRerunDelayMinutes: 30 });
    planOverrides = {};
    tree.unmount();
  });
});

describe('QaPlanDetailView troubleshoot', () => {
  it('opens a dev session from a failed result', async () => {
    runs = [
      {
        id: 'r1',
        planId: 'plan-1',
        iteration: 1,
        scope: 'full',
        status: 'failed',
        sessionId: null,
        sessionAgentId: null,
        results: [
          {
            id: 'res-1',
            runId: 'r1',
            caseId: 'c1',
            caseVersion: 1,
            verdict: 'fail',
            actual: 'Blank page',
            notes: '',
            screenshotArtifactIds: [],
            screenshots: [],
            findingCardId: null,
          },
        ],
      },
    ];
    const onOpenSession = vi.fn();
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(
        <QaPlanDetailView projectId="p1" planId="plan-1" onOpenSession={onOpenSession} />,
      );
    });
    await flush();
    await act(async () => {
      tree.root.findByProps({ testID: 'qa-result-troubleshoot' }).props.onPress();
    });
    await flush();
    expect(troubleshootQaResult).toHaveBeenCalledWith('p1', 'plan-1', 'r1', 'c1');
    expect(onOpenSession).toHaveBeenCalledWith('p1-dev', 's7');
    runs = [];
    tree.unmount();
  });
});

describe('QaPlanDetailView verdict override', () => {
  const failedRun = (override: unknown = null) => ({
    id: 'r1',
    planId: 'plan-1',
    iteration: 1,
    scope: 'full',
    status: 'failed',
    sessionId: null,
    sessionAgentId: null,
    results: [
      {
        id: 'res-1',
        runId: 'r1',
        caseId: 'c1',
        caseVersion: 1,
        verdict: 'fail',
        actual: 'Looks right to a person',
        notes: '',
        screenshotArtifactIds: [],
        screenshots: [],
        findingCardId: null,
        override,
      },
    ],
  });

  it('marks a failed result as pass and refreshes the plan', async () => {
    runs = [failedRun()];
    planOverrides = { status: 'in_progress', approved: true };
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<QaPlanDetailView projectId="p1" planId="plan-1" />);
    });
    await flush();
    const calls = getQaPlanCalls.length;
    await act(async () => {
      tree.root.findByProps({ testID: 'qa-result-override' }).props.onPress();
    });
    await flush();
    expect(overrideQaResult).toHaveBeenCalledWith('p1', 'plan-1', 'r1', 'c1', 'pass');
    expect(getQaPlanCalls.length).toBeGreaterThan(calls);
    tree.unmount();
  });

  it('labels an override, undoes it, and hides the controls on a signed-off plan', async () => {
    overrideQaResult.mockClear();
    runs = [failedRun({ originalVerdict: 'pass', by: 'u1', at: null })];
    planOverrides = { status: 'in_progress', approved: true };
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<QaPlanDetailView projectId="p1" planId="plan-1" />);
    });
    await flush();
    tree.root.findByProps({ testID: 'qa-result-overridden' });
    await act(async () => {
      tree.root.findByProps({ testID: 'qa-result-override-undo' }).props.onPress();
    });
    expect(overrideQaResult).toHaveBeenCalledWith('p1', 'plan-1', 'r1', 'c1', 'pass');
    tree.unmount();

    planOverrides = { status: 'done', approved: true };
    await act(async () => {
      tree = TestRenderer.create(<QaPlanDetailView projectId="p1" planId="plan-1" />);
    });
    await flush();
    expect(tree.root.findAllByProps({ testID: 'qa-result-override' })).toHaveLength(0);
    runs = [];
    planOverrides = {};
    tree.unmount();
  });
});

describe('QaPlanDetailView plan details', () => {
  const findSave = (form: any) => form.findByProps({ testID: 'qa-plan-details-save' });

  it('renames an approved plan without asking about approval', async () => {
    planOverrides = { approved: true, approvedAt: '2026-10-26 09:00:00', status: 'in_progress' };
    runs = [];
    updateQaPlan.mockClear();
    const { Alert } = await import('react-native');
    (Alert.alert as any).mockClear();
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<QaPlanDetailView projectId="p1" planId="plan-1" />);
    });
    await flush();
    await act(async () => {
      tree.root.findByProps({ testID: 'qa-plan-edit-details' }).props.onPress();
    });
    const form = tree.root.findByProps({ testID: 'qa-plan-details-form' });
    await act(async () => {
      form.findByProps({ testID: 'qa-plan-details-title' }).props.onChangeText('Plan v2');
      form.findByProps({ testID: 'qa-plan-details-goal' }).props.onChangeText('Log in');
    });
    await act(async () => {
      findSave(form).props.onPress();
    });
    await flush();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(updateQaPlan).toHaveBeenCalledWith('p1', 'plan-1', { title: 'Plan v2', goal: 'Log in' });
    tree.unmount();
    planOverrides = {};
  });

  it('locks the target URL on a signed-off plan', async () => {
    planOverrides = { approved: true, status: 'done', signedOffAt: '2026-10-26 12:00:00' };
    runs = [];
    let tree: any;
    await act(async () => {
      tree = TestRenderer.create(<QaPlanDetailView projectId="p1" planId="plan-1" />);
    });
    await flush();
    await act(async () => {
      tree.root.findByProps({ testID: 'qa-plan-edit-details' }).props.onPress();
    });
    expect(tree.root.findByProps({ testID: 'qa-plan-details-target' }).props.editable).toBe(false);
    expect(tree.root.findByProps({ testID: 'qa-plan-details-title' }).props.editable).toBe(true);
    tree.unmount();
    planOverrides = {};
  });
});
