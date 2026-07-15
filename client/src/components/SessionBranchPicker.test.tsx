import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/api', () => ({
  api: {
    getProjectBranches: vi.fn(),
    setSessionWorktreeBranch: vi.fn(),
  },
}));

import { api } from '../utils/api';
import SessionBranchPicker from './SessionBranchPicker';

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
    // Default branch is excluded from selectable options.
    await screen.findByText('feature/foo');
    expect(screen.queryByText('main')).toBeNull();

    fireEvent.click(screen.getByText('feature/foo'));
    await waitFor(() =>
      expect(api.setSessionWorktreeBranch).toHaveBeenCalledWith('sess-1', 'feature/foo'),
    );
  });

  it('clears the choice via the Default option', async () => {
    renderPicker({ ...baseSession, worktree_checkout_branch: 'feature/foo' });
    fireEvent.click(screen.getByTestId('session-branch-picker'));
    fireEvent.click(await screen.findByText(/Default/));
    await waitFor(() => expect(api.setSessionWorktreeBranch).toHaveBeenCalledWith('sess-1', null));
  });

  it('locks (no popover) once the worktree is provisioned and shows the branch', () => {
    renderPicker({
      ...baseSession,
      worktree_path: '/tmp/w',
      worktree_branch: 'agent-hub/x/session-1',
      code_changed_at: '2026-07-15T16:00:00.000Z',
    });
    const btn = screen.getByTestId('session-branch-picker');
    expect(btn).toHaveTextContent('agent-hub/x/session-1');
    fireEvent.click(btn);
    // Locked: clicking does not open the branch list.
    expect(api.getProjectBranches).not.toHaveBeenCalled();
    expect(screen.queryByText(/Start session on/)).toBeNull();
  });

  it('allows a clean provisioned session to choose another existing branch', async () => {
    renderPicker({
      ...baseSession,
      worktree_path: '/tmp/w',
      worktree_branch: 'agent-hub/x/session-1',
    });

    fireEvent.click(screen.getByTestId('session-branch-picker'));
    await screen.findByText('feature/foo');
    expect(screen.queryByText(/Default/)).toBeNull();

    fireEvent.click(screen.getByText('feature/foo'));
    await waitFor(() =>
      expect(api.setSessionWorktreeBranch).toHaveBeenCalledWith('sess-1', 'feature/foo'),
    );
  });
});
