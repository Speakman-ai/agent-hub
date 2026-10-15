import { describe, expect, it, vi } from 'vitest';
import {
  categoriesForNotificationData,
  createNotificationPrefsStore,
  foregroundBannerAllowed,
  type NotificationPrefsResponse,
} from './notificationPrefsStore';

const res = (category: string, in_app: boolean): NotificationPrefsResponse => ({
  categories: [{ category, in_app, desktop: false, push: false }],
});

describe('createNotificationPrefsStore', () => {
  it('keeps separate state per instance and per owner', async () => {
    let owner = 'a';
    const getPrefs = vi.fn().mockResolvedValue(res('pr_merged', false));
    const store = createNotificationPrefsStore({
      getPrefs,
      putPrefs: vi.fn(),
      currentOwner: () => owner,
    });
    const other = createNotificationPrefsStore({
      getPrefs: vi.fn(),
      putPrefs: vi.fn(),
      currentOwner: () => 'a',
    });

    await store.loadNotificationPrefs();
    expect(store.isNotificationChannelEnabled('pr_merged', 'in_app')).toBe(false);
    expect(other.isNotificationChannelEnabled('pr_merged', 'in_app')).toBe(true);

    owner = 'b';
    expect(store.isNotificationChannelEnabled('pr_merged', 'in_app')).toBe(true);
  });

  it('sends edits through the injected putPrefs', async () => {
    const putPrefs = vi.fn().mockResolvedValue(res('dm', false));
    const store = createNotificationPrefsStore({
      getPrefs: vi.fn().mockResolvedValue({ categories: [] }),
      putPrefs,
      currentOwner: () => 'a',
    });
    await store.loadNotificationPrefs();
    store.saveNotificationPrefs({ dm: { in_app: false } });
    expect(putPrefs).toHaveBeenCalledWith({ dm: { in_app: false } });
    expect(store.getSnapshot().prefs.dm.in_app).toBe(false);
  });

  it('gates foreground banners on the in_app pref', () => {
    expect(foregroundBannerAllowed({ event: 'pr_merged' }, () => false)).toBe(false);
    expect(foregroundBannerAllowed({ event: 'not_a_category' }, () => false)).toBe(true);
  });

  it('treats inherited property names as out-of-catalog payloads', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(categoriesForNotificationData({ event: key })).toEqual([]);
      expect(categoriesForNotificationData({ type: key })).toEqual([]);
      expect(foregroundBannerAllowed({ event: key }, () => false)).toBe(true);
    }
  });
});
