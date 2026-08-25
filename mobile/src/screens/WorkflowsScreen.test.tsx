// @vitest-environment jsdom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getProjectWorkflows: vi.fn(),
  getWorkflowRuns: vi.fn(),
  getWorkflowRunDetail: vi.fn(),
}));

function host(tag: string) {
  return ({ children, testID, accessibilityLabel, onPress }: any) =>
    React.createElement(
      tag,
      { 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress },
      children,
    );
}

vi.mock('react-native', () => ({
  ActivityIndicator: host('span'),
  ScrollView: host('div'),
  StyleSheet: { create: (styles: any) => styles },
  Text: host('span'),
  TouchableOpacity: host('button'),
  View: host('div'),
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: host('main') }));
vi.mock('../components/ProjectScreenHeader', () => ({
  default: ({ title, right }: any) =>
    React.createElement('header', null, React.createElement('span', null, title), right),
}));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({ projects: [{ id: 'p1', name: 'Project One' }] }),
}));
vi.mock('../utils/api', () => ({ api: apiMocks }));
vi.mock('lucide-react-native', () => {
  const Icon = ({ children }: any) => React.createElement('i', null, children);
  return {
    ChevronDown: Icon,
    ChevronRight: Icon,
    ListOrdered: Icon,
    RefreshCw: Icon,
    Terminal: Icon,
  };
});

import WorkflowsScreen, { WorkflowRunsPanel } from './WorkflowsScreen';

const WORKFLOW = {
  id: 'wf-1',
  name: 'Release',
  steps: [
    { id: 'step-1', title: 'Build', step_order: 0 },
    { id: 'step-2', title: 'Ship', step_order: 1 },
  ],
};

const RUN_A = { id: 'run-aaaa', status: 'success', started_at: '2026-07-20 12:00:00' };
const RUN_B = { id: 'run-bbbb', status: 'success', started_at: '2026-07-20 12:01:00' };

function detail(run: any, title = 'Build', error: string | null = null) {
  return {
    run: { ...run, error },
    step_runs: [{ workflow_step_id: 'step-1', status: 'success', step_title: title }],
  };
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
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let j = 0; j < 8; j += 1) await Promise.resolve();
    flushSync(() => undefined);
  }
}

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root, unmount: () => root.unmount() };
}

function screenElement(projectId = 'p1', project = { id: projectId, name: 'Project' }) {
  return (
    <WorkflowsScreen route={{ params: { projectId, project } }} navigation={{ goBack: vi.fn() }} />
  );
}

function clickButton(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (el) => el.textContent?.includes(text) || el.getAttribute('aria-label') === text,
  );
  expect(button).toBeTruthy();
  button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('WorkflowsScreen async behavior', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    apiMocks.getProjectWorkflows.mockResolvedValue([WORKFLOW]);
    apiMocks.getWorkflowRuns.mockResolvedValue([RUN_A]);
    apiMocks.getWorkflowRunDetail.mockResolvedValue(detail(RUN_A));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('loads workflow cards, the latest run, and its detail timeline', async () => {
    const view = mount();
    flushSync(() => view.root.render(screenElement()));
    await flush();

    expect(view.container.textContent).toContain('Release');
    expect(view.container.textContent).toContain('Last run:');
    expect(apiMocks.getProjectWorkflows).toHaveBeenCalledWith('p1');
    expect(apiMocks.getWorkflowRuns).toHaveBeenCalledWith('p1', 'wf-1', { limit: 1 });
    expect(apiMocks.getWorkflowRunDetail).toHaveBeenCalledWith('p1', 'wf-1', 'run-aaaa');

    flushSync(() => view.root.unmount());
  });

  it('refreshes and surfaces a top-level loading error', async () => {
    const view = mount();
    flushSync(() => view.root.render(screenElement()));
    await flush();

    apiMocks.getProjectWorkflows.mockRejectedValueOnce(new Error('refresh failed'));
    flushSync(() => clickButton(view.container, 'Refresh workflows'));
    await flush();

    expect(view.container.textContent).toContain('refresh failed');
    expect(view.container.textContent).toContain('Release');
    flushSync(() => view.root.unmount());
  });

  it('does not overlap active polling loads when a previous load is slow', async () => {
    const poll = deferred<any[]>();
    let intervalCallback: (() => void) | null = null;
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: any) => {
      intervalCallback = callback;
      return 1 as any;
    }) as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
    apiMocks.getProjectWorkflows
      .mockResolvedValueOnce([WORKFLOW])
      .mockReturnValueOnce(poll.promise);
    apiMocks.getWorkflowRuns.mockResolvedValue([{ ...RUN_A, status: 'running' }]);

    const view = mount();
    flushSync(() => view.root.render(screenElement()));
    await flush();

    expect(intervalCallback).not.toBeNull();
    intervalCallback!();
    intervalCallback!();

    expect(apiMocks.getProjectWorkflows).toHaveBeenCalledTimes(2);
    poll.resolve([WORKFLOW]);
    await flush();
    flushSync(() => view.root.unmount());
  });

  it('polls only active workflows in the background, reusing settled rows', async () => {
    let intervalCallback: (() => void) | null = null;
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: any) => {
      intervalCallback = callback;
      return 1 as any;
    }) as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);

    const settled = { id: 'wf-settled', name: 'Settled', steps: WORKFLOW.steps };
    const active = { id: 'wf-active', name: 'Active', steps: WORKFLOW.steps };
    apiMocks.getProjectWorkflows.mockResolvedValue([settled, active]);
    apiMocks.getWorkflowRuns.mockImplementation((_p: string, wfId: string) =>
      Promise.resolve(
        wfId === 'wf-active'
          ? [{ id: 'run-active', status: 'running', started_at: '2026-07-20 12:00:00' }]
          : [{ id: 'run-settled', status: 'success', started_at: '2026-07-20 11:00:00' }],
      ),
    );
    apiMocks.getWorkflowRunDetail.mockImplementation((_p: string, wfId: string, runId: string) =>
      Promise.resolve(detail({ id: runId, status: wfId === 'wf-active' ? 'running' : 'success' })),
    );

    const view = mount();
    flushSync(() => view.root.render(screenElement()));
    await flush();

    const runsCallsFor = (id: string) =>
      apiMocks.getWorkflowRuns.mock.calls.filter((c: any[]) => c[1] === id).length;
    expect(runsCallsFor('wf-settled')).toBe(1);
    expect(runsCallsFor('wf-active')).toBe(1);

    expect(intervalCallback).not.toBeNull();
    intervalCallback!();
    await flush();

    // The settled workflow is reused from cache (no new request); only the
    // active workflow is refetched on the background poll.
    expect(runsCallsFor('wf-settled')).toBe(1);
    expect(runsCallsFor('wf-active')).toBe(2);
    expect(view.container.textContent).toContain('Settled');
    expect(view.container.textContent).toContain('Active');

    flushSync(() => view.root.unmount());
  });

  it('ignores a late response from the previous project', async () => {
    const oldLoad = deferred<any[]>();
    apiMocks.getProjectWorkflows.mockImplementation((projectId: string) =>
      projectId === 'p1'
        ? oldLoad.promise
        : Promise.resolve([{ ...WORKFLOW, id: 'wf-2', name: 'Current' }]),
    );

    const view = mount();
    flushSync(() => view.root.render(screenElement('p1', { id: 'p1', name: 'Old' })));
    flushSync(() => view.root.render(screenElement('p2', { id: 'p2', name: 'Current project' })));
    await flush();

    oldLoad.resolve([WORKFLOW]);
    await flush();

    expect(view.container.textContent).toContain('Current');
    expect(view.container.textContent).not.toContain('Release');
    flushSync(() => view.root.unmount());
  });

  it('clears a previous project error when switching projects', async () => {
    apiMocks.getProjectWorkflows.mockRejectedValueOnce(new Error('old project failed'));

    const view = mount();
    flushSync(() => view.root.render(screenElement('p1', { id: 'p1', name: 'Old' })));
    await flush();
    expect(view.container.textContent).toContain('old project failed');

    apiMocks.getProjectWorkflows.mockResolvedValueOnce([]);
    flushSync(() => view.root.render(screenElement('p2', { id: 'p2', name: 'Current' })));
    await flush();

    expect(view.container.textContent).not.toContain('old project failed');
    expect(view.container.textContent).toContain('No Hub workflows defined');
    flushSync(() => view.root.unmount());
  });

  it('clears the previous project rows while the next project loads', async () => {
    const nextProject = deferred<any[]>();
    apiMocks.getProjectWorkflows
      .mockResolvedValueOnce([WORKFLOW])
      .mockReturnValueOnce(nextProject.promise);

    const view = mount();
    flushSync(() => view.root.render(screenElement('p1', { id: 'p1', name: 'Old' })));
    await flush();
    expect(view.container.textContent).toContain('Release');

    flushSync(() => view.root.render(screenElement('p2', { id: 'p2', name: 'Current' })));
    await flush();
    expect(view.container.textContent).not.toContain('Release');

    nextProject.resolve([]);
    await flush();
    flushSync(() => view.root.unmount());
  });
});

describe('WorkflowRunsPanel async behavior', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('stops the initial loading state and retries a failed run-list request', async () => {
    apiMocks.getWorkflowRuns
      .mockRejectedValueOnce(new Error('runs failed'))
      .mockResolvedValueOnce([RUN_A]);
    apiMocks.getWorkflowRunDetail.mockResolvedValue(detail(RUN_A));

    const view = mount();
    flushSync(() => view.root.render(<WorkflowRunsPanel projectId="p1" workflow={WORKFLOW} />));
    await flush();

    expect(view.container.textContent).toContain('runs failed');
    expect(view.container.querySelector('[aria-label="Retry loading runs"]')).toBeTruthy();

    clickButton(view.container, 'Retry loading runs');
    await flush();

    expect(apiMocks.getWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).not.toContain('runs failed');
    expect(view.container.textContent).toContain('run-aaaa');
    flushSync(() => view.root.unmount());
  });

  it('ignores stale detail after selecting a different run', async () => {
    const oldDetail = deferred<any>();
    const currentDetail = deferred<any>();
    apiMocks.getWorkflowRuns.mockResolvedValue([RUN_A, RUN_B]);
    apiMocks.getWorkflowRunDetail.mockImplementation((_: string, __: string, runId: string) =>
      runId === RUN_A.id ? oldDetail.promise : currentDetail.promise,
    );

    const view = mount();
    flushSync(() => view.root.render(<WorkflowRunsPanel projectId="p1" workflow={WORKFLOW} />));
    await flush();
    clickButton(view.container, 'run-bbbb');
    await flush();
    expect(apiMocks.getWorkflowRunDetail).toHaveBeenCalledWith('p1', 'wf-1', 'run-bbbb');

    currentDetail.resolve(detail(RUN_B, 'Current step', 'current detail'));
    await flush();
    expect(view.container.textContent).toContain('current detail');

    oldDetail.resolve(detail({ ...RUN_A, status: 'error' }, 'Stale step', 'stale failure'));
    await flush();
    expect(view.container.textContent).toContain('current detail');
    expect(view.container.textContent).not.toContain('stale failure');
    flushSync(() => view.root.unmount());
  });

  it('guards active run-list polling while its request is in flight', async () => {
    const pollRuns = deferred<any[]>();
    let intervalCallback: (() => void) | null = null;
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: any) => {
      intervalCallback = callback;
      return 1 as any;
    }) as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
    apiMocks.getWorkflowRuns.mockResolvedValueOnce([RUN_A]).mockReturnValueOnce(pollRuns.promise);
    apiMocks.getWorkflowRunDetail.mockResolvedValue(detail({ ...RUN_A, status: 'running' }));

    const view = mount();
    flushSync(() => view.root.render(<WorkflowRunsPanel projectId="p1" workflow={WORKFLOW} />));
    await flush();

    expect(intervalCallback).not.toBeNull();
    intervalCallback!();
    intervalCallback!();

    expect(apiMocks.getWorkflowRuns).toHaveBeenCalledTimes(2);
    pollRuns.resolve([RUN_A]);
    await flush();
    flushSync(() => view.root.unmount());
  });

  it('re-arms the detail poll even while a prior detail request is still in flight', async () => {
    let intervalCallback: (() => void) | null = null;
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: any) => {
      intervalCallback = callback;
      return 1 as any;
    }) as typeof window.setInterval);
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);

    const running = { ...RUN_A, status: 'running' };
    apiMocks.getWorkflowRuns.mockResolvedValue([running]);
    const hang = deferred<any>();
    apiMocks.getWorkflowRunDetail
      .mockResolvedValueOnce(detail(running)) // initial selection load
      .mockReturnValueOnce(hang.promise) // poll tick 1 — stays in flight
      .mockResolvedValue(detail(running)); // poll tick 2 onward

    const view = mount();
    flushSync(() => view.root.render(<WorkflowRunsPanel projectId="p1" workflow={WORKFLOW} />));
    await flush();
    expect(apiMocks.getWorkflowRunDetail).toHaveBeenCalledTimes(1);

    intervalCallback!(); // tick 1: detail request hangs, still in flight
    await flush();
    expect(apiMocks.getWorkflowRunDetail).toHaveBeenCalledTimes(2);

    // Tick 2 must NOT be deduped away by the still-in-flight tick-1 request:
    // the poll supersedes it so live progress never wedges.
    intervalCallback!();
    await flush();
    expect(apiMocks.getWorkflowRunDetail).toHaveBeenCalledTimes(3);

    hang.resolve(detail(running));
    await flush();
    flushSync(() => view.root.unmount());
  });

  it('clears a failed detail error when selecting a run that loads successfully', async () => {
    apiMocks.getWorkflowRuns.mockResolvedValue([RUN_A, RUN_B]);
    apiMocks.getWorkflowRunDetail
      .mockRejectedValueOnce(new Error('detail failed'))
      .mockResolvedValueOnce(detail(RUN_B));

    const view = mount();
    flushSync(() => view.root.render(<WorkflowRunsPanel projectId="p1" workflow={WORKFLOW} />));
    await flush();
    expect(view.container.textContent).toContain('detail failed');

    clickButton(view.container, 'run-bbbb');
    await flush();

    expect(view.container.textContent).not.toContain('detail failed');
    expect(view.container.textContent).toContain('run-bbbb');
    flushSync(() => view.root.unmount());
  });

  it('offers a retry when a settled run detail request fails', async () => {
    apiMocks.getWorkflowRuns.mockResolvedValue([RUN_A]);
    apiMocks.getWorkflowRunDetail
      .mockRejectedValueOnce(new Error('detail unavailable'))
      .mockResolvedValueOnce(detail(RUN_A));

    const view = mount();
    flushSync(() => view.root.render(<WorkflowRunsPanel projectId="p1" workflow={WORKFLOW} />));
    await flush();

    expect(view.container.textContent).toContain('detail unavailable');
    expect(view.container.querySelector('[aria-label="Retry run detail"]')).toBeTruthy();

    clickButton(view.container, 'Retry run detail');
    await flush();

    expect(apiMocks.getWorkflowRunDetail).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).not.toContain('detail unavailable');
    expect(view.container.textContent).toContain('run-aaaa');
    flushSync(() => view.root.unmount());
  });
});
