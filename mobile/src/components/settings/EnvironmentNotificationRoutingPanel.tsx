import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { Mail, Save } from 'lucide-react-native';
import { colors } from '../../theme/colors';
import { api } from '../../utils/api';
import {
  routingDefaultLabel,
  summarizeRouting,
  type NotificationRouting,
} from '../../utils/deployNotificationRouting';

/**
 * Presentational body for the per-environment notification-routing editor. Pure
 * and props-driven so it can be render-tested (react-dom/server) without effects
 * or a live API — mirrors the EnvironmentTriggersPanelContent split.
 */
export function EnvironmentNotificationRoutingPanelContent({
  environmentName,
  routing,
  ticketReleaseEnabled,
  releaseDigestEnabled,
  loading,
  saving,
  error,
  dirty,
  onTicketReleaseChange,
  onReleaseDigestChange,
  onSave,
}: {
  environmentName: string;
  routing: NotificationRouting | null;
  ticketReleaseEnabled: boolean;
  releaseDigestEnabled: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  dirty: boolean;
  onTicketReleaseChange: (value: boolean) => void;
  onReleaseDigestChange: (value: boolean) => void;
  onSave: () => void;
}) {
  return (
    <View style={styles.panel} testID={`env-notification-routing-${environmentName}`}>
      <View style={styles.headerRow}>
        <Mail size={13} color={colors.purple400} />
        <Text style={styles.title}>Notification routing</Text>
        {routing ? (
          <View style={styles.chip}>
            <Text style={styles.chipText}>{routingDefaultLabel(routing)}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.help}>
        Which release emails fire when a deployment to {environmentName} succeeds. Production
        defaults to reporter + digest; other environments send nothing until enabled here.
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {loading && !routing ? (
        <ActivityIndicator color={colors.gray400} />
      ) : (
        <>
          <View style={styles.optionRow}>
            <View style={styles.optionText}>
              <Text style={styles.optionLabel}>Reporter emails</Text>
              <Text style={styles.optionHint}>
                notify support-ticket reporters their fix shipped
              </Text>
            </View>
            <Switch
              value={ticketReleaseEnabled}
              onValueChange={onTicketReleaseChange}
              accessibilityLabel="Send reporter emails"
            />
          </View>
          <View style={styles.optionRow}>
            <View style={styles.optionText}>
              <Text style={styles.optionLabel}>Release digest</Text>
              <Text style={styles.optionHint}>notify digest subscribers</Text>
            </View>
            <Switch
              value={releaseDigestEnabled}
              onValueChange={onReleaseDigestChange}
              accessibilityLabel="Send release digest emails"
            />
          </View>

          <View style={styles.footerRow}>
            <Text style={styles.summary} numberOfLines={2}>
              {summarizeRouting({ ticketReleaseEnabled, releaseDigestEnabled })}
            </Text>
            <TouchableOpacity
              onPress={onSave}
              disabled={saving || !dirty}
              style={[styles.saveButton, (saving || !dirty) && styles.disabled]}
              accessibilityLabel="Save notification routing"
            >
              {saving ? (
                <ActivityIndicator color={colors.emerald300} size="small" />
              ) : (
                <Save size={13} color={colors.emerald300} />
              )}
              <Text style={styles.saveButtonText}>Save</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

/**
 * Per-environment notification-routing editor (mobile). Owns state + API calls
 * and delegates rendering to {@link EnvironmentNotificationRoutingPanelContent}.
 * Mirrors the web EnvironmentNotificationRoutingPanel.
 */
export default function EnvironmentNotificationRoutingPanel({
  projectId,
  environmentName,
  onNotify,
}: {
  projectId: string;
  environmentName: string;
  onNotify?: (message: string, type?: string) => void;
}) {
  const [routing, setRouting] = useState<NotificationRouting | null>(null);
  const [ticketRelease, setTicketRelease] = useState(false);
  const [releaseDigest, setReleaseDigest] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notify = useCallback(
    (message: string, type: string = 'info') => onNotify?.(message, type),
    [onNotify],
  );

  const applyRouting = useCallback((next: NotificationRouting) => {
    setRouting(next);
    setTicketRelease(next.ticketReleaseEnabled);
    setReleaseDigest(next.releaseDigestEnabled);
  }, []);

  const load = useCallback(async () => {
    if (!projectId || !environmentName) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getNotificationRouting(projectId, environmentName);
      if (res?.routing) applyRouting(res.routing);
    } catch (e: any) {
      setError(e?.message || 'Failed to load notification routing');
    } finally {
      setLoading(false);
    }
  }, [projectId, environmentName, applyRouting]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty =
    !!routing &&
    (ticketRelease !== routing.ticketReleaseEnabled ||
      releaseDigest !== routing.releaseDigestEnabled);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await api.updateNotificationRouting(projectId, environmentName, {
        ticketReleaseEnabled: ticketRelease,
        releaseDigestEnabled: releaseDigest,
      });
      if (res?.routing) applyRouting(res.routing);
      notify(`Notification routing saved for ${environmentName}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to save notification routing', 'error');
    } finally {
      setSaving(false);
    }
  }, [projectId, environmentName, ticketRelease, releaseDigest, applyRouting, notify]);

  return (
    <EnvironmentNotificationRoutingPanelContent
      environmentName={environmentName}
      routing={routing}
      ticketReleaseEnabled={ticketRelease}
      releaseDigestEnabled={releaseDigest}
      loading={loading}
      saving={saving}
      error={error}
      dirty={dirty}
      onTicketReleaseChange={setTicketRelease}
      onReleaseDigestChange={setReleaseDigest}
      onSave={save}
    />
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 10,
    gap: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: colors.gray200, fontSize: 12, fontWeight: '600' },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  chipText: { color: colors.gray400, fontSize: 10, textTransform: 'uppercase' },
  help: { color: colors.gray500, fontSize: 11, lineHeight: 15 },
  error: { color: colors.red400, fontSize: 12 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 4,
  },
  optionText: { flex: 1 },
  optionLabel: { color: colors.gray200, fontSize: 12 },
  optionHint: { color: colors.gray500, fontSize: 11 },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    paddingTop: 8,
  },
  summary: { flex: 1, color: colors.gray500, fontSize: 11 },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.emerald500,
    backgroundColor: colors.emerald900_40,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  saveButtonText: { color: colors.emerald300, fontSize: 12, fontWeight: '500' },
  disabled: { opacity: 0.5 },
});
