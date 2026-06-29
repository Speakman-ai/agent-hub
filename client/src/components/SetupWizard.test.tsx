import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

(vi as any).mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
  getAuthHeaders: vi.fn(() => ({})),
  getConnectionConfig: vi.fn(() => ({ apiKey: '' })),
  saveConnectionConfig: vi.fn(),
  testConnection: vi.fn(),
}));

(vi as any).mock('../utils/orgs.js', () => ({
  createOrg: vi.fn(),
  switchOrg: vi.fn(),
  getActiveOrg: vi.fn(),
  updateOrg: vi.fn(),
}));

(vi as any).mock('../utils/auth.js', () => ({
  setup: vi.fn().mockResolvedValue({
    token: 'test-jwt',
    expiresAt: null,
    user: { email: 'owner@example.com', role: 'Owner' },
  }),
}));

import { setup as setupHubAuth } from '../utils/auth';

// Stub only the methods the LAN-mode tests inspect; preserve everything
// else via importActual.
(vi as any).mock('../utils/api.js', async () => {
  const actual = await vi.importActual('../utils/api.js');
  return {
    ...(actual as any),
    api: {
      ...(actual as any).api,
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
    },
  };
});

// Stub the heavy per-user auth panels embedded in the AI engines step. We only
// care that the right panel shows/hides with its engine toggle here; the panels
// have their own dedicated tests. Each stub renders a marker we can query.
(vi as any).mock('./MyClaudeAuthSection', () => ({
  default: () => <div data-testid="claude-auth-panel">claude login</div>,
}));
(vi as any).mock('./MyCursorAuthSection', () => ({
  default: () => <div data-testid="cursor-auth-panel">cursor login</div>,
}));
(vi as any).mock('./MyCodexAuthSection', () => ({
  default: () => <div data-testid="codex-auth-panel">codex login</div>,
}));
(vi as any).mock('./MyGrokAuthSection', () => ({
  default: () => <div data-testid="grok-auth-panel">grok login</div>,
}));

import SetupWizard from './SetupWizard';
import { api } from '../utils/api';
import { saveConnectionConfig, testConnection } from '../utils/connection';
import { createOrg, switchOrg, updateOrg, getActiveOrg } from '../utils/orgs';

beforeEach(() => {
  (saveConnectionConfig as any).mockReset();
  (testConnection as any).mockReset();
  (createOrg as any).mockReset();
  (switchOrg as any).mockReset();
  (updateOrg as any).mockReset();
  (getActiveOrg as any).mockReset();
  (getActiveOrg as any).mockReturnValue(null);
  // setupHubAuth (= auth.js#setup) is mocked at module level. Without a
  // per-test reset, calls from the "fresh install" case bleed into the
  // "Owner already exists" case below and break the `.not.toHaveBeenCalled()`
  // assertion at the top of describe('SetupWizard — Hub account step').
  (setupHubAuth as any).mockReset();
  (setupHubAuth as any).mockResolvedValue({
    token: 'jwt-test',
    expiresAt: Date.now() + 3600000,
    user: {},
  });
  (api.getConfig as any).mockReset().mockResolvedValue({ lanMode: false });
  (api.updateConfig as any).mockReset().mockResolvedValue({ ok: true } as any);
  delete (window as any).electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).electronAPI;
});

/** Welcome → auto-create org → AI engines step. */
async function advancePastWelcome() {
  (createOrg as any).mockResolvedValue({ id: 'org-test' });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /continue/i } as any) as any);
  });
  await waitFor(() => expect(screen.getByText(/Choose Your AI Engines/i)).toBeInTheDocument());
}

describe('SetupWizard — Hub account step', () => {
  beforeEach(() => {
    (setupHubAuth as any).mockClear();
  });

  it('shows Hub account as step 1 when auth is not configured', () => {
    render(
      <SetupWizard setupStatus={{ authConfigured: false, engines: {} }} onComplete={() => {}} />,
    );
    expect(screen.getByText(/Create your Hub account/i)).toBeInTheDocument();
    expect(screen.queryByText(/Welcome to Agent Hub/i)).not.toBeInTheDocument();
  });

  it('creates the owner account then advances to Welcome', async () => {
    (createOrg as any).mockResolvedValue({ id: 'org-new' });
    render(
      <SetupWizard setupStatus={{ authConfigured: false, engines: {} }} onComplete={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('hub-account-username' as any), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByTestId('hub-account-password' as any), {
      target: { value: 'longpassword12' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i } as any) as any);
    });
    await waitFor(() => {
      expect(setupHubAuth!).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'admin@example.com', password: 'longpassword12' }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText(/Welcome to Agent Hub/i)).toBeInTheDocument();
    });
  });
});

describe('SetupWizard — welcome copy positioning', () => {
  it('positions Hub-hosted git as primary and GitHub as an optional mirror', () => {
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    const welcome = screen.getByText(/self-hosted home for teams of AI agents/i);
    expect(welcome).toBeInTheDocument();
    // Hub git is primary; GitHub is an optional mirror, not a requirement.
    expect(welcome.textContent).toMatch(/mirror any Hub repo to GitHub/i);
    expect(welcome.textContent).toMatch(/optional, not required/i);
  });

  it('lists the four CLI engines (Grok included, Gemini excluded)', () => {
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    const welcome = screen.getByText(/self-hosted home for teams of AI agents/i);
    expect(welcome.textContent).toMatch(/Claude, Cursor, Codex, or Grok/i);
    // Gemini is RAG/embeddings only — it must NOT appear as a selectable engine.
    expect(welcome.textContent).not.toMatch(/Gemini/i);
  });

  it('labels the GitHub step as optional in the step indicator', () => {
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    expect(screen.getByText(/GitHub \(optional\)/i)).toBeInTheDocument();
  });
});

describe('SetupWizard — Grok engine card', () => {
  it('renders a Grok CLI engine card on the AI engines step', async () => {
    render(
      <SetupWizard
        setupStatus={{ engines: { 'grok-cli': { available: true, path: '/usr/bin/grok' } } }}
        onComplete={() => {}}
      />,
    );
    await advancePastWelcome();
    expect(screen.getByText('Grok CLI')).toBeInTheDocument();
    expect(screen.getByText(/Detected at \/usr\/bin\/grok/i)).toBeInTheDocument();
    // A detected Grok engine alone satisfies the "enable one engine" gate.
    expect(screen.getByRole('button', { name: /save & continue/i })).not.toBeDisabled();
    // Detected engines need no manual path field.
    expect(screen.queryByLabelText(/grok cli binary path/i)).not.toBeInTheDocument();
  });

  it('lets the user enter a Grok binary path when grok-cli is not auto-detected', async () => {
    // No engines detected at all — the wizard must still let the user enable
    // Grok and type its binary path, otherwise Save & Continue is a dead end.
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advancePastWelcome();

    // Enabling Grok with no detected binary leaves Save blocked (pathsOk false).
    fireEvent.click(screen.getByRole('switch', { name: /enable grok cli/i }));
    expect(screen.getByRole('button', { name: /save & continue/i })).toBeDisabled();

    // The manual path input appears; entering a path unblocks Save.
    const input = screen.getByLabelText(/grok cli binary path/i);
    fireEvent.change(input, { target: { value: '/opt/grok' } });
    expect((input as HTMLInputElement).value).toBe('/opt/grok');
    expect(screen.getByRole('button', { name: /save & continue/i })).not.toBeDisabled();
  });
});

describe('SetupWizard — welcome auto-creates org', () => {
  it('creates a default local org when continuing from welcome', async () => {
    (createOrg as any).mockResolvedValue({ id: 'org-new' });
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i } as any) as any);
    });
    await waitFor(() => {
      expect(createOrg!).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Personal', mode: 'local' }),
      );
    });
    expect(switchOrg!).toHaveBeenCalledWith('org-new');
    expect(screen.getByText(/Choose Your AI Engines/i)).toBeInTheDocument();
  });
});

// The wizard's "AI engines" step selects which CLI engines to enable (host
// binary config via /setup/configure) AND lets each user sign in to their own
// per-account credentials inline. These tests guard the engine-enable gate and
// the inline-login show/hide behavior.
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

describe('SetupWizard — AI engines step inline login', () => {
  it('shows only the enabled engine login panel', async () => {
    render(
      <SetupWizard
        setupStatus={{ engines: { 'claude-code': { available: true, path: '/usr/bin/claude' } } }}
        onComplete={() => {}}
      />,
    );
    await advancePastWelcome();
    // Claude is enabled (available) → its login panel renders inline.
    expect(screen.getByTestId('claude-auth-panel')).toBeInTheDocument();
    // Cursor and Codex are off → their panels stay hidden.
    expect(screen.queryByTestId('cursor-auth-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('codex-auth-panel')).not.toBeInTheDocument();
  });

  it('renders no login panels when every engine is disabled', async () => {
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advancePastWelcome();
    expect(screen.queryByTestId('claude-auth-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cursor-auth-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('codex-auth-panel')).not.toBeInTheDocument();
  });

  it('toggling an engine on then off shows then hides its login panel', async () => {
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await advancePastWelcome();

    const cursorToggle = screen.getByRole('switch', { name: /enable cursor agent/i });
    await act(async () => {
      fireEvent.click(cursorToggle);
    });
    expect(screen.getByTestId('cursor-auth-panel')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(cursorToggle);
    });
    expect(screen.queryByTestId('cursor-auth-panel')).not.toBeInTheDocument();
  });
});
