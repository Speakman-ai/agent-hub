/**
 * Notification service for the Electron main process.
 *
 * Wraps Electron's native Notification API with:
 * - Permission checking
 * - Configurable defaults (app name, icon)
 * - Click-to-focus behavior
 * - Deduplication within a short window to prevent floods
 */

import { Notification, app, nativeImage, type BrowserWindow, type IpcMainEvent } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deduplication: ignore identical notifications within this window (ms)
const DEDUP_WINDOW_MS = 3000;

/** key → timestamp of last show */
const recentNotifications = new Map<string, number>();

export interface ShowNotificationOptions {
  title: string;
  body?: string;
  type?: 'info' | 'success' | 'error' | 'warning';
  silent?: boolean;
  mainWindow?: BrowserWindow | null;
}

/**
 * Build a dedup key from the notification options.
 * Two notifications with the same title + body within the dedup window are
 * considered duplicates.
 */
function dedupKey(title: string, body?: string) {
  return `${title}::${body || ''}`;
}

/**
 * Prune stale entries from the dedup map so it doesn't grow forever.
 */
function pruneRecent() {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [key, ts] of recentNotifications) {
    if (ts < cutoff) recentNotifications.delete(key);
  }
}

/**
 * Resolve the app icon path for notifications.
 * Returns a nativeImage or undefined if no icon is found.
 */
function getAppIcon() {
  try {
    const candidates = [
      path.join(__dirname, 'icon.png'),
      path.join(__dirname, '..', 'client', 'public', 'icon.png'),
      path.join(__dirname, '..', 'client', 'dist', 'icon.png'),
    ];
    for (const iconPath of candidates) {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) return img;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if the system supports native notifications.
 */
export function isNotificationSupported() {
  return Notification.isSupported();
}

/**
 * Show a native desktop notification.
 */
export function showNotification({
  title,
  body,
  type = 'info',
  silent = false,
  mainWindow,
}: ShowNotificationOptions) {
  if (!Notification.isSupported()) return false;

  // Deduplicate
  pruneRecent();
  const key = dedupKey(title, body);
  if (recentNotifications.has(key)) return false;
  recentNotifications.set(key, Date.now());

  const icon = getAppIcon();

  // Map type to urgency — Electron supports 'normal', 'critical', 'low' on Linux
  const urgency = type === 'error' ? 'critical' : type === 'warning' ? 'normal' : 'low';

  const notification = new Notification({
    title,
    body: body || '',
    icon,
    silent,
    urgency,
  });

  // Focus the main window when the user clicks the notification
  notification.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  notification.show();
  return true;
}

/**
 * Create an IPC-compatible handler function bound to a specific window.
 * This returns an object with the handler functions to register via ipcMain.
 */
export function createNotificationHandlers(getMainWindow: () => BrowserWindow | null) {
  return {
    handleShowNotification(
      _event: IpcMainEvent,
      options: Omit<ShowNotificationOptions, 'mainWindow'>,
    ) {
      const mainWindow = getMainWindow();
      return showNotification({ ...options, mainWindow });
    },

    handleGetSupport(event: IpcMainEvent) {
      event.returnValue = isNotificationSupported();
    },
  };
}

// Export for testing
export { DEDUP_WINDOW_MS, recentNotifications, dedupKey, pruneRecent };
