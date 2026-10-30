/**
 * "Run QA Tests" on the mobile finalize bar (mirrors the web
 * `finalize/SessionQaControl.tsx`): a checkbox before the session's work
 * merges, a button after, and a link to the QA plan once one exists.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AppIcon from './AppIcon';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { useApp } from '../context/AppContext';
import { qaSessionControl, type QaSessionStateWire } from '@shared/utils/qaSessionRequest';

export default function SessionQaControl({
  sessionId,
  sessionState,
  onOpenPlan,
  onError,
}: {
  sessionId: string;
  /** The session's resolved state; a change to `merged` refetches. */
  sessionState?: string | null;
  onOpenPlan?: (planId: string) => void;
  onError?: (message: string) => void;
}) {
  const { subscribeQaUpdates } = useApp();
  // Results are tagged with the session they belong to, so a GET or mutation
  // that resolves after the user switched sessions never shows (or acts on)
  // the previous session's request.
  const [loaded, setLoaded] = useState<{ sessionId: string; data: QaSessionStateWire } | null>(
    null,
  );
  const [pendingFor, setPendingFor] = useState<string | null>(null);
  const latest = useRef(0);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const state = loaded?.sessionId === sessionId ? loaded.data : null;
  const pending = pendingFor === sessionId;

  // Every state the control shows comes from this sequenced GET: the last GET
  // started wins, so an older response (including a mutation's) can never
  // overwrite a newer one.
  const load = useCallback((): Promise<void> => {
    const seq = ++latest.current;
    return api
      .getSessionQaRequest(sessionId)
      .then((s) => {
        if (seq === latest.current) setLoaded({ sessionId, data: s });
      })
      .catch(() => {
        if (seq === latest.current) setLoaded(null);
      });
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load, sessionState]);

  useEffect(() => {
    if (!subscribeQaUpdates) return undefined;
    return subscribeQaUpdates((e: { sessionId?: string | null; action?: string | null }) => {
      if (
        e.sessionId === sessionId ||
        e.action === 'environments_updated' ||
        e.action === 'settings_updated' ||
        e.action === 'pr_merged'
      ) {
        load();
      }
    });
  }, [subscribeQaUpdates, sessionId, load]);

  if (!state) return null;
  const control = qaSessionControl(state);
  const act = async (fn: () => Promise<QaSessionStateWire>) => {
    const target = sessionId;
    setPendingFor(target);
    try {
      await fn();
      // The mutation's own response is a snapshot from before any follow-up
      // transition (drafting finishing, a launch) landed, so it is not shown;
      // a fresh GET is, ordered with the event-driven ones.
      if (currentSession.current === target) await load();
    } catch (err: any) {
      if (currentSession.current !== target) return;
      onError?.(err?.message || 'Could not update QA tests');
      await load();
    } finally {
      setPendingFor((p) => (p === target ? null : p));
    }
  };
  const disabled = pending || !control.enabled;
  const failed = state.request?.status === 'failed';

  return (
    <View style={styles.wrap} testID="session-qa-control">
      {control.kind === 'checkbox' ? (
        <TouchableOpacity
          testID="session-qa-checkbox"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: control.checked, disabled }}
          accessibilityLabel="Run QA Tests"
          accessibilityHint={control.title}
          disabled={disabled}
          onPress={() => void act(() => api.setSessionQaRequestArmed(sessionId, !control.checked))}
          style={[styles.btn, disabled && styles.disabled]}
        >
          <AppIcon
            name={control.checked ? 'checkbox' : 'square-outline'}
            size={12}
            color={colors.teal300}
          />
          <Text style={styles.text}>Run QA Tests</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          testID="session-qa-run-button"
          accessibilityRole="button"
          accessibilityLabel="Run QA Tests"
          accessibilityHint={control.title}
          disabled={disabled}
          onPress={() => void act(() => api.runSessionQaRequest(sessionId))}
          style={[styles.btn, disabled && styles.disabled]}
        >
          {pending || control.busy ? (
            <ActivityIndicator size="small" color={colors.teal300} />
          ) : (
            <AppIcon name="clipboard-check-outline" size={12} color={colors.teal300} />
          )}
          <Text style={styles.text}>Run QA Tests</Text>
        </TouchableOpacity>
      )}
      {control.planId ? (
        <TouchableOpacity
          testID="session-qa-plan-link"
          accessibilityRole="link"
          onPress={() => onOpenPlan?.(control.planId!)}
          style={styles.link}
        >
          <Text style={styles.linkText}>View QA test</Text>
          <AppIcon name="open-outline" size={11} color={colors.sky300} />
        </TouchableOpacity>
      ) : null}
      {control.status ? (
        <Text
          testID="session-qa-status"
          numberOfLines={1}
          style={[styles.status, failed && styles.statusFailed]}
        >
          {control.status}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.teal500,
    backgroundColor: colors.teal900_30,
  },
  text: { color: colors.teal300, fontSize: 10, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  linkText: { color: colors.sky300, fontSize: 10, textDecorationLine: 'underline' },
  status: { color: colors.gray400, fontSize: 10, maxWidth: 160 },
  statusFailed: { color: colors.red400 },
});
