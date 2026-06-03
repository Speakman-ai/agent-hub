import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
import SessionSummarySidebar from './SessionSummarySidebar.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getSessionSummary: vi.fn(),
    getProjectPullDetail: vi.fn(),
  },
}));

describe('<SessionSummarySidebar /> — linked PR', () => {
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
      skills: [],
    });

    render(<SessionSummarySidebar sessionId="sess-1" isLive={false} />);

    await waitFor(() => expect(api.getSessionSummary).toHaveBeenCalledWith('sess-1'));
    expect(api.getProjectPullDetail).not.toHaveBeenCalled();
  });

  it('shows a loading placeholder until the first summary fetch resolves', async () => {
    let resolveSummary;
    const summaryPromise = new Promise((resolve) => {
      resolveSummary = resolve;
    });
    api.getSessionSummary.mockReturnValue(summaryPromise);

    render(<SessionSummarySidebar sessionId="sess-pending" isLive={false} />);

    fireEvent.click(screen.getByTestId('session-summary-toggle'));
    expect(screen.getByTestId('session-summary-loading')).toBeInTheDocument();

    resolveSummary({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: null,
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'Loaded' },
      skills: [],
    });

    await waitFor(() => {
      expect(screen.queryByTestId('session-summary-loading')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('Loaded')).toBeInTheDocument();
  });

  it('shows Merged status and opens PR detail when the PR box is clicked', async () => {
    const onOpenPrDetail = vi.fn();
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
      skills: [],
    });
    api.getProjectPullDetail.mockResolvedValue({
      pr: {
        title: 'Merged PR',
        state: 'closed',
        merged_at: '2026-05-01T12:00:00Z',
      },
      reviews: [],
    });

    render(
      <SessionSummarySidebar
        sessionId="sess-merged"
        isLive={false}
        onOpenPrDetail={onOpenPrDetail}
      />,
    );

    await waitFor(() => expect(api.getProjectPullDetail).toHaveBeenCalled());

    const statusPill = await screen.findByTestId('linked-pr-status-pill-collapsed');
    expect(statusPill).toHaveTextContent('Merged');

    fireEvent.click(screen.getByTestId('session-summary-toggle'));
    fireEvent.click(screen.getByTestId('session-linked-pr'));
    expect(onOpenPrDetail).toHaveBeenCalledWith('proj-1', 13);
  });

  it('shows Pending review for open PRs awaiting review', async () => {
    api.getSessionSummary.mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: {
        id: 'c1',
        title: 'Card',
        pr_url: 'https://github.com/acme/widgets/pull/12',
        review_status: 'awaiting_review',
        columnName: 'Review',
      },
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'x' },
      skills: [],
    });
    api.getProjectPullDetail.mockResolvedValue({
      pr: { title: 'Twelfth PR', state: 'open', merged_at: null },
      reviews: [],
    });

    render(<SessionSummarySidebar sessionId="sess-status" isLive={false} />);

    await waitFor(() => expect(api.getProjectPullDetail).toHaveBeenCalled());
    const statusPill = await screen.findByTestId('linked-pr-status-pill-collapsed');
    expect(statusPill).toHaveTextContent('Pending review');
  });

  it('renders each loaded skill once even when the server returns duplicate invocations', async () => {
    api.getSessionSummary.mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: null,
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'x' },
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
    await waitFor(() => {
      expect(screen.getByText('2 skills')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('session-summary-toggle'));
    await waitFor(() => {
      expect(screen.getAllByText('kanban')).toHaveLength(1);
    });
    expect(screen.getAllByText('wiki-search')).toHaveLength(1);
  });
});

describe('<SessionSummarySidebar /> — finalize strip removal', () => {
  beforeEach(() => {
    api.getSessionSummary.mockReset();
    api.getProjectPullDetail.mockReset();
    api.getProjectPullDetail.mockResolvedValue({
      pr: { title: 'PR', state: 'open', merged_at: null },
      reviews: [],
    });
  });

  it('does not mount ChecksPanel when session has linked PR', async () => {
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
      session: { id: 'sess-fin', name: 'Finalize session' },
      skills: [],
    });

    render(<SessionSummarySidebar sessionId="sess-fin" isLive={false} />);
    await waitFor(() => expect(api.getSessionSummary).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('session-summary-toggle'));
    expect(screen.queryByTestId('finalize-checks-panel')).toBeNull();
    expect(screen.getByTestId('session-linked-pr')).toBeInTheDocument();
  });

  it('does not show finalize phase pill in collapsed header', async () => {
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
      skills: [],
    });

    render(<SessionSummarySidebar sessionId="sess-collapsed" isLive={false} />);
    await waitFor(() => expect(api.getSessionSummary).toHaveBeenCalled());
    expect(screen.queryByTestId('finalize-phase-pill-collapsed')).toBeNull();
  });
});
