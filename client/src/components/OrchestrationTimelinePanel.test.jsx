import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import OrchestrationTimelinePanel from './OrchestrationTimelinePanel.jsx';

// Mock the api module so we don't hit the real server
vi.mock('../utils/api.js', () => ({
  api: {
    getSessionSummary: vi.fn(),
    getProjectPullDetail: vi.fn(),
  },
}));

import { api } from '../utils/api.js';

const makeEntry = (id, summary, kind = 'progress') => ({
  id,
  ts: 1_700_000_000_000,
  kind,
  summary,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('OrchestrationTimelinePanel', () => {
  it('renders nothing when entries are empty and no PR data', () => {
    const { container } = render(<OrchestrationTimelinePanel entries={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders timeline header and events', () => {
    const entries = [makeEntry('e1', 'Step started'), makeEntry('e2', 'Step done')];
    render(<OrchestrationTimelinePanel entries={entries} />);
    expect(screen.getByText('Orchestration timeline')).toBeInTheDocument();
    expect(screen.getByText('Step started')).toBeInTheDocument();
    expect(screen.getByText('Step done')).toBeInTheDocument();
  });

  it('shows event count in header', () => {
    const entries = [makeEntry('a', 'A'), makeEntry('b', 'B'), makeEntry('c', 'C')];
    render(<OrchestrationTimelinePanel entries={entries} />);
    expect(screen.getByText('3 events')).toBeInTheDocument();
  });

  it('compact mode omits outer max-width wrapper', () => {
    const entries = [makeEntry('e1', 'Event')];
    const { container } = render(<OrchestrationTimelinePanel entries={entries} compact />);
    // compact skips the outer <div className="px-3 md:px-0 mb-3 max-w-[95%]…"> wrapper.
    // In compact mode there is no element with the max-w-[95%] or mb-3 class that
    // acts as the outer positioning shell.
    expect(container.querySelector('[class*="max-w-\\[95"]')).toBeNull();
  });

  it('fetches session summary and shows PR review when sessionId provided', async () => {
    api.getSessionSummary.mockResolvedValue({
      linkedCard: {
        pr_url: 'https://github.com/org/repo/pull/42',
        review_status: 'approved',
        title: 'My feature PR',
      },
      sessionTitlePrUrl: null,
      projectId: 'proj-1',
      projectGithubRepo: 'org/repo',
    });
    api.getProjectPullDetail.mockResolvedValue({
      pr: { title: 'My feature PR', state: 'open', head: 'feature/foo', base: 'main' },
      checks: [{ name: 'CI / test', status: 'completed', conclusion: 'success' }],
    });

    const entries = [makeEntry('e1', 'Phase started', 'phase')];
    render(<OrchestrationTimelinePanel entries={entries} sessionId="session-abc" />);

    // PR link and review badge appear after async fetch
    await waitFor(() => {
      expect(screen.getByText(/#42/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Approved/i)).toBeInTheDocument();
    expect(api.getSessionSummary).toHaveBeenCalledWith('session-abc');
    expect(api.getProjectPullDetail).toHaveBeenCalledWith('proj-1', 42);
  });

  it('shows no PR section when session has no linked PR', async () => {
    api.getSessionSummary.mockResolvedValue({
      linkedCard: null,
      sessionTitlePrUrl: null,
      projectId: 'proj-1',
    });

    const entries = [makeEntry('e1', 'Some step')];
    render(<OrchestrationTimelinePanel entries={entries} sessionId="session-xyz" />);

    // Wait a tick for async effect to complete
    await waitFor(() => {
      expect(api.getSessionSummary).toHaveBeenCalledOnce();
    });
    expect(screen.queryByText(/Open on GitHub/i)).toBeNull();
  });

  it('shows failing checks in compact check list', async () => {
    api.getSessionSummary.mockResolvedValue({
      linkedCard: { pr_url: 'https://github.com/org/repo/pull/7', review_status: null },
      sessionTitlePrUrl: null,
      projectId: 'proj-1',
      projectGithubRepo: 'org/repo',
    });
    api.getProjectPullDetail.mockResolvedValue({
      pr: { title: 'Bugfix', state: 'open', head: 'fix/bug', base: 'main' },
      checks: [
        { name: 'CI / lint', status: 'completed', conclusion: 'failure' },
        { name: 'CI / test', status: 'in_progress', conclusion: null },
      ],
    });

    const entries = [makeEntry('e1', 'Phase acting', 'phase')];
    render(<OrchestrationTimelinePanel entries={entries} sessionId="sess-fail" />);

    await waitFor(() => {
      expect(screen.getByText('CI / lint')).toBeInTheDocument();
    });
    expect(screen.getByText('CI / test')).toBeInTheDocument();
  });

  it('does not call getProjectPullDetail when PR repo differs from project repo', async () => {
    // linkedCard.pr_url is for "other-org/other-repo" but projectGithubRepo is "org/repo"
    api.getSessionSummary.mockResolvedValue({
      linkedCard: {
        pr_url: 'https://github.com/other-org/other-repo/pull/99',
        review_status: 'awaiting_review',
        title: 'Cross-repo PR',
      },
      sessionTitlePrUrl: null,
      projectId: 'proj-1',
      projectGithubRepo: 'org/repo',
    });
    api.getProjectPullDetail.mockResolvedValue({});

    const entries = [makeEntry('e1', 'Step', 'phase')];
    render(<OrchestrationTimelinePanel entries={entries} sessionId="sess-cross" />);

    await waitFor(() => {
      expect(api.getSessionSummary).toHaveBeenCalledWith('sess-cross');
    });
    // PR link should still render (we show basic info without checks)
    await waitFor(() => {
      expect(screen.getByText(/#99/)).toBeInTheDocument();
    });
    // But getProjectPullDetail must NOT be called — wrong repo
    expect(api.getProjectPullDetail).not.toHaveBeenCalled();
  });
});
