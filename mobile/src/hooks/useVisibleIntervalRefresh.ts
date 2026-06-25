import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { startVisibleIntervalRefresh } from '@shared/utils/visibleIntervalRefresh';

/**
 * Mobile mirror of the web `useVisibleIntervalRefresh` hook.
 *
 * Runs `onRefresh` on a timer while the app is in the foreground, clears the
 * timer when it goes to the background (saves work + battery), and optionally
 * runs once when returning to the foreground after idle (missed-update catch-up).
 *
 * Does not fire `onRefresh` on mount — callers already own initial load — so
 * this is strictly for foreground polling / background-idle reconciliation.
 *
 * Shares the framework-free core in `@shared/utils/visibleIntervalRefresh`, so
 * the in-flight guard (no overlapping/stacked polls, no stale-over-fresh
 * overwrite) and the timing semantics are identical to the web hook.
 *
 * @param {() => void | Promise<void>} onRefresh
 * @param {number} intervalMs
 * @param {{ enabled?: boolean; runOnActive?: boolean }} [options]
 */
export function useVisibleIntervalRefresh(onRefresh: any, intervalMs: any, options: any = {}) {
  const { enabled = true, runOnActive = true } = options;
  const cbRef = useRef(onRefresh);
  cbRef.current = onRefresh;

  useEffect(() => {
    if (!enabled) return undefined;
    return startVisibleIntervalRefresh({
      onRefresh: () => cbRef.current?.(),
      intervalMs,
      runOnVisible: runOnActive,
      isVisible: () => AppState.currentState === 'active',
      subscribeVisibility: (cb: any) => {
        const sub = AppState.addEventListener('change', (next: any) => cb(next === 'active'));
        return () => sub.remove();
      },
    });
  }, [enabled, intervalMs, runOnActive]);
}
