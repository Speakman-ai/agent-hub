import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// Must be mocked before importing the component under test.
vi.mock('../utils/api.js', () => ({
  api: {
    getSkills: vi.fn(),
    getContext: vi.fn(),
    getSkillOverrides: vi.fn(),
    getRegistry: vi.fn(),
    getSkill: vi.fn(),
    toggleSkill: vi.fn(),
    installSkill: vi.fn(),
    uninstallSkill: vi.fn(),
    saveContext: vi.fn(),
    importGithubSkill: vi.fn(),
    getPluginInfo: vi.fn(),
    exportPlugin: vi.fn(),
    clawhubSearch: vi.fn(),
    clawhubListSkills: vi.fn(),
    clawhubGetSkill: vi.fn(),
    clawhubGetVersions: vi.fn(),
    clawhubInstall: vi.fn(),
    listUserMcpServers: vi.fn(),
    getMcpCatalog: vi.fn(),
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
    api.getRegistry.mockReset();
    api.getPluginInfo.mockReset();
    api.getSkillOverrides.mockResolvedValue([]);
    api.getPluginInfo.mockResolvedValue(null);
    api.listUserMcpServers.mockResolvedValue({ servers: [] });
    api.getMcpCatalog.mockResolvedValue({ entries: [] });
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
    api.getRegistry.mockResolvedValue([]);

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    const alert = await screen.findByTestId('skills-load-error-skills');
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toContain('Failed to load skills');
    expect(alert.textContent).toContain('500 Internal Server Error');
    expect(alert.textContent).toContain('Retry');

    // The misleading "No skills installed" empty state must NOT render
    // alongside the error — we want the user to see the cause, not a hint
    // to browse the registry.
    expect(screen.queryByText('No skills installed')).not.toBeInTheDocument();
  });

  it('renders an inline error when getContext rejects, separately from skills', async () => {
    api.getSkills.mockResolvedValue([]);
    api.getContext.mockRejectedValue(new Error('ENOENT: workspace missing'));
    api.getRegistry.mockResolvedValue([]);

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
    api.getRegistry.mockResolvedValue([]);

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

  it('surfaces install failures via a transient action-error banner', async () => {
    api.getSkills.mockResolvedValue([]);
    api.getContext.mockResolvedValue({});
    api.getRegistry.mockResolvedValue([
      {
        id: 'kanban',
        name: 'Kanban',
        description: 'Manage cards',
        category: 'platform',
        install_count: 3,
      },
    ]);
    api.installSkill.mockRejectedValue(new Error('write failed'));

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} />);
    await flush();

    // Switch to Registry tab. There may be multiple "Registry" buttons (the
    // tab itself, plus the inline link in the empty-state hint), so disambiguate
    // by selecting the one that lives inside the tab strip.
    const registryButtons = screen.getAllByRole('button', { name: /Registry/i });
    fireEvent.click(registryButtons[0]);
    await flush();

    // Install button on the rendered registry card.
    const installButtons = screen.getAllByRole('button', { name: /Install/i });
    fireEvent.click(installButtons[installButtons.length - 1]);
    await flush();

    const errorBanner = await screen.findByTestId('skills-action-error');
    expect(errorBanner.textContent).toContain('Failed to install skill kanban');
    expect(errorBanner.textContent).toContain('write failed');
  });

  it('shows MCP servers when initialSkillsTab is mcp', async () => {
    api.getSkills.mockResolvedValue([]);
    api.getContext.mockResolvedValue({});
    api.getRegistry.mockResolvedValue([]);
    api.listUserMcpServers.mockResolvedValue({ servers: [] });
    api.getMcpCatalog.mockResolvedValue({ entries: [] });

    render(<SkillsPage agents={[AGENT]} projects={PROJECTS} initialSkillsTab="mcp" />);
    await flush();

    expect(await screen.findByRole('heading', { name: /^MCP Servers$/ })).toBeInTheDocument();
  });
});
