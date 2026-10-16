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
  MAX_CHAT_DIGEST_PROMPT_CHARS,
  MAX_CHAT_DIGESTS_PER_CHANNEL,
  builtInDigestDescription,
  chatDigestAgents,
  chatDigestDraftFrom as draftFrom,
  chatDigestDraftIsBuiltIn,
  chatDigestDraftReady,
  chatDigestRunResultText,
  chatDigestSaveBody,
  chatDigestStatusText,
  describeDigestSchedule,
  type ChatDigest,
  type ChatDigestDraft as Draft,
} from '@shared/utils/chatDigest';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

/** Which digest the editor is open on: a saved id, a new one, or none. */
type Editing = string | 'new' | null;

interface DigestProject {
  id: string;
  name: string;
  agents: { id: string; name: string; allowedSkills: string[] | null }[];
}

interface SkillOption {
  id: string;
  description?: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'Request failed');
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
 * Channel settings: the channel's scheduled digests. Mirrors the web section:
 * each digest runs its prompt as a session of the chosen project agent, with
 * the chosen skills, and posts the agent's reply in the channel.
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
  const [projects, setProjects] = useState<DigestProject[] | null>(null);
  const [skillOptions, setSkillOptions] = useState<SkillOption[] | 'error' | null>(null);
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

  const needsProjects = editing !== null;
  useEffect(() => {
    if (!needsProjects || projects) return;
    let live = true;
    api
      .getProjects()
      .then((p: unknown) => {
        if (!live) return;
        setProjects(
          (Array.isArray(p) ? p : [])
            .filter((x: any) => x && !isHubSystemProject(x))
            .map((x: any) => ({
              id: String(x.id),
              name: String(x.name || x.id),
              agents: chatDigestAgents(Array.isArray(x.agents) ? x.agents : []).map((a: any) => ({
                id: String(a.id),
                name: String(a.name || a.id),
                allowedSkills: Array.isArray(a.allowedSkills) ? a.allowedSkills : null,
              })),
            })),
        );
      })
      .catch((err: unknown) => {
        if (live) setError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [needsProjects, projects]);

  const skillsAgentId = editing !== null ? draft.agentId : '';
  useEffect(() => {
    setSkillOptions(null);
    if (!skillsAgentId) return;
    let live = true;
    api
      .getSkills(skillsAgentId)
      .then((list: unknown) => {
        if (live) setSkillOptions(Array.isArray(list) ? (list as SkillOption[]) : []);
      })
      .catch(() => {
        if (live) setSkillOptions('error');
      });
    return () => {
      live = false;
    };
  }, [skillsAgentId]);

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

  const project = projects?.find((p) => p.id === draft.projectId) ?? null;
  const agent = project?.agents.find((a) => a.id === draft.agentId) ?? null;
  const skills = Array.isArray(skillOptions)
    ? skillOptions.filter((sk) => !agent?.allowedSkills || agent.allowedSkills.includes(sk.id))
    : [];
  const toggleSkill = (id: string) =>
    setDraft((d) => ({
      ...d,
      skills: d.skills.includes(id) ? d.skills.filter((x) => x !== id) : [...d.skills, id],
    }));

  const save = () =>
    run(async () => {
      const body = chatDigestSaveBody(draft);
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
      const res = await api.hubChat.runDigest(channelId, id);
      if (res.digest) replace(res.digest);
      setNotice(chatDigestRunResultText(res.result ?? {}));
    });

  const atLimit = digests.length >= MAX_CHAT_DIGESTS_PER_CHANNEL;
  const canSave = !busy && chatDigestDraftReady(draft);
  const builtInText = chatDigestDraftIsBuiltIn(draft)
    ? builtInDigestDescription(draft.scope)
    : null;

  const renderEditor = (digest: ChatDigest | null) => (
    <View style={styles.editor} testID="hub-chat-digest-editor">
      <Text style={styles.label}>Name</Text>
      <TextInput
        testID="hub-chat-digest-name"
        value={draft.name}
        onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
        placeholder="Agent digest"
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
      {builtInText && (
        <Text style={styles.muted} testID="hub-chat-digest-builtin">
          {builtInText} Pick a project and agent to run your own prompt instead.
        </Text>
      )}
      <Text style={styles.label}>Project</Text>
      <View style={styles.chipRow}>
        {!projects && <ActivityIndicator color={colors.gray400} />}
        {projects?.map((p) => (
          <Chip
            key={p.id}
            testID={`hub-chat-digest-project-${p.id}`}
            label={p.name}
            active={draft.projectId === p.id}
            onPress={() => setDraft((d) => ({ ...d, projectId: p.id, agentId: '', skills: [] }))}
          />
        ))}
      </View>
      {project && (
        <>
          <Text style={styles.label}>Agent</Text>
          <View style={styles.chipRow}>
            {project.agents.length === 0 && (
              <Text style={styles.muted}>No agent can run digests in this project.</Text>
            )}
            {project.agents.map((a) => (
              <Chip
                key={a.id}
                testID={`hub-chat-digest-agent-${a.id}`}
                label={a.name}
                active={draft.agentId === a.id}
                onPress={() => setDraft((d) => ({ ...d, agentId: a.id, skills: [] }))}
              />
            ))}
          </View>
        </>
      )}
      {!!draft.agentId && (
        <>
          <Text style={styles.label}>Skills ({draft.skills.length} selected)</Text>
          <View style={styles.chipRow}>
            {skillOptions === 'error' ? (
              <Text style={styles.error}>Couldn't load skills.</Text>
            ) : !skillOptions ? (
              <ActivityIndicator color={colors.gray400} />
            ) : skills.length === 0 ? (
              <Text style={styles.muted}>No skills available.</Text>
            ) : (
              skills.map((sk) => (
                <Chip
                  key={sk.id}
                  multi
                  testID={`hub-chat-digest-skill-${sk.id}`}
                  label={sk.id}
                  active={draft.skills.includes(sk.id)}
                  onPress={() => toggleSkill(sk.id)}
                />
              ))
            )}
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
      <Text style={styles.label}>Prompt</Text>
      <TextInput
        testID="hub-chat-digest-prompt"
        value={draft.prompt}
        onChangeText={(prompt) => setDraft((d) => ({ ...d, prompt }))}
        placeholder="What should the agent do? Its final reply is posted in this channel."
        placeholderTextColor={colors.gray500}
        maxLength={MAX_CHAT_DIGEST_PROMPT_CHARS}
        multiline
        textAlignVertical="top"
        style={[styles.input, styles.prompt]}
        accessibilityLabel="Digest prompt"
      />
      <Text style={styles.muted}>
        {draft.prompt.length}/{MAX_CHAT_DIGEST_PROMPT_CHARS}
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
        An agent runs your prompt on a schedule and posts its reply here.
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
