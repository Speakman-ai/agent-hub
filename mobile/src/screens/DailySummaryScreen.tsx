import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Switch,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import HubIcon from '../components/HubIcon';
import { useApp } from '../context/AppContext';
import { dispatchDailySummaryHref } from '@shared/utils/dailySummaryLinks';

function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function formatGeneratedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Hub Daily Summary — today / yesterday. Visiting this tab only
 * reads; Generate / Regenererate is what spawns a model.
 */
export default function DailySummaryScreen({
  navigation,
  setTab,
}: {
  navigation?: any;
  setTab?: (tab: 'assistant' | 'todos') => void;
} = {}) {
  const { setActiveAgentId, setActiveSessionId } = useApp();
  const [report, setReport] = useState<{
    markdown: string;
    generatedAt: string;
    engine?: string;
    model?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body: any = await api.getDailySummary({ tz: localTimeZone() });
      setReport(body?.report ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const body: any = await api.generateDailySummary({ tz: localTimeZone() });
      setReport(body?.report ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }, []);

  const onLinkPress = useCallback(
    (url: string) => {
      const handled = dispatchDailySummaryHref(url, {
        onCard: (projectId, cardId) => {
          navigation?.navigate('Kanban', { projectId, cardId });
        },
        onSession: (sessionId, agentId) => {
          if (agentId) setActiveAgentId(agentId);
          setActiveSessionId(sessionId);
          navigation?.navigate('Chat');
        },
        onTodo: () => setTab?.('todos'),
        onProject: (projectId) => {
          navigation?.navigate('Kanban', { projectId });
        },
      });
      return !handled;
    },
    [navigation, setActiveAgentId, setActiveSessionId, setTab],
  );

  const hasToday = !!report?.markdown;
  const actionLabel = hasToday ? 'Regenerate' : 'Generate';

  return (
    <View style={styles.root} testID="daily-summary-screen">
      <View style={styles.toolbar}>
        <HubIcon name="ScrollText" size={16} color={colors.sky400} />
        <Text style={styles.title}>Daily Summary</Text>
        <TouchableOpacity
          onPress={() => void generate()}
          disabled={generating || loading}
          testID="daily-summary-generate"
          style={[styles.button, (generating || loading) && styles.buttonDisabled]}
        >
          {generating ? (
            <ActivityIndicator size="small" color={colors.white} />
          ) : (
            <Text style={styles.buttonLabel}>{actionLabel}</Text>
          )}
        </TouchableOpacity>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
        {loading && !generating ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : hasToday && report ? (
          <View>
            <Text style={styles.meta}>
              Generated {formatGeneratedAt(report.generatedAt)}
              {report.engine ? ` · ${report.engine}` : ''}
              {report.model ? ` / ${report.model}` : ''}
            </Text>
            <Markdown style={markdownStyles as any} onLinkPress={onLinkPress}>
              {report.markdown}
            </Markdown>
          </View>
        ) : (
          <View style={styles.empty} testID="daily-summary-empty">
            <Text style={styles.emptyTitle}>No summary for today yet.</Text>
            <Text style={styles.muted}>
              Generate a report of what you did today, what is running now, and what happened
              yesterday.
            </Text>
          </View>
        )}
        <ScheduleEditor />
      </ScrollView>
    </View>
  );
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_TIME = '09:00';

/**
 * Auto-refresh schedule: one or more local times of day at which the Hub
 * regenerates this summary using the user's own Claude credentials.
 */
function ScheduleEditor() {
  const [enabled, setEnabled] = useState(false);
  const [times, setTimes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeZone = localTimeZone() ?? 'UTC';

  const apply = useCallback((schedule: any) => {
    setEnabled(schedule?.enabled ?? false);
    setTimes(Array.isArray(schedule?.times) ? schedule.times : []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body: any = await api.getDailySummarySchedule();
        if (!cancelled) apply(body?.schedule);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const save = useCallback(
    async (nextEnabled: boolean, nextTimes: string[]) => {
      setSaving(true);
      setError(null);
      try {
        const clean = Array.from(new Set(nextTimes.filter((t) => HHMM_RE.test(t)))).sort();
        const body: any = await api.setDailySummarySchedule({
          enabled: nextEnabled,
          timeZone,
          times: clean,
        });
        apply(body?.schedule);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [apply, timeZone],
  );

  return (
    <View style={styles.schedule} testID="daily-summary-schedule">
      <View style={styles.scheduleHeader}>
        <HubIcon name="Clock" size={14} color={colors.sky400} />
        <Text style={styles.scheduleTitle}>Auto-refresh schedule</Text>
        <Switch
          value={enabled}
          disabled={loading || saving}
          onValueChange={(next) => {
            setEnabled(next);
            void save(next, times);
          }}
          testID="daily-summary-schedule-enabled"
        />
      </View>
      <Text style={styles.muted}>
        Regenerates at each time below (in {timeZone}) using your Claude credentials.
      </Text>
      {loading ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : (
        <View style={styles.scheduleBody}>
          {times.length === 0 ? (
            <Text style={styles.muted}>No times yet. Add one below.</Text>
          ) : (
            times.map((time, idx) => (
              <View key={idx} style={styles.timeRow}>
                <TextInput
                  value={time}
                  placeholder="HH:MM"
                  placeholderTextColor={colors.gray500}
                  editable={!saving}
                  onChangeText={(v) => setTimes((prev) => prev.map((t, i) => (i === idx ? v : t)))}
                  style={styles.timeInput}
                  testID="daily-summary-schedule-time"
                />
                <TouchableOpacity
                  onPress={() => setTimes((prev) => prev.filter((_, i) => i !== idx))}
                  disabled={saving}
                  style={styles.timeRemove}
                >
                  <HubIcon name="Trash2" size={13} color={colors.gray400} />
                </TouchableOpacity>
              </View>
            ))
          )}
          <View style={styles.scheduleActions}>
            <TouchableOpacity
              onPress={() => setTimes((prev) => [...prev, DEFAULT_TIME])}
              disabled={saving}
              style={styles.scheduleButton}
              testID="daily-summary-schedule-add"
            >
              <Text style={styles.scheduleButtonLabel}>Add time</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => void save(enabled, times)}
              disabled={saving}
              style={[styles.scheduleButton, styles.scheduleSave]}
              testID="daily-summary-schedule-save"
            >
              <Text style={styles.scheduleSaveLabel}>{saving ? 'Saving…' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      )}
    </View>
  );
}

const markdownStyles = {
  body: { color: colors.gray200, fontSize: 14, lineHeight: 20 },
  heading2: { color: colors.white, fontSize: 16, fontWeight: '600', marginTop: 12, marginBottom: 6 },
  bullet_list: { marginBottom: 8 },
  list_item: { marginBottom: 4 },
  link: { color: colors.sky400, textDecorationLine: 'underline' },
  code_inline: { backgroundColor: colors.gray800, color: colors.gray200, fontSize: 13 },
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.gray950 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  title: { color: colors.white, fontSize: 16, fontWeight: '600', flex: 1 },
  button: {
    backgroundColor: colors.gray800,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { color: colors.white, fontSize: 12, fontWeight: '600' },
  error: { color: colors.red400, fontSize: 13, paddingHorizontal: 16, marginBottom: 8 },
  muted: { color: colors.gray500, fontSize: 13 },
  scroll: { flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 24 },
  meta: { color: colors.gray500, fontSize: 12, marginBottom: 12 },
  empty: { paddingTop: 32, gap: 6 },
  emptyTitle: { color: colors.gray300, fontSize: 14, fontWeight: '500' },
  schedule: {
    marginTop: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.gray800,
    paddingTop: 16,
    gap: 8,
  },
  scheduleHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  scheduleTitle: { color: colors.white, fontSize: 14, fontWeight: '600', flex: 1 },
  scheduleBody: { gap: 8 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timeInput: {
    backgroundColor: colors.gray800,
    color: colors.gray200,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
    width: 96,
  },
  timeRemove: { padding: 6 },
  scheduleActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  scheduleButton: {
    backgroundColor: colors.gray800,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  scheduleButtonLabel: { color: colors.gray200, fontSize: 12, fontWeight: '600' },
  scheduleSave: { backgroundColor: '#0e7490' },
  scheduleSaveLabel: { color: colors.white, fontSize: 12, fontWeight: '600' },
});
