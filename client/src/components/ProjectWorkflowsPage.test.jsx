import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import ProjectWorkflowsPage from './ProjectWorkflowsPage.jsx';
import { api } from '../utils/api.js';

vi.mock('./WorkflowRunsSection.jsx', () => ({
  default: function MockWorkflowRunsSection() {
    return <div data-testid="workflow-runs-section-mock" />;
  },
}));

vi.mock('../utils/api.js', () => ({
  api: {
    getProjectWorkflows: vi.fn(),
    getWorkflowRuns: vi.fn(),
    getWorkflowRunDetail: vi.fn(),
    startWorkflowRun: vi.fn(),
  },
}));

describe('ProjectWorkflowsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders workflow name and run control after load', async () => {
    api.getProjectWorkflows.mockResolvedValue([
      {
        id: 'wf-1',
        name: 'Ship it',
        steps: [{ id: 's1', title: 'Build', step_order: 0 }],
      },
    ]);
    api.getWorkflowRuns.mockResolvedValue([]);
    const onNavigate = vi.fn();
    const onSelectAgent = vi.fn();

    render(
      <ProjectWorkflowsPage
        projectId="p1"
        project={{ id: 'p1', name: 'Demo', color: '#f00', agents: [{ id: 'a1', active: true }] }}
        onNavigate={onNavigate}
        onSelectAgent={onSelectAgent}
        showToast={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Ship it')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Run/i })).toBeInTheDocument();
  });

  it('starts a run when Run is clicked', async () => {
    api.getProjectWorkflows.mockResolvedValue([{ id: 'wf-1', name: 'W', steps: [] }]);
    api.getWorkflowRuns.mockResolvedValue([]);
    api.startWorkflowRun.mockResolvedValue({ id: 'r1', status: 'pending' });

    render(
      <ProjectWorkflowsPage
        projectId="p1"
        project={{ id: 'p1', name: 'Demo', agents: [] }}
        onNavigate={vi.fn()}
        onSelectAgent={vi.fn()}
        showToast={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('W')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => {
      expect(api.startWorkflowRun).toHaveBeenCalledWith('p1', 'wf-1');
    });
  });

  it('GitHub opens Settings → Projects with expandProjectId', async () => {
    api.getProjectWorkflows.mockResolvedValue([{ id: 'wf-1', name: 'W', steps: [] }]);
    api.getWorkflowRuns.mockResolvedValue([]);
    const onNavigate = vi.fn();

    render(
      <ProjectWorkflowsPage
        projectId="p1"
        project={{ id: 'p1', name: 'Demo', agents: [] }}
        onNavigate={onNavigate}
        onSelectAgent={vi.fn()}
        showToast={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('W')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^GitHub$/i }));
    // The Settings → Projects tab now hosts per-project repo + workflow config
    // (split out of the GitHub tab so the connected GitHub account isn't
    // crowded by the project list).
    expect(onNavigate).toHaveBeenCalledWith('project-settings:p1');
  });

  it('Builder navigates to workflow editor view', async () => {
    api.getProjectWorkflows.mockResolvedValue([{ id: 'wf-1', name: 'W', steps: [] }]);
    api.getWorkflowRuns.mockResolvedValue([]);
    const onNavigate = vi.fn();

    render(
      <ProjectWorkflowsPage
        projectId="p1"
        project={{ id: 'p1', name: 'Demo', agents: [] }}
        onNavigate={onNavigate}
        onSelectAgent={vi.fn()}
        showToast={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('W')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Builder$/i }));
    expect(onNavigate).toHaveBeenCalledWith('workflow-edit:p1/wf-1');
  });

  it('debounces workflow WebSocket refetches for the same project', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.getProjectWorkflows.mockResolvedValue([{ id: 'wf-1', name: 'W', steps: [] }]);
      api.getWorkflowRuns.mockResolvedValue([]);

      render(
        <ProjectWorkflowsPage
          projectId="p1"
          project={{ id: 'p1', name: 'Demo', agents: [] }}
          onNavigate={vi.fn()}
          onSelectAgent={vi.fn()}
          showToast={vi.fn()}
        />,
      );

      await waitFor(() => expect(api.getProjectWorkflows).toHaveBeenCalledTimes(1));

      await act(async () => {
        for (let k = 0; k < 5; k += 1) {
          window.dispatchEvent(
            new CustomEvent('agenthub-workflow-ws', {
              detail: { projectId: 'p1', workflowId: 'wf-1' },
            }),
          );
        }
      });
      expect(api.getProjectWorkflows).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(450);
      });
      await waitFor(() => expect(api.getProjectWorkflows).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders monitor embed using mocked WorkflowRunsSection', async () => {
    api.getProjectWorkflows.mockResolvedValue([{ id: 'wf-1', name: 'W', steps: [] }]);
    api.getWorkflowRuns.mockResolvedValue([]);

    render(
      <ProjectWorkflowsPage
        projectId="p1"
        project={{ id: 'p1', name: 'Demo', agents: [] }}
        onNavigate={vi.fn()}
        onSelectAgent={vi.fn()}
        showToast={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('W')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Monitor$/i }));
    expect(await screen.findByTestId('workflow-runs-section-mock')).toBeInTheDocument();
  });
});
