import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from './api';
import { getUserEmail } from './auth';
import {
  getSnapshot,
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
});
