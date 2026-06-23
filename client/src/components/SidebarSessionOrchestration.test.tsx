import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SidebarSessionOrchestration from './SidebarSessionOrchestration';

describe('SidebarSessionOrchestration', () => {
  it('renders nothing without onOrchestrationSave', () => {
    const { container } = render(
      <SidebarSessionOrchestration session={{ id: 's1' }} onOrchestrationSave={null} />,
    );
    expect(container!.firstChild).toBeNull();
  });

  it('shows outer orchestration section when save handler is provided', () => {
    render(
      <SidebarSessionOrchestration
        session={{ id: 's1', orchestration_phase: 'acting' }}
        onOrchestrationSave={async () => {}}
        showToast={null}
      />,
    );
    expect(screen.getByText('Outer orchestration')).toBeInTheDocument();
  });
});
