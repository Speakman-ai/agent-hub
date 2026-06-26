import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getGlobalSkills: vi.fn(),
    getSkillOverrides: vi.fn(),
    toggleSkill: vi.fn(),
    getSkill: vi.fn(),
    getGlobalSkill: vi.fn(),
    getSkillCredentials: vi.fn(),
    deleteGlobalSkill: vi.fn(),
    createGlobalSkill: vi.fn(),
    updateGlobalSkill: vi.fn(),
  },
}));

import GlobalSkillsSection from './GlobalSkillsSection';
import { api } from '../utils/api';

const PROJECTS = [
  { id: 'proj-a', name: 'Project A' },
  { id: 'proj-b', name: 'Project B' },
];
const AGENTS = [
  { id: 'a-dev', name: 'A Dev', projectId: 'proj-a', role: 'sub', active: true },
  { id: 'a-docs', name: 'A Docs', projectId: 'proj-a', role: 'docs', active: true },
  { id: 'b-dev', name: 'B Dev', projectId: 'proj-b', role: 'sub', active: true },
];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('GlobalSkillsSection — per-agent override target selector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getGlobalSkills as any).mockResolvedValue([
      { id: 'kanban', name: 'Kanban', description: 'd', category: 'platform', source: 'default' },
    ]);
    (api.getSkillOverrides as any).mockResolvedValue([]);
    (api.toggleSkill as any).mockResolvedValue({});
  });

  afterEach(() => vi.clearAllMocks());

  it('renders an explicit agent selector defaulting to a dev agent and loads its overrides', async () => {
    render(<GlobalSkillsSection agents={AGENTS} projects={PROJECTS} />);
    await flush();

    const select = screen.getByTestId('global-skills-agent-select') as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    // Defaults to the first non-helper (dev) agent, not the docs helper.
    expect(select.value).toBe('a-dev');
    // The selector is grouped by project (optgroups).
    expect(select.querySelectorAll('optgroup').length).toBe(2);
    // Overrides load for the default target.
    expect(api.getSkillOverrides).toHaveBeenCalledWith('a-dev');
  });

  it('toggling a skill writes against the SELECTED agent, not an arbitrary one', async () => {
    render(<GlobalSkillsSection agents={AGENTS} projects={PROJECTS} />);
    await flush();

    // Switch the override target to the agent in the other project.
    fireEvent.change(screen.getByTestId('global-skills-agent-select'), {
      target: { value: 'b-dev' },
    });
    await flush();
    expect(api.getSkillOverrides).toHaveBeenCalledWith('b-dev');

    // Toggle the built-in skill off — must target the explicitly chosen agent.
    fireEvent.click(screen.getByTitle(/Disable for this agent|Enable for this agent/));
    await waitFor(() => expect(api.toggleSkill).toHaveBeenCalledTimes(1));
    expect(api.toggleSkill).toHaveBeenCalledWith('b-dev', 'kanban', false);
  });

  it('does not render the selector when there are no agents', async () => {
    render(<GlobalSkillsSection agents={[]} projects={PROJECTS} />);
    await flush();
    expect(screen.queryByTestId('global-skills-agent-select')).not.toBeInTheDocument();
  });
});
