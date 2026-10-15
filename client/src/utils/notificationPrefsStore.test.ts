import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from './api';
import { getUserEmail } from './auth';
import {
  getSnapshot,
  isNotificationChannelEnabled,
  loadNotificationPrefs,
  saveNotificationPrefs,
  resetNotificationPrefsStoreForTests,
} from './notificationPrefsStore';

(vi as any).mock('./api.js', () => ({
  api: { getNotificationPreferences: vi.fn(), updateNotificationPreferences: vi.fn() },
}));
(vi as any).mock('./auth.js', () => ({ getUserEmail: vi.fn(() => 'a@example.com') }));

const empty = { channels: [], sections: [], categories: [] };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('notificationPrefsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserEmail).mockReturnValue('a@example.com');
    resetNotificationPrefsStoreForTests();
    (api.getNotificationPreferences as any).mockResolvedValue(empty);
  });

  it('ignores saves until loaded', async () => {
    saveNotificationPrefs({ dm: { push: false } });
    expect(api.updateNotificationPreferences).not.toHaveBeenCalled();
    loadNotificationPrefs();
    await flush();
    expect(getSnapshot().loaded).toBe(true);
  });

  it("drops a queued edit instead of sending it under a different user's session", async () => {
    let resolveFirst!: (v: unknown) => void;
    (api.updateNotificationPreferences as any).mockReturnValueOnce(
      new Promise((r) => (resolveFirst = r)),
    );
    loadNotificationPrefs();
    await flush();
    saveNotificationPrefs({ dm: { push: false } });
    saveNotificationPrefs({ dm: { desktop: false } });
    expect(api.updateNotificationPreferences).toHaveBeenCalledTimes(1);

    vi.mocked(getUserEmail).mockReturnValue('b@example.com');
    resolveFirst(empty);
    await flush();
    expect(api.updateNotificationPreferences).toHaveBeenCalledTimes(1);
    expect(getSnapshot().loaded).toBe(false);
  });

  it('answers channel checks with catalog defaults before the matrix loads', () => {
    expect(isNotificationChannelEnabled('awaiting_feedback', 'desktop')).toBe(true);
    expect(isNotificationChannelEnabled('session_completed', 'desktop')).toBe(false);
    expect(isNotificationChannelEnabled('session_completed', 'in_app')).toBe(true);
    expect(isNotificationChannelEnabled('not_a_category', 'desktop')).toBe(true);
  });

  it('answers channel checks from the stored matrix and local edits', async () => {
    (api.getNotificationPreferences as any).mockResolvedValue({
      ...empty,
      categories: [{ category: 'awaiting_feedback', in_app: true, desktop: false, push: true }],
    });
    (api.updateNotificationPreferences as any).mockReturnValue(new Promise(() => {}));
    loadNotificationPrefs();
    await flush();
    expect(isNotificationChannelEnabled('awaiting_feedback', 'desktop')).toBe(false);
    saveNotificationPrefs({ awaiting_feedback: { in_app: false } });
    expect(isNotificationChannelEnabled('awaiting_feedback', 'in_app')).toBe(false);
  });

  it("never applies another user's matrix", async () => {
    (api.getNotificationPreferences as any).mockResolvedValue({
      ...empty,
      categories: [{ category: 'awaiting_feedback', in_app: true, desktop: false, push: true }],
    });
    loadNotificationPrefs();
    await flush();
    vi.mocked(getUserEmail).mockReturnValue('b@example.com');
    expect(isNotificationChannelEnabled('awaiting_feedback', 'desktop')).toBe(true);
  });
});
