import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { GitHubSection } from './SettingsPage.jsx';
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
    get: vi.fn(),
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
