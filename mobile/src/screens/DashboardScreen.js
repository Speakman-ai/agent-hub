import React, { useState, useEffect, useCallback, useContext } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SidebarContext } from '../context/SidebarContext';
import { getApiBaseUrl, getAuthHeaders } from '../utils/config';
import { getActiveOrg } from '../utils/orgs';
import { relativeTime } from '../utils/time';
import { colors } from '../theme/colors';
import {
  formatHeadlineTiles,
  priorityRows,
  columnRows,
  activityLabel,
  PRIORITY_KEYS,
} from '../utils/dashboard';

const PRIORITY_COLOR = {
  urgent: colors.red500,
  high: colors.amber400,
  medium: colors.yellow400,
  low: colors.emerald400,
};

const ACTIVITY_DOT = {
  card_created: colors.emerald400,
  card_updated: colors.amber400,
  session_created: colors.blue400,
  escalation: colors.rose400,
};

export default function DashboardScreen() {
  const { openSidebar } = useContext(SidebarContext);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async ({ asRefresh } = {}) => {
    const org = getActiveOrg();
    if (!org) {
      setError('No active organization.');
      return;
    }
    if (asRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const base = getApiBaseUrl();
      const res = await fetch(`${base}/orgs/${org.id}/dashboard`, {
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          detail = body.error || detail;
        } catch {
          /* not json */
        }
        throw new Error(detail);
      }
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const tiles = data ? formatHeadlineTiles(data.headline) : [];
  const cols = data ? columnRows(data.kanban?.byColumn) : [];
  const prios = data ? priorityRows(data.kanban?.byPriority) : [];
  const activity = data?.recentActivity || [];

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'\u2630'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Dashboard</Text>
        {data?.orgName && (
          <Text style={styles.orgLabel} numberOfLines={1}>
            {data.orgName}
          </Text>
        )}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load({ asRefresh: true })}
            tintColor={colors.gray400}
          />
        }
      >
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>Failed to load dashboard: {error}</Text>
          </View>
        ) : null}

        {loading && !data ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.blue400} />
          </View>
        ) : null}

        {data ? (
          <>
            {/* Headline tiles */}
            <View style={styles.headlineGrid} testID="headline-grid">
              {tiles.map((tile) => (
                <View key={tile.key} style={styles.headlineTile} testID={`headline-${tile.key}`}>
                  <Text style={styles.headlineLabel}>{tile.label}</Text>
                  <Text style={styles.headlineValue}>{tile.value}</Text>
                </View>
              ))}
            </View>

            {/* Kanban — by column */}
            <SectionHeader
              title="Kanban"
              subtitle={`${data.kanban?.totalCards ?? 0} cards · ${data.kanban?.totalBoards ?? 0} boards`}
            />
            <View style={styles.card} testID="kanban-by-column">
              <Text style={styles.cardLabel}>By column</Text>
              {cols.length === 0 ? (
                <Text style={styles.muted}>No columns yet.</Text>
              ) : (
                cols.map((row, i) => (
                  <View key={`${row.columnName}-${i}`} style={styles.barRow}>
                    <Text style={styles.barLabel} numberOfLines={1}>
                      {row.columnName}
                    </Text>
                    <View style={styles.barTrack}>
                      <View
                        style={[
                          styles.barFill,
                          {
                            width: `${Math.max(2, row.percent)}%`,
                            backgroundColor: colors.blue500,
                          },
                        ]}
                      />
                    </View>
                    <Text style={styles.barCount}>{row.count}</Text>
                  </View>
                ))
              )}
            </View>

            {/* Kanban — by priority */}
            <View style={styles.card} testID="kanban-by-priority">
              <Text style={styles.cardLabel}>By priority (open)</Text>
              {prios.map((row) => (
                <View key={row.key} style={styles.barRow}>
                  <Text style={[styles.barLabel, styles.capitalize]}>{row.key}</Text>
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        {
                          width: `${Math.max(2, row.percent)}%`,
                          backgroundColor: PRIORITY_COLOR[row.key] || colors.gray500,
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.barCount}>{row.count}</Text>
                </View>
              ))}
            </View>

            {/* Recent activity */}
            <SectionHeader title="Recent activity" />
            <View style={styles.card} testID="recent-activity">
              {activity.length === 0 ? (
                <Text style={styles.muted}>No recent activity yet.</Text>
              ) : (
                activity.map((item) => (
                  <View key={`${item.type}-${item.id}`} style={styles.activityRow}>
                    <View
                      style={[
                        styles.activityDot,
                        { backgroundColor: ACTIVITY_DOT[item.type] || colors.gray500 },
                      ]}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.activityTitle} numberOfLines={1}>
                        {item.title || '(untitled)'}
                      </Text>
                      <Text style={styles.activityMeta}>{activityLabel(item.type)}</Text>
                    </View>
                    <Text style={styles.activityTime}>{relativeTime(item.timestamp)}</Text>
                  </View>
                ))
              )}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionHeader({ title, subtitle }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

// Re-export priority keys for any future tests/screens that want the same
// ordering without needing to import from utils directly.
export { PRIORITY_KEYS };

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.gray950,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 8,
  },
  menuButton: {
    padding: 8,
  },
  menuIcon: {
    color: colors.gray300,
    fontSize: 22,
  },
  title: {
    color: colors.white,
    fontSize: 18,
    fontWeight: '600',
  },
  orgLabel: {
    flex: 1,
    color: colors.gray500,
    fontSize: 12,
    textAlign: 'right',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 12,
    paddingBottom: 24,
  },
  centered: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  errorBox: {
    backgroundColor: 'rgba(127, 29, 29, 0.5)',
    borderColor: colors.red600,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  errorText: {
    color: colors.red400,
    fontSize: 13,
  },
  headlineGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  headlineTile: {
    width: '48%',
    backgroundColor: colors.gray900,
    borderColor: colors.gray800,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  headlineLabel: {
    color: colors.gray400,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  headlineValue: {
    color: colors.white,
    fontSize: 22,
    fontWeight: '600',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: 8,
    marginBottom: 8,
  },
  sectionTitle: {
    color: colors.gray300,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '600',
  },
  sectionSubtitle: {
    color: colors.gray500,
    fontSize: 11,
  },
  card: {
    backgroundColor: colors.gray900,
    borderColor: colors.gray800,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  cardLabel: {
    color: colors.gray400,
    fontSize: 11,
    fontWeight: '500',
    marginBottom: 8,
  },
  muted: {
    color: colors.gray600,
    fontSize: 12,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  barLabel: {
    width: 96,
    color: colors.gray300,
    fontSize: 12,
  },
  capitalize: {
    textTransform: 'capitalize',
  },
  barTrack: {
    flex: 1,
    height: 6,
    backgroundColor: colors.gray800,
    borderRadius: 3,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
  },
  barCount: {
    width: 32,
    textAlign: 'right',
    color: colors.gray400,
    fontSize: 12,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray800,
  },
  activityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  activityTitle: {
    color: colors.white,
    fontSize: 13,
  },
  activityMeta: {
    color: colors.gray500,
    fontSize: 10,
  },
  activityTime: {
    color: colors.gray500,
    fontSize: 10,
  },
});
