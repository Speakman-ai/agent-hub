import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import IssuesView from './IssuesView';
import { api } from '../../utils/api';

vi.mock('../../utils/api', () => ({
  api: {
    listLogIssues: vi.fn(),
    getLogIssue: vi.fn(),
    resolveLogIssue: vi.fn(),
    ignoreLogIssue: vi.fn(),
    reopenLogIssue: vi.fn(),
    analyzeLogIssue: vi.fn(),
    fixLogIssue: vi.fn(),
    bulkSetLogIssueStatus: vi.fn(),
  },
}));

const openIssue = {
  id: 'iss-1',
  projectId: 'p1',
  fingerprint: 'abcdef0123456789',
  title: 'TypeError: cannot read property x of undefined',
  service: 'checkout',
  environment: 'prod',
  exceptionType: 'TypeError',
  messageTemplate: 'cannot read property x',
  // Epoch nanoseconds, matching what the server stores/serializes.
  firstSeen: 1_700_000_000_000_000_000,
  lastSeen: 1_700_000_500_000_000_000,
  eventCount: 42,
  status: 'open' as const,
  statusUpdatedAt: null,
  statusUpdatedBy: null,
  analyzeSessionId: null,
  fixSessionId: null,
  fixCardId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('IssuesView', () => {
  it('renders an empty state when there are no issues', async () => {
    (api.listLogIssues as any).mockResolvedValue({ issues: [], nextCursor: null });
    render(<IssuesView projectId="p1" />);
    expect(await screen.findByText(/No open error issues/i)).toBeInTheDocument();
  });

  it('renders an error state when the list request fails', async () => {
    (api.listLogIssues as any).mockRejectedValue(new Error('500: boom'));
    render(<IssuesView projectId="p1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('500: boom');
  });

  it('lists issues and expands to detail with releases and samples', async () => {
    (api.listLogIssues as any).mockResolvedValue({ issues: [openIssue], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({
      ...openIssue,
      releases: [
        { release: '1.4.0', commitSha: 'deadbeefcafe', firstSeen: 1, lastSeen: 2, eventCount: 40 },
      ],
      samples: [
        {
          id: 501,
          projectId: 'p1',
          sourceId: 'src',
          timeUnixNano: 1_700_000_000_000_000,
          observedTimeUnixNano: null,
          severityNumber: 17,
          severityText: 'ERROR',
          body: 'boom happened',
          serviceName: 'checkout',
          environment: 'prod',
          traceId: 't-1',
          spanId: 's-1',
          fingerprint: 'abcdef0123456789',
          resourceJson: null,
          attributesJson: null,
          scopeJson: null,
          byteSize: 20,
          ingestedAt: 0,
        },
      ],
    });

    render(<IssuesView projectId="p1" />);
    const title = await screen.findByText(/cannot read property x of undefined/i);
    fireEvent.click(title);

    expect(await screen.findByText('1.4.0')).toBeInTheDocument();
    expect(await screen.findByText('boom happened')).toBeInTheDocument();
    expect(api.getLogIssue).toHaveBeenCalledWith('p1', 'iss-1');
  });

  it('renders the real age of an issue instead of collapsing to "just now"', async () => {
    // Regression: `lastSeen` is epoch nanoseconds. Feeding it straight to a
    // Date formatter produced an Invalid Date, so every row read "just now"
    // regardless of age.
    const nowMs = Date.now();
    const firstSeenMs = nowMs - 90 * 60_000;
    const staleIssue = {
      ...openIssue,
      firstSeen: firstSeenMs * 1e6,
      lastSeen: (nowMs - 30 * 60_000) * 1e6,
    };
    (api.listLogIssues as any).mockResolvedValue({ issues: [staleIssue], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...staleIssue, releases: [], samples: [] });

    render(<IssuesView projectId="p1" />);
    expect(await screen.findByText('last 30m ago')).toBeInTheDocument();
    expect(screen.queryByText(/just now/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/cannot read property x of undefined/i));
    expect(await screen.findByText(new Date(firstSeenMs).toLocaleString())).toBeInTheDocument();
  });

  it('omits the last-seen label when the timestamp is unusable', async () => {
    (api.listLogIssues as any).mockResolvedValue({
      issues: [{ ...openIssue, lastSeen: 0 }],
      nextCursor: null,
    });
    render(<IssuesView projectId="p1" />);
    await screen.findByText(/cannot read property x of undefined/i);
    expect(screen.queryByText(/^last /)).not.toBeInTheDocument();
  });

  it('drops the First/Last seen detail terms when the timestamps are unusable', async () => {
    // A label with a blank value beside it reads as a rendering bug, and an
    // epoch-zero or "Invalid Date" stand-in would be worse — so the whole term
    // goes. 500_000 ns underflows to 0 ms; 1e22 ns overflows the Date range.
    const undated = { ...openIssue, firstSeen: 500_000, lastSeen: 1e22 };
    (api.listLogIssues as any).mockResolvedValue({ issues: [undated], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...undated, releases: [], samples: [] });

    render(<IssuesView projectId="p1" />);
    fireEvent.click(await screen.findByText(/cannot read property x of undefined/i));

    // Detail is open (a sibling term renders), but the undated ones are gone.
    expect(await screen.findByText('Fingerprint')).toBeInTheDocument();
    expect(screen.queryByText('First seen')).not.toBeInTheDocument();
    expect(screen.queryByText('Last seen')).not.toBeInTheDocument();
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  it('drives the resolve lifecycle transition and updates status', async () => {
    (api.listLogIssues as any).mockResolvedValue({ issues: [openIssue], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...openIssue, releases: [], samples: [] });
    (api.resolveLogIssue as any).mockResolvedValue({ ...openIssue, status: 'resolved' });
    const showToast = vi.fn();

    render(<IssuesView projectId="p1" showToast={showToast} />);
    fireEvent.click(await screen.findByText(/cannot read property x of undefined/i));
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));

    await waitFor(() => expect(api.resolveLogIssue).toHaveBeenCalledWith('p1', 'iss-1'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Issue resolved', 'success'));
    // The row badge now reflects the resolved state.
    await waitFor(() => expect(screen.getAllByText('resolved').length).toBeGreaterThan(0));
  });

  describe('batch triage', () => {
    const secondIssue = {
      ...openIssue,
      id: 'iss-2',
      title: 'RangeError: index out of range',
      messageTemplate: 'index out of range',
      exceptionType: 'RangeError',
    };

    it('batch-resolves the selected issues and drops them from the Open tab', async () => {
      (api.listLogIssues as any).mockResolvedValue({
        issues: [openIssue, secondIssue],
        nextCursor: null,
      });
      (api.bulkSetLogIssueStatus as any).mockResolvedValue({
        updated: [
          { ...openIssue, status: 'resolved' },
          { ...secondIssue, status: 'resolved' },
        ],
        notFound: [],
      });
      const showToast = vi.fn();

      render(<IssuesView projectId="p1" showToast={showToast} />);
      fireEvent.click(await screen.findByLabelText('Select all issues'));
      expect(screen.getByText('2 selected')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Resolve selected/ }));

      await waitFor(() =>
        expect(api.bulkSetLogIssueStatus).toHaveBeenCalledWith(
          'p1',
          ['iss-1', 'iss-2'],
          'resolved',
        ),
      );
      await waitFor(() => expect(showToast).toHaveBeenCalledWith('2 issues resolved', 'success'));
      expect(await screen.findByText(/No open error issues/i)).toBeInTheDocument();
    });

    it('sends only the ticked rows and reports stale ids in the toast', async () => {
      (api.listLogIssues as any).mockResolvedValue({
        issues: [openIssue, secondIssue],
        nextCursor: null,
      });
      (api.bulkSetLogIssueStatus as any).mockResolvedValue({
        updated: [{ ...secondIssue, status: 'ignored' }],
        notFound: ['iss-1'],
      });
      const showToast = vi.fn();

      render(<IssuesView projectId="p1" showToast={showToast} />);
      fireEvent.click(await screen.findByLabelText('Select RangeError: index out of range'));
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Ignore selected/ }));

      await waitFor(() =>
        expect(api.bulkSetLogIssueStatus).toHaveBeenCalledWith('p1', ['iss-2'], 'ignored'),
      );
      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          '1 issue ignored · 1 no longer available',
          'success',
        ),
      );
      // The untouched row stays on the tab; the ignored one leaves it.
      expect(screen.getByText(/cannot read property x of undefined/i)).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.queryByText(/index out of range/i)).not.toBeInTheDocument(),
      );
    });

    it('keeps a row ticked while the batch is in flight instead of clearing it', async () => {
      // Regression: completion used to reset the whole selection, silently
      // dropping rows ticked mid-request that were never part of the batch.
      let resolveBulk: (value: unknown) => void = () => {};
      (api.listLogIssues as any).mockResolvedValue({
        issues: [openIssue, secondIssue],
        nextCursor: null,
      });
      (api.bulkSetLogIssueStatus as any).mockReturnValue(
        new Promise((resolve) => (resolveBulk = resolve)),
      );

      render(<IssuesView projectId="p1" />);
      fireEvent.click(
        await screen.findByLabelText('Select TypeError: cannot read property x of undefined'),
      );
      fireEvent.click(screen.getByRole('button', { name: /Resolve selected/ }));
      // Only the first row was submitted; tick the second one mid-request.
      expect(api.bulkSetLogIssueStatus).toHaveBeenCalledWith('p1', ['iss-1'], 'resolved');
      fireEvent.click(screen.getByLabelText('Select RangeError: index out of range'));

      await act(async () =>
        resolveBulk({ updated: [{ ...openIssue, status: 'resolved' }], notFound: [] }),
      );

      expect(screen.getByText('1 selected')).toBeInTheDocument();
      expect(screen.getByLabelText('Select RangeError: index out of range')).toBeChecked();
    });

    it('offers no Resolve button when every selected issue is already resolved', async () => {
      const resolved = { ...openIssue, status: 'resolved' as const };
      (api.listLogIssues as any).mockResolvedValue({ issues: [resolved], nextCursor: null });

      render(<IssuesView projectId="p1" />);
      fireEvent.click(await screen.findByLabelText('Select all issues'));

      expect(screen.queryByRole('button', { name: /Resolve selected/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Reopen selected/ })).toBeInTheDocument();
    });

    it('surfaces a failed batch without clearing the selection', async () => {
      (api.listLogIssues as any).mockResolvedValue({ issues: [openIssue], nextCursor: null });
      (api.bulkSetLogIssueStatus as any).mockRejectedValue(new Error('500: boom'));
      const showToast = vi.fn();

      render(<IssuesView projectId="p1" showToast={showToast} />);
      fireEvent.click(await screen.findByLabelText('Select all issues'));
      fireEvent.click(screen.getByRole('button', { name: /Resolve selected/ }));

      await waitFor(() => expect(showToast).toHaveBeenCalledWith('500: boom', 'error'));
      expect(screen.getByText('1 selected')).toBeInTheDocument();
    });
  });

  it('starts Analyze and opens the linked normal chat session', async () => {
    (api.listLogIssues as any).mockResolvedValue({ issues: [openIssue], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...openIssue, releases: [], samples: [] });
    (api.analyzeLogIssue as any).mockResolvedValue({
      sessionId: 'session-analyze-1',
      agentId: 'agent-lead',
      reused: false,
      issue: { ...openIssue, analyzeSessionId: 'session-analyze-1' },
    });
    const onOpenSession = vi.fn();

    render(<IssuesView projectId="p1" onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByText(/cannot read property x of undefined/i));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));

    await waitFor(() => expect(api.analyzeLogIssue).toHaveBeenCalledWith('p1', 'iss-1'));
    expect(onOpenSession).toHaveBeenCalledWith({
      sessionId: 'session-analyze-1',
      agentId: 'agent-lead',
    });
  });

  it('reopens a resolved issue', async () => {
    const resolved = { ...openIssue, status: 'resolved' as const };
    (api.listLogIssues as any).mockResolvedValue({ issues: [resolved], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...resolved, releases: [], samples: [] });
    (api.reopenLogIssue as any).mockResolvedValue({ ...resolved, status: 'open' });
    const showToast = vi.fn();

    render(<IssuesView projectId="p1" showToast={showToast} />);
    fireEvent.click(await screen.findByText(/cannot read property x of undefined/i));
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }));

    await waitFor(() => expect(api.reopenLogIssue).toHaveBeenCalledWith('p1', 'iss-1'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Issue open', 'success'));
  });

  it('starts the tracked Fix workflow and opens its session', async () => {
    (api.listLogIssues as any).mockResolvedValue({ issues: [openIssue], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...openIssue, releases: [], samples: [] });
    (api.fixLogIssue as any).mockResolvedValue({
      cardId: 'card-fix-1',
      sessionId: 'session-fix-1',
      agentId: 'agent-dev',
      reused: false,
      issue: { ...openIssue, fixCardId: 'card-fix-1', fixSessionId: 'session-fix-1' },
    });
    const onOpenSession = vi.fn();

    render(<IssuesView projectId="p1" onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByText(/cannot read property x of undefined/i));
    fireEvent.click(screen.getByRole('button', { name: 'Fix' }));

    await waitFor(() => expect(api.fixLogIssue).toHaveBeenCalledWith('p1', 'iss-1'));
    expect(onOpenSession).toHaveBeenCalledWith({
      sessionId: 'session-fix-1',
      agentId: 'agent-dev',
    });
  });

  it('does not issue duplicate requests while an action is in flight', async () => {
    let resolveAction: (value: unknown) => void = () => {};
    (api.listLogIssues as any).mockResolvedValue({ issues: [openIssue], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...openIssue, releases: [], samples: [] });
    (api.analyzeLogIssue as any).mockReturnValue(
      new Promise((resolve) => (resolveAction = resolve)),
    );

    render(<IssuesView projectId="p1" />);
    fireEvent.click(await screen.findByText(/cannot read property x of undefined/i));
    const analyze = screen.getByRole('button', { name: 'Analyze' });
    fireEvent.click(analyze);
    fireEvent.click(analyze);

    expect(api.analyzeLogIssue).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Starting Analyze…')).toBeInTheDocument();
    await act(async () => resolveAction({ ...openIssue, analyzeSessionId: 's1' }));
  });

  it('shows a failed action and allows retry recovery', async () => {
    (api.listLogIssues as any).mockResolvedValue({ issues: [openIssue], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...openIssue, releases: [], samples: [] });
    (api.analyzeLogIssue as any)
      .mockRejectedValueOnce(new Error('agent unavailable'))
      .mockResolvedValueOnce({
        sessionId: 'session-retry',
        agentId: 'agent-lead',
        reused: false,
        issue: { ...openIssue, analyzeSessionId: 'session-retry' },
      });
    const toast = vi.fn();

    render(<IssuesView projectId="p1" showToast={toast} />);
    fireEvent.click(await screen.findByText(/cannot read property x of undefined/i));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Analyze failed: agent unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(api.analyzeLogIssue).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Analyze completed/)).toBeInTheDocument();
  });

  it('uses the explicit start-another path while retaining canonical reopen', async () => {
    const linked = { ...openIssue, analyzeSessionId: 'canonical-session' };
    (api.listLogIssues as any).mockResolvedValue({ issues: [linked], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...linked, releases: [], samples: [] });
    (api.analyzeLogIssue as any).mockResolvedValue({
      sessionId: 'second-session',
      agentId: 'agent-lead',
      reused: false,
      issue: { ...linked, analyzeSessionId: 'second-session' },
    });

    render(<IssuesView projectId="p1" />);
    fireEvent.click(await screen.findByText(/cannot read property x of undefined/i));
    fireEvent.click(screen.getByRole('button', { name: 'Start another analysis' }));

    await waitFor(() =>
      expect(api.analyzeLogIssue).toHaveBeenCalledWith('p1', 'iss-1', { startAnother: true }),
    );
  });

  it('reconciles a completed WebSocket action into the linked state', async () => {
    (api.listLogIssues as any).mockResolvedValue({ issues: [openIssue], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...openIssue, releases: [], samples: [] });
    render(<IssuesView projectId="p1" />);
    fireEvent.click(await screen.findByText(/cannot read property x of undefined/i));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('agenthub:log_issue_action', {
          detail: {
            type: 'log_issue_action',
            projectId: 'p1',
            issueId: 'iss-1',
            action: 'fix',
            status: 'completed',
            sessionId: 'fix-ws-session',
            cardId: 'fix-ws-card',
          },
        }),
      );
    });

    expect(await screen.findByText(/Fix completed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open fix' })).toBeInTheDocument();
  });

  it('reconciles a remote start-another workflow over an existing canonical link', async () => {
    const linked = { ...openIssue, fixSessionId: 'old-session', fixCardId: 'old-card' };
    (api.listLogIssues as any).mockResolvedValue({ issues: [linked], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...linked, releases: [], samples: [] });
    render(<IssuesView projectId="p1" />);
    fireEvent.click(await screen.findByText(/cannot read property x of undefined/i));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('agenthub:log_issue_action', {
          detail: {
            type: 'log_issue_action',
            projectId: 'p1',
            issueId: 'iss-1',
            action: 'fix',
            status: 'in_flight',
            sessionId: 'new-session',
            cardId: 'new-card',
          },
        }),
      );
    });
    expect(await screen.findByText('Starting Fix…')).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('agenthub:log_issue_action', {
          detail: {
            type: 'log_issue_action',
            projectId: 'p1',
            issueId: 'iss-1',
            action: 'fix',
            status: 'completed',
            sessionId: 'old-session',
            cardId: 'old-card',
          },
        }),
      );
    });
    expect(await screen.findByText('Starting Fix…')).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('agenthub:log_issue_action', {
          detail: {
            type: 'log_issue_action',
            projectId: 'p1',
            issueId: 'iss-1',
            action: 'fix',
            status: 'completed',
            sessionId: 'new-session',
            cardId: 'new-card',
          },
        }),
      );
    });
    expect(await screen.findByText(/Fix completed · new-card/)).toBeInTheDocument();
  });

  it('restores the old canonical link when a replacement workflow fails', async () => {
    const linked = { ...openIssue, fixSessionId: 'old-session', fixCardId: 'old-card' };
    (api.listLogIssues as any).mockResolvedValue({ issues: [linked], nextCursor: null });
    (api.getLogIssue as any).mockResolvedValue({ ...linked, releases: [], samples: [] });
    render(<IssuesView projectId="p1" />);
    fireEvent.click(await screen.findByText(/cannot read property x of undefined/i));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('agenthub:log_issue_action', {
          detail: {
            type: 'log_issue_action',
            projectId: 'p1',
            issueId: 'iss-1',
            action: 'fix',
            status: 'in_flight',
            sessionId: 'replacement-session',
            cardId: 'replacement-card',
          },
        }),
      );
    });
    expect(await screen.findByText('Starting Fix…')).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('agenthub:log_issue_action', {
          detail: {
            type: 'log_issue_action',
            projectId: 'p1',
            issueId: 'iss-1',
            action: 'fix',
            status: 'failed',
            sessionId: 'replacement-session',
            cardId: 'replacement-card',
            error: 'agent unavailable',
          },
        }),
      );
    });

    expect(await screen.findByText(/Fix failed: agent unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open fix' })).toBeInTheDocument();
    expect(screen.getByText(/Fix card linked · old-card/)).toBeInTheDocument();
  });

  it('drops a stale list response when the status tab changed before it resolved', async () => {
    let resolveOpen: () => void = () => {};
    let resolveIgnored: () => void = () => {};
    (api.listLogIssues as any).mockImplementation((_pid: string, params: { status?: string }) => {
      if (params.status === 'ignored') {
        return new Promise(
          (r) =>
            (resolveIgnored = () =>
              r({
                issues: [{ ...openIssue, id: 'ign-1', status: 'ignored', title: 'IGNORED ROW' }],
                nextCursor: null,
              })),
        );
      }
      return new Promise(
        (r) =>
          (resolveOpen = () =>
            r({ issues: [{ ...openIssue, id: 'open-1', title: 'OPEN ROW' }], nextCursor: null })),
      );
    });

    render(<IssuesView projectId="p1" />);
    // Initial 'open' load is in flight; switch to 'ignored' before it resolves.
    fireEvent.click(screen.getByRole('button', { name: 'Ignored' }));

    // Resolve the newer 'ignored' request first, then the stale 'open' one.
    await act(async () => {
      resolveIgnored();
    });
    expect(await screen.findByText('IGNORED ROW')).toBeInTheDocument();

    await act(async () => {
      resolveOpen();
    });
    // The stale 'open' page must not replace the 'ignored' list.
    expect(screen.queryByText('OPEN ROW')).not.toBeInTheDocument();
    expect(screen.getByText('IGNORED ROW')).toBeInTheDocument();
  });

  it('passes the selected status tab to the API', async () => {
    (api.listLogIssues as any).mockResolvedValue({ issues: [], nextCursor: null });
    render(<IssuesView projectId="p1" />);
    await screen.findByText(/No open error issues/i);
    fireEvent.click(screen.getByRole('button', { name: 'Ignored' }));
    await waitFor(() =>
      expect(api.listLogIssues).toHaveBeenLastCalledWith('p1', { limit: 50, status: 'ignored' }),
    );
  });
});
