import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import WorkflowRunsSection from './WorkflowRunsSection.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getProjectWorkflows: vi.fn(),
    getWorkflowRuns: vi.fn(),
    getWorkflowRunDetail: vi.fn(),
    startWorkflowRun: vi.fn(),
    cancelWorkflowRun: vi.fn(),
  },
}));

describe('WorkflowRunsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders timeline and progress for selected run detail', async () => {
    api.getProjectWorkflows.mockResolvedValue([
      {
        id: 'wf-1',
        name: 'Release',
        steps: [
          { id: 's1', title: 'Build', step_order: 0 },
          { id: 's2', title: 'Ship', step_order: 1 },
        ],
      },
    ]);
    api.getWorkflowRuns.mockResolvedValue([{ id: 'run-aa', status: 'running' }]);
    api.getWorkflowRunDetail.mockResolvedValue({
      run: { id: 'run-aa', status: 'running', error: null },
      step_runs: [
        {
          workflow_step_id: 's1',
          status: 'success',
          output: 'built',
          step_title: 'Build',
          step_order: 0,
        },
        {
          workflow_step_id: 's2',
          status: 'running',
          output: null,
          step_title: 'Ship',
          step_order: 1,
        },
      ],
    });

    render(<WorkflowRunsSection projectId="p1" embedWorkflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText('Progress')).toBeInTheDocument();
    });
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '2');
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('Ship')).toBeInTheDocument();
    expect(screen.getByText(/Active · Ship/i)).toBeInTheDocument();
    expect(screen.getByText(/Output is written when this step completes/i)).toBeInTheDocument();
  });

  it('shows run-level error banner and failed step on error', async () => {
    api.getProjectWorkflows.mockResolvedValue([
      {
        id: 'wf-1',
        name: 'W',
        steps: [{ id: 's1', title: 'Step one', step_order: 0 }],
      },
    ]);
    api.getWorkflowRuns.mockResolvedValue([{ id: 'run-e', status: 'error' }]);
    api.getWorkflowRunDetail.mockResolvedValue({
      run: { id: 'run-e', status: 'error', error: 'Run stopped' },
      step_runs: [
        {
          workflow_step_id: 's1',
          status: 'error',
          output: null,
          error: 'CLI timeout',
          step_title: 'Step one',
          step_order: 0,
        },
      ],
    });

    render(<WorkflowRunsSection projectId="p1" embedWorkflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText('Run stopped')).toBeInTheDocument();
    });
    expect(screen.getByText('CLI timeout')).toBeInTheDocument();
    expect(screen.getByText(/No stdout captured for this step/i)).toBeInTheDocument();
  });

  it('does not call setError when an older getWorkflowRunDetail rejects after a newer fetch', async () => {
    let rejectFirst;
    const firstPending = new Promise((_res, rej) => {
      rejectFirst = rej;
    });

    api.getProjectWorkflows.mockResolvedValue([
      { id: 'wf-1', name: 'W', steps: [{ id: 's1', title: 'X', step_order: 0 }] },
    ]);
    api.getWorkflowRuns.mockResolvedValue([
      { id: 'runone11', status: 'success' },
      { id: 'runtwo22', status: 'success' },
    ]);

    api.getWorkflowRunDetail
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValue({
        run: { id: 'runtwo22', status: 'success', error: null },
        step_runs: [],
      });

    render(<WorkflowRunsSection projectId="p1" embedWorkflowId="wf-1" />);

    await waitFor(() => screen.getByRole('button', { name: /runone11/i }));

    fireEvent.click(screen.getByRole('button', { name: /runtwo22/i }));

    await waitFor(() =>
      expect(api.getWorkflowRunDetail.mock.calls.length).toBeGreaterThanOrEqual(2),
    );

    await act(async () => {
      rejectFirst(new Error('stale-failure-should-not-banner'));
    });

    await waitFor(() => {
      expect(screen.queryByText(/stale-failure-should-not-banner/i)).not.toBeInTheDocument();
    });
  });

  it('ignores stale getWorkflowRunDetail after switching runs', async () => {
    api.getProjectWorkflows.mockResolvedValue([
      {
        id: 'wf-1',
        name: 'W',
        steps: [{ id: 's1', title: 'Only', step_order: 0 }],
      },
    ]);
    api.getWorkflowRuns.mockResolvedValue([
      { id: 'run-axxx', status: 'success' },
      { id: 'run-byyy', status: 'success' },
    ]);

    const pending = [];
    api.getWorkflowRunDetail.mockImplementation(() => {
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    });

    render(<WorkflowRunsSection projectId="p1" embedWorkflowId="wf-1" />);

    await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(1));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run-byyy/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /run-byyy/i }));

    await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(2));

    const runBDetail = {
      run: { id: 'run-byyy', status: 'success', error: null },
      step_runs: [
        {
          workflow_step_id: 's1',
          status: 'success',
          output: 'from-b',
          step_title: 'Only',
          step_order: 0,
        },
      ],
    };
    const runADetail = {
      run: { id: 'run-axxx', status: 'error', error: 'stale-should-not-show' },
      step_runs: [],
    };

    await act(async () => {
      pending[1](runBDetail);
    });

    await waitFor(() => {
      expect(screen.getByText('from-b')).toBeInTheDocument();
    });

    await act(async () => {
      pending[0](runADetail);
    });

    await waitFor(() => {
      expect(screen.queryByText('stale-should-not-show')).not.toBeInTheDocument();
    });
    expect(screen.getByText('from-b')).toBeInTheDocument();
  });

  it('clears detail output when switching runs before the new detail resolves', async () => {
    let resolveB;
    const detailBPending = new Promise((res) => {
      resolveB = res;
    });

    api.getProjectWorkflows.mockResolvedValue([
      {
        id: 'wf-1',
        name: 'W',
        steps: [{ id: 's1', title: 'Step', step_order: 0 }],
      },
    ]);
    api.getWorkflowRuns.mockResolvedValue([
      { id: 'runaaa11', status: 'success' },
      { id: 'runbbb22', status: 'success' },
    ]);

    const detailBResolved = {
      run: { id: 'runbbb22', status: 'success', error: null },
      step_runs: [
        {
          workflow_step_id: 's1',
          status: 'success',
          output: 'BBB-OUT',
          step_title: 'Step',
          step_order: 0,
        },
      ],
    };

    api.getWorkflowRunDetail
      .mockResolvedValueOnce({
        run: { id: 'runaaa11', status: 'success', error: null },
        step_runs: [
          {
            workflow_step_id: 's1',
            status: 'success',
            output: 'AAA-UNIQUE-OUTPUT',
            step_title: 'Step',
            step_order: 0,
          },
        ],
      })
      .mockImplementationOnce(() => detailBPending)
      .mockResolvedValue(detailBResolved);

    render(<WorkflowRunsSection projectId="p1" embedWorkflowId="wf-1" />);

    await waitFor(() => expect(screen.getByText('AAA-UNIQUE-OUTPUT')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /runbbb22/i }));

    expect(screen.queryByText('AAA-UNIQUE-OUTPUT')).not.toBeInTheDocument();

    await act(async () => {
      resolveB(detailBResolved);
    });

    await waitFor(() => expect(screen.getByText('BBB-OUT')).toBeInTheDocument());
  });

  it('does not keep prior workflow runs selected while the next list is loading', async () => {
    let resolveWf2;
    const wf2Promise = new Promise((res) => {
      resolveWf2 = res;
    });

    api.getProjectWorkflows.mockResolvedValue([
      { id: 'wf-1', name: 'First WF', steps: [] },
      { id: 'wf-2', name: 'Second WF', steps: [] },
    ]);

    api.getWorkflowRuns.mockImplementation((_pid, wid) => {
      if (wid === 'wf-1') {
        return Promise.resolve([{ id: 'runone11', status: 'success' }]);
      }
      if (wid === 'wf-2') {
        return wf2Promise;
      }
      return Promise.resolve([]);
    });

    api.getWorkflowRunDetail.mockResolvedValue({
      run: { id: 'runone11', status: 'success', error: null },
      step_runs: [],
    });

    render(<WorkflowRunsSection projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: /Hub workflow runs/i }));

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /runone11/i })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wf-2' } });

    expect(screen.queryByRole('button', { name: /runone11/i })).not.toBeInTheDocument();
    expect(api.getWorkflowRunDetail).not.toHaveBeenCalledWith('p1', 'wf-2', 'runone11');

    await act(async () => {
      resolveWf2([{ id: 'runtwo22', status: 'success' }]);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /runtwo22/i })).toBeInTheDocument();
    });
  });

  it('omits progressbar role when the workflow defines zero steps', async () => {
    api.getProjectWorkflows.mockResolvedValue([{ id: 'wf-1', name: 'W', steps: [] }]);
    api.getWorkflowRuns.mockResolvedValue([{ id: 'runone11', status: 'success' }]);
    api.getWorkflowRunDetail.mockResolvedValue({
      run: { id: 'runone11', status: 'success', error: null },
      step_runs: [],
    });

    render(<WorkflowRunsSection projectId="p1" embedWorkflowId="wf-1" />);

    await waitFor(() => expect(screen.getByText(/0\/0 steps/i)).toBeInTheDocument());
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('clears list error after getWorkflowRuns succeeds following a failure', async () => {
    let n = 0;
    api.getProjectWorkflows.mockResolvedValue([{ id: 'wf-1', name: 'W', steps: [] }]);
    api.getWorkflowRuns.mockImplementation(() => {
      n += 1;
      if (n === 1) return Promise.reject(new Error('network blip'));
      return Promise.resolve([{ id: 'rrun1111', status: 'success' }]);
    });
    api.getWorkflowRunDetail.mockResolvedValue({
      run: { id: 'rrun1111', status: 'success', error: null },
      step_runs: [],
    });

    render(<WorkflowRunsSection projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: /Hub workflow runs/i }));

    await waitFor(() => expect(screen.getByText(/network blip/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/network blip/i)).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /rrun1111/i })).toBeInTheDocument();
    });
  });

  it('expands collapsible header when not embedded', async () => {
    api.getProjectWorkflows.mockResolvedValue([{ id: 'wf-1', name: 'W', steps: [] }]);
    api.getWorkflowRuns.mockResolvedValue([]);

    render(<WorkflowRunsSection projectId="p1" />);

    fireEvent.click(screen.getByRole('button', { name: /Hub workflow runs/i }));
    await waitFor(() => {
      expect(api.getProjectWorkflows).toHaveBeenCalled();
    });
  });
});
