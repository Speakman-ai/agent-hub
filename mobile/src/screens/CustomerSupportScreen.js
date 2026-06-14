import React, { useState, useEffect, useCallback, useContext } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import { sortTickets, resolveReplayUrl } from '../utils/supportTickets';
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
  { key: 'converted', label: 'Converted' },
  { key: 'closed', label: 'Closed' },
];

export default function CustomerSupportScreen({ route }) {
  const { projects, lastSupportTicketEvent } = useApp();
  const { openSidebar } = useContext(SidebarContext);

  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = projects?.find((p) => p.id === projectId);

  const [tickets, setTickets] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  // React to live WebSocket events from AppContext
  useEffect(() => {
    if (!lastSupportTicketEvent) return;
    const { type, projectId: evtProjectId, ticket, ticketId } = lastSupportTicketEvent;
    if (evtProjectId !== projectId) return;

    if (type === 'support_ticket_deleted') {
      setTickets((prev) => prev.filter((t) => t.id !== ticketId));
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

  const renderItem = ({ item }) => {
    const severityColor = SEVERITY_COLOR[item.severity] || colors.gray500;
    const title = item.subject?.trim() || item.body?.trim() || '(no subject)';
    const hasReplay = item.type === 'bug' && item.replay_ref;
    return (
      <View style={styles.card}>
        <View style={styles.badgeRow}>
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

        <Text style={styles.cardTitle}>{title}</Text>

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

        {hasReplay ? (
          <TouchableOpacity onPress={() => openReplay(item.replay_ref)}>
            <Text style={styles.replayLink}>{'▶'} View session replay</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'☰'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Customer Support</Text>
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
});
