import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getProjectSkills: vi.fn(),
    getProjectSkill: vi.fn(),
    getContext: vi.fn(),
    getSkillOverrides: vi.fn(),
    getSkill: vi.fn(),
    getGlobalSkill: vi.fn(),
    toggleSkill: vi.fn(),
    uninstallSkill: vi.fn(),
    saveContext: vi.fn(),
    getSkillCredentials: vi.fn(),
    createProjectSkill: vi.fn(),
    createGlobalSkill: vi.fn(),
    updateProjectSkill: vi.fn(),
    updateGlobalSkill: vi.fn(),
    // SkillsPage loads the skill-improvement review queue on mount.
    // Implementation set here (not in a beforeEach) so `vi.clearAllMocks()`
    // — which clears calls, not implementations — keeps the empty default.
    getSkillImprovements: vi.fn().mockResolvedValue({ improvements: [] }),
    approveSkillImprovement: vi.fn(),
    rejectSkillImprovement: vi.fn(),
  },
}));

import SkillsPage from './SkillsPage';
import { api } from '../utils/api';

// The agent must belong to the active project so SkillsPage resolves a
// reference agent (drives the agent-scoped getSkill call in the edit flow).
const AGENT = {
  id: 'a1',
  name: 'A1',
  projectId: 'proj-1',
  color: '#22d3ee',
  workspace: '/tmp/ws',
} as Record<string, any>;
const PROJECTS = [{ id: 'proj-1', name: 'Proj 1', agents: [{ id: 'a1' }] }];
const PROPS = { agents: [AGENT], projects: PROJECTS, initialProjectId: 'proj-1' };

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SkillsPage — project skill editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getContext as any).mockResolvedValue({});
    (api.getSkillOverrides as any).mockResolvedValue([]);
  });

  afterEach(() => vi.clearAllMocks());

  it('opens the create editor and posts content to createProjectSkill', async () => {
    (api.getProjectSkills as any).mockResolvedValue([]);
    (api.createProjectSkill as any).mockResolvedValue({ id: 'my-skill' });

    render(<SkillsPage {...PROPS} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Write raw/i } as any) as any);
    await flush();

    const dialog = screen.getByRole('dialog', { name: /New skill/i });
    expect(dialog!).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Create skill/i } as any) as any);
    await flush();

    expect(api.createProjectSkill).toHaveBeenCalledTimes(1);
    const [projectId, body] = (api.createProjectSkill as any).mock.calls[0];
    expect(projectId!).toBe('proj-1');
    expect(body.content).toContain('name: my-skill');
    // After save, the list reloads.
    await waitFor(() => expect(api.getProjectSkills).toHaveBeenCalledTimes(2));
  });

  it('blocks save and shows an error when the frontmatter is invalid', async () => {
    (api.getProjectSkills as any).mockResolvedValue([]);

    render(<SkillsPage {...PROPS} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Write raw/i } as any) as any);
    await flush();

    const textarea = screen.getByRole('dialog').querySelector('textarea');
    // No frontmatter block at all.
    fireEvent.change(textarea as any, { target: { value: 'just body, no frontmatter' } } as any);
    await flush();

    const saveBtn = screen.getByRole('button', { name: /Create skill/i });
    expect(saveBtn!).toBeDisabled();
    expect(screen.getByText(/must start with a YAML frontmatter block/i)).toBeInTheDocument();
    expect(api.createProjectSkill).not.toHaveBeenCalled();
  });

  it('opens the edit editor for a project skill, seeded from the project read', async () => {
    (api.getProjectSkills as any).mockResolvedValue([
      { id: 'editable', name: 'editable', description: 'd', source: 'project' },
    ]);
    // Project skills are read through the PROJECT-owned endpoint, not the
    // agent-scoped one, so editing works even without a reference agent.
    (api.getProjectSkill as any).mockResolvedValue({
      content: '---\nname: editable\ndescription: existing\n---\n# Body\n',
    });
    (api.updateProjectSkill as any).mockResolvedValue({ id: 'editable' });

    render(<SkillsPage {...PROPS} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Edit skill/i } as any) as any);
    await flush();

    expect(api.getProjectSkill).toHaveBeenCalledWith('proj-1', 'editable');
    expect(api.getSkill).not.toHaveBeenCalled();
    const textarea = screen.getByRole('dialog').querySelector('textarea');
    expect((textarea as any).value).toContain('description: existing');

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i } as any) as any);
    await flush();

    expect(api.updateProjectSkill).toHaveBeenCalledTimes(1);
    const [projectId, skillId, body] = (api.updateProjectSkill as any).mock.calls[0];
    expect(projectId!).toBe('proj-1');
    expect(skillId!).toBe('editable');
    expect(body.name).toBe('editable');
  });

  it('edits a project skill for an AGENTLESS project (no reference agent)', async () => {
    // Regression: an agentless project with skills could render Edit but the
    // agent-scoped read would call /agents/null/skills/:id. The project-owned
    // read must be used so editing still loads the body.
    (api.getProjectSkills as any).mockResolvedValue([
      { id: 'editable', name: 'editable', description: 'd', source: 'project' },
    ]);
    (api.getProjectSkill as any).mockResolvedValue({
      content: '---\nname: editable\ndescription: existing\n---\n# Body\n',
    });

    render(<SkillsPage agents={[]} projects={PROJECTS} initialProjectId="proj-1" />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Edit skill/i } as any) as any);
    await flush();

    expect(api.getProjectSkill).toHaveBeenCalledWith('proj-1', 'editable');
    expect(api.getSkill).not.toHaveBeenCalled();
    const textarea = screen.getByRole('dialog').querySelector('textarea');
    expect((textarea as any).value).toContain('description: existing');
  });

  it('does not offer an edit button for built-in (default) skills', async () => {
    (api.getProjectSkills as any).mockResolvedValue([
      { id: 'kanban', name: 'kanban', description: 'd', source: 'default' },
    ]);

    render(<SkillsPage {...PROPS} />);
    await flush();

    expect(screen.queryByRole('button', { name: /Edit skill/i })).not.toBeInTheDocument();
  });
});
