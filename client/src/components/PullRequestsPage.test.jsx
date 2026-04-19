import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import PullRequestsPage from './PullRequestsPage.jsx';
import { api } from '../utils/api.js';

/**
 * Component test for the Resolve PR button in <PullRequestsPage />.
 *
 * Covers the three response branches from `POST /api/projects/:projectId/pulls/:number/resolve`:
 *   - 201 with `sessionId` → calls `onOpenSession(agentId, sessionId)` + success toast
 *   - 200 with `sessionId: null, triggered: []` → info toast "Nothing to resolve — PR looks clean."
 *   - rejected promise → error toast with the message
 *
 * Also verifies: button disabled + spinner while in flight (prevents double-submit),
 * and the no-agent edge case (button disabled with tooltip when project.agents is empty).
 */

vi.mock('../utils/api.js', () => ({
  api: {
    getProjectPulls: vi.fn(),
    getProjectPullDetail: vi.fn(),
    resolvePR: vi.fn(),
  },
}));

const prSummary = {
  number: 123,
  title: 'Fix the flaky test',
  state: 'open',
  user: 'alice',
  head: 'feature/x',
  base: 'main',
  updated_at: '2026-04-19T10:00:00Z',
  created_at: '2026-04-19T09:00:00Z',
  html_url: 'https://github.com/owner/repo/pull/123',
  labels: [],
  additions: 3,
  deletions: 1,
  changed_files: 1,
};

const detailResponse = {
  pr: { ...prSummary, mergeable: true, mergeable_state: 'clean' },
  checks: [],
  reviews: [],
  comments: [],
};

const project = {
  id: 'proj-1',
  name: 'Demo',
  agents: [{ id: 'agent-alpha', name: 'Alpha', active: true }],
};

async function renderAndOpenDetail(props = {}) {
  api.getProjectPulls.mockResolvedValue({ pulls: [prSummary] });
  api.getProjectPullDetail.mockResolvedValue(detailResponse);

  render(<PullRequestsPage projectId="proj-1" project={project} {...props} />);

  // Wait for the list to load, then click into the detail view.
  const title = await screen.findByText('Fix the flaky test');
  fireEvent.click(title);

  // Wait for the detail view to render (Resolve PR button present).
  return await screen.findByRole('button', { name: /resolve pr/i });
}

describe('<PullRequestsPage /> — Resolve PR button', () => {
  beforeEach(() => {
    api.getProjectPulls.mockReset();
    api.getProjectPullDetail.mockReset();
    api.resolvePR.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls api.resolvePR with the first agent id on click', async () => {
    api.resolvePR.mockResolvedValue({
      sessionId: 'sess-99',
      triggered: ['ci'],
      session: { id: 'sess-99' },
    });
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn);

    await waitFor(() => expect(api.resolvePR).toHaveBeenCalledTimes(1));
    expect(api.resolvePR).toHaveBeenCalledWith('proj-1', 123, {
      agentId: 'agent-alpha',
    });

    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('agent-alpha', 'sess-99'));
    // Success toast mentions the triggered kinds
    expect(onToast).toHaveBeenCalledWith(
      expect.stringMatching(/ci/i),
      'success',
      expect.any(Number),
    );
  });

  it('disables the button while the request is in flight', async () => {
    let resolveFn;
    api.resolvePR.mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn);

    // While the request is pending the button must be disabled.
    await waitFor(() => expect(btn).toBeDisabled());

    // Click again — should NOT trigger a second API call (guarded state).
    fireEvent.click(btn);
    expect(api.resolvePR).toHaveBeenCalledTimes(1);

    // Resolve the request and verify the button re-enables.
    await act(async () => {
      resolveFn({ sessionId: 's', triggered: [], session: { id: 's' } });
    });
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  it('shows an info toast and does NOT navigate when the PR is clean', async () => {
    api.resolvePR.mockResolvedValue({
      sessionId: null,
      triggered: [],
      reason: 'no-action-needed',
    });
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn);

    await waitFor(() => expect(api.resolvePR).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        'Nothing to resolve — PR looks clean.',
        'info',
        expect.any(Number),
      ),
    );
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('shows an error toast when the API call fails', async () => {
    api.resolvePR.mockRejectedValue(new Error('502: upstream down'));
    const onOpenSession = vi.fn();
    const onToast = vi.fn();

    const btn = await renderAndOpenDetail({ onOpenSession, onToast });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        expect.stringMatching(/resolve pr failed: 502: upstream down/i),
        'error',
        expect.any(Number),
      ),
    );
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('disables the button when the project has no agents configured', async () => {
    api.getProjectPulls.mockResolvedValue({ pulls: [prSummary] });
    api.getProjectPullDetail.mockResolvedValue(detailResponse);

    render(
      <PullRequestsPage
        projectId="proj-1"
        project={{ ...project, agents: [] }}
        onOpenSession={vi.fn()}
        onToast={vi.fn()}
      />,
    );

    const title = await screen.findByText('Fix the flaky test');
    fireEvent.click(title);

    const btn = await screen.findByRole('button', { name: /resolve pr/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'No agents configured');

    fireEvent.click(btn);
    expect(api.resolvePR).not.toHaveBeenCalled();
  });
});
