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

  it('shows a warning when the server has no OAuth credentials configured', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ connected: false, login: null, serverConfigured: false }),
    );

    render(<GithubConnectionSection />);

    await waitFor(() => {
      expect(
        screen.getByText(/GitHub OAuth is not configured on this server/i),
      ).toBeInTheDocument();
    });
    // Button should be disabled since server can't complete the flow.
    const btn = screen.getByRole('button', { name: /Sign in with GitHub/i });
    expect(btn).toBeDisabled();
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
});
