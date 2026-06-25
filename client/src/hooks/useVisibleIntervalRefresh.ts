import { useEffect, useRef } from 'react';
import { startVisibleIntervalRefresh } from '@shared/utils/visibleIntervalRefresh';

/**
 * Runs `onRefresh` on a timer while the document is visible, clears the timer
 * when hidden (saves work when the window is in the background), and optionally
 * runs once when returning to visible after idle (missed WebSocket catch-up).
 *
 * Does not fire `onRefresh` on mount — callers already own initial load — so
 * this is strictly for long-idle / background-tab reconciliation.
 *
 * Refreshes are serialized by an in-flight guard (see
 * `@shared/utils/visibleIntervalRefresh`): while a refresh promise is pending,
 * ticks are skipped rather than stacked, so a slow poll can never overlap the
 * next tick or let a stale response overwrite fresher data.
 *
 * @param {() => void | Promise<void>} onRefresh
 * @param {number} intervalMs
 * @param {{ enabled?: boolean; runOnVisible?: boolean }} [options]
 */
export function useVisibleIntervalRefresh(onRefresh: any, intervalMs: any, options: any = {}) {
  const { enabled = true, runOnVisible = true } = options;
  const cbRef = useRef(onRefresh);
  cbRef.current = onRefresh;

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') {
      return undefined;
    }
    return startVisibleIntervalRefresh({
      onRefresh: () => cbRef.current?.(),
      intervalMs,
      runOnVisible,
      isVisible: () => document.visibilityState === 'visible',
      subscribeVisibility: (cb: any) => {
        const handler = () => cb(document.visibilityState === 'visible');
        document.addEventListener('visibilitychange', handler);
        return () => document.removeEventListener('visibilitychange', handler);
      },
    });
  }, [enabled, intervalMs, runOnVisible]);
}
