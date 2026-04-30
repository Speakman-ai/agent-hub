import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/connection.js', () => ({
  getAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test-jwt' })),
  getApiBase: vi.fn(() => '/api'),
}));

import GithubConnectionSection from './GithubConnectionSection.jsx';

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function respond(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

describe('GithubConnectionSection', () => {
  it('renders the connect button when the user is not linked', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ connected: false, login: null, serverConfigured: true }),
    );

    render(<GithubConnectionSection />);

    await waitFor(() => {
      expect(screen.getByText(/Sign in with GitHub/i)).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/github/status',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('renders the connected state with the GitHub login', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({
        connected: true,
        login: 'speakmanra',
        connectedAt: '2026-04-20T00:00:00.000Z',
        serverConfigured: true,
      }),
    );

    render(<GithubConnectionSection />);

    await waitFor(() => {
      expect(screen.getByText('@speakmanra')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
  });

  it('falls back to a personal access token when the server has no OAuth credentials', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ connected: false, login: null, serverConfigured: false }),
    );

    render(<GithubConnectionSection />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Paste a personal access token/i }),
      ).toBeInTheDocument();
    });
    // OAuth button is hidden (server can't complete that flow); the PAT button takes its place.
    expect(screen.queryByRole('button', { name: /Sign in with GitHub/i })).toBeNull();
  });

  it('disconnects and refetches status on click', async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond({
          connected: true,
          login: 'speakmanra',
          connectedAt: '2026-04-20T00:00:00.000Z',
          serverConfigured: true,
        }),
      )
      .mockResolvedValueOnce(respond({ ok: true })) // DELETE response
      .mockResolvedValueOnce(respond({ connected: false, login: null, serverConfigured: true }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<GithubConnectionSection />);

    await waitFor(() => screen.getByText('@speakmanra'));
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));

    await waitFor(() => {
      expect(screen.getByText(/Sign in with GitHub/i)).toBeInTheDocument();
    });
    expect(confirmSpy).toHaveBeenCalled();
    // status + delete + status = 3 calls
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('saves a personal access token via POST /auth/github/connect-token', async () => {
    fetchMock
      // initial status
      .mockResolvedValueOnce(respond({ connected: false, login: null, serverConfigured: false }))
      // POST connect-token
      .mockResolvedValueOnce(respond({ ok: true, login: 'speakmanra' }))
      // refetch status after save
      .mockResolvedValueOnce(
        respond({
          connected: true,
          login: 'speakmanra',
          connectedAt: '2026-04-30T00:00:00.000Z',
          serverConfigured: false,
        }),
      );

    render(<GithubConnectionSection />);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Paste a personal access token/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Paste a personal access token/i }));

    const input = await screen.findByTestId('github-pat-input');
    fireEvent.change(input, { target: { value: 'ghp_abc123' } });
    fireEvent.click(screen.getByRole('button', { name: /save token/i }));

    await waitFor(() => expect(screen.getByText('@speakmanra')).toBeInTheDocument());

    // The POST call carries the token in the JSON body.
    const postCall = fetchMock.mock.calls.find((c) => c[0] === '/api/auth/github/connect-token');
    expect(postCall).toBeDefined();
    expect(postCall[1].method).toBe('POST');
    expect(JSON.parse(postCall[1].body)).toEqual({ token: 'ghp_abc123' });
  });

  it('surfaces a server-side rejection of an invalid token', async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ connected: false, login: null, serverConfigured: false }))
      .mockResolvedValueOnce(
        respond({ error: 'Invalid GitHub token (GitHub rejected it)' }, { ok: false, status: 400 }),
      );

    render(<GithubConnectionSection />);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Paste a personal access token/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Paste a personal access token/i }));

    const input = await screen.findByTestId('github-pat-input');
    fireEvent.change(input, { target: { value: 'ghp_bogus' } });
    fireEvent.click(screen.getByRole('button', { name: /save token/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid github token/i)).toBeInTheDocument();
    });
    // Still on the input step — token didn't clear, no transition to "connected".
    expect(screen.queryByText(/connected as/i)).toBeNull();
  });
});
