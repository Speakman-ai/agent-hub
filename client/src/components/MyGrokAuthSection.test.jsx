import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api.js', () => {
  const api = {
    getMyGrokAuth: vi.fn(),
    putMyGrokAuth: vi.fn(),
    getMyGrokBrowserAuth: vi.fn(),
    startMyGrokDeviceLogin: vi.fn(),
    cancelMyGrokDeviceLogin: vi.fn(),
    logoutMyGrok: vi.fn(),
  };
  return { api };
});

import { api } from '../utils/api.js';
import MyGrokAuthSection from './MyGrokAuthSection.jsx';

function defaultBrowserAuth(overrides = {}) {
  return {
    uiStatus: 'missing',
    binary: { present: true, path: '/usr/local/bin/grok' },
    oauth: { loggedIn: false, mode: null },
    loginInProgress: false,
    activeMethod: 'none',
    statusError: null,
    ...overrides,
  };
}

function defaultPasteAuth(overrides = {}) {
  return {
    engine: 'grok',
    apiKey: null,
    updatedAt: '2026-05-12T00:00:00.000Z',
    hostConfigFallback: { apiKey: false },
    ...overrides,
  };
}

let clipboardWriteText;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getMyGrokAuth.mockResolvedValue(defaultPasteAuth());
  api.getMyGrokBrowserAuth.mockResolvedValue(defaultBrowserAuth());
  if (typeof window !== 'undefined') window.open = vi.fn();
  clipboardWriteText = vi.fn().mockResolvedValue();
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWriteText },
      configurable: true,
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MyGrokAuthSection', () => {
  it('renders the "Sign in with browser" device-code button when unauthenticated', async () => {
    render(<MyGrokAuthSection />);
    await waitFor(() => expect(api.getMyGrokBrowserAuth).toHaveBeenCalled());

    expect(
      await screen.findByRole('button', { name: /sign in with browser/i }),
    ).toBeInTheDocument();
  });

  it('renders the device user-code and verification URL after start, and copies to clipboard', async () => {
    api.startMyGrokDeviceLogin.mockResolvedValue({
      ok: true,
      loginId: 'd1',
      deviceAuthUrl: 'https://auth.x.ai/device',
      userCode: 'QRST-7H2K',
    });

    render(<MyGrokAuthSection />);
    const btn = await screen.findByRole('button', { name: /sign in with browser/i });

    fireEvent.click(btn);

    await waitFor(() => expect(api.startMyGrokDeviceLogin).toHaveBeenCalledTimes(1));
    const codeEl = await screen.findByTestId('grok-device-code');
    expect(codeEl).toHaveTextContent('QRST-7H2K');
    expect(screen.getByText(/auth\.x\.ai\/device/)).toBeInTheDocument();
    // Opened with noopener/noreferrer so the CLI-sourced URL can't reach
    // window.opener back into the Agent Hub tab.
    expect(window.open).toHaveBeenCalledWith(
      'https://auth.x.ai/device',
      '_blank',
      'noopener,noreferrer',
    );

    const copyBtn = screen.getByRole('button', { name: /copy grok device code/i });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith('QRST-7H2K'));
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it('stops polling once uiStatus=authenticated', async () => {
    api.startMyGrokDeviceLogin.mockResolvedValue({
      ok: true,
      deviceAuthUrl: 'https://auth.x.ai/device',
      userCode: 'AAAA-BBBB',
    });

    // Two unauthenticated responses are consumed before polling begins:
    //   1. the mount-time fetchBrowserAuth()
    //   2. the fresh-status pre-check inside handleDeviceLogin (a no-op
    //      guard that skips device login when already authenticated)
    // Only then does the poll see `authenticated` and stop.
    api.getMyGrokBrowserAuth.mockResolvedValueOnce(defaultBrowserAuth());
    api.getMyGrokBrowserAuth.mockResolvedValueOnce(defaultBrowserAuth());
    api.getMyGrokBrowserAuth.mockResolvedValue(
      defaultBrowserAuth({
        uiStatus: 'authenticated',
        oauth: { loggedIn: true, mode: 'oauth' },
        activeMethod: 'oauth',
      }),
    );

    render(<MyGrokAuthSection />);
    const btn = await screen.findByRole('button', { name: /sign in with browser/i });
    fireEvent.click(btn);
    await waitFor(() => expect(api.startMyGrokDeviceLogin).toHaveBeenCalled());

    await waitFor(
      () => expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument(),
      { timeout: 4500 },
    );
    expect(screen.queryByTestId('grok-device-code')).not.toBeInTheDocument();
    expect(screen.getByText(/grok authenticated on this host/i)).toBeInTheDocument();
  }, 10000);

  it('falls back to a paste-key save when no browser is available', async () => {
    api.putMyGrokAuth.mockResolvedValue(
      defaultPasteAuth({ apiKey: '****rest', hostConfigFallback: { apiKey: false } }),
    );

    render(<MyGrokAuthSection />);
    const inputs = await screen.findAllByLabelText(/grok api key/i);
    const input = inputs.find((el) => el.tagName === 'INPUT');
    fireEvent.change(input, { target: { value: 'xai-test-key' } });

    const saveBtn = screen.getByRole('button', { name: /^save api key$/i });
    fireEvent.click(saveBtn);

    await waitFor(() => expect(api.putMyGrokAuth).toHaveBeenCalledWith({ apiKey: 'xai-test-key' }));
    expect(await screen.findByText('****rest')).toBeInTheDocument();
  });
});
