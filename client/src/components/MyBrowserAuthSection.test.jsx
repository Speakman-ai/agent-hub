import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import MyBrowserAuthSection from './MyBrowserAuthSection.jsx';

function buildStatus(overrides = {}) {
  return {
    uiStatus: 'unauthenticated',
    binary: { present: true, path: '/usr/local/bin/cursor-agent' },
    oauth: { loggedIn: false, email: null },
    loginInProgress: false,
    activeMethod: 'none',
    statusError: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('open', vi.fn());
  // Some test envs only expose window.open
  if (typeof window !== 'undefined') {
    window.open = vi.fn();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MyBrowserAuthSection — OAuth (cursor) mode', () => {
  it('renders "Sign in with browser" button when unauthenticated', async () => {
    const getStatus = vi.fn().mockResolvedValue(buildStatus());

    render(
      <MyBrowserAuthSection
        engine="cursor"
        engineLabel="Cursor"
        hostSettingHint="Settings → Cursor Auth"
        loginMode="oauth"
        getStatus={getStatus}
        startLogin={vi.fn()}
        cancelLogin={vi.fn()}
        logout={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole('button', { name: /sign in with browser/i }),
    ).toBeInTheDocument();
    expect(getStatus).toHaveBeenCalled();
  });

  it('opens login URL and shows polling banner after start', async () => {
    const getStatus = vi.fn().mockResolvedValue(buildStatus());
    const startLogin = vi
      .fn()
      .mockResolvedValue({ ok: true, loginId: 'l1', loginUrl: 'https://cursor.com/login?t=abc' });

    render(
      <MyBrowserAuthSection
        engine="cursor"
        engineLabel="Cursor"
        hostSettingHint=""
        loginMode="oauth"
        getStatus={getStatus}
        startLogin={startLogin}
        cancelLogin={vi.fn()}
        logout={vi.fn()}
      />,
    );

    const btn = await screen.findByRole('button', { name: /sign in with browser/i });
    fireEvent.click(btn);

    await waitFor(() => expect(startLogin).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/polling for completion/i)).toBeInTheDocument());
    expect(window.open).toHaveBeenCalledWith('https://cursor.com/login?t=abc', '_blank');
  });

  it('renders "Signed in" badge + sign-out button when oauth.loggedIn=true', async () => {
    const getStatus = vi.fn().mockResolvedValue(
      buildStatus({
        oauth: { loggedIn: true, email: 'me@example.com' },
        uiStatus: 'authenticated',
        activeMethod: 'oauth',
      }),
    );

    render(
      <MyBrowserAuthSection
        engine="cursor"
        engineLabel="Cursor"
        hostSettingHint=""
        loginMode="oauth"
        getStatus={getStatus}
        startLogin={vi.fn()}
        cancelLogin={vi.fn()}
        logout={vi.fn()}
      />,
    );

    expect(await screen.findByText(/signed in/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('disables sign-in when the CLI binary is missing', async () => {
    const getStatus = vi.fn().mockResolvedValue(
      buildStatus({
        binary: { present: false, path: '/usr/local/bin/cursor-agent' },
        statusError: 'Cursor Agent binary not found',
      }),
    );

    render(
      <MyBrowserAuthSection
        engine="cursor"
        engineLabel="Cursor"
        hostSettingHint=""
        loginMode="oauth"
        getStatus={getStatus}
        startLogin={vi.fn()}
        cancelLogin={vi.fn()}
        logout={vi.fn()}
      />,
    );

    const btn = await screen.findByRole('button', { name: /sign in with browser/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/CLI binary not found/i)).toBeInTheDocument();
  });
});

describe('MyBrowserAuthSection — device (codex) mode', () => {
  it('displays user code and device URL after device-login start', async () => {
    const getStatus = vi.fn().mockResolvedValue(buildStatus());
    const startLogin = vi.fn().mockResolvedValue({
      ok: true,
      loginId: 'd1',
      deviceAuthUrl: 'https://auth.openai.com/codex/device',
      userCode: 'UYG9-Q1Q9N',
    });

    render(
      <MyBrowserAuthSection
        engine="codex"
        engineLabel="Codex"
        hostSettingHint=""
        loginMode="device"
        getStatus={getStatus}
        startLogin={startLogin}
        cancelLogin={vi.fn()}
        logout={vi.fn()}
      />,
    );

    const btn = await screen.findByRole('button', { name: /sign in with browser/i });
    fireEvent.click(btn);

    await waitFor(() => expect(startLogin).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('UYG9-Q1Q9N')).toBeInTheDocument());
    expect(screen.getByText(/auth\.openai\.com\/codex\/device/)).toBeInTheDocument();
  });
});
