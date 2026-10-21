/**
 * FinalizeChecksCard — the mobile "CI card".
 *
 * Renders the current finalize run's CI steps (lint / typecheck / tests / …)
 * as a GitHub-Actions-style card. Ports the web `FinalizeChecksRoundBlock` /
 * `ChecksPanel` step list. Step data comes from the screen's
 * `useFinalizeRunPoll` (no separate fetch).
 */
import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import AppIcon from './AppIcon';
import { colors } from '../theme/colors';
import { summarizeChecks } from '../utils/finalizeView';
import { notSelectedStepReason, type TestSelectionWire } from '@shared/utils/testSelectionDisplay';
import { TestSelectionManifestView } from './TestSelectionViews';
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const STATE_ICON: Record<string, any> = {
  passed: { name: 'checkmark-circle', color: colors.emerald400 },
  failed: { name: 'close-circle', color: colors.red400 },
  skipped: { name: 'remove-circle-outline', color: colors.gray500 },
  not_selected: { name: 'remove-circle-outline', color: colors.gray600 },
};
function StepIcon({ state }: any) {
  if (state === 'running' || state === 'queued') {
    return <ActivityIndicator size="small" color={colors.amber400} />;
  }
  const meta = STATE_ICON[state] || { name: 'ellipse-outline', color: colors.gray500 };
  return <AppIcon name={meta.name} size={16} color={meta.color} />;
}
export default function FinalizeChecksCard({
  steps,
  round,
  selection = null,
}: {
  steps: any;
  round?: number;
  selection?: TestSelectionWire | null;
}) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0) return null;
  const sum = summarizeChecks(list);
  const tone = sum.failed > 0 ? colors.red400 : sum.allPassed ? colors.emerald400 : colors.amber400;
  return (
    <View style={styles.card} testID="finalize-checks-card">
      <View style={styles.header}>
        <AppIcon name="construct-outline" size={14} color={colors.gray300} />
        <Text style={styles.title}>
          Checks{typeof round === 'number' && round > 0 ? ` · round ${round}` : ''}
        </Text>
        <Text style={[styles.headline, { color: tone }]}>{sum.headline}</Text>
      </View>
      <View style={styles.steps}>
        {list.map((s: any, i: any) => {
          const reason = notSelectedStepReason(s, selection);
          return (
            <View
              key={`${s.name || 'step'}-${i}`}
              style={[styles.stepRow, reason ? styles.stepDim : null]}
            >
              <StepIcon state={s.state} />
              <View style={styles.stepText}>
                <Text style={styles.stepName} numberOfLines={1}>
                  {s.name || `Step ${i + 1}`}
                </Text>
                {reason ? (
                  <Text style={styles.stepReason} testID="finalize-step-not-selected-reason">
                    not selected · {reason}
                  </Text>
                ) : null}
              </View>
              {typeof s.exitCode === 'number' && s.state === 'failed' ? (
                <Text style={styles.exit}>exit {s.exitCode}</Text>
              ) : null}
            </View>
          );
        })}
      </View>
      {selection ? (
        <View style={styles.manifestWrap}>
          <TestSelectionManifestView selection={selection} />
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.gray800,
    marginBottom: 10,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.gray200,
    flex: 1,
  },
  headline: {
    fontSize: 12,
    fontWeight: '600',
  },
  steps: {
    paddingVertical: 4,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  stepDim: { opacity: 0.6 },
  stepText: { flex: 1 },
  stepReason: { fontSize: 11, color: colors.gray500, marginTop: 2 },
  manifestWrap: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  stepName: {
    fontSize: 13,
    color: colors.gray300,
    fontFamily: MONO,
  },
  exit: {
    fontSize: 11,
    color: colors.red400,
    fontFamily: MONO,
  },
});
