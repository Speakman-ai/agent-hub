import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    previewInvite: vi.fn(),
    acceptInvite: vi.fn(),
  },
}));

(vi as any).mock('../utils/auth.js', () => ({
  setToken: vi.fn(),
}));

import InviteAcceptPage from './InviteAcceptPage';
import { api } from '../utils/api';
import { setToken } from '../utils/auth';

beforeEach(() => {
  (api.previewInvite as any).mockReset();
  (api.acceptInvite as any).mockReset();
  (setToken as any).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InviteAcceptPage', () => {
  it('renders the invite preview, accepts it, stores the token, and redirects home', async () => {
    (api.previewInvite as any).mockResolvedValue({
      orgName: 'Acme Org',
      role: 'User',
      email: 'new@example.com',
      expiresAt: '2026-06-30T10:00:00.000Z',
      accepted: false,
    });
    (api.acceptInvite as any).mockResolvedValue({
      token: 'jwt',
      expiresAt: '2026-07-01T00:00:00.000Z',
      user: { email: 'new@example.com', role: 'User' },
    });
    const assign = vi.fn();
    const originalLocation = window.location;
    delete (window as any).location;
    (window as any).location = { ...originalLocation, assign };

    try {
      render(<InviteAcceptPage token="invite-token" />);

      expect(await screen.findByText(/Acme Org/i)).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText(/password/i), {
        target: { value: 'correct-password' },
      });
      fireEvent.click(screen.getByRole('button', { name: /accept invite/i }));

      await waitFor(() =>
        expect(api.acceptInvite).toHaveBeenCalledWith('invite-token', {
          email: 'new@example.com',
          username: 'new@example.com',
          password: 'correct-password',
        }),
      );
      expect(setToken).toHaveBeenCalledWith({
        token: 'jwt',
        expiresAt: '2026-07-01T00:00:00.000Z',
        user: { email: 'new@example.com', role: 'User' },
      });
      expect(assign).toHaveBeenCalledWith('/');
    } finally {
      (window as any).location = originalLocation;
    }
  });

  it('surfaces expired and consumed invite errors', async () => {
    (api.previewInvite as any).mockRejectedValue(new Error('410: invite expired'));

    render(<InviteAcceptPage token="expired-token" />);

    expect(
      await screen.findByText(/This invite has expired or was already used/i),
    ).toBeInTheDocument();
  });
});
