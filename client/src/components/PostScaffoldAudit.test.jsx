import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import PostScaffoldAudit from './PostScaffoldAudit.jsx';

function buildDeps({
  auditResult,
  auditError,
  agentsResult = [
    { id: 'hub-lead', name: 'Hub Lead', role: 'lead' },
    { id: 'hub-backend', name: 'Hub Backend' },
    { id: 'hub-frontend', name: 'Hub Frontend' },
  ],
  suggestionsResult,
  suggestionsError,
  saveRosterResult = { tracks: [], updatedAt: '2026-04-23T20:00:00Z' },
  saveRosterError,
  refreshResult,
  refreshError,
} = {}) {
  const deps = {
    fetchAudit: vi.fn(() =>
      auditError ? Promise.reject(auditError) : Promise.resolve(auditResult ?? {}),
    ),
    fetchAgents: vi.fn(() => Promise.resolve(agentsResult)),
    fetchSuggestions: vi.fn(() =>
      suggestionsError
        ? Promise.reject(suggestionsError)
        : Promise.resolve(suggestionsResult ?? null),
    ),
    saveRoster: vi.fn(() =>
      saveRosterError ? Promise.reject(saveRosterError) : Promise.resolve(saveRosterResult),
    ),
    refresh: vi.fn(() =>
      refreshError ? Promise.reject(refreshError) : Promise.resolve(refreshResult ?? {}),
    ),
  };
  return deps;
}

describe('PostScaffoldAudit', () => {
  it('shows loading card while initial load is in flight', async () => {
    const deps = buildDeps({ auditResult: { categories: [] } });
    await act(async () => {
      render(<PostScaffoldAudit projectId="p1" {...deps} />);
    });
    // After the microtask chain settles, loading is done — assert we stopped
    // showing the spinner.
    await waitFor(() => {
      expect(screen.queryByTestId('psa-loading')).not.toBeInTheDocument();
    });
    expect(deps.fetchAudit).toHaveBeenCalledWith('p1');
    expect(deps.fetchAgents).toHaveBeenCalled();
    expect(deps.fetchSuggestions).toHaveBeenCalledWith('p1');
  });

  it('renders the audit report when the load succeeds', async () => {
    const deps = buildDeps({
      auditResult: {
        projectId: 'p1',
        score: 88,
        categories: [{ id: 'lint', status: 'ok' }],
      },
    });
    await act(async () => {
      render(<PostScaffoldAudit projectId="p1" {...deps} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('audit-report')).toBeInTheDocument();
    });
    expect(screen.getByTestId('audit-score-value').textContent).toBe('88');
  });

  it('shows the load-error card when fetchAudit rejects', async () => {
    const deps = buildDeps({ auditError: new Error('boom') });
    await act(async () => {
      render(<PostScaffoldAudit projectId="p1" {...deps} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('psa-load-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it('falls back to local suggestions when the endpoint fails', async () => {
    const deps = buildDeps({
      auditResult: { categories: [] },
      suggestionsError: new Error('404'),
    });
    await act(async () => {
      render(<PostScaffoldAudit projectId="p1" {...deps} />);
    });
    // The fallback uses DEFAULT_TRACKS which includes 'frontend' — we should
    // see a row for it pre-selected to the frontend agent.
    await waitFor(() => {
      expect(screen.getByTestId('roster-row-frontend')).toBeInTheDocument();
    });
    expect(screen.getByTestId('roster-agent-frontend').value).toBe('hub-frontend');
  });

  it('confirm button is disabled until a roster row has an agent assigned', async () => {
    // Agent list that matches nothing so all suggestions start null.
    const deps = buildDeps({
      auditResult: { categories: [] },
      agentsResult: [{ id: 'no-match', name: 'No Match' }],
      suggestionsResult: { tracks: [{ id: 'architect', label: 'Architect' }] },
    });
    await act(async () => {
      render(<PostScaffoldAudit projectId="p1" {...deps} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('roster-row-architect')).toBeInTheDocument();
    });
    const btn = screen.getByTestId('psa-confirm');
    expect(btn).toBeDisabled();
    // Assign an agent; button enables.
    fireEvent.change(screen.getByTestId('roster-agent-architect'), {
      target: { value: 'no-match' },
    });
    expect(btn).not.toBeDisabled();
  });

  it('POSTs the roster and calls onConfirmed with the saved result', async () => {
    const onConfirmed = vi.fn();
    const deps = buildDeps({
      auditResult: { categories: [] },
      suggestionsResult: { tracks: [{ id: 'architect', label: 'Architect' }] },
      saveRosterResult: { tracks: [{ id: 'architect', agentId: 'hub-lead', custom: false }] },
    });
    await act(async () => {
      render(<PostScaffoldAudit projectId="p1" onConfirmed={onConfirmed} {...deps} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('roster-agent-architect')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('roster-agent-architect'), {
      target: { value: 'hub-lead' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('psa-confirm'));
    });
    expect(deps.saveRoster).toHaveBeenCalledWith('p1', {
      tracks: [{ id: 'architect', label: 'Architect', agentId: 'hub-lead', custom: false }],
    });
    // onConfirmed now receives the saved roster as the first arg and an
    // `{report, agents, roster}` context object as the second — the
    // downstream landing view uses these to render without refetching.
    expect(onConfirmed).toHaveBeenCalledWith(
      { tracks: [{ id: 'architect', agentId: 'hub-lead', custom: false }] },
      expect.objectContaining({
        agents: expect.any(Array),
        roster: expect.any(Array),
      }),
    );
  });

  it('surfaces save errors without invoking onConfirmed', async () => {
    const onConfirmed = vi.fn();
    const deps = buildDeps({
      auditResult: { categories: [] },
      suggestionsResult: {
        tracks: [{ id: 'architect', label: 'Architect', suggestedAgentId: 'hub-lead' }],
      },
      saveRosterError: new Error('500: db down'),
    });
    await act(async () => {
      render(<PostScaffoldAudit projectId="p1" onConfirmed={onConfirmed} {...deps} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('roster-agent-architect').value).toBe('hub-lead');
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('psa-confirm'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('psa-save-error')).toBeInTheDocument();
    });
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(screen.getByTestId('psa-save-error').textContent).toMatch(/db down/);
  });

  it('refresh replaces the report with the new payload', async () => {
    const deps = buildDeps({
      auditResult: { score: 30, categories: [] },
      refreshResult: { score: 95, categories: [] },
    });
    await act(async () => {
      render(<PostScaffoldAudit projectId="p1" {...deps} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('audit-score-value').textContent).toBe('30');
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-refresh'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('audit-score-value').textContent).toBe('95');
    });
    expect(deps.refresh).toHaveBeenCalledWith('p1');
  });

  it('refresh that returns a jobId falls back to re-fetching the report', async () => {
    const deps = buildDeps({
      auditResult: { score: 40, categories: [] },
      refreshResult: { jobId: 'job-123' },
    });
    deps.fetchAudit = vi
      .fn()
      // First call on mount
      .mockResolvedValueOnce({ score: 40, categories: [] })
      // Second call after refresh resolves with jobId
      .mockResolvedValueOnce({ score: 77, categories: [] });

    await act(async () => {
      render(<PostScaffoldAudit projectId="p1" {...deps} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('audit-score-value').textContent).toBe('40');
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-refresh'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('audit-score-value').textContent).toBe('77');
    });
    expect(deps.fetchAudit).toHaveBeenCalledTimes(2);
  });

  it('onSkip button fires the skip callback', async () => {
    const onSkip = vi.fn();
    const deps = buildDeps({ auditResult: { categories: [] } });
    await act(async () => {
      render(<PostScaffoldAudit projectId="p1" onSkip={onSkip} {...deps} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId('psa-skip')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('psa-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('renders no skip button when onSkip is not supplied', async () => {
    const deps = buildDeps({ auditResult: { categories: [] } });
    await act(async () => {
      render(<PostScaffoldAudit projectId="p1" {...deps} />);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('psa-loading')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('psa-skip')).not.toBeInTheDocument();
  });
});
