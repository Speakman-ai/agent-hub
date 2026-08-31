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

  it('forwards the persist target, shows the save-for-future copy, and confirms persistence', async () => {
    (api.submitSessionCredentialRequest as any).mockResolvedValue({
      status: 'submitted',
      persisted: {
        skillId: 'survey-tracker',
        stored: ['SURVEYTRACKER_API_DATA_USERNAME', 'SURVEYTRACKER_API_DATA_PASSWORD'],
        skipped: [],
      },
    });
    const persistRequest = {
      ...request,
      persist: {
        skillId: 'survey-tracker',
        map: {
          username: 'SURVEYTRACKER_API_DATA_USERNAME',
          password: 'SURVEYTRACKER_API_DATA_PASSWORD',
        },
      },
    };
    const onSubmit = vi.fn();
    render(
      <CredentialRequestPrompt
        sessionId="session-1"
        request={persistRequest}
        onSubmit={onSubmit}
      />,
    );

    // Honest copy at collection time: saved for future sessions, not "discarded".
    expect(screen.getByText(/saved to your Survey Tracker skill credentials/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ryan' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(api.submitSessionCredentialRequest).toHaveBeenCalledWith(
        'session-1',
        'survey-tracker-login',
        expect.objectContaining({
          persist: {
            skillId: 'survey-tracker',
            map: {
              username: 'SURVEYTRACKER_API_DATA_USERNAME',
              password: 'SURVEYTRACKER_API_DATA_PASSWORD',
            },
          },
        }),
      );
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toContain('reused in future sessions');
  });

  it('surfaces a persist failure instead of silently falling back to the ephemeral message', async () => {
    (api.submitSessionCredentialRequest as any).mockResolvedValue({
      status: 'submitted',
      persisted: {
        skillId: 'survey-tracker',
        stored: [],
        skipped: [],
        error: 'skill "survey-tracker" declares no credentials in SKILL.md frontmatter',
      },
    });
    const persistRequest = {
      ...request,
      persist: {
        skillId: 'survey-tracker',
        map: { username: 'SURVEYTRACKER_API_DATA_USERNAME' },
      },
    };
    const onSubmit = vi.fn();
    render(
      <CredentialRequestPrompt
        sessionId="session-1"
        request={persistRequest}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ryan' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const message = onSubmit.mock.calls[0][0];
    expect(message).toContain('could NOT be saved');
    expect(message).toContain('declares no credentials');
    expect(message).not.toContain('reused in future sessions');
  });

  it('discloses a partial save instead of confirming full persistence', async () => {
    (api.submitSessionCredentialRequest as any).mockResolvedValue({
      status: 'submitted',
      persisted: {
        skillId: 'survey-tracker',
        stored: ['SURVEYTRACKER_API_DATA_USERNAME'],
        skipped: [{ keyName: 'SURVEYTRACKER_API_DATA_PASSWORD', reason: 'not-declared-by-skill' }],
      },
    });
    const persistRequest = {
      ...request,
      persist: {
        skillId: 'survey-tracker',
        map: {
          username: 'SURVEYTRACKER_API_DATA_USERNAME',
          password: 'SURVEYTRACKER_API_DATA_PASSWORD',
        },
      },
    };
    const onSubmit = vi.fn();
    render(
      <CredentialRequestPrompt
        sessionId="session-1"
        request={persistRequest}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ryan' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const message = onSubmit.mock.calls[0][0];
    expect(message).toContain('partially saved');
    expect(message).toContain('SURVEYTRACKER_API_DATA_PASSWORD');
    expect(message).not.toContain('reused in future sessions');
  });
});
