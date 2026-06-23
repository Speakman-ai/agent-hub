import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// Must be mocked before importing the component under test.
(vi as any).mock('../utils/api.js', () => ({
  api: {
    getSkills: vi.fn(),
    getContext: vi.fn(),
    getSkillOverrides: vi.fn(),
    getSkill: vi.fn(),
    toggleSkill: vi.fn(),
    uninstallSkill: vi.fn(),
    saveContext: vi.fn(),
    getSkillCredentials: vi.fn(),
    createProjectSkill: vi.fn(),
    createGlobalSkill: vi.fn(),
    updateProjectSkill: vi.fn(),
    updateGlobalSkill: vi.fn(),
    deleteGlobalSkill: vi.fn(),
    getGlobalSkill: vi.fn(),
  },
}));

import SkillsPage from './SkillsPage';
import { api } from '../utils/api';

const AGENT = {
  id: 'hub-frontend',
  name: 'Hub Frontend',
  color: '#22d3ee',
  workspace: '/tmp/agent-hub/hub-frontend',
} as Record<string, any>;
const PROJECTS = [
  {
    id: 'agent-hub',
    agents: [{ id: 'hub-frontend' }],
  },
];

describe('SkillsPage error surfacing', () => {
  beforeEach(() => {
    (api.getSkills as any).mockReset();
    (api.getContext as any).mockReset();
    (api.getSkillOverrides as any).mockReset();
    (api.getSkillOverrides as any).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** Flush pending microtasks so .then/.catch/.finally runs. */
  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders an inline error with the failure message when getSkills rejects', async () => {
    (api.getSkills as any).mockRejectedValue(new Error('500 Internal Server Error'));
    (api.getContext as any).mockResolvedValue({});

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    const alert = await screen.findByTestId('skills-load-error-skills');
    expect(alert!).toBeInTheDocument();
    expect((alert as any).textContent).toContain('Failed to load skills');
    expect((alert as any).textContent).toContain('500 Internal Server Error');
    expect((alert as any).textContent).toContain('Retry');

    // The misleading "No skills installed" empty state must NOT render
    // alongside the error — we want the user to see the cause.
    expect(screen.queryByText('No skills installed')).not.toBeInTheDocument();
  });

  it('renders an inline error when getContext rejects, separately from skills', async () => {
    (api.getSkills as any).mockResolvedValue([]);
    (api.getContext as any).mockRejectedValue(new Error('ENOENT: workspace missing'));

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    const alert = await screen.findByTestId('skills-load-error-context files');
    expect(alert!).toBeInTheDocument();
    expect((alert as any).textContent).toContain('Failed to load context files');
    expect((alert as any).textContent).toContain('ENOENT: workspace missing');
  });

  it('clicking Retry re-invokes getSkills and clears the error on success', async () => {
    (api.getSkills as any).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([]);
    (api.getContext as any).mockResolvedValue({});

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    const alert = await screen.findByTestId('skills-load-error-skills');
    const retryButton = alert.querySelector('button');
    expect(retryButton!).toBeTruthy();

    fireEvent.click(retryButton as any);
    await flush();

    // Second call resolved cleanly → error banner gone, calls = 2.
    expect(screen.queryByTestId('skills-load-error-skills')).not.toBeInTheDocument();
    expect(api.getSkills).toHaveBeenCalledTimes(2);
  });
});

describe('SkillsPage is skill management only', () => {
  beforeEach(() => {
    (api.getSkills as any).mockReset();
    (api.getContext as any).mockReset();
    (api.getSkillOverrides as any).mockReset();
    (api.getSkillOverrides as any).mockResolvedValue([]);
    (api.getSkills as any).mockResolvedValue([
      { id: 'kanban', name: 'Kanban', description: 'Manage cards', category: 'platform' },
    ]);
    (api.getContext as any).mockResolvedValue({ 'SOUL.md': '# soul' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders the Skills and Context Files sections', async () => {
    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    expect(screen.getByRole('heading', { name: /Skills\s*\(\d+ total\)/ })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Context Files\s*\(workspace identity\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Kanban')).toBeInTheDocument();
  });

  it('does not render MCP, Registry, Plugin, or ClawHub tabs', async () => {
    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    for (const label of [/^MCP$/i, /^Registry$/i, /^Plugin$/i, /^ClawHub$/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    // The GitHub-import affordance lived on the removed Registry tab.
    expect(screen.queryByRole('button', { name: /Import from GitHub/i })).not.toBeInTheDocument();
  });
});

describe('SkillsPage — Skill Builder coach + skill scope', () => {
  // The coach is resolved from the flat `agents` list filtered by `projectId`
  // (NOT from embedded project.agents), so it must carry projectId here.
  const COACH = {
    id: 'agent-hub-skill-builder',
    role: 'skill-builder',
    name: 'Skill Builder',
    projectId: 'agent-hub',
  };
  const AGENTS_WITH_COACH = [AGENT, COACH];
  const PROJECTS_WITH_COACH = [{ id: 'agent-hub', agents: [{ id: 'hub-frontend' }, COACH] }];

  beforeEach(() => {
    vi.clearAllMocks();
    (api.getSkillOverrides as any).mockResolvedValue([]);
    (api.getSkills as any).mockResolvedValue([]);
    (api.getContext as any).mockResolvedValue({});
    (api.createProjectSkill as any).mockResolvedValue({ id: 'my-skill' });
    (api.createGlobalSkill as any).mockResolvedValue({ id: 'my-skill' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('shows "Build a skill" and starts a session with the project coach', async () => {
    const onStartCoachSession = vi.fn();
    render(
      <SkillsPage
        agents={AGENTS_WITH_COACH}
        projects={PROJECTS_WITH_COACH}
        onStartCoachSession={onStartCoachSession}
      />,
    );
    await flush();

    const build = screen.getByRole('button', { name: /Build a skill/i });
    fireEvent.click(build as any);
    expect(onStartCoachSession!).toHaveBeenCalledWith('agent-hub-skill-builder');
  });

  it('finds the coach via the flat agents list even when project.agents is not hydrated', async () => {
    // Regression: the lookup must not depend on embedded project.agents — the
    // projects payload may omit them. A project object with NO agents array
    // still surfaces the coach because it lives in the flat `agents` list.
    const onStartCoachSession = vi.fn();
    render(
      <SkillsPage
        agents={AGENTS_WITH_COACH}
        projects={[{ id: 'agent-hub' }]}
        onStartCoachSession={onStartCoachSession}
      />,
    );
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Build a skill/i } as any) as any);
    expect(onStartCoachSession!).toHaveBeenCalledWith('agent-hub-skill-builder');
  });

  it('hides "Build a skill" and makes the raw editor primary when there is no coach', async () => {
    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} onStartCoachSession={vi.fn()} />);
    await flush();

    expect(screen.queryByRole('button', { name: /Build a skill/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Write raw/i })).toBeInTheDocument();
  });

  it('saving a new skill with scope=Shared calls createGlobalSkill, not createProjectSkill', async () => {
    render(
      <SkillsPage agents={[AGENT]} projects={PROJECTS_WITH_COACH} onStartCoachSession={vi.fn()} />,
    );
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Write raw/i } as any) as any);
    // Switch the scope toggle to shared.
    fireEvent.click(screen.getByRole('button', { name: /Shared \(all projects\)/i }) as any);
    fireEvent.click(screen.getByRole('button', { name: /Create skill/i } as any) as any);
    await flush();

    expect(api.createGlobalSkill).toHaveBeenCalledTimes(1);
    expect(api.createProjectSkill).not.toHaveBeenCalled();
  });

  it('saving a new skill with the default scope calls createProjectSkill', async () => {
    render(
      <SkillsPage agents={[AGENT]} projects={PROJECTS_WITH_COACH} onStartCoachSession={vi.fn()} />,
    );
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Write raw/i } as any) as any);
    fireEvent.click(screen.getByRole('button', { name: /Create skill/i } as any) as any);
    await flush();

    expect(api.createProjectSkill).toHaveBeenCalledTimes(1);
    expect(api.createGlobalSkill).not.toHaveBeenCalled();
  });

  const GLOBAL_SKILL = {
    id: 'shared-x',
    name: 'Shared X',
    description: 'a shared skill',
    category: 'general',
    source: 'global',
  };

  it('deleting a shared (global) skill is gated by a confirmation and aborts on cancel', async () => {
    (api.getSkills as any).mockResolvedValue([GLOBAL_SKILL]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <SkillsPage agents={[AGENT]} projects={PROJECTS_WITH_COACH} onStartCoachSession={vi.fn()} />,
    );
    await flush();

    fireEvent.click(screen.getByTitle('Uninstall' as any) as any);
    await flush();

    expect(confirmSpy!).toHaveBeenCalledTimes(1);
    // Copy must make the cross-project blast radius explicit.
    expect((confirmSpy as any).mock.calls[0][0]).toMatch(/every (agent|project)/i);
    expect(api.deleteGlobalSkill).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('deletes a shared (global) skill only after the confirmation is accepted', async () => {
    (api.getSkills as any).mockResolvedValue([GLOBAL_SKILL]);
    (api.deleteGlobalSkill as any).mockResolvedValue({ ok: true } as any);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <SkillsPage agents={[AGENT]} projects={PROJECTS_WITH_COACH} onStartCoachSession={vi.fn()} />,
    );
    await flush();

    fireEvent.click(screen.getByTitle('Uninstall' as any) as any);
    await flush();

    expect(api.deleteGlobalSkill).toHaveBeenCalledWith('shared-x');
    confirmSpy.mockRestore();
  });
});
