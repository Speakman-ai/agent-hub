import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { isHubSystemProject } from '@shared/utils/hub';
import {
  CHAT_DIGEST_PRESETS,
  DEFAULT_CHAT_DIGEST_CRON,
  chatDigestStatusText,
  describeDigestSchedule,
  deviceTimeZone,
  type ChatDigest,
  type ChatDigestScope,
} from '@shared/utils/chatDigest';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

interface Draft {
  enabled: boolean;
  cron: string;
  timeZone: string;
  scope: ChatDigestScope;
  projectId: string;
}

function draftFrom(digest: ChatDigest | null, defaultProjectId: string | null): Draft {
  return {
    enabled: digest?.enabled ?? true,
    cron: digest?.cron ?? DEFAULT_CHAT_DIGEST_CRON,
    timeZone: digest?.timeZone ?? deviceTimeZone(),
    scope: digest?.scope ?? 'channel',
    projectId: digest?.projectId ?? defaultProjectId ?? '',
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'Request failed');
}

function Chip({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * Channel settings: the scheduled AI digest. Mirrors the web section; a custom
 * cron set on the web is kept and shown, and the timezone saved is the
 * existing one or this device's.
 */
export default function HubChatDigestSection({
  channelId,
  channelProjectId,
}: {
  channelId: string;
  channelProjectId: string | null;
}) {
  const [digest, setDigest] = useState<ChatDigest | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null, channelProjectId));
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.hubChat
      .digest(channelId)
      .then((res: { digest: ChatDigest | null }) => {
        if (!live) return;
        setDigest(res.digest);
        setDraft(draftFrom(res.digest, channelProjectId));
      })
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [channelId, channelProjectId]);

  const needsProjects = draft.scope === 'project';
  useEffect(() => {
    if (!needsProjects || projects) return;
    let live = true;
    api
      .getProjects()
      .then((p: unknown) => {
        if (!live) return;
        const list = (Array.isArray(p) ? p : [])
          .filter((x: any) => x && !isHubSystemProject(x))
          .map((x: any) => ({ id: String(x.id), name: String(x.name || x.id) }));
        setProjects(list);
        setDraft((d) => (d.projectId ? d : { ...d, projectId: list[0]?.id ?? '' }));
      })
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [needsProjects, projects]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (digest === undefined && !error) {
    return <ActivityIndicator color={colors.gray400} />;
  }

  const canSave = !busy && (draft.scope === 'channel' || draft.projectId.length > 0);
  const save = () =>
    run(async () => {
      const res = await api.hubChat.saveDigest(channelId, {
        enabled: draft.enabled,
        cron: draft.cron,
        timeZone: draft.timeZone,
        scope: draft.scope,
        projectId: draft.scope === 'project' ? draft.projectId : null,
      });
      setDigest(res.digest);
      setDraft(draftFrom(res.digest, channelProjectId));
    });
  const remove = () =>
    run(async () => {
      await api.hubChat.removeDigest(channelId);
      setDigest(null);
      setDraft(draftFrom(null, channelProjectId));
    });

  return (
    <View style={styles.root} testID="hub-chat-digest">
      <Text style={styles.sectionLabel}>Scheduled digest</Text>
      <Text style={styles.muted}>
        An AI summary posted here on a schedule. Nothing is posted when nothing happened.
      </Text>
      <View style={styles.row}>
        <Text style={styles.label}>Enabled</Text>
        <Switch
          value={draft.enabled}
          onValueChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
          accessibilityLabel="Digest enabled"
        />
      </View>
      <Text style={styles.label}>Summarize</Text>
      <View style={styles.chipRow}>
        <Chip
          label="This channel"
          testID="hub-chat-digest-scope-channel"
          active={draft.scope === 'channel'}
          onPress={() => setDraft((d) => ({ ...d, scope: 'channel' }))}
        />
        <Chip
          label="Project activity"
          testID="hub-chat-digest-scope-project"
          active={draft.scope === 'project'}
          onPress={() => setDraft((d) => ({ ...d, scope: 'project' }))}
        />
      </View>
      {draft.scope === 'project' && (
        <View style={styles.chipRow}>
          {!projects && <ActivityIndicator color={colors.gray400} />}
          {projects?.map((p) => (
            <Chip
              key={p.id}
              testID={`hub-chat-digest-project-${p.id}`}
              label={p.name}
              active={draft.projectId === p.id}
              onPress={() => setDraft((d) => ({ ...d, projectId: p.id }))}
            />
          ))}
        </View>
      )}
      <Text style={styles.label}>Schedule</Text>
      <View style={styles.chipRow}>
        {CHAT_DIGEST_PRESETS.map((p, i) => (
          <Chip
            key={p.cron}
            testID={`hub-chat-digest-preset-${i}`}
            label={p.label}
            active={draft.cron === p.cron}
            onPress={() => setDraft((d) => ({ ...d, cron: p.cron }))}
          />
        ))}
      </View>
      <Text style={styles.muted}>{describeDigestSchedule(draft.cron, draft.timeZone)}</Text>
      <Text style={styles.muted} testID="hub-chat-digest-status">
        {chatDigestStatusText(digest ?? null)}
      </Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.actions}>
        {digest && (
          <TouchableOpacity
            testID="hub-chat-digest-remove"
            onPress={remove}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.link}>Remove</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          testID="hub-chat-digest-save"
          onPress={save}
          disabled={!canSave}
          style={[styles.primary, !canSave && styles.disabled]}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>{digest ? 'Save digest' : 'Schedule digest'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 6, paddingHorizontal: 12, paddingVertical: 8 },
  sectionLabel: {
    color: colors.gray500,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  muted: { color: colors.gray400, fontSize: 12 },
  error: { color: colors.red400, fontSize: 13 },
  label: { color: colors.gray300, fontSize: 13 },
  link: { color: colors.blue400, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { color: colors.gray300, fontSize: 12 },
  chipTextActive: { color: colors.white },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 16,
    marginTop: 4,
  },
  primary: {
    backgroundColor: colors.blue600,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  primaryText: { color: colors.white, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
