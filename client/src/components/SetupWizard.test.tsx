import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SetupWizard from './SetupWizard';
import { setup, login } from '../utils/auth';
vi.mock('../utils/connection', () => ({
  getApiBase: () => '/api',
  getConnectionConfig: () => ({ apiKey: '' }),
}));
vi.mock('../utils/auth', () => ({ setup: vi.fn(), login: vi.fn() }));
beforeEach(() => {
  vi.mocked(setup).mockReset().mockResolvedValue({});
  vi.mocked(login).mockReset().mockResolvedValue({});
});
function submit() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secure-password-123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}
describe('Hub account setup', () => {
  it('finishes after creating the owner without welcome or credential steps', async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    render(<SetupWizard onComplete={complete} />);
    submit();
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'owner@example.com', password: 'secure-password-123' }),
    );
    expect(screen.queryByText('Welcome to Agent Hub')).not.toBeInTheDocument();
    expect(screen.queryByText('AI engines')).not.toBeInTheDocument();
    expect(screen.queryByText('GitHub (optional)')).not.toBeInTheDocument();
  });
  it('supports password-manager DOM autofill on submission', async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    render(<SetupWizard onComplete={complete} />);
    const email = screen.getByLabelText('Email') as HTMLInputElement;
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    email.value = 'autofill@example.com';
    password.value = 'autofilled-password';
    fireEvent.submit(email.closest('form')!);
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({ username: email.value, password: 'autofilled-password' }),
    );
  });
  it('shows completion failures and allows retry when the owner now exists', async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('Please retry'))
      .mockResolvedValue(undefined);
    render(<SetupWizard onComplete={complete} />);
    submit();
    await screen.findByText('Please retry');
    vi.mocked(setup).mockRejectedValueOnce(new Error('Already configured'));
    submit();
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(login).toHaveBeenCalledOnce();
  });
});
