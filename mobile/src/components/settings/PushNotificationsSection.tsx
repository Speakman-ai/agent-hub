import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { View, Text, TouchableOpacity, Switch, StyleSheet, ActivityIndicator } from 'react-native';
import { useApp } from '../../context/AppContext';
import { colors } from '../../theme/colors';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_SECTIONS,
  type NotificationChannel,
} from '@shared/utils/notificationCategories';
import type { NotificationPreferencesPatch } from '../../utils/api';
import {
  getSnapshot,
  loadNotificationPrefs,
  saveNotificationPrefs,
  subscribe,
  type NotificationPrefsState,
} from '../../utils/notificationPreferences';

const PERMISSION_LABEL: Record<string, string> = {
  granted: 'Granted',
  denied: 'Denied',
  undetermined: 'Not requested',
  unavailable: 'Unavailable (simulator)',
  unsupported: 'Unavailable (simulator)',
};

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: 'In-app',
  desktop: 'Desktop',
  push: 'Push',
};

/** Patch that turns every channel of every category in a section on or off. */
export function sectionPatch(
  categoryIds: readonly string[],
  value: boolean,
): NotificationPreferencesPatch {
  const patch: NotificationPreferencesPatch = {};
  for (const id of categoryIds) patch[id] = { in_app: value, desktop: value, push: value };
  return patch;
}

export interface NotificationPrefsContentProps extends NotificationPrefsState {
  pushToken: string | null;
  pushPermissionStatus: string | null;
  expanded: Record<string, boolean>;
  onToggleExpanded: (categoryId: string) => void;
  onSave: (patch: NotificationPreferencesPatch) => void;
  onRetry: () => void;
}

export function NotificationPrefsContent({
  loaded,
  loading,
  error,
  prefs,
  pushToken,
  pushPermissionStatus,
  expanded,
  onToggleExpanded,
  onSave,
  onRetry,
}: NotificationPrefsContentProps) {
  const editable = loaded;
  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Notifications</Text>
      <Text style={styles.hint}>
        Choose how you hear about each kind of event. These settings apply to every device you sign
        in on.
      </Text>

      <View style={styles.statusCard}>
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Push permission</Text>
          <Text style={styles.statusValue}>
            {(pushPermissionStatus && PERMISSION_LABEL[pushPermissionStatus]) ||
              pushPermissionStatus ||
              'Unknown'}
          </Text>
        </View>
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>This device</Text>
          <Text style={styles.statusValue} numberOfLines={1}>
            {pushToken ? 'Registered for push' : 'Not registered'}
          </Text>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          {!loaded && !loading ? (
            <TouchableOpacity onPress={onRetry} accessibilityRole="button">
              <Text style={styles.linkText}>Retry</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {loading && !loaded ? (
        <ActivityIndicator color={colors.gray400} style={{ marginVertical: 16 }} />
      ) : null}

      {NOTIFICATION_SECTIONS.map((section) => {
        const ids = section.categories.map((c) => c.id as string);
        const allOn = ids.every((id) => NOTIFICATION_CHANNELS.every((ch) => prefs[id]?.[ch]));
        return (
          <View key={section.id} style={styles.card} testID={`notification-section-${section.id}`}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{section.label}</Text>
              <View style={styles.enableAll}>
                <Text style={styles.enableAllText}>Enable all</Text>
                <Switch
                  value={allOn}
                  disabled={!editable}
                  accessibilityLabel={`Enable all ${section.label} notifications`}
                  onValueChange={(v: boolean) => onSave(sectionPatch(ids, v))}
                  trackColor={{ false: colors.gray700, true: colors.blue600 }}
                  thumbColor={colors.white}
                />
              </View>
            </View>
            {section.categories.map((cat) => {
              const values = prefs[cat.id];
              const open = !!expanded[cat.id];
              const on = NOTIFICATION_CHANNELS.filter((ch) => values?.[ch]).map(
                (ch) => CHANNEL_LABELS[ch],
              );
              return (
                <View key={cat.id} style={styles.categoryRow}>
                  <TouchableOpacity
                    onPress={() => onToggleExpanded(cat.id)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    testID={`notification-category-${cat.id}`}
                    style={styles.categoryHeader}
                  >
                    <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
                    <View style={styles.eventInfo}>
                      <Text style={styles.eventLabel}>{cat.label}</Text>
                      <Text style={styles.eventDesc}>{cat.description}</Text>
                    </View>
                    <Text style={styles.summary}>{on.length ? on.join(', ') : 'Off'}</Text>
                  </TouchableOpacity>
                  {open ? (
                    <View style={styles.channels}>
                      {NOTIFICATION_CHANNELS.map((ch) => (
                        <View key={ch} style={styles.channelRow}>
                          <Text style={styles.channelLabel}>{CHANNEL_LABELS[ch]}</Text>
                          <Switch
                            value={!!values?.[ch]}
                            disabled={!editable}
                            accessibilityLabel={`${cat.label}: ${CHANNEL_LABELS[ch]}`}
                            testID={`notification-toggle-${cat.id}-${ch}`}
                            onValueChange={(v: boolean) => onSave({ [cat.id]: { [ch]: v } })}
                            trackColor={{ false: colors.gray700, true: colors.blue600 }}
                            thumbColor={colors.white}
                          />
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

export default function PushNotificationsSection() {
  const { pushToken, pushPermissionStatus } = useApp();
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void loadNotificationPrefs();
  }, []);

  return (
    <NotificationPrefsContent
      {...state}
      pushToken={pushToken ?? null}
      pushPermissionStatus={pushPermissionStatus ?? null}
      expanded={expanded}
      onToggleExpanded={(id) => setExpanded((cur) => ({ ...cur, [id]: !cur[id] }))}
      onSave={saveNotificationPrefs}
      onRetry={() => void loadNotificationPrefs()}
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 6,
  },
  hint: { fontSize: 12, color: colors.gray500, marginBottom: 12, lineHeight: 18 },
  statusCard: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    padding: 12,
    marginBottom: 16,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  statusLabel: { fontSize: 12, color: colors.gray500 },
  statusValue: { fontSize: 12, color: colors.gray300, maxWidth: '60%' },
  errorBox: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.red600,
    backgroundColor: colors.red900_50,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
    gap: 8,
  },
  errorText: { flex: 1, fontSize: 12, color: colors.red400 },
  linkText: { fontSize: 12, color: colors.blue400 },
  card: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray800,
  },
  cardTitle: { fontSize: 14, fontWeight: '600', color: colors.gray200 },
  enableAll: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  enableAllText: { fontSize: 11, color: colors.gray400 },
  categoryRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray800,
  },
  categoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  chevron: { fontSize: 12, color: colors.gray500, width: 12 },
  eventInfo: { flex: 1 },
  eventLabel: { fontSize: 14, color: colors.gray200 },
  eventDesc: { fontSize: 11, color: colors.gray600, marginTop: 2 },
  summary: { fontSize: 11, color: colors.gray500, maxWidth: '35%', textAlign: 'right' },
  channels: { paddingLeft: 34, paddingRight: 12, paddingBottom: 8 },
  channelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  channelLabel: { fontSize: 13, color: colors.gray300 },
});
