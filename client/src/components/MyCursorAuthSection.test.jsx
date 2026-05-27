import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api.js', () => {
  const api = {
    getMyCursorAuth: vi.fn(),
    putMyCursorAuth: vi.fn(),
    getMyCursorBrowserAuth: vi.fn(),
    startMyCursorLogin: vi.fn(),
    cancelMyCursorLogin: vi.fn(),
    logoutMyCursor: vi.fn(),
  };
  return { api };
});

import { api } from '../utils/api.js';
import MyCursorAuthSection from './MyCursorAuthSection.jsx';

function defaultBrowserAuth(overrides = {}) {
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

function defaultPasteAuth(overrides = {}) {
  return {
    engine: 'cursor',
    apiKey: null,
    updatedAt: '2026-05-12T00:00:00.000Z',
    hostConfigFallback: { apiKey: false },
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getMyCursorAuth.mockResolvedValue(defaultPasteAuth());
  api.getMyCursorBrowserAuth.mockResolvedValue(defaultBrowserAuth());
  if (typeof window !== 'undefined') window.open = vi.fn();
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue() },
      configurable: true,
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MyCursorAuthSection', () => {
  it('renders the "Sign in with browser" button when the user is unauthenticated', async () => {
    render(<MyCursorAuthSection />);
    await waitFor(() => expect(api.getMyCursorBrowserAuth).toHaveBeenCalled());

    const btn = await screen.findByRole('button', { name: /sign in with browser/i });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('renders the login URL banner once startMyCursorLogin resolves with a loginUrl', async () => {
    api.startMyCursorLogin.mockResolvedValue({
      ok: true,
      loginId: 'l1',
      loginUrl: 'https://cursor.com/login?t=abc123',
    });

    render(<MyCursorAuthSection />);
    const btn = await screen.findByRole('button', { name: /sign in with browser/i });

    fireEvent.click(btn);

    await waitFor(() => expect(api.startMyCursorLogin).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/cursor\.com\/login\?t=abc123/)).toBeInTheDocument();
    expect(screen.getByText(/polling for completion/i)).toBeInTheDocument();
    expect(window.open).toHaveBeenCalledWith('https://cursor.com/login?t=abc123', '_blank');
  });

  it('stops polling once uiStatus=authenticated', async () => {
    api.startMyCursorLogin.mockResolvedValue({
      ok: true,
      loginUrl: 'https://cursor.com/login?t=poll',
    });

    // Initial load → unauthenticated; immediately after start, every poll
    // returns authenticated. This avoids needing fake timers — the first
    // setInterval tick fires within ~3s but Vitest test timeout is 5s.
    api.getMyCursorBrowserAuth.mockResolvedValueOnce(defaultBrowserAuth());
    api.getMyCursorBrowserAuth.mockResolvedValue(
      defaultBrowserAuth({
        uiStatus: 'authenticated',
        oauth: { loggedIn: true, email: 'me@example.com' },
        activeMethod: 'oauth',
      }),
    );

    render(<MyCursorAuthSection />);
    const btn = await screen.findByRole('button', { name: /sign in with browser/i });
    fireEvent.click(btn);
    await waitFor(() => expect(api.startMyCursorLogin).toHaveBeenCalled());

    // The polling loop calls getMyCursorBrowserAuth every 3s. Wait for the
    // post-auth UI — slightly more than one interval.
    await waitFor(
      () => expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument(),
      { timeout: 4500 },
    );
    expect(screen.queryByText(/polling for completion/i)).not.toBeInTheDocument();
    expect(screen.getByText(/signed in to cursor/i)).toBeInTheDocument();
  }, 10000);

  it('saves the paste-key fallback through putMyCursorAuth', async () => {
    api.putMyCursorAuth.mockResolvedValue(
      defaultPasteAuth({ apiKey: '****tail', hostConfigFallback: { apiKey: false } }),
    );

    render(<MyCursorAuthSection />);
    // The input shares its accessible label with the show/hide-key button,
    // so target the textbox role explicitly.
    const input = await screen
      .findByRole('textbox', { name: /cursor api key/i })
      .catch(async () => {
        // password inputs aren't textbox role — fall back to aria-label
        const all = await screen.findAllByLabelText(/cursor api key/i);
        return all.find((el) => el.tagName === 'INPUT');
      });
    fireEvent.change(input, { target: { value: 'cursor-test-key' } });

    const saveBtn = screen.getByRole('button', { name: /^save api key$/i });
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(api.putMyCursorAuth).toHaveBeenCalledWith({ apiKey: 'cursor-test-key' }),
    );
    expect(await screen.findByText('****tail')).toBeInTheDocument();
  });
});
