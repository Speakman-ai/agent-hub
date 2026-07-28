import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ProjectLandingHandoff, {
  normalizeIntegrations,
  summarizeStack,
} from './ProjectLandingHandoff';

function defaultProps(overrides: any = {}) {
  return {
    projectId: 'proj-1',
    projectName: 'My Cool App',
    repoUrl: 'https://github.com/acme/my-cool-app',
    payload: {
      name: 'My Cool App',
      appType: 'web-app',
      stack: { frontend: 'React', backend: 'Node.js' },
      integrations: ['github', 'db'],
    },
    ...overrides,
  };
}

describe('ProjectLandingHandoff — pure helpers', () => {
  it('normalizeIntegrations handles idk / null / arrays', () => {
    expect(normalizeIntegrations('idk')).toEqual([]);
    expect(normalizeIntegrations(null)).toEqual([]);
    expect(normalizeIntegrations([])).toEqual([]);
    expect(normalizeIntegrations(['github', 'slack'])).toEqual(['GitHub', 'Slack']);
  });

  it('summarizeStack handles object / array / string / idk', () => {
    expect(summarizeStack(null)).toEqual([]);
    expect(summarizeStack({ stack: 'idk' })).toEqual([]);
    expect(summarizeStack({ stack: 'React' })).toEqual(['React']);
    expect(summarizeStack({ stack: ['React', 'Node.js'] })).toEqual(['React', 'Node.js']);
    expect(summarizeStack({ stack: { frontend: 'React', backend: 'idk' } })).toEqual(['React']);
  });
});

describe('ProjectLandingHandoff — rendering', () => {
  it('renders project name and repo link', () => {
    render(<ProjectLandingHandoff {...defaultProps()} />);
    expect(screen.getByTestId('project-landing')).toBeInTheDocument();
    expect(screen.getByText(/My Cool App/)).toBeInTheDocument();
    const repo = screen.getByTestId('pl-repo-link');
    expect(repo!).toHaveAttribute('href', 'https://github.com/acme/my-cool-app');
    expect((repo as any).textContent).toContain('github.com/acme/my-cool-app');
  });

  it('shows stack and integrations as chips', () => {
    render(<ProjectLandingHandoff {...defaultProps()} />);
    expect((screen.getByTestId('pl-stack') as any).textContent).toMatch(/React/);
    expect((screen.getByTestId('pl-stack') as any).textContent).toMatch(/Node\.js/);
    expect((screen.getByTestId('pl-integrations') as any).textContent).toMatch(/GitHub/);
    expect((screen.getByTestId('pl-integrations') as any).textContent).toMatch(/Database/);
    expect((screen.getByTestId('pl-apptype') as any).textContent).toBe('Web app');
  });

  it('handles a missing repo URL with a muted placeholder', () => {
    render(<ProjectLandingHandoff {...defaultProps({ repoUrl: null })} />);
    expect(screen.queryByTestId('pl-repo-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('pl-repo-none')).toBeInTheDocument();
  });

  // Regression: the readiness/roster step that fed this page its audit
  // report and per-track agents is gone. Both panels could only ever render
  // their empty states, so neither may come back.
  it('renders no audit or roster surface', () => {
    render(<ProjectLandingHandoff {...defaultProps()} />);
    expect(screen.getByTestId('project-landing')).not.toHaveAttribute('data-audit-band');
    expect(screen.queryByTestId('pl-summary-band')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pl-audit-highlights')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pl-audit-clean')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pl-audit-unavailable')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pl-roster')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pl-next-chat-lead')).not.toBeInTheDocument();
    // Next steps still render — the page stays useful without them.
    expect(screen.getByTestId('pl-next-steps')).toBeInTheDocument();
  });
});

describe('ProjectLandingHandoff — callbacks', () => {
  it('Open-project CTA fires onOpenProject with projectId + repoUrl', () => {
    const onOpenProject = vi.fn();
    render(<ProjectLandingHandoff {...defaultProps()} onOpenProject={onOpenProject} />);
    fireEvent.click(screen.getByTestId('pl-next-open' as any) as any);
    expect(onOpenProject!).toHaveBeenCalledWith({
      projectId: 'proj-1',
      repoUrl: 'https://github.com/acme/my-cool-app',
    });
  });

  it('Starter-task CTAs fire onOpenStarterTask with task.type', () => {
    const onOpenStarterTask = vi.fn();
    render(<ProjectLandingHandoff {...defaultProps()} onOpenStarterTask={onOpenStarterTask} />);
    fireEvent.click(screen.getByTestId('pl-next-kanban' as any) as any);
    expect(onOpenStarterTask!).toHaveBeenCalledWith({
      projectId: 'proj-1',
      task: { type: 'kanban' },
    });
    fireEvent.click(screen.getByTestId('pl-next-skills' as any) as any);
    expect(onOpenStarterTask!).toHaveBeenCalledWith({
      projectId: 'proj-1',
      task: { type: 'skills' },
    });
  });

  it('close button fires onClose', () => {
    const onClose = vi.fn();
    render(<ProjectLandingHandoff {...defaultProps()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('pl-close' as any) as any);
    expect(onClose!).toHaveBeenCalledTimes(1);
  });
});
