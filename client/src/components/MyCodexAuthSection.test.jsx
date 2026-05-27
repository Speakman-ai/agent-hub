import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api.js', () => {
  const api = {
    getMyCodexAuth: vi.fn(),
    putMyCodexAuth: vi.fn(),
    getMyCodexBrowserAuth: vi.fn(),
    startMyCodexDeviceLogin: vi.fn(),
    cancelMyCodexDeviceLogin: vi.fn(),
    logoutMyCodex: vi.fn(),
  };
  return { api };
});

import { api } from '../utils/api.js';
import MyCodexAuthSection from './MyCodexAuthSection.jsx';

function defaultBrowserAuth(overrides = {}) {
  return {
    uiStatus: 'unauthenticated',
    binary: { present: true, path: '/usr/local/bin/codex' },
    oauth: { loggedIn: false, mode: null },
    loginInProgress: false,
    activeMethod: 'none',
    statusError: null,
    ...overrides,
  };
}

function defaultPasteAuth(overrides = {}) {
  return {
    engine: 'codex',
    apiKey: null,
    updatedAt: '2026-05-12T00:00:00.000Z',
    hostConfigFallback: { apiKey: false },
    ...overrides,
  };
}

let clipboardWriteText;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getMyCodexAuth.mockResolvedValue(defaultPasteAuth());
  api.getMyCodexBrowserAuth.mockResolvedValue(defaultBrowserAuth());
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

describe('MyCodexAuthSection', () => {
  it('renders the "Sign in with browser" device-code button when unauthenticated', async () => {
    render(<MyCodexAuthSection />);
    await waitFor(() => expect(api.getMyCodexBrowserAuth).toHaveBeenCalled());

    expect(
      await screen.findByRole('button', { name: /sign in with browser/i }),
    ).toBeInTheDocument();
  });

  it('renders the device user-code and verification URL after start, and copies to clipboard', async () => {
    api.startMyCodexDeviceLogin.mockResolvedValue({
      ok: true,
      loginId: 'd1',
      deviceAuthUrl: 'https://auth.openai.com/codex/device',
      userCode: 'UYG9-Q1Q9N',
    });

    render(<MyCodexAuthSection />);
    const btn = await screen.findByRole('button', { name: /sign in with browser/i });

    fireEvent.click(btn);

    await waitFor(() => expect(api.startMyCodexDeviceLogin).toHaveBeenCalledTimes(1));
    const codeEl = await screen.findByTestId('codex-device-code');
    expect(codeEl).toHaveTextContent('UYG9-Q1Q9N');
    expect(screen.getByText(/auth\.openai\.com\/codex\/device/)).toBeInTheDocument();
    expect(window.open).toHaveBeenCalledWith('https://auth.openai.com/codex/device', '_blank');

    const copyBtn = screen.getByRole('button', { name: /copy codex device code/i });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith('UYG9-Q1Q9N'));
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it('stops polling once uiStatus=authenticated', async () => {
    api.startMyCodexDeviceLogin.mockResolvedValue({
      ok: true,
      deviceAuthUrl: 'https://auth.openai.com/codex/device',
      userCode: 'AAAA-BBBB',
    });

    api.getMyCodexBrowserAuth.mockResolvedValueOnce(defaultBrowserAuth());
    api.getMyCodexBrowserAuth.mockResolvedValue(
      defaultBrowserAuth({
        uiStatus: 'authenticated',
        oauth: { loggedIn: true, mode: 'chatgpt' },
        activeMethod: 'oauth',
      }),
    );

    render(<MyCodexAuthSection />);
    const btn = await screen.findByRole('button', { name: /sign in with browser/i });
    fireEvent.click(btn);
    await waitFor(() => expect(api.startMyCodexDeviceLogin).toHaveBeenCalled());

    await waitFor(
      () => expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument(),
      { timeout: 4500 },
    );
    expect(screen.queryByTestId('codex-device-code')).not.toBeInTheDocument();
    expect(screen.getByText(/codex authenticated on this host/i)).toBeInTheDocument();
  }, 10000);

  it('falls back to a paste-key save when no browser is available', async () => {
    api.putMyCodexAuth.mockResolvedValue(
      defaultPasteAuth({ apiKey: '****rest', hostConfigFallback: { apiKey: false } }),
    );

    render(<MyCodexAuthSection />);
    const inputs = await screen.findAllByLabelText(/codex api key/i);
    const input = inputs.find((el) => el.tagName === 'INPUT');
    fireEvent.change(input, { target: { value: 'sk-codex-test' } });

    const saveBtn = screen.getByRole('button', { name: /^save api key$/i });
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(api.putMyCodexAuth).toHaveBeenCalledWith({ apiKey: 'sk-codex-test' }),
    );
    expect(await screen.findByText('****rest')).toBeInTheDocument();
  });
});
