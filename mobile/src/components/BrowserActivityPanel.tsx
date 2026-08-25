import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  ScrollView,
  Platform,
} from 'react-native';
import {
  deriveStreamingBrowserHint,
  mergeBrowserTimelineRows,
} from '@shared/utils/browserActivityTimeline';
import { colors } from '../theme/colors';
function runningGlyph(row: any, streaming: any) {
  const pending = !!streaming && row.phase === 'running';
  if (pending) return { char: '\u2022', color: colors.blue400 };
  if (row.phase === 'done' && row.ok) return { char: '\u2713', color: colors.emerald400 };
  if (row.phase === 'done' && row.ok === false) return { char: '\u2715', color: colors.rose400 };
  return { char: '\u25CB', color: colors.gray500 };
}
/** Mobile twin of web `BrowserActivityPanel` — host Chromium ReAct telemetry. */
export default function BrowserActivityPanel({ timelineEntries, streaming, screenshots }: any) {
  const hint = useMemo<any>(() => deriveStreamingBrowserHint(timelineEntries), [timelineEntries]);
  const rows = useMemo<any>(() => mergeBrowserTimelineRows(timelineEntries), [timelineEntries]);
  const hasRunningBrowser = !!(streaming && rows.some((r: any) => r.phase === 'running'));
  const [open, setOpen] = useState(true);
  if (!hint && rows.length === 0) return null;
  const hasLive = !!(streaming && hint);
  const showDetail = open || hasRunningBrowser;
  return (
    <View style={styles.wrap} testID="browser-activity-panel">
      {hasLive && (
        <View style={styles.hintRow}>
          <Text style={styles.globe}>{'\uD83C\uDF10'}</Text>
          <Text style={styles.hint}>{hint}</Text>
        </View>
      )}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ expanded: showDetail }}
        onPress={() => setOpen((v: any) => !v)}
      >
        <View style={styles.headerRow}>
          <Text style={styles.globeSm}>{'\uD83C\uDF10'}</Text>
          <Text style={styles.header}>
            Browser Activity{rows.length > 0 ? ` (${rows.length})` : ''}
            {streaming ? ' · live' : ''}
          </Text>
          <Text style={styles.chev}>{showDetail ? '\u25BE' : '\u25B8'}</Text>
        </View>
      </TouchableOpacity>
      {showDetail ? (
        <ScrollView
          nestedScrollEnabled
          style={styles.listScroll}
          contentContainerStyle={styles.listContent}
        >
          {rows.map((row: any) => {
            const aid = row.actionId;
            const caption =
              row.phase === 'done' ? row.summary || row.startedLabel : row.startedLabel || row.op;
            const g = runningGlyph(row, streaming);
            const shot = screenshots?.[aid];
            const duration =
              row.durationMs != null && row.phase === 'done' ? ` ${row.durationMs}ms` : '';
            return (
              <View key={aid} style={styles.row}>
                <Text style={[styles.glyph, { color: g.color }]}>{g.char}</Text>
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle}>
                    <Text style={styles.rowOp}>{(row.op || 'browser').toUpperCase()} </Text>
                    {caption}
                    {duration ? <Text style={styles.duration}>{duration}</Text> : null}
                  </Text>
                  {row.targetSummary ? (
                    <Text style={styles.mono} selectable>
                      {row.targetSummary}
                    </Text>
                  ) : null}
                  {row.error ? <Text style={styles.err}>{row.error}</Text> : null}
                  {row.extractPreview ? (
                    <Text style={styles.extract} selectable numberOfLines={8}>
                      {row.extractPreview}
                    </Text>
                  ) : null}
                  {shot ? (
                    <Image
                      source={{ uri: shot }}
                      accessibilityLabel="Browser screenshot preview"
                      style={styles.shot}
                      resizeMode="contain"
                    />
                  ) : null}
                  {!shot && row.hasScreenshot ? (
                    <Text style={styles.muted}>
                      Screenshot captured (preview too large or not synced)
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  wrap: { paddingVertical: 4, paddingHorizontal: 2 },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  globe: { fontSize: 14 },
  hint: { color: colors.gray400, fontSize: 12, flexShrink: 1 },
  globeSm: { fontSize: 12, marginRight: 4 },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  header: {
    color: colors.gray500,
    fontSize: 12,
    flex: 1,
    fontWeight: '600',
  },
  chev: { color: colors.gray500, fontSize: 12 },
  listScroll: {
    maxHeight: 220,
    marginTop: 8,
    marginLeft: 6,
    paddingLeft: 8,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.gray700,
  },
  listContent: { gap: 8, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.gray400, fontSize: 12, lineHeight: 18 },
  rowOp: {
    fontSize: 10,
    color: colors.gray500,
    letterSpacing: 1,
    fontWeight: '700',
    marginRight: 4,
  },
  mono: {
    marginTop: 4,
    color: colors.gray500,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  err: {
    marginTop: 4,
    color: colors.rose400,
    fontSize: 11,
    lineHeight: 16,
  },
  extract: {
    marginTop: 4,
    backgroundColor: 'rgba(3, 7, 18, 0.72)',
    color: colors.gray500,
    padding: 8,
    borderRadius: 4,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.gray700,
    maxHeight: 120,
    overflow: 'hidden',
  },
  shot: {
    marginTop: 8,
    width: '100%',
    height: 180,
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.gray700,
  },
  duration: {
    marginLeft: 6,
    color: colors.gray500,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  muted: {
    marginTop: 4,
    color: colors.gray600,
    fontStyle: 'italic',
    fontSize: 11,
  },
  glyph: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, marginTop: 2 },
});
