/**
 * ReviewerThreadsCard — the mobile "review card".
 *
 * Ports the web `ReviewerThreadsPanel`: a read-only, diff-anchored list of the
 * reviewer's findings for a finalize run, grouped by file with a verdict pill
 * (approved / changes requested). Discovers threads from the run id and polls
 * while the run is still active (mobile has no `reviewer_thread_added` WS
 * bridge).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import AppIcon from './AppIcon';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  groupThreadsByFile,
  emptyReviewerThreads,
  normalizeReviewerThreads,
  isFreshGeneration,
} from '../utils/finalizeView';
import { isTerminalStatus } from '../utils/finalizeRun';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const POLL_MS = 4000;

const VERDICT_META = {
  approved: { label: 'Approved', color: colors.emerald400, icon: 'checkmark-circle' },
  changes_requested: { label: 'Changes requested', color: colors.amber400, icon: 'alert-circle' },
};

export default function ReviewerThreadsCard({ projectId, runId, status }) {
  const [threads, setThreads] = useState([]);
  const [verdict, setVerdict] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [loaded, setLoaded] = useState(false);
  const timer = useRef(null);
  // Monotonic generation token, bumped whenever projectId/runId changes (in the
  // reset effect below). An in-flight `/reviewer-threads` request captures it
  // live and re-checks before calling setThreads/setVerdict, so an out-of-order
  // response from a previous run can't render its verdict/findings under the
  // new run. A shared boolean ref can't do this — the next run's effect resets
  // it to false, letting the late response pass the check.
  const genRef = useRef(0);

  const fetchThreads = useCallback(async () => {
    if (!projectId || !runId) return;
    const myGen = genRef.current;
    try {
      const resp = await api.getReviewerThreads(projectId, runId);
      if (!isFreshGeneration(myGen, genRef.current)) return;
      const next = normalizeReviewerThreads(resp);
      setThreads(next.threads);
      setVerdict(next.verdict);
    } catch {
      /* leave last-known threads in place on transient failure */
    } finally {
      if (isFreshGeneration(myGen, genRef.current)) setLoaded(true);
    }
  }, [projectId, runId]);

  // Clear stale review state the moment the run changes, before the first
  // poll resolves. Otherwise findings (and the verdict pill) from a previous
  // finalize run render under the new run, and a transient failure on the new
  // run would leave that old review visible indefinitely. Bumping the
  // generation here also invalidates any in-flight request from the old run.
  useEffect(() => {
    genRef.current += 1;
    const cleared = emptyReviewerThreads();
    setThreads(cleared.threads);
    setVerdict(cleared.verdict);
    setLoaded(false);
    setCollapsed({});
  }, [projectId, runId]);

  useEffect(() => {
    if (!projectId || !runId) return undefined;
    // Per-effect-instance flag controls only this poll loop's lifecycle (a
    // status change re-runs this effect for the same run); the generation
    // token, not this flag, is what drops stale cross-run responses.
    let active = true;
    const tick = async () => {
      await fetchThreads();
      if (!active) return;
      // Stop polling once the run is terminal — findings are final then.
      if (!isTerminalStatus(status)) timer.current = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [projectId, runId, status, fetchThreads]);

  // Nothing to show until we have a finding or a verdict.
  if (!runId || (!threads.length && !verdict)) return null;
  if (!loaded && !threads.length && !verdict) return null;

  const groups = groupThreadsByFile(threads);
  const vmeta = verdict ? VERDICT_META[verdict] : null;

  return (
    <View style={styles.card} testID="reviewer-threads-card">
      <View style={styles.header}>
        <AppIcon name="chatbubbles-outline" size={14} color={colors.gray300} />
        <Text style={styles.title}>Review</Text>
        {threads.length > 0 && (
          <Text style={styles.count}>
            {threads.length} finding{threads.length === 1 ? '' : 's'}
          </Text>
        )}
        {vmeta && (
          <View style={[styles.verdictPill, { borderColor: vmeta.color }]}>
            <AppIcon name={vmeta.icon} size={12} color={vmeta.color} />
            <Text style={[styles.verdictText, { color: vmeta.color }]}>{vmeta.label}</Text>
          </View>
        )}
      </View>

      {groups.map((g) => {
        const isCollapsed = !!collapsed[g.file];
        return (
          <View key={g.file} style={styles.fileGroup}>
            <TouchableOpacity
              style={styles.fileHeader}
              onPress={() => setCollapsed((p) => ({ ...p, [g.file]: !p[g.file] }))}
            >
              <AppIcon
                name={isCollapsed ? 'chevron-forward' : 'chevron-down'}
                size={14}
                color={colors.gray500}
              />
              <Text style={styles.fileName} numberOfLines={1}>
                {g.file}
              </Text>
              <Text style={styles.fileCount}>{g.items.length}</Text>
            </TouchableOpacity>
            {!isCollapsed &&
              g.items.map((t, i) => (
                <View key={t.id || `${g.file}-${i}`} style={styles.finding}>
                  {(t.line_start || t.line_end) && (
                    <Text style={styles.lineRef}>
                      {t.line_start === t.line_end || !t.line_end
                        ? `L${t.line_start}`
                        : `L${t.line_start}–${t.line_end}`}
                    </Text>
                  )}
                  <Text style={styles.findingBody}>{t.body}</Text>
                </View>
              ))}
          </View>
        );
      })}
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
  count: {
    fontSize: 11,
    color: colors.gray500,
  },
  verdictPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
  },
  verdictText: {
    fontSize: 11,
    fontWeight: '600',
  },
  fileGroup: {
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.gray950,
  },
  fileName: {
    flex: 1,
    fontSize: 12,
    color: colors.gray300,
    fontFamily: MONO,
  },
  fileCount: {
    fontSize: 11,
    color: colors.gray500,
  },
  finding: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  lineRef: {
    fontSize: 10,
    color: colors.blue400,
    fontFamily: MONO,
    marginBottom: 3,
  },
  findingBody: {
    fontSize: 12,
    color: colors.gray300,
    lineHeight: 17,
  },
});
