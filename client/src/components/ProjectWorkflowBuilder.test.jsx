import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import ProjectWorkflowBuilder from './ProjectWorkflowBuilder.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getProjectWorkflow: vi.fn(),
    createProjectWorkflow: vi.fn(),
    updateProjectWorkflow: vi.fn(),
  },
}));

describe('ProjectWorkflowBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads workflow and marks dirty after name change', async () => {
    api.getProjectWorkflow.mockResolvedValue({
      id: 'wf-1',
      name: 'Ship',
      trigger_type: 'manual',
      default_payload: {},
      steps: [],
    });

    render(
      <ProjectWorkflowBuilder
        projectId="p1"
        workflowId="wf-1"
        project={{ id: 'p1', name: 'Proj' }}
        agents={[{ id: 'a1', projectId: 'p1', name: 'Bot', active: true }]}
        onNavigate={vi.fn()}
        showToast={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByDisplayValue('Ship')).toBeInTheDocument());
    expect(screen.queryByText(/Unsaved changes/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Ship'), { target: { value: 'Ship 2' } });
    expect(await screen.findByText(/Unsaved changes/i)).toBeInTheDocument();
  });

  it('discard restores baseline', async () => {
    api.getProjectWorkflow.mockResolvedValue({
      id: 'wf-1',
      name: 'One',
      trigger_type: 'manual',
      default_payload: {},
      steps: [],
    });

    render(
      <ProjectWorkflowBuilder
        projectId="p1"
        workflowId="wf-1"
        project={{ id: 'p1', name: 'Proj' }}
        agents={[]}
        onNavigate={vi.fn()}
        showToast={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByDisplayValue('One')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('One'), { target: { value: 'Two' } });
    expect(await screen.findByText(/Unsaved changes/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Discard$/i }));
    expect(screen.getByDisplayValue('One')).toBeInTheDocument();
    expect(screen.queryByText(/Unsaved changes/i)).not.toBeInTheDocument();
  });

  it('ignores stale getProjectWorkflow after workflowId changes', async () => {
    let slowResolve;
    api.getProjectWorkflow.mockImplementation((_pid, wid) => {
      if (wid === 'slow-wf') {
        return new Promise((resolve) => {
          slowResolve = () =>
            resolve({
              id: 'slow-wf',
              name: 'Stale',
              trigger_type: 'manual',
              default_payload: {},
              steps: [],
            });
        });
      }
      return Promise.resolve({
        id: 'fast-wf',
        name: 'Fresh',
        trigger_type: 'manual',
        default_payload: {},
        steps: [],
      });
    });

    const props = {
      projectId: 'p1',
      project: { id: 'p1', name: 'Proj' },
      agents: [],
      onNavigate: vi.fn(),
      showToast: vi.fn(),
    };

    const { rerender } = render(<ProjectWorkflowBuilder {...props} workflowId="slow-wf" />);

    rerender(<ProjectWorkflowBuilder {...props} workflowId="fast-wf" />);

    await waitFor(() => expect(screen.getByDisplayValue('Fresh')).toBeInTheDocument());

    await act(async () => {
      slowResolve?.();
    });

    expect(screen.getByDisplayValue('Fresh')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Stale')).not.toBeInTheDocument();
  });

  it('new workflow saves via POST and navigates', async () => {
    api.createProjectWorkflow.mockResolvedValue({
      id: 'new-wf',
      name: 'N',
      trigger_type: 'manual',
      steps: [],
    });

    const onNavigate = vi.fn();
    render(
      <ProjectWorkflowBuilder
        projectId="p1"
        workflowId="new"
        project={{ id: 'p1', name: 'Proj' }}
        agents={[{ id: 'a1', projectId: 'p1', name: 'Bot', active: true }]}
        onNavigate={onNavigate}
        showToast={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByDisplayValue('New workflow')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(api.createProjectWorkflow).toHaveBeenCalled());
    expect(onNavigate).toHaveBeenCalledWith('workflow-edit:p1/new-wf');
  });
});
