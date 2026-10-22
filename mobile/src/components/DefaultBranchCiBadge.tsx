import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativePrTime } from '../utils/prFormatting';
import { createUseDefaultBranchCi } from '@shared/hooks/useDefaultBranchCi';
import { ciOnPushEnabled, type DefaultBranchCiTone } from '@shared/utils/defaultBranchCiStatus';

const useDefaultBranchCi = createUseDefaultBranchCi({ useEffect, useState });

const fetchLatestPushRun = (projectId: string) =>
  api.getCiRuns(projectId, { trigger: 'git_push', limit: 1 });

const TONE: Record<DefaultBranchCiTone, { glyph: string; color: string }> = {
  passed: { glyph: '✓', color: colors.emerald400 },
  failed: { glyph: '✕', color: colors.red400 },
  running: { glyph: '', color: colors.amber400 },
  cancelled: { glyph: '○', color: colors.gray500 },
  none: { glyph: '–', color: colors.gray500 },
};

/**
 * Default-branch CI status strip for the top of the Repository screen.
 * Renders nothing unless the project has CI on push enabled.
 */
export default function DefaultBranchCiBadge({
  projectId,
  project,
  onOpenRunners,
}: {
  projectId: string;
  project: unknown;
  onOpenRunners?: () => void;
}) {
  const enabled = ciOnPushEnabled(project);
  const status = useDefaultBranchCi(projectId, enabled, fetchLatestPushRun);
  if (!enabled || !status) return null;
  const tone = TONE[status.tone];
  const meta = [
    status.sha ? status.sha.slice(0, 8) : null,
    status.at != null ? relativePrTime(new Date(status.at).toISOString()) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <TouchableOpacity
      style={styles.wrap}
      onPress={onOpenRunners}
      disabled={!onOpenRunners}
      testID="repo-default-branch-ci"
      accessibilityLabel={status.label}
    >
      {status.tone === 'running' ? (
        <ActivityIndicator size="small" color={tone.color} />
      ) : (
        <Text style={[styles.glyph, { color: tone.color }]}>{tone.glyph}</Text>
      )}
      <View style={styles.text}>
        <Text style={styles.label} numberOfLines={1} testID="repo-default-branch-ci-label">
          {status.label}
        </Text>
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
      </View>
      {onOpenRunners ? <Text style={styles.link}>View runs</Text> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  glyph: { fontSize: 15, fontWeight: '700', width: 16, textAlign: 'center' },
  text: { flex: 1, minWidth: 0 },
  label: { fontSize: 13, fontWeight: '600', color: colors.white },
  meta: { fontSize: 11, color: colors.gray500, fontFamily: 'monospace', marginTop: 2 },
  link: { fontSize: 12, color: colors.blue400 },
});
