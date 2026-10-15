/**
 * Web instance of the shared notification preferences store
 * (`@shared/utils/notificationPrefsStore`), keyed by the signed-in email.
 */
import { createNotificationPrefsStore } from '@shared/utils/notificationPrefsStore';
import { api } from './api';
import { getUserEmail } from './auth';

export {
  applyPatch,
  type ChannelValues,
  type NotificationPrefsState,
  type PrefsMap,
} from '@shared/utils/notificationPrefsStore';

const store = createNotificationPrefsStore({
  getPrefs: () => api.getNotificationPreferences(),
  putPrefs: (patch) => api.updateNotificationPreferences(patch),
  currentOwner: () => getUserEmail() ?? null,
});

export const {
  subscribe,
  getSnapshot,
  saveNotificationPrefs,
  isNotificationChannelEnabled,
  resetNotificationPrefsStoreForTests,
} = store;

export function loadNotificationPrefs(): void {
  void store.loadNotificationPrefs();
}
