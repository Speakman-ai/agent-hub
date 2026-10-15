/**
 * Desktop notices for inbox notifications.
 *
 * The server's `notification_created` event is the one source of OS notices
 * for catalog categories, so web and Electron raise them for the same events
 * that create inbox rows and push. The event carries the recipient's
 * `desktop` pref; this only turns it into notice copy.
 */
import type { NotificationChannel } from '@shared/utils/notificationCategories';
import { isNotificationChannelEnabled } from './notificationPrefsStore';

const CHAT_CATEGORIES = new Set(['dm', 'mention']);

export interface InboxDesktopNotice {
  title: string;
  body: string;
  category: string;
}

/**
 * `isViewingChannel` suppresses DMs and mentions for the Hub Chat channel
 * already on screen, since that message is read the moment it lands.
 */
export function desktopNoticeForNotificationCreated(
  data: any,
  opts: { isViewingChannel?: (channelId: string) => boolean } = {},
): InboxDesktopNotice | null {
  if (!data || data.desktop !== true) return null;
  const n = data.notification;
  if (!n || typeof n.category !== 'string' || typeof n.title !== 'string') return null;
  if (CHAT_CATEGORIES.has(n.category)) {
    const channelId = n.data?.channelId;
    if (typeof channelId === 'string' && opts.isViewingChannel?.(channelId)) return null;
  }
  return {
    title: n.title,
    body: typeof n.body === 'string' ? n.body : '',
    category: n.category,
  };
}

/** Gate for in-app toasts that mirror a catalog category. */
export function toastAllowed(category: string): boolean {
  return isNotificationChannelEnabled(category, 'in_app' satisfies NotificationChannel);
}
