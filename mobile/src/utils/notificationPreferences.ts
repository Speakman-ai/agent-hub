/**
 * Mobile instance of the shared notification preferences store
 * (`@shared/utils/notificationPrefsStore`). Keyed by server + user id so a
 * different server or account never sees or sends the previous one's edits.
 */
import {
  createNotificationPrefsStore,
  foregroundBannerAllowed as bannerAllowed,
} from '@shared/utils/notificationPrefsStore';
import { api } from './api';
import { getAuthRecord } from './auth';
import { getApiBaseUrl } from './config';

export { catalogDefaults, type NotificationPrefsState } from '@shared/utils/notificationPrefsStore';

const store = createNotificationPrefsStore({
  getPrefs: () => api.getNotificationPreferences(),
  putPrefs: (patch) => api.updateNotificationPreferences(patch),
  currentOwner: () => `${getApiBaseUrl() ?? ''}|${getAuthRecord()?.user?.id ?? ''}`,
});

export const {
  subscribe,
  getSnapshot,
  loadNotificationPrefs,
  saveNotificationPrefs,
  isNotificationChannelEnabled,
  resetNotificationPrefsStoreForTests,
} = store;

/** Foreground banners follow the signed-in user's `in_app` prefs. */
export function foregroundBannerAllowed(data: unknown): boolean {
  return bannerAllowed(data, isNotificationChannelEnabled);
}
