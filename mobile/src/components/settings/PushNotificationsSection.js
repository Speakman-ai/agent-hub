import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Switch,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';

/** Matches server/push.ts PUSH_EVENT_TYPES */
export const PUSH_EVENT_OPTIONS = [
  { key: 'awaiting_feedback', label: 'Awaiting feedback', desc: 'Agent needs your input' },
  { key: 'ready_to_push', label: 'Ready to push', desc: 'Finalize passed — ready to ship' },
  { key: 'pushed', label: 'Pushed', desc: 'Changes were pushed to GitHub' },
  { key: 'support_ticket_created', label: 'Support ticket created', desc: 'New support ticket' },
  { key: 'thread_message', label: 'Thread messages', desc: 'New cron or heartbeat message' },
  { key: 'review_assigned_to_you', label: 'Review assigned to you', desc: 'PR or card needs review' },
  { key: 'pr_merged', label: 'PR merged', desc: 'Linked PR was merged' },
];

const PERMISSION_LABEL = {
  granted: 'Granted',
  denied: 'Denied',
  undetermined: 'Not requested',
  unavailable: 'Unavailable (simulator)',
};

export default function PushNotificationsSection() {
  const { pushToken, pushPermissionStatus } = useApp();
  const [enabledEvents, setEnabledEvents] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadPrefs = useCallback(async () => {
    if (!pushToken) {
      setEnabledEvents(null);
      return;
    }
    setLoading(true);
    try {
      const data = await api.getDeviceTokenPreferences(pushToken);
      const events = Array.isArray(data?.enabledEvents) ? data.enabledEvents : null;
      setEnabledEvents(events);
    } catch {
      setEnabledEvents(null);
    } finally {
      setLoading(false);
    }
  }, [pushToken]);

  useEffect(() => {
    loadPrefs();
  }, [loadPrefs]);

  const isEventEnabled = (key) => {
    if (!enabledEvents) return true;
    return enabledEvents.includes(key);
  };

  const handleToggle = async (key, value) => {
    if (!pushToken) return;
    const current = enabledEvents || PUSH_EVENT_OPTIONS.map((o) => o.key);
    const next = value ? [...new Set([...current, key])] : current.filter((k) => k !== key);
    setEnabledEvents(next);
    setSaving(true);
    try {
      await api.setDeviceTokenPreferences(pushToken, next);
    } catch (err) {
      Alert.alert('Notifications', err.message || 'Failed to save preferences');
      await loadPrefs();
    } finally {
      setSaving(false);
    }
  };

  const handleEnableAll = async () => {
    if (!pushToken) return;
    const all = PUSH_EVENT_OPTIONS.map((o) => o.key);
    setEnabledEvents(all);
    setSaving(true);
    try {
      await api.setDeviceTokenPreferences(pushToken, all);
    } catch (err) {
      Alert.alert('Notifications', err.message || 'Failed to save preferences');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Push Notifications</Text>
      <Text style={styles.hint}>
        Native notifications are limited to projects you own. Toggle which event types can reach your
        device below.
      </Text>

      <View style={styles.statusCard}>
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Permission</Text>
          <Text style={styles.statusValue}>
            {PERMISSION_LABEL[pushPermissionStatus] || pushPermissionStatus || 'Unknown'}
          </Text>
        </View>
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Device token</Text>
          <Text style={styles.statusValue} numberOfLines={1}>
            {pushToken ? `${pushToken.slice(0, 12)}…` : 'Not registered'}
          </Text>
        </View>
      </View>

      {!pushToken ? (
        <Text style={styles.muted}>
          Push notifications require a physical device with notification permission granted.
        </Text>
      ) : loading ? (
        <ActivityIndicator color={colors.gray400} style={{ marginVertical: 16 }} />
      ) : (
        <>
          <View style={styles.toolbar}>
            <Text style={styles.subheading}>Notify me about</Text>
            <TouchableOpacity onPress={handleEnableAll} disabled={saving}>
              <Text style={styles.linkText}>Enable all</Text>
            </TouchableOpacity>
          </View>
          {PUSH_EVENT_OPTIONS.map((opt) => (
            <View key={opt.key} style={styles.eventRow}>
              <View style={styles.eventInfo}>
                <Text style={styles.eventLabel}>{opt.label}</Text>
                <Text style={styles.eventDesc}>{opt.desc}</Text>
              </View>
              <Switch
                value={isEventEnabled(opt.key)}
                onValueChange={(v) => handleToggle(opt.key, v)}
                disabled={saving}
                trackColor={{ false: colors.gray700, true: colors.blue600 }}
                thumbColor={colors.white}
              />
            </View>
          ))}
        </>
      )}
    </View>
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
  muted: { fontSize: 12, color: colors.gray600, fontStyle: 'italic' },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  subheading: { fontSize: 12, color: colors.gray400, fontWeight: '600', textTransform: 'uppercase' },
  linkText: { fontSize: 12, color: colors.blue400 },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray800,
    gap: 12,
  },
  eventInfo: { flex: 1 },
  eventLabel: { fontSize: 14, color: colors.gray200 },
  eventDesc: { fontSize: 11, color: colors.gray600, marginTop: 2 },
});
