import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import PullRequestsPage, { mapWithConcurrency } from './PullRequestsPage.jsx';
import { api } from '../utils/api.js';

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

vi.mock('../utils/api.js', () => ({
  api: {
    getProjectPulls: vi.fn(),
    getProjectPullDetail: vi.fn(),
    resolvePR: vi.fn(),
    getPrDiffText: vi.fn(async () => 'diff --git a/x.txt b/x.txt\n+x'),
    updateNativePr: vi.fn(),
    getGitHostRecentPushes: vi.fn(async () => ({ pushes: [] })),
    getGitHostBranches: vi.fn(async () => ({ defaultBranch: 'main', branches: [] })),
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
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return value * 2;
    });

    expect(result).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

async function renderAndOpenDetail(props = {}) {
  api.getProjectPulls.mockResolvedValue({ pulls: [prSummary] });
  api.getProjectPullDetail.mockResolvedValue(detailResponse);

  render(<PullRequestsPage projectId="proj-1" project={project} {...props} />);

  // Wait for the list to load, then click into the detail view.
  const title = await screen.findByText('Fix the flaky test');
  fireEvent.click(title);

  // Wait for the detail view to render (Resolve PR button present).
  return await screen.findByRole('button', { name: /resolve pr/i });
}

describe('<PullRequestsPage /> — Resolve PR button', () => {
  beforeEach(() => {
    api.getProjectPulls.mockReset();
    api.getProjectPullDetail.mockReset();
    api.resolvePR.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls api.resolvePR with the first agent id on click', async () => {
    api.resolvePR.mockResolvedValue({
      sessionId: 'sess-99',
      triggered: ['ci'],
      session: { id: 'sess-99' },
    });
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn);

    await waitFor(() => expect(api.resolvePR).toHaveBeenCalledTimes(1));
    expect(api.resolvePR).toHaveBeenCalledWith('proj-1', 123, {
      agentId: 'agent-alpha',
    });

    expect(onOpenSession).not.toHaveBeenCalled();
    // Success toast mentions the triggered kinds
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        expect.stringMatching(/ci/i),
        'success',
        expect.any(Number),
      ),
    );
    const openChat = await screen.findByRole('button', { name: /open chat/i });
    fireEvent.click(openChat);
    expect(onOpenSession).toHaveBeenCalledWith('agent-alpha', 'sess-99');
  });

  it('shows the Activity timeline on the PR detail view', async () => {
    await renderAndOpenDetail();
    expect(await screen.findByText('Activity')).toBeTruthy();
    expect(screen.getByText(/Chronological history from GitHub/i)).toBeTruthy();
  });

  it('disables the button while the request is in flight', async () => {
    let resolveFn;
    api.resolvePR.mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn);

    // While the request is pending the button must be disabled.
    await waitFor(() => expect(btn).toBeDisabled());

    // Click again — should NOT trigger a second API call (guarded state).
    fireEvent.click(btn);
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
    api.resolvePR.mockResolvedValue({
      sessionId: null,
      triggered: [],
      reason: 'no-action-needed',
    });
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn);

    await waitFor(() => expect(api.resolvePR).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        'Nothing to resolve — PR looks clean.',
        'info',
        expect.any(Number),
      ),
    );
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('shows an error toast when the API call fails', async () => {
    api.resolvePR.mockRejectedValue(new Error('502: upstream down'));
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        expect.stringMatching(/resolve pr failed: 502: upstream down/i),
        'error',
        expect.any(Number),
      ),
    );
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('disables the button when the project has no agents configured', async () => {
    api.getProjectPulls.mockResolvedValue({ pulls: [prSummary] });
    api.getProjectPullDetail.mockResolvedValue(detailResponse);

    render(
      <PullRequestsPage
        projectId="proj-1"
        project={{ ...project, agents: [] }}
        onOpenSession={vi.fn()}
        onToast={vi.fn()}
      />,
    );

    const title = await screen.findByText('Fix the flaky test');
    fireEvent.click(title);

    const btn = await screen.findByRole('button', { name: /resolve pr/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'No agents configured');

    fireEvent.click(btn);
    expect(api.resolvePR).not.toHaveBeenCalled();
  });
});

describe('<PullRequestsPage /> — list Resolve PR + Resolve all', () => {
  beforeEach(() => {
    api.getProjectPulls.mockReset();
    api.getProjectPullDetail.mockReset();
    api.resolvePR.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('list row Resolve PR calls the API without navigating to detail', async () => {
    api.resolvePR.mockResolvedValue({
      sessionId: 'sess-list',
      triggered: ['review'],
      session: { id: 'sess-list' },
    });
    const onOpenSession = vi.fn();
    const onToast = vi.fn();
    api.getProjectPulls.mockResolvedValue({ pulls: [prSummary] });

    render(
      <PullRequestsPage
        projectId="proj-1"
        project={project}
        onOpenSession={onOpenSession}
        onToast={onToast}
      />,
    );

    const rowResolve = await screen.findByRole('button', { name: /resolve pr #123/i });
    fireEvent.click(rowResolve);

    await waitFor(() => expect(api.resolvePR).toHaveBeenCalledTimes(1));
    expect(api.resolvePR).toHaveBeenCalledWith('proj-1', 123, { agentId: 'agent-alpha' });
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(api.getProjectPullDetail).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        expect.stringMatching(/review/i),
        'success',
        expect.any(Number),
      ),
    );
    const openChat = await screen.findByRole('button', { name: /open chat/i });
    fireEvent.click(openChat);
    expect(onOpenSession).toHaveBeenCalledWith('agent-alpha', 'sess-list');
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
    api.getProjectPulls.mockResolvedValue({ pulls: [cleanPr] });

    render(<PullRequestsPage projectId="proj-1" project={project} />);

    const rowResolve = await screen.findByRole('button', { name: /resolve pr #123/i });
    expect(rowResolve).not.toBeDisabled();
  });

  it('Resolve all runs resolve once per listed PR', async () => {
    const second = { ...prSummary, number: 77, title: 'Other PR' };
    api.getProjectPulls.mockResolvedValue({ pulls: [prSummary, second] });
    api.resolvePR.mockResolvedValue({
      sessionId: null,
      triggered: [],
      reason: 'no-action-needed',
    });
    const onToast = vi.fn();

    render(<PullRequestsPage projectId="proj-1" project={project} onToast={onToast} />);

    await screen.findByText('Other PR');
    fireEvent.click(screen.getByRole('button', { name: /resolve all/i }));

    await waitFor(() => expect(api.resolvePR).toHaveBeenCalledTimes(2));
    expect(api.resolvePR).toHaveBeenNthCalledWith(1, 'proj-1', 123, { agentId: 'agent-alpha' });
    expect(api.resolvePR).toHaveBeenNthCalledWith(2, 'proj-1', 77, { agentId: 'agent-alpha' });
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        expect.stringMatching(/resolve all finished/i),
        'info',
        expect.any(Number),
      ),
    );
  });
});

describe('<PullRequestsPage /> — PR list row button layout', () => {
  beforeEach(() => {
    api.getProjectPulls.mockReset();
  });

  it('action buttons in list rows are arranged horizontally (flex-row not flex-col)', async () => {
    api.getProjectPulls.mockResolvedValue({ pulls: [prSummary] });

    render(<PullRequestsPage projectId="proj-1" project={project} />);

    await screen.findByText('Fix the flaky test');

    // The Merge and Resolve buttons share a container div.
    // It must use flex-row so buttons sit side-by-side (not stacked vertically).
    const mergeBtn = screen.getByRole('button', { name: /merge pr #123/i });
    const container = mergeBtn.parentElement;

    expect(container.className).toMatch(/flex-row/);
    expect(container.className).not.toMatch(/flex-col/);
  });
});

describe('<PullRequestsPage /> — listRefreshNonce (live sync from App)', () => {
  beforeEach(() => {
    api.getProjectPulls.mockReset();
  });

  it('refetches when listRefreshNonce bumps after initial load', async () => {
    api.getProjectPulls.mockResolvedValue({ pulls: [prSummary] });
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
    api.getProjectPulls.mockResolvedValue({ pulls: [] });
    api.getGitHostRecentPushes.mockResolvedValue({
      pushes: [{ branch: 'feature/fast-fix', pushedAt: Date.now() - 60_000 }],
    });
    api.createNativePr.mockResolvedValue({
      prUrl: '/projects/proj-1/pulls/4',
      number: 4,
      created: true,
    });
    api.getProjectPullDetail.mockResolvedValue({
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
    fireEvent.click(screen.getByTestId('recent-push-create-feature/fast-fix'));

    // Form prefills a humanized title from the branch name.
    const form = await screen.findByTestId('recent-push-form-feature/fast-fix');
    expect(form.querySelector('input').value).toBe('Fast fix');
    expect(await screen.findByTestId('branch-changes-feature/fast-fix')).toHaveTextContent(
      'File changes',
    );

    fireEvent.click(screen.getByTestId('recent-push-submit-feature/fast-fix'));
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
    api.getProjectPulls.mockResolvedValue({ pulls: [prSummary] });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    await screen.findByText('Fix the flaky test');
    expect(api.getGitHostRecentPushes).not.toHaveBeenCalled();
  });

  it('hides managed session branches and branches that already have an open PR', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    api.getProjectPulls.mockResolvedValue({
      pulls: [{ ...prSummary, head: 'feature/already-open' }],
    });
    api.getGitHostRecentPushes.mockResolvedValue({
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
    api.getProjectPulls.mockResolvedValue({ pulls: [] });
    api.getGitHostRecentPushes.mockResolvedValue({ pushes: [] });
    api.getGitHostBranches.mockResolvedValue({
      defaultBranch: 'main',
      branches: [{ name: 'main' }, { name: 'feature/picker' }],
    });
    api.getNativePrBranchChanges.mockResolvedValue({
      headBranch: 'feature/picker',
      baseBranch: 'main',
      stats: { changedFiles: 2, additions: 5, deletions: 1 },
      files: [
        { filename: 'src/picker.jsx', status: 'modified', additions: 4, deletions: 1 },
        { filename: 'src/picker.test.jsx', status: 'added', additions: 1, deletions: 0 },
      ],
      truncated: false,
    });
    api.generatePrDescription.mockResolvedValue({
      title: 'Add the picker',
      body: '## Summary\n- picker',
    });
    api.createNativePr.mockResolvedValue({
      prUrl: '/projects/proj-1/pulls/9',
      number: 9,
      created: true,
    });
    api.getProjectPullDetail.mockResolvedValue({
      source: 'agenthub',
      pr: { ...prSummary, number: 9, html_url: '/projects/proj-1/pulls/9' },
      checks: [],
      reviews: [],
      comments: [],
      inline_comments: [],
    });

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} onToast={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('new-pr-button'));
    const select = await screen.findByTestId('new-pr-branch');
    // Default branch excluded from candidates.
    await waitFor(() =>
      expect(select.querySelectorAll('option')).toHaveLength(2 /* placeholder + feature */),
    );
    fireEvent.change(select, { target: { value: 'feature/picker' } });

    expect(await screen.findByTestId('branch-changes-feature/picker')).toHaveTextContent(
      'src/picker.jsx',
    );
    expect(api.getNativePrBranchChanges).toHaveBeenCalledWith('proj-1', 'feature/picker');

    fireEvent.click(screen.getByTestId('new-pr-generate'));
    await waitFor(() =>
      expect(api.generatePrDescription).toHaveBeenCalledWith('proj-1', 'feature/picker'),
    );

    fireEvent.click(screen.getByTestId('new-pr-submit'));
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
    api.getProjectPulls.mockResolvedValue({
      pulls: [{ ...prSummary, head: 'feature/already-open' }],
    });
    api.getGitHostRecentPushes.mockResolvedValue({ pushes: [] });
    api.getGitHostBranches.mockResolvedValue({
      defaultBranch: 'main',
      branches: [
        { name: 'main' },
        { name: 'agent-hub/dev/session-abc12345' },
        { name: 'feature/already-open' },
        { name: 'feature/manual' },
      ],
    });

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} />);

    fireEvent.click(await screen.findByTestId('new-pr-button'));
    const select = await screen.findByTestId('new-pr-branch');
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2));
    expect([...select.querySelectorAll('option')].map((option) => option.value)).toEqual([
      '',
      'feature/manual',
    ]);
  });

  it('does not offer branches without file changes in the picker', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    api.getProjectPulls.mockResolvedValue({ pulls: [] });
    api.getGitHostRecentPushes.mockResolvedValue({ pushes: [] });
    api.getGitHostBranches.mockResolvedValue({
      defaultBranch: 'main',
      branches: [{ name: 'main' }, { name: 'feature/empty' }, { name: 'feature/manual' }],
    });
    api.getNativePrBranchChanges.mockImplementation(async (_projectId, branchName) => ({
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
    }));

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} />);

    fireEvent.click(await screen.findByTestId('new-pr-button'));
    const select = await screen.findByTestId('new-pr-branch');
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2));
    expect([...select.querySelectorAll('option')].map((option) => option.value)).toEqual([
      '',
      'feature/manual',
    ]);
  });

  it('keeps the picker in loading state while branch prechecks are still running', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    api.getProjectPulls.mockResolvedValue({ pulls: [] });
    api.getGitHostRecentPushes.mockResolvedValue({ pushes: [] });
    api.getGitHostBranches.mockResolvedValue({
      defaultBranch: 'main',
      branches: [{ name: 'main' }, { name: 'feature/pending' }],
    });
    api.getNativePrBranchChanges.mockReturnValue(new Promise(() => {}));

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} />);

    fireEvent.click(await screen.findByTestId('new-pr-button'));
    const select = await screen.findByTestId('new-pr-branch');
    await waitFor(() => expect(api.getNativePrBranchChanges).toHaveBeenCalled());
    expect(select.querySelector('option')?.textContent).toMatch(/Loading branches/);
    expect(screen.queryByText(/No branches with file changes/i)).toBeNull();
  });

  it('keeps branches selectable when their precheck fails', async () => {
    const hostedProject = { ...project, gitHost: 'agenthub' };
    api.getProjectPulls.mockResolvedValue({ pulls: [] });
    api.getGitHostRecentPushes.mockResolvedValue({ pushes: [] });
    api.getGitHostBranches.mockResolvedValue({
      defaultBranch: 'main',
      branches: [{ name: 'main' }, { name: 'feature/unknown' }, { name: 'feature/empty' }],
    });
    api.getNativePrBranchChanges.mockImplementation(async (_projectId, branchName) => {
      if (branchName === 'feature/unknown') throw new Error('temporary git failure');
      return {
        headBranch: branchName,
        baseBranch: 'main',
        stats: { changedFiles: 0, additions: 0, deletions: 0 },
        files: [],
        truncated: false,
      };
    });

    render(<PullRequestsPage projectId="proj-1" project={hostedProject} />);

    fireEvent.click(await screen.findByTestId('new-pr-button'));
    const select = await screen.findByTestId('new-pr-branch');
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2));
    expect([...select.querySelectorAll('option')].map((option) => option.value)).toEqual([
      '',
      'feature/unknown',
    ]);
    expect(screen.getByText(/could not be prechecked/i)).toBeInTheDocument();
  });
});

describe('<PullRequestsPage /> — commits section', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders commits collapsed by default at the end of the detail page', async () => {
    api.getProjectPulls.mockResolvedValue({ pulls: [prSummary] });
    api.getProjectPullDetail.mockResolvedValue({
      ...detailResponse,
      commits: [
        { sha: 'abc1234def', subject: 'feat: one', author: 'ryan', date: '2026-06-11T00:00:00Z' },
        { sha: 'def5678abc', subject: 'fix: two', author: 'ryan', date: '2026-06-11T01:00:00Z' },
      ],
    });
    render(<PullRequestsPage projectId="proj-1" project={project} />);
    fireEvent.click(await screen.findByText('Fix the flaky test'));

    const toggle = await screen.findByTestId('pr-commits-toggle');
    expect(toggle).toHaveTextContent('Commits (2)');
    // Collapsed: no commit rows visible yet.
    expect(screen.queryByText('feat: one')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByText('feat: one')).toBeInTheDocument();
    expect(screen.getByText('fix: two')).toBeInTheDocument();
  });
});
