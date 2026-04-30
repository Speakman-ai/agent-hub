import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/connection.js', () => ({
  getAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test-jwt' })),
  getApiBase: vi.fn(() => '/api'),
}));

import PersonalOAuthConfigSection from './PersonalOAuthConfigSection.jsx';

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

describe('PersonalOAuthConfigSection', () => {
  it('shows "Configure OAuth App" button when not configured', async () => {
    fetchMock.mockResolvedValueOnce(respond({ configured: false, clientId: null }));
    render(<PersonalOAuthConfigSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Configure OAuth App/i })).toBeInTheDocument();
    });
  });

  it('shows the configured client ID and a Remove button when configured', async () => {
    fetchMock.mockResolvedValueOnce(respond({ configured: true, clientId: 'Iv1.abcdef' }));
    render(<PersonalOAuthConfigSection />);
    await waitFor(() => {
      expect(screen.getByText('Iv1.abcdef')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Remove/i })).toBeInTheDocument();
  });

  it('PUTs both clientId and clientSecret on save', async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ configured: false, clientId: null })) // initial GET
      .mockResolvedValueOnce(respond({ ok: true, configured: true, clientId: 'Iv1.x' })) // PUT
      .mockResolvedValueOnce(respond({ configured: true, clientId: 'Iv1.x' })); // reload GET

    render(<PersonalOAuthConfigSection />);
    await waitFor(() => screen.getByRole('button', { name: /Configure OAuth App/i }));

    fireEvent.click(screen.getByRole('button', { name: /Configure OAuth App/i }));

    fireEvent.change(screen.getByTestId('personal-oauth-client-id'), {
      target: { value: 'Iv1.x' },
    });
    fireEvent.change(screen.getByTestId('personal-oauth-client-secret'), {
      target: { value: 'secret-y' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/config/personal-oauth',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ clientId: 'Iv1.x', clientSecret: 'secret-y' }),
        }),
      );
    });
  });
});
