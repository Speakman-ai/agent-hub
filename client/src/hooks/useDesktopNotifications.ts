/**
 * Hook for sending native desktop notifications from the renderer.
 *
 * In Electron, delegates to the main process via IPC (window.electronAPI).
 * In the browser, falls back to the Web Notifications API.
 * Returns a no-op when neither is available.
 */

import { useCallback, useRef } from 'react';

/**
 * Check if we're running inside Electron.
 */
function isElectron() {
  return typeof window !== 'undefined' && window.electronAPI?.isElectron === true;
}

/**
 * Check if the browser Notification API is available and permission isn't denied.
 */
function isBrowserNotificationAvailable() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * @typedef {object} NotificationOptions
 * @property {string} title - Notification title (required)
 * @property {string} [body] - Notification body text
 * @property {'info'|'success'|'error'|'warning'} [type='info'] - Notification type
 * @property {boolean} [silent=false] - Suppress notification sound
 */

/**
 * Send a desktop notification using the best available method.
 *
 * @param {NotificationOptions} options
 * @returns {boolean} Whether the notification was sent
 */
export function sendDesktopNotification({ title, body, type = 'info', silent = false }: any) {
  // Electron path — IPC to main process
  if (isElectron()) {
    window.electronAPI?.showNotification?.({ title, body, type, silent });
    return true;
  }

  // Browser path — Web Notifications API
  if (isBrowserNotificationAvailable()) {
    if (Notification.permission === 'granted') {
      new Notification(title, { body, silent });
      return true;
    }
    if (Notification.permission !== 'denied') {
      // Request permission, then show if granted
      Notification.requestPermission().then((perm: any) => {
        if (perm === 'granted') {
          new Notification(title, { body, silent });
        }
      });
      return false; // permission pending
    }
  }

  return false;
}

/**
 * Hook that returns a stable `notify` function for desktop notifications.
 *
 * Only fires when the window is not focused (background notifications),
 * so it won't annoy users who are already looking at the app.
 *
 * @returns {{ notify: (options: NotificationOptions) => void, isSupported: boolean }}
 */
export function useDesktopNotifications() {
  const supported = useRef(
    isElectron()
      ? (window.electronAPI as any)?.isNotificationSupported?.() !== false
      : isBrowserNotificationAvailable(),
  );

  const notify = useCallback(
    /** @param {NotificationOptions} options */
    ({ title, body, type = 'info', silent = false }: any) => {
      // Only notify when the app window is in the background
      if (document.hasFocus()) return;

      sendDesktopNotification({ title, body, type, silent });
    },
    [],
  );

  return { notify, isSupported: supported.current };
}
