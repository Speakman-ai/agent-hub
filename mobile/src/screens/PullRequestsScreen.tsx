import React, { useState, useEffect, useCallback, useContext, useRef } from 'react';
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
  reviewDecisionListBadge,
  mergePipelineListBadge,
  buildPrActivityTimeline,
} from '../utils/prFormatting';
import { resolveAgentIdFromProject } from '../utils/projectAgents';
import { isWorkflowProject } from '../utils/project-mode';
import { prDetailCapabilities, canDismissReview } from '../utils/prReviewActions';
import { prPreviewViewState } from '@shared/utils/prPreview';
import {
  appendPrPage,
  canLoadMore,
  createListRequestGate,
  initialPrPaging,
  pagingAfterFailure,
  pagingAfterPage,
} from '../utils/prPaging';
import PrDiffView from '../components/PrDiffView';
import PrReviewSheet from '../components/PrReviewSheet';
import PrCommentSheet from '../components/PrCommentSheet';
import PrEditSheet from '../components/PrEditSheet';
import PrDismissSheet from '../components/PrDismissSheet';
const STATE_TABS = [
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];
/** Rows per request. Older PRs are reachable through the "Load more" footer. */
const PAGE_SIZE = 25;
function Badge({ label, color, bg, title }: any) {
  const a11y = title ? `${label}. ${title}` : label;
  return (
    <View
      style={[styles.badge, { backgroundColor: bg || colors.gray700_40 }]}
      accessibilityLabel={a11y}
    >
      <Text style={[styles.badgeText, { color: color || colors.gray400 }]}>{label}</Text>
    </View>
  );
}
function PrListItem({
  pr,
  onPress,
  onResolveRow,
  resolveAgentId,
  resolvingThisRow,
  bulkResolving,
  spawnedSessionId,
  onOpenChat,
}: any) {
  const state = prStateBadge(pr);
  const diff = diffSummary(pr);
  const showCi = Array.isArray(pr.check_rollup) && pr.check_rollup.length > 0;
  const ciBadge = showCi ? checksBadge(summarizeChecks(pr.check_rollup)) : null;
  const reviewB = reviewDecisionListBadge(pr.review_decision);
  const mBadge = mergeableBadge(pr.mergeable);
  const pipeB = mergePipelineListBadge(pr);
  const resolveBusy = bulkResolving || resolvingThisRow;
  const resolveDisabled = !resolveAgentId || resolveBusy;
  return (
    <View style={styles.listItemRow}>
      <TouchableOpacity style={styles.listItemMain} onPress={onPress} activeOpacity={0.7}>
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
        {(ciBadge || reviewB || mBadge.show || pipeB) && (
          <View style={[styles.labelsRow, { marginTop: 8 }]}>
            {ciBadge ? <Badge label={ciBadge.label} color={ciBadge.color} bg={ciBadge.bg} /> : null}
            {reviewB ? <Badge label={reviewB.label} color={reviewB.color} bg={reviewB.bg} /> : null}
            {mBadge.show ? (
              <Badge
                label={mBadge.label}
                color={mBadge.good ? colors.emerald400 : colors.red400}
                bg={mBadge.good ? colors.emerald900_40 : colors.red900_50}
              />
            ) : null}
            {pipeB ? (
              <Badge label={pipeB.label} color={pipeB.color} bg={pipeB.bg} title={pipeB.title} />
            ) : null}
          </View>
        )}
        {Array.isArray(pr.labels) && pr.labels.length > 0 && (
          <View style={styles.labelsRow}>
            {pr.labels.slice(0, 4).map((l: any) => (
              <View key={l.name} style={styles.label}>
                <Text style={styles.labelText} numberOfLines={1}>
                  {l.name}
                </Text>
              </View>
            ))}
          </View>
        )}
      </TouchableOpacity>
      <View style={styles.listRowActions}>
        {spawnedSessionId ? (
          <View
            style={styles.listRowStarted}
            accessibilityLabel={`Session started for PR #${pr.number}`}
          >
            <Text style={styles.listRowStartedCheck}>{'\u2713'}</Text>
            <Text style={styles.listRowStartedCaption} numberOfLines={2}>
              Started
            </Text>
            {typeof onOpenChat === 'function' && resolveAgentId ? (
              <TouchableOpacity
                onPress={() => onOpenChat(spawnedSessionId)}
                accessibilityLabel="Open chat"
                style={styles.listRowOpenChat}
              >
                <Text style={styles.listRowOpenChatText}>Open chat</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.listRowResolveButton, resolveDisabled && styles.resolveButtonDisabled]}
            onPress={() => onResolveRow(pr.number)}
            disabled={resolveDisabled}
            accessibilityLabel={`Resolve PR #${pr.number}`}
            accessibilityState={{ disabled: resolveDisabled, busy: resolvingThisRow }}
          >
            {resolvingThisRow ? (
              <ActivityIndicator size="small" color={colors.gray300} />
            ) : (
              <Text style={styles.listRowResolveButtonText}>{'Fix'}</Text>
            )}
            <Text
              style={[
                styles.listRowResolveButtonCaption,
                resolveDisabled && styles.resolveButtonTextDisabled,
              ]}
              numberOfLines={2}
            >
              Resolve PR
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}
function PrActivityBlock({ pr, detail, styles }: any) {
  const activity = buildPrActivityTimeline(pr, detail);
  if (!activity.length) {
    return <Text style={styles.emptyText}>No recorded activity for this pull request.</Text>;
  }
  return (
    <View style={{ marginBottom: 16 }}>
      {activity.map((item: any) => (
        <View key={item.id} style={styles.activityItem}>
          <Text style={styles.activityGlyph} accessibilityLabel={item.kind}>
            {item.kind === 'opened'
              ? 'O'
              : item.kind === 'merged'
                ? 'M'
                : item.kind === 'closed'
                  ? '\u2715'
                  : item.kind === 'review'
                    ? 'R'
                    : item.kind === 'comment'
                      ? 'C'
                      : '\u2022'}
          </Text>
          <View style={styles.activityBody}>
            <ActivityRowBody item={item} styles={styles} />
          </View>
        </View>
      ))}
    </View>
  );
}
function ActivityRowBody({ item, styles }: any) {
  const k = item.kind;
  const time =
    typeof item.at === 'string'
      ? relativePrTime(item.at)
      : item.atMs
        ? relativePrTime(new Date(item.atMs).toISOString())
        : '';
  if (k === 'opened') {
    const u = item.user ? `@${item.user}` : 'someone';
    return (
      <Text style={styles.activityLine}>
        <Text style={styles.activityStrong}>Opened</Text> by {u}
        {time ? <Text style={styles.activityMuted}> · {time}</Text> : null}
      </Text>
    );
  }
  if (k === 'merged') {
    return (
      <Text style={styles.activityLine}>
        <Text style={styles.activityStrong}>Merged</Text>
        {time ? <Text style={styles.activityMuted}> · {time}</Text> : null}
      </Text>
    );
  }
  if (k === 'closed') {
    return (
      <Text style={styles.activityLine}>
        <Text style={styles.activityStrong}>Closed</Text> without merging
        {time ? <Text style={styles.activityMuted}> · {time}</Text> : null}
      </Text>
    );
  }
  if (k === 'review' && item.review) {
    const r = item.review;
    const s = (r.state || '').toUpperCase();
    let c = colors.gray400;
    if (s === 'APPROVED') c = colors.emerald400;
    else if (s === 'CHANGES_REQUESTED') c = colors.red400;
    else if (s === 'COMMENTED') c = colors.blue400;
    return (
      <View style={styles.reviewBlock}>
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
  }
  if (k === 'comment' && item.comment) {
    const c = item.comment;
    return (
      <View style={styles.reviewBlock}>
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
    );
  }
  return null;
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
  spawnedSessionId,
  onOpenChat,
}: any) {
  const pr = detail?.pr;
  const caps = prDetailCapabilities(detail);
  // PR actions (diff / review / comment / edit / reopen) — web parity.
  const [showFiles, setShowFiles] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [togglingAutoMerge, setTogglingAutoMerge] = useState(false);
  // The review currently being dismissed (drives the dismiss sheet), or null.
  const [dismissTarget, setDismissTarget] = useState<any>(null);
  // Which dismissed review's collapsed body the user chose to expand.
  const [expandedDismissedId, setExpandedDismissedId] = useState<any>(null);
  const prNumber = pr?.number;

  // ── PR-scoped preview (web parity) ──────────────────────────────────
  const [previewStateResp, setPreviewStateResp] = useState<any>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewView = prPreviewViewState(previewStateResp, { pending: previewPending });
  const previewStatus = previewView.status;
  // The PR we've already auto-started (default-on projects), so opening a PR
  // does not restart it or fight the reaper.
  const autoStartedRef = useRef<number | null>(null);
  // The PR currently shown. A `/preview/state` request captures the PR it was
  // issued for; if this ref has moved on by the time it resolves, the response
  // is stale and must NOT mutate state (else it paints the previous PR's
  // link/failure onto the newly opened one).
  const currentPrRef = useRef<number | null>(prNumber ?? null);

  useEffect(() => {
    currentPrRef.current = prNumber ?? null;
    setPreviewStateResp(null);
    setPreviewPending(false);
    setPreviewBusy(false);
    autoStartedRef.current = null;
  }, [prNumber]);

  const refreshPreview = useCallback(async () => {
    if (!caps.canPreview || !prNumber) return null;
    const requested = prNumber;
    try {
      const res = await api.getPullPreviewState(projectId, requested);
      // Drop a response for a PR the user already navigated away from.
      if (requested !== currentPrRef.current) return null;
      setPreviewStateResp(res);
      if (res?.preview) setPreviewPending(false);
      return res;
    } catch {
      return null;
    }
  }, [caps.canPreview, projectId, prNumber]);

  const handleEnablePreview = useCallback(async () => {
    if (!prNumber) return;
    // Capture the PR this operation is for; discard every UI mutation below if
    // the user has since navigated to another PR (else a late catch/finally
    // clears the new PR's pending/busy state).
    const requested = prNumber;
    setPreviewBusy(true);
    setPreviewPending(true);
    try {
      await api.startPullPreview(projectId, requested, { reason: `PR #${requested} preview` });
      await refreshPreview();
    } catch (err: any) {
      if (requested !== currentPrRef.current) return;
      setPreviewPending(false);
      Alert.alert('Preview failed', err?.message || 'Failed to start preview');
    } finally {
      if (requested === currentPrRef.current) setPreviewBusy(false);
    }
  }, [projectId, prNumber, refreshPreview]);

  const handleStopPreview = useCallback(async () => {
    if (!prNumber) return;
    const requested = prNumber;
    setPreviewBusy(true);
    try {
      await api.stopPullPreview(projectId, requested);
      if (requested === currentPrRef.current) setPreviewPending(false);
      await refreshPreview();
    } catch (err: any) {
      if (requested === currentPrRef.current) {
        Alert.alert('Stop failed', err?.message || 'Failed to stop preview');
      }
    } finally {
      if (requested === currentPrRef.current) setPreviewBusy(false);
    }
  }, [projectId, prNumber, refreshPreview]);

  // Hydrate the CURRENT preview state whenever the PR detail opens — even when
  // the project default is off — so an already-running/failed preview shows
  // instead of a misleading idle state. Auto-start when the project opts every
  // PR in and nothing is running.
  useEffect(() => {
    if (!caps.canPreview || !prNumber) return;
    let alive = true;
    (async () => {
      const res = await refreshPreview();
      if (!alive) return;
      const hydrated = prPreviewViewState(res).status;
      if (caps.previewDefaultOn && hydrated === 'idle' && autoStartedRef.current !== prNumber) {
        autoStartedRef.current = prNumber;
        void handleEnablePreview();
      }
    })();
    return () => {
      alive = false;
    };
    // handleEnablePreview is guarded by autoStartedRef; excluding it keeps this
    // to a single hydrate per PR.
  }, [caps.canPreview, caps.previewDefaultOn, prNumber, refreshPreview]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while a preview is booting (Enable, auto-start, or a boot already in
  // flight when the PR was opened).
  useEffect(() => {
    if (!caps.canPreview || previewStatus !== 'loading') return;
    const timer = setTimeout(() => {
      void refreshPreview();
    }, 2500);
    return () => clearTimeout(timer);
  }, [caps.canPreview, previewStatus, previewStateResp, refreshPreview]);

  // Sheets throw on failure so they can render the error inline and stay
  // open; success closes the sheet and refreshes the detail payload.
  const handleSubmitReview = useCallback(
    async (payload: any) => {
      await api.submitPullReview(projectId, prNumber, payload);
      onRefresh();
    },
    [projectId, prNumber, onRefresh],
  );
  const handleSaveEdit = useCallback(
    async (payload: any) => {
      await api.updatePull(projectId, prNumber, payload);
      onRefresh();
    },
    [projectId, prNumber, onRefresh],
  );
  const handleAddInlineComment = useCallback(
    async (payload: any) => {
      await api.addPullComment(projectId, prNumber, payload);
      onRefresh();
    },
    [projectId, prNumber, onRefresh],
  );
  const handleSetThreadResolved = useCallback(
    async (payload: any) => {
      await api.setPullCommentThreadResolved(projectId, prNumber, payload);
      onRefresh();
    },
    [projectId, prNumber, onRefresh],
  );
  const handleDismissReview = useCallback(
    async (payload: any) => {
      if (!dismissTarget?.id) return;
      await api.dismissPullReview(projectId, prNumber, dismissTarget.id, payload);
      onRefresh();
    },
    [projectId, prNumber, dismissTarget, onRefresh],
  );
  const handleReopen = useCallback(async () => {
    if (reopening || !prNumber) return;
    setReopening(true);
    try {
      await api.reopenPull(projectId, prNumber);
      onRefresh();
    } catch (err: any) {
      Alert.alert('Reopen failed', err?.message || 'Failed to reopen PR');
    } finally {
      setReopening(false);
    }
  }, [projectId, prNumber, reopening, onRefresh]);
  // Confirmed before it runs: this writes a commit to the base branch and
  // pushes it on to the GitHub mirror (web parity, which asks twice).
  const runRevert = useCallback(async () => {
    setReverting(true);
    try {
      await api.revertPull(projectId, prNumber);
      onRefresh();
    } catch (err: any) {
      Alert.alert('Revert failed', err?.message || 'Failed to revert PR');
    } finally {
      setReverting(false);
    }
  }, [projectId, prNumber, onRefresh]);
  const handleToggleAutoMerge = useCallback(async () => {
    if (togglingAutoMerge || !prNumber) return;
    const next = !caps.autoMergeEnabled;
    setTogglingAutoMerge(true);
    try {
      await api.setPullAutoMerge(projectId, prNumber, next);
      onRefresh();
    } catch (err: any) {
      Alert.alert('Auto-merge failed', err?.message || 'Failed to update auto-merge');
    } finally {
      setTogglingAutoMerge(false);
    }
  }, [projectId, prNumber, togglingAutoMerge, caps.autoMergeEnabled, onRefresh]);
  const handleRevert = useCallback(() => {
    if (reverting || !prNumber) return;
    Alert.alert(
      `Revert PR #${prNumber}?`,
      `This commits the inverse of the merge on ${pr?.base || 'the base branch'} and pushes it to the GitHub mirror. History is not rewritten.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Revert', style: 'destructive', onPress: () => void runRevert() },
      ],
    );
  }, [prNumber, pr?.base, reverting, runRevert]);
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
        {spawnedSessionId ? (
          <View style={styles.detailSessionStarted}>
            <Text style={styles.detailSessionStartedText}>{'\u2713'} Session started</Text>
            {typeof onOpenChat === 'function' ? (
              <TouchableOpacity onPress={onOpenChat} accessibilityLabel="Open chat">
                <Text style={styles.detailOpenChatText}>Open chat</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : (
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
                Resolve PR
              </Text>
            )}
          </TouchableOpacity>
        )}
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
          {pr.labels.map((l: any) => (
            <View key={l.name} style={styles.label}>
              <Text style={styles.labelText}>{l.name}</Text>
            </View>
          ))}
        </View>
      )}

      {/* External link only for real GitHub URLs \u2014 native PR URLs are
              in-app client routes with nothing external to open. */}
      {caps.externalUrl ? (
        <TouchableOpacity
          style={styles.openGithubButton}
          onPress={() => Linking.openURL(caps.externalUrl)}
        >
          <Text style={styles.openGithubText}>Open on GitHub {'\u2197'}</Text>
        </TouchableOpacity>
      ) : null}

      {/* PR-scoped preview (web parity) */}
      {caps.canPreview ? (
        <View style={styles.previewPanel} accessibilityLabel="PR preview">
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>Preview</Text>
            {previewView.status === 'idle' ? (
              <TouchableOpacity
                style={styles.prActionButton}
                onPress={handleEnablePreview}
                disabled={previewBusy}
                accessibilityLabel="Enable preview"
              >
                <Text style={styles.prActionButtonText}>Enable preview</Text>
              </TouchableOpacity>
            ) : null}
            {previewView.status === 'loading' ? (
              <View style={styles.previewStatusRow}>
                <ActivityIndicator size="small" color={colors.blue400} />
                <Text style={styles.previewStatusText}>Starting preview…</Text>
                <TouchableOpacity
                  style={styles.prActionButton}
                  onPress={handleStopPreview}
                  disabled={previewBusy}
                  accessibilityLabel="Stop preview"
                >
                  <Text style={styles.prActionButtonText}>Stop</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {previewView.status === 'ready' ? (
              <View style={styles.previewStatusRow}>
                <TouchableOpacity
                  style={styles.prActionButton}
                  onPress={() => previewView.url && Linking.openURL(previewView.url)}
                  disabled={!previewView.url}
                  accessibilityLabel="Open preview"
                >
                  <Text style={styles.prActionButtonText}>Open preview {'↗'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.prActionButton}
                  onPress={handleStopPreview}
                  disabled={previewBusy}
                  accessibilityLabel="Tear down preview"
                >
                  <Text style={styles.prActionButtonText}>Tear down</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {previewView.status === 'failed' ? (
              <TouchableOpacity
                style={styles.prActionButton}
                onPress={handleEnablePreview}
                disabled={previewBusy}
                accessibilityLabel="Retry preview"
              >
                <Text style={styles.prActionButtonText}>Retry</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {previewView.status === 'failed' ? (
            <Text style={styles.previewError} accessibilityLabel="Preview error">
              {previewView.reason}
            </Text>
          ) : null}
        </View>
      ) : caps.previewArchived ? (
        <View style={styles.previewPanel} accessibilityLabel="PR preview unavailable">
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>Preview</Text>
            <Text style={styles.previewStatusText} accessibilityLabel="Preview unavailable">
              Unavailable — session archived
            </Text>
          </View>
        </View>
      ) : null}

      {/* PR actions: diff, review, comment, edit, reopen */}
      <View style={styles.prActionsRow}>
        <TouchableOpacity
          style={[styles.prActionButton, !caps.canViewFiles && styles.resolveButtonDisabled]}
          onPress={() => setShowFiles((v: any) => !v)}
          disabled={!caps.canViewFiles}
          accessibilityState={{ disabled: !caps.canViewFiles, expanded: showFiles }}
        >
          <Text style={styles.prActionButtonText}>
            {showFiles ? 'Hide files' : `Files${pr.changed_files ? ` (${pr.changed_files})` : ''}`}
          </Text>
        </TouchableOpacity>
        {caps.canReview ? (
          <TouchableOpacity style={styles.prActionButton} onPress={() => setReviewOpen(true)}>
            <Text style={styles.prActionButtonText}>Review</Text>
          </TouchableOpacity>
        ) : null}
        {caps.canComment ? (
          <TouchableOpacity style={styles.prActionButton} onPress={() => setCommentOpen(true)}>
            <Text style={styles.prActionButtonText}>Comment</Text>
          </TouchableOpacity>
        ) : null}
        {caps.canEdit ? (
          <TouchableOpacity style={styles.prActionButton} onPress={() => setEditOpen(true)}>
            <Text style={styles.prActionButtonText}>Edit</Text>
          </TouchableOpacity>
        ) : null}
        {caps.canReopen ? (
          <TouchableOpacity
            style={[styles.prActionButton, reopening && styles.resolveButtonDisabled]}
            onPress={handleReopen}
            disabled={reopening}
            accessibilityState={{ disabled: reopening, busy: reopening }}
          >
            {reopening ? (
              <ActivityIndicator size="small" color={colors.emerald400} />
            ) : (
              <Text style={[styles.prActionButtonText, { color: colors.emerald400 }]}>Reopen</Text>
            )}
          </TouchableOpacity>
        ) : null}
        {caps.canRevert ? (
          <TouchableOpacity
            style={[styles.prActionButton, reverting && styles.resolveButtonDisabled]}
            onPress={handleRevert}
            disabled={reverting}
            accessibilityLabel="Revert PR"
            accessibilityState={{ disabled: reverting, busy: reverting }}
          >
            {reverting ? (
              <ActivityIndicator size="small" color={colors.amber400} />
            ) : (
              <Text style={[styles.prActionButtonText, { color: colors.amber400 }]}>Revert</Text>
            )}
          </TouchableOpacity>
        ) : null}
        {caps.canAutoMerge ? (
          <TouchableOpacity
            style={[styles.prActionButton, togglingAutoMerge && styles.resolveButtonDisabled]}
            onPress={handleToggleAutoMerge}
            disabled={togglingAutoMerge}
            accessibilityLabel="Toggle auto-merge"
            accessibilityState={{
              disabled: togglingAutoMerge,
              busy: togglingAutoMerge,
              selected: caps.autoMergeEnabled,
            }}
          >
            {togglingAutoMerge ? (
              <ActivityIndicator size="small" color={colors.emerald400} />
            ) : (
              <Text
                style={[
                  styles.prActionButtonText,
                  caps.autoMergeEnabled && { color: colors.emerald400 },
                ]}
              >
                {caps.autoMergeEnabled ? 'Auto-merge on' : 'Auto-merge'}
              </Text>
            )}
          </TouchableOpacity>
        ) : null}
      </View>

      {pr.body ? (
        <>
          <Text style={styles.sectionHeader}>Description</Text>
          <Text style={styles.descriptionText}>{pr.body}</Text>
        </>
      ) : null}

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

      {showFiles ? (
        <>
          <Text style={styles.sectionHeader}>Files changed</Text>
          <PrDiffView
            prUrl={caps.prUrl}
            comments={caps.isNative ? detail.inline_comments || [] : []}
            onAddComment={caps.canComment ? handleAddInlineComment : null}
            onSetResolved={caps.isNative ? handleSetThreadResolved : null}
          />
        </>
      ) : null}

      {caps.isNative && Array.isArray(detail.reviews) && detail.reviews.length > 0 ? (
        <>
          <Text style={styles.sectionHeader}>Reviews</Text>
          {detail.reviews.map((r: any, i: any) => {
            const s = String(r.state || '').toUpperCase();
            let c = colors.gray400;
            if (s === 'APPROVED') c = colors.emerald400;
            else if (s === 'CHANGES_REQUESTED') c = colors.red400;
            else if (s === 'COMMENTED') c = colors.blue400;
            return (
              <View key={r.id || i} style={[styles.reviewBlock, r.dismissed && { opacity: 0.7 }]}>
                <View style={styles.reviewHeader}>
                  <Text style={styles.reviewUser}>@{r.user || 'unknown'}</Text>
                  <Text style={[styles.reviewState, { color: r.dismissed ? colors.gray500 : c }]}>
                    {s || 'REVIEW'}
                  </Text>
                  {r.dismissed ? (
                    <Text style={[styles.reviewState, { color: colors.gray400 }]}>· dismissed</Text>
                  ) : null}
                  <View style={{ flex: 1 }} />
                  {canDismissReview(detail, r) ? (
                    <TouchableOpacity
                      onPress={() => setDismissTarget(r)}
                      accessibilityLabel={`Dismiss review by ${r.user || 'unknown'}`}
                    >
                      <Text style={[styles.prActionButtonText, { color: colors.gray400 }]}>
                        Dismiss
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                {r.body && (!r.dismissed || expandedDismissedId === (r.id || i)) ? (
                  <Text style={styles.reviewBody} numberOfLines={6}>
                    {r.body}
                  </Text>
                ) : null}
                {r.dismissed && r.dismissal_reason ? (
                  <Text style={[styles.reviewBody, { color: colors.gray500, fontStyle: 'italic' }]}>
                    Dismissed{r.dismissed_by ? ` by @${r.dismissed_by}` : ''}: {r.dismissal_reason}
                  </Text>
                ) : null}
                {r.dismissed && r.body ? (
                  <TouchableOpacity
                    onPress={() =>
                      setExpandedDismissedId((cur: any) => (cur === (r.id || i) ? null : r.id || i))
                    }
                  >
                    <Text style={[styles.reviewTime, { color: colors.gray500 }]}>
                      {expandedDismissedId === (r.id || i)
                        ? 'Hide review'
                        : 'Show dismissed review'}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          })}
        </>
      ) : null}

      <Text style={styles.activitySectionHeader}>Activity</Text>
      <Text style={styles.activitySub}>
        Chronological history from GitHub (open/merge/close, reviews, and issue comments).
      </Text>
      <PrActivityBlock detail={detail} pr={pr} styles={styles} />

      {/* CI Checks list */}
      <Text style={styles.sectionHeader}>CI Checks</Text>
      {(!detail.checks || detail.checks.length === 0) && (
        <Text style={styles.emptyText}>No checks reported.</Text>
      )}
      {Array.isArray(detail.checks) &&
        detail.checks.map((chk: any, i: any) => {
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

      <View style={{ height: 40 }} />

      <PrReviewSheet
        visible={reviewOpen}
        prNumber={pr.number}
        onClose={() => setReviewOpen(false)}
        onSubmit={handleSubmitReview}
      />
      <PrCommentSheet
        visible={commentOpen}
        prNumber={pr.number}
        onClose={() => setCommentOpen(false)}
        onSubmit={handleSubmitReview}
      />
      <PrEditSheet
        visible={editOpen}
        pr={pr}
        onClose={() => setEditOpen(false)}
        onSubmit={handleSaveEdit}
      />
      <PrDismissSheet
        visible={!!dismissTarget}
        prNumber={pr.number}
        reviewer={dismissTarget?.user}
        onClose={() => setDismissTarget(null)}
        onSubmit={handleDismissReview}
      />
    </ScrollView>
  );
}
/**
 * List footer for append-style paging.
 *
 * A failed "Load more" leaves `hasMore` alone — a dropped request tells us
 * nothing about whether more pages exist — and offers a retry, so a flaky
 * network can't permanently strand the rest of the list behind a footer that
 * silently disappeared.
 */
export function LoadMoreFooter({ hasMore, loading, error, onPress }: any) {
  if (!hasMore) return null;
  if (loading) {
    return (
      <View style={styles.loadMoreButton}>
        <ActivityIndicator color={colors.gray400} />
      </View>
    );
  }
  return (
    <TouchableOpacity style={styles.loadMoreButton} onPress={onPress}>
      {error ? (
        <>
          <Text style={styles.loadMoreErrorText}>{String(error)}</Text>
          <Text style={styles.loadMoreText}>Tap to retry</Text>
        </>
      ) : (
        <Text style={styles.loadMoreText}>Load more</Text>
      )}
    </TouchableOpacity>
  );
}
export default function PullRequestsScreen({ route, navigation }: any) {
  const { projects, setActiveAgentId, setActiveSessionId } = useApp();
  const { openSidebar } = useContext(SidebarContext);
  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = projects?.find((p: any) => p.id === projectId);
  const resolveAgentId = resolveAgentIdFromProject(project);
  const [state, setState] = useState('open');
  const [pulls, setPulls] = useState<any[]>([]);
  const [paging, setPaging] = useState(initialPrPaging);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Shared by both list fetches so a superseded response can never write the list. */
  const listGateRef = useRef(createListRequestGate());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<any>(null);
  const [selectedNumber, setSelectedNumber] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<any>(null);
  const [resolving, setResolving] = useState(false);
  const [resolvingFromList, setResolvingFromList] = useState<any>(null);
  const [bulkResolving, setBulkResolving] = useState(false);
  const [sessionSpawnedByPr, setSessionSpawnedByPr] = useState<any>({});
  useEffect(() => {
    if (!projectId || !project) return;
    if (!isWorkflowProject(project)) return;
    const id = requestAnimationFrame(() => {
      Alert.alert(
        'Workflow mode',
        'Pull requests are hidden for workflow projects. Switch the project to dev mode in Settings if you need this screen.',
        [
          {
            text: 'OK',
            onPress: () => {
              if (navigation?.canGoBack?.()) navigation.goBack();
              else navigation?.navigate?.('Chat');
            },
          },
        ],
      );
    });
    return () => cancelAnimationFrame(id);
  }, [projectId, project, navigation]);
  const openResolverChat = useCallback(
    (sessionId: any) => {
      if (!sessionId || !resolveAgentId) return;
      setActiveAgentId(resolveAgentId);
      setActiveSessionId(sessionId);
      navigation?.navigate?.('Chat');
    },
    [resolveAgentId, setActiveAgentId, setActiveSessionId, navigation],
  );
  const loadList = useCallback(async () => {
    if (!projectId) {
      setError('No project selected.');
      setLoading(false);
      return;
    }
    // Claim the newest list request. A tab switch, project switch or
    // refresh started while a page is in flight invalidates that page, so
    // its rows can never land in the list they no longer belong to.
    const token = listGateRef.current.begin();
    try {
      setError(null);
      const data = await api.getProjectPulls(projectId, { state, limit: PAGE_SIZE, page: 1 });
      if (!listGateRef.current.isCurrent(token)) return;
      setPulls(data.pulls || []);
      setPaging(pagingAfterPage({ page: 1, hasMore: data.hasMore }));
    } catch (err: any) {
      if (!listGateRef.current.isCurrent(token)) return;
      console.warn('Failed to load PRs:', err?.message || err);
      setError(err?.message || 'Failed to load PRs');
      setPulls([]);
      setPaging(initialPrPaging);
    } finally {
      if (listGateRef.current.isCurrent(token)) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [projectId, state]);
  // Append-style paging: the list keeps what's already on screen and pulls
  // the next page in behind it. A failed fetch preserves `hasMore` (see
  // prPaging.ts) so the footer stays available as a retry.
  const loadMore = useCallback(async () => {
    // A whole-list load in flight owns the list, so no page is appended on
    // top of results that are about to be replaced.
    if (!projectId || !canLoadMore(paging, loadingMore || loading || refreshing)) return;
    const next = paging.page + 1;
    // Capture, don't claim: a page append rides on the list generation it
    // was requested for. A reload started meanwhile retires this token and
    // the response is dropped.
    const token = listGateRef.current.current();
    setLoadingMore(true);
    try {
      const data = await api.getProjectPulls(projectId, { state, limit: PAGE_SIZE, page: next });
      if (!listGateRef.current.isCurrent(token)) return;
      setPulls((prev: any[]) => appendPrPage(prev, data.pulls || []));
      setPaging(pagingAfterPage({ page: next, hasMore: data.hasMore }));
    } catch (err: any) {
      if (!listGateRef.current.isCurrent(token)) return;
      console.warn('Failed to load more PRs:', err?.message || err);
      setPaging((prev: any) =>
        pagingAfterFailure(prev, err?.message || 'Failed to load more pull requests'),
      );
    } finally {
      // Unconditional: this flag belongs to this request alone, and
      // nothing else clears it. Gating it on the token would leave a
      // superseded page spinning forever, blocking every later press.
      setLoadingMore(false);
    }
  }, [projectId, state, paging, loadingMore, loading, refreshing]);
  useEffect(() => {
    setLoading(true);
    loadList();
  }, [loadList]);
  const loadDetail = useCallback(
    async (number: any) => {
      if (!projectId || !number) return;
      setDetailLoading(true);
      setDetailError(null);
      try {
        const data = await api.getProjectPullDetail(projectId, number);
        setDetail(data);
      } catch (err: any) {
        console.warn('Failed to load PR detail:', err?.message || err);
        setDetailError(err?.message || 'Failed to load PR');
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [projectId],
  );
  // Deep-link: a PR review notification tap routes here with a target
  // `prNumber` (see AppContext `applyNotificationRoute`). Open that PR's
  // detail view directly instead of leaving the user on the list. Keyed on
  // the param so re-renders without a new target don't reopen after the user
  // backs out, but a fresh notification for a different PR still routes.
  const deepLinkedNumber = route?.params?.prNumber;
  useEffect(() => {
    if (deepLinkedNumber == null || !projectId) return;
    setSelectedNumber(deepLinkedNumber);
    setDetail(null);
    setDetailError(null);
    loadDetail(deepLinkedNumber);
  }, [deepLinkedNumber, projectId, loadDetail]);
  const handleSelect = (pr: any) => {
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
        setSessionSpawnedByPr((prev: any) => ({ ...prev, [selectedNumber]: res.sessionId }));
        const kinds = Array.isArray(res.triggered) ? res.triggered.join(', ') : '';
        Alert.alert(
          'Resolve PR',
          kinds ? `Resolving PR — ${kinds}` : 'Resolving PR — agent session started',
        );
      } else {
        Alert.alert('Resolve PR', 'Nothing to resolve — PR looks clean.');
      }
    } catch (err: any) {
      const msg = err?.message || 'Failed to resolve PR';
      Alert.alert('Resolve PR failed', msg);
    } finally {
      setResolving(false);
    }
  }, [projectId, selectedNumber, resolveAgentId, resolving]);
  const handleResolveFromList = useCallback(
    async (prNumber: any) => {
      if (!projectId || !resolveAgentId || bulkResolving || resolvingFromList != null) return;
      setResolvingFromList(prNumber);
      try {
        const res = await api.resolvePR(projectId, prNumber, { agentId: resolveAgentId });
        if (res?.sessionId) {
          setSessionSpawnedByPr((prev: any) => ({ ...prev, [prNumber]: res.sessionId }));
          const kinds = Array.isArray(res.triggered) ? res.triggered.join(', ') : '';
          Alert.alert(
            'Resolve PR',
            kinds
              ? `PR #${prNumber}: session started (${kinds})`
              : `PR #${prNumber}: agent session started`,
          );
        } else {
          Alert.alert('Resolve PR', `Nothing to resolve — PR #${prNumber} looks clean.`);
        }
      } catch (err: any) {
        const msg = err?.message || 'Failed to resolve PR';
        Alert.alert('Resolve PR failed', `PR #${prNumber}: ${msg}`);
      } finally {
        setResolvingFromList(null);
      }
    },
    [projectId, resolveAgentId, bulkResolving, resolvingFromList],
  );
  const handleResolveAll = useCallback(async () => {
    if (
      !projectId ||
      !resolveAgentId ||
      pulls.length === 0 ||
      bulkResolving ||
      resolvingFromList != null
    ) {
      return;
    }
    setBulkResolving(true);
    let spawned = 0;
    let clean = 0;
    let failed = 0;
    try {
      for (const pr of pulls) {
        try {
          const res = await api.resolvePR(projectId, pr.number, { agentId: resolveAgentId });
          if (res?.sessionId) {
            spawned += 1;
            setSessionSpawnedByPr((prev: any) => ({ ...prev, [pr.number]: res.sessionId }));
          } else {
            clean += 1;
          }
        } catch {
          failed += 1;
        }
      }
      const parts = [
        `${spawned} session(s) started`,
        `${clean} already clean`,
        failed ? `${failed} failed` : null,
      ].filter(Boolean);
      Alert.alert('Resolve all', `Finished: ${parts.join(', ')}.`);
    } finally {
      setBulkResolving(false);
    }
  }, [projectId, resolveAgentId, pulls, bulkResolving, resolvingFromList]);
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
        {!selectedNumber && pulls.length > 0 ? (
          <TouchableOpacity
            style={[styles.headerResolveAll, bulkResolving && styles.resolveButtonDisabled]}
            onPress={handleResolveAll}
            disabled={
              !resolveAgentId ||
              pulls.length === 0 ||
              bulkResolving ||
              resolvingFromList != null ||
              loading
            }
          >
            {bulkResolving ? (
              <ActivityIndicator size="small" color={colors.gray300} />
            ) : (
              <Text style={styles.headerResolveAllText}>Resolve all</Text>
            )}
          </TouchableOpacity>
        ) : null}
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
              spawnedSessionId={sessionSpawnedByPr[selectedNumber] || null}
              onOpenChat={
                sessionSpawnedByPr[selectedNumber]
                  ? () => openResolverChat(sessionSpawnedByPr[selectedNumber])
                  : undefined
              }
            />
          )}
        </>
      ) : (
        <>
          {/* State tabs */}
          <View style={styles.tabs}>
            {STATE_TABS.map((tab: any) => (
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
            keyExtractor={(item: any) => String(item.number)}
            renderItem={({ item }: any) => (
              <PrListItem
                pr={item}
                onPress={() => handleSelect(item)}
                onResolveRow={handleResolveFromList}
                resolveAgentId={resolveAgentId}
                resolvingThisRow={resolvingFromList === item.number}
                bulkResolving={bulkResolving}
                spawnedSessionId={sessionSpawnedByPr[item.number] || null}
                onOpenChat={openResolverChat}
              />
            )}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                tintColor={colors.gray400}
              />
            }
            contentContainerStyle={{ paddingVertical: 8 }}
            ListFooterComponent={
              <LoadMoreFooter
                hasMore={paging.hasMore}
                loading={loadingMore}
                error={paging.error}
                onPress={loadMore}
              />
            }
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
  listItemRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
    marginHorizontal: 12,
    marginVertical: 5,
    padding: 10,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  listItemMain: {
    flex: 1,
    minWidth: 0,
  },
  listRowActions: {
    flexDirection: 'column',
    gap: 6,
    alignItems: 'stretch',
  },
  listRowResolveButton: {
    width: 76,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  listRowResolveButtonText: { fontSize: 16, textAlign: 'center' },
  listRowResolveButtonCaption: {
    color: colors.gray200,
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 2,
  },
  listRowStarted: {
    width: 76,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  listRowStartedCheck: {
    color: colors.emerald400,
    fontSize: 18,
    fontWeight: '700',
  },
  listRowStartedCaption: {
    color: colors.emerald400,
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 2,
  },
  listRowOpenChat: { marginTop: 4, paddingVertical: 2 },
  listRowOpenChatText: { color: colors.blue400, fontSize: 10, fontWeight: '600' },
  headerResolveAll: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerResolveAllText: { color: colors.gray200, fontSize: 12, fontWeight: '600' },
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
  loadMoreButton: {
    marginTop: 8,
    marginHorizontal: 12,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: colors.gray800,
    borderRadius: 8,
  },
  loadMoreText: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  loadMoreErrorText: { color: colors.red400, fontSize: 12, marginBottom: 4, textAlign: 'center' },
  backButton: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  backButtonText: { color: colors.blue400, fontSize: 13 },
  detailTopActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
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
  detailSessionStarted: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'flex-end',
    maxWidth: 200,
  },
  detailSessionStartedText: { color: colors.emerald400, fontSize: 13, fontWeight: '600' },
  detailOpenChatText: { color: colors.blue400, fontSize: 13, fontWeight: '500' },
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
  prActionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  prActionButton: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    minHeight: 32,
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  prActionButtonText: { color: colors.gray200, fontSize: 13, fontWeight: '600' },
  previewPanel: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 10,
    backgroundColor: colors.gray800,
  },
  previewRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  previewLabel: { color: colors.gray200, fontSize: 14, fontWeight: '700', marginRight: 4 },
  previewStatusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  previewStatusText: { color: colors.blue400, fontSize: 13 },
  previewError: { color: colors.red400, fontSize: 12, marginTop: 6 },
  descriptionText: {
    color: colors.gray300,
    fontSize: 13,
    lineHeight: 19,
    padding: 10,
    backgroundColor: colors.gray900,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  activitySectionHeader: {
    color: colors.gray300,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  activitySub: {
    color: colors.gray500,
    fontSize: 11,
    marginBottom: 10,
    lineHeight: 16,
  },
  activityItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 12,
  },
  activityGlyph: {
    width: 22,
    fontSize: 15,
    textAlign: 'center',
    marginTop: 2,
  },
  activityBody: {
    flex: 1,
    minWidth: 0,
  },
  activityLine: {
    color: colors.gray200,
    fontSize: 13,
  },
  activityStrong: {
    fontWeight: '700',
    color: colors.white,
  },
  activityMuted: {
    color: colors.gray500,
    fontSize: 13,
  },
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
