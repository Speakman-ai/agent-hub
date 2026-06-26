import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// Must be mocked before importing the component under test.
(vi as any).mock('../utils/api.js', () => ({
  api: {
    getProjectSkills: vi.fn(),
    getProjectSkill: vi.fn(),
    getContext: vi.fn(),
    getSkillOverrides: vi.fn(),
    getSkill: vi.fn(),
    toggleSkill: vi.fn(),
    uninstallSkill: vi.fn(),
    saveContext: vi.fn(),
    getSkillCredentials: vi.fn(),
    putSkillCredential: vi.fn(),
    deleteSkillCredential: vi.fn(),
    createProjectSkill: vi.fn(),
    createGlobalSkill: vi.fn(),
    updateProjectSkill: vi.fn(),
    updateGlobalSkill: vi.fn(),
    deleteGlobalSkill: vi.fn(),
    getGlobalSkill: vi.fn(),
  },
}));

import SkillsPage, { SkillCard } from './SkillsPage';
import { api } from '../utils/api';

const AGENT = {
  id: 'hub-frontend',
  name: 'Hub Frontend',
  projectId: 'agent-hub',
  color: '#22d3ee',
  workspace: '/tmp/agent-hub/hub-frontend',
} as Record<string, any>;
const PROJECTS = [{ id: 'agent-hub', name: 'Agent Hub' }];
const SKILLS_PAGE_PROPS = {
  agents: [AGENT],
  projects: PROJECTS,
  initialProjectId: 'agent-hub',
};

describe('SkillsPage error surfacing', () => {
  beforeEach(() => {
    (api.getProjectSkills as any).mockReset();
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

  it('renders an inline error with the failure message when getProjectSkills rejects', async () => {
    (api.getProjectSkills as any).mockRejectedValue(new Error('500 Internal Server Error'));
    (api.getContext as any).mockResolvedValue({});

    render(<SkillsPage {...SKILLS_PAGE_PROPS} />);
    await flush();

    const alert = await screen.findByTestId('skills-load-error-skills');
    expect(alert!).toBeInTheDocument();
    expect((alert as any).textContent).toContain('Failed to load skills');
    expect((alert as any).textContent).toContain('500 Internal Server Error');
    expect((alert as any).textContent).toContain('Retry');

    // The misleading "No skills installed" empty state must NOT render
    // alongside the error — we want the user to see the cause.
    expect(screen.queryByText(/No skills found/i)).not.toBeInTheDocument();
  });

  it('renders an inline error when getContext rejects, separately from skills', async () => {
    (api.getProjectSkills as any).mockResolvedValue([]);
    (api.getContext as any).mockRejectedValue(new Error('ENOENT: workspace missing'));

    render(<SkillsPage {...SKILLS_PAGE_PROPS} />);
    await flush();

    const alert = await screen.findByTestId('skills-load-error-context files');
    expect(alert!).toBeInTheDocument();
    expect((alert as any).textContent).toContain('Failed to load context files');
    expect((alert as any).textContent).toContain('ENOENT: workspace missing');
  });

  it('clicking Retry re-invokes getProjectSkills and clears the error on success', async () => {
    (api.getProjectSkills as any)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);
    (api.getContext as any).mockResolvedValue({});

    render(<SkillsPage {...SKILLS_PAGE_PROPS} />);
    await flush();

    const alert = await screen.findByTestId('skills-load-error-skills');
    const retryButton = alert.querySelector('button');
    expect(retryButton!).toBeTruthy();

    fireEvent.click(retryButton as any);
    await flush();

    // Second call resolved cleanly → error banner gone, calls = 2.
    expect(screen.queryByTestId('skills-load-error-skills')).not.toBeInTheDocument();
    expect(api.getProjectSkills).toHaveBeenCalledTimes(2);
  });
});

describe('SkillsPage is skill management only', () => {
  beforeEach(() => {
    (api.getProjectSkills as any).mockReset();
    (api.getContext as any).mockReset();
    (api.getSkillOverrides as any).mockReset();
    (api.getSkillOverrides as any).mockResolvedValue([]);
    (api.getProjectSkills as any).mockResolvedValue([
      {
        id: 'kanban',
        name: 'Kanban',
        description: 'Manage cards',
        category: 'platform',
        source: 'project',
      },
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
    render(<SkillsPage {...SKILLS_PAGE_PROPS} />);
    await flush();

    expect(screen.getByRole('heading', { name: /Skills\s*\(\d+ total\)/ })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Context Files\s*\(workspace identity\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Kanban')).toBeInTheDocument();
  });

  it('does not render MCP, Registry, Plugin, or ClawHub tabs', async () => {
    render(<SkillsPage {...SKILLS_PAGE_PROPS} />);
    await flush();

    for (const label of [/^MCP$/i, /^Registry$/i, /^Plugin$/i, /^ClawHub$/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    // The GitHub-import affordance lived on the removed Registry tab.
    expect(screen.queryByRole('button', { name: /Import from GitHub/i })).not.toBeInTheDocument();
  });
});

describe('SkillsPage — Skill Builder mode + skill scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getSkillOverrides as any).mockResolvedValue([]);
    (api.getProjectSkills as any).mockResolvedValue([]);
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

  it('shows "Build a skill" and starts Skill Builder mode for the project', async () => {
    const onStartSkillBuilderMode = vi.fn();
    render(<SkillsPage {...SKILLS_PAGE_PROPS} onStartSkillBuilderMode={onStartSkillBuilderMode} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Build a skill/i }));
    expect(onStartSkillBuilderMode).toHaveBeenCalledWith('agent-hub');
  });

  it('hides "Build a skill" when there is no dev agent for the project', async () => {
    render(<SkillsPage {...SKILLS_PAGE_PROPS} agents={[]} onStartSkillBuilderMode={vi.fn()} />);
    await flush();

    expect(screen.queryByRole('button', { name: /Build a skill/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Write raw/i })).toBeInTheDocument();
  });

  it('hides "Build a skill" when the project has only helper agents (no dev agent)', async () => {
    // Skill Builder is a dev-agent mode; a docs/reviewer/skill-builder-only
    // roster must NOT offer it (the handler would reject it anyway).
    const helpers = [
      { id: 'd', name: 'Docs', projectId: 'agent-hub', role: 'docs', workspace: '/tmp/d' },
      { id: 'r', name: 'Rev', projectId: 'agent-hub', role: 'reviewer', workspace: '/tmp/r' },
    ];
    render(
      <SkillsPage {...SKILLS_PAGE_PROPS} agents={helpers} onStartSkillBuilderMode={vi.fn()} />,
    );
    await flush();

    expect(screen.queryByRole('button', { name: /Build a skill/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Write raw/i })).toBeInTheDocument();
  });

  it('saving a new skill with scope=Shared calls createGlobalSkill, not createProjectSkill', async () => {
    render(<SkillsPage {...SKILLS_PAGE_PROPS} />);
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
    render(<SkillsPage {...SKILLS_PAGE_PROPS} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Write raw/i } as any) as any);
    fireEvent.click(screen.getByRole('button', { name: /Create skill/i } as any) as any);
    await flush();

    expect(api.createProjectSkill).toHaveBeenCalledTimes(1);
    expect(api.createGlobalSkill).not.toHaveBeenCalled();
  });

  it('does not render cross-project tabs (sidebar selects the project)', async () => {
    render(
      <SkillsPage
        {...SKILLS_PAGE_PROPS}
        projects={[
          { id: 'agent-hub', name: 'Agent Hub' },
          { id: 'other', name: 'Other' },
        ]}
      />,
    );
    await flush();

    expect(screen.queryByTestId('skills-project-tabs')).not.toBeInTheDocument();
    expect(screen.getByTestId('skills-project-label')).toHaveTextContent('Agent Hub');
  });
});

describe('SkillsPage — per-agent override selector', () => {
  const AGENT_A = {
    id: 'agent-a',
    name: 'Agent A',
    projectId: 'agent-hub',
    color: '#22d3ee',
    workspace: '/tmp/a',
  } as Record<string, any>;
  const AGENT_B = {
    id: 'agent-b',
    name: 'Agent B',
    projectId: 'agent-hub',
    color: '#f472b6',
    workspace: '/tmp/b',
  } as Record<string, any>;
  const MULTI_PROPS = {
    agents: [AGENT_A, AGENT_B],
    projects: [{ id: 'agent-hub', name: 'Agent Hub' }],
    initialProjectId: 'agent-hub',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (api.getSkillOverrides as any).mockResolvedValue([]);
    (api.getContext as any).mockResolvedValue({});
    (api.getProjectSkills as any).mockResolvedValue([
      { id: 'kanban', name: 'Kanban', description: 'd', category: 'platform', source: 'project' },
    ]);
    (api.toggleSkill as any).mockResolvedValue({});
  });

  afterEach(() => vi.clearAllMocks());

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders an agent selector for multi-agent projects and defaults to the reference agent', async () => {
    render(<SkillsPage {...MULTI_PROPS} />);
    await flush();

    const selector = screen.getByTestId('skills-agent-selector');
    expect(selector).toBeInTheDocument();
    // First load loads context + overrides for the default reference agent (A).
    expect(api.getSkillOverrides).toHaveBeenCalledWith('agent-a');
    expect(screen.getByRole('tab', { name: /Agent A/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('selecting another agent re-targets override loads and toggles to that agent', async () => {
    render(<SkillsPage {...MULTI_PROPS} />);
    await flush();

    fireEvent.click(screen.getByRole('tab', { name: /Agent B/ }));
    await flush();

    // Switching agents reloads that agent's overrides + context.
    expect(api.getSkillOverrides).toHaveBeenCalledWith('agent-b');
    expect(api.getContext).toHaveBeenCalledWith('agent-b');

    // A toggle now writes against the newly-selected agent, not the default.
    const toggle = screen.getByTitle(/Disable for this agent|Enable for this agent/);
    fireEvent.click(toggle);
    await flush();
    expect(api.toggleSkill).toHaveBeenCalledWith('agent-b', 'kanban', false);
  });

  it('does not render the agent selector for single-agent projects', async () => {
    render(<SkillsPage {...MULTI_PROPS} agents={[AGENT_A]} />);
    await flush();
    expect(screen.queryByTestId('skills-agent-selector')).not.toBeInTheDocument();
  });
});

describe('SkillsPage — skill credential configuration', () => {
  const AGENT = {
    id: 'a1',
    name: 'A1',
    projectId: 'agent-hub',
    color: '#22d3ee',
    workspace: '/tmp/ws',
  } as Record<string, any>;
  const PROPS = {
    agents: [AGENT],
    projects: [{ id: 'agent-hub', name: 'Agent Hub' }],
    initialProjectId: 'agent-hub',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (api.getSkillOverrides as any).mockResolvedValue([]);
    (api.getContext as any).mockResolvedValue({});
    (api.getProjectSkills as any).mockResolvedValue([
      { id: 'gh', name: 'GitHub', description: 'd', category: 'git', source: 'project' },
    ]);
    // Project skills are read via the project-owned endpoint (works without an
    // agent); it returns the content + credential schema.
    (api.getProjectSkill as any).mockResolvedValue({
      content: '# GitHub',
      credentials: [{ name: 'GH_TOKEN', label: 'GitHub token', type: 'secret', required: true }],
    });
    (api.getSkillCredentials as any).mockResolvedValue({ credentials: [] });
    (api.putSkillCredential as any).mockResolvedValue({});
  });

  afterEach(() => vi.clearAllMocks());

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders credential Save controls when an expanded skill declares credentials', async () => {
    render(<SkillsPage {...PROPS} />);
    await flush();

    // Expand the skill card to load its content + credential schema.
    fireEvent.click(screen.getByText('GitHub'));
    await flush();

    // Project skill → project-owned read (not the agent-scoped one).
    expect(api.getProjectSkill).toHaveBeenCalledWith('agent-hub', 'gh');
    expect(api.getSkill).not.toHaveBeenCalled();
    expect(api.getSkillCredentials).toHaveBeenCalledWith('gh');
    expect(screen.getByText('GitHub token')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument();
  });

  it('saves a credential value through putSkillCredential', async () => {
    render(<SkillsPage {...PROPS} />);
    await flush();

    fireEvent.click(screen.getByText('GitHub'));
    await flush();

    const input = screen.getByPlaceholderText(/Required/);
    fireEvent.change(input, { target: { value: 'ghp_secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await flush();

    expect(api.putSkillCredential).toHaveBeenCalledWith({
      skill_id: 'gh',
      key_name: 'GH_TOKEN',
      value: 'ghp_secret',
      agent_id: 'a1',
    });
  });
});

describe('SkillCard — global skill content resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getSkillCredentials as any).mockResolvedValue({ credentials: [] });
  });

  afterEach(() => vi.clearAllMocks());

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('expands a global skill via getGlobalSkill, not the agent-scoped getSkill', async () => {
    (api.getGlobalSkill as any).mockResolvedValue({
      content: '# Shared skill body',
      credentials: [],
    });
    (api.getSkill as any).mockResolvedValue({ content: 'WRONG', credentials: [] });

    render(
      <SkillCard
        skill={{ id: 'shared-thing', name: 'Shared Thing', source: 'global' }}
        agentId="a1"
        overrides={[]}
        isInstalled
      />,
    );

    fireEvent.click(screen.getByText('Shared Thing'));
    await flush();

    // The shared (global) skill must resolve from the global tier, never the
    // agent-scoped read that only searches project → default.
    expect(api.getGlobalSkill).toHaveBeenCalledWith('shared-thing');
    expect(api.getSkill).not.toHaveBeenCalled();
    expect(screen.getByText('Shared skill body')).toBeInTheDocument();
  });

  it('expands a project skill via the PROJECT-owned read when a projectId is given', async () => {
    (api.getProjectSkill as any).mockResolvedValue({ content: '# Project body', credentials: [] });
    (api.getSkill as any).mockResolvedValue({ content: 'WRONG', credentials: [] });

    render(
      <SkillCard
        skill={{ id: 'local-thing', name: 'Local Thing', source: 'project' }}
        agentId="a1"
        projectId="proj-1"
        overrides={[]}
        isInstalled
      />,
    );

    fireEvent.click(screen.getByText('Local Thing'));
    await flush();

    // Project-owned read — works even when no reference agent exists.
    expect(api.getProjectSkill).toHaveBeenCalledWith('proj-1', 'local-thing');
    expect(api.getSkill).not.toHaveBeenCalled();
    expect(screen.getByText('Project body')).toBeInTheDocument();
  });

  it('inspects an agentless project skill via getProjectSkill (no agentId)', async () => {
    (api.getProjectSkill as any).mockResolvedValue({
      content: '# Agentless body',
      credentials: [],
    });

    render(
      <SkillCard
        skill={{ id: 'orphan', name: 'Orphan Skill', source: 'project' }}
        agentId={null}
        projectId="proj-1"
        overrides={[]}
        isInstalled
      />,
    );

    fireEvent.click(screen.getByText('Orphan Skill'));
    await flush();

    expect(api.getProjectSkill).toHaveBeenCalledWith('proj-1', 'orphan');
    expect(api.getSkill).not.toHaveBeenCalled();
    expect(screen.getByText('Agentless body')).toBeInTheDocument();
  });
});
