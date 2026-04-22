import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
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
});
