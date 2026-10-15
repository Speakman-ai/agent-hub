import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}));
const authState = vi.hoisted(() => ({ userId: 'u1' as string | null }));

vi.mock('./api', () => ({ api: apiMock }));
vi.mock('./auth', () => ({
  getAuthRecord: () => (authState.userId ? { user: { id: authState.userId } } : null),
}));
vi.mock('./config', () => ({ getApiBaseUrl: () => 'http://hub.test/api' }));

import {
  categoriesForNotificationData,
  foregroundBannerAllowed as bannerAllowed,
} from '@shared/utils/notificationPrefsStore';
import {
  foregroundBannerAllowed,
  getSnapshot,
  isNotificationChannelEnabled,
  loadNotificationPrefs,
  resetNotificationPrefsStoreForTests,
  saveNotificationPrefs,
} from './notificationPreferences';

function wire(overrides: Record<string, Partial<Record<'in_app' | 'desktop' | 'push', boolean>>>) {
  return {
    channels: ['in_app', 'desktop', 'push'],
    sections: [],
    categories: Object.entries(overrides).map(([category, v]) => ({
      category,
      in_app: v.in_app ?? true,
      desktop: v.desktop ?? false,
      push: v.push ?? false,
      isDefault: false,
    })),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  authState.userId = 'u1';
  apiMock.getNotificationPreferences.mockReset();
  apiMock.updateNotificationPreferences.mockReset();
  resetNotificationPrefsStoreForTests();
});

describe('notification preferences store (mobile)', () => {
  it('answers with catalog defaults before the matrix loads', () => {
    expect(isNotificationChannelEnabled('awaiting_feedback', 'push')).toBe(true);
    expect(isNotificationChannelEnabled('session_completed', 'push')).toBe(false);
    expect(isNotificationChannelEnabled('pr_merged', 'in_app')).toBe(true);
  });

  it('loads the per-user matrix from the server', async () => {
    apiMock.getNotificationPreferences.mockResolvedValue(wire({ pr_merged: { in_app: false } }));
    await loadNotificationPrefs();
    expect(getSnapshot().loaded).toBe(true);
    expect(getSnapshot().prefs.pr_merged.in_app).toBe(false);
    expect(isNotificationChannelEnabled('pr_merged', 'in_app')).toBe(false);
  });

  it('serializes saves and coalesces edits made while one is in flight', async () => {
    apiMock.getNotificationPreferences.mockResolvedValue(wire({}));
    await loadNotificationPrefs();
    const first = deferred<any>();
    apiMock.updateNotificationPreferences
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(wire({ dm: { push: false }, mention: { push: false } }));

    saveNotificationPrefs({ dm: { push: false } });
    saveNotificationPrefs({ mention: { push: false } });
    expect(apiMock.updateNotificationPreferences).toHaveBeenCalledTimes(1);
    expect(apiMock.updateNotificationPreferences).toHaveBeenLastCalledWith({ dm: { push: false } });
    // Optimistic: both edits show before the server confirms.
    expect(getSnapshot().prefs.dm.push).toBe(false);
    expect(getSnapshot().prefs.mention.push).toBe(false);

    first.resolve(wire({ dm: { push: false } }));
    await vi.waitFor(() => expect(apiMock.updateNotificationPreferences).toHaveBeenCalledTimes(2));
    expect(apiMock.updateNotificationPreferences).toHaveBeenLastCalledWith({
      mention: { push: false },
    });
  });

  it('ignores edits before load and drops state when the account changes', async () => {
    saveNotificationPrefs({ dm: { push: false } });
    expect(apiMock.updateNotificationPreferences).not.toHaveBeenCalled();

    apiMock.getNotificationPreferences.mockResolvedValue(wire({ dm: { in_app: false } }));
    await loadNotificationPrefs();
    expect(isNotificationChannelEnabled('dm', 'in_app')).toBe(false);

    authState.userId = 'u2';
    expect(isNotificationChannelEnabled('dm', 'in_app')).toBe(true);
  });
});

describe('foreground banner gate', () => {
  it('maps payloads to catalog categories', () => {
    expect(categoriesForNotificationData({ category: 'mention', event: 'chat_message' })).toEqual([
      'mention',
    ]);
    expect(categoriesForNotificationData({ event: 'chat_message' })).toEqual(['dm', 'mention']);
    expect(categoriesForNotificationData({ type: 'pr_merged' })).toEqual(['pr_merged']);
    expect(categoriesForNotificationData({ type: 'deploy_outcome' })).toEqual(['deploy_outcome']);
    expect(categoriesForNotificationData({ type: 'something_else' })).toEqual([]);
    expect(categoriesForNotificationData(null)).toEqual([]);
  });

  it('hides banners whose category has in_app off', () => {
    const off = new Set(['pr_merged', 'dm']);
    const isEnabled = (c: string) => !off.has(c);
    expect(bannerAllowed({ event: 'pr_merged' }, isEnabled)).toBe(false);
    expect(bannerAllowed({ event: 'pushed' }, isEnabled)).toBe(true);
    expect(bannerAllowed({ event: 'chat_message', category: 'dm' }, isEnabled)).toBe(false);
    expect(bannerAllowed({ event: 'chat_message', category: 'mention' }, isEnabled)).toBe(true);
    // Legacy chat payload without a category shows while either chat category is on.
    expect(bannerAllowed({ event: 'chat_message' }, isEnabled)).toBe(true);
    expect(bannerAllowed({ type: 'unrelated' }, () => false)).toBe(true);
  });

  it('reads the loaded in_app pref by default', async () => {
    apiMock.getNotificationPreferences.mockResolvedValue(wire({ infra_alert: { in_app: false } }));
    await loadNotificationPrefs();
    expect(foregroundBannerAllowed({ event: 'infra_alert' })).toBe(false);
    expect(foregroundBannerAllowed({ event: 'awaiting_feedback' })).toBe(true);
  });
});
