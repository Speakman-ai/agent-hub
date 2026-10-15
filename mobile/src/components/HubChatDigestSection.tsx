import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { isHubSystemProject } from '@shared/utils/hub';
import {
  CHAT_DIGEST_PRESETS,
  DEFAULT_CHAT_DIGEST_CRON,
  DEFAULT_CHAT_DIGEST_INSTRUCTIONS,
  MAX_CHAT_DIGEST_PROJECTS,
  MAX_CHAT_DIGEST_PROMPT_CHARS,
  MAX_CHAT_DIGESTS_PER_CHANNEL,
  chatDigestStatusText,
  describeDigestSchedule,
  deviceTimeZone,
  type ChatDigest,
  type ChatDigestSaveRequest,
  type ChatDigestScope,
} from '@shared/utils/chatDigest';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

/** Which digest the editor is open on: a saved id, a new one, or none. */
type Editing = string | 'new' | null;

interface Draft {
  name: string;
  enabled: boolean;
  cron: string;
  timeZone: string;
  scope: ChatDigestScope;
  projectIds: string[];
  prompt: string;
}

interface RunResult {
  status: 'posted' | 'skipped' | 'cancelled' | 'error';
  reason?: string;
  error?: string;
}

function draftFrom(digest: ChatDigest | null, defaultProjectId: string | null): Draft {
  return {
    name: digest?.name ?? '',
    enabled: digest?.enabled ?? true,
    cron: digest?.cron ?? DEFAULT_CHAT_DIGEST_CRON,
    timeZone: digest?.timeZone ?? deviceTimeZone(),
    scope: digest?.scope ?? 'channel',
    projectIds: digest ? digest.projectIds : defaultProjectId ? [defaultProjectId] : [],
    prompt: digest?.prompt ?? '',
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'Request failed');
}

function runNotice(result: RunResult): string {
  if (result.status === 'posted') return 'Digest posted.';
  if (result.status === 'skipped') return 'Nothing new since the last digest, nothing posted.';
  if (result.status === 'cancelled') return `Run cancelled: ${result.reason || 'unknown reason'}`;
  return `Run failed: ${result.error || 'unknown error'}`;
}

function Chip({
  label,
  active,
  onPress,
  testID,
  multi = false,
  disabled = false,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
  multi?: boolean;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      style={[styles.chip, active && styles.chipActive, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={multi ? { checked: active, disabled } : { selected: active, disabled }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * Channel settings: the channel's scheduled AI digests. Mirrors the web
 * section: a list of digest cards, each opening an editor with scope,
 * projects, schedule and custom instructions.
 */
export default function HubChatDigestSection({
  channelId,
  channelProjectId,
}: {
  channelId: string;
  channelProjectId: string | null;
}) {
  const [digests, setDigests] = useState<ChatDigest[] | undefined>(undefined);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null, channelProjectId));
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDigests(undefined);
    setEditing(null);
    api.hubChat
      .digests(channelId)
      .then((res: { digests: ChatDigest[] }) => {
        if (live) setDigests(res.digests);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setDigests([]);
        setError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [channelId]);

  const needsProjects = editing !== null && draft.scope === 'project';
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
        setDraft((d) => (d.projectIds.length || !list[0] ? d : { ...d, projectIds: [list[0].id] }));
      })
      .catch((err: unknown) => {
        if (live) setError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [needsProjects, projects]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (digests === undefined) {
    return <ActivityIndicator color={colors.gray400} />;
  }

  const open = (next: Editing) => {
    setError(null);
    setNotice(null);
    setEditing(next);
    const digest = next && next !== 'new' ? (digests.find((d) => d.id === next) ?? null) : null;
    setDraft(draftFrom(digest, channelProjectId));
  };
  const replace = (digest: ChatDigest) =>
    setDigests((list) => (list ?? []).map((d) => (d.id === digest.id ? digest : d)));

  const toggleProject = (id: string) =>
    setDraft((d) => {
      if (d.projectIds.includes(id)) {
        return { ...d, projectIds: d.projectIds.filter((p) => p !== id) };
      }
      if (d.projectIds.length >= MAX_CHAT_DIGEST_PROJECTS) return d;
      return { ...d, projectIds: [...d.projectIds, id] };
    });

  const save = () =>
    run(async () => {
      const body: ChatDigestSaveRequest = {
        name: draft.name.trim() || undefined,
        enabled: draft.enabled,
        cron: draft.cron.trim(),
        timeZone: draft.timeZone.trim(),
        scope: draft.scope,
        projectIds: draft.scope === 'project' ? draft.projectIds : [],
        prompt: draft.prompt.trim() || null,
      };
      if (editing === 'new') {
        const res = await api.hubChat.createDigest(channelId, body);
        setDigests((list) => [...(list ?? []), res.digest]);
      } else if (editing) {
        const res = await api.hubChat.updateDigest(channelId, editing, body);
        replace(res.digest);
      }
      setEditing(null);
    });
  const remove = (id: string) =>
    run(async () => {
      await api.hubChat.removeDigest(channelId, id);
      setDigests((list) => (list ?? []).filter((d) => d.id !== id));
      setEditing(null);
    });
  const runNow = (id: string) =>
    run(async () => {
      const res: { result: RunResult; digest: ChatDigest | null } = await api.hubChat.runDigest(
        channelId,
        id,
      );
      if (res.digest) replace(res.digest);
      setNotice(runNotice(res.result));
    });

  const atLimit = digests.length >= MAX_CHAT_DIGESTS_PER_CHANNEL;
  const canSave =
    !busy &&
    draft.cron.trim().length > 0 &&
    draft.timeZone.trim().length > 0 &&
    (draft.scope === 'channel' || draft.projectIds.length > 0);

  const renderEditor = (digest: ChatDigest | null) => (
    <View style={styles.editor} testID="hub-chat-digest-editor">
      <Text style={styles.label}>Name</Text>
      <TextInput
        testID="hub-chat-digest-name"
        value={draft.name}
        onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
        placeholder="Defaults from what it summarizes"
        placeholderTextColor={colors.gray500}
        maxLength={80}
        style={styles.input}
        accessibilityLabel="Digest name"
      />
      <View style={styles.row}>
        <Text style={styles.label}>Enabled</Text>
        <Switch
          testID="hub-chat-digest-enabled"
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
        <>
          <Text style={styles.muted}>
            Projects ({draft.projectIds.length}/{MAX_CHAT_DIGEST_PROJECTS})
          </Text>
          <View style={styles.chipRow}>
            {!projects && <ActivityIndicator color={colors.gray400} />}
            {projects?.map((p) => {
              const selected = draft.projectIds.includes(p.id);
              return (
                <Chip
                  key={p.id}
                  multi
                  testID={`hub-chat-digest-project-${p.id}`}
                  label={p.name}
                  active={selected}
                  disabled={!selected && draft.projectIds.length >= MAX_CHAT_DIGEST_PROJECTS}
                  onPress={() => toggleProject(p.id)}
                />
              );
            })}
          </View>
        </>
      )}
      <Text style={styles.label}>Schedule</Text>
      <View style={styles.chipRow}>
        {CHAT_DIGEST_PRESETS.map((p, i) => (
          <Chip
            key={p.cron}
            testID={`hub-chat-digest-preset-${i}`}
            label={p.label}
            active={draft.cron.trim() === p.cron}
            onPress={() => setDraft((d) => ({ ...d, cron: p.cron }))}
          />
        ))}
      </View>
      <View style={styles.fieldRow}>
        <View style={styles.flex}>
          <Text style={styles.muted}>Cron</Text>
          <TextInput
            testID="hub-chat-digest-cron"
            value={draft.cron}
            onChangeText={(cron) => setDraft((d) => ({ ...d, cron }))}
            placeholder="0 9 * * 1-5"
            placeholderTextColor={colors.gray500}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, styles.mono]}
            accessibilityLabel="Digest cron"
          />
        </View>
        <View style={styles.flex}>
          <Text style={styles.muted}>Timezone</Text>
          <TextInput
            testID="hub-chat-digest-timezone"
            value={draft.timeZone}
            onChangeText={(timeZone) => setDraft((d) => ({ ...d, timeZone }))}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            accessibilityLabel="Digest timezone"
          />
        </View>
      </View>
      <Text style={styles.muted}>{describeDigestSchedule(draft.cron, draft.timeZone.trim())}</Text>
      <Text style={styles.label}>Instructions</Text>
      <TextInput
        testID="hub-chat-digest-prompt"
        value={draft.prompt}
        onChangeText={(prompt) => setDraft((d) => ({ ...d, prompt }))}
        placeholder={DEFAULT_CHAT_DIGEST_INSTRUCTIONS}
        placeholderTextColor={colors.gray500}
        maxLength={MAX_CHAT_DIGEST_PROMPT_CHARS}
        multiline
        textAlignVertical="top"
        style={[styles.input, styles.prompt]}
        accessibilityLabel="Digest instructions"
      />
      <Text style={styles.muted}>
        Leave blank for the default. {draft.prompt.length}/{MAX_CHAT_DIGEST_PROMPT_CHARS}
      </Text>
      {digest && (
        <Text style={styles.muted} testID="hub-chat-digest-status">
          {chatDigestStatusText(digest)}
        </Text>
      )}
      <View style={styles.actions}>
        {digest && (
          <TouchableOpacity
            testID="hub-chat-digest-remove"
            onPress={() => remove(digest.id)}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.danger}>Remove</Text>
          </TouchableOpacity>
        )}
        {digest && (
          <TouchableOpacity
            testID="hub-chat-digest-run"
            onPress={() => runNow(digest.id)}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.link}>Run now</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          testID="hub-chat-digest-cancel"
          onPress={() => open(null)}
          disabled={busy}
          accessibilityRole="button"
        >
          <Text style={styles.link}>Cancel</Text>
        </TouchableOpacity>
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

  return (
    <View style={styles.root} testID="hub-chat-digest">
      <Text style={styles.sectionLabel}>Scheduled digests</Text>
      <Text style={styles.muted}>
        AI summaries posted here on a schedule. Nothing is posted when nothing happened.
      </Text>
      {digests.length === 0 && editing !== 'new' && (
        <Text style={styles.muted} testID="hub-chat-digest-empty">
          No digests scheduled.
        </Text>
      )}
      {digests.map((d) =>
        editing === d.id ? (
          <View key={d.id} style={styles.card}>
            {renderEditor(d)}
          </View>
        ) : (
          <TouchableOpacity
            key={d.id}
            testID={`hub-chat-digest-card-${d.id}`}
            style={styles.card}
            onPress={() => open(d.id)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Edit digest ${d.name}`}
          >
            <Text style={styles.cardTitle}>{d.name}</Text>
            <Text style={styles.muted}>{describeDigestSchedule(d.cron, d.timeZone)}</Text>
            <Text style={styles.muted} testID={`hub-chat-digest-card-status-${d.id}`}>
              {chatDigestStatusText(d)}
            </Text>
          </TouchableOpacity>
        ),
      )}
      {editing === 'new' && <View style={styles.card}>{renderEditor(null)}</View>}
      {notice && (
        <Text style={styles.muted} testID="hub-chat-digest-notice">
          {notice}
        </Text>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      {editing === null && (
        <TouchableOpacity
          testID="hub-chat-digest-add"
          onPress={() => open('new')}
          disabled={busy || atLimit}
          style={[styles.addButton, (busy || atLimit) && styles.disabled]}
          accessibilityRole="button"
        >
          <Text style={styles.link}>
            {atLimit ? `Limit of ${MAX_CHAT_DIGESTS_PER_CHANNEL} digests reached` : '+ Add digest'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
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
  danger: { color: colors.red400, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldRow: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1, gap: 4 },
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
  card: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  cardTitle: { color: colors.white, fontSize: 14, fontWeight: '600' },
  editor: { gap: 6 },
  input: {
    color: colors.white,
    backgroundColor: colors.gray800,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
  },
  mono: { fontFamily: 'monospace' },
  prompt: { minHeight: 96 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 16,
    marginTop: 4,
  },
  addButton: { paddingVertical: 6 },
  primary: {
    backgroundColor: colors.blue600,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  primaryText: { color: colors.white, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
