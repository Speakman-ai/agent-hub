import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import PullRequestsPage, { mapWithConcurrency } from './PullRequestsPage';
import { api } from '../utils/api';

/**
 * Component test for the Resolve PR button in <PullRequestsPage />.
 *
 * Covers the response branches from `POST /api/projects/:projectId/pulls/:number/resolve`:
 *   - 201 with `sessionId` → success toast + inline "Session started" (does not auto-navigate;
 *     optional "Open chat" calls `onOpenSession` when clicked)
 *   - rejected promise → error toast with the message
 *
 * The button always brings the PR into a session (no "nothing to resolve" gate),
 * so it stays enabled regardless of the PR's clean/dirty state.
 *
 * Also verifies: button disabled + spinner while in flight (prevents double-submit),
 * and the no-agent edge case (button disabled with tooltip when project.agents is empty).
 */

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getProjectPulls: vi.fn(),
    getProjectPullDetail: vi.fn(),
    resolvePR: vi.fn(),
    getPrDiffText: vi.fn(async () => 'diff --git a/x.txt b/x.txt\n+x'),
    updateNativePr: vi.fn(),
    getGitHostRecentPushes: vi.fn(async () => ({ pushes: [] })),
    getGitHostBranches: vi.fn(async () => ({ defaultBranch: 'main', branches: [] })),
    getCiRunDetail: vi.fn(),
    getFinalizeStepOutput: vi.fn(),
    getFinalizeRunResources: vi.fn(),
    cancelFinalizeRun: vi.fn(),
    getNativePrBranchChanges: vi.fn(async () => ({
      headBranch: 'feature/x',
      baseBranch: 'main',
      stats: { changedFiles: 1, additions: 1, deletions: 0 },
      files: [{ filename: 'x.txt', status: 'added', additions: 1, deletions: 0 }],
      truncated: false,
    })),
    generatePrDescription: vi.fn(),
    rerunCiRun: vi.fn(),
    createNativePr: vi.fn(),
    revertNativePr: vi.fn(),
    dismissNativePrReview: vi.fn(),
    requestNativePrReview: vi.fn(),
    startNativePrPreview: vi.fn(),
    stopNativePrPreview: vi.fn(),
    getNativePrPreviewState: vi.fn(),
  },
}));

const prSummary = {
  number: 123,
  title: 'Fix the flaky test',
  state: 'open',
  user: 'alice',
  head: 'feature/x',
  base: 'main',
  updated_at: '2026-04-19T10:00:00Z',
  created_at: '2026-04-19T09:00:00Z',
  html_url: 'https://github.com/owner/repo/pull/123',
  labels: [],
  additions: 3,
  deletions: 1,
  changed_files: 1,
};

const detailResponse = {
  pr: { ...prSummary, mergeable: true, mergeable_state: 'clean' },
  checks: [],
  reviews: [],
  comments: [],
};

const project = {
  id: 'proj-1',
  name: 'Demo',
  githubRepo: 'owner/repo',
  agents: [
    { id: 'agent-alpha', name: 'Alpha', role: 'lead', active: true },
    { id: 'agent-rev', name: 'Reviewer', role: 'reviewer', active: true },
  ],
};

describe('mapWithConcurrency', () => {
  it('limits concurrent branch scans', async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value: any) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve: any) => setTimeout(resolve, 0));
      active -= 1;
      return value * 2;
    });

    expect(result!).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxActive!).toBeLessThanOrEqual(2);
  });
});

async function renderAndOpenDetail(props: any = {}) {
  (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
  (api.getProjectPullDetail as any).mockResolvedValue(detailResponse);

  render(<PullRequestsPage projectId="proj-1" project={project} {...props} />);

  // Wait for the list to load, then click into the detail view.
  const title = await screen.findByText('Fix the flaky test');
  fireEvent.click(title as any);

  // Wait for the detail view to render (Resolve PR button present).
  return await screen.findByRole('button', { name: /resolve pr/i });
}

describe('<PullRequestsPage /> — Resolve PR button', () => {
  beforeEach(() => {
    (api.getProjectPulls as any).mockReset();
    (api.getProjectPullDetail as any).mockReset();
    (api.resolvePR as any).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls api.resolvePR with the first agent id on click', async () => {
    (api.resolvePR as any).mockResolvedValue({
      sessionId: 'sess-99',
      triggered: ['ci'],
      session: { id: 'sess-99' },
    });
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn as any);

    await waitFor(() => expect(api.resolvePR).toHaveBeenCalledTimes(1));
    expect(api.resolvePR).toHaveBeenCalledWith('proj-1', 123, {
      agentId: 'agent-alpha',
    });

    expect(onOpenSession!).not.toHaveBeenCalled();
    // Success toast mentions the triggered kinds
    await waitFor(() =>
      expect(onToast!).toHaveBeenCalledWith(
        expect.stringMatching(/ci/i),
        'success',
        expect.any(Number),
      ),
    );
    const openChat = await screen.findByRole('button', { name: /open chat/i });
    fireEvent.click(openChat as any);
    expect(onOpenSession!).toHaveBeenCalledWith('agent-alpha', 'sess-99');
  });

  it('shows the Activity timeline on the PR detail view', async () => {
    await renderAndOpenDetail();
    expect(await screen.findByText('Activity')).toBeTruthy();
    expect(screen.getByText(/Chronological history from GitHub/i)).toBeTruthy();
  });

  it('renders the backing CI run as an expandable runner row with step logs', async () => {
    const ciRun = {
      id: 'run-pr-1',
      branch: 'feature/x',
      head_sha: 'c'.repeat(40),
      status: 'failed',
      trigger_source: 'pr_push',
      failure_reason: 'checks_failed',
      started_at: Date.now() - 70_000,
      ended_at: Date.now() - 30_000,
      jobs: [
        {
          job_id: 'test',
          matrix_key: 'mobile 1/2',
          state: 'failed',
          exit_code: 1,
          started_at: 1,
          ended_at: 2,
        },
      ],
    };
    (api.getProjectPullDetail as any).mockResolvedValue({
      ...detailResponse,
      source: 'agenthub',
      ci_run: ciRun,
      checks: [
        {
          id: 'flat-check',
          name: 'legacy flat row',
          status: 'completed',
          conclusion: 'failure',
          job_id: 'test',
        },
      ],
    });
    (api.getCiRunDetail as any).mockResolvedValue({
      run: ciRun,
      steps: [
        {
          step_index: 1,
          name: 'test / mobile 1/2 / Tests (mobile 1/2)',
          state: 'failed',
          exit_code: 1,
          started_at: 1,
          ended_at: 2,
          job_id: 'test',
          matrix_key: 'mobile 1/2',
        },
      ],
    });
    (api.getFinalizeRunResources as any).mockResolvedValue({
      jobs: [
        {
          job_name: 'test',
          matrix_key: 'mobile 1/2',
          peak_mem_bytes: 1.3 * 1024 * 1024 * 1024,
          mem_total_bytes: 15.3 * 1024 * 1024 * 1024,
          peak_cpu_percent: 44,
        },
      ],
    });
    (api.getFinalizeStepOutput as any).mockResolvedValue({
      lines: ['npm test failed'],
    });

    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByText('Fix the flaky test' as any));

    const runSection = await screen.findByTestId('pr-ci-run-row');
    expect(within(runSection).getByTestId('ci-run-run-pr-1')).toHaveTextContent('pr ci');
    expect(within(runSection).getByText('feature/x')).toBeInTheDocument();
    expect(screen.queryByText('legacy flat row')).toBeNull();

    fireEvent.click(within(runSection).getByTestId('ci-run-run-pr-1' as any));
    expect(await screen.findByText('mobile 1/2')).toBeInTheDocument();
    expect(await screen.findByText('1.3 / 15.3 GB · 44%')).toBeInTheDocument();

    fireEvent.click(await screen.findByTestId('ci-run-step-run-pr-1-1' as any));
    await waitFor(() =>
      expect(api.getFinalizeStepOutput).toHaveBeenCalledWith('proj-1', 'run-pr-1', 1),
    );
    expect(await screen.findByText('npm test failed')).toBeInTheDocument();
  });

  it('renders the detailed run for a Finalize PR (checks_run, ci_run null) without re-run/stop', async () => {
    const checksRun = {
      id: 'fin-1',
      branch: 'feature/x',
      head_sha: 'd'.repeat(40),
      status: 'succeeded',
      trigger_source: 'finalize',
      failure_reason: null,
      started_at: Date.now() - 70_000,
      ended_at: Date.now() - 30_000,
      session_title: 'Finalized work',
      jobs: [
        {
          job_id: 'backend',
          matrix_key: '',
          state: 'passed',
          exit_code: 0,
          started_at: 1,
          ended_at: 2,
        },
      ],
    };
    (api.getProjectPullDetail as any).mockResolvedValue({
      ...detailResponse,
      source: 'agenthub',
      // Finalize runs are not re-runnable from the PR page.
      ci_run: null,
      checks_run: checksRun,
      // A flat check exists too — the detailed run must win over it.
      checks: [
        { id: 'flat', name: 'finalize/backend', status: 'completed', conclusion: 'success' },
      ],
    });
    (api.getCiRunDetail as any).mockResolvedValue({ run: checksRun, steps: [] });
    (api.getFinalizeRunResources as any).mockResolvedValue({ jobs: [] });

    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByText('Fix the flaky test' as any));

    const runSection = await screen.findByTestId('pr-ci-run-row');
    const runRow = within(runSection).getByTestId('ci-run-fin-1');
    expect(runRow).toHaveTextContent('finalize');
    // The flat check list is suppressed in favor of the detailed run.
    expect(screen.queryByTestId('pr-checks-empty-note')).toBeNull();
    // No re-run / stop affordances for a non-re-runnable Finalize run.
    expect(within(runSection).queryByTestId('ci-run-rerun-fin-1')).toBeNull();
    expect(within(runSection).queryByTestId('ci-run-stop-fin-1')).toBeNull();
    expect(screen.queryByTestId('pr-rerun-checks')).toBeNull();
  });

  it('disables the button while the request is in flight', async () => {
    let resolveFn: any;
    (api.resolvePR as any).mockReturnValue(
      new Promise((resolve: any) => {
        resolveFn = resolve;
      }),
    );
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn as any);

    // While the request is pending the button must be disabled.
    await waitFor(() => expect(btn!).toBeDisabled());

    // Click again — should NOT trigger a second API call (guarded state).
    fireEvent.click(btn as any);
    expect(api.resolvePR).toHaveBeenCalledTimes(1);

    // Complete the request — success UI replaces the Resolve control (no stale handle).
    await act(async () => {
      resolveFn({ sessionId: 's', triggered: [], session: { id: 's' } });
    });
    await waitFor(() => {
      expect(screen.getByText('Session started')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /resolve pr/i })).not.toBeInTheDocument();
    });
  });

  it('shows an info toast and does NOT navigate when the PR is clean', async () => {
    (api.resolvePR as any).mockResolvedValue({
      sessionId: null,
      triggered: [],
      reason: 'no-action-needed',
    });
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn as any);

    await waitFor(() => expect(api.resolvePR).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onToast!).toHaveBeenCalledWith(
        'Nothing to resolve — PR looks clean.',
        'info',
        expect.any(Number),
      ),
    );
    expect(onOpenSession!).not.toHaveBeenCalled();
  });

  it('shows an error toast when the API call fails', async () => {
    (api.resolvePR as any).mockRejectedValue(new Error('502: upstream down'));
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn as any);

    await waitFor(() =>
      expect(onToast!).toHaveBeenCalledWith(
        expect.stringMatching(/resolve pr failed: 502: upstream down/i),
        'error',
        expect.any(Number),
      ),
    );
    expect(onOpenSession!).not.toHaveBeenCalled();
  });

  it('disables the button when the project has no agents configured', async () => {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    (api.getProjectPullDetail as any).mockResolvedValue(detailResponse);

    render(
      <PullRequestsPage
        projectId="proj-1"
        project={{ ...project, agents: [] }}
        onOpenSession={vi.fn()}
        onToast={vi.fn()}
      />,
    );

    const title = await screen.findByText('Fix the flaky test');
    fireEvent.click(title as any);

    const btn = await screen.findByRole('button', { name: /resolve pr/i });
    expect(btn!).toBeDisabled();
    expect(btn!).toHaveAttribute('title', 'No agents configured');

    fireEvent.click(btn as any);
    expect(api.resolvePR).not.toHaveBeenCalled();
  });
});

describe('<PullRequestsPage /> — list Resolve PR + Resolve all', () => {
  beforeEach(() => {
    (api.getProjectPulls as any).mockReset();
    (api.getProjectPullDetail as any).mockReset();
    (api.resolvePR as any).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('list row Resolve PR calls the API without navigating to detail', async () => {
    (api.resolvePR as any).mockResolvedValue({
      sessionId: 'sess-list',
      triggered: ['review'],
      session: { id: 'sess-list' },
    });
    const onOpenSession = vi.fn();
    const onToast = vi.fn();
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });

    render(
      <PullRequestsPage
        projectId="proj-1"
        project={project}
        onOpenSession={onOpenSession}
        onToast={onToast}
      />,
    );

    const rowResolve = await screen.findByRole('button', { name: /resolve pr #123/i });
    fireEvent.click(rowResolve as any);

    await waitFor(() => expect(api.resolvePR).toHaveBeenCalledTimes(1));
    expect(api.resolvePR).toHaveBeenCalledWith('proj-1', 123, { agentId: 'agent-alpha' });
    expect(onOpenSession!).not.toHaveBeenCalled();
    expect(api.getProjectPullDetail).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onToast!).toHaveBeenCalledWith(
        expect.stringMatching(/review/i),
        'success',
        expect.any(Number),
      ),
    );
    const openChat = await screen.findByRole('button', { name: /open chat/i });
    fireEvent.click(openChat as any);
    expect(onOpenSession!).toHaveBeenCalledWith('agent-alpha', 'sess-list');
  });

  it('keeps list-row Resolve enabled even when list metadata looks clean', async () => {
    // The button always brings the PR into a session — it is no longer gated on
    // the snapshot showing failing signal, so a "clean" PR can still be resolved.
    const cleanPr = {
      ...prSummary,
      mergeable: true,
      mergeable_state: 'clean',
      check_rollup: [],
    };
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [cleanPr] });

    render(<PullRequestsPage projectId="proj-1" project={project} />);

    const rowResolve = await screen.findByRole('button', { name: /resolve pr #123/i });
    expect(rowResolve!).not.toBeDisabled();
  });

  it('Resolve all runs resolve once per listed PR', async () => {
    const second = { ...prSummary, number: 77, title: 'Other PR' };
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary, second] });
    (api.resolvePR as any).mockResolvedValue({
      sessionId: null,
      triggered: [],
      reason: 'no-action-needed',
    });
    const onToast = vi.fn();

    render(<PullRequestsPage projectId="proj-1" project={project} onToast={onToast} />);

    await screen.findByText('Other PR');
    fireEvent.click(screen.getByRole('button', { name: /resolve all/i } as any) as any);

    await waitFor(() => expect(api.resolvePR).toHaveBeenCalledTimes(2));
    expect(api.resolvePR).toHaveBeenNthCalledWith(1, 'proj-1', 123, { agentId: 'agent-alpha' });
    expect(api.resolvePR).toHaveBeenNthCalledWith(2, 'proj-1', 77, { agentId: 'agent-alpha' });
    await waitFor(() =>
      expect(onToast!).toHaveBeenCalledWith(
        expect.stringMatching(/resolve all finished/i),
        'info',
        expect.any(Number),
      ),
    );
  });
});

describe('<PullRequestsPage /> — PR list row button layout', () => {
  beforeEach(() => {
    (api.getProjectPulls as any).mockReset();
  });

  it('enables Merge when the list reports a clean merge state without mergeable', async () => {
    (api.getProjectPulls as any).mockResolvedValue({
      pulls: [{ ...prSummary, mergeable: null, merge_state_status: 'CLEAN' }],
    });

    render(<PullRequestsPage projectId="proj-1" project={project} />);

    const mergeBtn = await screen.findByRole('button', { name: /merge pr #123/i });
    expect(mergeBtn).not.toBeDisabled();
  });

  it('action buttons in list rows are arranged horizontally (flex-row not flex-col)', async () => {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });

    render(<PullRequestsPage projectId="proj-1" project={project} />);

    await screen.findByText('Fix the flaky test');

    // The Merge and Resolve buttons share a container div.
    // It must use flex-row so buttons sit side-by-side (not stacked vertically).
    const mergeBtn = screen.getByRole('button', { name: /merge pr #123/i });
    const container = mergeBtn.parentElement;

    expect(container!.className).toMatch(/flex-row/);
    expect(container!.className).not.toMatch(/flex-col/);
  });
});

describe('<PullRequestsPage /> — listRefreshNonce (live sync from App)', () => {
  beforeEach(() => {
    (api.getProjectPulls as any).mockReset();
  });

  it('refetches when listRefreshNonce bumps after initial load', async () => {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    const { rerender } = render(
      <PullRequestsPage projectId="proj-1" project={project} listRefreshNonce={0} />,
    );
    await waitFor(() => expect(api.getProjectPulls).toHaveBeenCalledTimes(1));

    rerender(<PullRequestsPage projectId="proj-1" project={project} listRefreshNonce={1} />);
    await waitFor(() => expect(api.getProjectPulls).toHaveBeenCalledTimes(2));
  });
});

describe('<PullRequestsPage /> — recent-pushes banner (hosted projects)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows a banner for a recent push and creates a PR from it', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [] });
    (api.getGitHostRecentPushes as any).mockResolvedValue({
      pushes: [{ branch: 'feature/fast-fix', pushedAt: Date.now() - 60_000 }],
    });
    (api.createNativePr as any).mockResolvedValue({
      prUrl: '/projects/proj-1/pulls/4',
      number: 4,
      created: true,
    });
    (api.getProjectPullDetail as any).mockResolvedValue({
      source: 'agenthub',
      pr: { ...prSummary, number: 4, html_url: '/projects/proj-1/pulls/4' },
      checks: [],
      reviews: [],
      comments: [],
      inline_comments: [],
    });

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} onToast={vi.fn()} />);

    // Banner renders with the branch + create button.
    await screen.findByTestId('recent-push-feature/fast-fix');
    fireEvent.click(screen.getByTestId('recent-push-create-feature/fast-fix' as any) as any);

    // Form prefills a humanized title from the branch name.
    const form = await screen.findByTestId('recent-push-form-feature/fast-fix');
    expect((form.querySelector('input') as any).value).toBe('Fast fix');
    expect(await screen.findByTestId('branch-changes-feature/fast-fix')).toHaveTextContent(
      'File changes',
    );

    fireEvent.click(screen.getByTestId('recent-push-submit-feature/fast-fix' as any) as any);
    await waitFor(() =>
      expect(api.createNativePr).toHaveBeenCalledWith('proj-1', {
        headBranch: 'feature/fast-fix',
        title: 'Fast fix',
        body: '',
      }),
    );
    // Navigates into the new PR's detail.
    await waitFor(() => expect(api.getProjectPullDetail).toHaveBeenCalledWith('proj-1', 4));
  });

  it('does not fetch recent pushes for GitHub-hosted projects', async () => {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    await screen.findByText('Fix the flaky test');
    expect(api.getGitHostRecentPushes).not.toHaveBeenCalled();
  });

  it('hides managed session branches and branches that already have an open PR', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    (api.getProjectPulls as any).mockResolvedValue({
      pulls: [{ ...prSummary, head: 'feature/already-open' }],
    });
    (api.getGitHostRecentPushes as any).mockResolvedValue({
      pushes: [
        { branch: 'agent-hub/dev/session-abc12345', pushedAt: Date.now() - 60_000 },
        { branch: 'feature/already-open', pushedAt: Date.now() - 50_000 },
        { branch: 'feature/manual', pushedAt: Date.now() - 40_000 },
      ],
    });

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} />);

    expect(await screen.findByTestId('recent-push-feature/manual')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-push-agent-hub/dev/session-abc12345')).toBeNull();
    expect(screen.queryByTestId('recent-push-feature/already-open')).toBeNull();
  });
});

describe('<PullRequestsPage /> — New pull request panel (hosted projects)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('picks an existing branch, generates text with AI, and creates the PR', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [] });
    (api.getGitHostRecentPushes as any).mockResolvedValue({ pushes: [] });
    (api.getGitHostBranches as any).mockResolvedValue({
      defaultBranch: 'main',
      branches: [{ name: 'main' }, { name: 'feature/picker' }],
    });
    (api.getNativePrBranchChanges as any).mockResolvedValue({
      headBranch: 'feature/picker',
      baseBranch: 'main',
      stats: { changedFiles: 2, additions: 5, deletions: 1 },
      files: [
        { filename: 'src/picker.jsx', status: 'modified', additions: 4, deletions: 1 },
        { filename: 'src/picker.test.jsx', status: 'added', additions: 1, deletions: 0 },
      ],
      truncated: false,
    });
    (api.generatePrDescription as any).mockResolvedValue({
      title: 'Add the picker',
      body: '## Summary\n- picker',
    });
    (api.createNativePr as any).mockResolvedValue({
      prUrl: '/projects/proj-1/pulls/9',
      number: 9,
      created: true,
    });
    (api.getProjectPullDetail as any).mockResolvedValue({
      source: 'agenthub',
      pr: { ...prSummary, number: 9, html_url: '/projects/proj-1/pulls/9' },
      checks: [],
      reviews: [],
      comments: [],
      inline_comments: [],
    });

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} onToast={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('new-pr-button' as any));
    const select = await screen.findByTestId('new-pr-branch');
    // Default branch excluded from candidates.
    await waitFor(() =>
      expect(select.querySelectorAll('option')).toHaveLength(2 /* placeholder + feature */),
    );
    fireEvent.change(select, { target: { value: 'feature/picker' } } as any);

    expect(await screen.findByTestId('branch-changes-feature/picker')).toHaveTextContent(
      'src/picker.jsx',
    );
    expect(api.getNativePrBranchChanges).toHaveBeenCalledWith('proj-1', 'feature/picker');

    fireEvent.click(screen.getByTestId('new-pr-generate' as any) as any);
    await waitFor(() =>
      expect(api.generatePrDescription).toHaveBeenCalledWith('proj-1', 'feature/picker'),
    );

    fireEvent.click(screen.getByTestId('new-pr-submit' as any) as any);
    await waitFor(() =>
      expect(api.createNativePr).toHaveBeenCalledWith('proj-1', {
        headBranch: 'feature/picker',
        title: 'Add the picker',
        body: '## Summary\n- picker',
      }),
    );
    // Panel closes after creation.
    await waitFor(() => expect(screen.queryByTestId('new-pr-panel')).toBeNull());
  });

  it('does not offer managed session branches or branches with open PRs in the picker', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    (api.getProjectPulls as any).mockResolvedValue({
      pulls: [{ ...prSummary, head: 'feature/already-open' }],
    });
    (api.getGitHostRecentPushes as any).mockResolvedValue({ pushes: [] });
    (api.getGitHostBranches as any).mockResolvedValue({
      defaultBranch: 'main',
      branches: [
        { name: 'main' },
        { name: 'agent-hub/dev/session-abc12345' },
        { name: 'feature/already-open' },
        { name: 'feature/manual' },
      ],
    });

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} />);

    fireEvent.click(await screen.findByTestId('new-pr-button' as any));
    const select = await screen.findByTestId('new-pr-branch');
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2));
    expect(
      [...select.querySelectorAll('option')].map((option: any) => (option as any).value),
    ).toEqual(['', 'feature/manual']);
  });

  it('does not offer branches without file changes in the picker', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [] });
    (api.getGitHostRecentPushes as any).mockResolvedValue({ pushes: [] });
    (api.getGitHostBranches as any).mockResolvedValue({
      defaultBranch: 'main',
      branches: [{ name: 'main' }, { name: 'feature/empty' }, { name: 'feature/manual' }],
    });
    (api.getNativePrBranchChanges as any).mockImplementation(
      async (_projectId: any, branchName: any) => ({
        headBranch: branchName,
        baseBranch: 'main',
        stats:
          branchName === 'feature/manual'
            ? { changedFiles: 1, additions: 2, deletions: 0 }
            : { changedFiles: 0, additions: 0, deletions: 0 },
        files:
          branchName === 'feature/manual'
            ? [{ filename: 'manual.txt', status: 'added', additions: 2, deletions: 0 }]
            : [],
        truncated: false,
      }),
    );

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} />);

    fireEvent.click(await screen.findByTestId('new-pr-button' as any));
    const select = await screen.findByTestId('new-pr-branch');
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2));
    expect(
      [...select.querySelectorAll('option')].map((option: any) => (option as any).value),
    ).toEqual(['', 'feature/manual']);
  });

  it('keeps the picker in loading state while branch prechecks are still running', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [] });
    (api.getGitHostRecentPushes as any).mockResolvedValue({ pushes: [] });
    (api.getGitHostBranches as any).mockResolvedValue({
      defaultBranch: 'main',
      branches: [{ name: 'main' }, { name: 'feature/pending' }],
    });
    (api.getNativePrBranchChanges as any).mockReturnValue(new Promise(() => {}));

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} />);

    fireEvent.click(await screen.findByTestId('new-pr-button' as any));
    const select = await screen.findByTestId('new-pr-branch');
    await waitFor(() => expect(api.getNativePrBranchChanges).toHaveBeenCalled());
    expect(select.querySelector('option')?.textContent).toMatch(/Loading branches/);
    expect(screen.queryByText(/No branches with file changes/i)).toBeNull();
  });

  it('keeps branches selectable when their precheck fails', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [] });
    (api.getGitHostRecentPushes as any).mockResolvedValue({ pushes: [] });
    (api.getGitHostBranches as any).mockResolvedValue({
      defaultBranch: 'main',
      branches: [{ name: 'main' }, { name: 'feature/unknown' }, { name: 'feature/empty' }],
    });
    (api.getNativePrBranchChanges as any).mockImplementation(
      async (_projectId: any, branchName: any) => {
        if (branchName === 'feature/unknown') throw new Error('temporary git failure');
        return {
          headBranch: branchName,
          baseBranch: 'main',
          stats: { changedFiles: 0, additions: 0, deletions: 0 },
          files: [],
          truncated: false,
        };
      },
    );

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} />);

    fireEvent.click(await screen.findByTestId('new-pr-button' as any));
    const select = await screen.findByTestId('new-pr-branch');
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2));
    expect(
      [...select.querySelectorAll('option')].map((option: any) => (option as any).value),
    ).toEqual(['', 'feature/unknown']);
    expect(screen.getByText(/could not be prechecked/i)).toBeInTheDocument();
  });

  it('shows the repo default branch as the PR base, not a hardcoded "main"', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [] });
    (api.getGitHostRecentPushes as any).mockResolvedValue({ pushes: [] });
    let resolveBranches: (value: any) => void = () => {};
    (api.getGitHostBranches as any).mockReturnValue(
      new Promise((resolve) => {
        resolveBranches = resolve;
      }),
    );
    (api.getNativePrBranchChanges as any).mockResolvedValue({
      headBranch: 'feature/x',
      baseBranch: 'master',
      stats: { changedFiles: 1, additions: 1, deletions: 0 },
      files: [{ filename: 'a.txt', status: 'added', additions: 1, deletions: 0 }],
      truncated: false,
    });

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} />);

    fireEvent.click(await screen.findByTestId('new-pr-button' as any));
    const base = await screen.findByTestId('new-pr-base-branch');
    // While branches are still loading we must not claim any concrete branch.
    expect(base.textContent).not.toMatch(/main|master/);
    expect(base).toHaveTextContent('…');

    resolveBranches({
      defaultBranch: 'master',
      branches: [{ name: 'master' }, { name: 'feature/x' }],
    });

    await waitFor(() => expect(base).toHaveTextContent('master'));
    expect(base.textContent).not.toMatch(/main/);
  });

  // Regression: AH-1251 — "Loading branches stays forever".
  // The branch-change scan keyed off `rawCandidates` array identity, which churned
  // on every parent re-render (the unmemoized `openPrHeadBranches` Set was rebuilt
  // each render). A soft refresh re-fetches `pulls` → new array → new Set → new
  // `rawCandidates` → the scan re-fired, resetting every entry to {loading:true} and
  // re-hammering the server, so the picker never left "Loading branches…". The scan
  // must NOT restart when the candidate branch set is unchanged.
  it('does not re-scan branches when the parent re-renders with the same branch set', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    // An open PR on feature/already-open seeds a non-empty excludedBranches Set,
    // the reference-unstable input that drove the loop.
    (api.getProjectPulls as any).mockImplementation(async () => ({
      pulls: [{ ...prSummary, head: 'feature/already-open' }],
    }));
    (api.getGitHostRecentPushes as any).mockResolvedValue({ pushes: [] });
    (api.getGitHostBranches as any).mockResolvedValue({
      defaultBranch: 'main',
      branches: [{ name: 'main' }, { name: 'feature/already-open' }, { name: 'feature/manual' }],
    });
    (api.getNativePrBranchChanges as any).mockResolvedValue({
      headBranch: 'feature/manual',
      baseBranch: 'main',
      stats: { changedFiles: 1, additions: 2, deletions: 0 },
      files: [{ filename: 'manual.txt', status: 'added', additions: 2, deletions: 0 }],
      truncated: false,
    });

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} onToast={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('new-pr-button' as any));
    const select = await screen.findByTestId('new-pr-branch');
    // Scan settles: placeholder flips to "Select a branch…" and the one eligible
    // branch (feature/manual; feature/already-open is excluded) is offered.
    await waitFor(() =>
      expect(select.querySelector('option')?.textContent).toMatch(/Select a branch/),
    );
    expect([...select.querySelectorAll('option')].map((o: any) => o.value)).toEqual([
      '',
      'feature/manual',
    ]);

    const callsAfterInitialScan = (api.getNativePrBranchChanges as any).mock.calls.length;
    expect(callsAfterInitialScan).toBe(1);

    // Soft refresh — re-fetches pulls (new array reference, identical content) and
    // re-renders the parent. Pre-fix this re-fired the scan; now it must be a no-op.
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(api.getProjectPulls).toHaveBeenCalledTimes(2));
    // Give any erroneously-scheduled effect a chance to fire.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect((api.getNativePrBranchChanges as any).mock.calls.length).toBe(callsAfterInitialScan);
    // And the picker stays settled — never falls back to "Loading branches…".
    expect(select.querySelector('option')?.textContent).toMatch(/Select a branch/);
  });
});

describe('<PullRequestsPage /> — PR description markdown', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the PR description as formatted markdown, not raw source', async () => {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    (api.getProjectPullDetail as any).mockResolvedValue({
      ...detailResponse,
      pr: {
        ...detailResponse.pr,
        body: '## Summary\n\n- **Risk**: low\n- see [docs](https://example.com)',
      },
    });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByText('Fix the flaky test' as any));

    const description = await screen.findByTestId('pr-description');
    expect(description.querySelector('h2')).toHaveTextContent('Summary');
    expect(screen.getByText('Risk').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    expect(within(description).queryByText(/## Summary/)).toBeNull();
  });
});

describe('<PullRequestsPage /> — commits in activity log', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders commits inline in the Activity timeline', async () => {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    (api.getProjectPullDetail as any).mockResolvedValue({
      ...detailResponse,
      commits: [
        { sha: 'abc1234def', subject: 'feat: one', author: 'ryan', date: '2026-06-11T00:00:00Z' },
        { sha: 'def5678abc', subject: 'fix: two', author: 'ryan', date: '2026-06-11T01:00:00Z' },
      ],
    });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByText('Fix the flaky test' as any));

    // Commits show directly in the activity feed (no collapse toggle).
    expect(await screen.findByText('feat: one')).toBeInTheDocument();
    expect(screen.getByText('fix: two')).toBeInTheDocument();
    expect(screen.getAllByTestId('pr-activity-commit')).toHaveLength(2);
    // The old collapsed commits section is gone.
    expect(screen.queryByTestId('pr-commits-toggle')).toBeNull();
    // Short SHA is rendered.
    expect(screen.getByText('abc1234d')).toBeInTheDocument();
  });
});

describe('<PullRequestsPage /> — Revert on a merged native PR', () => {
  const mergedNativePr = {
    ...prSummary,
    state: 'closed',
    merged: true,
    merged_at: '2026-04-20T10:00:00Z',
    html_url: '/projects/proj-1/pulls/123',
  };

  async function openMergedDetail(pr: any = mergedNativePr, props: any = {}) {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [pr] });
    (api.getProjectPullDetail as any).mockResolvedValue({
      source: 'agenthub',
      pr,
      checks: [],
      reviews: [],
      comments: [],
    });
    render(<PullRequestsPage projectId="proj-1" project={project} {...props} />);
    fireEvent.click(await screen.findByText('Fix the flaky test' as any));
    return await screen.findByTestId('pr-revert-button').catch(() => null);
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('needs a confirming second click before it calls the API', async () => {
    const onToast = vi.fn();
    (api.revertNativePr as any).mockResolvedValue({ revertSha: 'abc1234def5678' });
    const btn = await openMergedDetail(mergedNativePr, { onToast });

    fireEvent.click(btn as any);
    expect(api.revertNativePr).not.toHaveBeenCalled();
    expect(await screen.findByText(/Revert on main\?/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pr-revert-button') as any);
    await waitFor(() => expect(api.revertNativePr).toHaveBeenCalledWith('proj-1', 123));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        expect.stringMatching(/reverted on main/i),
        'success',
        expect.any(Number),
      ),
    );
  });

  it('surfaces a failed revert as an error toast', async () => {
    const onToast = vi.fn();
    (api.revertNativePr as any).mockRejectedValue(
      new Error('the revert conflicts with changes made after the merge landed'),
    );
    const btn = await openMergedDetail(mergedNativePr, { onToast });

    fireEvent.click(btn as any);
    fireEvent.click(screen.getByTestId('pr-revert-button') as any);

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        expect.stringMatching(/conflicts/i),
        'error',
        expect.any(Number),
      ),
    );
  });

  it('replaces the button with a Reverted marker once the PR carries a revert', async () => {
    await openMergedDetail({
      ...mergedNativePr,
      reverted: true,
      revert_sha: 'f'.repeat(40),
      reverted_by: 'alice',
    });

    expect(await screen.findByTestId('pr-reverted-note')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-revert-button')).toBeNull();
  });

  it('is not offered on an open PR or a GitHub-hosted one', async () => {
    // Open native PR — nothing merged to revert.
    const { unmount } = render(<PullRequestsPage projectId="proj-1" project={project} />);
    unmount();

    (api.getProjectPulls as any).mockResolvedValue({ pulls: [mergedNativePr] });
    (api.getProjectPullDetail as any).mockResolvedValue({
      // No `source: 'agenthub'` → GitHub-hosted, where the Hub can't revert.
      pr: mergedNativePr,
      checks: [],
      reviews: [],
      comments: [],
    });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByText('Fix the flaky test' as any));
    expect(await screen.findByText('Activity')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-revert-button')).toBeNull();
  });
});

describe('<PullRequestsPage /> — Dismiss review', () => {
  const nativeOpenPr = { ...prSummary, html_url: '/projects/proj-1/pulls/123' };

  async function openDetailWithReviews(reviews: any[], props: any = {}) {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [nativeOpenPr] });
    (api.getProjectPullDetail as any).mockResolvedValue({
      source: 'agenthub',
      pr: { ...nativeOpenPr, mergeable: true },
      checks: [],
      reviews,
      comments: [],
      inline_comments: [],
    });
    render(<PullRequestsPage projectId="proj-1" project={project} {...props} />);
    fireEvent.click(await screen.findByText('Fix the flaky test' as any));
    await screen.findByTestId('pr-reviews-list');
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('dismisses a verdict review through the inline reason box', async () => {
    const onToast = vi.fn();
    (api.dismissNativePrReview as any).mockResolvedValue({ review: { id: 'r1', dismissed: true } });
    await openDetailWithReviews(
      [
        {
          id: 'r1',
          user: 'bob',
          state: 'CHANGES_REQUESTED',
          body: 'please fix',
          submitted_at: '2026-04-19T10:00:00Z',
          dismissed: false,
        },
      ],
      { onToast },
    );

    // Reason box is not shown until Dismiss is clicked.
    expect(screen.queryByTestId('pr-review-dismiss-form')).toBeNull();
    fireEvent.click(screen.getByTestId('pr-review-dismiss' as any));

    // Confirm is disabled until a reason is entered (required).
    const confirm = screen.getByTestId('pr-review-dismiss-confirm');
    expect(confirm).toBeDisabled();

    const textarea = within(screen.getByTestId('pr-review-dismiss-form')).getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Stale — fixed later' } } as any);
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm as any);
    await waitFor(() =>
      expect(api.dismissNativePrReview).toHaveBeenCalledWith(
        'proj-1',
        123,
        'r1',
        'Stale — fixed later',
      ),
    );
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('Review dismissed.', 'success', expect.any(Number)),
    );
  });

  it('renders a dismissed review collapsed — body hidden behind a toggle — with its reason and no Dismiss button', async () => {
    await openDetailWithReviews([
      {
        id: 'r2',
        user: 'bob',
        state: 'CHANGES_REQUESTED',
        body: 'the full superseded review body',
        submitted_at: '2026-04-19T10:00:00Z',
        dismissed: true,
        dismissed_by: 'alice',
        dismissal_reason: 'Superseded by a later push',
      },
    ]);

    expect(screen.getByTestId('pr-review-dismissed-badge')).toHaveTextContent('dismissed');
    expect(screen.getByTestId('pr-review-dismissal-reason')).toHaveTextContent(
      'Superseded by a later push',
    );
    expect(screen.getByTestId('pr-review-dismissal-reason')).toHaveTextContent('@alice');
    // A dismissed review cannot be dismissed again.
    expect(screen.queryByTestId('pr-review-dismiss')).toBeNull();

    // Collapsed by default: the original body is NOT rendered until expanded.
    expect(screen.queryByTestId('pr-review-body')).toBeNull();
    fireEvent.click(screen.getByTestId('pr-review-toggle-body' as any));
    expect(screen.getByTestId('pr-review-body')).toHaveTextContent(
      'the full superseded review body',
    );
    // Toggling again re-collapses it.
    fireEvent.click(screen.getByTestId('pr-review-toggle-body' as any));
    expect(screen.queryByTestId('pr-review-body')).toBeNull();
  });

  it('does not offer Dismiss on a comment review (no verdict)', async () => {
    await openDetailWithReviews([
      {
        id: 'r3',
        user: 'bob',
        state: 'COMMENTED',
        body: 'just a note',
        submitted_at: '2026-04-19T10:00:00Z',
        dismissed: false,
      },
    ]);
    expect(screen.queryByTestId('pr-review-dismiss')).toBeNull();
  });
});

describe('<PullRequestsPage /> — pagination', () => {
  function page(numbers: number[], hasMore: boolean) {
    return {
      pulls: numbers.map((n) => ({ ...prSummary, number: n, title: `PR ${n}` })),
      hasMore,
    };
  }

  beforeEach(() => {
    (api.getProjectPulls as any).mockReset();
    (api.getProjectPullDetail as any).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requests page 1 on mount and hides the pager when there is only one page', async () => {
    (api.getProjectPulls as any).mockResolvedValue(page([1, 2], false));

    render(<PullRequestsPage projectId="proj-1" project={project} />);

    expect(await screen.findByText('PR 1')).toBeInTheDocument();
    expect(api.getProjectPulls).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ state: 'open', page: 1 }),
    );
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('pages forward and back, fetching the matching page each time', async () => {
    (api.getProjectPulls as any)
      .mockResolvedValueOnce(page([1, 2], true))
      .mockResolvedValueOnce(page([3, 4], false))
      .mockResolvedValueOnce(page([1, 2], true));

    render(<PullRequestsPage projectId="proj-1" project={project} />);

    const next = await screen.findByRole('button', { name: 'Next' });
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(next);

    expect(await screen.findByText('PR 3')).toBeInTheDocument();
    expect(screen.queryByText('PR 1')).toBeNull();
    expect(screen.getByText('Page 2')).toBeInTheDocument();
    expect(api.getProjectPulls).toHaveBeenLastCalledWith(
      'proj-1',
      expect.objectContaining({ page: 2 }),
    );
    // Last page — nowhere further to go, but Previous is now live.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('PR 1')).toBeInTheDocument();
    expect(api.getProjectPulls).toHaveBeenLastCalledWith(
      'proj-1',
      expect.objectContaining({ page: 1 }),
    );
  });

  it('resets to page 1 when the state tab changes', async () => {
    (api.getProjectPulls as any).mockResolvedValue(page([1, 2], true));

    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Page 2')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Closed' }));

    await waitFor(() =>
      expect(api.getProjectPulls).toHaveBeenLastCalledWith(
        'proj-1',
        expect.objectContaining({ state: 'closed', page: 1 }),
      ),
    );
    expect(screen.getByText('Page 1')).toBeInTheDocument();
  });

  it('keeps the pager usable when a later page fails to load', async () => {
    // The regression: a failed page cleared the list and hid the pager, so a
    // user on page 2+ had no Previous and no way back to page 1.
    (api.getProjectPulls as any)
      .mockResolvedValueOnce(page([1, 2], true))
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValueOnce(page([1, 2], true));

    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));

    expect(await screen.findByText('502 Bad Gateway')).toBeInTheDocument();
    expect(screen.getByText(/Failed to load pull requests \(page 2\)/)).toBeInTheDocument();

    // Pager survives the failure, and Previous is live.
    const previous = screen.getByRole('button', { name: 'Previous' });
    expect(previous).toBeEnabled();

    fireEvent.click(previous);
    expect(await screen.findByText('PR 1')).toBeInTheDocument();
    expect(screen.queryByText('502 Bad Gateway')).toBeNull();
    expect(api.getProjectPulls).toHaveBeenLastCalledWith(
      'proj-1',
      expect.objectContaining({ page: 1 }),
    );
  });

  it('retries the failed page, and offers a jump back to the first page', async () => {
    (api.getProjectPulls as any)
      .mockResolvedValueOnce(page([1, 2], true))
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom again'))
      .mockResolvedValueOnce(page([1, 2], true));

    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByText('boom');

    // Retry re-requests the SAME page, not page 1.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('boom again')).toBeInTheDocument());
    expect(api.getProjectPulls).toHaveBeenLastCalledWith(
      'proj-1',
      expect.objectContaining({ page: 2 }),
    );

    // ...and there is a one-click escape back to the start of the list.
    fireEvent.click(screen.getByRole('button', { name: /first page/i }));
    expect(await screen.findByText('PR 1')).toBeInTheDocument();
    expect(screen.getByText('Page 1')).toBeInTheDocument();
  });

  it('offers a way back when a later page comes up empty', async () => {
    (api.getProjectPulls as any)
      .mockResolvedValueOnce(page([1, 2], true))
      .mockResolvedValueOnce(page([], false))
      .mockResolvedValueOnce(page([1, 2], true));

    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Nothing on page 2')).toBeInTheDocument();
    // Not the generic "no open pull requests" empty state — the project has PRs.
    expect(screen.queryByText(/No open pull requests/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /back to the first page/i }));
    expect(await screen.findByText('PR 1')).toBeInTheDocument();
  });
});

describe('<PullRequestsPage /> — PR deep linking', () => {
  beforeEach(() => {
    (api.getProjectPulls as any).mockReset();
    (api.getProjectPullDetail as any).mockReset();
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary], hasMore: false });
    (api.getProjectPullDetail as any).mockResolvedValue(detailResponse);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens the detail for initialPrNumber without a click', async () => {
    render(<PullRequestsPage projectId="proj-1" project={project} initialPrNumber={123} />);

    expect(await screen.findByRole('button', { name: /resolve pr/i })).toBeInTheDocument();
    expect(api.getProjectPullDetail).toHaveBeenCalledWith('proj-1', 123);
  });

  it('reports the open PR number so the URL can be shared, and clears it on back', async () => {
    const onPrNumberChange = vi.fn();
    render(
      <PullRequestsPage projectId="proj-1" project={project} onPrNumberChange={onPrNumberChange} />,
    );

    fireEvent.click(await screen.findByText('Fix the flaky test'));
    await screen.findByRole('button', { name: /resolve pr/i });
    expect(onPrNumberChange).toHaveBeenCalledWith(123);

    fireEvent.click(screen.getByRole('button', { name: /back to list/i }));
    await waitFor(() => expect(onPrNumberChange).toHaveBeenLastCalledWith(null));
  });

  it('does not re-fetch the detail when the click round-trips back through the URL', async () => {
    const { rerender } = render(
      <PullRequestsPage projectId="proj-1" project={project} initialPrNumber={null} />,
    );

    fireEvent.click(await screen.findByText('Fix the flaky test'));
    await screen.findByRole('button', { name: /resolve pr/i });
    expect(api.getProjectPullDetail).toHaveBeenCalledTimes(1);

    // App echoes the selection back down as a prop (the hash changed).
    rerender(<PullRequestsPage projectId="proj-1" project={project} initialPrNumber={123} />);
    await waitFor(() => expect(api.getProjectPullDetail).toHaveBeenCalledTimes(1));
  });

  it('closes the detail when the PR number leaves the URL (browser Back)', async () => {
    const { rerender } = render(
      <PullRequestsPage projectId="proj-1" project={project} initialPrNumber={123} />,
    );
    await screen.findByRole('button', { name: /resolve pr/i });

    rerender(<PullRequestsPage projectId="proj-1" project={project} initialPrNumber={null} />);

    // Back on the list: the detail-only "Back to list" affordance is gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: /back to list/i })).toBeNull());
    expect(await screen.findByText('Fix the flaky test')).toBeInTheDocument();
  });
});

describe('<PullRequestsPage /> — Request Agent/Human Review buttons', () => {
  beforeEach(() => {
    (api.getProjectPulls as any).mockReset();
    (api.getProjectPullDetail as any).mockReset();
    (api.requestNativePrReview as any).mockReset();
    // Default: the server confirms a reviewer was dispatched.
    (api.requestNativePrReview as any).mockResolvedValue({
      pr: prSummary,
      agent_review_dispatched: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // The buttons only render for open, Agent-Hub-hosted (native) PRs.
  async function openNativeDetail(props: any = {}) {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    (api.getProjectPullDetail as any).mockResolvedValue({
      ...detailResponse,
      source: 'agenthub',
    });
    render(<PullRequestsPage projectId="proj-1" project={project} {...props} />);
    fireEvent.click((await screen.findByText('Fix the flaky test')) as any);
    return await screen.findByTestId('pr-request-agent-review-button');
  }

  it('Request Agent Review dispatches the agent only (kind=agent)', async () => {
    const agentBtn = await openNativeDetail();
    fireEvent.click(agentBtn as any);
    await waitFor(() => expect(api.requestNativePrReview).toHaveBeenCalledTimes(1));
    expect(api.requestNativePrReview).toHaveBeenCalledWith('proj-1', 123, true, 'agent');
  });

  it('agent button latches to a disabled "requested" state, blocking duplicate dispatch', async () => {
    const agentBtn = await openNativeDetail();
    fireEvent.click(agentBtn as any);
    await waitFor(() => expect(api.requestNativePrReview).toHaveBeenCalledTimes(1));

    // The button reflects the persistent requested state and is disabled, so a
    // second click cannot dispatch a duplicate while the review is pending.
    const latched = await screen.findByTestId('pr-request-agent-review-button');
    await waitFor(() => expect(latched).toBeDisabled());
    expect(latched).toHaveTextContent(/agent review requested/i);
    fireEvent.click(latched as any);
    expect(api.requestNativePrReview).toHaveBeenCalledTimes(1);
  });

  it('does NOT latch when the server reports no reviewer was dispatched', async () => {
    // No reviewer agent / unavailable engine → dispatch no-ops. The button must
    // NOT stick in a false "requested" state; the user is told instead.
    (api.requestNativePrReview as any).mockResolvedValue({
      pr: prSummary,
      agent_review_dispatched: false,
    });
    const onToast = vi.fn();
    const agentBtn = await openNativeDetail({ onToast });
    fireEvent.click(agentBtn as any);
    await waitFor(() => expect(api.requestNativePrReview).toHaveBeenCalledTimes(1));

    const btn = await screen.findByTestId('pr-request-agent-review-button');
    await waitFor(() => expect(btn).toBeEnabled());
    expect(btn).toHaveTextContent(/request agent review/i);
    expect(onToast).toHaveBeenCalledWith(
      expect.stringMatching(/no reviewer agent/i),
      'error',
      6000,
    );
  });

  it('latches (does not error) when a review is already in flight', async () => {
    // A concurrent request lost the server-side atomic claim: dispatched=false
    // but a review IS pending, so the button should reflect requested, not error.
    (api.requestNativePrReview as any).mockResolvedValue({
      pr: prSummary,
      agent_review_dispatched: false,
      agent_review_reason: 'already_in_flight',
    });
    const onToast = vi.fn();
    const agentBtn = await openNativeDetail({ onToast });
    fireEvent.click(agentBtn as any);
    await waitFor(() => expect(api.requestNativePrReview).toHaveBeenCalledTimes(1));

    const btn = await screen.findByTestId('pr-request-agent-review-button');
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveTextContent(/agent review requested/i);
    expect(onToast).toHaveBeenCalledWith(
      expect.stringMatching(/already in progress/i),
      'success',
      4000,
    );
  });

  it('initializes the agent button from the server pending flag (survives remount)', async () => {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    (api.getProjectPullDetail as any).mockResolvedValue({
      ...detailResponse,
      source: 'agenthub',
      pr: { ...detailResponse.pr, agent_review_requested: true },
    });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click((await screen.findByText('Fix the flaky test')) as any);

    // No click happened in this component's lifetime, yet the button reflects the
    // durable server-side pending state — the requested state survives a remount.
    const btn = await screen.findByTestId('pr-request-agent-review-button');
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveTextContent(/agent review requested/i);
    fireEvent.click(btn as any);
    expect(api.requestNativePrReview).not.toHaveBeenCalled();
  });

  it('Request Human Review flips the human flag only (kind=human)', async () => {
    await openNativeDetail();
    const humanBtn = await screen.findByTestId('pr-request-review-button');
    fireEvent.click(humanBtn as any);
    await waitFor(() => expect(api.requestNativePrReview).toHaveBeenCalledTimes(1));
    // review_requested is falsy on the summary, so the toggle requests true.
    expect(api.requestNativePrReview).toHaveBeenCalledWith('proj-1', 123, true, 'human');
  });
});

describe('PR-scoped preview panel', () => {
  beforeEach(() => {
    (api.getProjectPulls as any).mockReset();
    (api.getProjectPullDetail as any).mockReset();
    (api.startNativePrPreview as any).mockReset().mockResolvedValue({
      ok: true,
      started: true,
      sessionId: 's1',
    });
    (api.stopNativePrPreview as any).mockReset().mockResolvedValue({
      ok: true,
      stopped: 1,
      sessionId: 's1',
    });
    (api.getNativePrPreviewState as any)
      .mockReset()
      .mockResolvedValue({ sessionId: null, preview: null });
  });

  async function openPreviewDetail(detailOverrides: any = {}) {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    (api.getProjectPullDetail as any).mockResolvedValue({
      ...detailResponse,
      source: 'agenthub',
      preview_available: true,
      ...detailOverrides,
    });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click((await screen.findByText('Fix the flaky test')) as any);
    return await screen.findByTestId('pr-preview-panel');
  }

  it('shows Enable preview and starts the preview on click', async () => {
    await openPreviewDetail();
    const enable = await screen.findByTestId('pr-preview-enable');
    fireEvent.click(enable as any);
    await waitFor(() => expect(api.startNativePrPreview).toHaveBeenCalledTimes(1));
    expect(api.startNativePrPreview).toHaveBeenCalledWith('proj-1', 123, {
      reason: 'PR #123 preview',
    });
    await waitFor(() => expect(api.getNativePrPreviewState).toHaveBeenCalled());
  });

  it('hides the panel entirely when no dev server is configured', async () => {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    (api.getProjectPullDetail as any).mockResolvedValue({
      ...detailResponse,
      source: 'agenthub',
      preview_available: false,
    });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click((await screen.findByText('Fix the flaky test')) as any);
    await screen.findByText(/#123/);
    expect(screen.queryByTestId('pr-preview-panel')).toBeNull();
  });

  it('auto-opens and renders a ready preview link + tear-down when the project defaults previews on', async () => {
    (api.getNativePrPreviewState as any).mockResolvedValue({
      sessionId: 's1',
      preview: { kind: 'preview', fullUrl: 'https://pr-preview.example.com/', logTail: [] },
    });
    await openPreviewDetail({ preview_default_on: true });

    const link = await screen.findByTestId('pr-preview-link');
    expect(link).toHaveAttribute('href', 'https://pr-preview.example.com/');

    const stop = await screen.findByTestId('pr-preview-stop');
    fireEvent.click(stop as any);
    await waitFor(() => expect(api.stopNativePrPreview).toHaveBeenCalledWith('proj-1', 123));
  });

  it('renders the failure reason when the preview fails to boot', async () => {
    (api.getNativePrPreviewState as any).mockResolvedValue({
      sessionId: 's1',
      preview: { kind: 'preview_failed', error: 'npm run dev exited 1', logTail: [] },
    });
    await openPreviewDetail({ preview_default_on: true });
    const err = await screen.findByTestId('pr-preview-error');
    expect(err).toHaveTextContent('npm run dev exited 1');
  });

  it('reflects an already-running preview on open — default OFF, no click, no restart', async () => {
    // The visibility bug: revisiting a PR with a live preview used to show idle
    // because state was only fetched after expanding. Now it hydrates on open.
    (api.getNativePrPreviewState as any).mockResolvedValue({
      sessionId: 's1',
      preview: { kind: 'preview', fullUrl: 'https://pr-preview.example.com/', logTail: [] },
    });
    await openPreviewDetail(); // preview_default_on omitted → false

    const link = await screen.findByTestId('pr-preview-link');
    expect(link).toHaveAttribute('href', 'https://pr-preview.example.com/');
    // No idle "Enable" affordance, and we never (re)started it.
    expect(screen.queryByTestId('pr-preview-enable')).toBeNull();
    expect(api.startNativePrPreview).not.toHaveBeenCalled();
  });

  it('reflects an already-failed preview on open without clicking (default OFF)', async () => {
    (api.getNativePrPreviewState as any).mockResolvedValue({
      sessionId: 's1',
      preview: { kind: 'preview_failed', error: 'boot crashed', logTail: [] },
    });
    await openPreviewDetail();
    expect(await screen.findByTestId('pr-preview-error')).toHaveTextContent('boot crashed');
    expect(api.startNativePrPreview).not.toHaveBeenCalled();
  });

  it('auto-starts once when the project defaults previews on and none is running', async () => {
    // Hydrate returns idle (no preview) → default-on auto-starts one.
    (api.getNativePrPreviewState as any).mockResolvedValue({ sessionId: null, preview: null });
    await openPreviewDetail({ preview_default_on: true });
    await waitFor(() => expect(api.startNativePrPreview).toHaveBeenCalledTimes(1));
    expect(api.startNativePrPreview).toHaveBeenCalledWith('proj-1', 123, {
      reason: 'PR #123 preview',
    });
  });

  it('shows an archived note instead of Enable when no live session backs the PR', async () => {
    await openPreviewDetail({ preview_session_available: false });
    // The panel still renders (dev server IS configured), but the clickable
    // Enable control is replaced by an explanatory note — clicking it used to
    // 409 with "No live session worktree is associated with this pull request".
    expect(await screen.findByTestId('pr-preview-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('pr-preview-enable')).toBeNull();
    expect(api.startNativePrPreview).not.toHaveBeenCalled();
  });

  it('does NOT auto-start when default-on but the owning session is archived', async () => {
    (api.getNativePrPreviewState as any).mockResolvedValue({ sessionId: null, preview: null });
    await openPreviewDetail({ preview_default_on: true, preview_session_available: false });
    await screen.findByTestId('pr-preview-unavailable');
    expect(api.startNativePrPreview).not.toHaveBeenCalled();
  });

  it('does NOT auto-start when default-on but a preview is already running', async () => {
    (api.getNativePrPreviewState as any).mockResolvedValue({
      sessionId: 's1',
      preview: { kind: 'preview', fullUrl: 'https://x/', logTail: [] },
    });
    await openPreviewDetail({ preview_default_on: true });
    await screen.findByTestId('pr-preview-link');
    expect(api.startNativePrPreview).not.toHaveBeenCalled();
  });

  it('hides the panel (no fetch, no auto-start) for a merged PR even with default-on', async () => {
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prSummary] });
    (api.getProjectPullDetail as any).mockResolvedValue({
      ...detailResponse,
      source: 'agenthub',
      preview_available: true,
      preview_default_on: true,
      pr: { ...prSummary, state: 'closed', merged_at: '2026-04-20T00:00:00Z' },
    });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click((await screen.findByText('Fix the flaky test')) as any);
    await screen.findByText(/#123/);
    expect(screen.queryByTestId('pr-preview-panel')).toBeNull();
    expect(api.getNativePrPreviewState).not.toHaveBeenCalled();
    expect(api.startNativePrPreview).not.toHaveBeenCalled();
  });

  it('discards a stale preview-state response after switching PRs', async () => {
    const prA = { ...prSummary, number: 123 };
    const prB = { ...prSummary, number: 456 };
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prA, prB] });
    (api.getProjectPullDetail as any).mockImplementation(async (_pid: any, n: any) => ({
      ...detailResponse,
      source: 'agenthub',
      preview_available: true,
      pr: { ...(n === 123 ? prA : prB), mergeable: true },
    }));

    // PR 123's state request stays pending until we resolve it late, with a
    // FAILURE — which must be ignored because we've moved to PR 456 by then.
    let resolveA: (v: any) => void = () => {};
    const deferredA = new Promise((r) => {
      resolveA = r;
    });
    (api.getNativePrPreviewState as any).mockImplementation((_pid: any, n: any) =>
      n === 123
        ? deferredA
        : Promise.resolve({
            sessionId: 'sB',
            preview: { kind: 'preview', fullUrl: 'https://B/', logTail: [] },
          }),
    );

    const { rerender } = render(
      <PullRequestsPage projectId="proj-1" project={project} initialPrNumber={123} />,
    );
    await screen.findByTestId('pr-preview-panel'); // PR 123 open; state request pending

    // Switch to PR 456 — its ready snapshot renders the link.
    rerender(<PullRequestsPage projectId="proj-1" project={project} initialPrNumber={456} />);
    const link = await screen.findByTestId('pr-preview-link');
    expect(link).toHaveAttribute('href', 'https://B/');

    // Now PR 123's stale response lands — it must NOT paint a failure on 456.
    await act(async () => {
      resolveA({
        sessionId: 'sA',
        preview: { kind: 'preview_failed', error: 'PR 123 failed', logTail: [] },
      });
      await Promise.resolve();
    });

    expect(screen.queryByTestId('pr-preview-error')).toBeNull();
    expect(screen.getByTestId('pr-preview-link')).toHaveAttribute('href', 'https://B/');
  });

  it('suppresses a start-failure toast for a PR the user already navigated away from', async () => {
    const prA = { ...prSummary, number: 123 };
    const prB = { ...prSummary, number: 456 };
    (api.getProjectPulls as any).mockResolvedValue({ pulls: [prA, prB] });
    (api.getProjectPullDetail as any).mockImplementation(async (_pid: any, n: any) => ({
      ...detailResponse,
      source: 'agenthub',
      preview_available: true,
      pr: { ...(n === 123 ? prA : prB), mergeable: true },
    }));
    (api.getNativePrPreviewState as any).mockResolvedValue({ sessionId: null, preview: null });

    // PR 123's start REJECTS late — after we've moved to PR 456.
    let rejectA: (e: any) => void = () => {};
    const startA = new Promise((_res, rej) => {
      rejectA = rej;
    });
    (api.startNativePrPreview as any).mockImplementation((_pid: any, n: any) =>
      n === 123 ? startA : Promise.resolve({ ok: true, started: true }),
    );

    const onToast = vi.fn();
    const { rerender } = render(
      <PullRequestsPage
        projectId="proj-1"
        project={project}
        initialPrNumber={123}
        onToast={onToast}
      />,
    );
    // Kick off PR 123's start.
    fireEvent.click(await screen.findByTestId('pr-preview-enable'));
    await waitFor(() =>
      expect(api.startNativePrPreview).toHaveBeenCalledWith('proj-1', 123, expect.anything()),
    );

    // Navigate to PR 456 before 123's start settles.
    rerender(
      <PullRequestsPage
        projectId="proj-1"
        project={project}
        initialPrNumber={456}
        onToast={onToast}
      />,
    );
    await screen.findByTestId('pr-preview-enable'); // PR 456 panel is live

    // 123's start now fails — its toast must be suppressed (stale PR).
    await act(async () => {
      rejectA(new Error('PR 123 start blew up'));
      await Promise.resolve();
    });

    expect(onToast).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to start preview'),
      'error',
    );
  });
});
