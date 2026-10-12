import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getMyMuseBrowserAuth: vi.fn(),
    startMyMuseDeviceLogin: vi.fn(),
    cancelMyMuseDeviceLogin: vi.fn(),
    logoutMyMuse: vi.fn(),
  },
}));

import { api } from '../utils/api';
import MyMuseAuthSection from './MyMuseAuthSection';

function status(overrides: any = {}) {
  return {
    uiStatus: 'missing',
    binary: { present: true, path: '/usr/local/bin/muse' },
    auth: { loggedIn: false, mode: null },
    loginInProgress: false,
    statusError: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  (api.getMyMuseBrowserAuth as any).mockResolvedValue(status());
  window.open = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MyMuseAuthSection', () => {
  it('shows the device code, opens the Meta page safely, and finishes when the login lands', async () => {
    (api.startMyMuseDeviceLogin as any).mockResolvedValue({
      ok: true,
      loginId: 'l1',
      deviceAuthUrl: 'https://auth.meta.com/oauth/device/?code=WXYZ-1234',
      userCode: 'WXYZ-1234',
    });
    render(<MyMuseAuthSection />);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole('button', { name: /sign in with meta/i }));

    expect(await screen.findByTestId('muse-device-code')).toHaveTextContent('WXYZ-1234');
    expect(window.open).toHaveBeenCalledWith(
      'https://auth.meta.com/oauth/device/?code=WXYZ-1234',
      '_blank',
      'noopener,noreferrer',
    );

    (api.getMyMuseBrowserAuth as any).mockResolvedValue(
      status({ uiStatus: 'authenticated', auth: { loggedIn: true, mode: 'oauth' } }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByText('Signed in to Muse Code.')).toBeInTheDocument();
    expect(screen.queryByTestId('muse-device-code')).toBeNull();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('ignores a start response that arrives after the user cancelled', async () => {
    let resolveStart!: (v: unknown) => void;
    (api.startMyMuseDeviceLogin as any).mockReturnValue(
      new Promise((r) => {
        resolveStart = r;
      }),
    );
    (api.cancelMyMuseDeviceLogin as any).mockResolvedValue({ ok: true });
    render(<MyMuseAuthSection />);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole('button', { name: /sign in with meta/i }));
    fireEvent.click(await screen.findByRole('button', { name: /cancel/i }));
    expect(await screen.findByText('Sign-in cancelled.')).toBeInTheDocument();
    const statusCalls = (api.getMyMuseBrowserAuth as any).mock.calls.length;

    await act(async () => {
      resolveStart({
        ok: true,
        deviceAuthUrl: 'https://auth.meta.com/oauth/device/?code=LATE-0001',
        userCode: 'LATE-0001',
      });
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.queryByTestId('muse-device-code')).toBeNull();
    expect((api.getMyMuseBrowserAuth as any).mock.calls.length).toBe(statusCalls);
  });

  it('does nothing when the start response lands after unmount', async () => {
    let resolveStart!: (v: unknown) => void;
    (api.startMyMuseDeviceLogin as any).mockReturnValue(
      new Promise((r) => {
        resolveStart = r;
      }),
    );
    const { unmount } = render(<MyMuseAuthSection />);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole('button', { name: /sign in with meta/i }));
    unmount();
    const statusCalls = (api.getMyMuseBrowserAuth as any).mock.calls.length;
    await act(async () => {
      resolveStart({
        ok: true,
        deviceAuthUrl: 'https://auth.meta.com/oauth/device/?code=LATE-0002',
        userCode: 'LATE-0002',
      });
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(window.open).not.toHaveBeenCalled();
    expect((api.getMyMuseBrowserAuth as any).mock.calls.length).toBe(statusCalls);
  });

  it('keeps the newest status when an older status response lands last', async () => {
    (api.startMyMuseDeviceLogin as any).mockResolvedValue({
      ok: true,
      deviceAuthUrl: 'https://auth.meta.com/oauth/device/?code=WXYZ-1234',
      userCode: 'WXYZ-1234',
    });
    (api.cancelMyMuseDeviceLogin as any).mockResolvedValue({ ok: true });
    render(<MyMuseAuthSection />);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole('button', { name: /sign in with meta/i }));
    await screen.findByTestId('muse-device-code');

    // The first poll goes out and hangs.
    let resolveOld!: (v: unknown) => void;
    (api.getMyMuseBrowserAuth as any).mockReturnValueOnce(
      new Promise((r) => {
        resolveOld = r;
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    // Cancel issues a newer status request, which reports signed in.
    (api.getMyMuseBrowserAuth as any).mockResolvedValueOnce(
      status({ uiStatus: 'authenticated', auth: { loggedIn: true, mode: 'oauth' } }),
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();

    // The stale poll finally answers "missing"; it must not undo the sign-in.
    await act(async () => {
      resolveOld(status({ uiStatus: 'missing', loginInProgress: true }));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with meta/i })).toBeNull();
  });

  it('never has two status polls in flight', async () => {
    (api.startMyMuseDeviceLogin as any).mockResolvedValue({
      ok: true,
      deviceAuthUrl: 'https://auth.meta.com/oauth/device/?code=WXYZ-1234',
      userCode: 'WXYZ-1234',
    });
    render(<MyMuseAuthSection />);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole('button', { name: /sign in with meta/i }));
    await screen.findByTestId('muse-device-code');
    const before = (api.getMyMuseBrowserAuth as any).mock.calls.length;
    (api.getMyMuseBrowserAuth as any).mockReturnValue(new Promise(() => {}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect((api.getMyMuseBrowserAuth as any).mock.calls.length).toBe(before + 1);
  });

  it('cancels by loginId and blocks a retry until the cancel settles', async () => {
    (api.startMyMuseDeviceLogin as any)
      .mockResolvedValueOnce({
        ok: true,
        loginId: 'login-1',
        deviceAuthUrl: 'https://auth.meta.com/oauth/device/?code=AAAA-1111',
        userCode: 'AAAA-1111',
      })
      .mockResolvedValueOnce({
        ok: true,
        loginId: 'login-2',
        deviceAuthUrl: 'https://auth.meta.com/oauth/device/?code=BBBB-2222',
        userCode: 'BBBB-2222',
      });
    let resolveCancel!: (v: unknown) => void;
    (api.cancelMyMuseDeviceLogin as any).mockReturnValueOnce(
      new Promise((r) => {
        resolveCancel = r;
      }),
    );
    render(<MyMuseAuthSection />);
    fireEvent.click(await screen.findByRole('button', { name: /sign in with meta/i }));
    await screen.findByTestId('muse-device-code');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(api.cancelMyMuseDeviceLogin).toHaveBeenCalledWith('login-1');
    const retry = await screen.findByRole('button', { name: /sign in with meta/i });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(api.startMyMuseDeviceLogin).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCancel({ ok: true, output: 'Device login cancelled' });
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sign in with meta/i })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /sign in with meta/i }));
    expect(await screen.findByTestId('muse-device-code')).toHaveTextContent('BBBB-2222');
    expect(api.cancelMyMuseDeviceLogin).toHaveBeenCalledTimes(1);
  });

  it('cancels exactly the server login whose start answered after Cancel', async () => {
    let resolveStart!: (v: unknown) => void;
    (api.startMyMuseDeviceLogin as any).mockReturnValue(
      new Promise((r) => {
        resolveStart = r;
      }),
    );
    (api.cancelMyMuseDeviceLogin as any).mockResolvedValue({ ok: true });
    render(<MyMuseAuthSection />);
    fireEvent.click(await screen.findByRole('button', { name: /sign in with meta/i }));
    fireEvent.click(await screen.findByRole('button', { name: /cancel/i }));
    await screen.findByText('Sign-in cancelled.');
    expect(api.cancelMyMuseDeviceLogin).toHaveBeenLastCalledWith(undefined);

    await act(async () => {
      resolveStart({
        ok: true,
        loginId: 'late-login',
        deviceAuthUrl: 'https://auth.meta.com/oauth/device/?code=LATE-0003',
        userCode: 'LATE-0003',
      });
    });
    expect(api.cancelMyMuseDeviceLogin).toHaveBeenLastCalledWith('late-login');
    expect(window.open).not.toHaveBeenCalled();
  });

  it('surfaces the CLI output when login cannot start', async () => {
    (api.startMyMuseDeviceLogin as any).mockResolvedValue({
      ok: false,
      output: 'network unreachable',
    });
    render(<MyMuseAuthSection />);
    fireEvent.click(await screen.findByRole('button', { name: /sign in with meta/i }));
    expect(await screen.findByText('network unreachable')).toBeInTheDocument();
  });

  it('disables sign-in and explains when the binary is missing', async () => {
    (api.getMyMuseBrowserAuth as any).mockResolvedValue(
      status({ binary: { present: false, path: '/opt/muse' } }),
    );
    render(<MyMuseAuthSection />);
    expect(await screen.findByRole('button', { name: /sign in with meta/i })).toBeDisabled();
    expect(screen.getByText('/opt/muse')).toBeInTheDocument();
  });

  it('signs out', async () => {
    (api.getMyMuseBrowserAuth as any).mockResolvedValue(
      status({ uiStatus: 'authenticated', auth: { loggedIn: true, mode: 'oauth' } }),
    );
    (api.logoutMyMuse as any).mockResolvedValue({ ok: true, output: 'Muse credential removed' });
    render(<MyMuseAuthSection />);
    fireEvent.click(await screen.findByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(api.logoutMyMuse).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Muse credential removed')).toBeInTheDocument();
  });
});
