import React, { useState, useEffect, useMemo, useCallback, useContext, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Image,
  Linking,
  Alert,
  Modal,
  TextInput,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import {
  sortTickets,
  resolveReplayUrl,
  resolveUploadUrl,
  performTicketDelete,
  performTicketLink,
  releaseStateLabel,
  mergeTicketDetail,
} from '../utils/supportTickets';
import { SidebarContext } from '../context/SidebarContext';
import { convertedCardLabel } from '@shared/utils/convertedCardLabel';
const SEVERITY_COLOR: Record<string, any> = {
  critical: colors.red500,
  high: colors.rose400,
  medium: colors.amber400,
  low: colors.gray500,
};
const SEVERITY_OPTIONS = [
  { key: 'critical', label: 'Critical' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
];
const TYPE_LABEL: Record<string, any> = {
  bug: 'Bug',
  feature_request: 'Feature request',
  question: 'Question',
  incident: 'Incident',
  other: 'Other',
};
// Human label per lifecycle status (closed reads as "Done").
const STATUS_LABEL: Record<string, any> = {
  new: 'New',
  investigating: 'Investigating',
  converted: 'Converted',
  closed: 'Done',
  duplicate: 'Duplicate',
  wont_do: "Won't do",
};
const ALL_STATUSES = ['new', 'investigating', 'converted', 'closed', 'duplicate', 'wont_do'];
// Filter groups. Default ("Open") shows the working states only; terminal
// states are retained but hidden until their filter is selected.
const STATUS_FILTERS = [
  { key: 'open', label: 'Open', statuses: ['new', 'investigating'] },
  { key: 'done', label: 'Done', statuses: ['converted', 'closed'] },
  { key: 'duplicate', label: 'Duplicate', statuses: ['duplicate'] },
  { key: 'wont_do', label: "Won't do", statuses: ['wont_do'] },
  { key: 'all', label: 'All', statuses: ALL_STATUSES },
];
const TYPE_FILTERS = [
  { key: 'all', label: 'All types' },
  { key: 'bug', label: 'Bug' },
  { key: 'feature_request', label: 'Feature' },
  { key: 'question', label: 'Question' },
  { key: 'incident', label: 'Incident' },
  { key: 'other', label: 'Other' },
];
const TYPE_OPTIONS = TYPE_FILTERS.filter((f: any) => f.key !== 'all');
// Queue ordering toggle. "Priority" (default) sorts severity-first then newest;
// "Date" ignores severity and orders purely by creation date (newest first).
const SORT_MODES = [
  { key: 'priority', label: 'Priority' },
  { key: 'date', label: 'Date' },
];
function pickMainDevAgent(agents: any[]) {
  const active = (agent: any) => agent?.active !== false;
  return (
    agents.find((agent: any) => active(agent) && agent.role === 'lead') ||
    agents.find((agent: any) => active(agent) && agent.role === 'dev') ||
    agents.find(
      (agent: any) =>
        active(agent) &&
        agent.role !== 'docs' &&
        agent.role !== 'reviewer' &&
        agent.role !== 'skill-builder',
    ) ||
    null
  );
}
function reporterText(ticket: any) {
  const parts = [ticket.reporter, ticket.reporter_email].filter(Boolean);
  return parts.length ? `Reported by ${parts.join(' · ')}` : '';
}
function notificationRecipientLabel(notification: any) {
  if (notification?.recipient_type === 'reporter') return 'Reporter';
  if (notification?.recipient_type === 'release_digest') return 'Release digest';
  return String(notification?.recipient_type || notification?.notification_type || 'Recipient');
}
function notificationStatusLabel(notification: any) {
  return String(notification?.status || 'pending').replaceAll('_', ' ');
}
function TicketCard({
  item,
  projectId,
  onOpenReplay,
  onDeleted,
  onPress,
  onSetStatus,
  onWontDo,
  onReclassify,
  onReRate,
  onConverted,
}: any) {
  const severityColor = SEVERITY_COLOR[item.severity] || colors.gray500;
  const title = item.subject?.trim() || item.body?.trim() || '(no subject)';
  const hasReplay = item.type === 'bug' && item.replay_ref;
  const screenshotUrl = resolveUploadUrl(item.screenshot_ref);
  const isConverted = item.status === 'converted' || !!item.converted_card_id;
  const isUnread = !item.read_at;
  const reporterLabel = reporterText(item);
  const releaseLabel = releaseStateLabel(item.release_state);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<any>(null);
  // Tri-state auto-merge: only send an explicit preference once the user
  // toggles the switch. Untouched → omit so the server uses the project default
  // (per the API contract) instead of stamping an explicit `false`.
  const [convertAutoMerge, setConvertAutoMerge] = useState(false);
  const [convertAutoMergeTouched, setConvertAutoMergeTouched] = useState(false);
  const [convertComment, setConvertComment] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<any>(null);
  // Link-to-existing-card state (the sibling of convert): the picker is lazy —
  // cards load the first time the operator opens it.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkCards, setLinkCards] = useState<any[]>([]);
  const [loadingLinkCards, setLoadingLinkCards] = useState(false);
  const [linkCardId, setLinkCardId] = useState('');
  const [linkComment, setLinkComment] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<any>(null);
  const loadLinkCards = async () => {
    setLoadingLinkCards(true);
    setLinkError(null);
    try {
      const board: any = await api.getProjectBoard(projectId, { limit: 200 });
      const flat: any[] = [];
      for (const col of board?.columns || []) {
        for (const c of col?.cards || []) {
          flat.push({ id: c.id, title: c.title, shortId: c.short_id, column: col.name });
        }
      }
      setLinkCards(flat);
    } catch (err: any) {
      setLinkError(err.message || 'Failed to load board cards');
    } finally {
      setLoadingLinkCards(false);
    }
  };
  const handleOpenLink = () => {
    setLinkOpen(true);
    if (!linkCards.length) void loadLinkCards();
  };
  const handleLink = async () => {
    if (linking || !linkCardId) return;
    // Local-state update on success + error handling lives in a pure,
    // unit-tested helper (performTicketLink in utils/supportTickets) so the
    // "flip the ticket to converted without waiting on the WebSocket echo"
    // behavior can't silently regress.
    await performTicketLink({
      projectId,
      ticketId: item.id,
      cardId: linkCardId,
      comment: linkComment.trim() || undefined,
      item,
      linkCard: api.linkSupportTicketToCard,
      setLinking,
      setLinkError,
      onConverted,
    });
  };
  const handleConvert = async () => {
    if (converting || isConverted) return;
    setConverting(true);
    setConvertError(null);
    try {
      await api.convertSupportTicketToCard(projectId, item.id, {
        autoMerge: convertAutoMergeTouched ? convertAutoMerge : undefined,
        comment: convertComment.trim() || undefined,
      });
      // The support_ticket_updated WebSocket event re-renders this card as
      // converted; no local state mutation needed.
    } catch (err: any) {
      setConvertError(err.message || 'Failed to convert');
    } finally {
      setConverting(false);
    }
  };
  const performDelete = async () => {
    if (deleting) return;
    // Optimistic-removal + error handling lives in a pure, unit-tested helper
    // (performTicketDelete in utils/supportTickets) so the success/failure
    // state transitions can't silently regress.
    await performTicketDelete({
      projectId,
      ticketId: item.id,
      deleteTicket: api.deleteSupportTicket,
      setDeleting,
      setDeleteError,
      onDeleted,
    });
  };
  const handleDelete = () => {
    if (deleting) return;
    Alert.alert('Delete support ticket?', 'This permanently removes the ticket.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: performDelete },
    ]);
  };
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => onPress?.(item)}
      testID="support-ticket-card"
      accessibilityState={{ selected: !isUnread }}
      style={[styles.card, isUnread && styles.cardUnread]}
    >
      <View style={styles.badgeRow}>
        {isUnread ? <View testID="unread-dot" style={styles.unreadDot} /> : null}
        <View style={[styles.severityBadge, { borderColor: severityColor }]}>
          <Text style={[styles.severityText, { color: severityColor }]}>{item.severity}</Text>
        </View>
        <View style={styles.typeBadge}>
          <Text style={styles.typeText}>{TYPE_LABEL[item.type] || 'Other'}</Text>
        </View>
        <View style={styles.statusBadge}>
          <Text style={styles.statusText}>{STATUS_LABEL[item.status] || item.status}</Text>
        </View>
        {releaseLabel ? (
          <View style={styles.releaseBadge}>
            <Text style={styles.releaseText}>{releaseLabel}</Text>
          </View>
        ) : null}
        <Text style={styles.time}>{relativeTime(item.created_at)}</Text>
      </View>

      <Text style={[styles.cardTitle, isUnread && styles.cardTitleUnread]} numberOfLines={2}>
        {title}
      </Text>

      {item.subject?.trim() && item.body?.trim() ? (
        <Text style={styles.cardBody} numberOfLines={3}>
          {item.body}
        </Text>
      ) : null}

      {reporterLabel ? <Text style={styles.reporter}>{reporterLabel}</Text> : null}

      {item.status === 'wont_do' && item.wont_do_reason ? (
        <View style={styles.wontDoBox} testID="wont-do-reason">
          <Text style={styles.wontDoLabel}>Won&apos;t do</Text>
          <Text style={styles.wontDoText}>{item.wont_do_reason}</Text>
        </View>
      ) : null}

      {item.ai_summary ? (
        <View style={styles.aiBox}>
          <Text style={styles.aiLabel}>AI investigation</Text>
          <Text style={styles.aiText}>{item.ai_summary}</Text>
        </View>
      ) : null}

      {screenshotUrl ? (
        <TouchableOpacity
          onPress={() => Linking.openURL(screenshotUrl).catch(() => {})}
          testID="ticket-screenshot"
        >
          <Image source={{ uri: screenshotUrl }} style={styles.screenshot} resizeMode="contain" />
        </TouchableOpacity>
      ) : null}

      {hasReplay ? (
        <TouchableOpacity onPress={() => onOpenReplay(item.replay_ref)}>
          <Text style={styles.replayLink}>{'▶'} View session replay</Text>
        </TouchableOpacity>
      ) : null}

      {!isConverted ? (
        <View style={styles.convertOptions}>
          <View style={styles.autoMergeRow}>
            <Text style={styles.autoMergeLabel}>Auto-merge</Text>
            <Switch
              value={convertAutoMerge}
              onValueChange={(v: any) => {
                setConvertAutoMerge(v);
                setConvertAutoMergeTouched(true);
              }}
              disabled={converting}
              testID="convert-auto-merge"
            />
          </View>
          <TextInput
            style={styles.convertComment}
            value={convertComment}
            onChangeText={setConvertComment}
            placeholder="Comments / instructions (optional)"
            placeholderTextColor={colors.gray500}
            editable={!converting}
            multiline
            maxLength={4000}
            testID="convert-comment"
          />
        </View>
      ) : null}

      {!isConverted && linkOpen ? (
        <View style={styles.linkOptions} testID="link-card-picker">
          <Text style={styles.linkLabel}>Link to an existing card</Text>
          {loadingLinkCards ? (
            <Text style={styles.linkHint}>Loading cards…</Text>
          ) : (
            <ScrollView style={styles.linkCardList} nestedScrollEnabled>
              {linkCards.map((c: any) => {
                const active = linkCardId === c.id;
                return (
                  <TouchableOpacity
                    key={c.id}
                    testID={`link-card-option-${c.id}`}
                    onPress={() => setLinkCardId(c.id)}
                    style={[styles.linkCardOption, active && styles.linkCardOptionActive]}
                  >
                    <Text
                      style={[styles.linkCardOptionText, active && styles.linkCardOptionTextActive]}
                      numberOfLines={1}
                    >
                      {c.shortId ? `#${c.shortId} · ` : ''}
                      {c.title} ({c.column})
                    </Text>
                  </TouchableOpacity>
                );
              })}
              {!linkCards.length ? (
                <Text style={styles.linkHint}>No cards on this board.</Text>
              ) : null}
            </ScrollView>
          )}
          <TextInput
            style={styles.convertComment}
            value={linkComment}
            onChangeText={setLinkComment}
            placeholder="Note for the card (optional)"
            placeholderTextColor={colors.gray500}
            editable={!linking}
            multiline
            maxLength={4000}
            testID="link-card-comment"
          />
          {linkError ? <Text style={styles.convertErrorText}>{linkError}</Text> : null}
        </View>
      ) : null}

      <View style={styles.actionRow}>
        {isConverted ? (
          <Text style={styles.convertedText} testID="converted-card-label">
            {'✓'} Converted to {convertedCardLabel(item) ?? 'card'}
          </Text>
        ) : (
          <TouchableOpacity
            onPress={handleConvert}
            disabled={converting}
            style={[styles.convertButton, converting && styles.convertButtonDisabled]}
          >
            <Text style={styles.convertButtonText}>
              {converting ? 'Converting…' : '▤ Convert to card'}
            </Text>
          </TouchableOpacity>
        )}
        {!isConverted ? (
          linkOpen ? (
            <TouchableOpacity
              onPress={handleLink}
              disabled={linking || !linkCardId}
              style={[
                styles.convertButton,
                (linking || !linkCardId) && styles.convertButtonDisabled,
              ]}
              testID="link-card-submit"
            >
              <Text style={styles.convertButtonText}>{linking ? 'Linking…' : '🔗 Link'}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={handleOpenLink}
              style={styles.convertButton}
              testID="link-card-open"
            >
              <Text style={styles.convertButtonText}>🔗 Link to card</Text>
            </TouchableOpacity>
          )
        ) : null}
        <TouchableOpacity
          onPress={handleDelete}
          disabled={deleting}
          style={[styles.deleteButton, deleting && styles.convertButtonDisabled]}
        >
          <Text style={styles.deleteButtonText}>{deleting ? 'Deleting…' : 'Delete'}</Text>
        </TouchableOpacity>
        {convertError ? <Text style={styles.convertErrorText}>{convertError}</Text> : null}
        {deleteError ? <Text style={styles.convertErrorText}>{deleteError}</Text> : null}
      </View>

      {item.status !== 'converted' ? (
        <View style={styles.statusActionRow}>
          <TouchableOpacity
            testID="reclassify-ticket"
            onPress={() => onReclassify?.(item)}
            style={styles.statusActionButton}
          >
            <Text style={styles.statusActionText}>Reclassify</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="re-rate-ticket"
            onPress={() => onReRate?.(item)}
            style={styles.statusActionButton}
          >
            <Text style={styles.statusActionText}>Severity</Text>
          </TouchableOpacity>
          {[
            { value: 'closed', label: 'Done' },
            { value: 'duplicate', label: 'Duplicate' },
            { value: 'wont_do', label: "Won't do" },
          ].map((s: any) => {
            const active = item.status === s.value;
            return (
              <TouchableOpacity
                key={s.value}
                testID={`status-action-${s.value}`}
                onPress={() =>
                  s.value === 'wont_do' ? onWontDo?.(item) : onSetStatus?.(item, s.value)
                }
                style={[styles.statusActionButton, active && styles.statusActionButtonActive]}
              >
                <Text style={[styles.statusActionText, active && styles.statusActionTextActive]}>
                  {s.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

function TicketInvestigationControl({ projectId, ticket, agents, onUpdated }: any) {
  const mainDevAgent = pickMainDevAgent(agents || []);
  const [running, setRunning] = useState(false);
  if (!mainDevAgent) return null;
  const run = async () => {
    if (running) return;
    setRunning(true);
    try {
      const response = await api.runSupportTicketInvestigation(projectId, ticket.id);
      if (response?.ticket) onUpdated?.(response.ticket);
      Alert.alert('Customer Support', `AI investigation queued with ${mainDevAgent.name}`);
    } catch (err: any) {
      Alert.alert('Investigation failed', err?.message || 'Could not start AI investigation');
    } finally {
      setRunning(false);
    }
  };
  return (
    <View style={styles.investigationBox} testID="ticket-investigation-control">
      <Text style={styles.investigationLabel}>Run AI investigation with {mainDevAgent.name}</Text>
      <View style={styles.investigationRow}>
        <TouchableOpacity
          style={[styles.investigateButton, running && styles.convertButtonDisabled]}
          onPress={run}
          disabled={running}
        >
          <Text style={styles.investigateButtonText}>{running ? 'Queueing…' : 'Run'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function CustomerSupportScreen({ route }: any) {
  const {
    projects,
    agents,
    lastSupportTicketEvent,
    refreshSupportUnreadCount,
    setSupportUnreadCount,
  } = useApp();
  const { openSidebar } = useContext(SidebarContext);
  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = projects?.find((p: any) => p.id === projectId);
  const [tickets, setTickets] = useState<any[]>([]);
  // Default to the "Open" group; terminal tickets are retained but hidden.
  const [statusFilter, setStatusFilter] = useState('open');
  const [typeFilter, setTypeFilter] = useState('all');
  // Queue ordering: 'priority' (default) sorts severity-first then newest;
  // 'date' ignores severity and sorts purely by creation date (newest first).
  const [sortMode, setSortMode] = useState<'priority' | 'date'>('priority');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [selectedTicket, setSelectedTicket] = useState<any>(null);
  const [retryingNotificationId, setRetryingNotificationId] = useState<any>(null);
  // The ticket whose "won't do" reason is being captured (null = modal closed).
  const [wontDoTicket, setWontDoTicket] = useState<any>(null);
  const [wontDoReason, setWontDoReason] = useState('');
  const [reclassifyTicket, setReclassifyTicket] = useState<any>(null);
  const [severityTicket, setSeverityTicket] = useState<any>(null);
  const activeStatusFilter =
    STATUS_FILTERS.find((f: any) => f.key === statusFilter) || STATUS_FILTERS[0];
  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getSupportTickets(
        projectId,
        activeStatusFilter.statuses.join(','),
        typeFilter === 'all' ? undefined : typeFilter,
      );
      setTickets(sortTickets(Array.isArray(data) ? data : []));
    } catch (err: any) {
      setError(err.message || 'Failed to load support requests');
    } finally {
      setLoading(false);
    }
  }, [projectId, activeStatusFilter, typeFilter]);
  useEffect(() => {
    load();
  }, [load]);
  // Seed the drawer's unread badge from the server on mount / project change so
  // it's correct on a cold load; WebSocket unreadCount keeps it live after.
  useEffect(() => {
    if (projectId) refreshSupportUnreadCount(projectId);
  }, [projectId, refreshSupportUnreadCount]);
  // React to live WebSocket events from AppContext
  useEffect(() => {
    if (!lastSupportTicketEvent) return;
    const { type, projectId: evtProjectId, ticket, ticketId } = lastSupportTicketEvent;
    if (evtProjectId !== projectId) return;
    if (type === 'support_ticket_deleted') {
      setTickets((prev: any) => prev.filter((t: any) => t.id !== ticketId));
      return;
    }
    if (type === 'support_tickets_read_all') {
      const stamp = new Date().toISOString();
      setTickets((prev: any) => prev.map((t: any) => (t.read_at ? t : { ...t, read_at: stamp })));
      return;
    }
    if (!ticket) return;
    setTickets((prev: any) => {
      const without = prev.filter((t: any) => t.id !== ticket.id);
      // A status/type change can move a ticket out of the active filter.
      const statusOk = activeStatusFilter.statuses.includes(ticket.status);
      const typeOk = typeFilter === 'all' || ticket.type === typeFilter;
      if (!statusOk || !typeOk) return without;
      return sortTickets([...without, ticket]);
    });
  }, [lastSupportTicketEvent, projectId, activeStatusFilter, typeFilter]);
  const openReplay = useCallback((ref: any) => {
    const url = resolveReplayUrl(ref);
    if (url) Linking.openURL(url).catch(() => {});
  }, []);
  // Tapping a ticket marks it read: optimistic local flip + fire-and-forget
  // POST (the WebSocket echo refreshes the drawer badge).
  const markRead = useCallback(
    (ticket: any) => {
      if (!ticket || ticket.read_at) return;
      const stamp = new Date().toISOString();
      setTickets((prev: any) =>
        prev.map((t: any) => (t.id === ticket.id && !t.read_at ? { ...t, read_at: stamp } : t)),
      );
      api.markSupportTicketRead(projectId, ticket.id).catch(() => {});
    },
    [projectId],
  );
  const hasUnread = tickets.some((t: any) => !t.read_at);
  // Re-sort for display when the sort mode changes. The write paths keep
  // `tickets` in priority order; this memo applies the pure-date ordering on
  // top when selected, so toggling never needs a refetch.
  const sortedTickets = useMemo(() => sortTickets(tickets, sortMode), [tickets, sortMode]);
  const markAllRead = useCallback(() => {
    const stamp = new Date().toISOString();
    setTickets((prev: any) => prev.map((t: any) => (t.read_at ? t : { ...t, read_at: stamp })));
    setSupportUnreadCount(projectId, 0);
    api.markAllSupportTicketsRead(projectId).catch(() => {});
  }, [projectId, setSupportUnreadCount]);
  // Optimistically drop a row once its DELETE succeeds, independent of the
  // support_ticket_deleted WebSocket echo (which still arrives for other
  // clients).
  const removeTicket = useCallback((ticketId: any) => {
    setTickets((prev: any) => prev.filter((t: any) => t.id !== ticketId));
  }, []);
  // Insert/replace a ticket honouring the active filters — a status/type change
  // can move it out of the current view, so drop it then.
  const upsertOrDrop = (updated: any) => {
    setTickets((prev: any) => {
      const without = prev.filter((t: any) => t.id !== updated.id);
      const statusOk = activeStatusFilter.statuses.includes(updated.status);
      const typeOk = typeFilter === 'all' || updated.type === typeFilter;
      if (!statusOk || !typeOk) return without;
      return sortTickets([...without, updated]);
    });
    // Keep an open detail sheet in lock-step with the list. Every mutation
    // path (status, type, severity — optimistic write, server reconcile, and
    // rollback) funnels through here, so the sheet never shows a stale value.
    // Merge rather than replace: PATCH responses omit detail-only fields the
    // sheet loaded separately (release_notifications), which a bare
    // assignment would blank out.
    setSelectedTicket((cur: any) => mergeTicketDetail(cur, updated));
  };
  // Optimistically apply a status change, reconciling with the server's row.
  const setStatus = async (ticket: any, status: any, reason: any) => {
    upsertOrDrop({ ...ticket, status, wont_do_reason: status === 'wont_do' ? reason : null });
    try {
      const updated = await api.setSupportTicketStatus(projectId, ticket.id, status, reason);
      if (updated) upsertOrDrop(updated);
    } catch (err: any) {
      upsertOrDrop(ticket); // revert
      Alert.alert('Could not update status', err?.message || 'Failed to update status');
    }
  };
  const handleWontDo = (ticket: any) => {
    setWontDoTicket(ticket);
    setWontDoReason(ticket.wont_do_reason || '');
  };
  const submitWontDo = async () => {
    const reason = wontDoReason.trim();
    if (!reason || !wontDoTicket) return;
    const target = wontDoTicket;
    setWontDoTicket(null);
    await setStatus(target, 'wont_do', reason);
  };
  const setType = async (ticket: any, type: any) => {
    setReclassifyTicket(null);
    upsertOrDrop({ ...ticket, type });
    try {
      const updated = await api.setSupportTicketType(projectId, ticket.id, type);
      if (updated) upsertOrDrop(updated);
    } catch (err: any) {
      upsertOrDrop(ticket);
      Alert.alert('Could not reclassify ticket', err?.message || 'Failed to reclassify ticket');
    }
  };
  // Severity drives the queue order and the priority a converted card
  // inherits, so it stays editable after intake got it wrong.
  const setSeverity = async (ticket: any, severity: any) => {
    setSeverityTicket(null);
    upsertOrDrop({ ...ticket, severity });
    try {
      const updated = await api.setSupportTicketSeverity(projectId, ticket.id, severity);
      if (updated) upsertOrDrop(updated);
    } catch (err: any) {
      upsertOrDrop(ticket);
      Alert.alert('Could not change severity', err?.message || 'Failed to change severity');
    }
  };
  const handleTicketPress = useCallback(
    (ticket: any) => {
      markRead(ticket);
      setSelectedTicket(ticket);
      api
        .getSupportTicket(projectId, ticket.id)
        .then((detail: any) => {
          setSelectedTicket((cur: any) => mergeTicketDetail(cur, detail));
        })
        .catch(() => {});
    },
    [markRead, projectId],
  );
  const retryNotification = async (notification: any) => {
    if (!projectId || !selectedTicket || !notification?.id || !notification?.deployment_id) return;
    setRetryingNotificationId(notification.id);
    try {
      const res = await api.retryReleaseNotification(
        projectId,
        notification.deployment_id,
        notification.id,
      );
      const updatedNotification = res?.notification || {
        ...notification,
        status: 'pending',
        error_summary: null,
        can_retry: false,
      };
      const releaseNotifications = selectedTicket.release_notifications || [];
      const updatedTicket = {
        ...selectedTicket,
        release_notifications: releaseNotifications.map((item: any) =>
          item.id === notification.id ? updatedNotification : item,
        ),
      };
      setSelectedTicket(updatedTicket);
      upsertOrDrop(updatedTicket);
      Alert.alert('Customer Support', 'Release notification queued for retry');
    } catch (err: any) {
      Alert.alert('Retry failed', err?.message || 'Failed to retry release notification');
    } finally {
      setRetryingNotificationId(null);
    }
  };
  // Deep-link: a `support_ticket_created` notification tap routes here with the
  // triggering ticket id (see `notificationRouteToNavigation`). Open that
  // ticket once it's present in the loaded list instead of leaving the user on
  // the list. The ref guard makes it fire once per distinct target so backing
  // out (or a WebSocket list refresh) doesn't force the detail back open.
  const deepLinkedTicketId = route?.params?.ticketId;
  const deepLinkAppliedRef = useRef<any>(null);
  useEffect(() => {
    if (!deepLinkedTicketId) return;
    if (deepLinkAppliedRef.current === deepLinkedTicketId) return;
    const match = tickets.find((t: any) => t.id === deepLinkedTicketId);
    if (!match) return;
    deepLinkAppliedRef.current = deepLinkedTicketId;
    handleTicketPress(match);
  }, [deepLinkedTicketId, tickets, handleTicketPress]);
  const renderItem = ({ item }: any) => (
    <TicketCard
      item={item}
      projectId={projectId}
      onOpenReplay={openReplay}
      onDeleted={removeTicket}
      onPress={handleTicketPress}
      onSetStatus={setStatus}
      onWontDo={handleWontDo}
      onReclassify={setReclassifyTicket}
      onReRate={setSeverityTicket}
      onConverted={upsertOrDrop}
    />
  );
  if (selectedTicket) {
    const title = selectedTicket.subject?.trim() || selectedTicket.body?.trim() || '(no subject)';
    const screenshotUrl = resolveUploadUrl(selectedTicket.screenshot_ref);
    const releaseNotifications = selectedTicket.release_notifications || [];
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => setSelectedTicket(null)} style={styles.menuButton}>
            <Text style={styles.backIcon}>{'\u2190'}</Text>
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>
            Support ticket
          </Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Text style={styles.detailTitle}>{title}</Text>
          <Text style={styles.detailMeta}>
            {TYPE_LABEL[selectedTicket.type] || 'Other'} · {selectedTicket.severity} ·{' '}
            {STATUS_LABEL[selectedTicket.status] || selectedTicket.status}
          </Text>
          <TouchableOpacity
            testID="detail-reclassify-ticket"
            onPress={() => setReclassifyTicket(selectedTicket)}
            style={styles.detailReclassifyButton}
          >
            <Text style={styles.statusActionText}>Reclassify</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="detail-re-rate-ticket"
            onPress={() => setSeverityTicket(selectedTicket)}
            style={styles.detailReclassifyButton}
          >
            <Text style={styles.statusActionText}>Severity</Text>
          </TouchableOpacity>
          {selectedTicket.body ? (
            <Text style={styles.detailBody}>{selectedTicket.body}</Text>
          ) : null}
          {reporterText(selectedTicket) ? (
            <Text style={styles.reporter}>{reporterText(selectedTicket)}</Text>
          ) : null}
          {selectedTicket.status === 'wont_do' && selectedTicket.wont_do_reason ? (
            <View style={styles.wontDoBox} testID="detail-wont-do-reason">
              <Text style={styles.wontDoLabel}>Won&apos;t do</Text>
              <Text style={styles.wontDoText}>{selectedTicket.wont_do_reason}</Text>
            </View>
          ) : null}
          {selectedTicket.ai_summary ? (
            <View style={styles.aiBox}>
              <Text style={styles.aiLabel}>AI investigation</Text>
              <Text style={styles.aiText}>{selectedTicket.ai_summary}</Text>
            </View>
          ) : null}
          <TicketInvestigationControl
            projectId={projectId}
            ticket={selectedTicket}
            agents={(agents || []).filter((agent: any) => agent.projectId === projectId)}
            onUpdated={upsertOrDrop}
          />
          <View style={styles.notificationSection}>
            <Text style={styles.notificationTitle}>Notifications</Text>
            {releaseNotifications.length === 0 ? (
              <Text style={styles.notificationEmpty}>No release notifications recorded.</Text>
            ) : (
              releaseNotifications.map((notification: any) => {
                const retrying = retryingNotificationId === notification.id;
                return (
                  <View key={notification.id} style={styles.notificationCard}>
                    <View style={styles.notificationHeader}>
                      <Text style={styles.notificationRecipient}>
                        {notificationRecipientLabel(notification)}
                      </Text>
                      <Text style={styles.notificationStatus}>
                        {notificationStatusLabel(notification)}
                      </Text>
                    </View>
                    <Text style={styles.notificationSubject} numberOfLines={2}>
                      {notification.subject || 'Release notification'}
                    </Text>
                    <Text style={styles.notificationMeta}>
                      {notification.attempts || 0} attempts
                      {notification.sent_at ? ` · sent ${relativeTime(notification.sent_at)}` : ''}
                    </Text>
                    {notification.error_summary ? (
                      <Text style={styles.notificationError}>{notification.error_summary}</Text>
                    ) : null}
                    {notification.can_retry ? (
                      <TouchableOpacity
                        onPress={() => retryNotification(notification)}
                        disabled={retrying}
                        style={[
                          styles.notificationRetryButton,
                          retrying && styles.convertButtonDisabled,
                        ]}
                      >
                        <Text style={styles.notificationRetryText}>
                          {retrying ? 'Retrying…' : 'Retry'}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                );
              })
            )}
          </View>
          {screenshotUrl ? (
            <Image
              source={{ uri: screenshotUrl }}
              style={styles.detailScreenshot}
              resizeMode="contain"
            />
          ) : null}
        </ScrollView>
        <Modal
          visible={!!reclassifyTicket}
          transparent
          animationType="fade"
          onRequestClose={() => setReclassifyTicket(null)}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard} testID="reclassify-modal">
              <Text style={styles.modalTitle}>Reclassify ticket</Text>
              {TYPE_OPTIONS.map((t: any) => {
                const active = reclassifyTicket?.type === t.key;
                return (
                  <TouchableOpacity
                    key={t.key}
                    testID={`reclassify-option-${t.key}`}
                    onPress={() =>
                      reclassifyTicket ? setType(reclassifyTicket, t.key) : undefined
                    }
                    style={[styles.reclassifyOption, active && styles.statusActionButtonActive]}
                  >
                    <Text
                      style={[styles.statusActionText, active && styles.statusActionTextActive]}
                    >
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <View style={styles.modalActions}>
                <TouchableOpacity
                  onPress={() => setReclassifyTicket(null)}
                  style={styles.modalCancel}
                >
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
        <Modal
          visible={!!severityTicket}
          transparent
          animationType="fade"
          onRequestClose={() => setSeverityTicket(null)}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard} testID="severity-modal">
              <Text style={styles.modalTitle}>Change severity</Text>
              {SEVERITY_OPTIONS.map((s: any) => {
                const active = severityTicket?.severity === s.key;
                return (
                  <TouchableOpacity
                    key={s.key}
                    testID={`severity-option-${s.key}`}
                    onPress={() =>
                      severityTicket ? setSeverity(severityTicket, s.key) : undefined
                    }
                    style={[styles.reclassifyOption, active && styles.statusActionButtonActive]}
                  >
                    <Text
                      style={[styles.statusActionText, active && styles.statusActionTextActive]}
                    >
                      {s.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <View style={styles.modalActions}>
                <TouchableOpacity
                  onPress={() => setSeverityTicket(null)}
                  style={styles.modalCancel}
                >
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'☰'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Customer Support</Text>
        {hasUnread ? (
          <TouchableOpacity
            onPress={markAllRead}
            testID="mark-all-read"
            style={styles.markAllButton}
          >
            <Text style={styles.markAllText}>Mark all read</Text>
          </TouchableOpacity>
        ) : null}
        {project && (
          <Text style={styles.projectLabel} numberOfLines={1}>
            {project.name}
          </Text>
        )}
      </View>

      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f: any) => (
          <TouchableOpacity
            key={f.key}
            testID={`status-filter-${f.key}`}
            onPress={() => setStatusFilter(f.key)}
            style={[styles.filterButton, statusFilter === f.key && styles.filterButtonActive]}
          >
            <Text style={[styles.filterText, statusFilter === f.key && styles.filterTextActive]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.typeFilterRow}>
        {TYPE_FILTERS.map((f: any) => (
          <TouchableOpacity
            key={f.key}
            testID={`type-filter-${f.key}`}
            onPress={() => setTypeFilter(f.key)}
            style={[styles.typeFilterButton, typeFilter === f.key && styles.filterButtonActive]}
          >
            <Text style={[styles.filterText, typeFilter === f.key && styles.filterTextActive]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.sortRow}>
        <Text style={styles.sortLabel}>Sort</Text>
        {SORT_MODES.map((s: any) => (
          <TouchableOpacity
            key={s.key}
            testID={`sort-mode-${s.key}`}
            onPress={() => setSortMode(s.key)}
            style={[styles.typeFilterButton, sortMode === s.key && styles.filterButtonActive]}
          >
            <Text style={[styles.filterText, sortMode === s.key && styles.filterTextActive]}>
              {s.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="small" color={colors.gray400} />
        </View>
      ) : error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : tickets.length === 0 ? (
        <View style={styles.centerState}>
          <Text style={styles.emptyTitle}>No support requests</Text>
          <Text style={styles.emptyDesc}>Incoming requests appear here, most urgent first.</Text>
        </View>
      ) : (
        <FlatList
          data={sortedTickets}
          keyExtractor={(item: any) => item.id}
          contentContainerStyle={{ padding: 12 }}
          renderItem={renderItem}
        />
      )}

      <Modal
        visible={!!wontDoTicket}
        transparent
        animationType="fade"
        onRequestClose={() => setWontDoTicket(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="wont-do-modal">
            <Text style={styles.modalTitle}>Won&apos;t do — why?</Text>
            <TextInput
              testID="wont-do-input"
              value={wontDoReason}
              onChangeText={setWontDoReason}
              placeholder="Reason this won't be done"
              placeholderTextColor={colors.gray600}
              style={styles.modalInput}
              multiline
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={() => setWontDoTicket(null)} style={styles.modalCancel}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="wont-do-save"
                onPress={submitWontDo}
                disabled={!wontDoReason.trim()}
                style={[styles.modalSave, !wontDoReason.trim() && styles.convertButtonDisabled]}
              >
                <Text style={styles.modalSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        visible={!!reclassifyTicket}
        transparent
        animationType="fade"
        onRequestClose={() => setReclassifyTicket(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="reclassify-modal">
            <Text style={styles.modalTitle}>Reclassify ticket</Text>
            {TYPE_OPTIONS.map((t: any) => {
              const active = reclassifyTicket?.type === t.key;
              return (
                <TouchableOpacity
                  key={t.key}
                  testID={`reclassify-option-${t.key}`}
                  onPress={() => (reclassifyTicket ? setType(reclassifyTicket, t.key) : undefined)}
                  style={[styles.reclassifyOption, active && styles.statusActionButtonActive]}
                >
                  <Text style={[styles.statusActionText, active && styles.statusActionTextActive]}>
                    {t.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <View style={styles.modalActions}>
              <TouchableOpacity
                onPress={() => setReclassifyTicket(null)}
                style={styles.modalCancel}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        visible={!!severityTicket}
        transparent
        animationType="fade"
        onRequestClose={() => setSeverityTicket(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="severity-modal">
            <Text style={styles.modalTitle}>Change severity</Text>
            {SEVERITY_OPTIONS.map((s: any) => {
              const active = severityTicket?.severity === s.key;
              return (
                <TouchableOpacity
                  key={s.key}
                  testID={`severity-option-${s.key}`}
                  onPress={() => (severityTicket ? setSeverity(severityTicket, s.key) : undefined)}
                  style={[styles.reclassifyOption, active && styles.statusActionButtonActive]}
                >
                  <Text style={[styles.statusActionText, active && styles.statusActionTextActive]}>
                    {s.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={() => setSeverityTicket(null)} style={styles.modalCancel}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 8,
  },
  menuButton: { padding: 4 },
  menuIcon: { fontSize: 22, color: colors.gray400 },
  title: { fontSize: 17, fontWeight: '600', color: colors.white, flexShrink: 1 },
  markAllButton: {
    marginLeft: 'auto',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  markAllText: { fontSize: 11, color: colors.gray300, fontWeight: '600' },
  projectLabel: { marginLeft: 'auto', fontSize: 12, color: colors.gray500, maxWidth: 120 },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  filterButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.gray800,
  },
  filterButtonActive: { backgroundColor: colors.gray700 },
  filterText: { fontSize: 12, color: colors.gray500 },
  filterTextActive: { color: colors.gray200, fontWeight: '600' },
  centerState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: colors.gray400, marginBottom: 6 },
  emptyDesc: { fontSize: 13, color: colors.gray600, textAlign: 'center', lineHeight: 18 },
  errorText: { fontSize: 13, color: colors.red400, textAlign: 'center' },
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
  },
  cardUnread: { borderLeftWidth: 3, borderLeftColor: colors.blue400 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.blue400 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  severityBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  severityText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  typeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: colors.gray800,
  },
  typeText: { fontSize: 10, fontWeight: '600', color: colors.gray300 },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: colors.gray700_40,
  },
  statusText: { fontSize: 10, color: colors.gray500 },
  releaseBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.emerald500,
    backgroundColor: colors.gray900,
  },
  releaseText: { fontSize: 10, color: colors.emerald300, fontWeight: '600' },
  time: { fontSize: 11, color: colors.gray600, marginLeft: 'auto' },
  cardTitle: { fontSize: 14, color: colors.gray200, fontWeight: '600', marginTop: 6 },
  cardTitleUnread: { color: colors.white, fontWeight: '700' },
  cardBody: { fontSize: 12, color: colors.gray500, marginTop: 4 },
  reporter: { fontSize: 11, color: colors.gray600, marginTop: 6 },
  aiBox: {
    marginTop: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.purple900_40,
    backgroundColor: colors.purple900_40,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  aiLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.purple400,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  aiText: { fontSize: 12, color: colors.gray300 },
  investigationBox: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray950,
    padding: 10,
  },
  investigationLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.gray500,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  investigationRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  investigationPicker: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  investigationPickerText: { color: colors.gray300, fontSize: 11 },
  investigateButton: {
    borderWidth: 1,
    borderColor: colors.purple400,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  investigateButtonText: { color: colors.purple400, fontSize: 11, fontWeight: '700' },
  replayLink: { fontSize: 12, color: colors.blue400, marginTop: 8 },
  screenshot: {
    marginTop: 8,
    width: '100%',
    height: 160,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  convertOptions: { marginTop: 10, gap: 8 },
  linkOptions: { marginTop: 10, gap: 8 },
  linkLabel: { fontSize: 13, color: colors.gray300, fontWeight: '600' },
  linkHint: { fontSize: 12, color: colors.gray500, paddingVertical: 6 },
  linkCardList: {
    maxHeight: 160,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    backgroundColor: colors.gray800,
  },
  linkCardOption: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray700,
  },
  linkCardOptionActive: { backgroundColor: colors.gray700 },
  linkCardOptionText: { fontSize: 12, color: colors.gray300 },
  linkCardOptionTextActive: { color: colors.white, fontWeight: '600' },
  autoMergeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  autoMergeLabel: { fontSize: 13, color: colors.gray300 },
  convertComment: {
    backgroundColor: colors.gray800,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.white,
    fontSize: 13,
    minHeight: 56,
    textAlignVertical: 'top',
  },
  convertButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  convertButtonDisabled: { opacity: 0.5 },
  convertButtonText: { fontSize: 12, color: colors.gray300, fontWeight: '600' },
  convertedText: { fontSize: 12, color: colors.emerald400 },
  convertErrorText: { fontSize: 11, color: colors.red400 },
  deleteButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  deleteButtonText: { fontSize: 12, color: colors.red400, fontWeight: '600' },
  backIcon: { fontSize: 22, color: colors.gray400 },
  detailTitle: { fontSize: 18, fontWeight: '700', color: colors.white, marginBottom: 8 },
  detailMeta: { fontSize: 12, color: colors.gray500, marginBottom: 12 },
  detailReclassifyButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    marginBottom: 12,
  },
  detailBody: { fontSize: 14, color: colors.gray300, lineHeight: 20 },
  detailScreenshot: {
    marginTop: 12,
    width: '100%',
    height: 220,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  notificationSection: { marginTop: 12, gap: 8 },
  notificationTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.gray500,
    textTransform: 'uppercase',
  },
  notificationEmpty: { color: colors.gray500, fontSize: 12 },
  notificationCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    padding: 10,
    gap: 5,
  },
  notificationHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  notificationRecipient: { flex: 1, color: colors.gray200, fontSize: 13, fontWeight: '700' },
  notificationStatus: { color: colors.gray400, fontSize: 11 },
  notificationSubject: { color: colors.gray400, fontSize: 12 },
  notificationMeta: { color: colors.gray500, fontSize: 11 },
  notificationError: { color: colors.red400, fontSize: 12 },
  notificationRetryButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: 2,
  },
  notificationRetryText: { color: colors.gray300, fontSize: 12, fontWeight: '700' },
  typeFilterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 6,
  },
  typeFilterButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: colors.gray800,
  },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 6,
  },
  sortLabel: { color: colors.gray600, fontSize: 11, marginRight: 2 },
  statusActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  statusActionButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  statusActionButtonActive: { backgroundColor: colors.gray700 },
  statusActionText: { fontSize: 11, color: colors.gray400, fontWeight: '600' },
  statusActionTextActive: { color: colors.gray200 },
  wontDoBox: {
    marginTop: 8,
    borderLeftWidth: 2,
    borderLeftColor: colors.gray700,
    paddingLeft: 8,
  },
  wontDoLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.gray500,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  wontDoText: { fontSize: 12, color: colors.gray300 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.gray900,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
    padding: 16,
  },
  modalTitle: { fontSize: 15, fontWeight: '700', color: colors.white, marginBottom: 10 },
  modalInput: {
    minHeight: 64,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    backgroundColor: colors.gray950,
    color: colors.gray100,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  modalCancel: { paddingHorizontal: 12, paddingVertical: 8 },
  modalCancelText: { fontSize: 13, color: colors.gray400, fontWeight: '600' },
  modalSave: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  modalSaveText: { fontSize: 13, color: colors.gray200, fontWeight: '700' },
  reclassifyOption: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    marginBottom: 8,
  },
});
