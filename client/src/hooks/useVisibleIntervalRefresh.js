import { useEffect, useRef } from 'react';

/**
 * Runs `onRefresh` on a timer while the document is visible, clears the timer
 * when hidden (saves work when the window is in the background), and optionally
 * runs once when returning to visible after idle (missed WebSocket catch-up).
 *
 * Does not fire `onRefresh` on mount — callers already own initial load — so
 * this is strictly for long-idle / background-tab reconciliation.
 *
 * @param {() => void | Promise<void>} onRefresh
 * @param {number} intervalMs
 * @param {{ enabled?: boolean; runOnVisible?: boolean }} [options]
 */
export function useVisibleIntervalRefresh(onRefresh, intervalMs, options = {}) {
  const { enabled = true, runOnVisible = true } = options;
  const cbRef = useRef(onRefresh);
  cbRef.current = onRefresh;

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') {
      return undefined;
    }

    let intervalId = null;

    const clearTimer = () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const armTimer = () => {
      clearTimer();
      if (document.visibilityState !== 'visible') return;
      intervalId = window.setInterval(() => {
        void cbRef.current?.();
      }, intervalMs);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (runOnVisible) void cbRef.current?.();
        armTimer();
      } else {
        clearTimer();
      }
    };

    armTimer();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimer();
    };
  }, [enabled, intervalMs, runOnVisible]);
}
