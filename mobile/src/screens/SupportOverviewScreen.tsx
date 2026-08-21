import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { SidebarContext } from '../context/SidebarContext';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import { api } from '../utils/api';
import { SUPPORT_SEVERITY_DOT } from '../utils/dashboard';
import { createRequestGenerationState, beginRequest } from '@shared/utils/requestGeneration';
import {
  groupTicketsByProject,
  paginate,
  pageCount,
  clampPage,
  type SupportSeverity,
  type ProjectSection,
} from '@shared/utils/supportOverview';

/**
 * Cross-project support dashboard (mobile parity with web SupportOverviewPage):
 * every project's support issues on one screen, grouped into a section per
 * project and paginated within each section so a busy project can't run its
 * list off the screen. Reads the existing overview endpoint; grouping and
 * pagination reuse the shared pure helpers in `@shared/utils/supportOverview`.
 */

const SECTION_PAGE_SIZE = 6;
const REFRESH_MS = 15000;
const SEVERITY_ORDER: readonly SupportSeverity[] = ['critical', 'high', 'medium', 'low'];

const STATUS_FILTERS: { key: string; label: string; status?: string }[] = [
  { key: 'open', label: 'Open', status: 'new,investigating' },
  { key: 'all', label: 'All' },
];

interface OverviewData {
  tickets: any[];
  projects: { id: string; name: string; count: number }[];
}

export default function SupportOverviewScreen() {
  const navigation = useNavigation<any>();
  const { openSidebar } = useContext(SidebarContext);
  const { projects } = useApp();

  const [data, setData] = useState<OverviewData>({ tickets: [], projects: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusKey, setStatusKey] = useState('open');

  const mountedRef = useRef(true);
  const genRef = useRef(createRequestGenerationState());
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const statusValue = useMemo(
    () => STATUS_FILTERS.find((f) => f.key === statusKey)?.status,
    [statusKey],
  );

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const req = beginRequest(genRef.current, { silent });
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      let committed = false;
      try {
        const res = await api.getAllSupportTickets(statusValue ? { status: statusValue } : {});
        if (mountedRef.current && req.canCommit()) {
          req.commit();
          committed = true;
          setData({
            tickets: Array.isArray(res?.tickets) ? res.tickets : [],
            projects: Array.isArray(res?.projects) ? res.projects : [],
          });
          setError(null);
        }
      } catch (err: any) {
        if (!silent && mountedRef.current && req.canCommit()) {
          req.commit();
          committed = true;
          setError(err?.message || String(err));
        }
      } finally {
        if (mountedRef.current && (committed || req.ownsLoading())) setLoading(false);
      }
    },
    [statusValue],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => load({ silent: true }), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const findProject = useCallback(
    (projectId: any) => projects?.find((p: any) => p.id === projectId),
    [projects],
  );

  const openProjectSupport = useCallback(
    (projectId: string, ticketId?: string | null) => {
      if (!projectId) return;
      navigation.navigate('CustomerSupport', {
        projectId,
        project: findProject(projectId),
        ticketId: ticketId || undefined,
      });
    },
    [findProject, navigation],
  );

  const sections = useMemo(
    () => groupTicketsByProject(data.tickets, data.projects),
    [data.tickets, data.projects],
  );
  const totalTickets = data.tickets.length;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'☰'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Support</Text>
      </View>

      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key}
            onPress={() => setStatusKey(f.key)}
            style={[styles.filterChip, statusKey === f.key && styles.filterChipActive]}
            accessibilityState={{ selected: statusKey === f.key }}
          >
            <Text
              style={[styles.filterChipText, statusKey === f.key && styles.filterChipTextActive]}
            >
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
        <Text style={styles.countLabel}>
          {totalTickets} across {sections.length} project{sections.length === 1 ? '' : 's'}
        </Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              if (mountedRef.current) setRefreshing(false);
            }}
            tintColor={colors.gray400}
          />
        }
      >
        {error ? (
          <View style={styles.card}>
            <Text style={styles.errorInline}>Failed to load support issues: {error}</Text>
          </View>
        ) : loading && totalTickets === 0 ? (
          <View style={styles.card}>
            <Text style={styles.muted}>Loading support issues…</Text>
          </View>
        ) : sections.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.muted}>No support issues in this view. Everything is triaged.</Text>
          </View>
        ) : (
          sections.map((section) => (
            <ProjectSupportSection
              key={section.id}
              section={section}
              onOpenProjectSupport={openProjectSupport}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ProjectSupportSection({
  section,
  onOpenProjectSupport,
}: {
  section: ProjectSection;
  onOpenProjectSupport: (projectId: string, ticketId?: string | null) => void;
}) {
  const [page, setPage] = useState(1);
  const total = section.tickets.length;
  const pages = pageCount(total, SECTION_PAGE_SIZE);

  useEffect(() => {
    setPage((p) => clampPage(p, total, SECTION_PAGE_SIZE));
  }, [total]);

  const safePage = clampPage(page, total, SECTION_PAGE_SIZE);
  const visible = useMemo(
    () => paginate(section.tickets, safePage, SECTION_PAGE_SIZE),
    [section.tickets, safePage],
  );
  const start = (safePage - 1) * SECTION_PAGE_SIZE;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle} numberOfLines={1}>
          {section.name}
        </Text>
        <View style={styles.severityRow}>
          {SEVERITY_ORDER.map((sev) =>
            section.severityCounts[sev] > 0 ? (
              <View key={sev} style={styles.severityBadge}>
                <View style={[styles.dot, { backgroundColor: SUPPORT_SEVERITY_DOT[sev] }]} />
                <Text style={styles.severityCount}>{section.severityCounts[sev]}</Text>
              </View>
            ) : null,
          )}
        </View>
      </View>

      <View style={styles.card}>
        {visible.map((ticket: any) => {
          const title = ticket.subject?.trim() || ticket.body?.trim() || '(no subject)';
          const dot = SUPPORT_SEVERITY_DOT[ticket.severity] || SUPPORT_SEVERITY_DOT.low;
          return (
            <TouchableOpacity
              key={ticket.id}
              style={styles.row}
              testID="support-overview-row"
              onPress={() => onOpenProjectSupport(String(ticket.project_id), ticket.id)}
            >
              <View style={[styles.dot, { backgroundColor: dot }]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {title}
                </Text>
                {ticket.status ? (
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {ticket.status}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.rowTime}>
                {ticket.created_at ? relativeTime(ticket.created_at) : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {pages > 1 ? (
        <View style={styles.pager}>
          <Text style={styles.pagerLabel}>
            {start + 1}–{start + visible.length} of {total}
          </Text>
          <View style={styles.pagerButtons}>
            <TouchableOpacity
              onPress={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              style={[styles.pagerButton, safePage <= 1 && styles.pagerButtonDisabled]}
              accessibilityLabel="Previous page"
            >
              <Text style={styles.pagerButtonText}>‹</Text>
            </TouchableOpacity>
            <Text style={styles.pagerPage}>
              {safePage} / {pages}
            </Text>
            <TouchableOpacity
              onPress={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={safePage >= pages}
              style={[styles.pagerButton, safePage >= pages && styles.pagerButtonDisabled]}
              accessibilityLabel="Next page"
            >
              <Text style={styles.pagerButtonText}>›</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 8,
  },
  menuButton: { padding: 8 },
  menuIcon: { color: colors.gray300, fontSize: 22 },
  title: { color: colors.white, fontSize: 18, fontWeight: '600', flex: 1 },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  filterChipActive: { backgroundColor: 'rgba(59,130,246,0.2)', borderColor: colors.blue500 },
  filterChipText: { color: colors.gray400, fontSize: 12 },
  filterChipTextActive: { color: colors.blue300 },
  countLabel: { color: colors.gray600, fontSize: 11, marginLeft: 'auto' },
  scroll: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 24 },
  section: { marginBottom: 16 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    paddingHorizontal: 2,
    gap: 8,
  },
  sectionTitle: { color: colors.gray200, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  severityRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  severityBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  severityCount: { color: colors.gray400, fontSize: 11 },
  card: {
    backgroundColor: colors.gray900,
    borderColor: colors.gray800,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray800,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowTitle: { color: colors.white, fontSize: 14 },
  rowMeta: { color: colors.gray500, fontSize: 11, marginTop: 2 },
  rowTime: { color: colors.gray500, fontSize: 11 },
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
    paddingHorizontal: 2,
  },
  pagerLabel: { color: colors.gray600, fontSize: 11 },
  pagerButtons: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pagerButton: {
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  pagerButtonDisabled: { opacity: 0.4 },
  pagerButtonText: { color: colors.gray300, fontSize: 18, lineHeight: 22 },
  pagerPage: { color: colors.gray500, fontSize: 11 },
  muted: { color: colors.gray600, fontSize: 13, padding: 16, textAlign: 'center' },
  errorInline: { color: colors.red400, fontSize: 13, padding: 16, textAlign: 'center' },
});
