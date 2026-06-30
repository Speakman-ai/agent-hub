import { useCallback, useEffect, useState } from 'react';
import { api } from '../utils/api';
import type { GoogleStatusLike } from '../utils/googleSurface';

/**
 * Fetches the calling user's Google connection status (`/api/auth/google/status`).
 *
 * Used to connection-gate the global Google Workspace surfaces (Calendar today;
 * Gmail / Sheets / Drive later). Best-effort: failures resolve to a
 * disconnected status so navigation simply hides the surface rather than
 * throwing. Re-fetches whenever `nonce` changes so callers can refresh after an
 * OAuth round-trip.
 */
export function useGoogleStatus(nonce: number = 0) {
  const [status, setStatus] = useState<GoogleStatusLike>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.getGoogleStatus();
      setStatus(next);
      return next;
    } catch {
      setStatus({ connected: false });
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getGoogleStatus()
      .then((next: any) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus({ connected: false });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { status, loading, refresh };
}
