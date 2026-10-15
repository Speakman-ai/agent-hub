import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import AppIcon from './AppIcon';
import { colors } from '../theme/colors';
import { useNotificationInbox } from '../utils/notificationInboxInstance';
import { badgeLabel } from '../utils/notificationInboxStore';

/** Header bell with the inbox unread badge. Opens the Notifications screen. */
export default function NotificationBell({
  onPress,
  buttonStyle,
  testID = 'notification-bell',
}: {
  onPress: () => void;
  buttonStyle?: any;
  testID?: string;
}) {
  const { active, unreadCount } = useNotificationInbox();
  if (!active) return null;
  return (
    <TouchableOpacity
      style={[styles.button, buttonStyle]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'
      }
      testID={testID}
    >
      <AppIcon name="notifications-outline" size={20} color={colors.gray400} />
      {unreadCount > 0 ? (
        <View style={styles.badge} testID={`${testID}-badge`}>
          <Text style={styles.badgeText}>{badgeLabel(unreadCount)}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    padding: 8,
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 0,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: colors.indigo500,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.white,
    fontSize: 10,
    fontWeight: '600',
    lineHeight: 14,
  },
});
