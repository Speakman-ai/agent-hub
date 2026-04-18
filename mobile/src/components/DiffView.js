import React, { memo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { colors } from '../theme/colors';
import { parseDiffLines, shortenPath } from '../utils/diff';

/**
 * DiffView — React Native twin of the web DiffView in SessionTail.jsx.
 *
 * Shows a compact, colorized diff for file-modifying tools:
 *   - Edit: old_string lines as removals (red) and new_string as additions (green).
 *   - Write: all content as additions (green), truncated to keep mobile compact.
 *
 * Renders a small header with the action ("Update" / "Create"), a shortened
 * file path, and +/- line counts. The body is a horizontally-scrolling list
 * of gutter-marked lines so long lines don't force wrapping or truncate the
 * leading indentation.
 */
function DiffView({ tool, input }) {
  const { filePath, action, removals, additions } = parseDiffLines(tool, input);

  const addedCount = additions.filter((l) => l && l.trim()).length;
  const removedCount = removals.filter((l) => l && l.trim()).length;

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

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
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
});

export default memo(DiffView);
