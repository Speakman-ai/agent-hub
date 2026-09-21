import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MyClaudeBrowserAuthSection from './MyClaudeBrowserAuthSection';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: {
    getMyClaudeBrowserAuth: vi.fn(),
    startMyClaudeBrowserLogin: vi.fn(),
    submitMyClaudeBrowserCode: vi.fn(),
    cancelMyClaudeBrowserLogin: vi.fn(),
    logoutMyClaudeBrowser: vi.fn(),
  },
}));
const idle = { binary: { present: true }, loginInProgress: false, oauth: { loggedIn: false } };
const attempt = {
  loginId: 'attempt-one',
  loginUrl: 'https://claude.ai/oauth/authorize?state=test',
};
const pending = { ...idle, ...attempt, loginInProgress: true };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getMyClaudeBrowserAuth).mockResolvedValue(idle);
  vi.mocked(api.startMyClaudeBrowserLogin).mockResolvedValue({ ok: true, ...attempt });
  vi.mocked(api.submitMyClaudeBrowserCode).mockResolvedValue({ ok: true });
  vi.mocked(api.cancelMyClaudeBrowserLogin).mockResolvedValue({ ok: true });
  vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Claude browser sign-in', () => {
  it('submits the code to the same login and waits for CLI completion', async () => {
    render(<MyClaudeBrowserAuthSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with browser' }));
    const field = await screen.findByLabelText('Claude authorization code');
    expect(field).toHaveAttribute('type', 'password');
    expect(screen.getByRole('link', { name: 'Open Claude sign-in' })).toHaveAttribute(
      'href',
      attempt.loginUrl,
    );
    fireEvent.change(field, { target: { value: 'one-time-code#state' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
    await waitFor(() =>
      expect(api.submitMyClaudeBrowserCode).toHaveBeenCalledWith(
        attempt.loginId,
        'one-time-code#state',
      ),
    );
    expect(await screen.findByText('Waiting for sign-in to finish…')).toBeInTheDocument();
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Claude authorization code')).not.toBeInTheDocument();
  });

  it('resumes a pending login and polls through completion', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getMyClaudeBrowserAuth).mockResolvedValue(pending);
    render(<MyClaudeBrowserAuthSection />);
    await act(async () => {});
    expect(screen.getByLabelText('Claude authorization code')).toBeInTheDocument();
    vi.mocked(api.getMyClaudeBrowserAuth).mockResolvedValue({
      ...idle,
      loginId: attempt.loginId,
      oauth: { loggedIn: true },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.queryByLabelText('Claude authorization code')).not.toBeInTheDocument();
    const calls = vi.mocked(api.getMyClaudeBrowserAuth).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(api.getMyClaudeBrowserAuth).toHaveBeenCalledTimes(calls);
  });

  it.each([false, true])(
    'resumes polling after failed cancellation and code submission (status failure: %s)',
    async (statusFails) => {
      vi.useFakeTimers();
      const getStatus = vi.mocked(api.getMyClaudeBrowserAuth);
      getStatus.mockResolvedValue(pending);
      vi.mocked(api.cancelMyClaudeBrowserLogin).mockRejectedValue(new Error('Cancel unavailable'));
      render(<MyClaudeBrowserAuthSection />);
      await act(async () => {});

      if (statusFails) getStatus.mockRejectedValueOnce(new Error('Status unavailable'));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
      await act(async () => {});
      fireEvent.change(screen.getByLabelText('Claude authorization code'), {
        target: { value: 'code-after-cancel-failure' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
      await act(async () => {});
      expect(api.submitMyClaudeBrowserCode).toHaveBeenCalledWith(
        attempt.loginId,
        'code-after-cancel-failure',
      );
      expect(screen.getByText('Waiting for sign-in to finish…')).toBeInTheDocument();

      getStatus.mockResolvedValue({
        ...idle,
        loginId: attempt.loginId,
        oauth: { loggedIn: true },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText('Signed in')).toBeInTheDocument();
      expect(screen.queryByText('Waiting for sign-in to finish…')).not.toBeInTheDocument();
      const calls = getStatus.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(getStatus).toHaveBeenCalledTimes(calls);
    },
  );

  it.each(['reject', 'resolve'])(
    'releases an obsolete submission after failed cancellation and ignores its late %s',
    async (outcome) => {
      vi.useFakeTimers();
      let resolveOld!: (value: any) => void;
      let rejectOld!: (reason: Error) => void;
      let rejectRetry!: (reason: Error) => void;
      const submitCode = vi.mocked(api.submitMyClaudeBrowserCode);
      submitCode.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolveOld = resolve;
          rejectOld = reject;
        }),
      );
      submitCode.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectRetry = reject;
        }),
      );
      const getStatus = vi.mocked(api.getMyClaudeBrowserAuth);
      getStatus.mockResolvedValue({ ...pending, codeSubmitted: false });
      vi.mocked(api.cancelMyClaudeBrowserLogin).mockRejectedValue(new Error('Cancel unavailable'));
      render(<MyClaudeBrowserAuthSection />);
      await act(async () => {});
      const enterCode = () => {
        fireEvent.change(screen.getByLabelText('Claude authorization code'), {
          target: { value: 'code#state' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
      };
      enterCode();
      expect(screen.getByLabelText('Claude authorization code')).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
      await act(async () => {});
      expect(screen.getByLabelText('Claude authorization code')).toBeEnabled();
      enterCode();
      expect(submitCode).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (outcome === 'reject') rejectOld(new Error('Obsolete submission failed'));
        else resolveOld({ ok: true });
      });
      expect(screen.queryByText('Obsolete submission failed')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Claude authorization code')).toBeDisabled();
      await act(async () => rejectRetry(new Error('Retry failed')));
      expect(screen.getByLabelText('Claude authorization code')).toBeEnabled();
      enterCode();
      await act(async () => {});
      expect(screen.getByText('Waiting for sign-in to finish…')).toBeInTheDocument();
      getStatus.mockResolvedValue({ ...idle, oauth: { loggedIn: true } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText('Signed in')).toBeInTheDocument();
    },
  );

  it.each(['expired', 'replaced'])(
    'releases a pending submission when polling reports the login %s',
    async (outcome) => {
      vi.useFakeTimers();
      let reject!: (reason: Error) => void;
      vi.mocked(api.submitMyClaudeBrowserCode).mockReturnValueOnce(
        new Promise((_resolve, r) => {
          reject = r;
        }),
      );
      const getStatus = vi.mocked(api.getMyClaudeBrowserAuth);
      getStatus.mockResolvedValueOnce(pending).mockResolvedValue(
        outcome === 'expired'
          ? idle
          : {
              ...pending,
              loginId: 'replacement',
            },
      );
      render(<MyClaudeBrowserAuthSection />);
      await act(async () => {});
      fireEvent.change(screen.getByLabelText('Claude authorization code'), {
        target: { value: 'code' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.queryByLabelText('Claude authorization code')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with browser' }));
      await act(async () => {});
      await act(async () => reject(new Error('Obsolete failure')));
      expect(screen.getByLabelText('Claude authorization code')).toBeEnabled();
      expect(screen.queryByText('Obsolete failure')).not.toBeInTheDocument();
    },
  );

  it('ignores a late start response after cancellation', async () => {
    let resolve!: (value: any) => void;
    vi.mocked(api.startMyClaudeBrowserLogin).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<MyClaudeBrowserAuthSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with browser' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel sign-in' }));
    await screen.findByRole('button', { name: 'Sign in with browser' });
    await act(async () => resolve({ ok: true, ...attempt }));
    expect(screen.queryByLabelText('Claude authorization code')).not.toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('ignores a pending status response after cancellation', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getMyClaudeBrowserAuth).mockResolvedValueOnce(pending);
    render(<MyClaudeBrowserAuthSection />);
    await act(async () => {});
    let resolve!: (value: any) => void;
    vi.mocked(api.getMyClaudeBrowserAuth).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    await act(async () => {});
    await act(async () => resolve({ ...idle, oauth: { loggedIn: true } }));
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with browser' })).toBeInTheDocument();
  });

  it('does not reopen code input when an older pending poll arrives after submission', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getMyClaudeBrowserAuth).mockResolvedValueOnce(pending);
    render(<MyClaudeBrowserAuthSection />);
    await act(async () => {});
    let resolve!: (value: any) => void;
    vi.mocked(api.getMyClaudeBrowserAuth).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    fireEvent.change(screen.getByLabelText('Claude authorization code'), {
      target: { value: 'one-time-code' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
    await act(async () => {});
    await act(async () => resolve({ ...pending, codeSubmitted: false }));
    expect(screen.queryByLabelText('Claude authorization code')).not.toBeInTheDocument();
    expect(screen.getByText('Waiting for sign-in to finish…')).toBeInTheDocument();
  });

  it('shows failure and lets the user retry', async () => {
    vi.mocked(api.startMyClaudeBrowserLogin).mockResolvedValue({
      ok: false,
      output: 'Claude sign-in expired. Start again.',
    });
    render(<MyClaudeBrowserAuthSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with browser' }));
    expect(await screen.findByText('Claude sign-in expired. Start again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with browser' })).toBeEnabled();
  });
});
