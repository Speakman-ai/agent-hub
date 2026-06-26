import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CiRunsSection, {
  formatCiStepLogLine,
  groupStepsByJob,
  runHasWorkInFlight,
} from './CiRunsSection';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getCiRuns: vi.fn(),
    getCiRunStats: vi.fn(),
    getCiRunDetail: vi.fn(),
    getFinalizeStepOutput: vi.fn(),
    getFinalizeRunResources: vi.fn(),
    updateProject: vi.fn(),
    cancelFinalizeRun: vi.fn(),
    rerunCiRun: vi.fn(),
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
        state: 'passed',
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
  {
    id: 'run-3',
    branch: 'agent-hub/dev/session-live',
    head_sha: 'c'.repeat(40),
    status: 'running',
    mode: 'full',
    trigger_source: 'ui_button',
    failure_reason: null,
    started_at: Date.now() - 5_000,
    ended_at: null,
    jobs: [],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  (api.getCiRuns as any).mockResolvedValue({ runs });
  (api.getCiRunStats as any).mockResolvedValue({
    overall: {
      average_seconds: 90,
      total_runs: 4,
      failed_runs: 1,
      failure_rate: 0.25,
      total_errors: 1,
      infra_errors: 0,
      infra_error_rate: 0,
    },
    tests: [
      {
        job_id: 'test',
        matrix_key: 'server',
        name: 'test / server',
        configured: true,
        average_seconds: 120,
        total_runs: 3,
        failed_runs: 1,
        failure_rate: 1 / 3,
        total_errors: 1,
        infra_errors: 0,
        infra_error_rate: 0,
      },
    ],
    ci_config: { found: true, version: 2, error: null },
  });
  (api.getCiRunDetail as any).mockResolvedValue({
    run: runs[0],
    steps: [
      {
        step_index: 1,
        name: 'unit / default / test',
        state: 'passed',
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

  it('renders runner stats above recent runs', async () => {
    render(<CiRunsSection project={hostedProject} />);
    const stats = await screen.findByTestId('ci-run-stats');

    expect(stats).toHaveTextContent('Overall');
    expect(stats).toHaveTextContent('1m 30s');
    expect(stats).toHaveTextContent('25%');
    expect(stats).toHaveTextContent('Tests in ci.yaml');
    expect(stats).toHaveTextContent('test / server');
    expect(stats).toHaveTextContent('2m 0s');
    expect(stats).toHaveTextContent('33%');
    expect(stats).toHaveTextContent('Runs');
    expect(api.getCiRunStats).toHaveBeenCalledWith('proj-1', { range: 'all' });
  });

  it('reloads runner stats for the selected time range', async () => {
    render(<CiRunsSection project={hostedProject} />);
    await screen.findByTestId('ci-run-stats');
    expect(api.getCiRunStats).toHaveBeenCalledWith('proj-1', { range: 'all' });

    fireEvent.click(screen.getByRole('button', { name: 'Last 24 hours' }));

    await waitFor(() =>
      expect(api.getCiRunStats).toHaveBeenLastCalledWith('proj-1', { range: '24h' }),
    );
  });

  it('renders stats as unavailable instead of spinning forever when stats fail', async () => {
    (api.getCiRunStats as any).mockRejectedValue(new Error('stats unavailable'));
    render(<CiRunsSection project={hostedProject} />);

    expect(await screen.findByTestId('ci-run-stats-unavailable')).toHaveTextContent('unavailable');
    expect(screen.queryByText(/Loading runner stats/i)).toBeNull();
  });

  it('keeps successful stats visible when recent runs fail', async () => {
    (api.getCiRuns as any).mockRejectedValue(new Error('runs unavailable'));
    render(<CiRunsSection project={hostedProject} />);

    const stats = await screen.findByTestId('ci-run-stats');
    expect(stats).toHaveTextContent('Overall');
    expect(stats).toHaveTextContent('test / server');
    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument();
  });

  it('shows the session title when present, falling back to the branch otherwise', async () => {
    const titled = {
      ...runs[1],
      id: 'run-titled',
      branch: 'agent-hub/dev/session-abc123',
      session_id: 'sess-1',
      session_title: 'Fix login redirect',
    };
    const untitled = {
      ...runs[0],
      id: 'run-untitled',
      branch: 'main',
      session_id: null,
      session_title: null,
    };
    (api.getCiRuns as any).mockResolvedValue({ runs: [titled, untitled] });
    render(<CiRunsSection project={hostedProject} />);

    // Titled run shows the human-readable session title, not its branch.
    const titledRow = await screen.findByTestId('ci-run-run-titled');
    expect(titledRow).toHaveTextContent('Fix login redirect');
    expect(titledRow).not.toHaveTextContent('agent-hub/dev/session-abc123');
    // Sessionless push run keeps showing the branch.
    expect(screen.getByTestId('ci-run-run-untitled')).toHaveTextContent('main');
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

  it('renders object-shaped step output as log text', async () => {
    (api.getFinalizeStepOutput as any).mockResolvedValue({
      lines: [
        { stream: 'stdout', text: 'backend migration check' },
        { stream: 'stderr', text: 'relation missing' },
      ],
    });
    render(<CiRunsSection project={hostedProject} />);
    fireEvent.click(await screen.findByTestId('ci-run-run-1' as any));
    fireEvent.click((await screen.findByTestId('ci-run-step-run-1-1' as any)) as any);

    expect(await screen.findByText(/backend migration check/)).toBeInTheDocument();
    expect(screen.getByText(/relation missing/)).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  it('formats legacy CI step log line shapes without object coercion', () => {
    expect(formatCiStepLogLine({ text: 'from text' })).toBe('from text');
    expect(formatCiStepLogLine({ data: 'from data' })).toBe('from data');
    expect(formatCiStepLogLine({ line: 'from line' })).toBe('from line');
    expect(formatCiStepLogLine({ message: 'from message' })).toBe('from message');
    expect(formatCiStepLogLine({ nested: true })).toBe('{"nested":true}');
  });

  it('nests each step under its parent job for a matrix run', async () => {
    const matrixRun = {
      ...runs[0],
      id: 'run-3',
      jobs: [
        {
          job_id: 'e2e',
          matrix_key: 'shard-1',
          state: 'passed',
          exit_code: 0,
          started_at: 1,
          ended_at: 2,
        },
        {
          job_id: 'e2e',
          matrix_key: 'shard-2',
          state: 'failed',
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
          state: 'passed',
          exit_code: 0,
          started_at: 1,
          ended_at: 2,
          job_id: 'e2e',
          matrix_key: 'shard-1',
        },
        {
          step_index: 2,
          name: 'e2e / shard-2 / cypress',
          state: 'failed',
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

  it('shows a green check for passed jobs/steps and a red X for failed (not the gray "never ran" circle)', async () => {
    // Regression: the runner writes job/step state as passed|failed|skipped,
    // but the icon map only knew success/failure, so finished jobs fell
    // through to the dashed "pending" circle and looked like they never ran.
    const mixedRun = {
      ...runs[0],
      id: 'run-mixed',
      jobs: [
        { job_id: 'backend', matrix_key: 'default', state: 'passed', exit_code: 0 },
        { job_id: 'frontend', matrix_key: 'default', state: 'failed', exit_code: 1 },
        { job_id: 'e2e', matrix_key: 'default', state: 'running', exit_code: null },
      ],
    };
    (api.getCiRuns as any).mockResolvedValue({ runs: [mixedRun] });
    (api.getCiRunDetail as any).mockResolvedValue({
      run: mixedRun,
      steps: [
        {
          step_index: 1,
          name: 'backend / default / test',
          state: 'passed',
          exit_code: 0,
          job_id: 'backend',
          matrix_key: 'default',
        },
        {
          step_index: 2,
          name: 'frontend / default / build',
          state: 'failed',
          exit_code: 1,
          job_id: 'frontend',
          matrix_key: 'default',
        },
      ],
    });
    render(<CiRunsSection project={hostedProject} />);
    fireEvent.click(await screen.findByTestId('ci-run-run-mixed' as any));
    await waitFor(() => expect(api.getCiRunDetail).toHaveBeenCalledWith('proj-1', 'run-mixed'));

    // Passed job header + its passed step both render the check glyph; failed
    // both render the X. None render as "pending" (the regression symptom).
    const passed = await screen.findAllByLabelText('passed');
    const failed = await screen.findAllByLabelText('failed');
    expect(passed.length).toBeGreaterThanOrEqual(2); // backend job + its step
    expect(failed.length).toBeGreaterThanOrEqual(2); // frontend job + its step
    expect(screen.getByLabelText('running')).toBeInTheDocument(); // e2e job
    expect(screen.queryByLabelText('pending')).toBeNull();
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

  it('shows a Stop-all control only on live (non-terminal) runs', async () => {
    render(<CiRunsSection project={hostedProject} />);
    // run-3 is `running` → stoppable; run-1 (succeeded) and run-2 (failed) are terminal.
    expect(await screen.findByTestId('ci-run-stop-run-3')).toBeInTheDocument();
    expect(screen.queryByTestId('ci-run-stop-run-1')).toBeNull();
    expect(screen.queryByTestId('ci-run-stop-run-2')).toBeNull();
  });

  it('keeps the Stop-all control on a terminal run while a job is still running', async () => {
    // Regression: the run-level status flips to `failed` the moment one shard
    // goes red, but other shards keep running. The Stop button must stay so the
    // still-running jobs can be terminated. Previously `stoppable` keyed only on
    // run.status, so the button vanished while tests were still executing.
    const partiallyFailedRun = {
      id: 'run-partial',
      branch: 'agent-hub/dev/session-partial',
      head_sha: 'd'.repeat(40),
      status: 'failed',
      mode: 'full',
      trigger_source: 'ui_button',
      failure_reason: 'checks_failed',
      started_at: Date.now() - 30_000,
      ended_at: null,
      jobs: [
        { job_id: 'unit', matrix_key: 'default', state: 'failed', exit_code: 1 },
        { job_id: 'e2e', matrix_key: 'shard-1', state: 'running', exit_code: null },
      ],
    };
    (api.getCiRuns as any).mockResolvedValue({ runs: [partiallyFailedRun] });
    render(<CiRunsSection project={hostedProject} />);
    expect(await screen.findByTestId('ci-run-stop-run-partial')).toBeInTheDocument();
  });

  it('hides Re-run (but keeps Stop) on a push run that is failed-but-still-running', async () => {
    // Regression: `rerunnable` keyed only on run.status, so a push/pr run whose
    // status flipped to `failed` from one red shard — while other shards were
    // still queued/running — exposed Re-run. Clicking it would start a
    // duplicate CI run before the current one settled. Rerun must wait until
    // the run has no work in flight; Stop stays available meanwhile.
    const pushPartial = {
      id: 'run-push-partial',
      branch: 'main',
      head_sha: 'e'.repeat(40),
      status: 'failed',
      mode: 'checks',
      trigger_source: 'git_push',
      failure_reason: 'checks_failed',
      started_at: Date.now() - 30_000,
      ended_at: null,
      jobs: [
        { job_id: 'unit', matrix_key: 'default', state: 'failed', exit_code: 1 },
        { job_id: 'e2e', matrix_key: 'shard-1', state: 'running', exit_code: null },
      ],
    };
    (api.getCiRuns as any).mockResolvedValue({ runs: [pushPartial] });
    render(<CiRunsSection project={hostedProject} />);
    expect(await screen.findByTestId('ci-run-stop-run-push-partial')).toBeInTheDocument();
    expect(screen.queryByTestId('ci-run-rerun-run-push-partial')).toBeNull();
  });

  it('shows Re-run on a fully-settled push run', async () => {
    const pushSettled = {
      id: 'run-push-done',
      branch: 'main',
      head_sha: 'f'.repeat(40),
      status: 'failed',
      mode: 'checks',
      trigger_source: 'git_push',
      failure_reason: 'checks_failed',
      started_at: Date.now() - 60_000,
      ended_at: Date.now() - 30_000,
      jobs: [
        { job_id: 'unit', matrix_key: 'default', state: 'failed', exit_code: 1 },
        { job_id: 'e2e', matrix_key: 'shard-1', state: 'passed', exit_code: 0 },
      ],
    };
    (api.getCiRuns as any).mockResolvedValue({ runs: [pushSettled] });
    render(<CiRunsSection project={hostedProject} />);
    expect(await screen.findByTestId('ci-run-rerun-run-push-done')).toBeInTheDocument();
    expect(screen.queryByTestId('ci-run-stop-run-push-done')).toBeNull();
  });

  it('runHasWorkInFlight: terminal status with an in-flight job is still live', () => {
    expect(
      runHasWorkInFlight({ status: 'failed', jobs: [{ state: 'running' }, { state: 'failed' }] }),
    ).toBe(true);
    expect(runHasWorkInFlight({ status: 'failed', jobs: [{ state: 'queued' }] })).toBe(true);
    // Fully terminal: status terminal and every job settled.
    expect(
      runHasWorkInFlight({ status: 'failed', jobs: [{ state: 'failed' }, { state: 'passed' }] }),
    ).toBe(false);
    expect(runHasWorkInFlight({ status: 'succeeded', jobs: [] })).toBe(false);
    // Non-terminal run status is always live, jobs notwithstanding.
    expect(runHasWorkInFlight({ status: 'running', jobs: [] })).toBe(true);
  });

  it('Stop-all cancels the run without expanding the row', async () => {
    (api.cancelFinalizeRun as any).mockResolvedValue({ ok: true, status: 'cancelled' });
    render(<CiRunsSection project={hostedProject} />);

    fireEvent.click(await screen.findByTestId('ci-run-stop-run-3' as any));
    await waitFor(() => expect(api.cancelFinalizeRun).toHaveBeenCalledWith('proj-1', 'run-3'));
    // The click must not bubble to the row toggle (which would fetch detail).
    expect(api.getCiRunDetail).not.toHaveBeenCalled();
  });
});
