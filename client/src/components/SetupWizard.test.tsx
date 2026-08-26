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
  login: vi.fn().mockResolvedValue({
    token: 'test-jwt',
    expiresAt: null,
    user: { email: 'owner@example.com', role: 'Owner' },
  }),
}));

import { setup as setupHubAuth, login as loginHubAuth } from '../utils/auth';

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
(vi as any).mock('./GithubConnectionSection', () => ({
  default: () => <div data-testid="github-connection-panel">github</div>,
}));

import SetupWizard, { getSetupWizardStepPlan, resolveSetupWizardPresentation } from './SetupWizard';
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
  (loginHubAuth as any).mockReset();
  (loginHubAuth as any).mockResolvedValue({
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

  it('falls back to login when Owner was already created (interrupted / double-submit)', async () => {
    (setupHubAuth as any).mockRejectedValueOnce(new Error('Auth already configured'));
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
      expect(loginHubAuth!).toHaveBeenCalledWith(
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

  it('skips org mutation when an active org already exists (avoids Welcome-step 401)', async () => {
    (getActiveOrg as any).mockReturnValue({ id: 'default', name: 'Default', mode: 'local' });
    render(<SetupWizard setupStatus={{ engines: {} }} onComplete={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i } as any) as any);
    });
    await waitFor(() => {
      expect(screen.getByText(/Choose Your AI Engines/i)).toBeInTheDocument();
    });
    expect(updateOrg!).not.toHaveBeenCalled();
    expect(createOrg!).not.toHaveBeenCalled();
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

/**
 * Final step ("Open Your First Project"). The button's `onComplete` is what
 * persists the durable `onboardingComplete` flag server-side, so it can
 * fail — 403 if the caller isn't an Owner, 500 if the write fails.
 *
 * Regression: the host used to fire-and-forget that request and tear the
 * wizard down unconditionally. A failed write then left the user in the
 * main chrome with `onboardingComplete` still false and no route back into
 * setup — the exact stranded state this PR exists to fix. The wizard must
 * keep the step mounted and offer a retry instead.
 */
describe('SetupWizard — finish step failure handling', () => {
  const projectStepStatus = { engines: {} };
  // ['welcome', 'credentials', 'github', 'project'] → project is step 4.
  const PROJECT_STEP = 4;

  it('keeps the wizard on the final step and surfaces a retry when onComplete rejects', async () => {
    const onComplete = vi.fn().mockRejectedValue(new Error('403: Owner role required.'));
    render(
      <SetupWizard
        setupStatus={projectStepStatus}
        initialStep={PROJECT_STEP}
        onComplete={onComplete}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open project/i }));
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    // The failure is visible, names the cause, and says setup is unfinished.
    const banner = await screen.findByText(/Owner role required/i);
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/not marked complete/i);
    // Still on the final step — the wizard did not tear itself down.
    expect(screen.getByText(/Open Your First Project/i)).toBeInTheDocument();
    // And the action is now an explicit retry.
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('retries the completion request when the button is clicked again', async () => {
    const onComplete = vi
      .fn()
      .mockRejectedValueOnce(new Error('500: disk full'))
      .mockResolvedValueOnce(undefined);
    render(
      <SetupWizard
        setupStatus={projectStepStatus}
        initialStep={PROJECT_STEP}
        onComplete={onComplete}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open project/i }));
    });
    await screen.findByText(/disk full/i);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    });

    expect(onComplete).toHaveBeenCalledTimes(2);
    // Second attempt succeeded → the error clears (the host closes the
    // wizard from here, which this unit test doesn't model).
    await waitFor(() => expect(screen.queryByText(/disk full/i)).not.toBeInTheDocument());
  });

  it('shows no error when onComplete succeeds', async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(
      <SetupWizard
        setupStatus={projectStepStatus}
        initialStep={PROJECT_STEP}
        onComplete={onComplete}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open project/i }));
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/not marked complete/i)).not.toBeInTheDocument();
  });
});

describe('getSetupWizardStepPlan', () => {
  it('includes First Project by default', () => {
    expect(getSetupWizardStepPlan({ engines: {} }).stepKeys).toEqual([
      'welcome',
      'credentials',
      'github',
      'project',
    ]);
  });

  it('omits First Project when includeFirstProject is false', () => {
    expect(
      getSetupWizardStepPlan({ engines: {} }, { includeFirstProject: false }).stepKeys,
    ).toEqual(['welcome', 'credentials', 'github']);
    expect(
      getSetupWizardStepPlan({ engines: {} }, { includeFirstProject: false }).stepLabels,
    ).not.toContain('First Project');
  });
});

describe('resolveSetupWizardPresentation', () => {
  const ownerOpts = { canCompleteOnboarding: true, hasOrgs: true };
  const memberOpts = { canCompleteOnboarding: false, hasOrgs: true };

  it('sends Owners through instance onboarding when the flag is still false', () => {
    expect(
      resolveSetupWizardPresentation(
        { authConfigured: true, onboardingComplete: false, hasAnyAiCredentials: true },
        ownerOpts,
      ),
    ).toEqual({ show: true, initialStepKey: 'welcome', includeFirstProject: true });
  });

  it('does not trap invited members in instance onboarding', () => {
    expect(
      resolveSetupWizardPresentation(
        { authConfigured: true, onboardingComplete: false, hasAnyAiCredentials: true },
        memberOpts,
      ),
    ).toEqual({ show: false, initialStepKey: null, includeFirstProject: false });
  });

  it('shows a credentials walkthrough without First Project for members with no AI engines', () => {
    expect(
      resolveSetupWizardPresentation(
        { authConfigured: true, onboardingComplete: true, hasAnyAiCredentials: false },
        memberOpts,
      ),
    ).toEqual({ show: true, initialStepKey: 'credentials', includeFirstProject: false });
  });

  it('still shows credentials walkthrough when instance onboarding is pending but the caller cannot complete it', () => {
    expect(
      resolveSetupWizardPresentation(
        { authConfigured: true, onboardingComplete: false, hasAnyAiCredentials: false },
        memberOpts,
      ),
    ).toEqual({ show: true, initialStepKey: 'credentials', includeFirstProject: false });
  });

  // Regression: the Owner-only ending must key off the server-authoritative
  // canCompleteOnboarding (current org role), not the role cached at login.
  it('does not send a demoted Owner through the Owner-only ending when the server says they cannot complete it', () => {
    // Cached role is still Owner (ownerOpts) after a demotion, but the fresh
    // /api/setup/status resolved the current membership to non-Owner.
    expect(
      resolveSetupWizardPresentation(
        {
          authConfigured: true,
          onboardingComplete: false,
          hasAnyAiCredentials: true,
          canCompleteOnboarding: false,
        },
        ownerOpts,
      ),
    ).toEqual({ show: false, initialStepKey: null, includeFirstProject: false });
  });

  it('sends a freshly promoted Owner through instance onboarding even when the cached role is stale', () => {
    // Cached role is still a non-Owner member (memberOpts) after a promotion,
    // but the server now reports the caller may complete onboarding.
    expect(
      resolveSetupWizardPresentation(
        {
          authConfigured: true,
          onboardingComplete: false,
          hasAnyAiCredentials: true,
          canCompleteOnboarding: true,
        },
        memberOpts,
      ),
    ).toEqual({ show: true, initialStepKey: 'welcome', includeFirstProject: true });
  });

  it('falls back to the client hint when a legacy server omits canCompleteOnboarding', () => {
    expect(
      resolveSetupWizardPresentation(
        { authConfigured: true, onboardingComplete: false, hasAnyAiCredentials: true },
        ownerOpts,
      ),
    ).toEqual({ show: true, initialStepKey: 'welcome', includeFirstProject: true });
    expect(
      resolveSetupWizardPresentation(
        { authConfigured: true, onboardingComplete: false, hasAnyAiCredentials: true },
        memberOpts,
      ),
    ).toEqual({ show: false, initialStepKey: null, includeFirstProject: false });
  });
});

describe('SetupWizard — no First Project ending', () => {
  it('finishes from GitHub via Get started instead of calling Open Project', async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(
      <SetupWizard
        setupStatus={{ engines: {} }}
        includeFirstProject={false}
        initialStep={3}
        onComplete={onComplete}
      />,
    );

    expect(screen.queryByText(/First Project/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open Your First Project/i)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /get started/i }));
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Owner role required/i)).not.toBeInTheDocument();
  });
});
