/**
 * Mobile views for Finalize dynamic test selection: the run's manifest
 * (which job instances ran and why) and the default-branch red banner.
 * Ports `client/src/components/finalize/TestSelectionManifest.tsx`; the
 * labels come from `@shared/utils/testSelectionDisplay`.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { colors } from '../theme/colors';
import { api } from '../utils/api';
import {
  DEFAULT_BRANCH_HEALTH_POLL_MS,
  defaultBranchFailureName,
  defaultBranchRedLabel,
  forcedFullLabel,
  selectionChipLabel,
  selectionInstanceName,
  selectionInstanceReason,
  sortedSelectionInstances,
  type TestSelectionWire,
} from '@shared/utils/testSelectionDisplay';
import { createUseDefaultBranchHealth } from '@shared/hooks/useDefaultBranchHealth';

const useDefaultBranchHealth = createUseDefaultBranchHealth({ useEffect, useState });

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const MAX_FILES_SHOWN = 5;

export function TestSelectionManifestView({
  selection,
  initiallyOpen = false,
}: {
  selection: TestSelectionWire | null;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  if (!selection) return null;
  const chip = selectionChipLabel(selection);
  const forced = forcedFullLabel(selection);
  return (
    <View style={styles.manifest} testID="test-selection-manifest">
      <TouchableOpacity
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        testID="test-selection-manifest-toggle"
      >
        <Text style={styles.manifestTitle}>
          {open ? '▾' : '▸'} Test selection{chip ? ` · ${chip}` : ''}
        </Text>
      </TouchableOpacity>
      {forced ? (
        <Text style={styles.forced} testID="test-selection-forced-full">
          {forced}
        </Text>
      ) : null}
      {open
        ? sortedSelectionInstances(selection).map((i) => (
            <View
              key={`${i.jobId}::${i.matrixKey}`}
              style={[styles.row, !i.selected && styles.rowDim]}
              testID="test-selection-manifest-row"
            >
              <Text style={styles.rowName}>
                {i.selected ? '✓ ' : '– '}
                {selectionInstanceName(i)}
                <Text style={styles.rowState}>{i.selected ? '  ran' : '  not selected'}</Text>
              </Text>
              {!forced ? <Text style={styles.rowReason}>{selectionInstanceReason(i)}</Text> : null}
              {i.files.length > 0 ? (
                <Text style={styles.rowFiles}>
                  {i.files.slice(0, MAX_FILES_SHOWN).join(', ')}
                  {i.files.length > MAX_FILES_SHOWN
                    ? ` +${i.files.length - MAX_FILES_SHOWN} more`
                    : ''}
                </Text>
              ) : null}
            </View>
          ))
        : null}
    </View>
  );
}

export function DefaultBranchHealthBanner({
  projectId,
  onOpenCard,
  refreshKey = '',
  pollMs = DEFAULT_BRANCH_HEALTH_POLL_MS,
}: {
  projectId: string;
  onOpenCard?: (cardId: string) => void;
  /** Refetch whenever this changes (e.g. a push-CI run settles). */
  refreshKey?: string;
  pollMs?: number;
}) {
  const health = useDefaultBranchHealth(projectId, api.getDefaultBranchHealth, {
    refreshKey,
    pollMs,
  });
  const label = defaultBranchRedLabel(health);
  if (!health || !label) return null;
  const cardId = health.breakage?.card_id ?? null;
  return (
    <View style={styles.banner} testID="default-branch-red-banner">
      <Text style={styles.bannerTitle}>{label}</Text>
      {health.failures.map((f) => (
        <Text key={`${f.job_id}::${f.matrix_key}`} style={styles.bannerFailure}>
          {defaultBranchFailureName(f)} since {f.first_failing_sha.slice(0, 8)}
        </Text>
      ))}
      <Text style={styles.bannerNote}>
        Merges are not blocked. Session runs that fail only on these instances pass as inherited.
      </Text>
      {cardId && onOpenCard ? (
        <TouchableOpacity
          onPress={() => onOpenCard(cardId)}
          testID="default-branch-breakage-card"
          accessibilityRole="link"
        >
          <Text style={styles.bannerLink}>Open breakage card</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  manifest: { marginTop: 8 },
  manifestTitle: { fontSize: 13, color: colors.gray300, fontWeight: '600' },
  forced: { fontSize: 12, color: colors.amber400, marginTop: 4 },
  row: { marginTop: 6 },
  rowDim: { opacity: 0.6 },
  rowName: { fontSize: 12, color: colors.gray200, fontFamily: MONO },
  rowState: { color: colors.gray500 },
  rowReason: { fontSize: 11, color: colors.gray500, marginLeft: 14 },
  rowFiles: { fontSize: 10, color: colors.gray600, marginLeft: 14, fontFamily: MONO },
  banner: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: colors.red400,
    backgroundColor: colors.red900_50,
    borderRadius: 8,
    padding: 12,
  },
  bannerTitle: { fontSize: 14, fontWeight: '600', color: colors.red400 },
  bannerFailure: { fontSize: 12, color: colors.gray200, fontFamily: MONO, marginTop: 4 },
  bannerNote: { fontSize: 11, color: colors.gray400, marginTop: 6 },
  bannerLink: { fontSize: 13, color: colors.blue400, marginTop: 6 },
});
