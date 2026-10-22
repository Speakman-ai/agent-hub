import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import NotificationPreferencesSection from './NotificationPreferencesSection';
import { api } from '../utils/api';
import { NOTIFICATION_CATEGORIES } from '@shared/utils/notificationCategories';
import { resetNotificationPrefsStoreForTests } from '../utils/notificationPrefsStore';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getNotificationPreferences: vi.fn(),
    updateNotificationPreferences: vi.fn(),
  },
}));

function serverPrefs(overrides: Record<string, Partial<Record<string, boolean>>> = {}) {
  return {
    channels: ['in_app', 'desktop', 'push'],
    sections: [],
    categories: NOTIFICATION_CATEGORIES.map((c) => ({
      category: c.id,
      section: c.section,
      label: c.label,
      description: c.description,
      ...c.defaults,
      ...overrides[c.id],
      defaults: { ...c.defaults },
      isDefault: !overrides[c.id],
    })),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const toggle = (cat: string, ch: string) => screen.getByTestId(`notification-toggle-${cat}-${ch}`);
const loaded = () =>
  waitFor(() => expect(screen.getByTestId('notification-section-all-chat')).not.toBeDisabled());
const expand = (cat: string) =>
  fireEvent.click(
    screen.getByTestId(`notification-category-${cat}`).querySelector('button[aria-expanded]')!,
  );

describe('NotificationPreferencesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNotificationPrefsStoreForTests();
    (api.getNotificationPreferences as any).mockResolvedValue(
      serverPrefs({ session_completed: { in_app: false } }),
    );
  });

  it('renders every catalog section and category', async () => {
    render(<NotificationPreferencesSection />);
    for (const id of ['sessions', 'code', 'board', 'support', 'infra', 'chat']) {
      expect(screen.getByTestId(`notification-section-${id}`)).toBeInTheDocument();
    }
    for (const c of NOTIFICATION_CATEGORIES) {
      expect(screen.getByTestId(`notification-category-${c.id}`)).toBeInTheDocument();
    }
  });

  it('expands a category into In-app / Desktop / Push toggles reflecting server values', async () => {
    render(<NotificationPreferencesSection />);
    await loaded();
    expand('session_completed');
    await waitFor(() =>
      expect(toggle('session_completed', 'in_app')).toHaveAttribute('aria-checked', 'false'),
    );
    expect(screen.getByRole('switch', { name: 'Session completed: In-app' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Session completed: Desktop' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Session completed: Push' })).toBeInTheDocument();
  });

  it('applies a toggle optimistically and PUTs only the changed channel', async () => {
    const pending = deferred<any>();
    (api.updateNotificationPreferences as any).mockReturnValue(pending.promise);
    render(<NotificationPreferencesSection />);
    await loaded();
    expand('dm');
    await waitFor(() => expect(toggle('dm', 'push')).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(toggle('dm', 'push'));
    expect(toggle('dm', 'push')).toHaveAttribute('aria-checked', 'false');
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith({ dm: { push: false } });

    pending.resolve(serverPrefs({ dm: { push: false } }));
    await waitFor(() => expect(toggle('dm', 'push')).toHaveAttribute('aria-checked', 'false'));
  });

  it('reverts the optimistic toggle and shows an error when the save fails', async () => {
    (api.updateNotificationPreferences as any).mockRejectedValue(new Error('boom'));
    render(<NotificationPreferencesSection />);
    await loaded();
    expand('mention');
    await waitFor(() =>
      expect(toggle('mention', 'desktop')).toHaveAttribute('aria-checked', 'true'),
    );

    fireEvent.click(toggle('mention', 'desktop'));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(toggle('mention', 'desktop')).toHaveAttribute('aria-checked', 'true');
  });

  it('section "Enable all" turns every channel on for every category in the section', async () => {
    (api.updateNotificationPreferences as any).mockResolvedValue(
      serverPrefs({
        ready_to_push: { desktop: true, push: true },
        pushed: { desktop: true, push: true },
        finalize_failed: { desktop: true, push: true },
        pr_merged: { desktop: true, push: true },
      }),
    );
    render(<NotificationPreferencesSection />);
    await loaded();
    const all = screen.getByTestId('notification-section-all-code');
    expect(all).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(all);
    const on = { in_app: true, desktop: true, push: true };
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith({
      ready_to_push: on,
      pushed: on,
      finalize_failed: on,
      default_branch_ci_failed: on,
      review_assigned_to_you: on,
      pr_environment_ready: on,
      pr_merged: on,
    });
    expect(all).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(all);
    const off = { in_app: false, desktop: false, push: false };
    await waitFor(() =>
      expect(api.updateNotificationPreferences).toHaveBeenLastCalledWith(
        expect.objectContaining({ ready_to_push: off, pr_merged: off }),
      ),
    );
  });

  it('keeps editing disabled until the initial load succeeds, so a late GET cannot clobber a save', async () => {
    const get = deferred<any>();
    (api.getNotificationPreferences as any).mockReturnValue(get.promise);
    render(<NotificationPreferencesSection />);
    const all = screen.getByTestId('notification-section-all-chat');
    expect(all).toBeDisabled();
    fireEvent.click(all);
    expect(api.updateNotificationPreferences).not.toHaveBeenCalled();

    get.resolve(serverPrefs({ dm: { push: false } }));
    await waitFor(() => expect(all).not.toBeDisabled());
    expand('dm');
    expect(toggle('dm', 'push')).toHaveAttribute('aria-checked', 'false');
  });

  it('offers a retry when the initial load fails and stays read-only meanwhile', async () => {
    (api.getNotificationPreferences as any)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(serverPrefs());
    render(<NotificationPreferencesSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.getByTestId('notification-section-all-chat')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.getByTestId('notification-section-all-chat')).not.toBeDisabled(),
    );
  });

  it('serializes overlapping saves so an earlier edit is not erased by a later response', async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    (api.updateNotificationPreferences as any)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<NotificationPreferencesSection />);
    await loaded();
    expand('dm');

    fireEvent.click(toggle('dm', 'push'));
    fireEvent.click(toggle('dm', 'desktop'));
    // Only one PUT in flight; the second edit waits.
    expect(api.updateNotificationPreferences).toHaveBeenCalledTimes(1);
    expect(api.updateNotificationPreferences).toHaveBeenLastCalledWith({ dm: { push: false } });
    expect(toggle('dm', 'push')).toHaveAttribute('aria-checked', 'false');
    expect(toggle('dm', 'desktop')).toHaveAttribute('aria-checked', 'false');

    // The first response predates the desktop edit; it must not undo it.
    first.resolve(serverPrefs({ dm: { push: false } }));
    await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalledTimes(2));
    expect(api.updateNotificationPreferences).toHaveBeenLastCalledWith({ dm: { desktop: false } });
    expect(toggle('dm', 'push')).toHaveAttribute('aria-checked', 'false');
    expect(toggle('dm', 'desktop')).toHaveAttribute('aria-checked', 'false');

    second.resolve(serverPrefs({ dm: { push: false, desktop: false } }));
    await waitFor(() => expect(toggle('dm', 'desktop')).toHaveAttribute('aria-checked', 'false'));
    expect(toggle('dm', 'push')).toHaveAttribute('aria-checked', 'false');
  });

  it('a failed older save does not roll back a newer edit to the same channel', async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    (api.updateNotificationPreferences as any)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<NotificationPreferencesSection />);
    await loaded();
    expand('mention');

    fireEvent.click(toggle('mention', 'push')); // off, in flight
    fireEvent.click(toggle('mention', 'push')); // back on, queued
    fireEvent.click(toggle('mention', 'desktop')); // off, queued
    expect(toggle('mention', 'push')).toHaveAttribute('aria-checked', 'true');

    first.reject(new Error('boom'));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(toggle('mention', 'push')).toHaveAttribute('aria-checked', 'true');
    expect(toggle('mention', 'desktop')).toHaveAttribute('aria-checked', 'false');
    await waitFor(() =>
      expect(api.updateNotificationPreferences).toHaveBeenLastCalledWith({
        mention: { push: true, desktop: false },
      }),
    );

    second.resolve(serverPrefs({ mention: { desktop: false } }));
    await waitFor(() =>
      expect(toggle('mention', 'desktop')).toHaveAttribute('aria-checked', 'false'),
    );
    expect(toggle('mention', 'push')).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps draining queued saves after the view unmounts', async () => {
    const first = deferred<any>();
    (api.updateNotificationPreferences as any)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(serverPrefs({ dm: { push: false, desktop: false } }));
    const view = render(<NotificationPreferencesSection />);
    await loaded();
    expand('dm');
    fireEvent.click(toggle('dm', 'push')); // in flight
    fireEvent.click(toggle('dm', 'desktop')); // queued
    expect(api.updateNotificationPreferences).toHaveBeenCalledTimes(1);

    view.unmount(); // e.g. switching settings tabs
    first.resolve(serverPrefs({ dm: { push: false } }));
    await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalledTimes(2));
    expect(api.updateNotificationPreferences).toHaveBeenLastCalledWith({ dm: { desktop: false } });

    // Coming back shows both saved edits, and the refresh GET doesn't undo them.
    (api.getNotificationPreferences as any).mockResolvedValue(
      serverPrefs({ dm: { push: false, desktop: false } }),
    );
    render(<NotificationPreferencesSection />);
    await loaded();
    expand('dm');
    expect(toggle('dm', 'push')).toHaveAttribute('aria-checked', 'false');
    expect(toggle('dm', 'desktop')).toHaveAttribute('aria-checked', 'false');
  });

  it('ignores a refresh GET that started before a newer save', async () => {
    render(<NotificationPreferencesSection />);
    await loaded();
    cleanup();
    const staleGet = deferred<any>();
    (api.getNotificationPreferences as any).mockReturnValueOnce(staleGet.promise);
    (api.updateNotificationPreferences as any).mockResolvedValue(
      serverPrefs({ dm: { push: false } }),
    );
    render(<NotificationPreferencesSection />); // refresh GET pending, editing still allowed
    expand('dm');
    fireEvent.click(toggle('dm', 'push'));
    await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalledTimes(1));

    staleGet.resolve(serverPrefs());
    await waitFor(() => expect(screen.queryByText(/Loading preferences/)).toBeNull());
    expect(toggle('dm', 'push')).toHaveAttribute('aria-checked', 'false');
  });
});
