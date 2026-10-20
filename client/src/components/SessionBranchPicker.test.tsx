import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

(vi as any).mock('../utils/api', () => ({
  api: {
    getProjectBranches: vi.fn(),
    setSessionWorktreeBranch: vi.fn(),
    setSessionTargetBranch: vi.fn(),
  },
}));

import { api } from '../utils/api';
import SessionBranchPicker, { retargetNotice } from './SessionBranchPicker';

const baseSession = {
  id: 'sess-1',
  use_worktree: 1,
  worktree_path: null,
  worktree_branch: null,
  worktree_checkout_branch: null,
  code_changed_at: null,
};

function renderPicker(session: any = baseSession, extra: any = {}) {
  return render(
    <SessionBranchPicker
      sessionId={session.id}
      session={session}
      projectId="proj-1"
      disabled={false}
      onError={extra.onError ?? vi.fn()}
      onNotice={extra.onNotice ?? vi.fn()}
    />,
  );
}

describe('SessionBranchPicker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (api.getProjectBranches as any).mockResolvedValue({
      branches: [
        { name: 'main', isDefault: true },
        { name: 'feature/foo', isDefault: false },
        { name: 'feature/bar', isDefault: false },
      ],
    });
    (api.setSessionWorktreeBranch as any).mockResolvedValue({ ...baseSession });
  });

  it('renders nothing when the session does not use a worktree', () => {
    const { container } = renderPicker({ ...baseSession, use_worktree: 0 });
    expect(container.firstChild).toBeNull();
  });

  it('lists non-default branches and sets the chosen branch', async () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('session-branch-picker'));

    await waitFor(() => expect(api.getProjectBranches).toHaveBeenCalledWith('proj-1', false));
    const head = await screen.findByTestId('session-branch-picker-head-list');
    await within(head).findByText('feature/foo');
    // Default branch is excluded from the working-branch options.
    expect(within(head).queryByText('main')).toBeNull();

    fireEvent.click(within(head).getByText('feature/foo'));
    await waitFor(() =>
      expect(api.setSessionWorktreeBranch).toHaveBeenCalledWith('sess-1', 'feature/foo'),
    );
  });

  it('clears the choice via the Default option', async () => {
    renderPicker({ ...baseSession, worktree_checkout_branch: 'feature/foo' });
    fireEvent.click(screen.getByTestId('session-branch-picker'));
    const head = await screen.findByTestId('session-branch-picker-head-list');
    fireEvent.click(within(head).getByText(/New branch/));
    await waitFor(() => expect(api.setSessionWorktreeBranch).toHaveBeenCalledWith('sess-1', null));
  });

  it('hides the working-branch list after code changes but keeps the target list', async () => {
    renderPicker({
      ...baseSession,
      worktree_path: '/tmp/w',
      worktree_branch: 'agent-hub/x/session-1',
      code_changed_at: '2026-07-15T16:00:00.000Z',
    });
    const btn = screen.getByTestId('session-branch-picker');
    expect(btn).toHaveTextContent('agent-hub/x/session-1');
    fireEvent.click(btn);
    await screen.findByTestId('session-branch-picker-target-list');
    expect(screen.queryByTestId('session-branch-picker-head-list')).toBeNull();
    expect(screen.queryByText(/Switch session to/)).toBeNull();
  });

  it('allows a clean provisioned session to choose another existing branch', async () => {
    renderPicker({
      ...baseSession,
      worktree_path: '/tmp/w',
      worktree_branch: 'agent-hub/x/session-1',
    });

    fireEvent.click(screen.getByTestId('session-branch-picker'));
    const head = await screen.findByTestId('session-branch-picker-head-list');
    await within(head).findByText('feature/foo');
    expect(within(head).queryByText(/New branch/)).toBeNull();

    fireEvent.click(within(head).getByText('feature/foo'));
    await waitFor(() =>
      expect(api.setSessionWorktreeBranch).toHaveBeenCalledWith('sess-1', 'feature/foo'),
    );
  });

  it('sets the target branch (default branch included) and reports the rebase', async () => {
    (api.setSessionTargetBranch as any).mockResolvedValue({
      session: { ...baseSession, pr_base_branch: 'main' },
      retarget: { kind: 'rebased', fromBranch: 'feature/foo', toBranch: 'main', commits: 3 },
    });
    const onNotice = vi.fn();
    renderPicker(
      {
        ...baseSession,
        worktree_path: '/tmp/w',
        worktree_branch: 'agent-hub/x/session-1',
        code_changed_at: '2026-07-15T16:00:00.000Z',
        pr_base_branch: 'feature/foo',
      },
      { onNotice },
    );
    expect(screen.getByTestId('session-branch-picker-target')).toHaveTextContent('feature/foo');

    fireEvent.click(screen.getByTestId('session-branch-picker'));
    const targets = await screen.findByTestId('session-branch-picker-target-list');
    fireEvent.click(await within(targets).findByText('main'));
    await waitFor(() => expect(api.setSessionTargetBranch).toHaveBeenCalledWith('sess-1', 'main'));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith('Target set to main. Rebased 3 commit(s).', 'success'),
    );
  });

  it('clears the target via the Default option', async () => {
    (api.setSessionTargetBranch as any).mockResolvedValue({
      session: baseSession,
      retarget: { kind: 'stored', fromBranch: null, toBranch: null },
    });
    renderPicker({ ...baseSession, pr_base_branch: 'feature/foo' });
    fireEvent.click(screen.getByTestId('session-branch-picker'));
    const targets = await screen.findByTestId('session-branch-picker-target-list');
    fireEvent.click(within(targets).getByText(/Default/));
    await waitFor(() => expect(api.setSessionTargetBranch).toHaveBeenCalledWith('sess-1', null));
  });
});

describe('retargetNotice', () => {
  it('describes an agent hand-off on conflict', () => {
    expect(
      retargetNotice({
        kind: 'conflict',
        toBranch: 'release-1.16.0',
        files: ['a', 'b'],
        agentDispatched: true,
      }),
    ).toEqual({
      message:
        'Target set to release-1.16.0. Rebase conflicts in 2 file(s); the agent is resolving them.',
      level: 'info',
    });
  });

  it('explains why an unsafe history was not rebased', () => {
    expect(
      retargetNotice({
        kind: 'unsafe',
        toBranch: 'release',
        reason: 'the session history has 1 merge commit(s), which a rebase does not replay',
        agentDispatched: true,
      })?.message,
    ).toBe(
      'Target set to release. Not rebased automatically (the session history has 1 merge commit(s), which a rebase does not replay); the agent will move the commits.',
    );
  });

  it('says when merge commits were flattened', () => {
    expect(
      retargetNotice({
        kind: 'rebased',
        toBranch: 'release',
        commits: 1,
        flattened: {
          originalHead: 'abc',
          backupRef: 'refs/agent-hub/pre-flatten/abc',
          mergeCount: 1,
        },
      })?.message,
    ).toContain('original history is kept at refs/agent-hub/pre-flatten/abc');
  });

  it('is silent when nothing changed', () => {
    expect(retargetNotice({ kind: 'unchanged' })).toBeNull();
    expect(retargetNotice(undefined)).toBeNull();
  });
});
