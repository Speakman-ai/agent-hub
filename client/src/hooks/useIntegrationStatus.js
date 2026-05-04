import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * useIntegrationStatus — fetch + poll the status of a single per-user
 * integration row.
 *
 * Lifecycle
 * ---------
 *  - On mount, runs `fetchStatus()` once to seed `data`.
 *  - When `polling === true`, re-fetches every `pollIntervalMs` (default
 *    2000ms) until either:
 *      • `data.status === 'CONNECTED'` (the OAuth handshake landed)
 *      • `pollTimeoutMs` elapses (default 5 minutes — Nango sessions are
 *        typically short, anything longer is almost certainly a stuck
 *        popup the user closed without completing).
 *      • The caller flips `polling` back to false.
 *  - The hook tolerates 404 responses (`status: null` is the steady
 *    state when the user has never connected this app) and surfaces
 *    other fetch failures via `error`.
 *
 * The hook intentionally accepts an injectable `fetcher` so unit tests
 * don't need to mock global `fetch`. The default implementation calls
 * `api.getUserIntegration(userId, app)`.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.app
 * @param {boolean} params.polling
 * @param {(userId: string, app: string) => Promise<object|null>} [params.fetcher]
 * @param {number} [params.pollIntervalMs]
 * @param {number} [params.pollTimeoutMs]
 * @param {() => void} [params.onTimeout]
 * @param {(row: object) => void} [params.onConnected]
 */
export function useIntegrationStatus({
  userId,
  app,
  polling,
  fetcher,
  pollIntervalMs = 2000,
  pollTimeoutMs = 5 * 60 * 1000,
  onTimeout,
  onConnected,
}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [timedOut, setTimedOut] = useState(false);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const refetch = useCallback(async () => {
    if (!userId || !app) return null;
    setError(null);
    try {
      const row = await fetcherRef.current?.(userId, app);
      setData(row ?? null);
      return row ?? null;
    } catch (err) {
      setError(err?.message || String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [userId, app]);

  // Initial fetch + reset on identity change.
  useEffect(() => {
    setLoading(true);
    setTimedOut(false);
    void refetch();
  }, [refetch]);

  // Polling loop — only runs while `polling === true` AND we haven't
  // already seen CONNECTED. The interval clears as soon as either
  // condition flips.
  useEffect(() => {
    if (!polling) return undefined;
    if (data?.status === 'CONNECTED') return undefined;

    const startedAt = Date.now();
    const intervalId = setInterval(async () => {
      if (Date.now() - startedAt > pollTimeoutMs) {
        clearInterval(intervalId);
        setTimedOut(true);
        onTimeoutRef.current?.();
        return;
      }
      const row = await refetch();
      if (row?.status === 'CONNECTED') {
        clearInterval(intervalId);
        onConnectedRef.current?.(row);
      }
    }, pollIntervalMs);

    return () => clearInterval(intervalId);
  }, [polling, data?.status, pollIntervalMs, pollTimeoutMs, refetch]);

  return { data, error, loading, timedOut, refetch };
}
