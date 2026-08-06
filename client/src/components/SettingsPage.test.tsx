import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent, within } from '@testing-library/react';
import SettingsPage, {
  GeneralSection,
  OrganizationsSection,
  ProjectsSection,
  AgentConfigSection,
} from './SettingsPage';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    get: vi.fn(),
    getModelConfig: vi.fn(),
    updateProject: vi.fn().mockResolvedValue({ ok: true } as any),
    deleteProject: vi.fn().mockResolvedValue({ ok: true } as any),
    getAgents: vi.fn(),
    updateAgent: vi.fn(),
    getProjectSecrets: vi.fn().mockResolvedValue({ secrets: {} }),
    // Pulled in by the embedded <ProjectDefaultAutomationSection> now mounted
    // on the project settings page; resolve to "no preference" so its mount
    // effect doesn't throw.
    getProjectUserSettings: vi.fn().mockResolvedValue({ defaultFinalizeAutomation: null }),
    updateProjectUserSettings: vi.fn().mockResolvedValue({ defaultFinalizeAutomation: null }),
    getReleaseNotificationSettings: vi.fn().mockResolvedValue({
      projectId: 'p1',
      releaseDigestPrompt: 'Write a concise customer-facing release digest.',
      defaultReleaseDigestPrompt: 'Write a concise customer-facing release digest.',
      isDefault: true,
      promptMaxLength: 4000,
      factBoundedSystemTemplate: 'Ground every claim in release facts.',
      updatedBy: null,
      updatedAt: null,
    }),
    updateReleaseNotificationSettings: vi.fn().mockResolvedValue({
      projectId: 'p1',
      releaseDigestPrompt: 'Write a concise customer-facing release digest.',
      defaultReleaseDigestPrompt: 'Write a concise customer-facing release digest.',
      isDefault: true,
      promptMaxLength: 4000,
      factBoundedSystemTemplate: 'Ground every claim in release facts.',
      updatedBy: null,
      updatedAt: null,
    }),
    getInfraAlertRouting: vi.fn().mockResolvedValue({ routing: [] }),
    updateInfraAlertRouting: vi.fn().mockResolvedValue({ routing: [] }),
    resetReleaseNotificationSettings: vi.fn().mockResolvedValue({
      projectId: 'p1',
      releaseDigestPrompt: 'Write a concise customer-facing release digest.',
      defaultReleaseDigestPrompt: 'Write a concise customer-facing release digest.',
      isDefault: true,
      promptMaxLength: 4000,
      factBoundedSystemTemplate: 'Ground every claim in release facts.',
      updatedBy: null,
      updatedAt: null,
    }),
    getMyAgentModelOverrides: vi.fn().mockResolvedValue({ agentModelOverrides: {} }),
    putMyAgentModelOverride: vi.fn((id: any, body: any) =>
      Promise.resolve({ agentModelOverrides: { [id]: body.model } }),
    ),
    deleteMyAgentModelOverride: vi.fn().mockResolvedValue({ agentModelOverrides: {} }),
    getMyAgentEngineOverrides: vi.fn().mockResolvedValue({ agentEngineOverrides: {} }),
    putMyAgentEngineOverride: vi.fn((id: any, body: any) =>
      Promise.resolve({ agentEngineOverrides: { [id]: { engine: body.engine } } }),
    ),
    deleteMyAgentEngineOverride: vi.fn().mockResolvedValue({ agentEngineOverrides: {} }),
    getSkills: vi.fn().mockResolvedValue([]),
    getGlobalSkills: vi.fn().mockResolvedValue([]),
    getGlobalSkill: vi.fn().mockResolvedValue({ content: '' }),
    createGlobalSkill: vi.fn().mockResolvedValue({ id: 'new-skill' }),
    updateGlobalSkill: vi.fn().mockResolvedValue({ id: 'skill' }),
    deleteGlobalSkill: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

// Role gating helpers — `hasRole` is read at render-time to filter the
// settings sidebar. Default to Admin so the existing tests (which don't
// care about the role) keep seeing every tab; individual role-gating
// tests below override via `vi.mocked(hasRole).mockReturnValueOnce(...)`.
(vi as any).mock('../utils/auth.js', async () => {
  const actual = await vi.importActual('../utils/auth.js');
  return {
    ...actual,
    hasRole: vi.fn(() => true),
    getUserRole: vi.fn(() => 'Admin'),
    // Default to false (cloud/JWT mode); local-mode tests override below.
    isLocalBundledDeployment: vi.fn(() => false),
  };
});

// `OrganizationsSection` calls into `utils/orgs.js` at render time.
// Mock the surface it touches so the focused tests below don't depend on
// localStorage / Electron file storage / live server fetches.
(vi as any).mock('../utils/orgs.js', async () => {
  const actual = await vi.importActual('../utils/orgs.js');
  return {
    ...actual,
    getOrgs: vi.fn(() => ({
      orgs: [{ id: 'default', name: 'Personal', mode: 'local', color: '#6366f1' }],
      activeOrgId: 'default',
    })),
    getActiveOrg: vi.fn(() => ({ id: 'default', name: 'Personal', mode: 'local' })),
    createOrg: vi.fn(),
    updateOrg: vi.fn(),
    deleteOrg: vi.fn(),
    switchOrg: vi.fn(),
  };
});

describe('SettingsPage — tab labels', () => {
  beforeEach(() => {
    (api.getConfig as any).mockResolvedValue({
      claudeBin: '/bin/claude',
      cursorBin: '/bin/cursor',
      defaultModel: 'claude-opus-4-8',
      defaultCwd: '/tmp',
      port: 3051,
      publicUrl: '',
      anthropicApiKeySet: false,
      _file: {},
    });
    (api.get as any).mockResolvedValue({});
    (api.getModelConfig as any).mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-8'] },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('does not expose a Workspace sidebar link named Integrations', async () => {
    const { queryByRole, findByRole } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} />,
    );
    await findByRole('button', { name: /^General$/ });
    expect(queryByRole('button', { name: /^Integrations$/ })).toBeNull();
  });

  it('lands the legacy Settings → Integrations deep link on General', async () => {
    // The Integrations tab is gone; the old `?tab=integrations` link must
    // land on General rather than bouncing to the removed `skills:mcp`.
    const onNavigate = vi.fn();
    const { findByRole } = render(
      <SettingsPage
        projects={[]}
        agents={[]}
        onAgentsChange={() => {}}
        initialTab="integrations"
        onNavigate={onNavigate}
      />,
    );
    expect(await findByRole('button', { name: /^General$/ })).toBeTruthy();
    expect(onNavigate!).not.toHaveBeenCalledWith('skills:mcp');
  });

  it('no longer exposes Preview or Finalize tabs (moved to per-project sidebar)', async () => {
    // Preview and Finalize configuration moved out of Settings and into the
    // per-project sidebar as "Preview" and "Runners". Guard against the tabs
    // accidentally reappearing here.
    const { findByRole, queryByRole } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} />,
    );
    // Wait for the settings nav to render before asserting absence.
    expect(await findByRole('button', { name: /^General$/ })).toBeTruthy();
    expect(queryByRole('button', { name: /^Preview$/ })).toBeNull();
    expect(queryByRole('button', { name: /^Finalize$/ })).toBeNull();
  });

  it('labels the host-wide Gemini key tab "Global API Keys"', async () => {
    // Per-account Claude/Cursor/Codex auth now lives on Settings → Account.
    // The only host-wide AI credential left is the Gemini API key (used for
    // wiki embeddings / memory RAG), so the tab is labeled "Global API Keys".
    const { findByText, queryByRole, queryByText } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} />,
    );

    expect(await findByText('Global API Keys')).toBeTruthy();
    // The old combined-auth labels are gone — guard against regression.
    expect(queryByText('Global AI Authentication')).toBeNull();
    expect(queryByText('AI Authentication')).toBeNull();
    // Regression guard: don't accidentally render a tab labeled just "Auth".
    expect(queryByRole('button', { name: /^Auth$/ })).toBeNull();
  });

  it('hides reviewer-role agents from project Agents settings', async () => {
    const agents = [
      {
        id: 'agent-dev',
        name: 'Agent Hub Dev',
        role: 'lead',
        engine: 'claude-code',
        model: 'claude-opus-4-8',
        color: '#22c55e',
        active: true,
        projectId: 'p1',
      },
      {
        id: 'agent-reviewer',
        name: 'agent-hub Reviewer',
        role: 'reviewer',
        engine: 'claude-code',
        model: 'claude-sonnet-4-20250514',
        color: '#a855f7',
        active: true,
        projectId: 'p1',
      },
    ];

    const { findByText, queryByText } = render(
      <AgentConfigSection
        projects={[{ id: 'p1', name: 'Acme', cwd: '/tmp', agents: [] }]}
        agents={agents}
        projectId="p1"
        onAgentsChange={() => {}}
      />,
    );

    expect(await findByText('Agent Hub Dev')).toBeTruthy();
    expect(queryByText('agent-hub Reviewer')).toBeNull();
    expect(queryByText('agent-reviewer')).toBeNull();
  });
});

/**
 * Role-gated visibility of the host-wide "Gemini API Key" tab.
 *
 * The tab writes to `~/.agent-hub/data/config.json` — a host-wide credential
 * file — so only Admin/Owner users can act on it. Regular users manage their
 * own per-user CLI creds on Settings → Account. Hiding the tab from non-Admins
 * eliminates the long-standing "two places to enter auth" confusion.
 *
 * Server-side enforcement of the underlying permissions is unchanged; this
 * is purely a UX gate, so we only need to verify the client-side filter.
 */
describe('SettingsPage — Gemini API Key tab role gating', () => {
  beforeEach(async () => {
    (api.getConfig as any).mockResolvedValue({
      claudeBin: '/bin/claude',
      cursorBin: '/bin/cursor',
      defaultModel: 'claude-opus-4-8',
      defaultCwd: '/tmp',
      port: 3051,
      publicUrl: '',

      _file: {},
    });
    (api.get as any).mockResolvedValue({});
    (api.getModelConfig as any).mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-8'] },
    });
    const { hasRole, isLocalBundledDeployment } = await import('../utils/auth.js');
    // Reset to default (Admin sees everything, not local mode) before each
    // test — individual tests override below.
    vi.mocked(hasRole).mockImplementation(() => true);
    vi.mocked(isLocalBundledDeployment).mockImplementation(() => false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('renders the tab for Admin/Owner users', async () => {
    const { hasRole } = await import('../utils/auth.js');
    vi.mocked(hasRole).mockImplementation((min: any) => min === 'Admin');

    const { findByText } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} />,
    );

    expect(await findByText('Global API Keys')).toBeTruthy();
  });

  it('hides the tab from non-Admin users', async () => {
    const { hasRole } = await import('../utils/auth.js');
    // Plain User role — hasRole('Admin') returns false.
    vi.mocked(hasRole).mockImplementation(() => false);

    const { queryByText, findAllByText } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} />,
    );

    // Wait for the page to settle — `General` is in both the desktop
    // sidebar and the mobile drawer, so we wait for the multi-match form.
    await findAllByText('General');

    expect(queryByText('Global API Keys')).toBeNull();
    // And the old combined-auth name doesn't sneak back either.
    expect(queryByText('Global AI Authentication')).toBeNull();
  });

  it('redirects a non-Admin who deep-links to the gated tab back to Account', async () => {
    const { hasRole } = await import('../utils/auth.js');
    vi.mocked(hasRole).mockImplementation(() => false);

    // initialTab = 'claude-auth' simulates a saved bookmark / shared URL.
    // The redirect effect should push them to 'account' before render.
    const { queryByText, getAllByText } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} initialTab="claude-auth" />,
    );

    // `getAllByText` throws if not found — this assertion actually fails
    // when the redirect doesn't fire (unlike a Promise-wrapped findAllByText).
    await waitFor(() => {
      expect(getAllByText('Account').length).toBeGreaterThan(0);
    });
    // The gated panel never rendered.
    expect(queryByText('Global API Keys')).toBeNull();
  });

  it('does not render the host-wide Gemini panel for non-Admin even if tab state somehow lands on claude-auth', async () => {
    // Belt-and-suspenders: the role check on the render switch should
    // also short-circuit, so even a brief tick where `tab === 'claude-auth'`
    // before the redirect effect runs won't expose the host-wide panel.
    const { hasRole } = await import('../utils/auth.js');
    vi.mocked(hasRole).mockImplementation(() => false);

    const { queryByText, findAllByText } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} initialTab="claude-auth" />,
    );

    // Wait for first render to flush — `General` is in both the desktop
    // sidebar and the mobile drawer.
    await findAllByText('General');
    // The gated tab renders only <GeminiAuthSection />. Its distinctive
    // heading is a reliable signal that the panel rendered.
    expect(queryByText('Gemini CLI Authentication')).toBeNull();
  });

  it('shows the tab in local-bundled mode (no JWT / activeOrgIsLocal=true)', async () => {
    // Regression guard for Electron / single-user self-host: when the
    // server returns activeOrgIsLocal=true it never issues a JWT, so
    // hasRole() returns false. The tab must still appear because local-mode
    // users own the host and need to configure claudeBin / cursorBin.
    const { hasRole, isLocalBundledDeployment } = await import('../utils/auth.js');
    vi.mocked(hasRole).mockImplementation(() => false); // no JWT → no role
    vi.mocked(isLocalBundledDeployment).mockImplementation(() => true); // local-mode

    const { findByText } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} />,
    );

    expect(await findByText('Global API Keys')).toBeTruthy();
  });
});

describe('GeneralSection — CLI binary paths', () => {
  beforeEach(() => {
    (api.getConfig as any).mockResolvedValue({
      claudeBin: '/usr/bin/claude',
      cursorBin: '/home/agenthub/.local/bin/agent',
      geminiBin: '/usr/local/bin/gemini',
      codexBin: '/usr/local/bin/codex',
      port: 3051,
      defaultCwd: '/tmp',
      publicUrl: '',

      _file: {},
    });
    (api.updateConfig as any).mockResolvedValue({ ok: true } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    delete (window as any).electronAPI;
  });

  it('shows desktop PATH hint when running inside Electron', async () => {
    window.electronAPI = { isElectron: true };
    const { getByText } = render(<GeneralSection />);
    await waitFor(() => {
      expect(getByText(/Desktop app:/)).toBeTruthy();
    });
  });

  it('links to the versioned desktop DMG instead of the release bucket root', async () => {
    vi.stubEnv('VITE_RELEASE_BUCKET_BASE', 'https://releases.example.test');
    vi.stubEnv('VITE_APP_VERSION', '2.31.41');

    const { findByRole } = render(<GeneralSection />);
    const link = await findByRole('link', { name: /Download desktop app/ });

    expect(link).toHaveAttribute(
      'href',
      'https://releases.example.test/v2.31.41/Agent%20Hub-2.31.41.dmg',
    );
  });

  it('renders a cursorBin input pre-populated from config', async () => {
    const { findByDisplayValue, getByText } = render(<GeneralSection />);
    // Section label visible alongside the claude/gemini ones
    await waitFor(() => expect(getByText('Cursor Agent CLI')).toBeTruthy());
    // Input is wired to the loaded config value
    expect(await findByDisplayValue('/home/agenthub/.local/bin/agent')).toBeTruthy();
  });

  it('sends cursorBin in the updateConfig payload when saved', async () => {
    const { findByDisplayValue, getByText } = render(<GeneralSection />);

    const cursorInput = await findByDisplayValue('/home/agenthub/.local/bin/agent');
    fireEvent.change(cursorInput, { target: { value: '/usr/local/bin/agent' } } as any);

    fireEvent.click(getByText('Save' as any));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ cursorBin: '/usr/local/bin/agent' }),
      );
    });
  });

  it('renders a codexBin input pre-populated from config', async () => {
    const { findByDisplayValue, getByText } = render(<GeneralSection />);
    await waitFor(() => expect(getByText('Codex CLI')).toBeTruthy());
    expect(await findByDisplayValue('/usr/local/bin/codex')).toBeTruthy();
  });

  it('sends codexBin in the updateConfig payload when saved', async () => {
    const { findByDisplayValue, getByText } = render(<GeneralSection />);

    const codexInput = await findByDisplayValue('/usr/local/bin/codex');
    fireEvent.change(codexInput, { target: { value: '/opt/codex/bin/codex' } } as any);

    fireEvent.click(getByText('Save' as any));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ codexBin: '/opt/codex/bin/codex' }),
      );
    });
  });
});

/**
 * Sidebar navigation regression — replaces the old horizontal tab strip.
 *
 * The bug report (Electron 1.10.1) said the top of Settings felt crowded
 * because every section name was crammed into a horizontal scroller. The
 * fix is a persistent left sidebar grouped by purpose: any future change
 * that compresses navigation back into the top bar should fail this test.
 */
describe('SettingsPage — sidebar navigation', () => {
  beforeEach(() => {
    (api.getConfig as any).mockResolvedValue({
      claudeBin: '/bin/claude',
      cursorBin: '/bin/cursor',
      defaultModel: 'claude-opus-4-8',
      defaultCwd: '/tmp',
      port: 3051,
      publicUrl: '',

      _file: {},
    });
    (api.get as any).mockResolvedValue({});
    (api.getModelConfig as any).mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-8'] },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders a navigation landmark labelled "Settings sections"', () => {
    const { getAllByLabelText } = render(<SettingsPage projects={[]} agents={[]} />);
    // Sidebar is rendered both desktop-side and inside the mobile drawer
    // (the drawer is hidden by default, but the desktop one is present in the DOM).
    expect(getAllByLabelText('Settings sections').length).toBeGreaterThan(0);
  });

  it('renders a flat settings sidebar without section category headers', () => {
    const { getAllByText, queryByText } = render(<SettingsPage projects={[]} agents={[]} />);
    expect(getAllByText('General').length).toBeGreaterThan(0);
    expect(getAllByText('Account').length).toBeGreaterThan(0);
    expect(getAllByText('Global Skills').length).toBeGreaterThan(0);
    expect(getAllByText('GitHub').length).toBeGreaterThan(0);
    expect(queryByText('Workspace')).toBeNull();
    expect(queryByText('Agents & Auth')).toBeNull();
    expect(queryByText('Automation')).toBeNull();
    expect(queryByText('Operations')).toBeNull();
  });

  it('switches the active section when a sidebar item is clicked', async () => {
    const { getAllByText, getAllByLabelText } = render(<SettingsPage projects={[]} agents={[]} />);
    const accountButtons = getAllByText('Account');
    fireEvent.click(accountButtons[0] as any);
    await waitFor(() => {
      const nav = getAllByLabelText('Settings sections')[0];
      const active = within(nav).getByRole('button', { name: 'Account' });
      expect(active!).toHaveAttribute('aria-current', 'page');
    });
  });

  it('marks the active sidebar item with aria-current="page"', () => {
    // Use the "Account" tab (always visible) — the previous version targeted
    // "Organizations", but that tab is now Electron-only and absent in the
    // jsdom (browser-like) test environment.
    const { getAllByText } = render(
      <SettingsPage projects={[]} agents={[]} initialTab="account" />,
    );
    const accountButtons = getAllByText('Account').map((el: any) => el.closest('button'));
    const active = accountButtons.find((b: any) => b?.getAttribute('aria-current') === 'page');
    expect(active!).toBeTruthy();
  });

  // The web app is locked to a single Hub server, so the "Organizations" tab
  // (which manages multi-server bookmarks) is Electron-only. In a plain
  // browser context the tab MUST NOT appear in the settings sidebar, and a
  // deep-link with initialTab="orgs" MUST redirect to a visible tab so the
  // user doesn't land on a blank settings pane.
  describe('Organizations tab — Electron-only gating', () => {
    it('does NOT render the "Organizations" sidebar entry in a plain browser', () => {
      const { queryByText } = render(<SettingsPage projects={[]} agents={[]} />);
      expect(queryByText('Organizations')).toBeNull();
    });

    it('renders the "Organizations" sidebar entry when window.electronAPI.isElectron is true', () => {
      const origElectronAPI = globalThis.window.electronAPI;
      globalThis.window.electronAPI = { isElectron: true };
      try {
        const { getAllByText } = render(<SettingsPage projects={[]} agents={[]} />);
        expect(getAllByText('Organizations').length).toBeGreaterThan(0);
      } finally {
        if (origElectronAPI === undefined) {
          delete (globalThis as any).window.electronAPI;
        } else {
          globalThis.window.electronAPI = origElectronAPI;
        }
      }
    });
  });

  it('exposes a mobile menu trigger labelled "Open settings navigation"', () => {
    const { getByLabelText } = render(<SettingsPage projects={[]} agents={[]} />);
    expect(getByLabelText('Open settings navigation')).toBeTruthy();
  });

  // Bug "GitHub account on this page; Projects in its own tab" (Electron 1.10.1):
  // Projects must have a dedicated sidebar entry rather than being crammed
  // under the GitHub tab. The GitHub tab now hosts the personal GitHub OAuth
  // connection + server OAuth App config — and nothing per-project.
  it('does not expose a global Projects tab (moved to per-project sidebar menu)', () => {
    const { queryByText } = render(<SettingsPage projects={[]} agents={[]} />);
    expect(queryByText('Projects')).toBeNull();
  });

  it('renders project settings via ProjectsSection in single-project mode', async () => {
    const projects = [
      { id: 'p1', name: 'Acme', color: '#ff0000', cwd: '/tmp/a', githubRepo: '', agents: [] },
    ];
    const { findByText } = render(<ProjectsSection projects={projects} projectId="p1" />);
    await findByText('Project settings');
    expect(
      await findByText('Configure secrets, visibility, and lifecycle settings for this project.'),
    ).toBeTruthy();
  });

  it('no longer renders the Clone URL, GitHub Repository, PR toggles, or workflow runs', async () => {
    const projects = [
      {
        id: 'p1',
        name: 'Acme',
        color: '#ff0000',
        cwd: '/tmp/a',
        githubRepo: 'acme/acme',
        agents: [],
      },
    ];
    const { queryByText, findByText } = render(
      <ProjectsSection projects={projects} projectId="p1" />,
    );
    expect(await findByText('Project settings')).toBeTruthy();
    // Removed editing surfaces (repo is now set automatically).
    expect(queryByText(/GitHub Repository/)).toBeNull();
    expect(queryByText(/Clone URL/)).toBeNull();
    // Removed PR automation controls (Hub runs its own review/CI cycle).
    // NOTE: "Auto Merge" / "Build and Review" intentionally render here now —
    // they are radio labels of the per-user default-automation panel, a
    // different surface from the old per-project PR toggles.
    expect(queryByText('Auto Review')).toBeNull();
    expect(queryByText('Wait for CI')).toBeNull();
    expect(queryByText('Wait for Resolved Comments')).toBeNull();
    expect(queryByText('PR review model')).toBeNull();
  });

  it('renders the per-user default automation panel on the project settings page', async () => {
    const projects = [
      { id: 'p1', name: 'Acme', color: '#ff0000', cwd: '/tmp/a', githubRepo: '', agents: [] },
    ];
    const { findByText } = render(<ProjectsSection projects={projects} projectId="p1" />);
    expect(await findByText('Your default automation')).toBeTruthy();
    // The Finalize automation levels are selectable here now.
    expect(await findByText('Auto Merge')).toBeTruthy();
  });

  it('exposes an AWS enable toggle that defaults off and persists via updateProject', async () => {
    const { api } = await import('../utils/api.js');
    const updateSpy = vi.spyOn(api, 'updateProject').mockResolvedValue({} as any);
    const onAgentsChange = vi.fn();
    const projects = [
      { id: 'p1', name: 'Acme', color: '#ff0000', cwd: '/tmp/a', githubRepo: '', agents: [] },
    ];
    const { getByTestId } = render(
      <ProjectsSection projects={projects} projectId="p1" onProjectsChange={onAgentsChange} />,
    );
    const toggle = getByTestId('project-aws-enabled-p1');
    fireEvent.click(toggle as any);
    await waitFor(() => {
      expect(updateSpy!).toHaveBeenCalledWith('p1', { awsEnabled: true });
    });
    updateSpy.mockRestore();
  });

  it('does NOT render the project list on the GitHub tab anymore', async () => {
    const projects = [
      { id: 'p1', name: 'Acme', color: '#ff0000', cwd: '/tmp/a', githubRepo: '', agents: [] },
    ];
    const { queryByText, findByText } = render(
      <SettingsPage projects={projects} agents={[]} initialTab="github" />,
    );
    // GitHub Settings heading still present…
    await findByText('GitHub Settings');
    // …but the per-project block is gone from this tab.
    expect(queryByText('Project Settings')).toBeFalsy();
  });

  it('renders the GitHub Account ("Sign in with GitHub") block on the GitHub tab', async () => {
    const { findByText } = render(<SettingsPage projects={[]} agents={[]} initialTab="github" />);
    // GithubConnectionSection's heading — proves the personal GitHub identity
    // is now visible on the same page that hosts the server OAuth App config.
    await findByText('GitHub Account');
  });
});

/**
 * The Connection Mode (Local/Remote) toggle is meaningful only when the
 * client is decoupled from its server — i.e. Electron, which can spawn a
 * bundled local server *or* HTTP/WS to a remote one. The web client is
 * served *by* its server, so the page's origin *is* the server URL: there
 * is no other server it could sensibly point at, and rendering the toggle
 * just lets users put their org into a state where the configured
 * `remoteUrl` disagrees with the actual page origin.
 *
 * These tests guard the hide-on-web behavior in both the per-org edit
 * form and the "Add Organization" form.
 */
describe('OrganizationsSection — Connection Mode toggle visibility', () => {
  beforeEach(() => {
    delete (window as any).electronAPI;
  });

  afterEach(() => {
    delete (window as any).electronAPI;
  });

  it('hides the Connection Mode toggle on web (no electronAPI)', () => {
    const { queryByText, getByText } = render(<OrganizationsSection />);
    // The orgs heading still renders — we only dropped the toggle, not
    // the section.
    expect(getByText('Organizations')).toBeTruthy();
    // No Connection Mode label anywhere on the page.
    expect(queryByText(/Connection Mode/i)).toBeNull();
    // No Local / Remote toggle buttons under the Add-Organization form.
    fireEvent.click(getByText(/Add Organization/i as any));
    expect(queryByText(/Connection Mode/i)).toBeNull();
    expect(queryByText(/Server runs on this machine/i)).toBeNull();
    expect(queryByText(/Connect to a remote server/i)).toBeNull();
  });

  it('renders the Connection Mode toggle on Electron (window.electronAPI.isElectron)', () => {
    window.electronAPI = { isElectron: true };
    const { getByText } = render(<OrganizationsSection />);
    // Click "Add Organization" to expand the new-org form, where the toggle
    // is unconditionally rendered for the Electron build.
    fireEvent.click(getByText(/Add Organization/i as any));
    expect(getByText(/Connection Mode/i)).toBeTruthy();
    expect(getByText(/Server runs on this machine/i)).toBeTruthy();
    expect(getByText(/Connect to a remote server/i)).toBeTruthy();
  });
});

describe('ProjectsSection — visibility toggle', () => {
  beforeEach(() => {
    (api.getModelConfig as any).mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-8'] },
    });
    (api.updateProject as any).mockResolvedValue({ ok: true } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeProject(overrides: any = {}) {
    return {
      id: 'p1',
      name: 'Demo',
      cwd: '/tmp/p1',
      ahw: '/tmp/p1-ahw',
      color: '#6366f1',
      visibility: 'shared',
      ownerUserId: null,
      agents: [],
      ...overrides,
    };
  }

  it('renders the Visibility select pre-populated from project.visibility', async () => {
    const project = makeProject({ visibility: 'private', ownerUserId: 'u1' });
    const { getByTestId } = render(
      <ProjectsSection
        projects={[project]}
        onProjectsChange={() => {}}
        initialExpandedProjectId="p1"
      />,
    );
    await waitFor(() => {
      const sel = getByTestId('project-visibility-select-p1');
      expect((sel as any).value).toBe('private');
    });
  });

  it('calls api.updateProject with the new visibility and triggers onProjectsChange', async () => {
    const project = makeProject({ visibility: 'shared' });
    const onProjectsChange = vi.fn();
    const { getByTestId } = render(
      <ProjectsSection
        projects={[project]}
        onProjectsChange={onProjectsChange}
        initialExpandedProjectId="p1"
      />,
    );

    const sel = await waitFor(() => getByTestId('project-visibility-select-p1'));
    fireEvent.change(sel, { target: { value: 'private' } } as any);

    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith('p1', { visibility: 'private' });
    });
    await waitFor(() => {
      expect(onProjectsChange!).toHaveBeenCalled();
    });
  });

  it('surfaces a server error via showToast when updateProject rejects (e.g. 403)', async () => {
    (api.updateProject as any).mockRejectedValueOnce(
      new Error('Only org Owners can make a shared project private.'),
    );
    const project = makeProject({ visibility: 'shared' });
    const showToast = vi.fn();
    const { getByTestId } = render(
      <ProjectsSection
        projects={[project]}
        onProjectsChange={() => {}}
        initialExpandedProjectId="p1"
        showToast={showToast}
      />,
    );

    const sel = await waitFor(() => getByTestId('project-visibility-select-p1'));
    fireEvent.change(sel, { target: { value: 'private' } } as any);

    await waitFor(() => {
      expect(showToast!).toHaveBeenCalledWith(
        expect.stringMatching(/Only org Owners can make a shared project private/),
        'error',
      );
    });
  });
});

/**
 * Regression guard for the per-user override save race.
 *
 * Saves now go through the per-AGENT merge endpoints, so editing one agent
 * sends only that agent's key — it can never clobber another agent's pick
 * (the whole-map lost-update window the reviewer flagged). Each agent's write
 * carries its own value, independent of what's in flight for another agent.
 */
describe('AgentConfigSection — per-user override saves are race-safe', () => {
  beforeEach(() => {
    (api.getConfig as any).mockResolvedValue({ claudeBin: '/bin/claude', _file: {} });
    (api.get as any).mockResolvedValue({});
    (api.getModelConfig as any).mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: { 'claude-code': 'claude-opus-4-8' },
      engineValidModels: { 'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-20250514'] },
    });
    (api.getMyAgentModelOverrides as any).mockResolvedValue({ agentModelOverrides: {} });
    (api.getMyAgentEngineOverrides as any).mockResolvedValue({ agentEngineOverrides: {} });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends a per-agent merge call per edit and never clobbers another agent', async () => {
    const agents = [
      {
        id: 'agent-a',
        name: 'Agent A',
        role: 'lead',
        engine: 'claude-code',
        active: true,
        projectId: 'p1',
      },
      {
        id: 'agent-b',
        name: 'Agent B',
        role: 'lead',
        engine: 'claude-code',
        active: true,
        projectId: 'p1',
      },
    ];

    // Agent A's save hangs until released, so Agent B is edited while it's in
    // flight — the exact window the old whole-map PUT could lose.
    let releaseFirst: any;
    const firstPut = new Promise((resolve: any) => {
      releaseFirst = resolve;
    });
    (api.putMyAgentModelOverride as any)
      .mockImplementationOnce((id: any, body: any) =>
        firstPut.then(() => ({ agentModelOverrides: { [id]: body.model } })),
      )
      .mockImplementation((id: any, body: any) =>
        Promise.resolve({ agentModelOverrides: { [id]: body.model } }),
      );

    const { findByText, getByTestId } = render(
      <AgentConfigSection
        projects={[{ id: 'p1', name: 'Acme', cwd: '/tmp', agents: [] }]}
        agents={agents}
        projectId="p1"
        onAgentsChange={() => {}}
      />,
    );

    // Expand Agent A and pick a model (call #1 — now pending).
    fireEvent.click(await findByText('Agent A' as any));
    fireEvent.change(getByTestId('per-user-model-select' as any), {
      target: { value: 'claude-sonnet-4-20250514' },
    });
    await waitFor(() => expect(api.putMyAgentModelOverride).toHaveBeenCalledTimes(1));

    // Collapse A, expand B, pick a different model while A's call is in flight
    // (only one card expands at a time, mirroring real usage).
    fireEvent.click(await findByText('Agent B' as any));
    fireEvent.change(getByTestId('per-user-model-select' as any), {
      target: { value: 'claude-opus-4-8' },
    });
    releaseFirst();

    await waitFor(() => expect(api.putMyAgentModelOverride).toHaveBeenCalledTimes(2));
    // Each agent was saved with ONLY its own id + value — no whole-map payload
    // exists to drop the other agent's change.
    expect(api.putMyAgentModelOverride).toHaveBeenCalledWith('agent-a', {
      model: 'claude-sonnet-4-20250514',
    });
    expect(api.putMyAgentModelOverride).toHaveBeenCalledWith('agent-b', {
      model: 'claude-opus-4-8',
    });
  });
});

describe('AgentConfigSection — shared engine change reconciles per-user model override', () => {
  beforeEach(() => {
    (api.getConfig as any).mockResolvedValue({ claudeBin: '/bin/claude', _file: {} });
    (api.get as any).mockResolvedValue({});
    (api.getModelConfig as any).mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: { 'claude-code': 'claude-opus-4-8', 'codex-cli': 'gpt-5.2' },
      engineValidModels: {
        'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-6'],
        'codex-cli': ['gpt-5.2', 'gpt-5.5'],
      },
    });
    (api.getMyAgentEngineOverrides as any).mockResolvedValue({ agentEngineOverrides: {} });
    (api.getSkills as any).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const agent = {
    id: 'agent-a',
    name: 'Agent A',
    role: 'lead',
    engine: 'claude-code',
    active: true,
    projectId: 'p1',
  };

  function renderSection() {
    return render(
      <AgentConfigSection
        projects={[{ id: 'p1', name: 'Acme', cwd: '/tmp', agents: [] }]}
        agents={[agent]}
        projectId="p1"
        onAgentsChange={() => {}}
      />,
    );
  }

  it('clears a per-user model override made stale by saving a new shared engine', async () => {
    // Pinned model is valid for claude-code but not codex-cli.
    (api.getMyAgentModelOverrides as any).mockResolvedValue({
      agentModelOverrides: { 'agent-a': 'claude-sonnet-4-6' },
    });
    (api.updateAgent as any).mockResolvedValue({ ...agent, engine: 'codex-cli' });

    const { findByText, getByTestId } = renderSection();
    fireEvent.click(await findByText('Agent A' as any));
    fireEvent.change(getByTestId('agent-shared-engine' as any), { target: { value: 'codex-cli' } });
    fireEvent.click(await findByText('Save' as any));

    await waitFor(() => expect(api.updateAgent).toHaveBeenCalled());
    expect((api.updateAgent as any).mock.calls[0][1].engine).toBe('codex-cli');
    await waitFor(() => expect(api.deleteMyAgentModelOverride).toHaveBeenCalledWith('agent-a'));
  });

  it('keeps a per-user model override still valid for the new shared engine', async () => {
    // Pinned model is valid for BOTH engines → must survive the engine change.
    (api.getModelConfig as any).mockResolvedValue({
      defaultModel: 'shared-default',
      engineDefaultModels: { 'claude-code': 'shared-default', 'codex-cli': 'shared-default' },
      engineValidModels: {
        'claude-code': ['shared-default', 'shared-b'],
        'codex-cli': ['shared-default', 'shared-c'],
      },
    });
    (api.getMyAgentModelOverrides as any).mockResolvedValue({
      agentModelOverrides: { 'agent-a': 'shared-default' },
    });
    (api.updateAgent as any).mockResolvedValue({ ...agent, engine: 'codex-cli' });

    const { findByText, getByTestId } = renderSection();
    fireEvent.click(await findByText('Agent A' as any));
    fireEvent.change(getByTestId('agent-shared-engine' as any), { target: { value: 'codex-cli' } });
    fireEvent.click(await findByText('Save' as any));

    await waitFor(() => expect(api.updateAgent).toHaveBeenCalled());
    expect(api.deleteMyAgentModelOverride).not.toHaveBeenCalled();
  });
});

describe('AgentConfigSection — allowed-skills multi-select', () => {
  beforeEach(() => {
    (api.getConfig as any).mockResolvedValue({ claudeBin: '/bin/claude', _file: {} });
    (api.get as any).mockResolvedValue({});
    (api.getModelConfig as any).mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: { 'claude-code': 'claude-opus-4-8' },
      engineValidModels: { 'claude-code': ['claude-opus-4-8'] },
    });
    (api.getMyAgentModelOverrides as any).mockResolvedValue({ agentModelOverrides: {} });
    (api.getMyAgentEngineOverrides as any).mockResolvedValue({ agentEngineOverrides: {} });
    (api.getSkills as any).mockResolvedValue([
      { id: 'kanban', name: 'kanban', description: 'manage cards' },
      { id: '1password', name: '1password', description: 'secrets' },
      { id: 'aws-cli', name: 'aws-cli', description: 'aws' },
    ]);
    (api.updateAgent as any).mockResolvedValue({ ok: true } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const baseAgent = {
    id: 'agent-a',
    name: 'Agent A',
    role: 'lead',
    engine: 'claude-code',
    active: true,
    projectId: 'p1',
  };

  function renderSection(agents: any) {
    return render(
      <AgentConfigSection
        projects={[{ id: 'p1', name: 'Acme', cwd: '/tmp', agents: [] }]}
        agents={agents}
        projectId="p1"
        onAgentsChange={() => {}}
      />,
    );
  }

  it('defaults to ALL (unrestricted) and hides the checkbox list', async () => {
    const { findByText, getByTestId, queryByTestId } = renderSection([baseAgent]);
    fireEvent.click(await findByText('Agent A' as any));
    expect(getByTestId('agent-allowed-skills-toggle').textContent).toBe('ALL');
    expect(queryByTestId('agent-allowed-skills-list')).toBeNull();
  });

  it('enabling restriction seeds with every skill and lets you remove one', async () => {
    const { findByText, getByTestId, findByTestId } = renderSection([baseAgent]);
    fireEvent.click(await findByText('Agent A' as any));
    // Toggle is disabled until the skill list loads — wait for that.
    await waitFor(() => expect(getByTestId('agent-allowed-skills-toggle')).not.toBeDisabled());

    // Turn restriction ON — seeds the allowlist with all known skill ids.
    fireEvent.click(getByTestId('agent-allowed-skills-toggle' as any));
    expect(getByTestId('agent-allowed-skills-toggle').textContent).toBe('RESTRICTED');
    const list = await findByTestId('agent-allowed-skills-list');
    const boxes = within(list).getAllByRole('checkbox');
    expect(boxes!).toHaveLength(3);
    expect(boxes.every((b: any) => (b as any).checked)).toBe(true);

    // Uncheck 1password, then save.
    fireEvent.click(boxes[1] as any);
    fireEvent.click(await findByText('Save' as any));

    await waitFor(() => expect(api.updateAgent).toHaveBeenCalled());
    const payload = (api.updateAgent as any).mock.calls[0][1];
    expect(payload.allowedSkills).toEqual(['kanban', 'aws-cli']);
  });

  it('an already-restricted agent renders only its allowed boxes checked', async () => {
    const { findByText, getByTestId, findByTestId } = renderSection([
      { ...baseAgent, allowedSkills: ['kanban'] },
    ]);
    fireEvent.click(await findByText('Agent A' as any));
    expect(getByTestId('agent-allowed-skills-toggle').textContent).toBe('RESTRICTED');
    const list = await findByTestId('agent-allowed-skills-list');
    const boxes = within(list).getAllByRole('checkbox');
    expect((boxes[0] as any).checked).toBe(true); // kanban
    expect((boxes[1] as any).checked).toBe(false); // 1password
    expect((boxes[2] as any).checked).toBe(false); // aws-cli
  });

  it('toggling RESTRICTED off clears the allowlist (sends null)', async () => {
    const { findByText, getByTestId } = renderSection([
      { ...baseAgent, allowedSkills: ['kanban'] },
    ]);
    fireEvent.click(await findByText('Agent A' as any));
    await waitFor(() => expect(getByTestId('agent-allowed-skills-toggle')).not.toBeDisabled());
    fireEvent.click(getByTestId('agent-allowed-skills-toggle' as any));
    expect(getByTestId('agent-allowed-skills-toggle').textContent).toBe('ALL');
    fireEvent.click(await findByText('Save' as any));
    await waitFor(() => expect(api.updateAgent).toHaveBeenCalled());
    expect((api.updateAgent as any).mock.calls[0][1].allowedSkills).toBeNull();
  });

  it('keeps the toggle disabled and shows an error when the skill list fails to load', async () => {
    // Regression: a transient /agents/:id/skills failure must NOT enable the
    // ALL->RESTRICTED toggle with an empty allowlist (a save would then write
    // allowedSkills: [] and wipe every skill).
    (api.getSkills as any).mockRejectedValueOnce(new Error('boom'));
    const { findByText, getByTestId, findByTestId, queryByTestId } = renderSection([baseAgent]);
    fireEvent.click(await findByText('Agent A' as any));

    await findByTestId('agent-allowed-skills-error');
    expect(getByTestId('agent-allowed-skills-toggle')).toBeDisabled();
    expect(getByTestId('agent-allowed-skills-toggle').textContent).toBe('ALL');

    // Clicking the disabled toggle must not flip to RESTRICTED.
    fireEvent.click(getByTestId('agent-allowed-skills-toggle' as any));
    expect(getByTestId('agent-allowed-skills-toggle').textContent).toBe('ALL');
    expect(queryByTestId('agent-allowed-skills-list')).toBeNull();
  });

  it('Retry re-fetches and enables restriction after a failed load', async () => {
    (api.getSkills as any).mockRejectedValueOnce(new Error('boom'));
    const { findByText, getByTestId, findByTestId } = renderSection([baseAgent]);
    fireEvent.click(await findByText('Agent A' as any));

    await findByTestId('agent-allowed-skills-error');
    // Next fetch (triggered by Retry) succeeds.
    fireEvent.click(getByTestId('agent-allowed-skills-retry' as any));

    await waitFor(() => expect(getByTestId('agent-allowed-skills-toggle')).not.toBeDisabled());
    fireEvent.click(getByTestId('agent-allowed-skills-toggle' as any));
    const list = await findByTestId('agent-allowed-skills-list');
    expect(within(list).getAllByRole('checkbox')).toHaveLength(3);
  });
});
