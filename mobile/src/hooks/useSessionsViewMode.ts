import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSessionsViewMode, type SessionsViewMode } from '@shared/utils/sessionState';

export const SESSIONS_VIEW_STORAGE_KEY = 'dashboard.activeSessionsView';

/**
 * Dashboard Active sessions List/Board choice, persisted per device. The
 * stored value hydrates asynchronously; once the user picks a mode the
 * hydration result is ignored so a slow read can't undo their choice.
 */
export function useSessionsViewMode(): [SessionsViewMode, (mode: SessionsViewMode) => void] {
  const [mode, setMode] = useState<SessionsViewMode>('list');
  const userPickedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(SESSIONS_VIEW_STORAGE_KEY)
      .then((raw) => {
        if (!cancelled && !userPickedRef.current && isSessionsViewMode(raw)) setMode(raw);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const change = useCallback((next: SessionsViewMode) => {
    userPickedRef.current = true;
    setMode(next);
    AsyncStorage.setItem(SESSIONS_VIEW_STORAGE_KEY, next).catch(() => {});
  }, []);
  return [mode, change];
}
