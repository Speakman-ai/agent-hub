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

vi.mock('../utils/auth.js', () => ({
  setup: vi.fn().mockResolvedValue({
    token: 'test-jwt',
    expiresAt: null,
    user: { username: 'owner', role: 'Owner' },
  }),
}));

import { setup as setupHubAuth } from '../utils/auth.js';

// Stub only the methods the LAN-mode tests inspect; preserve everything
// else (api.startCodexDeviceLogin, api.getCodexAuth, etc.) via
// importActual so the Step 3 Codex device-login flow still uses its real
// fetch-stubbed paths.
vi.mock('../utils/api.js', async () => {
  const actual = await vi.importActual('../utils/api.js');
  return {
    ...actual,
    api: {
      ...actual.api,
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
    },
  };
});

import SetupWizard from './SetupWizard.jsx';
import { api } from '../utils/api.js';
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
  api.getConfig.mockReset().mockResolvedValue({ lanMode: false });
  api.updateConfig.mockReset().mockResolvedValue({ ok: true });
  delete window.electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.electronAPI;
});

/** Welcome → auto-create org → AI credentials step. */
async function advancePastWelcome() {
  createOrg.mockResolvedValue({ id: 'org-test' });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  });
  await waitFor(() => expect(screen.getByText(/Configure Your Tools/i)).toBeInTheDocument());
}

describe('SetupWizard — Hub account step', () => {
  beforeEach(() => {
    setupHubAuth.mockClear();
  });

  it('shows Hub account as step 1 when auth is not configured', () => {
    render(
      <SetupWizard setupStatus={{ authConfigured: false, engines: {} }} onComplete={() => {}} />,
    );
    expect(screen.getByText(/Create your Hub account/i)).toBeInTheDocument();
    expect(screen.queryByText(/Welcome to Agent Hub/i)).not.toBeInTheDocument();
  });

  it('creates the owner account then advances to Welcome', async () => {
    createOrg.mockResolvedValue({ id: 'org-new' });
    render(
      <SetupWizard setupStatus={{ authConfigured: false, engines: {} }} onComplete={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('hub-account-username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByTestId('hub-account-password'), {
      target: { value: 'longpassword12' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    });
    await waitFor(() => {
      expect(setupHubAuth).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'admin', password: 'longpassword12' }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText(/Welcome to Agent Hub/i)).toBeInTheDocument();
    });
  });
});

describe('SetupWizard — welcome auto-creates org', () => {
  it('creates a default local org when continuing from welcome', async () => {
    createOrg.mockResolvedValue({ id: 'org-new' });
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });
    await waitFor(() => {
      expect(createOrg).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Personal', mode: 'local' }),
      );
    });
    expect(switchOrg).toHaveBeenCalledWith('org-new');
    expect(screen.getByText(/Configure Your Tools/i)).toBeInTheDocument();
  });
});

describe('SetupWizard — Step 2 Claude credential gate', () => {
  // Helper: set up a fetch mock that routes by URL substring.
  // Routes return JSON Response objects so the component's
  // `await res.json()` works the same as in production.
  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async function advanceToCredentialsStep() {
    await advancePastWelcome();
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
    await advanceToCredentialsStep();

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
    await advanceToCredentialsStep();
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
    await advanceToCredentialsStep();
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
    await advanceToCredentialsStep();

    await waitFor(() =>
      expect(screen.getByTestId('claude-credentials')).toHaveTextContent(/API key configured/i),
    );
    // No tab UI shown when already configured.
    expect(screen.queryByPlaceholderText(/sk-ant-api03/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save & continue/i })).not.toBeDisabled();
  });
});

describe('SetupWizard — Step 2 Cursor path auth probe', () => {
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
    await advancePastWelcome();
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

    await advancePastWelcome();

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

// Step 3 = "Connect GitHub". The LAN-mode toggle lives at the top of
// this step (mirrored on Settings → GitHub for post-setup changes). The
// toggle is purely a passthrough to PATCH /api/config { lanMode } — the
// LAN-mode behavior itself is verified server-side in
// server/autonomous-lan-mode-reviewer-poll.test.ts and
// server/test/webhook-skip-autoregister-lan-mode.test.ts. These tests
// guard the wiring: GET on entry, PATCH on toggle, rollback on error.
describe('SetupWizard — Step 3 LAN mode toggle', () => {
  it('loads the current lanMode value from /api/config on Step 3 entry', async () => {
    api.getConfig.mockResolvedValue({ lanMode: true });

    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} initialStep={3} />);

    await waitFor(() => expect(api.getConfig).toHaveBeenCalled());
    // "LAN mode is on" banner only renders when the load succeeds AND
    // returns lanMode: true — guards the round-trip end-to-end.
    expect(await screen.findByText(/LAN mode is on/i)).toBeInTheDocument();
  });

  it('PATCHes /api/config { lanMode: true } when the user toggles on', async () => {
    api.getConfig.mockResolvedValue({ lanMode: false });

    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} initialStep={3} />);

    await waitFor(() => expect(api.getConfig).toHaveBeenCalled());
    expect(screen.queryByText(/LAN mode is on/i)).not.toBeInTheDocument();

    // The toggle wrapper carries the testid; click the inner button.
    const wrapper = screen.getByTestId('lan-mode-toggle-wrapper');
    const toggle = wrapper.querySelector('button');
    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ lanMode: true });
    });
    expect(await screen.findByText(/LAN mode is on/i)).toBeInTheDocument();
  });

  it('rolls back the toggle when PATCH /api/config fails', async () => {
    api.getConfig.mockResolvedValue({ lanMode: false });
    api.updateConfig.mockRejectedValueOnce(new Error('boom'));

    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} initialStep={3} />);

    await waitFor(() => expect(api.getConfig).toHaveBeenCalled());

    const wrapper = screen.getByTestId('lan-mode-toggle-wrapper');
    const toggle = wrapper.querySelector('button');
    await act(async () => {
      fireEvent.click(toggle);
    });

    // PATCH attempted exactly once; banner must NOT appear (state rolled back).
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/LAN mode is on/i)).not.toBeInTheDocument();
  });
});
