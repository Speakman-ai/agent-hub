import React, { useState, useEffect, useCallback, useContext } from 'react';
import { View, Text, TouchableOpacity, FlatList, ScrollView, StyleSheet, ActivityIndicator, RefreshControl, Linking, Alert, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { SidebarContext } from '../context/SidebarContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativePrTime, diffSummary, prStateBadge, summarizeChecks, checksBadge, summarizeReviews, reviewsBadge, mergeableBadge, reviewDecisionListBadge, mergePipelineListBadge, buildPrActivityTimeline, } from '../utils/prFormatting';
import { resolveAgentIdFromProject } from '../utils/projectAgents';
import { isWorkflowProject } from '../utils/project-mode';
import { prDetailCapabilities } from '../utils/prReviewActions';
import PrDiffView from '../components/PrDiffView';
import PrReviewSheet from '../components/PrReviewSheet';
import PrCommentSheet from '../components/PrCommentSheet';
import PrEditSheet from '../components/PrEditSheet';
const STATE_TABS = [
    { key: 'open', label: 'Open' },
    { key: 'closed', label: 'Closed' },
    { key: 'all', label: 'All' },
];
function Badge({ label, color, bg, title }: any) {
    const a11y = title ? `${label}. ${title}` : label;
    return (<View style={[styles.badge, { backgroundColor: bg || colors.gray700_40 }]} accessibilityLabel={a11y}>
      <Text style={[styles.badgeText, { color: color || colors.gray400 }]}>{label}</Text>
    </View>);
}
function PrListItem({ pr, onPress, onResolveRow, resolveAgentId, resolvingThisRow, bulkResolving, spawnedSessionId, onOpenChat, }: any) {
    const state = prStateBadge(pr);
    const diff = diffSummary(pr);
    const showCi = Array.isArray(pr.check_rollup) && pr.check_rollup.length > 0;
    const ciBadge = showCi ? checksBadge(summarizeChecks(pr.check_rollup)) : null;
    const reviewB = reviewDecisionListBadge(pr.review_decision);
    const mBadge = mergeableBadge(pr.mergeable);
    const pipeB = mergePipelineListBadge(pr);
    const resolveBusy = bulkResolving || resolvingThisRow;
    const resolveDisabled = !resolveAgentId || resolveBusy;
    return (<View style={styles.listItemRow}>
      <TouchableOpacity style={styles.listItemMain} onPress={onPress} activeOpacity={0.7}>
        <View style={styles.listItemHeader}>
          <Badge label={state.label} color={state.color} bg={state.bg}/>
          <Text style={styles.prNumber}>#{pr.number}</Text>
          <View style={{ flex: 1 }}/>
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
        {(ciBadge || reviewB || mBadge.show || pipeB) && (<View style={[styles.labelsRow, { marginTop: 8 }]}>
            {ciBadge ? <Badge label={ciBadge.label} color={ciBadge.color} bg={ciBadge.bg}/> : null}
            {reviewB ? <Badge label={reviewB.label} color={reviewB.color} bg={reviewB.bg}/> : null}
            {mBadge.show ? (<Badge label={mBadge.label} color={mBadge.good ? colors.emerald400 : colors.red400} bg={mBadge.good ? colors.emerald900_40 : colors.red900_50}/>) : null}
            {pipeB ? (<Badge label={pipeB.label} color={pipeB.color} bg={pipeB.bg} title={pipeB.title}/>) : null}
          </View>)}
        {Array.isArray(pr.labels) && pr.labels.length > 0 && (<View style={styles.labelsRow}>
            {pr.labels.slice(0, 4).map((l: any) => (<View key={l.name} style={styles.label}>
                <Text style={styles.labelText} numberOfLines={1}>
                  {l.name}
                </Text>
              </View>))}
          </View>)}
      </TouchableOpacity>
      <View style={styles.listRowActions}>
        {spawnedSessionId ? (<View style={styles.listRowStarted} accessibilityLabel={`Session started for PR #${pr.number}`}>
            <Text style={styles.listRowStartedCheck}>{'\u2713'}</Text>
            <Text style={styles.listRowStartedCaption} numberOfLines={2}>
              Started
            </Text>
            {typeof onOpenChat === 'function' && resolveAgentId ? (<TouchableOpacity onPress={() => onOpenChat(spawnedSessionId)} accessibilityLabel="Open chat" style={styles.listRowOpenChat}>
                <Text style={styles.listRowOpenChatText}>Open chat</Text>
              </TouchableOpacity>) : null}
          </View>) : (<TouchableOpacity style={[styles.listRowResolveButton, resolveDisabled && styles.resolveButtonDisabled]} onPress={() => onResolveRow(pr.number)} disabled={resolveDisabled} accessibilityLabel={`Resolve PR #${pr.number}`} accessibilityState={{ disabled: resolveDisabled, busy: resolvingThisRow }}>
            {resolvingThisRow ? (<ActivityIndicator size="small" color={colors.gray300}/>) : (<Text style={styles.listRowResolveButtonText}>{'Fix'}</Text>)}
            <Text style={[
                styles.listRowResolveButtonCaption,
                resolveDisabled && styles.resolveButtonTextDisabled,
            ]} numberOfLines={2}>
              Resolve PR
            </Text>
          </TouchableOpacity>)}
      </View>
    </View>);
}
function PrActivityBlock({ pr, detail, styles }: any) {
    const activity = buildPrActivityTimeline(pr, detail);
    if (!activity.length) {
        return <Text style={styles.emptyText}>No recorded activity for this pull request.</Text>;
    }
    return (<View style={{ marginBottom: 16 }}>
      {activity.map((item: any) => (<View key={item.id} style={styles.activityItem}>
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
            <ActivityRowBody item={item} styles={styles}/>
          </View>
        </View>))}
    </View>);
}
function ActivityRowBody({ item, styles }: any) {
    const k = item.kind;
    const time = typeof item.at === 'string'
        ? relativePrTime(item.at)
        : item.atMs
            ? relativePrTime(new Date(item.atMs).toISOString())
            : '';
    if (k === 'opened') {
        const u = item.user ? `@${item.user}` : 'someone';
        return (<Text style={styles.activityLine}>
        <Text style={styles.activityStrong}>Opened</Text> by {u}
        {time ? <Text style={styles.activityMuted}> · {time}</Text> : null}
      </Text>);
    }
    if (k === 'merged') {
        return (<Text style={styles.activityLine}>
        <Text style={styles.activityStrong}>Merged</Text>
        {time ? <Text style={styles.activityMuted}> · {time}</Text> : null}
      </Text>);
    }
    if (k === 'closed') {
        return (<Text style={styles.activityLine}>
        <Text style={styles.activityStrong}>Closed</Text> without merging
        {time ? <Text style={styles.activityMuted}> · {time}</Text> : null}
      </Text>);
    }
    if (k === 'review' && item.review) {
        const r = item.review;
        const s = (r.state || '').toUpperCase();
        let c = colors.gray400;
        if (s === 'APPROVED')
            c = colors.emerald400;
        else if (s === 'CHANGES_REQUESTED')
            c = colors.red400;
        else if (s === 'COMMENTED')
            c = colors.blue400;
        return (<View style={styles.reviewBlock}>
        <View style={styles.reviewHeader}>
          <Text style={styles.reviewUser}>@{r.user || 'unknown'}</Text>
          <Text style={[styles.reviewState, { color: c }]}>{s || 'REVIEW'}</Text>
          <Text style={styles.reviewTime}>{relativePrTime(r.submitted_at)}</Text>
        </View>
        {r.body ? (<Text style={styles.reviewBody} numberOfLines={6}>
            {r.body}
          </Text>) : null}
      </View>);
    }
    if (k === 'comment' && item.comment) {
        const c = item.comment;
        return (<View style={styles.reviewBlock}>
        <View style={styles.reviewHeader}>
          <Text style={styles.reviewUser}>@{c.user || 'unknown'}</Text>
          <Text style={styles.reviewTime}>{relativePrTime(c.created_at)}</Text>
        </View>
        {c.body ? (<Text style={styles.reviewBody} numberOfLines={8}>
            {c.body}
          </Text>) : null}
      </View>);
    }
    return null;
}
function PrDetail({ detail, projectId, onBack, onRefresh, refreshing, onResolve, resolving, canResolve, spawnedSessionId, onOpenChat, }: any) {
    const pr = detail?.pr;
    const caps = prDetailCapabilities(detail);
    // PR actions (diff / review / comment / edit / reopen) — web parity.
    const [showFiles, setShowFiles] = useState(false);
    const [reviewOpen, setReviewOpen] = useState(false);
    const [commentOpen, setCommentOpen] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const [reopening, setReopening] = useState(false);
    const [reverting, setReverting] = useState(false);
    const prNumber = pr?.number;
    // Sheets throw on failure so they can render the error inline and stay
    // open; success closes the sheet and refreshes the detail payload.
    const handleSubmitReview = useCallback(async (payload: any) => {
        await api.submitPullReview(projectId, prNumber, payload);
        onRefresh();
    }, [projectId, prNumber, onRefresh]);
    const handleSaveEdit = useCallback(async (payload: any) => {
        await api.updatePull(projectId, prNumber, payload);
        onRefresh();
    }, [projectId, prNumber, onRefresh]);
    const handleAddInlineComment = useCallback(async (payload: any) => {
        await api.addPullComment(projectId, prNumber, payload);
        onRefresh();
    }, [projectId, prNumber, onRefresh]);
    const handleReopen = useCallback(async () => {
        if (reopening || !prNumber)
            return;
        setReopening(true);
        try {
            await api.reopenPull(projectId, prNumber);
            onRefresh();
        }
        catch (err: any) {
            Alert.alert('Reopen failed', err?.message || 'Failed to reopen PR');
        }
        finally {
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
        }
        catch (err: any) {
            Alert.alert('Revert failed', err?.message || 'Failed to revert PR');
        }
        finally {
            setReverting(false);
        }
    }, [projectId, prNumber, onRefresh]);
    const handleRevert = useCallback(() => {
        if (reverting || !prNumber)
            return;
        Alert.alert(`Revert PR #${prNumber}?`, `This commits the inverse of the merge on ${pr?.base || 'the base branch'} and pushes it to the GitHub mirror. History is not rewritten.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Revert', style: 'destructive', onPress: () => void runRevert() },
        ]);
    }, [prNumber, pr?.base, reverting, runRevert]);
    if (!pr)
        return null;
    const state = prStateBadge(pr);
    const checks = summarizeChecks(detail.checks);
    const cBadge = checksBadge(checks);
    const reviewState = summarizeReviews(detail.reviews);
    const rBadge = reviewsBadge(reviewState);
    const mBadge = mergeableBadge(pr.mergeable);
    const resolveDisabled = resolving || !canResolve;
    return (<ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailContent} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gray400}/>}>
      <View style={styles.detailTopActions}>
        <TouchableOpacity style={styles.backButton} onPress={onBack}>
          <Text style={styles.backButtonText}>{'\u2190'} Back to list</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}/>
        {spawnedSessionId ? (<View style={styles.detailSessionStarted}>
            <Text style={styles.detailSessionStartedText}>{'\u2713'} Session started</Text>
            {typeof onOpenChat === 'function' ? (<TouchableOpacity onPress={onOpenChat} accessibilityLabel="Open chat">
                <Text style={styles.detailOpenChatText}>Open chat</Text>
              </TouchableOpacity>) : null}
          </View>) : (<TouchableOpacity style={[styles.resolveButton, resolveDisabled && styles.resolveButtonDisabled]} onPress={onResolve} disabled={resolveDisabled} accessibilityLabel="Resolve PR" accessibilityState={{ disabled: resolveDisabled, busy: resolving }}>
            {resolving ? (<ActivityIndicator size="small" color={colors.gray300}/>) : (<Text style={[
                    styles.resolveButtonText,
                    resolveDisabled && styles.resolveButtonTextDisabled,
                ]}>
                Resolve PR
              </Text>)}
          </TouchableOpacity>)}
      </View>

      <View style={styles.detailHeader}>
        <Badge label={state.label} color={state.color} bg={state.bg}/>
        <Text style={styles.prNumber}>#{pr.number}</Text>
      </View>
      <Text style={styles.detailTitle}>{pr.title}</Text>

      <Text style={styles.metaText}>
        {pr.user ? `@${pr.user}` : 'unknown'}
        {pr.created_at ? ` opened ${relativePrTime(pr.created_at)}` : ''}
      </Text>
      {pr.head && (<Text style={styles.metaText}>
          {pr.head} → {pr.base || 'main'}
        </Text>)}
      <Text style={styles.diffText}>{diffSummary(pr)}</Text>

      {Array.isArray(pr.labels) && pr.labels.length > 0 && (<View style={styles.labelsRow}>
          {pr.labels.map((l: any) => (<View key={l.name} style={styles.label}>
              <Text style={styles.labelText}>{l.name}</Text>
            </View>))}
        </View>)}

      {/* External link only for real GitHub URLs \u2014 native PR URLs are
              in-app client routes with nothing external to open. */}
      {caps.externalUrl ? (<TouchableOpacity style={styles.openGithubButton} onPress={() => Linking.openURL(caps.externalUrl)}>
          <Text style={styles.openGithubText}>Open on GitHub {'\u2197'}</Text>
        </TouchableOpacity>) : null}

      {/* PR actions: diff, review, comment, edit, reopen */}
      <View style={styles.prActionsRow}>
        <TouchableOpacity style={[styles.prActionButton, !caps.canViewFiles && styles.resolveButtonDisabled]} onPress={() => setShowFiles((v: any) => !v)} disabled={!caps.canViewFiles} accessibilityState={{ disabled: !caps.canViewFiles, expanded: showFiles }}>
          <Text style={styles.prActionButtonText}>
            {showFiles ? 'Hide files' : `Files${pr.changed_files ? ` (${pr.changed_files})` : ''}`}
          </Text>
        </TouchableOpacity>
        {caps.canReview ? (<TouchableOpacity style={styles.prActionButton} onPress={() => setReviewOpen(true)}>
            <Text style={styles.prActionButtonText}>Review</Text>
          </TouchableOpacity>) : null}
        {caps.canComment ? (<TouchableOpacity style={styles.prActionButton} onPress={() => setCommentOpen(true)}>
            <Text style={styles.prActionButtonText}>Comment</Text>
          </TouchableOpacity>) : null}
        {caps.canEdit ? (<TouchableOpacity style={styles.prActionButton} onPress={() => setEditOpen(true)}>
            <Text style={styles.prActionButtonText}>Edit</Text>
          </TouchableOpacity>) : null}
        {caps.canReopen ? (<TouchableOpacity style={[styles.prActionButton, reopening && styles.resolveButtonDisabled]} onPress={handleReopen} disabled={reopening} accessibilityState={{ disabled: reopening, busy: reopening }}>
            {reopening ? (<ActivityIndicator size="small" color={colors.emerald400}/>) : (<Text style={[styles.prActionButtonText, { color: colors.emerald400 }]}>Reopen</Text>)}
          </TouchableOpacity>) : null}
        {caps.canRevert ? (<TouchableOpacity style={[styles.prActionButton, reverting && styles.resolveButtonDisabled]} onPress={handleRevert} disabled={reverting} accessibilityLabel="Revert PR" accessibilityState={{ disabled: reverting, busy: reverting }}>
            {reverting ? (<ActivityIndicator size="small" color={colors.amber400}/>) : (<Text style={[styles.prActionButtonText, { color: colors.amber400 }]}>Revert</Text>)}
          </TouchableOpacity>) : null}
      </View>

      {pr.body ? (<>
          <Text style={styles.sectionHeader}>Description</Text>
          <Text style={styles.descriptionText}>{pr.body}</Text>
        </>) : null}

      {/* Summary strip: checks + reviews */}
      <View style={styles.summaryStrip}>
        <Badge label={cBadge.label} color={cBadge.color} bg={cBadge.bg}/>
        <Badge label={rBadge.label} color={rBadge.color} bg={rBadge.bg}/>
        {mBadge.show && (<Badge label={mBadge.label} color={mBadge.good ? colors.emerald400 : colors.red400} bg={mBadge.good ? colors.emerald900_40 : colors.red900_50}/>)}
      </View>

      {showFiles ? (<>
          <Text style={styles.sectionHeader}>Files changed</Text>
          <PrDiffView prUrl={caps.prUrl} comments={caps.isNative ? detail.inline_comments || [] : []} onAddComment={caps.canComment ? handleAddInlineComment : null}/>
        </>) : null}

      <Text style={styles.activitySectionHeader}>Activity</Text>
      <Text style={styles.activitySub}>
        Chronological history from GitHub (open/merge/close, reviews, and issue comments).
      </Text>
      <PrActivityBlock detail={detail} pr={pr} styles={styles}/>

      {/* CI Checks list */}
      <Text style={styles.sectionHeader}>CI Checks</Text>
      {(!detail.checks || detail.checks.length === 0) && (<Text style={styles.emptyText}>No checks reported.</Text>)}
      {Array.isArray(detail.checks) &&
            detail.checks.map((chk: any, i: any) => {
                const status = (chk.status || '').toLowerCase();
                const concl = (chk.conclusion || '').toLowerCase();
                let c = colors.gray400;
                let icon = '\u25CF';
                if (status && status !== 'completed') {
                    c = colors.yellow400;
                    icon = '\u25D0';
                }
                else if (concl === 'success' || concl === 'skipped' || concl === 'neutral') {
                    c = colors.emerald400;
                    icon = '\u2713';
                }
                else if (concl === 'failure' ||
                    concl === 'timed_out' ||
                    concl === 'cancelled' ||
                    concl === 'action_required') {
                    c = colors.red400;
                    icon = '\u2717';
                }
                return (<TouchableOpacity key={chk.id || chk.name || i} style={styles.checkRow} onPress={() => chk.html_url && Linking.openURL(chk.html_url)} disabled={!chk.html_url}>
              <Text style={[styles.checkIcon, { color: c }]}>{icon}</Text>
              <Text style={styles.checkName} numberOfLines={1}>
                {chk.name || 'unnamed'}
              </Text>
              <Text style={styles.checkState}>{concl || status || ''}</Text>
            </TouchableOpacity>);
            })}

      <View style={{ height: 40 }}/>

      <PrReviewSheet visible={reviewOpen} prNumber={pr.number} onClose={() => setReviewOpen(false)} onSubmit={handleSubmitReview}/>
      <PrCommentSheet visible={commentOpen} prNumber={pr.number} onClose={() => setCommentOpen(false)} onSubmit={handleSubmitReview}/>
      <PrEditSheet visible={editOpen} pr={pr} onClose={() => setEditOpen(false)} onSubmit={handleSaveEdit}/>
    </ScrollView>);
}
export default function PullRequestsScreen({ route, navigation }: any) {
    const { projects, setActiveAgentId, setActiveSessionId } = useApp();
    const { openSidebar } = useContext(SidebarContext);
    const projectId = route?.params?.projectId || projects?.[0]?.id;
    const project = projects?.find((p: any) => p.id === projectId);
    const resolveAgentId = resolveAgentIdFromProject(project);
    const [state, setState] = useState('open');
    const [pulls, setPulls] = useState<any[]>([]);
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
        if (!projectId || !project)
            return;
        if (!isWorkflowProject(project))
            return;
        const id = requestAnimationFrame(() => {
            Alert.alert('Workflow mode', 'Pull requests are hidden for workflow projects. Switch the project to dev mode in Settings if you need this screen.', [
                {
                    text: 'OK',
                    onPress: () => {
                        if (navigation?.canGoBack?.())
                            navigation.goBack();
                        else
                            navigation?.navigate?.('Chat');
                    },
                },
            ]);
        });
        return () => cancelAnimationFrame(id);
    }, [projectId, project, navigation]);
    const openResolverChat = useCallback((sessionId: any) => {
        if (!sessionId || !resolveAgentId)
            return;
        setActiveAgentId(resolveAgentId);
        setActiveSessionId(sessionId);
        navigation?.navigate?.('Chat');
    }, [resolveAgentId, setActiveAgentId, setActiveSessionId, navigation]);
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
        }
        catch (err: any) {
            console.warn('Failed to load PRs:', err?.message || err);
            setError(err?.message || 'Failed to load PRs');
            setPulls([]);
        }
        finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [projectId, state]);
    useEffect(() => {
        setLoading(true);
        loadList();
    }, [loadList]);
    const loadDetail = useCallback(async (number: any) => {
        if (!projectId || !number)
            return;
        setDetailLoading(true);
        setDetailError(null);
        try {
            const data = await api.getProjectPullDetail(projectId, number);
            setDetail(data);
        }
        catch (err: any) {
            console.warn('Failed to load PR detail:', err?.message || err);
            setDetailError(err?.message || 'Failed to load PR');
            setDetail(null);
        }
        finally {
            setDetailLoading(false);
        }
    }, [projectId]);
    // Deep-link: a PR review notification tap routes here with a target
    // `prNumber` (see AppContext `applyNotificationRoute`). Open that PR's
    // detail view directly instead of leaving the user on the list. Keyed on
    // the param so re-renders without a new target don't reopen after the user
    // backs out, but a fresh notification for a different PR still routes.
    const deepLinkedNumber = route?.params?.prNumber;
    useEffect(() => {
        if (deepLinkedNumber == null || !projectId)
            return;
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
        }
        else {
            loadList();
        }
    };
    // Spawn an agent session to resolve the selected PR (CI failures, review
    // feedback, or merge conflicts). Mirrors the web's `handleResolve` in
    // `client/src/components/PullRequestsPage.jsx`.
    const handleResolve = useCallback(async () => {
        if (!projectId || !selectedNumber || !resolveAgentId || resolving)
            return;
        setResolving(true);
        try {
            const res = await api.resolvePR(projectId, selectedNumber, { agentId: resolveAgentId });
            if (res?.sessionId) {
                setSessionSpawnedByPr((prev: any) => ({ ...prev, [selectedNumber]: res.sessionId }));
                const kinds = Array.isArray(res.triggered) ? res.triggered.join(', ') : '';
                Alert.alert('Resolve PR', kinds ? `Resolving PR — ${kinds}` : 'Resolving PR — agent session started');
            }
            else {
                Alert.alert('Resolve PR', 'Nothing to resolve — PR looks clean.');
            }
        }
        catch (err: any) {
            const msg = err?.message || 'Failed to resolve PR';
            Alert.alert('Resolve PR failed', msg);
        }
        finally {
            setResolving(false);
        }
    }, [projectId, selectedNumber, resolveAgentId, resolving]);
    const handleResolveFromList = useCallback(async (prNumber: any) => {
        if (!projectId || !resolveAgentId || bulkResolving || resolvingFromList != null)
            return;
        setResolvingFromList(prNumber);
        try {
            const res = await api.resolvePR(projectId, prNumber, { agentId: resolveAgentId });
            if (res?.sessionId) {
                setSessionSpawnedByPr((prev: any) => ({ ...prev, [prNumber]: res.sessionId }));
                const kinds = Array.isArray(res.triggered) ? res.triggered.join(', ') : '';
                Alert.alert('Resolve PR', kinds
                    ? `PR #${prNumber}: session started (${kinds})`
                    : `PR #${prNumber}: agent session started`);
            }
            else {
                Alert.alert('Resolve PR', `Nothing to resolve — PR #${prNumber} looks clean.`);
            }
        }
        catch (err: any) {
            const msg = err?.message || 'Failed to resolve PR';
            Alert.alert('Resolve PR failed', `PR #${prNumber}: ${msg}`);
        }
        finally {
            setResolvingFromList(null);
        }
    }, [projectId, resolveAgentId, bulkResolving, resolvingFromList]);
    const handleResolveAll = useCallback(async () => {
        if (!projectId ||
            !resolveAgentId ||
            pulls.length === 0 ||
            bulkResolving ||
            resolvingFromList != null) {
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
                    }
                    else {
                        clean += 1;
                    }
                }
                catch {
                    failed += 1;
                }
            }
            const parts = [
                `${spawned} session(s) started`,
                `${clean} already clean`,
                failed ? `${failed} failed` : null,
            ].filter(Boolean);
            Alert.alert('Resolve all', `Finished: ${parts.join(', ')}.`);
        }
        finally {
            setBulkResolving(false);
        }
    }, [projectId, resolveAgentId, pulls, bulkResolving, resolvingFromList]);
    return (<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'\u2630'}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {selectedNumber ? `PR #${selectedNumber}` : `${project?.name || 'Project'} · PRs`}
        </Text>
        {!selectedNumber && pulls.length > 0 ? (<TouchableOpacity style={[styles.headerResolveAll, bulkResolving && styles.resolveButtonDisabled]} onPress={handleResolveAll} disabled={!resolveAgentId ||
                pulls.length === 0 ||
                bulkResolving ||
                resolvingFromList != null ||
                loading}>
            {bulkResolving ? (<ActivityIndicator size="small" color={colors.gray300}/>) : (<Text style={styles.headerResolveAllText}>Resolve all</Text>)}
          </TouchableOpacity>) : null}
      </View>

      {/* Detail view */}
      {selectedNumber ? (<>
          {detailLoading && !detail && (<View style={styles.centered}>
              <ActivityIndicator color={colors.gray400}/>
            </View>)}
          {detailError && !detailLoading && (<View style={styles.centered}>
              <Text style={styles.errorText}>{detailError}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={() => loadDetail(selectedNumber)}>
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.backButton} onPress={handleBack}>
                <Text style={styles.backButtonText}>{'\u2190'} Back</Text>
              </TouchableOpacity>
            </View>)}
          {detail && (<PrDetail detail={detail} projectId={projectId} onBack={handleBack} onRefresh={handleRefresh} refreshing={refreshing} onResolve={handleResolve} resolving={resolving} canResolve={Boolean(resolveAgentId)} spawnedSessionId={sessionSpawnedByPr[selectedNumber] || null} onOpenChat={sessionSpawnedByPr[selectedNumber]
                    ? () => openResolverChat(sessionSpawnedByPr[selectedNumber])
                    : undefined}/>)}
        </>) : (<>
          {/* State tabs */}
          <View style={styles.tabs}>
            {STATE_TABS.map((tab: any) => (<TouchableOpacity key={tab.key} style={[styles.tab, state === tab.key && styles.tabActive]} onPress={() => setState(tab.key)}>
                <Text style={[styles.tabText, state === tab.key && styles.tabTextActive]}>
                  {tab.label}
                </Text>
              </TouchableOpacity>))}
          </View>

          {loading && pulls.length === 0 && (<View style={styles.centered}>
              <ActivityIndicator color={colors.gray400}/>
            </View>)}

          {!loading && error && (<View style={styles.centered}>
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={loadList}>
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>)}

          {!loading && !error && pulls.length === 0 && (<View style={styles.centered}>
              <Text style={styles.emptyText}>No {state} pull requests.</Text>
            </View>)}

          <FlatList data={pulls} keyExtractor={(item: any) => String(item.number)} renderItem={({ item }: any) => (<PrListItem pr={item} onPress={() => handleSelect(item)} onResolveRow={handleResolveFromList} resolveAgentId={resolveAgentId} resolvingThisRow={resolvingFromList === item.number} bulkResolving={bulkResolving} spawnedSessionId={sessionSpawnedByPr[item.number] || null} onOpenChat={openResolverChat}/>)} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.gray400}/>} contentContainerStyle={{ paddingVertical: 8 }}/>
        </>)}
    </SafeAreaView>);
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
