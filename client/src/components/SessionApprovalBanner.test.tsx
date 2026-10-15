import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

(vi as any).mock('../utils/api', () => ({
  api: {
    listMyApprovals: vi.fn(),
    answerApproval: vi.fn(),
  },
}));

import { api } from '../utils/api';
import SessionApprovalBanner from './SessionApprovalBanner';
import { APPROVAL_WS_EVENT } from './ApprovalActions';

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function approval(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: 's1',
    agentId: 'a1',
    projectId: 'p1',
    action: 'send',
    target: 'email to ann@example.com',
    domain: 'mail.example.com',
    details: 'Quarterly numbers',
    status: 'pending',
    resolution: null,
    ruleId: null,
    canRemember: true,
    requestedAt: Date.now(),
    expiresAt: Date.now() + 3 * 3_600_000 + 60_000,
    resolvedAt: null,
    ...over,
  };
}

function emit(detail: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new CustomEvent(APPROVAL_WS_EVENT, { detail }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.listMyApprovals.mockResolvedValue({ approvals: [approval('ap1')] });
  mocked.answerApproval.mockResolvedValue({ approval: approval('ap1'), ruleId: null });
});
afterEach(() => cleanup());

describe('SessionApprovalBanner', () => {
  it('renders nothing when the session has no pending approvals', async () => {
    mocked.listMyApprovals.mockResolvedValue({ approvals: [] });
    render(<SessionApprovalBanner sessionId="s1" />);
    await waitFor(() =>
      expect(mocked.listMyApprovals).toHaveBeenCalledWith({ status: 'pending', sessionId: 's1' }),
    );
    expect(screen.queryByTestId('session-approval-banner')).toBeNull();
  });

  it('shows the request with all three answers when it can be remembered', async () => {
    render(<SessionApprovalBanner sessionId="s1" />);
    const card = await screen.findByTestId('session-approval');
    expect(card).toHaveTextContent('send email to ann@example.com');
    expect(card).toHaveTextContent('on mail.example.com');
    expect(card).toHaveTextContent('Quarterly numbers');
    expect(card).toHaveTextContent('expires in 3h');
    expect(screen.getByTestId('session-approval-always_allow')).toBeTruthy();
  });

  it('hides Always allow when the answer cannot be saved as a rule', async () => {
    mocked.listMyApprovals.mockResolvedValue({
      approvals: [approval('ap1', { canRemember: false, domain: null })],
    });
    render(<SessionApprovalBanner sessionId="s1" />);
    await screen.findByTestId('session-approval');
    expect(screen.queryByTestId('session-approval-always_allow')).toBeNull();
  });

  it('sends the decision and removes the card', async () => {
    render(<SessionApprovalBanner sessionId="s1" />);
    fireEvent.click(await screen.findByTestId('session-approval-always_allow'));
    await waitFor(() => expect(mocked.answerApproval).toHaveBeenCalledWith('ap1', 'always_allow'));
    await waitFor(() => expect(screen.queryByTestId('session-approval-banner')).toBeNull());
  });

  it('clears the card when the server says it is no longer waiting', async () => {
    mocked.answerApproval.mockRejectedValue(
      Object.assign(new Error('This approval expired and was denied'), { status: 409 }),
    );
    render(<SessionApprovalBanner sessionId="s1" />);
    fireEvent.click(await screen.findByTestId('session-approval-allow_once'));
    await waitFor(() => expect(screen.queryByTestId('session-approval-banner')).toBeNull());
  });

  it('keeps the card and shows the error on other failures', async () => {
    mocked.answerApproval.mockRejectedValue(new Error('Network down'));
    render(<SessionApprovalBanner sessionId="s1" />);
    fireEvent.click(await screen.findByTestId('session-approval-deny'));
    expect(await screen.findByTestId('session-approval-error')).toHaveTextContent('Network down');
    expect(screen.getByTestId('session-approval')).toBeTruthy();
  });

  it('reloads on a new request for this session and drops resolved ones', async () => {
    mocked.listMyApprovals.mockResolvedValueOnce({ approvals: [] });
    render(<SessionApprovalBanner sessionId="s1" />);
    await waitFor(() => expect(mocked.listMyApprovals).toHaveBeenCalledTimes(1));
    emit({ type: 'approval_requested', sessionId: 'other' });
    expect(mocked.listMyApprovals).toHaveBeenCalledTimes(1);
    emit({ type: 'approval_requested', sessionId: 's1' });
    expect(await screen.findByTestId('session-approval')).toBeTruthy();
    emit({ type: 'approval_resolved', sessionId: 's1', approvalId: 'ap1' });
    expect(screen.queryByTestId('session-approval-banner')).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('SessionApprovalBanner: races', () => {
  it('a list response in flight when the approval resolves does not bring it back', async () => {
    mocked.listMyApprovals.mockResolvedValueOnce({ approvals: [] });
    render(<SessionApprovalBanner sessionId="s1" />);
    await waitFor(() => expect(mocked.listMyApprovals).toHaveBeenCalledTimes(1));
    const late = deferred<{ approvals: unknown[] }>();
    mocked.listMyApprovals.mockReturnValueOnce(late.promise);
    emit({ type: 'approval_requested', sessionId: 's1' });
    emit({ type: 'approval_resolved', sessionId: 's1', approvalId: 'ap1' });
    await act(async () => {
      late.resolve({ approvals: [approval('ap1')] });
    });
    expect(screen.queryByTestId('session-approval-banner')).toBeNull();
  });

  it('a list response in flight when the user answers does not bring it back', async () => {
    render(<SessionApprovalBanner sessionId="s1" />);
    await screen.findByTestId('session-approval');
    const late = deferred<{ approvals: unknown[] }>();
    mocked.listMyApprovals.mockReturnValueOnce(late.promise);
    emit({ type: 'approval_requested', sessionId: 's1' });
    fireEvent.click(screen.getByTestId('session-approval-deny'));
    await waitFor(() => expect(screen.queryByTestId('session-approval-banner')).toBeNull());
    await act(async () => {
      late.resolve({ approvals: [approval('ap1')] });
    });
    expect(screen.queryByTestId('session-approval-banner')).toBeNull();
  });

  it("hides the previous session's approvals while the next session's list loads", async () => {
    const { rerender } = render(<SessionApprovalBanner sessionId="s1" />);
    await screen.findByTestId('session-approval');
    const slow = deferred<{ approvals: unknown[] }>();
    mocked.listMyApprovals.mockReturnValueOnce(slow.promise);
    rerender(<SessionApprovalBanner sessionId="s2" />);
    expect(screen.queryByTestId('session-approval-banner')).toBeNull();
    await act(async () => {
      slow.resolve({ approvals: [approval('ap2', { sessionId: 's2', action: 'publish' })] });
    });
    expect(await screen.findByTestId('session-approval')).toHaveTextContent('publish');
  });
});
