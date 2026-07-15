import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/connection.js', () => ({
  getAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test-jwt' })),
  getApiBase: vi.fn(() => '/api'),
}));

import GithubAppConfigSection from './GithubAppConfigSection';

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

const UNCONFIGURED = {
  configured: false,
  appId: null,
  installationId: null,
  installations: [],
  hasPrivateKey: false,
};

describe('GithubAppConfigSection', () => {
  it('shows "Configure GitHub App" when not configured', async () => {
    fetchMock.mockResolvedValueOnce(respond(UNCONFIGURED));
    render(<GithubAppConfigSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Configure GitHub App/i })).toBeInTheDocument();
    });
  });

  it('shows the configured App ID with Edit/Remove and never renders the private key', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({
        configured: true,
        appId: 123456,
        installationId: 987,
        installations: [{ account: 'acme', id: 987 }],
        hasPrivateKey: true,
      }),
    );
    render(<GithubAppConfigSection />);
    await waitFor(() => expect(screen.getByText('123456')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Remove/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
    // The status never carries the key, so it can't leak into the DOM.
    expect(document.body.textContent).not.toMatch(/BEGIN RSA PRIVATE KEY/);
  });

  it('PUTs appId + privateKey + installations on first-time save', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(UNCONFIGURED)) // initial GET
      .mockResolvedValueOnce(
        respond({ ok: true, configured: true, appId: '55', hasPrivateKey: true }),
      ) // PUT
      .mockResolvedValueOnce(respond({ ...UNCONFIGURED, configured: true, appId: '55' })); // reload GET

    render(<GithubAppConfigSection />);
    await waitFor(() => screen.getByRole('button', { name: /Configure GitHub App/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configure GitHub App/i }));

    fireEvent.change(screen.getByTestId('github-app-app-id'), { target: { value: '55' } });
    fireEvent.change(screen.getByTestId('github-app-private-key'), {
      target: { value: 'PEMDATA' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/config/github-app',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ appId: '55', privateKey: 'PEMDATA', installations: [] }),
        }),
      );
    });
  });

  it('blocks first-time save with no private key and does not PUT', async () => {
    fetchMock.mockResolvedValueOnce(respond(UNCONFIGURED));
    render(<GithubAppConfigSection />);
    await waitFor(() => screen.getByRole('button', { name: /Configure GitHub App/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configure GitHub App/i }));

    fireEvent.change(screen.getByTestId('github-app-app-id'), { target: { value: '55' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(screen.getByText(/private key is required/i)).toBeInTheDocument());
    // Only the initial GET happened — no PUT.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows editing without re-pasting the key when one is already stored', async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond({
          configured: true,
          appId: '1',
          hasPrivateKey: true,
          installationId: null,
          installations: [],
        }),
      ) // GET
      .mockResolvedValueOnce(
        respond({ ok: true, configured: true, appId: '2', hasPrivateKey: true }),
      ) // PUT
      .mockResolvedValueOnce(
        respond({
          configured: true,
          appId: '2',
          hasPrivateKey: true,
          installationId: null,
          installations: [],
        }),
      ); // reload

    render(<GithubAppConfigSection />);
    await waitFor(() => screen.getByRole('button', { name: /Edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));

    fireEvent.change(screen.getByTestId('github-app-app-id'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/config/github-app',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ appId: '2', installations: [] }),
        }),
      );
    });
  });

  it.each(['abc', '0', '00'])(
    'blocks an invalid App ID (%s) client-side and does not PUT',
    async (badId) => {
      fetchMock.mockResolvedValueOnce(respond(UNCONFIGURED)); // initial GET only
      render(<GithubAppConfigSection />);
      await waitFor(() => screen.getByRole('button', { name: /Configure GitHub App/i }));
      fireEvent.click(screen.getByRole('button', { name: /Configure GitHub App/i }));

      fireEvent.change(screen.getByTestId('github-app-app-id'), { target: { value: badId } });
      fireEvent.change(screen.getByTestId('github-app-private-key'), {
        target: { value: 'PEMDATA' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

      await waitFor(() =>
        expect(screen.getByText(/App ID must be a positive number/i)).toBeInTheDocument(),
      );
      // Only the initial GET happened — the invalid appId never reached the server.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('blocks a non-numeric installation ID client-side and does not PUT', async () => {
    fetchMock.mockResolvedValueOnce(respond(UNCONFIGURED)); // initial GET only
    render(<GithubAppConfigSection />);
    await waitFor(() => screen.getByRole('button', { name: /Configure GitHub App/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configure GitHub App/i }));

    fireEvent.change(screen.getByTestId('github-app-app-id'), { target: { value: '55' } });
    fireEvent.change(screen.getByTestId('github-app-private-key'), {
      target: { value: 'PEMDATA' },
    });
    fireEvent.change(screen.getByTestId('github-app-installation-id'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() =>
      expect(screen.getByText(/Installation ID must be a positive number/i)).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the server bad-key validation error and keeps the form open', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(UNCONFIGURED)) // initial GET
      .mockResolvedValueOnce(
        respond({ error: 'privateKey is not a valid PEM private key' }, { ok: false, status: 400 }),
      ); // PUT rejected by server-side PEM parse

    render(<GithubAppConfigSection />);
    await waitFor(() => screen.getByRole('button', { name: /Configure GitHub App/i }));
    fireEvent.click(screen.getByRole('button', { name: /Configure GitHub App/i }));

    fireEvent.change(screen.getByTestId('github-app-app-id'), { target: { value: '55' } });
    fireEvent.change(screen.getByTestId('github-app-private-key'), {
      target: { value: 'not-a-real-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    // The server's message renders verbatim, not a generic failure…
    await waitFor(() =>
      expect(screen.getByText(/not a valid PEM private key/i)).toBeInTheDocument(),
    );
    // …and the form stays open so the admin can correct the key.
    expect(screen.getByTestId('github-app-private-key')).toBeInTheDocument();
  });
});
