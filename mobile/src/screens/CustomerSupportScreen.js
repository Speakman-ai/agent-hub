import React, { useState, useEffect, useCallback, useContext, useRef } from 'react';
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
} from '../utils/supportTickets';
import { SidebarContext } from '../context/SidebarContext';

const SEVERITY_COLOR = {
  critical: colors.red500,
  high: colors.rose400,
  medium: colors.amber400,
  low: colors.gray500,
};

const TYPE_LABEL = {
  bug: 'Bug',
  feature_request: 'Feature request',
  question: 'Question',
  incident: 'Incident',
  other: 'Other',
};

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'investigating', label: 'Investigating' },
];

function TicketCard({ item, projectId, onOpenReplay, onDeleted, onPress }) {
  const severityColor = SEVERITY_COLOR[item.severity] || colors.gray500;
  const title = item.subject?.trim() || item.body?.trim() || '(no subject)';
  const hasReplay = item.type === 'bug' && item.replay_ref;
  const screenshotUrl = resolveUploadUrl(item.screenshot_ref);
  const isConverted = item.status === 'converted' || !!item.converted_card_id;
  const isUnread = !item.read_at;

  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const handleConvert = async () => {
    if (converting || isConverted) return;
    setConverting(true);
    setConvertError(null);
    try {
      await api.convertSupportTicketToCard(projectId, item.id);
      // The support_ticket_updated WebSocket event re-renders this card as
      // converted; no local state mutation needed.
    } catch (err) {
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
          <Text style={styles.statusText}>{item.status}</Text>
        </View>
        <Text style={styles.time}>{relativeTime(item.created_at)}</Text>
      </View>

      <Text style={[styles.cardTitle, isUnread && styles.cardTitleUnread]}>{title}</Text>

      {item.subject?.trim() && item.body?.trim() ? (
        <Text style={styles.cardBody} numberOfLines={3}>
          {item.body}
        </Text>
      ) : null}

      {item.reporter ? <Text style={styles.reporter}>Reported by {item.reporter}</Text> : null}

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
          <Image
            source={{ uri: screenshotUrl }}
            style={styles.screenshot}
            resizeMode="contain"
          />
        </TouchableOpacity>
      ) : null}

      {hasReplay ? (
        <TouchableOpacity onPress={() => onOpenReplay(item.replay_ref)}>
          <Text style={styles.replayLink}>{'▶'} View session replay</Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.actionRow}>
        {isConverted ? (
          <Text style={styles.convertedText}>{'✓'} Converted to card</Text>
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
    </TouchableOpacity>
  );
}

export default function CustomerSupportScreen({ route }) {
  const {
    projects,
    lastSupportTicketEvent,
    refreshSupportUnreadCount,
    setSupportUnreadCount,
  } = useApp();
  const { openSidebar } = useContext(SidebarContext);

  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = projects?.find((p) => p.id === projectId);

  const [tickets, setTickets] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedTicket, setSelectedTicket] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getSupportTickets(
        projectId,
        statusFilter === 'all' ? undefined : statusFilter,
      );
      setTickets(sortTickets(Array.isArray(data) ? data : []));
    } catch (err) {
      setError(err.message || 'Failed to load support requests');
    } finally {
      setLoading(false);
    }
  }, [projectId, statusFilter]);

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
      setTickets((prev) => prev.filter((t) => t.id !== ticketId));
      return;
    }
    if (type === 'support_tickets_read_all') {
      const stamp = new Date().toISOString();
      setTickets((prev) => prev.map((t) => (t.read_at ? t : { ...t, read_at: stamp })));
      return;
    }
    if (!ticket) return;
    setTickets((prev) => {
      const without = prev.filter((t) => t.id !== ticket.id);
      // A status change can move a ticket out of the active filter.
      if (statusFilter !== 'all' && ticket.status !== statusFilter) return without;
      return sortTickets([...without, ticket]);
    });
  }, [lastSupportTicketEvent, projectId, statusFilter]);

  const openReplay = useCallback((ref) => {
    const url = resolveReplayUrl(ref);
    if (url) Linking.openURL(url).catch(() => {});
  }, []);

  // Tapping a ticket marks it read: optimistic local flip + fire-and-forget
  // POST (the WebSocket echo refreshes the drawer badge).
  const markRead = useCallback(
    (ticket) => {
      if (!ticket || ticket.read_at) return;
      const stamp = new Date().toISOString();
      setTickets((prev) =>
        prev.map((t) => (t.id === ticket.id && !t.read_at ? { ...t, read_at: stamp } : t)),
      );
      api.markSupportTicketRead(projectId, ticket.id).catch(() => {});
    },
    [projectId],
  );

  const hasUnread = tickets.some((t) => !t.read_at);

  const markAllRead = useCallback(() => {
    const stamp = new Date().toISOString();
    setTickets((prev) => prev.map((t) => (t.read_at ? t : { ...t, read_at: stamp })));
    setSupportUnreadCount(projectId, 0);
    api.markAllSupportTicketsRead(projectId).catch(() => {});
  }, [projectId, setSupportUnreadCount]);

  // Optimistically drop a row once its DELETE succeeds, independent of the
  // support_ticket_deleted WebSocket echo (which still arrives for other
  // clients).
  const removeTicket = useCallback((ticketId) => {
    setTickets((prev) => prev.filter((t) => t.id !== ticketId));
  }, []);

  const handleTicketPress = useCallback(
    (ticket) => {
      markRead(ticket);
      setSelectedTicket(ticket);
    },
    [markRead],
  );

  // Deep-link: a `support_ticket_created` notification tap routes here with the
  // triggering ticket id (see `notificationRouteToNavigation`). Open that
  // ticket once it's present in the loaded list instead of leaving the user on
  // the list. The ref guard makes it fire once per distinct target so backing
  // out (or a WebSocket list refresh) doesn't force the detail back open.
  const deepLinkedTicketId = route?.params?.ticketId;
  const deepLinkAppliedRef = useRef(null);
  useEffect(() => {
    if (!deepLinkedTicketId) return;
    if (deepLinkAppliedRef.current === deepLinkedTicketId) return;
    const match = tickets.find((t) => t.id === deepLinkedTicketId);
    if (!match) return;
    deepLinkAppliedRef.current = deepLinkedTicketId;
    handleTicketPress(match);
  }, [deepLinkedTicketId, tickets, handleTicketPress]);

  const renderItem = ({ item }) => (
    <TicketCard
      item={item}
      projectId={projectId}
      onOpenReplay={openReplay}
      onDeleted={removeTicket}
      onPress={handleTicketPress}
    />
  );

  if (selectedTicket) {
    const title =
      selectedTicket.subject?.trim() || selectedTicket.body?.trim() || '(no subject)';
    const screenshotUrl = resolveUploadUrl(selectedTicket.screenshot_ref);
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
            {selectedTicket.status}
          </Text>
          {selectedTicket.body ? (
            <Text style={styles.detailBody}>{selectedTicket.body}</Text>
          ) : null}
          {selectedTicket.reporter ? (
            <Text style={styles.reporter}>Reported by {selectedTicket.reporter}</Text>
          ) : null}
          {selectedTicket.ai_summary ? (
            <View style={styles.aiBox}>
              <Text style={styles.aiLabel}>AI investigation</Text>
              <Text style={styles.aiText}>{selectedTicket.ai_summary}</Text>
            </View>
          ) : null}
          {screenshotUrl ? (
            <Image source={{ uri: screenshotUrl }} style={styles.detailScreenshot} resizeMode="contain" />
          ) : null}
        </ScrollView>
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
        {STATUS_FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key}
            onPress={() => setStatusFilter(f.key)}
            style={[styles.filterButton, statusFilter === f.key && styles.filterButtonActive]}
          >
            <Text style={[styles.filterText, statusFilter === f.key && styles.filterTextActive]}>
              {f.label}
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
          data={tickets}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 12 }}
          renderItem={renderItem}
        />
      )}
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
});
