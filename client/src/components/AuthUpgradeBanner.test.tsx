import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock the auth + connection utils before importing the component so the
// component picks up our mocked getAuthStatus/setToken instead of hitting
// the real network.
(vi as any).mock('../utils/auth.js', () => ({
  getAuthStatus: vi.fn(),
  setToken: vi.fn(),
}));

(vi as any).mock('../utils/connection.js', () => ({
  getConnectionConfig: vi.fn(),
  getLocalApiBase: vi.fn(() => '/api'),
}));

import AuthUpgradeBanner from './AuthUpgradeBanner';
import { getAuthStatus, setToken } from '../utils/auth';
import { getConnectionConfig } from '../utils/connection';

beforeEach(() => {
  (getAuthStatus as any).mockReset();
  (setToken as any).mockReset();
  (getConnectionConfig as any).mockReset();
  (getConnectionConfig as any).mockReturnValue({
    mode: 'local',
    remoteUrl: '',
    apiKey: 'legacy-api-key',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthUpgradeBanner', () => {
  it('renders the upgrade banner when needsMigration is true', async () => {
    (getAuthStatus as any).mockResolvedValue({
      authRequired: false,
      role: null,
      jwtConfigured: false,
      apiKeyConfigured: true,
      needsMigration: true,
    });

    render(<AuthUpgradeBanner />);

    await waitFor(() => {
      expect(screen.getByTestId('auth-upgrade-banner')).toBeInTheDocument();
    });
    expect(screen.getByText(/You're running on an API key/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set up account/i })).toBeInTheDocument();
  });

  it('stays hidden when needsMigration is false', async () => {
    (getAuthStatus as any).mockResolvedValue({
      authRequired: true,
      role: 'Owner',
      jwtConfigured: true,
      apiKeyConfigured: true,
      needsMigration: false,
    });

    const { container } = render(<AuthUpgradeBanner />);

    // Wait a tick for the status promise to settle.
    await waitFor(() => expect(getAuthStatus!).toHaveBeenCalled());
    expect(screen.queryByTestId('auth-upgrade-banner')).toBeNull();
    expect(container!.firstChild).toBeNull();
  });

  it('stays hidden when /auth/status throws', async () => {
    (getAuthStatus as any).mockRejectedValue(new Error('network down'));

    render(<AuthUpgradeBanner />);

    await waitFor(() => expect(getAuthStatus!).toHaveBeenCalled());
    expect(screen.queryByTestId('auth-upgrade-banner')).toBeNull();
  });

  it('hides itself when the user dismisses the banner', async () => {
    (getAuthStatus as any).mockResolvedValue({ needsMigration: true });
    render(<AuthUpgradeBanner />);

    await waitFor(() => expect(screen.getByTestId('auth-upgrade-banner')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /dismiss upgrade banner/i } as any) as any);

    expect(screen.queryByTestId('auth-upgrade-banner')).toBeNull();
  });

  it('submits username/password to /auth/setup with X-API-Key header and stores the JWT', async () => {
    (getAuthStatus as any)
      .mockResolvedValueOnce({ needsMigration: true })
      .mockResolvedValueOnce({ needsMigration: false });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          token: 'jwt-abc',
          expiresAt: '2099-01-01T00:00:00.000Z',
          user: { username: 'alice', role: 'Owner' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AuthUpgradeBanner />);

    await waitFor(() => expect(screen.getByTestId('auth-upgrade-banner')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /set up account/i } as any) as any);

    fireEvent.change(screen.getByLabelText(/username/i as any), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText(/password/i as any), {
      target: { value: 'super-secret-pw-123' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create account/i } as any) as any);

    await waitFor(() => expect(fetchMock!).toHaveBeenCalledTimes(1));

    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url!).toBe('/api/auth/setup');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-API-Key']).toBe('legacy-api-key');
    expect(JSON.parse(init.body)).toEqual({
      username: 'alice',
      password: 'super-secret-pw-123',
    });

    await waitFor(() =>
      expect(setToken!).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'jwt-abc', user: { username: 'alice', role: 'Owner' } }),
      ),
    );

    // After a successful upgrade the component re-fetches status; the second
    // response reports needsMigration=false, so the banner unmounts.
    await waitFor(() => {
      expect(screen.queryByTestId('auth-upgrade-banner')).toBeNull();
    });
  });

  it('surfaces the server error message on a 4xx response', async () => {
    (getAuthStatus as any).mockResolvedValue({ needsMigration: true });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'password too short' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<AuthUpgradeBanner />);

    await waitFor(() => expect(screen.getByTestId('auth-upgrade-banner')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /set up account/i } as any) as any);
    fireEvent.change(screen.getByLabelText(/username/i as any), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText(/password/i as any), {
      target: { value: 'super-secret-pw-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create account/i } as any) as any);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/password too short/i);
    });
    // setToken must NOT run on failure.
    expect(setToken!).not.toHaveBeenCalled();
    // Banner remains visible so the user can retry.
    expect(screen.getByTestId('auth-upgrade-banner')).toBeInTheDocument();
  });

  it('omits the X-API-Key header when no API key is stored', async () => {
    (getConnectionConfig as any).mockReturnValue({ mode: 'local', remoteUrl: '', apiKey: '' });
    (getAuthStatus as any).mockResolvedValue({ needsMigration: true });

    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, token: 't', user: { username: 'alice', role: 'Owner' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<AuthUpgradeBanner />);
    await waitFor(() => expect(screen.getByTestId('auth-upgrade-banner')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /set up account/i } as any) as any);
    fireEvent.change(screen.getByLabelText(/username/i as any), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText(/password/i as any), {
      target: { value: 'super-secret-pw-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create account/i } as any) as any);

    await waitFor(() => expect(fetchMock!).toHaveBeenCalledTimes(1));
    const [, init] = (fetchMock as any).mock.calls[0];
    expect(init.headers['X-API-Key']).toBeUndefined();
    expect(init.headers['Content-Type']).toBe('application/json');
  });
});
