import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/auth.js', () => ({
  getAuthStatus: vi.fn(),
  login: vi.fn(),
  setup: vi.fn(),
}));

(vi as any).mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
}));

import LoginScreen from './LoginScreen';
import { getAuthStatus, login } from '../utils/auth';

beforeEach(() => {
  (getAuthStatus as any).mockReset();
  (login as any).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LoginScreen', () => {
  it('submits legacy non-email login names even after install status no longer needs email update', async () => {
    (getAuthStatus as any).mockResolvedValue({
      authConfigured: true,
      email: 'owner@example.com',
      needsEmailUpdate: false,
    });
    (login as any).mockResolvedValue({
      token: 'jwt',
      user: { email: null, needsEmailUpdate: true, role: 'Owner' },
    });
    const onAuthenticated = vi.fn();

    const { container } = render(<LoginScreen onAuthenticated={onAuthenticated} />);
    await screen.findByText(/Sign in to Agent Hub/i);

    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'legacy-user' } });
    fireEvent.change(inputs[1], { target: { value: 'correct-password' } });
    fireEvent.submit(inputs[1].closest('form')!);

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith({
        baseUrl: '/api',
        username: 'legacy-user',
        password: 'correct-password',
      });
    });
    expect(screen.queryByText(/Enter a valid email address/i)).toBeNull();
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });
});
