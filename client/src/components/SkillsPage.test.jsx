import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// Must be mocked before importing the component under test.
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
  },
}));

import SkillsPage from './SkillsPage.jsx';
import { api } from '../utils/api.js';

const AGENT = {
  id: 'hub-frontend',
  name: 'Hub Frontend',
  color: '#22d3ee',
  workspace: '/tmp/agent-hub/hub-frontend',
};
const PROJECTS = [
  {
    id: 'agent-hub',
    agents: [{ id: 'hub-frontend' }],
  },
];

describe('SkillsPage error surfacing', () => {
  beforeEach(() => {
    api.getSkills.mockReset();
    api.getContext.mockReset();
    api.getSkillOverrides.mockReset();
    api.getSkillOverrides.mockResolvedValue([]);
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
    api.getSkills.mockRejectedValue(new Error('500 Internal Server Error'));
    api.getContext.mockResolvedValue({});

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    const alert = await screen.findByTestId('skills-load-error-skills');
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toContain('Failed to load skills');
    expect(alert.textContent).toContain('500 Internal Server Error');
    expect(alert.textContent).toContain('Retry');

    // The misleading "No skills installed" empty state must NOT render
    // alongside the error — we want the user to see the cause.
    expect(screen.queryByText('No skills installed')).not.toBeInTheDocument();
  });

  it('renders an inline error when getContext rejects, separately from skills', async () => {
    api.getSkills.mockResolvedValue([]);
    api.getContext.mockRejectedValue(new Error('ENOENT: workspace missing'));

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    const alert = await screen.findByTestId('skills-load-error-context files');
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toContain('Failed to load context files');
    expect(alert.textContent).toContain('ENOENT: workspace missing');
  });

  it('clicking Retry re-invokes getSkills and clears the error on success', async () => {
    api.getSkills.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([]);
    api.getContext.mockResolvedValue({});

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    const alert = await screen.findByTestId('skills-load-error-skills');
    const retryButton = alert.querySelector('button');
    expect(retryButton).toBeTruthy();

    fireEvent.click(retryButton);
    await flush();

    // Second call resolved cleanly → error banner gone, calls = 2.
    expect(screen.queryByTestId('skills-load-error-skills')).not.toBeInTheDocument();
    expect(api.getSkills).toHaveBeenCalledTimes(2);
  });
});

describe('SkillsPage is skill management only', () => {
  beforeEach(() => {
    api.getSkills.mockReset();
    api.getContext.mockReset();
    api.getSkillOverrides.mockReset();
    api.getSkillOverrides.mockResolvedValue([]);
    api.getSkills.mockResolvedValue([
      { id: 'kanban', name: 'Kanban', description: 'Manage cards', category: 'platform' },
    ]);
    api.getContext.mockResolvedValue({ 'SOUL.md': '# soul' });
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
