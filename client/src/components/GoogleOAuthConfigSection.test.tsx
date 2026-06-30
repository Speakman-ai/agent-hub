import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Plain `vi.mock(...)` so vitest's hoisting transform lifts it above the static
// import below (it matches the `vi.mock(` call shape, not a parenthesized
// `(vi as any).mock` member access).
vi.mock('../utils/connection.js', () => ({
  getAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test-jwt' })),
  getApiBase: vi.fn(() => '/api'),
}));

import GoogleOAuthConfigSection from './GoogleOAuthConfigSection';

let fetchMock: any;
beforeEach(() => {
  fetchMock = vi.fn();
  (globalThis as any).fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function respond(body: any, init: any = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

describe('GoogleOAuthConfigSection', () => {
  it('shows "Configure OAuth App" button when not configured', async () => {
    (fetchMock as any).mockResolvedValueOnce(respond({ configured: false, clientId: null }));
    render(<GoogleOAuthConfigSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Configure OAuth App/i })).toBeInTheDocument();
    });
  });

  it('shows the configured client ID and a Remove button when configured', async () => {
    (fetchMock as any).mockResolvedValueOnce(
      respond({ configured: true, clientId: 'abc.apps.googleusercontent.com' }),
    );
    render(<GoogleOAuthConfigSection />);
    await waitFor(() => {
      expect(screen.getByText('abc.apps.googleusercontent.com')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Remove/i })).toBeInTheDocument();
  });

  it('shows the server-provided canonical redirect URI (not window.location.origin)', async () => {
    // The server resolves this from publicUrl; the component must display it
    // verbatim so the admin registers the right value in Google Console.
    (fetchMock as any).mockResolvedValueOnce(
      respond({
        configured: false,
        clientId: null,
        redirectUri: 'https://hub.example.com/api/auth/google/callback',
      }),
    );
    render(<GoogleOAuthConfigSection />);
    await waitFor(() => screen.getByRole('button', { name: /Configure OAuth App/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configure OAuth App/i } as any) as any);
    const uri = screen.getByTestId('google-oauth-redirect-uri' as any);
    expect(uri.textContent).toBe('https://hub.example.com/api/auth/google/callback');
  });

  it('PUTs both clientId and clientSecret on save', async () => {
    (fetchMock as any)
      .mockResolvedValueOnce(respond({ configured: false, clientId: null })) // initial GET
      .mockResolvedValueOnce(respond({ ok: true, configured: true, clientId: 'goog.x' })) // PUT
      .mockResolvedValueOnce(respond({ configured: true, clientId: 'goog.x' })); // reload GET

    render(<GoogleOAuthConfigSection />);
    await waitFor(() => screen.getByRole('button', { name: /Configure OAuth App/i }));

    fireEvent.click(screen.getByRole('button', { name: /Configure OAuth App/i } as any) as any);

    fireEvent.change(screen.getByTestId('google-oauth-client-id' as any), {
      target: { value: 'goog.x' },
    });
    fireEvent.change(screen.getByTestId('google-oauth-client-secret' as any), {
      target: { value: 'secret-y' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i } as any) as any);

    await waitFor(() => {
      expect(fetchMock!).toHaveBeenCalledWith(
        '/api/config/google-oauth',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ clientId: 'goog.x', clientSecret: 'secret-y' }),
        }),
      );
    });
  });
});
