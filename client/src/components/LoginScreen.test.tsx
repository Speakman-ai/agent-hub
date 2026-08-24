import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/auth.js', () => ({
  getAuthStatus: vi.fn(),
  login: vi.fn(),
  setup: vi.fn(),
  completeMfaLogin: vi.fn(),
  forgotPassword: vi.fn(),
}));

(vi as any).mock('../utils/connection.js', () => ({
  getApiBase: vi.fn(() => '/api'),
}));

import LoginScreen from './LoginScreen';
import { completeMfaLogin, getAuthStatus, login, forgotPassword } from '../utils/auth';

beforeEach(() => {
  (getAuthStatus as any).mockReset();
  (login as any).mockReset();
  (completeMfaLogin as any).mockReset();
  (forgotPassword as any).mockReset();
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
    await screen.findByRole('button', { name: /^Sign in$/i });
    expect(screen.queryByRole('heading', { name: /Sign in to Agent Hub/i })).toBeNull();

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

  it('renders the MFA challenge after password verification and completes sign-in', async () => {
    (getAuthStatus as any).mockResolvedValue({
      authConfigured: true,
      email: 'owner@example.com',
      needsEmailUpdate: false,
    });
    (login as any).mockResolvedValue({
      mfaRequired: true,
      challengeId: 'mfa_123',
      expiresAt: '2026-06-29T12:05:00.000Z',
    });
    (completeMfaLogin as any).mockResolvedValue({ token: 'jwt' });
    const onAuthenticated = vi.fn();

    const { container } = render(<LoginScreen onAuthenticated={onAuthenticated} />);
    await screen.findByRole('button', { name: /^Sign in$/i });

    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'owner@example.com' } });
    fireEvent.change(inputs[1], { target: { value: 'correct-password' } });
    fireEvent.submit(inputs[1].closest('form')!);

    expect(await screen.findByText(/Verify MFA/i)).toBeInTheDocument();
    expect(onAuthenticated).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Authenticator code/i), {
      target: { value: '123 456' },
    });
    fireEvent.submit(screen.getByText(/Verify and sign in/i).closest('form')!);

    await waitFor(() =>
      expect(completeMfaLogin).toHaveBeenCalledWith({
        baseUrl: '/api',
        challengeId: 'mfa_123',
        code: '123456',
      }),
    );
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('exposes password-manager autofill hints on the MFA code field', async () => {
    // Regression: Bitwarden/1Password did not recognize the authenticator field
    // because it only carried autocomplete=one-time-code with no name matching
    // a strong TOTP keyword. The name must hit Bitwarden's TotpFieldNames list
    // (e.g. "totp"/"totpcode") in TOTP mode and not claim to be a TOTP field in
    // recovery mode.
    (getAuthStatus as any).mockResolvedValue({
      authConfigured: true,
      email: 'owner@example.com',
      needsEmailUpdate: false,
    });
    (login as any).mockResolvedValue({
      mfaRequired: true,
      challengeId: 'mfa_123',
      expiresAt: '2026-06-29T12:05:00.000Z',
    });

    const { container } = render(<LoginScreen onAuthenticated={vi.fn()} />);
    await screen.findByRole('button', { name: /^Sign in$/i });
    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'owner@example.com' } });
    fireEvent.change(inputs[1], { target: { value: 'correct-password' } });
    fireEvent.submit(inputs[1].closest('form')!);

    const totpField = (await screen.findByLabelText(/Authenticator code/i)) as HTMLInputElement;
    expect(totpField.getAttribute('autocomplete')).toBe('one-time-code');
    expect(totpField.getAttribute('inputmode')).toBe('numeric');
    // name must contain a strong Bitwarden TOTP keyword so autofill fires.
    expect(totpField.getAttribute('name')?.toLowerCase()).toContain('totp');

    fireEvent.click(screen.getByRole('button', { name: /Recovery code/i }));
    const recoveryField = (await screen.findByLabelText(/Recovery code/i)) as HTMLInputElement;
    expect(recoveryField.getAttribute('name')?.toLowerCase()).not.toContain('totp');
  });

  it('forgot mode hides the password field and submits the reset request with just the email', async () => {
    // Regression: the shared login form kept rendering a `required` password
    // field in forgot mode and the submit button stayed disabled until a
    // password was typed, so "Forgot password?" appeared to do nothing.
    (getAuthStatus as any).mockResolvedValue({
      authConfigured: true,
      email: 'owner@example.com',
      needsEmailUpdate: false,
    });
    (forgotPassword as any).mockResolvedValue({ ok: true });

    const { container } = render(<LoginScreen onAuthenticated={vi.fn()} />);
    await screen.findByRole('button', { name: /^Sign in$/i });

    // Two inputs before forgot mode: email + password.
    expect(container.querySelectorAll('input')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /Forgot password\?/i }));
    await screen.findByText(/Reset your password/i);

    // Password field is gone in forgot mode — only the email input remains.
    const inputs = container.querySelectorAll('input');
    expect(inputs).toHaveLength(1);

    // Submit is enabled with only an email and reads "Send reset link".
    const submitBtn = screen.getByRole('button', { name: /Send reset link/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    fireEvent.change(inputs[0], { target: { value: 'user@example.com' } });
    fireEvent.submit(inputs[0].closest('form')!);

    await waitFor(() =>
      expect(forgotPassword).toHaveBeenCalledWith({
        baseUrl: '/api',
        email: 'user@example.com',
      }),
    );
    // Confirmation state renders after a successful request.
    expect(await screen.findByRole('button', { name: /Back to sign in/i })).toBeInTheDocument();
  });

  it('supports recovery-code fallback and shows MFA errors without clearing the challenge', async () => {
    (getAuthStatus as any).mockResolvedValue({
      authConfigured: true,
      email: 'owner@example.com',
      needsEmailUpdate: false,
    });
    (login as any).mockResolvedValue({
      mfaRequired: true,
      challengeId: 'mfa_123',
      expiresAt: '2026-06-29T12:05:00.000Z',
    });
    (completeMfaLogin as any).mockRejectedValue(
      new Error('Too many MFA attempts. Try again later.'),
    );

    const { container } = render(<LoginScreen onAuthenticated={vi.fn()} />);
    await screen.findByRole('button', { name: /^Sign in$/i });
    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'owner@example.com' } });
    fireEvent.change(inputs[1], { target: { value: 'correct-password' } });
    fireEvent.submit(inputs[1].closest('form')!);

    await screen.findByText(/Verify MFA/i);
    fireEvent.click(screen.getByRole('button', { name: /Recovery code/i }));
    fireEvent.change(screen.getByLabelText(/Recovery code/i), {
      target: { value: 'abcd-efgh' },
    });
    fireEvent.submit(screen.getByText(/Verify and sign in/i).closest('form')!);

    expect(await screen.findByText(/Too many MFA attempts/i)).toBeInTheDocument();
    expect(screen.getByText(/Verify MFA/i)).toBeInTheDocument();
  });
});
