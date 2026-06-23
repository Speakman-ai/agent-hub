import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ProjectLandingHandoff, {
  pickTopFindings,
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
    report: {
      projectId: 'proj-1',
      score: 72,
      categories: [
        { id: 'lint', label: 'Lint', status: 'ok' },
        { id: 'tests', label: 'Tests', status: 'warn' },
      ],
      findings: [
        { id: 'f1', severity: 'warn', message: 'Tests missing for auth route' },
        { id: 'f2', severity: 'info', message: 'Consider enabling Prettier' },
      ],
      gaps: [],
    },
    roster: [
      { trackId: 'architect', label: 'Architect', agentId: 'hub-lead', custom: false },
      { trackId: 'frontend', label: 'Frontend', agentId: null, custom: false },
    ],
    agents: [
      { id: 'hub-lead', name: 'Hub Lead' },
      { id: 'hub-frontend', name: 'Hub Frontend' },
    ],
    ...overrides,
  };
}

describe('ProjectLandingHandoff — pure helpers', () => {
  it('pickTopFindings sorts by severity and limits to max', () => {
    const findings = [
      { id: 'a', severity: 'info', message: 'i' },
      { id: 'b', severity: 'error', message: 'e' },
      { id: 'c', severity: 'warn', message: 'w' },
      { id: 'd', severity: 'error', message: 'e2' },
    ];
    const top = pickTopFindings(findings, 3);
    expect(top.map((f: any) => f.id)).toEqual(['b', 'd', 'c']);
  });

  it('pickTopFindings returns [] on empty input', () => {
    expect(pickTopFindings([])).toEqual([]);
  });

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
  it('renders project name, repo link, and band chip', () => {
    render(<ProjectLandingHandoff {...defaultProps()} />);
    expect(screen.getByTestId('project-landing')).toHaveAttribute('data-audit-band', 'amber');
    expect(screen.getByText(/My Cool App/)).toBeInTheDocument();
    const repo = screen.getByTestId('pl-repo-link');
    expect(repo!).toHaveAttribute('href', 'https://github.com/acme/my-cool-app');
    expect((repo as any).textContent).toContain('github.com/acme/my-cool-app');
    expect((screen.getByTestId('pl-summary-band') as any).textContent).toMatch(/Needs work/);
    expect((screen.getByTestId('pl-summary-band') as any).textContent).toMatch(/72/);
  });

  it('shows stack and integrations as chips', () => {
    render(<ProjectLandingHandoff {...defaultProps()} />);
    expect((screen.getByTestId('pl-stack') as any).textContent).toMatch(/React/);
    expect((screen.getByTestId('pl-stack') as any).textContent).toMatch(/Node\.js/);
    expect((screen.getByTestId('pl-integrations') as any).textContent).toMatch(/GitHub/);
    expect((screen.getByTestId('pl-integrations') as any).textContent).toMatch(/Database/);
    expect((screen.getByTestId('pl-apptype') as any).textContent).toBe('Web app');
  });

  it('renders audit highlights with top findings sorted by severity', () => {
    render(<ProjectLandingHandoff {...defaultProps()} />);
    const highlights = screen.getByTestId('pl-audit-highlights');
    // warn comes before info
    const items = highlights.querySelectorAll('[data-testid^="pl-finding-"]');
    expect(items.length).toBe(2);
    expect(items[0].getAttribute('data-severity')).toBe('warn');
    expect(items[1].getAttribute('data-severity')).toBe('info');
  });

  it('shows a "clean" callout when the report has no findings', () => {
    render(
      <ProjectLandingHandoff
        {...defaultProps({
          report: { score: 95, categories: [], findings: [], gaps: [] },
        })}
      />,
    );
    expect(screen.getByTestId('pl-audit-clean')).toBeInTheDocument();
    expect(screen.queryByTestId('pl-audit-highlights')).not.toBeInTheDocument();
  });

  it('falls back to an "audit unavailable" strip when report is null', () => {
    render(<ProjectLandingHandoff {...defaultProps({ report: null })} />);
    expect(screen.getByTestId('pl-audit-unavailable')).toBeInTheDocument();
    // Next steps must still render — empty/error handoffs don't kill the page.
    expect(screen.getByTestId('pl-next-steps')).toBeInTheDocument();
  });

  it('handles a missing repo URL with a muted placeholder', () => {
    render(<ProjectLandingHandoff {...defaultProps({ repoUrl: null })} />);
    expect(screen.queryByTestId('pl-repo-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('pl-repo-none')).toBeInTheDocument();
  });

  it('renders roster rows with a Chat button only when an agent is assigned', () => {
    render(<ProjectLandingHandoff {...defaultProps()} />);
    expect(screen.getByTestId('pl-roster-row-architect')).toBeInTheDocument();
    expect(screen.getByTestId('pl-chat-architect')).toBeInTheDocument();
    // frontend row is unassigned → no Chat button, shows placeholder
    expect(screen.queryByTestId('pl-chat-frontend')).not.toBeInTheDocument();
    expect(screen.getByTestId('pl-roster-row-frontend-empty')).toBeInTheDocument();
  });

  it('collapses the roster panel to a muted message when empty', () => {
    render(<ProjectLandingHandoff {...defaultProps({ roster: [] })} />);
    expect(screen.getByTestId('pl-roster-empty')).toBeInTheDocument();
  });
});

describe('ProjectLandingHandoff — callbacks', () => {
  it('Chat button fires onStartChat with agentId + trackId', () => {
    const onStartChat = vi.fn();
    render(<ProjectLandingHandoff {...defaultProps()} onStartChat={onStartChat} />);
    fireEvent.click(screen.getByTestId('pl-chat-architect' as any) as any);
    expect(onStartChat!).toHaveBeenCalledWith({
      projectId: 'proj-1',
      agentId: 'hub-lead',
      trackId: 'architect',
    });
  });

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

  it('primary "Brief {lead}" CTA surfaces when a preferred lead track is assigned', () => {
    const onStartChat = vi.fn();
    render(<ProjectLandingHandoff {...defaultProps()} onStartChat={onStartChat} />);
    const brief = screen.getByTestId('pl-next-chat-lead');
    expect((brief as any).textContent).toMatch(/Hub Lead/);
    fireEvent.click(brief as any);
    expect(onStartChat!).toHaveBeenCalledWith({
      projectId: 'proj-1',
      agentId: 'hub-lead',
      trackId: 'architect',
    });
  });

  it('omits the "Brief lead" CTA when no roster row has an agent', () => {
    render(
      <ProjectLandingHandoff
        {...defaultProps({
          roster: [{ trackId: 'architect', label: 'Architect', agentId: null }],
        })}
      />,
    );
    expect(screen.queryByTestId('pl-next-chat-lead')).not.toBeInTheDocument();
    // The remaining three starter-task buttons still render.
    expect(screen.getByTestId('pl-next-kanban')).toBeInTheDocument();
    expect(screen.getByTestId('pl-next-skills')).toBeInTheDocument();
    expect(screen.getByTestId('pl-next-open')).toBeInTheDocument();
  });

  it('close button fires onClose', () => {
    const onClose = vi.fn();
    render(<ProjectLandingHandoff {...defaultProps()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('pl-close' as any) as any);
    expect(onClose!).toHaveBeenCalledTimes(1);
  });
});
