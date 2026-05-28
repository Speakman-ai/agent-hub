import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import SettingsPage, {
  GeneralSection,
  GitHubSection,
  OrganizationsSection,
  ProjectsSection,
} from './SettingsPage.jsx';
import { api } from '../utils/api.js';

/**
 * Regression guard for the bug: "GitHub App not creating sidebar agent".
 *
 * When the user completes the GitHub App auto-setup flow, the server
 * redirects to `/#/settings?githubApp=ready`. At that moment the server
 * has already run `ensureReviewerAgents()` and (via the fix) broadcast
 * `projects_updated` — but the WebSocket may have been disconnected
 * during the browser redirect and missed the event entirely.
 *
 * The SettingsPage ready-redirect effect must therefore ALSO call
 * `onProjectsChange()` locally so the sidebar picks up the newly seeded
 * Reviewer agent without requiring a full page reload.
 */

vi.mock('../utils/api.js', () => ({
  api: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    get: vi.fn(),
    getModelConfig: vi.fn(),
    getProjectWebhooks: vi.fn().mockResolvedValue([]),
    updateProject: vi.fn().mockResolvedValue({ ok: true }),
    deleteProject: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

// Role gating helpers — `hasRole` is read at render-time to filter the
// settings sidebar. Default to Admin so the existing tests (which don't
// care about the role) keep seeing every tab; individual role-gating
// tests below override via `vi.mocked(hasRole).mockReturnValueOnce(...)`.
vi.mock('../utils/auth.js', async () => {
  const actual = await vi.importActual('../utils/auth.js');
  return {
    ...actual,
    hasRole: vi.fn(() => true),
    getUserRole: vi.fn(() => 'Admin'),
    // Default to false (cloud/JWT mode); local-mode tests override below.
    isLocalMode: vi.fn(() => false),
  };
});

// `OrganizationsSection` calls into `utils/orgs.js` at render time.
// Mock the surface it touches so the focused tests below don't depend on
// localStorage / Electron file storage / live server fetches.
vi.mock('../utils/orgs.js', async () => {
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

describe('GitHubSection — return from GitHub App auto-setup', () => {
  beforeEach(() => {
    api.getConfig.mockResolvedValue({
      claudeBin: '/bin/claude',
      cursorBin: '/bin/cursor',
      defaultModel: 'claude-opus-4-8',
      defaultCwd: '/tmp',
      port: 3051,
      publicUrl: '',
      githubApp: null,
      botGithubTokenSet: false,
      botGithubUser: null,
      anthropicApiKeySet: false,
      _file: {},
    });
    // `/github-app/status` and other GET calls — resolve to empty objects.
    api.get.mockResolvedValue({});
    api.getModelConfig.mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-8'] },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Reset the hash so the effect doesn't fire on subsequent tests.
    window.history.replaceState(null, '', '/');
  });

  it('calls onProjectsChange when returning with ?githubApp=ready', async () => {
    window.history.replaceState(null, '', '/#/settings?githubApp=ready');
    const onProjectsChange = vi.fn();

    render(<GitHubSection projects={[]} onProjectsChange={onProjectsChange} />);

    await waitFor(() => {
      expect(onProjectsChange).toHaveBeenCalled();
    });
  });

  it('calls onProjectsChange when returning with ?githubApp=created', async () => {
    // `created` is the status used after a brand-new App manifest flow —
    // the server has just created the App and seeded reviewers in one go,
    // so the sidebar still needs to refresh.
    window.history.replaceState(null, '', '/#/settings?githubApp=created');
    const onProjectsChange = vi.fn();

    render(<GitHubSection projects={[]} onProjectsChange={onProjectsChange} />);

    await waitFor(() => {
      expect(onProjectsChange).toHaveBeenCalled();
    });
  });

  it('does NOT call onProjectsChange when the URL has no githubApp query param', async () => {
    window.history.replaceState(null, '', '/#/settings');
    const onProjectsChange = vi.fn();

    render(<GitHubSection projects={[]} onProjectsChange={onProjectsChange} />);

    // Give any pending effects a tick to run.
    await waitFor(() => {
      expect(api.getConfig).toHaveBeenCalled();
    });
    expect(onProjectsChange).not.toHaveBeenCalled();
  });

  it('does NOT call onProjectsChange when ?githubApp=error (user saw an alert instead)', async () => {
    // On error we don't refresh projects — nothing changed server-side.
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    window.history.replaceState(
      null,
      '',
      '/#/settings?githubApp=error&message=' + encodeURIComponent('boom'),
    );
    const onProjectsChange = vi.fn();

    render(<GitHubSection projects={[]} onProjectsChange={onProjectsChange} />);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalled();
    });
    expect(onProjectsChange).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });
});

describe('SettingsPage — tab labels', () => {
  beforeEach(() => {
    api.getConfig.mockResolvedValue({
      claudeBin: '/bin/claude',
      cursorBin: '/bin/cursor',
      defaultModel: 'claude-opus-4-8',
      defaultCwd: '/tmp',
      port: 3051,
      publicUrl: '',
      githubApp: null,
      botGithubTokenSet: false,
      botGithubUser: null,
      anthropicApiKeySet: false,
      _file: {},
    });
    api.get.mockResolvedValue({});
    api.getModelConfig.mockResolvedValue({
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

  it('redirects legacy Settings → Integrations deep link to Skills MCP', async () => {
    const onNavigate = vi.fn();
    render(
      <SettingsPage
        projects={[]}
        agents={[]}
        onAgentsChange={() => {}}
        initialTab="integrations"
        onNavigate={onNavigate}
      />,
    );
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('skills:mcp');
    });
  });

  it('exposes a Preview tab in the Workspace group', async () => {
    // The Preview settings panel is the only place users can configure
    // the per-session worktree preview without hand-editing
    // projects.json. It must appear in the sidebar under Workspace.
    const { findByRole } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} />,
    );
    expect(await findByRole('button', { name: /^Preview$/ })).toBeTruthy();
  });

  it('labels the host-wide CLI auth tab "Global AI Authentication"', async () => {
    // The host-wide tab manages credentials in ~/.agent-hub/data/config.json
    // and is rendered side-by-side with the per-user Account page. Calling
    // it "Global AI Authentication" makes its scope obvious so the per-user
    // vs. host-wide split stops confusing users.
    const { findByText, queryByRole, queryByText } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} />,
    );

    expect(await findByText('Global AI Authentication')).toBeTruthy();
    // The old label is gone — guard against accidental regression.
    expect(queryByText('AI Authentication')).toBeNull();
    // Regression guard: don't accidentally render a tab labeled just "Auth".
    expect(queryByRole('button', { name: /^Auth$/ })).toBeNull();
  });
});

/**
 * Role-gated visibility of the host-wide "Global AI Authentication" tab.
 *
 * The tab writes to `~/.agent-hub/data/config.json` — a host-wide credential
 * file — so only Admin/Owner users can act on it. Regular users manage their
 * own per-user CLI creds on Settings → Account. Hiding the tab from non-Admins
 * eliminates the long-standing "two places to enter auth" confusion.
 *
 * Server-side enforcement of the underlying permissions is unchanged; this
 * is purely a UX gate, so we only need to verify the client-side filter.
 */
describe('SettingsPage — Global AI Authentication tab role gating', () => {
  beforeEach(async () => {
    api.getConfig.mockResolvedValue({
      claudeBin: '/bin/claude',
      cursorBin: '/bin/cursor',
      defaultModel: 'claude-opus-4-8',
      defaultCwd: '/tmp',
      port: 3051,
      publicUrl: '',
      githubApp: null,
      _file: {},
    });
    api.get.mockResolvedValue({});
    api.getModelConfig.mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-8'] },
    });
    const { hasRole, isLocalMode } = await import('../utils/auth.js');
    // Reset to default (Admin sees everything, not local mode) before each
    // test — individual tests override below.
    vi.mocked(hasRole).mockImplementation(() => true);
    vi.mocked(isLocalMode).mockImplementation(() => false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('renders the tab for Admin/Owner users', async () => {
    const { hasRole } = await import('../utils/auth.js');
    vi.mocked(hasRole).mockImplementation((min) => min === 'Admin');

    const { findByText } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} />,
    );

    expect(await findByText('Global AI Authentication')).toBeTruthy();
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

    expect(queryByText('Global AI Authentication')).toBeNull();
    // And the old name doesn't sneak back either.
    expect(queryByText('AI Authentication')).toBeNull();
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
    expect(queryByText('Global AI Authentication')).toBeNull();
  });

  it('does not render the host-wide auth panel for non-Admin even if tab state somehow lands on claude-auth', async () => {
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
    // The combined-host-auth panel is wrapped in `space-y-10` with the
    // ClaudeAuth/Gemini/Cursor/Codex sections. The Cursor section's
    // distinctive heading is a reliable signal that the panel rendered.
    expect(queryByText('Cursor Agent Authentication')).toBeNull();
  });

  it('shows the tab in local-bundled mode (no JWT / activeOrgIsLocal=true)', async () => {
    // Regression guard for Electron / single-user self-host: when the
    // server returns activeOrgIsLocal=true it never issues a JWT, so
    // hasRole() returns false. The tab must still appear because local-mode
    // users own the host and need to configure claudeBin / cursorBin.
    const { hasRole, isLocalMode } = await import('../utils/auth.js');
    vi.mocked(hasRole).mockImplementation(() => false); // no JWT → no role
    vi.mocked(isLocalMode).mockImplementation(() => true); // local-mode

    const { findByText } = render(
      <SettingsPage projects={[]} agents={[]} onAgentsChange={() => {}} />,
    );

    expect(await findByText('Global AI Authentication')).toBeTruthy();
  });
});

describe('GeneralSection — CLI binary paths', () => {
  beforeEach(() => {
    api.getConfig.mockResolvedValue({
      claudeBin: '/usr/bin/claude',
      cursorBin: '/home/agenthub/.local/bin/agent',
      geminiBin: '/usr/local/bin/gemini',
      codexBin: '/usr/local/bin/codex',
      port: 3051,
      defaultCwd: '/tmp',
      publicUrl: '',
      githubApp: null,
      _file: {},
    });
    api.updateConfig.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete window.electronAPI;
  });

  it('shows desktop PATH hint when running inside Electron', async () => {
    window.electronAPI = { isElectron: true };
    const { getByText } = render(<GeneralSection />);
    await waitFor(() => {
      expect(getByText(/Desktop app:/)).toBeTruthy();
    });
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
    fireEvent.change(cursorInput, { target: { value: '/usr/local/bin/agent' } });

    fireEvent.click(getByText('Save'));

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
    fireEvent.change(codexInput, { target: { value: '/opt/codex/bin/codex' } });

    fireEvent.click(getByText('Save'));

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
    api.getConfig.mockResolvedValue({
      claudeBin: '/bin/claude',
      cursorBin: '/bin/cursor',
      defaultModel: 'claude-opus-4-8',
      defaultCwd: '/tmp',
      port: 3051,
      publicUrl: '',
      githubApp: null,
      _file: {},
    });
    api.get.mockResolvedValue({});
    api.getModelConfig.mockResolvedValue({
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

  it('groups tabs into Workspace / Agents & Auth / Automation / Operations sections', () => {
    const { getAllByText } = render(<SettingsPage projects={[]} agents={[]} />);
    expect(getAllByText('Workspace').length).toBeGreaterThan(0);
    expect(getAllByText('Agents & Auth').length).toBeGreaterThan(0);
    expect(getAllByText('Automation').length).toBeGreaterThan(0);
    expect(getAllByText('Operations').length).toBeGreaterThan(0);
  });

  it('switches the active section when a sidebar item is clicked', async () => {
    const { getAllByText, queryByText } = render(<SettingsPage projects={[]} agents={[]} />);
    // "Account" is the second sidebar entry. Click it and the Account section heading should appear.
    const accountButtons = getAllByText('Account');
    fireEvent.click(accountButtons[0]);
    // The AccountSection renders its own UI; we don't need to assert its internals,
    // only that the click handler updates state and re-renders without throwing.
    await waitFor(() => {
      expect(queryByText('Workspace')).toBeTruthy();
    });
  });

  it('marks the active sidebar item with aria-current="page"', () => {
    // Use the "Account" tab (always visible) — the previous version targeted
    // "Organizations", but that tab is now Electron-only and absent in the
    // jsdom (browser-like) test environment.
    const { getAllByText } = render(
      <SettingsPage projects={[]} agents={[]} initialTab="account" />,
    );
    const accountButtons = getAllByText('Account').map((el) => el.closest('button'));
    const active = accountButtons.find((b) => b?.getAttribute('aria-current') === 'page');
    expect(active).toBeTruthy();
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
          delete globalThis.window.electronAPI;
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
  // connection + GitHub App config — and nothing per-project.
  it('exposes a "Projects" entry in the Workspace group', () => {
    const { getAllByText } = render(<SettingsPage projects={[]} agents={[]} />);
    expect(getAllByText('Projects').length).toBeGreaterThan(0);
  });

  it('renders the project list on the Projects tab (not the GitHub tab)', async () => {
    const projects = [
      { id: 'p1', name: 'Acme', color: '#ff0000', cwd: '/tmp/a', githubRepo: '', agents: [] },
    ];
    const { getAllByText, queryByText } = render(
      <SettingsPage projects={projects} agents={[]} initialTab="projects" />,
    );
    // The "Projects & Repos" subheading is the unique marker for the project
    // list block we moved off the GitHub tab.
    await waitFor(() => {
      expect(queryByText('Projects & Repos')).toBeTruthy();
    });
    // The project name renders as a row under it.
    expect(getAllByText('Acme').length).toBeGreaterThan(0);
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
    expect(queryByText('Projects & Repos')).toBeFalsy();
  });

  it('renders the GitHub Account ("Sign in with GitHub") block on the GitHub tab', async () => {
    const { findByText } = render(<SettingsPage projects={[]} agents={[]} initialTab="github" />);
    // GithubConnectionSection's heading — proves the personal GitHub identity
    // is now visible on the same page that hosts the GitHub App config.
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
    delete window.electronAPI;
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  it('hides the Connection Mode toggle on web (no electronAPI)', () => {
    const { queryByText, getByText } = render(<OrganizationsSection />);
    // The orgs heading still renders — we only dropped the toggle, not
    // the section.
    expect(getByText('Organizations')).toBeTruthy();
    // No Connection Mode label anywhere on the page.
    expect(queryByText(/Connection Mode/i)).toBeNull();
    // No Local / Remote toggle buttons under the Add-Organization form.
    fireEvent.click(getByText(/Add Organization/i));
    expect(queryByText(/Connection Mode/i)).toBeNull();
    expect(queryByText(/Server runs on this machine/i)).toBeNull();
    expect(queryByText(/Connect to a remote server/i)).toBeNull();
  });

  it('renders the Connection Mode toggle on Electron (window.electronAPI.isElectron)', () => {
    window.electronAPI = { isElectron: true };
    const { getByText } = render(<OrganizationsSection />);
    // Click "Add Organization" to expand the new-org form, where the toggle
    // is unconditionally rendered for the Electron build.
    fireEvent.click(getByText(/Add Organization/i));
    expect(getByText(/Connection Mode/i)).toBeTruthy();
    expect(getByText(/Server runs on this machine/i)).toBeTruthy();
    expect(getByText(/Connect to a remote server/i)).toBeTruthy();
  });
});

describe('ProjectsSection — visibility toggle', () => {
  beforeEach(() => {
    api.getModelConfig.mockResolvedValue({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-8'] },
    });
    api.updateProject.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeProject(overrides = {}) {
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
      expect(sel.value).toBe('private');
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
    fireEvent.change(sel, { target: { value: 'private' } });

    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith('p1', { visibility: 'private' });
    });
    await waitFor(() => {
      expect(onProjectsChange).toHaveBeenCalled();
    });
  });

  it('surfaces a server error via showToast when updateProject rejects (e.g. 403)', async () => {
    api.updateProject.mockRejectedValueOnce(
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
    fireEvent.change(sel, { target: { value: 'private' } });

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/Only org Owners can make a shared project private/),
        'error',
      );
    });
  });
});

/**
 * LAN mode toggle on the GitHub settings page. The polling / webhook-skip
 * behavior itself is covered server-side; these tests guard the UI wiring:
 *
 *   • Initial state mirrors `data.lanMode` from GET /api/config.
 *   • Toggling fires PATCH /api/config { lanMode } and reflects the new
 *     state in the rendered banner.
 *   • Failure rolls back the optimistic update so the toggle never
 *     claims a state the server didn't accept.
 */
describe('GitHubSection — LAN mode toggle', () => {
  beforeEach(() => {
    api.getConfig.mockResolvedValue({
      claudeBin: '/bin/claude',
      cursorBin: '/bin/cursor',
      defaultModel: 'claude-opus-4-8',
      defaultCwd: '/tmp',
      port: 3051,
      publicUrl: '',
      githubApp: null,
      botGithubTokenSet: false,
      botGithubUser: null,
      anthropicApiKeySet: false,
      lanMode: false,
      _file: {},
    });
    api.get.mockResolvedValue({});
    api.updateConfig.mockResolvedValue({ ok: true });
    api.getModelConfig?.mockResolvedValue?.({
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-8'] },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the toggle reflecting the loaded lanMode value', async () => {
    api.getConfig.mockResolvedValue({
      claudeBin: '/bin/claude',
      cursorBin: '/bin/cursor',
      defaultModel: 'claude-opus-4-8',
      defaultCwd: '/tmp',
      port: 3051,
      publicUrl: '',
      githubApp: null,
      botGithubTokenSet: false,
      botGithubUser: null,
      anthropicApiKeySet: false,
      lanMode: true,
      _file: {},
    });

    const { findByTestId, findByText } = render(<GitHubSection projects={[]} />);
    const toggle = await findByTestId('lan-mode-toggle');
    expect(toggle.checked).toBe(true);
    expect(await findByText(/LAN mode is on/i)).toBeInTheDocument();
  });

  it('PATCHes /api/config { lanMode: true } when toggled on', async () => {
    const { findByTestId } = render(<GitHubSection projects={[]} />);
    const toggle = await findByTestId('lan-mode-toggle');
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ lanMode: true });
    });
  });

  it('rolls back the toggle when the PATCH fails', async () => {
    api.updateConfig.mockRejectedValueOnce(new Error('network down'));
    // Silence the alert() we fire on failure so the test doesn't pop a real dialog.
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    const { findByTestId } = render(<GitHubSection projects={[]} />);
    const toggle = await findByTestId('lan-mode-toggle');
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    await waitFor(() => expect(api.updateConfig).toHaveBeenCalledTimes(1));
    // After the rollback the toggle should be back to its original state.
    await waitFor(() => expect(toggle.checked).toBe(false));
    alertSpy.mockRestore();
  });
});
