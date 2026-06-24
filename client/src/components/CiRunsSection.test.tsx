import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CiRunsSection, { groupStepsByJob } from './CiRunsSection';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
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
  (api.getCiRuns as any).mockResolvedValue({ runs });
  (api.getCiRunDetail as any).mockResolvedValue({
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
  (api.getFinalizeStepOutput as any).mockResolvedValue({ lines: ['[stdout] all green'] });
  (api.getFinalizeRunResources as any).mockResolvedValue({ jobs: [] });
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
    fireEvent.click(await screen.findByTestId('ci-run-run-1' as any));

    await waitFor(() => expect(api.getCiRunDetail).toHaveBeenCalledWith('proj-1', 'run-1'));
    // The step name renders with its job/matrix prefix stripped ("unit /
    // default / test" -> "test") because the job header already shows that
    // context.
    expect(await screen.findByText('test')).toBeInTheDocument();
    expect(screen.queryByText('unit / default / test')).toBeNull();
    // Job header still shows the job id once.
    expect(screen.getByText('unit')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ci-run-step-run-1-1' as any) as any);
    await waitFor(() =>
      expect(api.getFinalizeStepOutput).toHaveBeenCalledWith('proj-1', 'run-1', 1),
    );
    expect(await screen.findByText('[stdout] all green')).toBeInTheDocument();
  });

  it('nests each step under its parent job for a matrix run', async () => {
    const matrixRun = {
      ...runs[0],
      id: 'run-3',
      jobs: [
        {
          job_id: 'e2e',
          matrix_key: 'shard-1',
          state: 'success',
          exit_code: 0,
          started_at: 1,
          ended_at: 2,
        },
        {
          job_id: 'e2e',
          matrix_key: 'shard-2',
          state: 'failure',
          exit_code: 1,
          started_at: 1,
          ended_at: 2,
        },
      ],
    };
    (api.getCiRuns as any).mockResolvedValue({ runs: [matrixRun] });
    (api.getCiRunDetail as any).mockResolvedValue({
      run: matrixRun,
      steps: [
        {
          step_index: 1,
          name: 'e2e / shard-1 / cypress',
          state: 'success',
          exit_code: 0,
          started_at: 1,
          ended_at: 2,
          job_id: 'e2e',
          matrix_key: 'shard-1',
        },
        {
          step_index: 2,
          name: 'e2e / shard-2 / cypress',
          state: 'failure',
          exit_code: 1,
          started_at: 1,
          ended_at: 2,
          job_id: 'e2e',
          matrix_key: 'shard-2',
        },
      ],
    });
    render(<CiRunsSection project={hostedProject} />);
    fireEvent.click(await screen.findByTestId('ci-run-run-3' as any));

    // Both shards render as separate job blocks, each with its own step row.
    expect(await screen.findByTestId('ci-run-step-run-3-1')).toBeInTheDocument();
    expect(await screen.findByTestId('ci-run-step-run-3-2')).toBeInTheDocument();
    // Shard labels are shown so the otherwise-identical 'cypress' steps are
    // distinguishable.
    expect(screen.getByText('shard-1')).toBeInTheDocument();
    expect(screen.getByText('shard-2')).toBeInTheDocument();
  });

  describe('groupStepsByJob', () => {
    const job = (id: string, mk: string) => ({ job_id: id, matrix_key: mk });
    const step = (i: number, jid: string | null, mk: string | null) => ({
      step_index: i,
      job_id: jid,
      matrix_key: mk,
    });

    it('buckets steps under the matching job by id + matrix_key', () => {
      const { groups, orphan } = groupStepsByJob(
        [job('e2e', 'shard-1'), job('e2e', 'shard-2')],
        [step(1, 'e2e', 'shard-1'), step(2, 'e2e', 'shard-2'), step(3, 'e2e', 'shard-1')],
      );
      expect(orphan).toEqual([]);
      expect(groups[0].steps.map((s: any) => s.step_index)).toEqual([1, 3]);
      expect(groups[1].steps.map((s: any) => s.step_index)).toEqual([2]);
    });

    it('folds unkeyed steps into the sole job (legacy single-job runs)', () => {
      const { groups, orphan } = groupStepsByJob(
        [job('checks', 'default')],
        [step(1, null, null), step(2, null, null)],
      );
      expect(orphan).toEqual([]);
      expect(groups[0].steps.map((s: any) => s.step_index)).toEqual([1, 2]);
    });

    it('returns unmatched steps as orphan when there are multiple jobs', () => {
      const { groups, orphan } = groupStepsByJob(
        [job('a', 'default'), job('b', 'default')],
        [step(1, 'a', 'default'), step(2, 'ghost', 'default')],
      );
      expect(groups[0].steps.map((s: any) => s.step_index)).toEqual([1]);
      expect(groups[1].steps).toEqual([]);
      expect(orphan.map((s: any) => s.step_index)).toEqual([2]);
    });
  });

  it('renders the per-job resource badge keyed by job id + matrix', async () => {
    // Resources endpoint keys jobs by `job_name`; the run jobs use `job_id` —
    // the same logical identifier. The render must resolve the lookup so the
    // badge shows. A key-format mismatch (the bug this guards) yields no badge.
    (api.getFinalizeRunResources as any).mockResolvedValue({
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
    fireEvent.click(await screen.findByTestId('ci-run-run-1' as any));

    await waitFor(() =>
      expect(api.getFinalizeRunResources).toHaveBeenCalledWith('proj-1', 'run-1'),
    );
    expect(await screen.findByText('1.7 / 32.0 GB · 72%')).toBeInTheDocument();
  });

  it('CI-on-push toggle PATCHes the project (hosted projects only)', async () => {
    (api.updateProject as any).mockResolvedValue({});
    const onProjectsChange = vi.fn();
    render(<CiRunsSection project={hostedProject} onProjectsChange={onProjectsChange} />);

    fireEvent.click(await screen.findByTestId('ci-on-push-toggle' as any));
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith('proj-1', { ciOnPush: { enabled: true } }),
    );
    await waitFor(() => expect(onProjectsChange!).toHaveBeenCalled());
  });

  it('hides the toggle for GitHub-hosted projects but still shows history', async () => {
    render(<CiRunsSection project={{ id: 'proj-2', name: 'P2', gitHost: 'github' }} />);
    expect(await screen.findByTestId('ci-run-run-1')).toBeInTheDocument();
    expect(screen.queryByTestId('ci-on-push-toggle')).toBeNull();
  });

  it('renders the empty state when there are no runs', async () => {
    (api.getCiRuns as any).mockResolvedValue({ runs: [] });
    render(<CiRunsSection project={hostedProject} />);
    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument();
  });
});
