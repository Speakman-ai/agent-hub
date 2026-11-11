import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AppState,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Switch,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  checkPollerForm,
  expectedPollerRuns,
  formatPollerClock,
  formatPollerMinutes,
  EMPTY_POLLER_BANNER,
  pollerBannerReducer,
  SESSION_POLLER_REFRESH_MS,
  parsePollerAnchor,
  planPollerSchedule,
  pollerStartDurationMinutes,
  shouldReconcilePoller,
  type PollerProposal,
  type SessionPoller,
} from '@shared/utils/sessionPoller';

function statusLine(poller: SessionPoller): string {
  const runs = `${poller.runCount} run${poller.runCount === 1 ? '' : 's'}`;
  if (poller.status === 'completed') return `Finished after ${runs}`;
  if (poller.status === 'cancelled') return `Stopped after ${runs}`;
  return `Running · ${runs} so far`;
}

export default function SessionPollerCard({
  sessionId,
  proposal,
  proposedAt,
}: {
  sessionId: string;
  proposal: PollerProposal;
  /** `created_at` of the message carrying the block; anchors relative end times. */
  proposedAt?: string | null;
}) {
  // The end time the user named is fixed by when they asked, not by when this
  // card renders, so a reopened session still targets the same moment.
  const [schedule] = useState(() =>
    planPollerSchedule(proposal, {
      anchor: parsePollerAnchor(proposedAt) ?? new Date(),
      now: new Date(),
    }),
  );
  const { deadline } = schedule;
  const [task, setTask] = useState(proposal.task);
  const [interval, setIntervalText] = useState(
    proposal.intervalMinutes ? String(proposal.intervalMinutes) : '',
  );
  const [duration, setDuration] = useState(() =>
    schedule.initialDurationMinutes ? String(schedule.initialDurationMinutes) : '',
  );
  const [durationEdited, setDurationEdited] = useState(false);
  const [notifyEachRun, setNotifyEachRun] = useState(proposal.notifyEachRun);
  const [notifyOnComplete, setNotifyOnComplete] = useState(proposal.notifyOnComplete);
  // List refreshes, pushes and Start/Stop results all write this; the shared
  // reducer stops a slower refresh from undoing a newer write.
  const [pollers, dispatch] = useReducer(pollerBannerReducer, EMPTY_POLLER_BANNER);
  const stamp = useRef(0);
  const poller =
    (pollers.sessionId === sessionId &&
      pollers.pollers.find((p) => p.pollerId === proposal.pollerId)) ||
    null;
  const setPoller = useCallback(
    (next: SessionPoller | null | undefined) => {
      if (next) dispatch({ type: 'write', sessionId, poller: next, stamp: ++stamp.current });
    },
    [sessionId],
  );
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    if (!sessionId) return;
    const mine = ++stamp.current;
    api
      .listSessionPollers(sessionId)
      .then((body: any) => {
        const list: SessionPoller[] = Array.isArray(body?.pollers) ? body.pollers : [];
        dispatch({ type: 'list', sessionId, pollers: list, stamp: mine });
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isActive = poller?.status === 'active';
  // Mobile has no WS bridge for pollers: re-read while unfinished (including
  // before one exists, since it may be started on another device) and when
  // the app returns to the foreground.
  const reconcile = shouldReconcilePoller(poller);
  useEffect(() => {
    if (!reconcile) return;
    const timer = setInterval(refresh, SESSION_POLLER_REFRESH_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [reconcile, refresh]);

  const check = useMemo(
    () => checkPollerForm({ task, interval, duration }),
    [task, interval, duration],
  );
  const canStart = loaded && !poller && Object.keys(check.errors).length === 0 && !saving;

  const start = async () => {
    if (!canStart || check.intervalMinutes === null || check.durationMinutes === null) return;
    const durationMinutes = pollerStartDurationMinutes({
      deadline,
      durationEdited,
      formMinutes: check.durationMinutes,
      now: new Date(),
    });
    if (durationMinutes === null) {
      setError('That end time has passed. Set a duration to start.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body: any = await api.startSessionPoller(sessionId, {
        pollerId: proposal.pollerId,
        task: task.trim(),
        intervalMinutes: check.intervalMinutes,
        durationMinutes,
        notifyEachRun,
        notifyOnComplete,
      });
      setPoller(body?.poller);
    } catch (err: any) {
      setError(err?.message || 'Could not start the poller.');
    } finally {
      setSaving(false);
    }
  };

  const stop = async () => {
    if (!poller) return;
    setSaving(true);
    setError('');
    try {
      const body: any = await api.stopSessionPoller(sessionId, poller.id);
      setPoller(body?.poller);
    } catch (err: any) {
      setError(err?.message || 'Could not stop the poller.');
    } finally {
      setSaving(false);
    }
  };

  const deadlineMissed = schedule.deadlinePassed && !durationEdited && deadline !== null;
  const endsPreview =
    deadline && !durationEdited
      ? formatPollerClock(deadline)
      : check.durationMinutes !== null
        ? formatPollerClock(new Date(Date.now() + check.durationMinutes * 60_000))
        : null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.headerText}>{poller ? statusLine(poller) : 'Set up a poller'}</Text>
      </View>
      {poller ? (
        <View style={styles.body}>
          <Text style={styles.task}>{poller.task}</Text>
          <Text style={styles.meta}>
            Every {formatPollerMinutes(poller.intervalMinutes)} for{' '}
            {formatPollerMinutes(poller.durationMinutes)}
            {isActive && poller.nextRunAt
              ? ` · next check ${formatPollerClock(new Date(poller.nextRunAt))}`
              : ''}
            {isActive ? ` · ends ${formatPollerClock(new Date(poller.endsAt))}` : ''}
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {isActive && (
            <TouchableOpacity
              style={styles.secondary}
              onPress={stop}
              disabled={saving}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryText}>{saving ? 'Stopping...' : 'Stop'}</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <View style={styles.body}>
          <View style={styles.field}>
            <Text style={styles.label}>Task</Text>
            <TextInput
              value={task}
              onChangeText={setTask}
              multiline
              editable={!saving}
              style={[styles.input, styles.multiline]}
            />
            {check.errors.task ? <Text style={styles.error}>{check.errors.task}</Text> : null}
          </View>
          <View style={styles.row}>
            <View style={[styles.field, styles.flex]}>
              <Text style={styles.label}>Interval (minutes)</Text>
              <TextInput
                accessibilityLabel="Interval in minutes"
                value={interval}
                onChangeText={setIntervalText}
                keyboardType="number-pad"
                editable={!saving}
                style={styles.input}
              />
              {check.errors.interval ? (
                <Text style={styles.error}>{check.errors.interval}</Text>
              ) : null}
            </View>
            <View style={[styles.field, styles.flex]}>
              <Text style={styles.label}>Duration (minutes)</Text>
              <TextInput
                accessibilityLabel="Duration in minutes"
                value={duration}
                onChangeText={(text) => {
                  setDuration(text);
                  setDurationEdited(true);
                }}
                keyboardType="number-pad"
                editable={!saving}
                style={styles.input}
              />
              {deadlineMissed ? (
                <Text style={styles.error}>
                  The requested end ({formatPollerClock(deadline)}) has passed. Set a duration.
                </Text>
              ) : check.errors.duration ? (
                <Text style={styles.error}>{check.errors.duration}</Text>
              ) : endsPreview ? (
                <Text style={styles.hint}>Ends around {endsPreview}</Text>
              ) : null}
            </View>
          </View>
          <View style={styles.toggleRow}>
            <Text style={styles.label}>Notify me after every run</Text>
            <Switch value={notifyEachRun} onValueChange={setNotifyEachRun} disabled={saving} />
          </View>
          <View style={styles.toggleRow}>
            <Text style={styles.label}>Notify me when it finishes</Text>
            <Switch
              value={notifyOnComplete}
              onValueChange={setNotifyOnComplete}
              disabled={saving}
            />
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.footer}>
            <Text style={styles.hint}>
              {check.intervalMinutes && check.durationMinutes
                ? `About ${expectedPollerRuns(check.intervalMinutes, check.durationMinutes)} checks, first one now`
                : ''}
            </Text>
            <TouchableOpacity
              style={[styles.submit, !canStart && styles.submitDisabled]}
              onPress={start}
              disabled={!canStart}
              accessibilityRole="button"
            >
              <Text style={styles.submitText}>{saving ? 'Starting...' : 'Start'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.blue700,
    backgroundColor: colors.sky500_15,
    borderRadius: 10,
    overflow: 'hidden',
    marginVertical: 6,
  },
  header: {
    borderBottomWidth: 1,
    borderBottomColor: colors.blue700,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerText: { color: colors.sky300, fontSize: 12, fontWeight: '600' },
  body: { padding: 12, gap: 10 },
  task: { color: colors.white, fontSize: 14, lineHeight: 19 },
  meta: { color: colors.gray300, fontSize: 12, lineHeight: 17 },
  row: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  field: { gap: 4 },
  label: { color: colors.gray300, fontSize: 12 },
  hint: { color: colors.gray400, fontSize: 11, flexShrink: 1 },
  error: { color: colors.red400, fontSize: 11 },
  input: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    color: colors.white,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  multiline: { minHeight: 56, textAlignVertical: 'top' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  submit: {
    backgroundColor: colors.blue600,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  submitDisabled: { opacity: 0.45 },
  submitText: { color: colors.white, fontSize: 12, fontWeight: '600' },
  secondary: {
    alignSelf: 'flex-end',
    borderWidth: 1,
    borderColor: colors.blue700,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  secondaryText: { color: colors.sky300, fontSize: 12, fontWeight: '600' },
});
