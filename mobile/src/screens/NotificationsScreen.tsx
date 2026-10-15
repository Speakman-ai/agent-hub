import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { InboxNotification } from '@shared/utils/notificationInbox';
import AppIcon from '../components/AppIcon';
import { SidebarContext } from '../context/SidebarContext';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import { notificationInboxStore, useNotificationInbox } from '../utils/notificationInboxInstance';
import { approvalIdFromNotification } from '@shared/utils/approvals';
import { usePendingApprovals } from '../hooks/usePendingApprovals';
import ApprovalActions from '../components/ApprovalActions';

/**
 * The bell inbox (mobile parity with the web bell popover): newest first,
 * unread rows marked with an accent border, tap to open and mark read, Mark
 * all read in the header, 20 rows per page with more loaded on scroll, and a
 * footer link to Settings > Notifications.
 */
export default function NotificationsScreen() {
  const navigation = useNavigation<any>();
  const { openSidebar } = useContext(SidebarContext);
  const { openInboxNotification } = useApp();
  const inbox = useNotificationInbox();
  // Approval rows still waiting for an answer get action buttons.
  const approvals = usePendingApprovals({ enabled: inbox.active });

  // Every visit starts from the newest page so rows missed while away (or
  // while the socket was down) show up.
  useEffect(() => {
    void notificationInboxStore.loadFirstPage();
  }, [inbox.active]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void notificationInboxStore.loadFirstPage().finally(() => setRefreshing(false));
  }, []);

  const onRowPress = useCallback(
    (n: InboxNotification) => {
      const route = openInboxNotification(n);
      if (route?.kind === 'chat') navigation.navigate('Chat');
    },
    [openInboxNotification, navigation],
  );

  const pendingById = new Map(approvals.pending.map((a) => [a.id, a]));

  const canMarkAll = inbox.unreadCount > 0 || inbox.items.some((n) => !n.readAt);

  const renderItem = ({ item: n }: { item: InboxNotification }) => {
    const unread = !n.readAt;
    const approvalId = approvalIdFromNotification(n);
    const approval = approvalId ? pendingById.get(approvalId) : undefined;
    const rowView = (
      <TouchableOpacity
        onPress={() => onRowPress(n)}
        style={[styles.row, unread ? styles.rowUnread : null]}
        accessibilityRole="button"
        accessibilityLabel={unread ? `Unread: ${n.title}` : n.title}
        testID={`notification-row-${n.id}`}
      >
        <View style={styles.rowHeader}>
          <Text style={[styles.rowTitle, unread ? styles.rowTitleUnread : null]} numberOfLines={1}>
            {n.title}
          </Text>
          <Text style={styles.rowTime}>{relativeTime(n.createdAt)}</Text>
        </View>
        {n.body ? (
          <Text style={styles.rowBody} numberOfLines={2}>
            {n.body}
          </Text>
        ) : null}
      </TouchableOpacity>
    );
    if (!approval) return rowView;
    return (
      <View key={n.id}>
        {rowView}
        <View
          style={[styles.approvalActions, unread ? styles.rowUnread : null]}
          testID={`notification-approval-${n.id}`}
        >
          <ApprovalActions
            approval={approval}
            testIDPrefix={`notification-approval-${n.id}`}
            onSettled={(id) => {
              approvals.drop(id);
              if (!n.readAt) notificationInboxStore.markRead(n);
            }}
          />
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={openSidebar}
          style={styles.menuButton}
          accessibilityLabel="Open menu"
        >
          <AppIcon name="menu" size={22} color={colors.gray400} />
        </TouchableOpacity>
        <Text style={styles.title}>Notifications</Text>
        <TouchableOpacity
          onPress={() => notificationInboxStore.markAllRead()}
          disabled={!canMarkAll}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canMarkAll }}
          testID="notifications-mark-all"
        >
          <Text style={[styles.markAll, !canMarkAll ? styles.markAllDisabled : null]}>
            Mark all read
          </Text>
        </TouchableOpacity>
      </View>

      {inbox.actionError ? (
        <View
          style={styles.actionError}
          accessibilityRole="alert"
          testID="notifications-action-error"
        >
          <Text style={styles.actionErrorText}>{inbox.actionError}</Text>
          <TouchableOpacity
            onPress={() => notificationInboxStore.dismissActionError()}
            accessibilityLabel="Dismiss"
          >
            <AppIcon name="close" size={16} color={colors.red400} />
          </TouchableOpacity>
        </View>
      ) : null}

      <FlatList
        style={styles.list}
        data={inbox.items}
        keyExtractor={(n) => n.id}
        renderItem={renderItem}
        onEndReached={() => void notificationInboxStore.loadMore()}
        onEndReachedThreshold={0.5}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          inbox.error ? (
            <Text style={styles.errorText}>{inbox.error}</Text>
          ) : inbox.loaded ? (
            <Text style={styles.empty}>You&apos;re all caught up.</Text>
          ) : null
        }
        ListFooterComponent={
          inbox.loading && !refreshing ? (
            <ActivityIndicator style={styles.spinner} color={colors.gray500} />
          ) : inbox.items.length > 0 && inbox.error ? (
            <Text style={styles.errorText}>{inbox.error}</Text>
          ) : null
        }
      />

      <TouchableOpacity
        style={styles.footer}
        onPress={() => navigation.navigate('Settings', { tab: 'notifications' })}
        accessibilityRole="button"
        testID="notifications-settings"
      >
        <AppIcon name="settings-outline" size={14} color={colors.gray400} />
        <Text style={styles.footerText}>Notification settings</Text>
      </TouchableOpacity>
    </SafeAreaView>
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
  title: { color: colors.white, fontSize: 18, fontWeight: '600', flex: 1 },
  markAll: { color: colors.indigo400, fontSize: 13, paddingHorizontal: 4, paddingVertical: 6 },
  markAllDisabled: { color: colors.gray600 },
  actionError: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: 'rgba(69, 10, 10, 0.4)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(127, 29, 29, 0.5)',
  },
  actionErrorText: { color: colors.red400, fontSize: 12, flex: 1 },
  list: { flex: 1 },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  approvalActions: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  rowUnread: { borderLeftColor: colors.indigo500, backgroundColor: 'rgba(31, 41, 55, 0.3)' },
  rowHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowTitle: { flex: 1, color: colors.gray300, fontSize: 14 },
  rowTitleUnread: { color: colors.gray100, fontWeight: '600' },
  rowTime: { color: colors.gray500, fontSize: 11 },
  rowBody: { marginTop: 2, color: colors.gray400, fontSize: 12 },
  empty: { color: colors.gray500, fontSize: 14, textAlign: 'center', paddingVertical: 32 },
  errorText: { color: colors.red400, fontSize: 13, textAlign: 'center', paddingVertical: 16 },
  spinner: { paddingVertical: 12 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  footerText: { color: colors.gray400, fontSize: 12 },
});
