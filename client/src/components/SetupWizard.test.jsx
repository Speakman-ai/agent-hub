import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
  getAuthHeaders: vi.fn(() => ({})),
  saveConnectionConfig: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock('../utils/orgs.js', () => ({
  createOrg: vi.fn(),
  switchOrg: vi.fn(),
  getActiveOrg: vi.fn(),
  updateOrg: vi.fn(),
}));

import SetupWizard from './SetupWizard.jsx';
import { saveConnectionConfig, testConnection } from '../utils/connection.js';
import { createOrg, switchOrg, updateOrg, getActiveOrg } from '../utils/orgs.js';

beforeEach(() => {
  saveConnectionConfig.mockReset();
  testConnection.mockReset();
  createOrg.mockReset();
  switchOrg.mockReset();
  updateOrg.mockReset();
  getActiveOrg.mockReset();
  getActiveOrg.mockReturnValue(null);
  delete window.electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.electronAPI;
});

// The wizard renders the same Step 2 heading regardless of build, but the
// Connection Mode section only appears on Electron now (web has no use for
// a Local/Remote toggle — the page's origin *is* the server URL). Tests
// that need the toggle must set `window.electronAPI.isElectron = true`
// *before* calling this helper; web-only tests can advance without it.
async function advanceToOrgStep() {
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await waitFor(() => expect(screen.getByText(/Create Your Organization/i)).toBeInTheDocument());
}

describe('SetupWizard — remote mode (Electron only)', () => {
  it('saves connection config and navigates without touching local orgs', async () => {
    testConnection.mockResolvedValue({ ok: true, message: 'Connected' });
    window.electronAPI = { isElectron: true, navigateToOrg: vi.fn() };

    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    // Pick Remote
    fireEvent.click(screen.getByRole('button', { name: /remote/i }));

    // Fill URL
    fireEvent.change(screen.getByPlaceholderText(/my-server\.example\.com/i), {
      target: { value: 'https://hub.example.com/' },
    });

    // Click Continue — component will run its own testConnection internally
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    await waitFor(() => {
      expect(saveConnectionConfig).toHaveBeenCalledWith({
        mode: 'remote',
        remoteUrl: 'https://hub.example.com',
        apiKey: '',
      });
    });
    expect(window.electronAPI.navigateToOrg).toHaveBeenCalled();
    // Critically: no local org was created or updated.
    expect(createOrg).not.toHaveBeenCalled();
    expect(updateOrg).not.toHaveBeenCalled();
    expect(switchOrg).not.toHaveBeenCalled();
  });

  it('blocks progression when remote test fails', async () => {
    testConnection.mockResolvedValue({ ok: false, message: 'refused' });
    window.electronAPI = { isElectron: true, navigateToOrg: vi.fn() };

    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    fireEvent.click(screen.getByRole('button', { name: /remote/i }));
    fireEvent.change(screen.getByPlaceholderText(/my-server\.example\.com/i), {
      target: { value: 'https://bad.example.com' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    // Still on step 2 (org step), config not saved, navigation not triggered.
    expect(saveConnectionConfig).not.toHaveBeenCalled();
    expect(window.electronAPI.navigateToOrg).not.toHaveBeenCalled();
    expect(await screen.findByText(/connection test failed/i)).toBeInTheDocument();
  });

  it('requires a URL before continuing in remote mode', async () => {
    window.electronAPI = { isElectron: true, navigateToOrg: vi.fn() };
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    fireEvent.click(screen.getByRole('button', { name: /remote/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    expect(testConnection).not.toHaveBeenCalled();
    expect(saveConnectionConfig).not.toHaveBeenCalled();
    expect(await screen.findByText(/enter a server url/i)).toBeInTheDocument();
  });
});

describe('SetupWizard — local mode (regression)', () => {
  it('creates a local org and advances to step 3', async () => {
    createOrg.mockResolvedValue({ id: 'org-new' });
    // Run as Electron so the toggle is rendered — this test is asserting
    // the local-mode branch still works end-to-end, not the web hiding.
    window.electronAPI = { isElectron: true };

    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    // Default mode is local — just click Continue.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    await waitFor(() => {
      expect(createOrg).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Personal', mode: 'local' }),
      );
    });
    expect(switchOrg).toHaveBeenCalledWith('org-new');
    // Critically: no connection config was rewritten for the local path.
    expect(saveConnectionConfig).not.toHaveBeenCalled();
  });
});

describe('SetupWizard — Step 3 Claude credential gate', () => {
  // Helper: set up a fetch mock that routes by URL substring.
  // Routes return JSON Response objects so the component's
  // `await res.json()` works the same as in production.
  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Walk the wizard from Welcome (step 1) → Org (step 2) → Configure (step 3).
  // Defaults to local-mode org so Step 3 actually mounts.
  async function advanceToStep3() {
    createOrg.mockResolvedValue({ id: 'org-test' });
    // Welcome → Org
    await advanceToOrgStep();
    // Org → Configure
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });
    await waitFor(() => expect(screen.getByText(/Configure Your Tools/i)).toBeInTheDocument());
  }

  it('disables Continue when no creds are configured (a)', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (typeof url === 'string' && url.includes('/config/claude-auth')) {
        return jsonResponse({
          oauth: { loggedIn: false },
          apiKey: { configured: false },
          oauthToken: { configured: false },
          activeMethod: null,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SetupWizard
        setupStatus={{ engines: { 'claude-code': { available: true, path: '/usr/bin/claude' } } }}
        onComplete={() => {}}
      />,
    );
    await advanceToStep3();

    // Wait until the GET resolves and the credentials card renders the
    // "Required" pill (not the loading spinner).
    await waitFor(() =>
      expect(screen.getByTestId('claude-credentials')).toHaveTextContent(/Required/i),
    );

    const continueBtn = screen.getByRole('button', { name: /save & continue/i });
    expect(continueBtn).toBeDisabled();
  });

  it('enables Continue after saving an API key (b)', async () => {
    let apiKeyConfigured = false;
    const fetchMock = vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('/config/claude-auth/api-key')) {
        apiKeyConfigured = true;
        const body = JSON.parse(opts.body);
        return jsonResponse({ ok: true, masked: `…${body.apiKey.slice(-4)}` });
      }
      if (u.includes('/config/claude-auth/oauth-token')) {
        return jsonResponse({ ok: true });
      }
      if (u.includes('/config/claude-auth')) {
        return jsonResponse({
          oauth: { loggedIn: false },
          apiKey: { configured: apiKeyConfigured, source: 'config' },
          oauthToken: { configured: false },
          activeMethod: apiKeyConfigured ? 'api-key' : null,
        });
      }
      if (u.includes('/setup/configure')) return jsonResponse({ ok: true });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SetupWizard
        setupStatus={{ engines: { 'claude-code': { available: true, path: '/usr/bin/claude' } } }}
        onComplete={() => {}}
      />,
    );
    await advanceToStep3();
    await waitFor(() =>
      expect(screen.getByTestId('claude-credentials')).toHaveTextContent(/Required/i),
    );

    // API Key tab is active by default — paste + save.
    const keyInput = screen.getByPlaceholderText(/sk-ant-api03/i);
    fireEvent.change(keyInput, { target: { value: 'sk-ant-api03-fake-test-key-1234' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save api key/i }));
    });

    // POST hit
    expect(
      fetchMock.mock.calls.some(
        ([u, init]) => String(u).includes('/config/claude-auth/api-key') && init?.method === 'POST',
      ),
    ).toBe(true);

    // After re-fetch, success state shown and Continue enabled.
    await waitFor(() =>
      expect(screen.getByTestId('claude-credentials')).toHaveTextContent(/API key configured/i),
    );
    expect(screen.getByRole('button', { name: /save & continue/i })).not.toBeDisabled();
  });

  it('enables Continue after saving a setup token (c)', async () => {
    let tokenConfigured = false;
    const fetchMock = vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('/config/claude-auth/oauth-token')) {
        tokenConfigured = true;
        const body = JSON.parse(opts.body);
        // Server collapses whitespace; assert here that the client did too.
        expect(body.oauthToken).not.toMatch(/\s/);
        return jsonResponse({ ok: true, masked: `…${body.oauthToken.slice(-4)}` });
      }
      if (u.includes('/config/claude-auth')) {
        return jsonResponse({
          oauth: { loggedIn: false },
          apiKey: { configured: false },
          oauthToken: {
            configured: tokenConfigured,
            source: 'config',
            masked: tokenConfigured ? '…wxyz' : null,
          },
          activeMethod: tokenConfigured ? 'oauth' : null,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SetupWizard
        setupStatus={{ engines: { 'claude-code': { available: true, path: '/usr/bin/claude' } } }}
        onComplete={() => {}}
      />,
    );
    await advanceToStep3();
    await waitFor(() =>
      expect(screen.getByTestId('claude-credentials')).toHaveTextContent(/Required/i),
    );

    // Switch to setup-token tab.
    fireEvent.click(screen.getByRole('button', { name: /setup token/i }));

    // Paste a token with whitespace (simulating a multi-line terminal paste).
    const tokenInput = screen.getByPlaceholderText(/sk-ant-oat01/i);
    fireEvent.change(tokenInput, {
      target: { value: 'sk-ant-oat01-\n  fake\ttoken-wxyz' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save setup token/i }));
    });

    expect(
      fetchMock.mock.calls.some(
        ([u, init]) =>
          String(u).includes('/config/claude-auth/oauth-token') && init?.method === 'POST',
      ),
    ).toBe(true);

    await waitFor(() =>
      // The pill text varies with `activeMethod` ("OAuth active" vs "Setup
      // token configured") but both render the masked-trailing-4. Assert on
      // the mask — that's the unambiguous signal that the GET re-fetch saw
      // the new token.
      expect(screen.getByTestId('claude-credentials')).toHaveTextContent(/…wxyz/),
    );
    expect(screen.getByRole('button', { name: /save & continue/i })).not.toBeDisabled();
  });

  it('enables Continue without typing when GET reports apiKey already configured (d)', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (typeof url === 'string' && url.includes('/config/claude-auth')) {
        return jsonResponse({
          oauth: { loggedIn: false },
          apiKey: { configured: true, source: 'env' },
          oauthToken: { configured: false },
          activeMethod: 'api-key',
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SetupWizard
        setupStatus={{ engines: { 'claude-code': { available: true, path: '/usr/bin/claude' } } }}
        onComplete={() => {}}
      />,
    );
    await advanceToStep3();

    await waitFor(() =>
      expect(screen.getByTestId('claude-credentials')).toHaveTextContent(/API key configured/i),
    );
    // No tab UI shown when already configured.
    expect(screen.queryByPlaceholderText(/sk-ant-api03/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save & continue/i })).not.toBeDisabled();
  });
});

describe('SetupWizard — Step 3 Cursor path auth probe', () => {
  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('calls cursor-auth with cursorBin query for the in-form Cursor binary path', async () => {
    const wizardPath = '/home/test/.local/bin/cursor-agent';
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/config/claude-auth')) {
        return jsonResponse({
          oauth: { loggedIn: false },
          apiKey: { configured: false },
          oauthToken: { configured: false },
          activeMethod: null,
        });
      }
      if (u.includes('/config/cursor-auth')) {
        // The wizard's own probe carries `cursorBin` so a path typed in the
        // form (not yet persisted) is honored before Save & Continue runs
        // /setup/configure. The embedded `<CursorAuthSection />` also calls
        // this endpoint but without the query string — only assert the wizard
        // probe; the section's plain GET is asserted on separately below.
        return jsonResponse({
          oauth: { loggedIn: true },
          activeMethod: 'oauth',
          uiStatus: 'authenticated',
        });
      }
      if (u.includes('/config/codex-auth')) {
        return jsonResponse({ activeMethod: 'none' });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SetupWizard
        setupStatus={{
          engines: {
            'claude-code': { available: true, path: '/usr/bin/claude' },
            'cursor-agent': { available: true, path: wizardPath },
          },
        }}
        onComplete={() => {}}
      />,
    );

    createOrg.mockResolvedValue({ id: 'org-test' });
    await advanceToOrgStep();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });
    await waitFor(() => expect(screen.getByText(/Configure Your Tools/i)).toBeInTheDocument());

    await waitFor(() => {
      const cursorCallsWithBin = fetchMock.mock.calls.filter(([u]) => {
        const s = String(u);
        if (!s.includes('/config/cursor-auth')) return false;
        const parsed = new URL(s, 'http://localhost');
        return parsed.searchParams.get('cursorBin') === wizardPath;
      });
      expect(cursorCallsWithBin.length).toBeGreaterThan(0);
    });
  });
});

describe('SetupWizard — Codex ChatGPT device login subsection', () => {
  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('renders the device-login button when Codex CLI is enabled and starts the flow on click', async () => {
    const codexBin = '/usr/local/bin/codex';
    const wizardCursorBin = '/usr/local/bin/cursor-agent';
    let deviceLoginCalls = 0;
    const fetchMock = vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('/config/codex-auth/device-login')) {
        deviceLoginCalls += 1;
        // Surface a verification URL + user code the same shape the real
        // server returns so the wizard renders the panel.
        return jsonResponse({
          deviceAuthUrl: 'https://chatgpt.com/device',
          userCode: 'WZBN-RVLM',
        });
      }
      if (u.includes('/config/codex-auth')) {
        return jsonResponse({
          activeMethod: 'none',
          uiStatus: 'missing',
          loginInProgress: false,
          binary: { present: true, path: codexBin },
        });
      }
      if (u.includes('/config/cursor-auth')) {
        return jsonResponse({
          oauth: { loggedIn: false },
          activeMethod: 'none',
          uiStatus: 'missing',
          binary: { present: true, path: wizardCursorBin },
        });
      }
      if (u.includes('/config/claude-auth')) {
        return jsonResponse({
          oauth: { loggedIn: false },
          apiKey: { configured: false },
          oauthToken: { configured: false },
          activeMethod: null,
        });
      }
      if (u.includes('/setup/configure')) return jsonResponse({ ok: true });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    // Don't actually open a popup during the test.
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    createOrg.mockResolvedValue({ id: 'org-codex' });

    render(
      <SetupWizard
        setupStatus={{
          engines: {
            'claude-code': { available: true, path: '/usr/bin/claude' },
            'codex-cli': { available: true, path: codexBin },
          },
        }}
        onComplete={() => {}}
      />,
    );

    // Welcome → Org → Configure
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText(/Create Your Organization/i)).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });
    await waitFor(() => expect(screen.getByText(/Configure Your Tools/i)).toBeInTheDocument());

    // The Codex device-login panel is in the DOM…
    const deviceLoginPanel = await screen.findByTestId('codex-device-login');
    expect(deviceLoginPanel).toHaveTextContent(/ChatGPT sign-in \(device code\)/i);

    // …and clicking the button hits POST /config/codex-auth/device-login.
    const button = screen.getByRole('button', { name: /Start ChatGPT device login/i });
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(deviceLoginCalls).toBe(1));
    // The verification URL/code render after the response resolves.
    await waitFor(() =>
      expect(screen.getByTestId('codex-device-login')).toHaveTextContent(/WZBN-RVLM/),
    );

    openSpy.mockRestore();
  });
});

describe('SetupWizard — web build hides the Connection Mode toggle', () => {
  // The web client is *served by* the Agent Hub server it talks to, so a
  // Local/Remote toggle is incoherent here: there is no other server it
  // could sensibly point at. Hiding the toggle prevents users from
  // flipping a meaningful-only-on-Electron knob, and (by extension)
  // prevents them from accidentally creating an org with mode='remote'
  // that doesn't match the page origin.

  it('does not render the Connection Mode toggle when window.electronAPI is absent', async () => {
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    expect(screen.queryByText(/Connection Mode/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^remote$/i })).not.toBeInTheDocument();
    // The Org Name field and Continue button must still be there — the
    // wizard stays usable, we're just dropping a meaningless choice.
    expect(screen.getByPlaceholderText('Personal')).toBeInTheDocument();
  });

  it('still creates a local org on Continue (default behavior)', async () => {
    createOrg.mockResolvedValue({ id: 'org-web' });

    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advanceToOrgStep();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    await waitFor(() => {
      expect(createOrg).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Personal', mode: 'local' }),
      );
    });
    expect(switchOrg).toHaveBeenCalledWith('org-web');
    expect(saveConnectionConfig).not.toHaveBeenCalled();
  });
});
