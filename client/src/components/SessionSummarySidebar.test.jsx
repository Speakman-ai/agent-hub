import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import SessionSummarySidebar from './SessionSummarySidebar.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getSessionSummary: vi.fn(),
    getProjectPullDetail: vi.fn(),
  },
}));

const emptyRun = { toolCalls: 0, files: [], retries: 0, warnings: 0, toolErrors: 0 };

describe('<SessionSummarySidebar /> — project PR detail fetch', () => {
  beforeEach(() => {
    api.getSessionSummary.mockReset();
    api.getProjectPullDetail.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not call getProjectPullDetail when linked github.com URL targets another repo', async () => {
    api.getSessionSummary.mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: null,
      sessionTitlePrUrl: 'https://github.com/other/repo/pull/99',
      session: { id: 's1', name: 'Review: PR #1 …' },
      runSnapshot: emptyRun,
      skills: [],
    });
    api.getProjectPullDetail.mockResolvedValue({ pr: { title: 'wrong' } });

    render(<SessionSummarySidebar sessionId="sess-1" isLive={false} />);

    await waitFor(() => expect(api.getSessionSummary).toHaveBeenCalledWith('sess-1'));
    expect(api.getProjectPullDetail).not.toHaveBeenCalled();
  });

  it('does not fetch detail when linked card pr_url targets a different repo than the project', async () => {
    api.getSessionSummary.mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: {
        id: 'c1',
        title: 'Cross',
        pr_url: 'https://github.com/other/repo/pull/1',
        review_status: null,
        columnName: 'Review',
      },
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'x' },
      runSnapshot: emptyRun,
      skills: [],
    });

    render(<SessionSummarySidebar sessionId="sess-cross" isLive={false} />);

    await waitFor(() => expect(api.getSessionSummary).toHaveBeenCalled());
    expect(api.getProjectPullDetail).not.toHaveBeenCalled();
  });

  it('shows a loading placeholder until the first summary fetch resolves', async () => {
    let resolveSummary;
    const summaryPromise = new Promise((resolve) => {
      resolveSummary = resolve;
    });
    api.getSessionSummary.mockReturnValue(summaryPromise);

    render(<SessionSummarySidebar sessionId="sess-pending" isLive={false} />);

    expect(screen.getByTestId('session-summary-loading')).toBeInTheDocument();

    resolveSummary({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: null,
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'Loaded' },
      runSnapshot: emptyRun,
      skills: [],
    });

    await waitFor(() => {
      expect(screen.queryByTestId('session-summary-loading')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('Loaded')).toBeInTheDocument();
  });

  it('calls getProjectPullDetail when PR URL matches projectGithubRepo', async () => {
    api.getSessionSummary.mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: {
        id: 'c1',
        title: 'Card',
        pr_url: 'https://github.com/Acme/Widgets/pull/7',
        review_status: null,
        columnName: 'Review',
      },
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'x' },
      runSnapshot: emptyRun,
      skills: [],
    });
    api.getProjectPullDetail.mockResolvedValue({
      pr: { title: 'Seventh PR', head: 'f', base: 'main' },
      checks: [],
      reviews: [],
      comments: [],
    });

    render(<SessionSummarySidebar sessionId="sess-2" isLive={false} />);

    await waitFor(() => expect(api.getProjectPullDetail).toHaveBeenCalledWith('proj-1', 7));
  });

  it('renders the PR-state pill and aggregate checks rollup pill from PR detail', async () => {
    api.getSessionSummary.mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: {
        id: 'c1',
        title: 'Card',
        pr_url: 'https://github.com/acme/widgets/pull/12',
        review_status: null,
        columnName: 'Review',
      },
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'x' },
      runSnapshot: emptyRun,
      skills: [],
    });
    api.getProjectPullDetail.mockResolvedValue({
      repo: 'acme/widgets',
      source: 'rest',
      pr: {
        title: 'Twelfth PR',
        head: 'feature/x',
        base: 'main',
        state: 'open',
        draft: false,
        merged_at: null,
      },
      reviews: [],
      comments: [],
      checks: [
        { name: 'lint', status: 'completed', conclusion: 'success' },
        { name: 'unit', status: 'completed', conclusion: 'failure' },
        { name: 'e2e', status: 'in_progress', conclusion: null },
      ],
    });

    render(<SessionSummarySidebar sessionId="sess-status" isLive={false} />);

    await waitFor(() => expect(api.getProjectPullDetail).toHaveBeenCalled());

    const statePill = await screen.findByTestId('pr-state-pill');
    expect(statePill).toHaveTextContent('open');

    // failure precedes pending in summarizeChecks → label is "X/Y failing"
    const checksPill = await screen.findByTestId('checks-rollup-pill');
    expect(checksPill).toHaveTextContent('1/3 failing');
  });

  it('shows the merged label when the PR has been merged', async () => {
    api.getSessionSummary.mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: {
        id: 'c1',
        title: 'Card',
        pr_url: 'https://github.com/acme/widgets/pull/13',
        review_status: null,
        columnName: 'Done',
      },
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'x' },
      runSnapshot: emptyRun,
      skills: [],
    });
    api.getProjectPullDetail.mockResolvedValue({
      repo: 'acme/widgets',
      source: 'rest',
      pr: {
        title: 'Merged PR',
        state: 'closed',
        merged_at: '2026-05-01T12:00:00Z',
      },
      reviews: [],
      comments: [],
      checks: [],
    });

    render(<SessionSummarySidebar sessionId="sess-merged" isLive={false} />);

    await waitFor(() => expect(api.getProjectPullDetail).toHaveBeenCalled());
    const statePill = await screen.findByTestId('pr-state-pill');
    expect(statePill).toHaveTextContent('merged');
    expect(screen.queryByTestId('checks-rollup-pill')).not.toBeInTheDocument();
  });

  it('renders each loaded skill once even when the server returns duplicate invocations', async () => {
    api.getSessionSummary.mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: null,
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'x' },
      runSnapshot: emptyRun,
      skills: [
        {
          id: '1',
          skillId: 'kanban',
          status: 'loaded',
          source: 'project',
          injectedBytes: 4096,
          createdAt: '2026-04-21T17:00:00Z',
        },
        {
          id: '2',
          skillId: 'kanban',
          status: 'loaded',
          source: 'project',
          injectedBytes: 4096,
          createdAt: '2026-04-21T17:05:00Z',
        },
        {
          id: '3',
          skillId: 'wiki-search',
          status: 'loaded',
          source: 'default',
          injectedBytes: 2048,
          createdAt: '2026-04-21T17:02:00Z',
        },
      ],
    });

    render(<SessionSummarySidebar sessionId="sess-dup" isLive={false} />);

    await waitFor(() => expect(api.getSessionSummary).toHaveBeenCalledWith('sess-dup'));
    // Each distinct skill renders exactly one chip.
    await waitFor(() => {
      expect(screen.getAllByText('kanban')).toHaveLength(1);
    });
    expect(screen.getAllByText('wiki-search')).toHaveLength(1);
  });
});
