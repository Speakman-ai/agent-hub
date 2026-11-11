import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AppState, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  activeSessionPollers,
  EMPTY_POLLER_BANNER,
  pollerBannerReducer,
  pollerBannerSummary,
  SESSION_POLLER_REFRESH_MS,
  type SessionPoller,
} from '@shared/utils/sessionPoller';

/**
 * Running pollers for the open session, pinned above the transcript with a
 * Cancel button. Mobile has no WS bridge for pollers, so it re-reads on an
 * interval and when the app returns to the foreground; a poller started from
 * a card (or another device) shows up within one refresh.
 */
export default function SessionPollerBanner({ sessionId }: { sessionId: string | null }) {
  const [state, dispatch] = useReducer(pollerBannerReducer, EMPTY_POLLER_BANNER);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState('');
  // One counter orders every write and list request (see pollerBannerReducer).
  const stamp = useRef(0);
  const current = useRef(sessionId);
  current.current = sessionId;

  const load = useCallback(() => {
    const sid = sessionId;
    if (!sid) return;
    const mine = ++stamp.current;
    api
      .listSessionPollers(sid)
      .then((body: any) => {
        if (current.current !== sid) return;
        const list: SessionPoller[] = Array.isArray(body?.pollers) ? body.pollers : [];
        dispatch({ type: 'list', sessionId: sid, pollers: list, stamp: mine });
      })
      // A failed read changes nothing; the interval retries.
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    setError('');
    if (!sessionId) return;
    load();
    const timer = setInterval(load, SESSION_POLLER_REFRESH_MS);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') load();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [sessionId, load]);

  const cancel = async (poller: SessionPoller) => {
    const sid = sessionId;
    if (!sid) return;
    setStopping(poller.id);
    setError('');
    try {
      const body: any = await api.stopSessionPoller(sid, poller.id);
      if (body?.poller && current.current === sid) {
        dispatch({ type: 'write', sessionId: sid, poller: body.poller, stamp: ++stamp.current });
      }
    } catch (err: any) {
      setError(err?.message || 'Could not cancel the poller.');
    } finally {
      setStopping(null);
    }
  };

  const active =
    sessionId && state.sessionId === sessionId ? activeSessionPollers(state.pollers) : [];
  if (active.length === 0) return null;

  return (
    <View style={styles.banner} testID="session-poller-banner">
      {active.map((p) => (
        <View key={p.id} style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={1}>
              Poller running: {p.task}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {pollerBannerSummary(p)}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.cancel}
            onPress={() => cancel(p)}
            disabled={stopping === p.id}
            accessibilityRole="button"
            accessibilityLabel="Cancel poller"
          >
            <Text style={styles.cancelText}>{stopping === p.id ? 'Cancelling...' : 'Cancel'}</Text>
          </TouchableOpacity>
        </View>
      ))}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderBottomWidth: 1,
    borderBottomColor: colors.blue700,
    backgroundColor: colors.sky500_15,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.white, fontSize: 13, fontWeight: '600' },
  meta: { color: colors.gray300, fontSize: 11 },
  cancel: {
    borderWidth: 1,
    borderColor: colors.blue700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  cancelText: { color: colors.sky300, fontSize: 12, fontWeight: '600' },
  error: { color: colors.red400, fontSize: 11 },
});
