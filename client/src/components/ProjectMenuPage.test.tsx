import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProjectMenuPage from './ProjectMenuPage';

(vi as any).mock('./SettingsPage.jsx', () => ({
  AgentConfigSection: () => <div data-testid="agent-config-section" />,
  ProjectsSection: () => <div data-testid="projects-section" />,
  CronSection: () => <div data-testid="cron-section" />,
  HeartbeatSection: () => <div data-testid="heartbeat-section" />,
}));

describe('ProjectMenuPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseProps = {
    projectId: 'p1',
    project: { id: 'p1', name: 'Acme', color: '#ff0000' },
    projects: [{ id: 'p1', name: 'Acme', color: '#ff0000', cwd: '/tmp', agents: [] }],
    agents: [],
    onAgentsChange: vi.fn(),
    onProjectsChange: vi.fn(),
    onNavigate: vi.fn(),
    showToast: vi.fn(),
  };

  it('renders Agents section for agents tab', () => {
    render(<ProjectMenuPage {...baseProps} tab="agents" />);
    expect(screen.getByTestId('agent-config-section')).toBeInTheDocument();
    expect(screen.getByText(/Acme Menu/)).toBeInTheDocument();
  });

  it('renders Project settings section for settings tab', () => {
    render(<ProjectMenuPage {...baseProps} tab="settings" />);
    expect(screen.getByTestId('projects-section')).toBeInTheDocument();
    expect(screen.getByText('Project settings')).toBeInTheDocument();
  });

  it('renders Cron section for crons tab', () => {
    render(<ProjectMenuPage {...baseProps} tab="crons" />);
    expect(screen.getByTestId('cron-section')).toBeInTheDocument();
    expect(screen.getByText('Cron Jobs')).toBeInTheDocument();
  });

  it('renders Heartbeats section for heartbeats tab', () => {
    render(<ProjectMenuPage {...baseProps} tab="heartbeats" />);
    expect(screen.getByTestId('heartbeat-section')).toBeInTheDocument();
    expect(screen.getByText('Heartbeats')).toBeInTheDocument();
  });
});
