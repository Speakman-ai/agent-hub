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
  firstSeen: 1_700_000_000_000,
  lastSeen: 1_700_000_500_000,
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
