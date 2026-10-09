import { useEffect, useRef } from 'react';
import { api } from '../utils/api';
import { getAuthRecord } from '../utils/auth';
import {
  createChatNotifier,
  type ChatNotification,
  type ChatNotifierApi,
} from '../utils/googleChatNotifications';

/** Poll cadence without push. Keeps running in a hidden tab, where notices matter most. */
export const CHAT_NOTIFY_POLL_MS = 30_000;
/** Backup re-read while push is active, in case an event was lost. */
export const CHAT_NOTIFY_PUSH_BACKUP_MS = 5 * 60_000;

/**
 * Announce new Google Chat messages for the signed-in user. `enabled` must be
 * false unless the user's Google connection can read Chat. A new notifier is
 * built whenever the signed-in user changes, so one account's baselines and
 * seen messages never carry over to the next.
 */
export function useGoogleChatNotifications({
  enabled,
  pushActive,
  userId,
  onNotify,
  isViewingSpace,
  chatApi = api,
}: {
  enabled: boolean;
  pushActive: boolean;
  userId: string | null;
  onNotify: (notice: ChatNotification) => void;
  isViewingSpace?: (spaceId: string) => boolean;
  chatApi?: ChatNotifierApi;
}): void {
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const viewingRef = useRef(isViewingSpace);
  viewingRef.current = isViewingSpace;
  const notifierRef = useRef<ReturnType<typeof createChatNotifier> | null>(null);

  useEffect(() => {
    if (!enabled) {
      notifierRef.current = null;
      return undefined;
    }
    const notifier = createChatNotifier({
      api: chatApi,
      getMyUserId: () => getAuthRecord()?.user?.id || userId || null,
      isViewingSpace: (id) => !!viewingRef.current?.(id),
      onNotify: (n) => onNotifyRef.current(n),
    });
    notifierRef.current = notifier;
    void notifier.poll();
    const onEvent = (e: Event) => void notifier.handleEvent((e as CustomEvent).detail);
    window.addEventListener('google_chat_message', onEvent);
    return () => {
      // Requests started for this account may still resolve; dispose so they
      // can never notify after a sign-out or account switch.
      notifier.dispose();
      window.removeEventListener('google_chat_message', onEvent);
      if (notifierRef.current === notifier) notifierRef.current = null;
    };
  }, [enabled, userId, chatApi]);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(
      () => void notifierRef.current?.poll(),
      pushActive ? CHAT_NOTIFY_PUSH_BACKUP_MS : CHAT_NOTIFY_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [enabled, pushActive, userId, chatApi]);
}
