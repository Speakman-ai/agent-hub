import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Linking,
  Switch,
} from 'react-native';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import HubIcon from '../components/HubIcon';
import {
  ReminderListState,
  formatReminderTime,
  groupReminders,
  parseLocalDateTime,
  reminderCalendarLabel,
  REMINDER_PRESETS,
  type ReminderPreset,
  type ReminderWire,
} from '@shared/utils/reminders';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A quick pick, resolved to its absolute time at the moment it was tapped. */
export interface PickedPreset {
  id: ReminderPreset['id'];
  at: string;
}

export function pickPreset(preset: ReminderPreset, now: Date = new Date()): PickedPreset {
  return { id: preset.id, at: preset.at(now).toISOString() };
}

/**
 * The time a new reminder would fire at. Typed text wins over a preset and
 * must be a real local time on its own (strict parse, no rollover); a picked
 * preset is the absolute time captured when it was tapped, so waiting before
 * tapping Add doesn't shift it.
 */
export function resolveRemindAt(custom: string, picked: PickedPreset | null): string | null {
  if (custom.trim()) return parseLocalDateTime(custom);
  return picked?.at ?? null;
}

/**
 * Hub → Reminders tab, the mobile peer of the web `RemindersPage`. Reminders
 * come from the user or from agents in their sessions and fire into the
 * notification inbox. Live updates arrive through `subscribeReminderUpdates`,
 * ordered against list loads by `ReminderListState`.
 */
export default function RemindersScreen({ navigation }: { navigation?: any }) {
  const { subscribeReminderUpdates, setActiveAgentId, setActiveSessionId } = useApp();
  const listState = useRef(new ReminderListState()).current;
  const [reminders, setReminders] = useState<ReminderWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<PickedPreset | null>(null);
  const [custom, setCustom] = useState('');
  const [toCalendar, setToCalendar] = useState(true);
  const [adding, setAdding] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    setLoading(true);
    const token = listState.beginLoad();
    try {
      const res = await api.listReminders('all');
      setReminders((cur) => listState.finishLoad(token, res.reminders, cur) ?? cur);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [listState]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!subscribeReminderUpdates) return undefined;
    return subscribeReminderUpdates((event: any) => {
      setReminders((prev) => listState.apply(prev, event));
    });
  }, [subscribeReminderUpdates, listState]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(t);
  }, []);

  const groups = useMemo(() => groupReminders(reminders), [reminders]);
  const remindAt = resolveRemindAt(custom, picked);
  const customInvalid = !!custom.trim() && !remindAt;

  const upsert = (r: ReminderWire) =>
    setReminders((prev) => listState.apply(prev, { reminderId: r.id, reminder: r }));

  const add = async () => {
    if (!title.trim() || !remindAt) return;
    setAdding(true);
    try {
      const res = await api.createReminder({
        title: title.trim(),
        remindAt,
        calendar: toCalendar ? 'auto' : 'none',
      });
      upsert(res.reminder);
      setTitle('');
      setPicked(null);
      setCustom('');
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAdding(false);
    }
  };

  const mutate = async (fn: () => Promise<{ reminder: ReminderWire }>) => {
    try {
      upsert((await fn()).reminder);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (r: ReminderWire) => {
    try {
      await api.deleteReminder(r.id);
      setReminders((prev) => listState.apply(prev, { action: 'deleted', reminderId: r.id }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const openSession = (r: ReminderWire) => {
    if (!r.sessionId || !r.agentId) return;
    setActiveAgentId(r.agentId);
    setActiveSessionId(r.sessionId);
    navigation?.navigate?.('Chat');
  };

  const renderRow = (r: ReminderWire) => {
    const due = r.status === 'fired';
    const calendarLabel = reminderCalendarLabel(r);
    return (
      <View key={r.id} testID={`reminder-row-${r.id}`} style={[styles.row, due && styles.rowDue]}>
        <View style={styles.rowTop}>
          <Text style={[styles.rowTitle, r.status === 'dismissed' && styles.rowTitleDone]}>
            {r.title}
          </Text>
          <TouchableOpacity
            testID={`reminder-delete-${r.id}`}
            accessibilityLabel={`Delete reminder ${r.title}`}
            onPress={() => void remove(r)}
            style={styles.iconButton}
          >
            <HubIcon name="Trash2" size={14} color={colors.gray500} />
          </TouchableOpacity>
        </View>
        {r.notes ? <Text style={styles.notes}>{r.notes}</Text> : null}
        <View style={styles.meta}>
          <Text style={styles.metaText}>{formatReminderTime(r.remindAt, now)}</Text>
          {r.createdBy === 'agent' ? <Text style={styles.agentText}>Set by an agent</Text> : null}
          {r.sessionId && r.agentId ? (
            <TouchableOpacity onPress={() => openSession(r)}>
              <Text style={styles.linkText}>Open session</Text>
            </TouchableOpacity>
          ) : null}
          {calendarLabel ? (
            <TouchableOpacity
              disabled={!r.calendar.eventUrl}
              onPress={() => r.calendar.eventUrl && void Linking.openURL(r.calendar.eventUrl)}
            >
              <Text style={r.calendar.status === 'synced' ? styles.calendarOk : styles.metaText}>
                {calendarLabel}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {due ? (
          <View style={styles.chips}>
            {REMINDER_PRESETS.map((p) => (
              <TouchableOpacity
                key={p.id}
                testID={`reminder-snooze-${r.id}-${p.id}`}
                onPress={() =>
                  void mutate(() =>
                    api.updateReminder(r.id, { remindAt: p.at(new Date()).toISOString() }),
                  )
                }
                style={styles.chip}
              >
                <Text style={styles.chipText}>{p.label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              testID={`reminder-dismiss-${r.id}`}
              onPress={() => void mutate(() => api.updateReminder(r.id, { status: 'dismissed' }))}
              style={[styles.chip, styles.doneChip]}
            >
              <Text style={[styles.chipText, styles.doneChipText]}>Done</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="reminders-screen"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
    >
      <Text style={styles.subtitle}>
        Set by you or your agents. Due reminders show up in notifications.
      </Text>

      <View style={styles.form}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Remind me to…"
          placeholderTextColor={colors.gray600}
          testID="reminder-new-title"
          style={styles.input}
        />
        <View style={styles.chips}>
          {REMINDER_PRESETS.map((p) => (
            <TouchableOpacity
              key={p.id}
              testID={`reminder-preset-${p.id}`}
              onPress={() => {
                setPicked(pickPreset(p));
                setCustom('');
              }}
              style={[styles.chip, picked?.id === p.id && !custom && styles.chipActive]}
            >
              <Text style={styles.chipText}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput
          value={custom}
          onChangeText={setCustom}
          placeholder="Or a time: 2026-10-17 09:00"
          placeholderTextColor={colors.gray600}
          testID="reminder-new-when"
          style={styles.input}
        />
        {customInvalid ? (
          <Text style={styles.error} testID="reminder-new-when-invalid">
            Not a valid time. Use YYYY-MM-DD HH:mm.
          </Text>
        ) : remindAt ? (
          <Text style={styles.metaText} testID="reminder-new-when-preview">
            Fires {formatReminderTime(remindAt, now)}
          </Text>
        ) : null}
        <View style={styles.formFooter}>
          <View style={styles.switchRow}>
            <Switch
              value={toCalendar}
              onValueChange={setToCalendar}
              testID="reminder-new-calendar"
            />
            <Text style={styles.metaText}>Add to Google Calendar</Text>
          </View>
          <TouchableOpacity
            testID="reminder-add"
            disabled={adding || !title.trim() || !remindAt}
            onPress={() => void add()}
            style={[styles.addButton, (adding || !title.trim() || !remindAt) && styles.disabled]}
          >
            <Text style={styles.addText}>Add</Text>
          </TouchableOpacity>
        </View>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!loading && groups.due.length === 0 && groups.upcoming.length === 0 && !showDismissed ? (
        <Text style={styles.empty} testID="reminders-empty">
          No reminders. Add one above, or ask an agent to remind you.
        </Text>
      ) : null}
      {groups.due.length > 0 ? (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, styles.dueTitle]}>Due ({groups.due.length})</Text>
          {groups.due.map(renderRow)}
        </View>
      ) : null}
      {groups.upcoming.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Upcoming ({groups.upcoming.length})</Text>
          {groups.upcoming.map(renderRow)}
        </View>
      ) : null}
      {showDismissed && groups.dismissed.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Done ({groups.dismissed.length})</Text>
          {groups.dismissed.map(renderRow)}
        </View>
      ) : null}
      {groups.dismissed.length > 0 ? (
        <TouchableOpacity
          testID="reminders-toggle-dismissed"
          onPress={() => setShowDismissed((v) => !v)}
        >
          <Text style={styles.metaText}>
            {showDismissed ? 'Hide done' : `Show done (${groups.dismissed.length})`}
          </Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  subtitle: { color: colors.gray500, fontSize: 12 },
  form: { gap: 8 },
  input: {
    backgroundColor: colors.gray900,
    borderColor: colors.gray800,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.white,
    fontSize: 14,
  },
  formFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addButton: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 8,
  },
  addText: { color: colors.white, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  error: { color: colors.red400, fontSize: 13 },
  empty: { color: colors.gray500, fontSize: 13, textAlign: 'center', paddingVertical: 32 },
  section: { gap: 8 },
  sectionTitle: {
    color: colors.gray400,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  dueTitle: { color: colors.amber400 },
  row: {
    backgroundColor: colors.gray900,
    borderColor: colors.gray800,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  rowDue: { borderColor: colors.amber400, backgroundColor: colors.amber900_40 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  rowTitle: { flex: 1, color: colors.white, fontSize: 14 },
  rowTitleDone: { color: colors.gray500, textDecorationLine: 'line-through' },
  iconButton: { padding: 4 },
  notes: { color: colors.gray400, fontSize: 12 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metaText: { color: colors.gray500, fontSize: 11 },
  agentText: { color: colors.sky400, fontSize: 11 },
  linkText: { color: colors.blue400, fontSize: 11 },
  calendarOk: { color: colors.emerald400, fontSize: 11 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip: {
    backgroundColor: colors.gray800,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipActive: { backgroundColor: colors.blue700 },
  chipText: { color: colors.gray200, fontSize: 11 },
  doneChip: { backgroundColor: colors.amber400 },
  doneChipText: { color: colors.gray950, fontWeight: '600' },
});
