import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

(vi as any).mock('../utils/api', () => ({
  api: {
    getSessionCredentialRequest: vi.fn(),
    submitSessionCredentialRequest: vi.fn(),
  },
}));

import { api } from '../utils/api';
import CredentialRequestPrompt from './CredentialRequestPrompt';

const request = {
  requestId: 'survey-tracker-login',
  service: 'Survey Tracker',
  purpose: 'Sign in to query work orders.',
  fields: [
    { key: 'username', label: 'Username', type: 'username' as const },
    { key: 'password', label: 'Password', type: 'password' as const },
  ],
  ttlSeconds: 900,
};

describe('CredentialRequestPrompt', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (api.getSessionCredentialRequest as any).mockRejectedValue(new Error('not found'));
    (api.submitSessionCredentialRequest as any).mockResolvedValue({ status: 'submitted' });
  });

  it('submits credentials through the API without putting values in the chat callback', async () => {
    const onSubmit = vi.fn();
    render(<CredentialRequestPrompt sessionId="session-1" request={request} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'employee@example.com' },
    });
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(password.type).toBe('password');
    fireEvent.change(password, { target: { value: 'survey-secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(api.submitSessionCredentialRequest).toHaveBeenCalledWith(
        'session-1',
        'survey-tracker-login',
        expect.objectContaining({
          values: {
            username: 'employee@example.com',
            password: 'survey-secret-password',
          },
        }),
      );
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const message = onSubmit.mock.calls[0][0];
    expect(message).toContain('survey-tracker-login');
    expect(message).toContain('Survey Tracker');
    expect(message).not.toContain('employee@example.com');
    expect(message).not.toContain('survey-secret-password');
  });
});
