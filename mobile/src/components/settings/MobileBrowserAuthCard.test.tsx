/** @vitest-environment jsdom */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: ({ style }: any) => <span data-testid="loading" style={style} />,
  StyleSheet: { create: (styles: any) => styles },
  Text: ({ children }: any) => <span>{children}</span>,
  TouchableOpacity: ({ children, disabled, onPress }: any) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  View: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('../../utils/clipboard', () => ({ copyToClipboard: vi.fn() }));

import * as WebBrowser from 'expo-web-browser';
import MobileBrowserAuthCard from './MobileBrowserAuthCard';

type Status = {
  uiStatus?: string;
  binary?: { present?: boolean; path?: string };
  oauth?: { loggedIn?: boolean | null; email?: string | null };
  loginInProgress?: boolean;
  statusError?: string | null;
};

const idleStatus: Status = {
  binary: { present: true },
  oauth: { loggedIn: false },
  loginInProgress: false,
};
const signedInStatus: Status = {
  binary: { present: true },
  oauth: { loggedIn: true },
  uiStatus: 'authenticated',
  loginInProgress: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let renderedElement: React.ReactElement | null = null;

function mount(overrides: Partial<React.ComponentProps<typeof MobileBrowserAuthCard>> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const props: React.ComponentProps<typeof MobileBrowserAuthCard> = {
    label: 'Claude',
    description: 'Use browser sign-in.',
    loginMode: 'url',
    getStatus: vi.fn().mockResolvedValue(idleStatus),
    startLogin: vi.fn().mockResolvedValue({ loginUrl: 'https://claude.ai/login' }),
    cancelLogin: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue({ output: 'Signed out.' }),
    ...overrides,
  };
  renderedElement = <MobileBrowserAuthCard {...props} />;
  flushSync(() => {
    root!.render(renderedElement);
  });
  return props;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  if (root && renderedElement) {
    flushSync(() => root!.render(renderedElement));
  }
}

function text() {
  return container?.textContent ?? '';
}

function button(label: string) {
  const match = Array.from(container?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent === label,
  );
  if (!match) throw new Error(`Button not found: ${label}\n${text()}`);
  return match;
}

async function press(label: string) {
  button(label).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();
}

afterEach(() => {
  if (root) {
    flushSync(() => root!.unmount());
  }
  root = null;
  renderedElement = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MobileBrowserAuthCard', () => {
  it('shows loading first, then renders the idle sign-in action', async () => {
    const status = deferred<Status>();
    const getStatus = vi.fn().mockReturnValue(status.promise);
    mount({ getStatus });

    expect(container?.querySelector('[data-testid="loading"]')).not.toBeNull();
    status.resolve(idleStatus);
    await settle();

    expect(text()).toContain('Claude browser sign-in');
    expect(text()).toContain('Sign in with browser');
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('polls until sign-in completes and then clears the busy state', async () => {
    vi.useFakeTimers();
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(idleStatus)
      .mockResolvedValueOnce(signedInStatus);
    mount({ getStatus });
    await settle();
    await press('Sign in with browser');

    await vi.advanceTimersByTimeAsync(3000);
    await settle();

    expect(text()).toContain('Signed in');
    expect(text()).toContain('Claude sign-in complete.');
    expect(text()).toContain('Sign out');
  });

  it('keeps polling when an existing cache is valid but login is still in progress', async () => {
    vi.useFakeTimers();
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(idleStatus)
      .mockResolvedValueOnce({ ...signedInStatus, loginInProgress: true })
      .mockResolvedValueOnce(signedInStatus);
    mount({ getStatus });
    await settle();
    await press('Sign in with browser');

    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(text()).toContain('Cancel sign-in');
    expect(text()).not.toContain('Claude sign-in complete.');

    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(text()).toContain('Claude sign-in complete.');
    expect(text()).toContain('Sign out');
  });

  it('shows a timeout message after the polling deadline', async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn().mockResolvedValue({ ...idleStatus, loginInProgress: true });
    mount({ getStatus });
    await settle();
    await press('Sign in with browser');

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await settle();

    expect(text()).toContain('Claude sign-in timed out. Try again.');
    expect(text()).toContain('Sign in with browser');
  });

  it('cancels a login and refreshes status', async () => {
    const cancelLogin = vi.fn().mockResolvedValue(undefined);
    const getStatus = vi.fn().mockResolvedValue(idleStatus);
    mount({ cancelLogin, getStatus });
    await settle();
    await press('Sign in with browser');
    await press('Cancel sign-in');

    expect(cancelLogin).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Sign-in cancelled.');
    expect(text()).toContain('Sign in with browser');
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect a cancelled login when startLogin resolves late', async () => {
    const pendingLogin = deferred<{ loginUrl: string }>();
    const startLogin = vi.fn().mockReturnValue(pendingLogin.promise);
    const cancelLogin = vi.fn().mockResolvedValue(undefined);
    const getStatus = vi.fn().mockResolvedValue(idleStatus);
    vi.mocked(WebBrowser.openBrowserAsync).mockClear();
    mount({ startLogin, cancelLogin, getStatus });
    await settle();

    await press('Sign in with browser');
    await press('Cancel sign-in');
    expect(text()).toContain('Sign-in cancelled.');

    pendingLogin.resolve({ loginUrl: 'https://claude.ai/stale-login' });
    await settle();

    expect(text()).not.toContain('Copy link');
    expect(text()).not.toContain('Cancel sign-in');
    expect(text()).toContain('Sign in with browser');
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });

  it('logs out, refreshes status, and returns to the sign-in action', async () => {
    const logout = vi.fn().mockResolvedValue({ output: 'Claude session removed.' });
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(signedInStatus)
      .mockResolvedValueOnce(idleStatus);
    mount({ logout, getStatus });
    await settle();
    await press('Sign out');

    expect(logout).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Claude session removed.');
    expect(text()).toContain('Sign in with browser');
  });

  it('keeps the login link visible when the native browser cannot open it', async () => {
    vi.mocked(WebBrowser.openBrowserAsync).mockRejectedValueOnce(new Error('browser unavailable'));
    mount();
    await settle();
    await press('Sign in with browser');

    expect(text()).toContain('Copy link');
    expect(text()).toContain('Cancel sign-in');
    expect(text()).not.toContain('sign-in failed');
  });

  it('ignores stale poll responses and prevents overlapping polls', async () => {
    vi.useFakeTimers();
    const firstPoll = deferred<Status>();
    const afterCancel = deferred<Status>();
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(idleStatus)
      .mockReturnValueOnce(firstPoll.promise)
      .mockReturnValueOnce(afterCancel.promise);
    const cancelLogin = vi.fn().mockResolvedValue(undefined);
    mount({ getStatus, cancelLogin });
    await settle();
    await press('Sign in with browser');

    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(getStatus).toHaveBeenCalledTimes(2);

    await press('Cancel sign-in');
    afterCancel.resolve(signedInStatus);
    await settle();
    expect(text()).toContain('Signed in');

    firstPoll.resolve({ ...idleStatus, statusError: 'stale failure' });
    await settle();
    expect(text()).toContain('Signed in');
    expect(text()).not.toContain('stale failure');
  });
});
