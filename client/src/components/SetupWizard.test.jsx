import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
  getAuthHeaders: vi.fn(() => ({})),
  getConnectionConfig: vi.fn(() => ({ apiKey: '' })),
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
// else via importActual.
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
  // setupHubAuth (= auth.js#setup) is mocked at module level. Without a
  // per-test reset, calls from the "fresh install" case bleed into the
  // "Owner already exists" case below and break the `.not.toHaveBeenCalled()`
  // assertion at the top of describe('SetupWizard — Hub account step').
  setupHubAuth.mockReset();
  setupHubAuth.mockResolvedValue({
    token: 'jwt-test',
    expiresAt: Date.now() + 3600000,
    user: {},
  });
  api.getConfig.mockReset().mockResolvedValue({ lanMode: false });
  api.updateConfig.mockReset().mockResolvedValue({ ok: true });
  delete window.electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.electronAPI;
});

/** Welcome → auto-create org → AI engines step. */
async function advancePastWelcome() {
  createOrg.mockResolvedValue({ id: 'org-test' });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  });
  await waitFor(() => expect(screen.getByText(/Choose Your AI Engines/i)).toBeInTheDocument());
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
    expect(screen.getByText(/Choose Your AI Engines/i)).toBeInTheDocument();
  });
});

// Per-account AI auth (Claude / Cursor / Codex) is configured by each user in
// Settings → Account — not in the first-run wizard. The wizard's "AI engines"
// step only selects which CLI engines to enable (host binary config via
// /setup/configure). These tests guard the engine-enable gate.
describe('SetupWizard — AI engines step gate', () => {
  it('disables Save & Continue when no engine is enabled', async () => {
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advancePastWelcome();
    expect(screen.getByText(/Turn on at least one engine/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save & continue/i })).toBeDisabled();
  });

  it('enables Save & Continue when a detected engine is enabled', async () => {
    render(
      <SetupWizard
        setupStatus={{ engines: { 'claude-code': { available: true, path: '/usr/bin/claude' } } }}
        onComplete={() => {}}
      />,
    );
    await advancePastWelcome();
    expect(screen.getByText(/Detected at \/usr\/bin\/claude/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save & continue/i })).not.toBeDisabled();
  });
});
