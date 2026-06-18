import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CiRunsSection from './CiRunsSection.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getCiRuns: vi.fn(),
    getCiRunDetail: vi.fn(),
    getFinalizeStepOutput: vi.fn(),
    getFinalizeRunResources: vi.fn(),
    updateProject: vi.fn(),
  },
}));

const hostedProject = {
  id: 'proj-1',
  name: 'Proj One',
  gitHost: 'agenthub',
  ciOnPush: { enabled: false },
};

const runs = [
  {
    id: 'run-1',
    branch: 'main',
    head_sha: 'a'.repeat(40),
    status: 'succeeded',
    mode: 'checks',
    trigger_source: 'git_push',
    failure_reason: null,
    started_at: Date.now() - 60_000,
    ended_at: Date.now() - 30_000,
    jobs: [
      {
        job_id: 'unit',
        matrix_key: 'default',
        state: 'success',
        exit_code: 0,
        started_at: 1,
        ended_at: 2,
      },
    ],
  },
  {
    id: 'run-2',
    branch: 'agent-hub/dev/session-x',
    head_sha: 'b'.repeat(40),
    status: 'failed',
    mode: 'full',
    trigger_source: 'ui_button',
    failure_reason: 'checks_failed',
    started_at: Date.now() - 120_000,
    ended_at: Date.now() - 100_000,
    jobs: [],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getCiRuns.mockResolvedValue({ runs });
  api.getCiRunDetail.mockResolvedValue({
    run: runs[0],
    steps: [
      {
        step_index: 1,
        name: 'unit / default / test',
        state: 'success',
        exit_code: 0,
        started_at: 1,
        ended_at: 2,
        job_id: 'unit',
        matrix_key: 'default',
      },
    ],
  });
  api.getFinalizeStepOutput.mockResolvedValue({ lines: ['[stdout] all green'] });
  api.getFinalizeRunResources.mockResolvedValue({ jobs: [] });
});

describe('CiRunsSection', () => {
  it('lists runs with trigger badges, status, and failure reason', async () => {
    render(<CiRunsSection project={hostedProject} />);
    expect(await screen.findByTestId('ci-run-run-1')).toHaveTextContent('push');
    expect(screen.getByTestId('ci-run-run-1')).toHaveTextContent('passed');
    expect(screen.getByTestId('ci-run-run-2')).toHaveTextContent('finalize');
    expect(screen.getByTestId('ci-run-run-2')).toHaveTextContent('checks_failed');
    expect(api.getCiRuns).toHaveBeenCalledWith('proj-1', { limit: 30 });
  });

  it('expands a run to jobs + steps and opens a step log', async () => {
    render(<CiRunsSection project={hostedProject} />);
    fireEvent.click(await screen.findByTestId('ci-run-run-1'));

    await waitFor(() => expect(api.getCiRunDetail).toHaveBeenCalledWith('proj-1', 'run-1'));
    expect(await screen.findByText('unit / default / test')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ci-run-step-run-1-1'));
    await waitFor(() =>
      expect(api.getFinalizeStepOutput).toHaveBeenCalledWith('proj-1', 'run-1', 1),
    );
    expect(await screen.findByText('[stdout] all green')).toBeInTheDocument();
  });

  it('renders the per-job resource badge keyed by job id + matrix', async () => {
    // Resources endpoint keys jobs by `job_name`; the run jobs use `job_id` —
    // the same logical identifier. The render must resolve the lookup so the
    // badge shows. A key-format mismatch (the bug this guards) yields no badge.
    api.getFinalizeRunResources.mockResolvedValue({
      jobs: [
        {
          job_name: 'unit',
          matrix_key: 'default',
          peak_mem_bytes: 1.7 * 1024 * 1024 * 1024,
          mem_total_bytes: 32 * 1024 * 1024 * 1024,
          peak_cpu_percent: 72,
        },
      ],
    });
    render(<CiRunsSection project={hostedProject} />);
    fireEvent.click(await screen.findByTestId('ci-run-run-1'));

    await waitFor(() =>
      expect(api.getFinalizeRunResources).toHaveBeenCalledWith('proj-1', 'run-1'),
    );
    expect(await screen.findByText('1.7 / 32.0 GB · 72%')).toBeInTheDocument();
  });

  it('CI-on-push toggle PATCHes the project (hosted projects only)', async () => {
    api.updateProject.mockResolvedValue({});
    const onProjectsChange = vi.fn();
    render(<CiRunsSection project={hostedProject} onProjectsChange={onProjectsChange} />);

    fireEvent.click(await screen.findByTestId('ci-on-push-toggle'));
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('proj-1', { ciOnPush: { enabled: true } }),
    );
    await waitFor(() => expect(onProjectsChange).toHaveBeenCalled());
  });

  it('hides the toggle for GitHub-hosted projects but still shows history', async () => {
    render(<CiRunsSection project={{ id: 'proj-2', name: 'P2', gitHost: 'github' }} />);
    expect(await screen.findByTestId('ci-run-run-1')).toBeInTheDocument();
    expect(screen.queryByTestId('ci-on-push-toggle')).toBeNull();
  });

  it('renders the empty state when there are no runs', async () => {
    api.getCiRuns.mockResolvedValue({ runs: [] });
    render(<CiRunsSection project={hostedProject} />);
    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument();
  });
});
