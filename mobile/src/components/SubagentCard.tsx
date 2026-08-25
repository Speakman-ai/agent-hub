import React, { memo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import AppIcon from './AppIcon';
import { colors } from '../theme/colors';
/**
 * Mobile twin of the web SubagentCard. Renders a Task / Agent tool use as
 * a distinct card (instead of folding it into the generic tool row) so the
 * subagent type, background/isolation flags, prompt, and result are legible
 * in the chat stream.
 */
const SUBAGENT_TYPES: Record<string, any> = {
  'general-purpose': { label: 'General', color: colors.indigo400 },
  Explore: { label: 'Explore', color: '#22d3ee' },
  Plan: { label: 'Plan', color: colors.amber400 },
  'code-reviewer': { label: 'Reviewer', color: colors.emerald400 },
};
function SubagentCard({ use, result }: any) {
  const [open, setOpen] = useState(false);
  const input = use?.input || {};
  const subagentType = input.subagent_type || 'general-purpose';
  const description = input.description || 'Subagent task';
  const model = input.model || null;
  const background = input.run_in_background || false;
  const isolation = input.isolation || null;
  const errored = !!result?.isError;
  const stillRunning = !result;
  const typeInfo = SUBAGENT_TYPES[subagentType] || {
    label: subagentType,
    color: colors.gray400,
  };
  return (
    <View style={[styles.container, errored && styles.errored]}>
      <TouchableOpacity style={styles.header} onPress={() => setOpen((v: any) => !v)}>
        <AppIcon name="git-branch-outline" size={14} color={colors.indigo400} />
        <Text style={styles.title}>Subagent</Text>
        <View style={[styles.pill, { borderColor: typeInfo.color }]}>
          <Text style={[styles.pillText, { color: typeInfo.color }]}>{typeInfo.label}</Text>
        </View>
        <Text style={styles.description} numberOfLines={1}>
          {description}
        </Text>
        {stillRunning && <Text style={styles.running}>running…</Text>}
        {!stillRunning && !errored && <Text style={styles.done}>✓ done</Text>}
        {errored && <Text style={styles.errorBadge}>error</Text>}
        <Text style={styles.caret}>{open ? '\u25BE' : '\u25B8'}</Text>
      </TouchableOpacity>

      {(model || background || isolation) && (
        <View style={styles.meta}>
          {model && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {model.replace('claude-', '').replace(/-/g, ' ')}
              </Text>
            </View>
          )}
          {background && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>background</Text>
            </View>
          )}
          {isolation && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{isolation}</Text>
            </View>
          )}
        </View>
      )}

      {open && (
        <View style={styles.body}>
          {input.prompt && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>prompt</Text>
              <ScrollView style={styles.promptBox} nestedScrollEnabled>
                <Text style={styles.promptText}>{input.prompt}</Text>
              </ScrollView>
            </View>
          )}
          {result && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{errored ? 'error' : 'result'}</Text>
              <ScrollView
                style={[styles.resultBox, errored && styles.resultBoxError]}
                nestedScrollEnabled
              >
                <Text style={[styles.resultText, errored && { color: colors.red400 }]}>
                  {result.output || '(empty)'}
                </Text>
              </ScrollView>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.4)',
    backgroundColor: 'rgba(49, 46, 129, 0.2)',
    borderRadius: 8,
    overflow: 'hidden',
    marginVertical: 2,
  },
  errored: { borderColor: 'rgba(220, 38, 38, 0.6)' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  title: { color: colors.indigo400, fontWeight: '700', fontSize: 12, fontFamily: 'monospace' },
  pill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillText: { fontSize: 10, fontWeight: '600' },
  description: { color: colors.gray400, fontSize: 12, flex: 1 },
  running: { color: colors.indigo400, fontSize: 10, fontStyle: 'italic' },
  done: { color: colors.emerald400, fontSize: 10 },
  errorBadge: { color: colors.red400, fontSize: 10, fontWeight: '600', textTransform: 'uppercase' },
  caret: { color: colors.gray500, fontSize: 10 },
  meta: {
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 10,
    paddingBottom: 6,
    flexWrap: 'wrap',
  },
  badge: {
    backgroundColor: 'rgba(55, 65, 81, 0.6)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: { color: colors.gray400, fontSize: 10 },
  body: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(49, 46, 129, 0.3)',
    padding: 8,
    gap: 8,
  },
  section: {},
  sectionLabel: {
    fontSize: 10,
    color: colors.gray500,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  promptBox: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: 4,
    maxHeight: 160,
    padding: 6,
  },
  promptText: { color: colors.gray300, fontSize: 11, fontFamily: 'monospace' },
  resultBox: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: 4,
    maxHeight: 280,
    padding: 6,
  },
  resultBoxError: { backgroundColor: 'rgba(127, 29, 29, 0.3)' },
  resultText: { color: colors.gray300, fontSize: 11, fontFamily: 'monospace' },
});
export default memo(SubagentCard);
