import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { X } from 'lucide-react-native';
import { colors } from '../theme/colors';
import { api } from '../utils/api';
import {
  CONTEXT_CATEGORY_COLORS,
  contextBarSegments,
  formatTokenCount,
  startLatestOnlyPolling,
  type SessionContextUsage,
} from '@shared/utils/contextUsage';

const POLL_MS = 5000;

/** Mobile twin of the web `SessionContextUsagePanel`, toggled from the Actions menu. */
export default function MobileContextUsagePanel({
  sessionId,
  onClose,
  pollMs = POLL_MS,
}: {
  sessionId: string;
  onClose: () => void;
  pollMs?: number;
}) {
  const [usage, setUsage] = useState<SessionContextUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUsage(null);
    setError(null);
    return startLatestOnlyPolling({
      fetchUsage: () => api.getSessionContextUsage(sessionId),
      onData: (next) => {
        setUsage(next);
        setError(null);
      },
      onError: (err) =>
        setError((err as { message?: string } | null)?.message || 'Failed to load context usage'),
      intervalMs: pollMs,
    });
  }, [sessionId, pollMs]);

  const segments = usage ? contextBarSegments(usage.categories, usage.contextWindow) : [];
  const rows = usage?.categories.filter((c) => c.tokens > 0) ?? [];

  return (
    <View style={styles.card} testID="mobile-context-usage-panel">
      <View style={styles.header}>
        <Text style={styles.title}>Context Usage</Text>
        <TouchableOpacity
          testID="mobile-context-usage-close"
          accessibilityRole="button"
          accessibilityLabel="Close context usage"
          onPress={onClose}
        >
          <X size={16} color={colors.gray400} />
        </TouchableOpacity>
      </View>
      {error && !usage ? <Text style={styles.error}>{error}</Text> : null}
      {!usage && !error ? <Text style={styles.muted}>Loading…</Text> : null}
      {usage ? (
        <>
          <View style={styles.summary}>
            <Text style={styles.summaryText} testID="mobile-context-usage-percent">
              {usage.percent != null ? `${Math.round(usage.percent)}% Full` : 'Window size unknown'}
            </Text>
            <Text style={styles.summaryText} testID="mobile-context-usage-total">
              {`${usage.source === 'estimated' ? '~' : ''}${formatTokenCount(usage.totalTokens)}${
                usage.contextWindow ? ` / ${formatTokenCount(usage.contextWindow)}` : ''
              } Tokens`}
            </Text>
          </View>
          <View style={styles.bar}>
            {segments.map((s) => (
              <View
                key={s.key}
                style={{ width: `${s.widthPct}%`, backgroundColor: CONTEXT_CATEGORY_COLORS[s.key] }}
              />
            ))}
          </View>
          {usage.source === 'none' ? (
            <Text style={styles.muted}>No turns yet. Send a message to measure context.</Text>
          ) : (
            rows.map((c) => (
              <View key={c.key} style={styles.row} testID={`mobile-context-usage-row-${c.key}`}>
                <View
                  style={[styles.swatch, { backgroundColor: CONTEXT_CATEGORY_COLORS[c.key] }]}
                />
                <Text style={styles.label}>{c.label}</Text>
                <Text style={styles.value}>{formatTokenCount(c.tokens)}</Text>
              </View>
            ))
          )}
          {usage.source === 'estimated' ? (
            <Text style={styles.footnote}>
              Estimated from message size. This engine does not report per-step token counts.
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.sky400,
    backgroundColor: colors.gray950,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: { color: colors.gray100, fontSize: 14, fontWeight: '600' },
  summary: { flexDirection: 'row', justifyContent: 'space-between' },
  summaryText: { color: colors.gray300, fontSize: 12 },
  bar: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: colors.gray800,
    marginTop: 8,
    marginBottom: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3 },
  swatch: { width: 10, height: 10, borderRadius: 2, marginRight: 8 },
  label: { flex: 1, color: colors.gray200, fontSize: 12 },
  value: { color: colors.gray400, fontSize: 12 },
  muted: { color: colors.gray500, fontSize: 12 },
  error: { color: colors.red400, fontSize: 12 },
  footnote: { color: colors.gray500, fontSize: 10, marginTop: 8 },
});
