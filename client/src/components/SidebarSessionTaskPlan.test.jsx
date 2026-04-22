import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SidebarSessionTaskPlan from './SidebarSessionTaskPlan.jsx';

describe('SidebarSessionTaskPlan', () => {
  it('shows placeholder when task_state is empty', () => {
    render(
      <SidebarSessionTaskPlan
        session={{ id: 's1', task_state_json: null }}
        onOrchestrationSave={null}
        showToast={null}
      />,
    );
    expect(screen.getByText('Task plan')).toBeInTheDocument();
    expect(screen.getByText(/The model maintains this automatically/i)).toBeInTheDocument();
  });

  it('renders goal and checklist read-only', () => {
    const task_state_json = JSON.stringify({
      goal: 'Ship fix',
      checklist: [
        { text: 'Test', done: true },
        { text: 'Patch', done: false },
      ],
    });
    render(
      <SidebarSessionTaskPlan
        session={{ id: 's2', task_state_json }}
        onOrchestrationSave={null}
        showToast={null}
      />,
    );
    expect(screen.getByText('Ship fix')).toBeInTheDocument();
    expect(screen.getByText('Test')).toBeInTheDocument();
    expect(screen.getByText('Patch')).toBeInTheDocument();
  });

  it('renders nothing without session id', () => {
    const { container } = render(
      <SidebarSessionTaskPlan session={null} onOrchestrationSave={null} showToast={null} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
