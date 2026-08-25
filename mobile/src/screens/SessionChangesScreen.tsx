import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  normalizeChangesSummary,
  describeDiff,
  statusMeta,
  basename,
  dirname,
  worktreeStatusLine,
} from '../utils/sessionChangesView';
import { useFinalizeRunPoll } from '../hooks/useFinalizeRunPoll';
import FinalizeChecksCard from '../components/FinalizeChecksCard';
import ReviewerThreadsCard from '../components/ReviewerThreadsCard';
// Same monospace handling as code blocks elsewhere in the app: Android's
// generic 'monospace' family, Menlo on iOS (RN iOS has no generic alias).
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
/** Theme color per status tone (see sessionChangesView.statusMeta). */
const TONE_COLORS: Record<string, any> = {
  add: colors.emerald400,
  del: colors.red400,
  info: colors.blue400,
  warn: colors.amber400,
};
/** Diff line colors: additions emerald, deletions rose/red, hunks + metadata gray. */
const LINE_COLORS: Record<string, any> = {
  add: colors.emerald400,
  del: colors.rose400,
  hunk: colors.gray400,
  meta: colors.gray500,
  context: colors.gray300,
};
const LINE_BACKGROUNDS: Record<string, any> = {
  add: colors.emerald900_40,
  del: colors.rose900_40,
};
/** Notices rendered inside an expanded file instead of diff lines. */
function DiffNotice({ children, tone }: any) {
  return (
    <Text style={[styles.diffNotice, tone === 'warn' && { color: colors.amber400 }]}>
      {children}
    </Text>
  );
}
/** Unified diff body — vertical line stack inside a horizontal scroller so
 * long lines pan instead of wrapping. */
function DiffBody({ body }: any) {
  if (body.kind === 'loading') {
    return (
      <View style={styles.diffLoading}>
        <ActivityIndicator size="small" color={colors.gray400} />
      </View>
    );
  }
  if (body.kind === 'error') {
    return <DiffNotice>Failed to load diff: {body.message}</DiffNotice>;
  }
  if (body.kind === 'binary') {
    return <DiffNotice>Binary file — no text diff to display.</DiffNotice>;
  }
  if (body.kind === 'tooLarge') {
    return <DiffNotice tone="warn">Diff is too large to render inline.</DiffNotice>;
  }
  if (body.kind === 'empty') {
    return <DiffNotice>No textual changes.</DiffNotice>;
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={styles.diffScroll}>
      <View>
        {body.lines.map((line: any, i: any) => (
          <Text
            key={i}
            style={[
              styles.diffLine,
              { color: LINE_COLORS[line.type] || colors.gray300 },
              LINE_BACKGROUNDS[line.type] && { backgroundColor: LINE_BACKGROUNDS[line.type] },
            ]}
          >
            {line.text || ' '}
          </Text>
        ))}
        {body.hiddenLines > 0 && (
          <Text style={styles.diffHiddenNote}>… {body.hiddenLines} more lines not shown</Text>
        )}
      </View>
    </ScrollView>
  );
}
export default function SessionChangesScreen({ navigation, route }: any) {
  const sessionId = route?.params?.sessionId;
  const sessionName = route?.params?.sessionName;
  const projectId = route?.params?.projectId || null;
  const finalize = useFinalizeRunPoll(sessionId, { enabled: !!projectId });
  const [summary, setSummary] = useState<any>(null);
  const [worktree, setWorktree] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<any>(null);
  // Per-file UI state, keyed by repo-relative path.
  const [expanded, setExpanded] = useState<any>({});
  const [diffs, setDiffs] = useState<any>({});
  const [diffLoading, setDiffLoading] = useState<any>({});
  // Load generation — bumped on every summary (re)load so in-flight per-file
  // diff responses from before a refresh are discarded instead of written
  // into the freshly-cleared cache.
  const loadGenRef = useRef(0);
  const load = useCallback(
    async ({ asRefresh = false }: any = {}) => {
      if (!sessionId) return;
      loadGenRef.current += 1;
      if (asRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const [changes, wt] = await Promise.all([
          api.getSessionChanges(sessionId),
          // Live git status is a nice-to-have hint — never fail the screen on it.
          api.getSessionWorktreeChanges(sessionId).catch(() => null),
        ]);
        setSummary(normalizeChangesSummary(changes));
        setWorktree(wt);
        // The diffs may have moved — reset the per-file cache on every load.
        setDiffs({});
        setDiffLoading({});
      } catch (err: any) {
        setError(err?.message || String(err));
        setSummary(null);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [sessionId],
  );
  useEffect(() => {
    load();
  }, [load]);
  const toggleFile = useCallback(
    (path: any) => {
      const opening = !expanded[path];
      setExpanded((prev: any) => ({ ...prev, [path]: !prev[path] }));
      if (!opening || diffs[path] || diffLoading[path]) return;
      // Lazily fetch the unified diff the first time a file is expanded.
      const gen = loadGenRef.current;
      setDiffLoading((prev: any) => ({ ...prev, [path]: true }));
      api
        .getSessionChangesDiff(sessionId, path)
        .then((body: any) => {
          if (loadGenRef.current !== gen) return;
          setDiffs((prev: any) => ({ ...prev, [path]: body }));
        })
        .catch((err: any) => {
          if (loadGenRef.current !== gen) return;
          setDiffs((prev: any) => ({ ...prev, [path]: { error: err?.message || String(err) } }));
        })
        .finally(() => {
          if (loadGenRef.current !== gen) return;
          setDiffLoading((prev: any) => ({ ...prev, [path]: false }));
        });
    },
    [sessionId, expanded, diffs, diffLoading],
  );
  const files = summary?.files || [];
  const wtHint = worktreeStatusLine(worktree);
  const hasChanges = files.length > 0;
  // CI + review cards. Finalize controls (build dropdown / Finalize / Push) live
  // on the chat TopBar via FinalizeBar — not duplicated here.
  const finalizeCards = projectId ? (
    <>
      <FinalizeChecksCard steps={finalize.steps} />
      <ReviewerThreadsCard
        projectId={projectId}
        runId={finalize.run?.id}
        status={finalize.status}
      />
    </>
  ) : null;
  const renderFile = ({ item }: any) => {
    const meta = statusMeta(item.status);
    const toneColor = TONE_COLORS[meta.tone] || colors.gray400;
    const isOpen = !!expanded[item.path];
    const dir = dirname(item.path);
    return (
      <View style={styles.fileCard}>
        <TouchableOpacity
          style={styles.fileRow}
          onPress={() => toggleFile(item.path)}
          accessibilityLabel={`${meta.label}: ${item.path}`}
          accessibilityState={{ expanded: isOpen }}
        >
          <View style={[styles.statusBadge, { borderColor: toneColor }]}>
            <Text style={[styles.statusBadgeText, { color: toneColor }]}>{meta.short}</Text>
          </View>
          <View style={styles.fileNameBlock}>
            <Text style={styles.fileName} numberOfLines={1}>
              {basename(item.path)}
            </Text>
            {dir ? (
              <Text style={styles.fileDir} numberOfLines={1}>
                {dir}
              </Text>
            ) : null}
            {item.oldPath ? (
              <Text style={styles.fileDir} numberOfLines={1}>
                ← {item.oldPath}
              </Text>
            ) : null}
          </View>
          {item.binary ? (
            <Text style={styles.fileBin}>bin</Text>
          ) : (
            <Text style={styles.fileCounts}>
              <Text style={{ color: colors.emerald400 }}>+{item.additions}</Text>{' '}
              <Text style={{ color: colors.red400 }}>−{item.deletions}</Text>
            </Text>
          )}
          <Text style={styles.chevron}>{isOpen ? '▾' : '▸'}</Text>
        </TouchableOpacity>
        {isOpen && (
          <View style={styles.diffContainer}>
            <DiffBody body={describeDiff(diffLoading[item.path] ? null : diffs[item.path])} />
          </View>
        )}
      </View>
    );
  };
  const listHeader = (
    <View>
      {finalizeCards}
      {summary?.branch ? (
        <View style={styles.branchBlock}>
          <Text style={styles.branchText} numberOfLines={1}>
            {summary.branch}
            {summary.baseBranch ? ` ← ${summary.baseBranch}` : ''}
          </Text>
          {wtHint ? <Text style={styles.worktreeHint}>{wtHint}</Text> : null}
        </View>
      ) : null}
      {summary?.truncated ? (
        <Text style={styles.truncatedNote}>
          Showing the first {files.length} files (list truncated).
        </Text>
      ) : null}
    </View>
  );
  // Empty-state body. Holds ONLY the "no changes" copy — the finalize cards
  // live in `listHeader`, which the FlatList already renders above this when
  // the data array is empty, so the cards must not be repeated here.
  const emptyState = (
    <View style={styles.emptyBlock}>
      <Text style={styles.emptyTitle}>No changes yet</Text>
      <Text style={styles.emptyDesc}>
        Files the agent creates or edits in this session's worktree will show up here as a diff
        against the base branch.
      </Text>
    </View>
  );
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => navigation?.goBack?.()}
          style={styles.backButton}
          accessibilityLabel="Go back"
        >
          <Text style={styles.backIcon}>{'←'}</Text>
        </TouchableOpacity>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            Changes
            {files.length > 0 ? ` · ${files.length} file${files.length === 1 ? '' : 's'}` : ''}
          </Text>
          {sessionName ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {sessionName}
            </Text>
          ) : null}
        </View>
        {files.length > 0 && (
          <Text style={styles.totals}>
            <Text style={{ color: colors.emerald400 }}>+{summary.totals.additions}</Text>{' '}
            <Text style={{ color: colors.red400 }}>−{summary.totals.deletions}</Text>
          </Text>
        )}
      </View>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color={colors.gray400} />
        </View>
      ) : error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorTitle}>Failed to load changes</Text>
          <Text style={styles.errorDesc}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => load()}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item: any) => item.path}
          renderItem={renderFile}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={emptyState}
          contentContainerStyle={hasChanges ? styles.listContent : styles.listContentEmpty}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load({ asRefresh: true })}
              tintColor={colors.gray400}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.gray950,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 8,
  },
  backButton: { padding: 4 },
  backIcon: { fontSize: 22, color: colors.gray400 },
  titleBlock: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '600', color: colors.white },
  subtitle: { fontSize: 12, color: colors.gray500 },
  totals: { fontSize: 13, fontFamily: MONO },
  branchBlock: { marginBottom: 10 },
  branchText: { fontSize: 12, fontFamily: MONO, color: colors.gray500 },
  worktreeHint: { fontSize: 11, color: colors.amber400, marginTop: 2 },
  truncatedNote: {
    fontSize: 11,
    color: colors.amber400,
    backgroundColor: colors.amber900_40,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 10,
  },
  listContent: { padding: 12 },
  fileCard: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    marginBottom: 8,
    overflow: 'hidden',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 10,
  },
  statusBadge: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusBadgeText: { fontSize: 12, fontWeight: '700', fontFamily: MONO },
  fileNameBlock: { flex: 1, minWidth: 0 },
  fileName: { fontSize: 14, color: colors.gray200, fontFamily: MONO },
  fileDir: { fontSize: 11, color: colors.gray500, fontFamily: MONO, marginTop: 1 },
  fileCounts: { fontSize: 12, fontFamily: MONO },
  fileBin: { fontSize: 11, color: colors.gray500, fontFamily: MONO },
  chevron: { fontSize: 12, color: colors.gray500 },
  diffContainer: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    backgroundColor: colors.gray950,
  },
  diffScroll: { paddingVertical: 6 },
  diffLine: {
    fontSize: 11,
    fontFamily: MONO,
    lineHeight: 16,
    paddingHorizontal: 10,
  },
  diffHiddenNote: {
    fontSize: 11,
    fontFamily: MONO,
    color: colors.gray500,
    paddingHorizontal: 10,
    paddingTop: 6,
  },
  diffNotice: {
    fontSize: 12,
    color: colors.gray400,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  diffLoading: { paddingVertical: 16, alignItems: 'center' },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  errorTitle: { fontSize: 16, fontWeight: '600', color: colors.red400, marginBottom: 8 },
  errorDesc: {
    fontSize: 13,
    color: colors.gray500,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: colors.gray800,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryButtonText: { color: colors.gray300, fontSize: 14, fontWeight: '600' },
  listContentEmpty: { padding: 12, flexGrow: 1 },
  emptyBlock: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 20,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: colors.gray400, marginBottom: 8 },
  emptyDesc: {
    fontSize: 14,
    color: colors.gray600,
    textAlign: 'center',
    lineHeight: 20,
  },
});
