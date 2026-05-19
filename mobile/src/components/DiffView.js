import React, { memo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { colors } from '../theme/colors';
import { parseDiffLines, shortenPath, diffHasDisplayableLines } from '../utils/diff';

const DIFF_PREVIEW_LINES = 5;

/**
 * DiffView — React Native twin of the web DiffView in SessionTail.jsx.
 * Preview mode shows a few lines + tap to expand full diff.
 */
function DiffView({ tool, input }) {
  const { filePath, action, removals, additions } = parseDiffLines(tool, input);
  const [expanded, setExpanded] = useState(false);
  const hasLines = diffHasDisplayableLines(tool, input);

  const addedCount = additions.filter((l) => l && l.trim()).length;
  const removedCount = removals.filter((l) => l && l.trim()).length;
  const totalLines = removals.length + additions.length;
  const canPreview = totalLines > DIFF_PREVIEW_LINES;
  const showFull = expanded || !canPreview;
  const previewLines = additions.length > 0 ? additions : removals;
  const previewKind = additions.length > 0 ? 'add' : 'remove';
  const hiddenCount = totalLines - Math.min(previewLines.length, DIFF_PREVIEW_LINES);

  const diffBody = !hasLines ? (
    <Text style={styles.emptyHint}>
      {filePath ? 'Diff content pending or unavailable for this edit.' : 'No diff lines to display.'}
    </Text>
  ) : showFull ? (
    <ScrollView style={styles.fullScroll} nestedScrollEnabled>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
        <View>
          {removals.map((line, i) => (
            <View key={`r${i}`} style={styles.removalRow}>
              <Text style={styles.removalGutter}>-</Text>
              <Text style={styles.removalText}>{line || ' '}</Text>
            </View>
          ))}
          {additions.map((line, i) => (
            <View key={`a${i}`} style={styles.additionRow}>
              <Text style={styles.additionGutter}>+</Text>
              <Text style={styles.additionText}>{line || ' '}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  ) : (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
        <View>
          {previewLines.slice(0, DIFF_PREVIEW_LINES).map((line, i) => (
            <View
              key={`p${i}`}
              style={previewKind === 'add' ? styles.previewAddRow : styles.previewRemoveRow}
            >
              <Text style={previewKind === 'add' ? styles.additionGutter : styles.removalGutter}>
                {previewKind === 'add' ? '+' : '-'}
              </Text>
              <Text style={previewKind === 'add' ? styles.additionText : styles.removalText}>
                {line || ' '}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
      {hiddenCount > 0 ? (
        <TouchableOpacity
          style={styles.expandFooter}
          onPress={() => setExpanded(true)}
          accessibilityRole="button"
          testID="diff-view-expand"
        >
          <Text style={styles.expandFooterText}>
            {hiddenCount} more {hiddenCount === 1 ? 'line' : 'lines'} · view all
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.action}>{action}:</Text>
        <Text style={styles.path} numberOfLines={1}>
          {shortenPath(filePath) || '(unknown file)'}
        </Text>
        <View style={styles.counts}>
          {addedCount > 0 && <Text style={styles.addedCount}>+{addedCount}</Text>}
          {removedCount > 0 && <Text style={styles.removedCount}>-{removedCount}</Text>}
        </View>
      </View>

      {diffBody}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.gray950,
    borderRadius: 6,
    overflow: 'hidden',
    marginVertical: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: colors.gray900,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  action: { color: colors.emerald500, fontWeight: '700', fontSize: 11 },
  path: { color: colors.gray400, fontSize: 11, flex: 1, fontFamily: 'monospace' },
  counts: { flexDirection: 'row', gap: 4 },
  addedCount: { color: colors.emerald500, fontSize: 10, fontFamily: 'monospace' },
  removedCount: { color: colors.red400, fontSize: 10, fontFamily: 'monospace' },
  fullScroll: { maxHeight: 256 },
  removalRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(127, 29, 29, 0.25)',
    borderLeftWidth: 2,
    borderLeftColor: colors.red600,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  additionRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(6, 78, 59, 0.25)',
    borderLeftWidth: 2,
    borderLeftColor: colors.emerald500,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  previewRemoveRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(127, 29, 29, 0.15)',
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(220, 38, 38, 0.65)',
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  previewAddRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(6, 78, 59, 0.15)',
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(16, 185, 129, 0.6)',
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  removalGutter: {
    color: 'rgba(239, 68, 68, 0.7)',
    fontFamily: 'monospace',
    fontSize: 11,
    marginRight: 6,
  },
  additionGutter: {
    color: 'rgba(16, 185, 129, 0.7)',
    fontFamily: 'monospace',
    fontSize: 11,
    marginRight: 6,
  },
  removalText: { color: '#fca5a5', fontFamily: 'monospace', fontSize: 11 },
  additionText: { color: '#6ee7b7', fontFamily: 'monospace', fontSize: 11 },
  expandFooter: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: 'rgba(17, 24, 39, 0.55)',
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  expandFooterText: { fontSize: 10, color: colors.gray500 },
  emptyHint: {
    fontSize: 11,
    color: colors.gray500,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
});

export default memo(DiffView);
