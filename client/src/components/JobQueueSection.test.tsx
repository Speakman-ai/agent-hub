import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import JobQueueSection from './JobQueueSection';
import { api } from '../utils/api';

// Bare `vi.mock('../utils/api', ...)` so Vitest's hoister lifts the factory
// above the ESM imports (a `(vi as any).mock(...)` callee is a TSAsExpression,
// not the `vi` identifier, and would NOT be hoisted). Keep the specifier
// identical to the component/test import (`'../utils/api'`, no `.js`).
vi.mock('../utils/api', () => ({
  api: {
    getJobs: vi.fn(),
    retryJob: vi.fn(),
    deleteJob: vi.fn(),
  },
}));

function makeJob(overrides: any = {}) {
  return {
    id: overrides.id ?? 'job-1',
    type: overrides.type ?? 'scheduled.heartbeat',
    payload: '{}',
    status: overrides.status ?? 'queued',
    priority: 0,
    attempts: overrides.attempts ?? 0,
    max_attempts: 5,
    run_at: 1_000_000,
    claimed_by: null,
    claimed_at: null,
    lease_id: null,
    last_error: overrides.last_error ?? null,
    created_at: 1_000_000,
    updated_at: 1_000_000,
    ...overrides,
  };
}

function response(jobs: any[], counts: any = {}) {
  return {
    jobs,
    counts: {
      queued: 0,
      running: 0,
      done: 0,
      dead_letter: 0,
      total: jobs.length,
      ...counts,
    },
    types: [...new Set(jobs.map((j) => j.type))],
    limit: 200,
    offset: 0,
  };
}

describe('JobQueueSection', () => {
  beforeEach(() => {
    (api.getJobs as any).mockReset();
    (api.retryJob as any).mockReset();
    (api.deleteJob as any).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads jobs on mount and renders counts + rows', async () => {
    (api.getJobs as any).mockResolvedValue(
      response([makeJob({ id: 'a', type: 'scheduled.cron' })], { queued: 1, total: 1 }),
    );

    render(<JobQueueSection />);

    await waitFor(() => expect(api.getJobs).toHaveBeenCalled());
    expect(await screen.findByRole('cell', { name: 'scheduled.cron' })).toBeDefined();
    // Total count card shows 1.
    expect(screen.getByText('Background Jobs')).toBeDefined();
  });

  it('shows a Retry action only for dead-lettered jobs and calls retryJob', async () => {
    (api.getJobs as any).mockResolvedValue(
      response([makeJob({ id: 'dl', status: 'dead_letter', last_error: 'boom', attempts: 5 })], {
        dead_letter: 1,
        total: 1,
      }),
    );
    (api.retryJob as any).mockResolvedValue({ job: makeJob({ id: 'dl', status: 'queued' }) });

    render(<JobQueueSection />);

    const retryBtn = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(retryBtn);
    await waitFor(() => expect(api.retryJob).toHaveBeenCalledWith('dl'));
  });

  it('does not show a Retry action for queued jobs', async () => {
    (api.getJobs as any).mockResolvedValue(
      response([makeJob({ id: 'q', status: 'queued' })], { queued: 1, total: 1 }),
    );

    render(<JobQueueSection />);
    await screen.findByRole('cell', { name: 'scheduled.heartbeat' });
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('refetches with a status filter when the status select changes', async () => {
    (api.getJobs as any).mockResolvedValue(response([]));

    render(<JobQueueSection />);
    await waitFor(() => expect(api.getJobs).toHaveBeenCalledTimes(1));

    const statusSelect = screen.getAllByRole('combobox')[0];
    fireEvent.change(statusSelect, { target: { value: 'dead_letter' } });

    await waitFor(() =>
      expect(api.getJobs).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'dead_letter' }),
      ),
    );
  });

  it('deletes a job and refetches', async () => {
    (api.getJobs as any).mockResolvedValue(
      response([makeJob({ id: 'd1', status: 'done' })], { done: 1, total: 1 }),
    );
    (api.deleteJob as any).mockResolvedValue({ ok: true });

    render(<JobQueueSection />);
    const deleteBtn = await screen.findByTitle('Delete this job');
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(api.deleteJob).toHaveBeenCalledWith('d1'));
  });

  it('surfaces an error when loading fails', async () => {
    (api.getJobs as any).mockRejectedValue(new Error('nope'));

    render(<JobQueueSection />);
    expect(await screen.findByText('nope')).toBeDefined();
  });
});
