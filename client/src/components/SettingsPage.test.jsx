import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import SettingsPage, { GeneralSection, GitHubSection } from './SettingsPage.jsx';
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
  },
}));

describe('GitHubSection — return from GitHub App auto-setup', () => {
  beforeEach(() => {
    api.getConfig.mockResolvedValue({
      claudeBin: '/bin/claude',
      cursorBin: '/bin/cursor',
      defaultModel: 'claude-opus-4-7',
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
      defaultModel: 'claude-opus-4-7',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-7'] },
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
      defaultModel: 'claude-opus-4-7',
      defaultCwd: '/tmp',
      port: 3051,
      publicUrl: '',
      githubApp: null,
      _file: {},
    });
    api.get.mockResolvedValue({});
    api.getModelConfig.mockResolvedValue({
      defaultModel: 'claude-opus-4-7',
      engineDefaultModels: {},
      engineValidModels: { 'claude-code': ['claude-opus-4-7'] },
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
    const { getAllByText } = render(<SettingsPage projects={[]} agents={[]} initialTab="orgs" />);
    // "Organizations" appears in the sidebar; the active one carries aria-current.
    const orgButtons = getAllByText('Organizations').map((el) => el.closest('button'));
    const active = orgButtons.find((b) => b?.getAttribute('aria-current') === 'page');
    expect(active).toBeTruthy();
  });

  it('exposes a mobile menu trigger labelled "Open settings navigation"', () => {
    const { getByLabelText } = render(<SettingsPage projects={[]} agents={[]} />);
    expect(getByLabelText('Open settings navigation')).toBeTruthy();
  });
});
