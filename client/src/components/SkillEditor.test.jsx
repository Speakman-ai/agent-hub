import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api.js', () => ({
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
    updateProjectSkill: vi.fn(),
  },
}));

import SkillsPage from './SkillsPage.jsx';
import { api } from '../utils/api.js';

const AGENT = { id: 'a1', name: 'A1', color: '#22d3ee', workspace: '/tmp/ws' };
const PROJECTS = [{ id: 'proj-1', agents: [{ id: 'a1' }] }];

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
    api.getContext.mockResolvedValue({});
    api.getSkillOverrides.mockResolvedValue([]);
  });

  afterEach(() => vi.clearAllMocks());

  it('opens the create editor and posts content to createProjectSkill', async () => {
    api.getSkills.mockResolvedValue([]);
    api.createProjectSkill.mockResolvedValue({ id: 'my-skill' });

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /New skill/i }));
    await flush();

    const dialog = screen.getByRole('dialog', { name: /New skill/i });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Create skill/i }));
    await flush();

    expect(api.createProjectSkill).toHaveBeenCalledTimes(1);
    const [projectId, body] = api.createProjectSkill.mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(body.content).toContain('name: my-skill');
    // After save, the list reloads.
    await waitFor(() => expect(api.getSkills).toHaveBeenCalledTimes(2));
  });

  it('blocks save and shows an error when the frontmatter is invalid', async () => {
    api.getSkills.mockResolvedValue([]);

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /New skill/i }));
    await flush();

    const textarea = screen.getByRole('dialog').querySelector('textarea');
    // No frontmatter block at all.
    fireEvent.change(textarea, { target: { value: 'just body, no frontmatter' } });
    await flush();

    const saveBtn = screen.getByRole('button', { name: /Create skill/i });
    expect(saveBtn).toBeDisabled();
    expect(screen.getByText(/must start with a YAML frontmatter block/i)).toBeInTheDocument();
    expect(api.createProjectSkill).not.toHaveBeenCalled();
  });

  it('opens the edit editor for a project skill, seeded from getSkill', async () => {
    api.getSkills.mockResolvedValue([
      { id: 'editable', name: 'editable', description: 'd', source: 'project' },
    ]);
    api.getSkill.mockResolvedValue({
      content: '---\nname: editable\ndescription: existing\n---\n# Body\n',
    });
    api.updateProjectSkill.mockResolvedValue({ id: 'editable' });

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Edit skill/i }));
    await flush();

    expect(api.getSkill).toHaveBeenCalledWith('a1', 'editable');
    const textarea = screen.getByRole('dialog').querySelector('textarea');
    expect(textarea.value).toContain('description: existing');

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await flush();

    expect(api.updateProjectSkill).toHaveBeenCalledTimes(1);
    const [projectId, skillId, body] = api.updateProjectSkill.mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(skillId).toBe('editable');
    expect(body.name).toBe('editable');
  });

  it('does not offer an edit button for built-in (default) skills', async () => {
    api.getSkills.mockResolvedValue([
      { id: 'kanban', name: 'kanban', description: 'd', source: 'default' },
    ]);

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    expect(screen.queryByRole('button', { name: /Edit skill/i })).not.toBeInTheDocument();
  });
});
