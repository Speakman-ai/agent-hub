import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
import SessionSummarySidebar from './SessionSummarySidebar';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getSessionSummary: vi.fn(),
    getProjectPullDetail: vi.fn(),
  },
}));

describe('<SessionSummarySidebar /> — linked PR', () => {
  beforeEach(() => {
    (api.getSessionSummary as any).mockReset();
    (api.getProjectPullDetail as any).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not call getProjectPullDetail when linked github.com URL targets another repo', async () => {
    (api.getSessionSummary as any).mockResolvedValue({
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
    let resolveSummary: any;
    const summaryPromise = new Promise((resolve: any) => {
      resolveSummary = resolve;
    });
    (api.getSessionSummary as any).mockReturnValue(summaryPromise);

    render(<SessionSummarySidebar sessionId="sess-pending" isLive={false} />);

    fireEvent.click(screen.getByTestId('session-summary-toggle' as any) as any);
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
    (api.getSessionSummary as any).mockResolvedValue({
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
    (api.getProjectPullDetail as any).mockResolvedValue({
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
    expect(statusPill!).toHaveTextContent('Merged');

    fireEvent.click(screen.getByTestId('session-summary-toggle' as any) as any);
    fireEvent.click(screen.getByTestId('session-linked-pr' as any) as any);
    expect(onOpenPrDetail!).toHaveBeenCalledWith('proj-1', 13);
  });

  it('shows Pending review for open PRs awaiting review', async () => {
    (api.getSessionSummary as any).mockResolvedValue({
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
    (api.getProjectPullDetail as any).mockResolvedValue({
      pr: { title: 'Twelfth PR', state: 'open', merged_at: null },
      reviews: [],
    });

    render(<SessionSummarySidebar sessionId="sess-status" isLive={false} />);

    await waitFor(() => expect(api.getProjectPullDetail).toHaveBeenCalled());
    const statusPill = await screen.findByTestId('linked-pr-status-pill-collapsed');
    expect(statusPill!).toHaveTextContent('Pending review');
  });

  it('shows the latest finalize PR in the linked PR section when the card has no PR URL', async () => {
    (api.getSessionSummary as any).mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: null,
      finalizePrUrl: 'https://github.com/acme/widgets/pull/1240',
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'Finalize session' },
      skills: [],
    });
    (api.getProjectPullDetail as any).mockResolvedValue({
      pr: { title: 'Show diff fallback correctly', state: 'open', merged_at: null },
      reviews: [],
    });

    render(<SessionSummarySidebar sessionId="sess-finalize-pr" isLive={false} />);

    await waitFor(() => {
      expect(api.getProjectPullDetail).toHaveBeenCalledWith('proj-1', 1240);
    });

    fireEvent.click(screen.getByTestId('session-summary-toggle' as any) as any);
    expect(await screen.findByTestId('session-linked-pr')).toHaveTextContent('PR #1240');
    expect(screen.getByText('Show diff fallback correctly')).toBeInTheDocument();
    expect(screen.queryByText(/No PR linked/i)).toBeNull();
  });

  it('renders each loaded skill once even when the server returns duplicate invocations', async () => {
    (api.getSessionSummary as any).mockResolvedValue({
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
    fireEvent.click(screen.getByTestId('session-summary-toggle' as any) as any);
    await waitFor(() => {
      expect(screen.getAllByText('kanban')).toHaveLength(1);
    });
    expect(screen.getAllByText('wiki-search')).toHaveLength(1);
  });
});

describe('<SessionSummarySidebar /> — finalize strip removal', () => {
  beforeEach(() => {
    (api.getSessionSummary as any).mockReset();
    (api.getProjectPullDetail as any).mockReset();
    (api.getProjectPullDetail as any).mockResolvedValue({
      pr: { title: 'PR', state: 'open', merged_at: null },
      reviews: [],
    });
  });

  it('does not mount ChecksPanel when session has linked PR', async () => {
    (api.getSessionSummary as any).mockResolvedValue({
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

    fireEvent.click(screen.getByTestId('session-summary-toggle' as any) as any);
    expect(screen.queryByTestId('finalize-checks-panel')).toBeNull();
    expect(screen.getByTestId('session-linked-pr')).toBeInTheDocument();
  });

  it('does not show finalize phase pill in collapsed header', async () => {
    (api.getSessionSummary as any).mockResolvedValue({
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

describe('<SessionSummarySidebar /> — linked ticket', () => {
  beforeEach(() => {
    (api.getSessionSummary as any).mockReset();
    (api.getProjectPullDetail as any).mockReset();
    (api.getProjectPullDetail as any).mockResolvedValue({
      pr: { title: 'PR', state: 'open', merged_at: null },
      reviews: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the linked ticket title and column next to the PR and opens the board on click', async () => {
    const onOpenCard = vi.fn();
    (api.getSessionSummary as any).mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: {
        id: 'card-42',
        title: 'Persist user filters across list pages',
        pr_url: 'https://github.com/acme/widgets/pull/12',
        review_status: null,
        columnName: 'In Progress',
      },
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'x' },
      skills: [],
    });

    render(
      <SessionSummarySidebar sessionId="sess-ticket" isLive={false} onOpenCard={onOpenCard} />,
    );
    await waitFor(() => expect(api.getSessionSummary).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('session-summary-toggle' as any) as any);

    const ticket = await screen.findByTestId('session-linked-ticket');
    expect(ticket!).toHaveTextContent('Persist user filters across list pages');
    expect(screen.getByTestId('linked-ticket-column-pill')).toHaveTextContent('In Progress');

    fireEvent.click(ticket as any);
    expect(onOpenCard!).toHaveBeenCalledWith('proj-1', 'card-42');
  });

  it('shows the ticket even when the card has no PR linked', async () => {
    (api.getSessionSummary as any).mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: {
        id: 'card-7',
        title: 'No PR yet',
        pr_url: null,
        review_status: null,
        columnName: 'To Do',
      },
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'x' },
      skills: [],
    });

    render(<SessionSummarySidebar sessionId="sess-ticket-nopr" isLive={false} />);
    await waitFor(() => expect(api.getSessionSummary).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('session-summary-toggle' as any) as any);
    expect(await screen.findByTestId('session-linked-ticket')).toHaveTextContent('No PR yet');
  });

  it('does not render the ticket section when no card is linked', async () => {
    (api.getSessionSummary as any).mockResolvedValue({
      projectId: 'proj-1',
      projectGithubRepo: 'acme/widgets',
      linkedCard: null,
      sessionTitlePrUrl: null,
      session: { id: 's1', name: 'x' },
      skills: [],
    });

    render(<SessionSummarySidebar sessionId="sess-ticket-none" isLive={false} />);
    await waitFor(() => expect(api.getSessionSummary).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('session-summary-toggle' as any) as any);
    await waitFor(() =>
      expect(screen.queryByTestId('session-summary-loading')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('session-linked-ticket')).toBeNull();
  });
});
