/**
 * The app's one bell inbox store and its account gate. The gate is the same
 * one Agent Hub chat uses: the inbox belongs to one server, user and org, is
 * dropped the moment that account goes away, loads once the new account is
 * connected, and refetches on every reconnect.
 */
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { createHubChatAccountGate } from './hubChatAccountGate';
import {
  createNotificationInboxStore,
  type NotificationInboxSnapshot,
} from './notificationInboxStore';

export const notificationInboxStore = createNotificationInboxStore(api.notifications);

export const notificationInboxAccountGate = createHubChatAccountGate({
  reset: (enabled) => notificationInboxStore.reset(enabled),
  resync: () => notificationInboxStore.resync(),
  resetCaches: () => {},
});

export function useNotificationInbox(): NotificationInboxSnapshot {
  return useSyncExternalStore(
    notificationInboxStore.subscribe,
    notificationInboxStore.getSnapshot,
    notificationInboxStore.getSnapshot,
  );
}
