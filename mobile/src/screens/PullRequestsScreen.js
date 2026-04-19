import React, { useState, useEffect, useCallback, useContext } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Linking,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { SidebarContext } from '../context/SidebarContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  relativePrTime,
  diffSummary,
  prStateBadge,
  summarizeChecks,
  checksBadge,
  summarizeReviews,
  reviewsBadge,
  mergeableBadge,
} from '../utils/prFormatting';
import PrCapturesSection from '../components/PrCapturesSection';
import { resolveAgentIdFromProject } from '../utils/projectAgents';

const STATE_TABS = [
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

function Badge({ label, color, bg }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg || colors.gray700_40 }]}>
      <Text style={[styles.badgeText, { color: color || colors.gray400 }]}>{label}</Text>
    </View>
  );
}

function PrListItem({ pr, onPress }) {
  const state = prStateBadge(pr);
  const diff = diffSummary(pr);
  return (
    <TouchableOpacity style={styles.listItem} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.listItemHeader}>
        <Badge label={state.label} color={state.color} bg={state.bg} />
        <Text style={styles.prNumber}>#{pr.number}</Text>
        <View style={{ flex: 1 }} />
        <Text style={styles.timeText}>{relativePrTime(pr.updated_at)}</Text>
      </View>
      <Text style={styles.prTitle} numberOfLines={2}>
        {pr.title}
      </Text>
      <View style={styles.listItemFooter}>
        <Text style={styles.metaText} numberOfLines={1}>
          {pr.user ? `@${pr.user}` : ''}
          {pr.head ? ` · ${pr.head} → ${pr.base || 'main'}` : ''}
        </Text>
      </View>
      {diff ? <Text style={styles.diffText}>{diff}</Text> : null}
      {Array.isArray(pr.labels) && pr.labels.length > 0 && (
        <View style={styles.labelsRow}>
          {pr.labels.slice(0, 4).map((l) => (
            <View key={l.name} style={styles.label}>
              <Text style={styles.labelText} numberOfLines={1}>
                {l.name}
              </Text>
            </View>
          ))}
        </View>
      )}
    </TouchableOpacity>
  );
}

function PrDetail({
  detail,
  projectId,
  onBack,
  onRefresh,
  refreshing,
  onResolve,
  resolving,
  canResolve,
}) {
  const pr = detail?.pr;
  if (!pr) return null;
  const state = prStateBadge(pr);
  const checks = summarizeChecks(detail.checks);
  const cBadge = checksBadge(checks);
  const reviewState = summarizeReviews(detail.reviews);
  const rBadge = reviewsBadge(reviewState);
  const mBadge = mergeableBadge(pr.mergeable);

  const resolveDisabled = resolving || !canResolve;

  return (
    <ScrollView
      style={styles.detailScroll}
      contentContainerStyle={styles.detailContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gray400} />
      }
    >
      <View style={styles.detailTopActions}>
        <TouchableOpacity style={styles.backButton} onPress={onBack}>
          <Text style={styles.backButtonText}>{'\u2190'} Back to list</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          style={[styles.resolveButton, resolveDisabled && styles.resolveButtonDisabled]}
          onPress={onResolve}
          disabled={resolveDisabled}
          accessibilityLabel="Resolve PR"
          accessibilityState={{ disabled: resolveDisabled, busy: resolving }}
        >
          {resolving ? (
            <ActivityIndicator size="small" color={colors.gray300} />
          ) : (
            <Text
              style={[
                styles.resolveButtonText,
                resolveDisabled && styles.resolveButtonTextDisabled,
              ]}
            >
              {'\u{1F527}'} Resolve PR
            </Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.detailHeader}>
        <Badge label={state.label} color={state.color} bg={state.bg} />
        <Text style={styles.prNumber}>#{pr.number}</Text>
      </View>
      <Text style={styles.detailTitle}>{pr.title}</Text>

      <Text style={styles.metaText}>
        {pr.user ? `@${pr.user}` : 'unknown'}
        {pr.created_at ? ` opened ${relativePrTime(pr.created_at)}` : ''}
      </Text>
      {pr.head && (
        <Text style={styles.metaText}>
          {pr.head} → {pr.base || 'main'}
        </Text>
      )}
      <Text style={styles.diffText}>{diffSummary(pr)}</Text>

      {Array.isArray(pr.labels) && pr.labels.length > 0 && (
        <View style={styles.labelsRow}>
          {pr.labels.map((l) => (
            <View key={l.name} style={styles.label}>
              <Text style={styles.labelText}>{l.name}</Text>
            </View>
          ))}
        </View>
      )}

      <TouchableOpacity
        style={styles.openGithubButton}
        onPress={() => pr.html_url && Linking.openURL(pr.html_url)}
      >
        <Text style={styles.openGithubText}>Open on GitHub {'\u2197'}</Text>
      </TouchableOpacity>

      {/* Summary strip: checks + reviews */}
      <View style={styles.summaryStrip}>
        <Badge label={cBadge.label} color={cBadge.color} bg={cBadge.bg} />
        <Badge label={rBadge.label} color={rBadge.color} bg={rBadge.bg} />
        {mBadge.show && (
          <Badge
            label={mBadge.label}
            color={mBadge.good ? colors.emerald400 : colors.red400}
            bg={mBadge.good ? colors.emerald900_40 : colors.red900_50}
          />
        )}
      </View>

      {/* CI Checks list */}
      <Text style={styles.sectionHeader}>CI Checks</Text>
      {(!detail.checks || detail.checks.length === 0) && (
        <Text style={styles.emptyText}>No checks reported.</Text>
      )}
      {Array.isArray(detail.checks) &&
        detail.checks.map((chk, i) => {
          const status = (chk.status || '').toLowerCase();
          const concl = (chk.conclusion || '').toLowerCase();
          let c = colors.gray400;
          let icon = '\u25CF';
          if (status && status !== 'completed') {
            c = colors.yellow400;
            icon = '\u25D0';
          } else if (concl === 'success' || concl === 'skipped' || concl === 'neutral') {
            c = colors.emerald400;
            icon = '\u2713';
          } else if (
            concl === 'failure' ||
            concl === 'timed_out' ||
            concl === 'cancelled' ||
            concl === 'action_required'
          ) {
            c = colors.red400;
            icon = '\u2717';
          }
          return (
            <TouchableOpacity
              key={chk.id || chk.name || i}
              style={styles.checkRow}
              onPress={() => chk.html_url && Linking.openURL(chk.html_url)}
              disabled={!chk.html_url}
            >
              <Text style={[styles.checkIcon, { color: c }]}>{icon}</Text>
              <Text style={styles.checkName} numberOfLines={1}>
                {chk.name || 'unnamed'}
              </Text>
              <Text style={styles.checkState}>{concl || status || ''}</Text>
            </TouchableOpacity>
          );
        })}

      {/* Reviews */}
      <Text style={styles.sectionHeader}>Reviews</Text>
      {(!detail.reviews || detail.reviews.length === 0) && (
        <Text style={styles.emptyText}>No reviews yet.</Text>
      )}
      {Array.isArray(detail.reviews) &&
        detail.reviews.map((r) => {
          const s = (r.state || '').toUpperCase();
          let c = colors.gray400;
          if (s === 'APPROVED') c = colors.emerald400;
          else if (s === 'CHANGES_REQUESTED') c = colors.red400;
          else if (s === 'COMMENTED') c = colors.blue400;
          return (
            <View key={r.id} style={styles.reviewBlock}>
              <View style={styles.reviewHeader}>
                <Text style={styles.reviewUser}>@{r.user || 'unknown'}</Text>
                <Text style={[styles.reviewState, { color: c }]}>{s || 'REVIEW'}</Text>
                <Text style={styles.reviewTime}>{relativePrTime(r.submitted_at)}</Text>
              </View>
              {r.body ? (
                <Text style={styles.reviewBody} numberOfLines={6}>
                  {r.body}
                </Text>
              ) : null}
            </View>
          );
        })}

      {/* Issue Comments */}
      <Text style={styles.sectionHeader}>Comments</Text>
      {(!detail.comments || detail.comments.length === 0) && (
        <Text style={styles.emptyText}>No comments.</Text>
      )}
      {Array.isArray(detail.comments) &&
        detail.comments.map((c) => (
          <View key={c.id} style={styles.reviewBlock}>
            <View style={styles.reviewHeader}>
              <Text style={styles.reviewUser}>@{c.user || 'unknown'}</Text>
              <Text style={styles.reviewTime}>{relativePrTime(c.created_at)}</Text>
            </View>
            {c.body ? (
              <Text style={styles.reviewBody} numberOfLines={8}>
                {c.body}
              </Text>
            ) : null}
          </View>
        ))}

      {/* PR Captures (screenshots + videos attached to this PR) */}
      {projectId && pr.number ? (
        <PrCapturesSection projectId={projectId} prNumber={pr.number} />
      ) : null}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

export default function PullRequestsScreen({ route, navigation }) {
  const { projects, setActiveAgentId, setActiveSessionId } = useApp();
  const { openSidebar } = useContext(SidebarContext);

  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = projects?.find((p) => p.id === projectId);
  const resolveAgentId = resolveAgentIdFromProject(project);

  const [state, setState] = useState('open');
  const [pulls, setPulls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [selectedNumber, setSelectedNumber] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [resolving, setResolving] = useState(false);

  const loadList = useCallback(async () => {
    if (!projectId) {
      setError('No project selected.');
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const data = await api.getProjectPulls(projectId, { state, limit: 50 });
      setPulls(data.pulls || []);
    } catch (err) {
      console.warn('Failed to load PRs:', err?.message || err);
      setError(err?.message || 'Failed to load PRs');
      setPulls([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId, state]);

  useEffect(() => {
    setLoading(true);
    loadList();
  }, [loadList]);

  const loadDetail = useCallback(
    async (number) => {
      if (!projectId || !number) return;
      setDetailLoading(true);
      setDetailError(null);
      try {
        const data = await api.getProjectPullDetail(projectId, number);
        setDetail(data);
      } catch (err) {
        console.warn('Failed to load PR detail:', err?.message || err);
        setDetailError(err?.message || 'Failed to load PR');
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [projectId],
  );

  const handleSelect = (pr) => {
    setSelectedNumber(pr.number);
    setDetail(null);
    loadDetail(pr.number);
  };

  const handleBack = () => {
    setSelectedNumber(null);
    setDetail(null);
    setDetailError(null);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    if (selectedNumber) {
      loadDetail(selectedNumber).finally(() => setRefreshing(false));
    } else {
      loadList();
    }
  };

  // Spawn an agent session to resolve the selected PR (CI failures, review
  // feedback, or merge conflicts). Mirrors the web's `handleResolve` in
  // `client/src/components/PullRequestsPage.jsx`.
  const handleResolve = useCallback(async () => {
    if (!projectId || !selectedNumber || !resolveAgentId || resolving) return;
    setResolving(true);
    try {
      const res = await api.resolvePR(projectId, selectedNumber, { agentId: resolveAgentId });
      if (res?.sessionId) {
        // Jump into the resolver session in the Chat screen.
        setActiveAgentId(resolveAgentId);
        setActiveSessionId(res.sessionId);
        const kinds = Array.isArray(res.triggered) ? res.triggered.join(', ') : '';
        if (navigation?.navigate) {
          navigation.navigate('Chat');
        }
        Alert.alert(
          'Resolve PR',
          kinds ? `Resolving PR — ${kinds}` : 'Resolving PR — agent session started',
        );
      } else {
        Alert.alert('Resolve PR', 'Nothing to resolve — PR looks clean.');
      }
    } catch (err) {
      const msg = err?.message || 'Failed to resolve PR';
      Alert.alert('Resolve PR failed', msg);
    } finally {
      setResolving(false);
    }
  }, [
    projectId,
    selectedNumber,
    resolveAgentId,
    resolving,
    navigation,
    setActiveAgentId,
    setActiveSessionId,
  ]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'\u2630'}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {selectedNumber ? `PR #${selectedNumber}` : `${project?.name || 'Project'} · PRs`}
        </Text>
      </View>

      {/* Detail view */}
      {selectedNumber ? (
        <>
          {detailLoading && !detail && (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.gray400} />
            </View>
          )}
          {detailError && !detailLoading && (
            <View style={styles.centered}>
              <Text style={styles.errorText}>{detailError}</Text>
              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => loadDetail(selectedNumber)}
              >
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.backButton} onPress={handleBack}>
                <Text style={styles.backButtonText}>{'\u2190'} Back</Text>
              </TouchableOpacity>
            </View>
          )}
          {detail && (
            <PrDetail
              detail={detail}
              projectId={projectId}
              onBack={handleBack}
              onRefresh={handleRefresh}
              refreshing={refreshing}
              onResolve={handleResolve}
              resolving={resolving}
              canResolve={Boolean(resolveAgentId)}
            />
          )}
        </>
      ) : (
        <>
          {/* State tabs */}
          <View style={styles.tabs}>
            {STATE_TABS.map((tab) => (
              <TouchableOpacity
                key={tab.key}
                style={[styles.tab, state === tab.key && styles.tabActive]}
                onPress={() => setState(tab.key)}
              >
                <Text style={[styles.tabText, state === tab.key && styles.tabTextActive]}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {loading && pulls.length === 0 && (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.gray400} />
            </View>
          )}

          {!loading && error && (
            <View style={styles.centered}>
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={loadList}>
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}

          {!loading && !error && pulls.length === 0 && (
            <View style={styles.centered}>
              <Text style={styles.emptyText}>No {state} pull requests.</Text>
            </View>
          )}

          <FlatList
            data={pulls}
            keyExtractor={(item) => String(item.number)}
            renderItem={({ item }) => <PrListItem pr={item} onPress={() => handleSelect(item)} />}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                tintColor={colors.gray400}
              />
            }
            contentContainerStyle={{ paddingVertical: 8 }}
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.gray950,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  menuButton: { padding: 6 },
  menuIcon: { color: colors.gray300, fontSize: 20 },
  headerTitle: {
    flex: 1,
    color: colors.white,
    fontSize: 16,
    fontWeight: '600',
  },
  tabs: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.gray800,
  },
  tabActive: {
    backgroundColor: colors.gray700,
  },
  tabText: { color: colors.gray400, fontSize: 13, fontWeight: '500' },
  tabTextActive: { color: colors.white },

  listItem: {
    marginHorizontal: 12,
    marginVertical: 5,
    padding: 12,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  listItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  listItemFooter: {
    marginTop: 4,
  },
  prNumber: { color: colors.gray400, fontSize: 12, fontWeight: '500' },
  prTitle: { color: colors.white, fontSize: 15, fontWeight: '500' },
  metaText: { color: colors.gray400, fontSize: 12, marginTop: 2 },
  timeText: { color: colors.gray500, fontSize: 11 },
  diffText: { color: colors.gray400, fontSize: 12, marginTop: 4, fontVariant: ['tabular-nums'] },
  labelsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
  label: {
    backgroundColor: colors.gray800,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  labelText: { color: colors.gray300, fontSize: 10 },

  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  badgeText: { fontSize: 11, fontWeight: '600' },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  errorText: { color: colors.red400, textAlign: 'center', marginBottom: 12 },
  emptyText: { color: colors.gray500, textAlign: 'center' },
  retryButton: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.gray800,
    borderRadius: 6,
  },
  retryButtonText: { color: colors.white, fontSize: 13 },
  backButton: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  backButtonText: { color: colors.blue400, fontSize: 13 },
  detailTopActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  resolveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 32,
    minWidth: 110,
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  resolveButtonDisabled: { opacity: 0.5 },
  resolveButtonText: { color: colors.gray200, fontSize: 13, fontWeight: '500' },
  resolveButtonTextDisabled: { color: colors.gray500 },

  detailScroll: { flex: 1 },
  detailContent: { padding: 16 },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  detailTitle: {
    color: colors.white,
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  openGithubButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.gray800,
    borderRadius: 6,
  },
  openGithubText: { color: colors.blue400, fontSize: 13 },
  summaryStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 16,
    marginBottom: 8,
  },
  sectionHeader: {
    color: colors.gray300,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  checkIcon: { fontSize: 14, width: 18, textAlign: 'center' },
  checkName: { flex: 1, color: colors.white, fontSize: 13 },
  checkState: { color: colors.gray500, fontSize: 11 },
  reviewBlock: {
    padding: 10,
    marginVertical: 4,
    backgroundColor: colors.gray900,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  reviewUser: { color: colors.gray300, fontSize: 13, fontWeight: '500' },
  reviewState: { fontSize: 11, fontWeight: '600' },
  reviewTime: { color: colors.gray500, fontSize: 11, marginLeft: 'auto' },
  reviewBody: { color: colors.gray300, fontSize: 13, lineHeight: 18 },
});
