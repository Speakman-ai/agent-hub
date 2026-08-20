import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
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
      {loading && !generating ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : hasToday && report ? (
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.meta}>
            Generated {formatGeneratedAt(report.generatedAt)}
            {report.engine ? ` · ${report.engine}` : ''}
            {report.model ? ` / ${report.model}` : ''}
          </Text>
          <Markdown style={markdownStyles as any} onLinkPress={onLinkPress}>
            {report.markdown}
          </Markdown>
        </ScrollView>
      ) : (
        <View style={styles.empty} testID="daily-summary-empty">
          <Text style={styles.emptyTitle}>No summary for today yet.</Text>
          <Text style={styles.muted}>
            Generate a report of what you did today, what is running now, and what happened
            yesterday.
          </Text>
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
  muted: { color: colors.gray500, fontSize: 13, paddingHorizontal: 16 },
  body: { paddingHorizontal: 16, paddingBottom: 24 },
  meta: { color: colors.gray500, fontSize: 12, marginBottom: 12 },
  empty: { paddingHorizontal: 16, paddingTop: 32, gap: 6 },
  emptyTitle: { color: colors.gray300, fontSize: 14, fontWeight: '500' },
});
