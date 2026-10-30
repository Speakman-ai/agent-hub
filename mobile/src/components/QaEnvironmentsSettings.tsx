import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  draftFromQaEnvironment,
  emptyQaAccount,
  emptyQaEnvironment,
  parseQaAutoDelay,
  QA_AUTO_DELAY_MAX_MINUTES,
  qaEnvironmentDraftToInput,
  validateQaEnvironmentDraft,
  type QaAccountDraft,
  type QaEnvironmentDraft,
  type QaEnvironmentWire,
} from '@shared/utils/qaEnvironments';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function EnvironmentEditor({
  projectId,
  initial,
  onSaved,
  onDeleted,
  isDefault = false,
  onToggleDefault,
}: {
  projectId: string;
  initial: QaEnvironmentDraft;
  onSaved: (env: QaEnvironmentWire) => void;
  onDeleted: () => void;
  isDefault?: boolean;
  /** Absent for an unsaved environment: it has no id to mark yet. */
  onToggleDefault?: (next: boolean) => Promise<void>;
}) {
  const [togglingDefault, setTogglingDefault] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [dirty, setDirty] = useState(!initial.id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edits are locked while a save is in flight: the response replaces the
  // draft, so anything typed meanwhile would be silently dropped.
  const update = (patch: Partial<QaEnvironmentDraft>) => {
    if (saving) return;
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const updateAccount = (key: string, patch: Partial<QaAccountDraft>) =>
    update({ accounts: draft.accounts.map((a) => (a.key === key ? { ...a, ...patch } : a)) });

  const save = async () => {
    const invalid = validateQaEnvironmentDraft(draft);
    if (invalid) return setError(invalid);
    setSaving(true);
    setError(null);
    try {
      const input = qaEnvironmentDraftToInput(draft);
      const res = draft.id
        ? await api.updateQaEnvironment(projectId, draft.id, input)
        : await api.createQaEnvironment(projectId, input);
      setDraft(draftFromQaEnvironment(res.environment));
      setDirty(false);
      onSaved(res.environment);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!draft.id) return onDeleted();
    const id = draft.id;
    Alert.alert('Delete environment', `Delete "${draft.name}" and its test accounts?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          api
            .deleteQaEnvironment(projectId, id)
            .then(onDeleted)
            .catch((e) => setError(errorText(e)));
        },
      },
    ]);
  };

  return (
    <View style={styles.card} testID="qa-env-editor">
      <Text style={styles.label}>Name</Text>
      <TextInput
        editable={!saving}
        style={styles.input}
        placeholder="Staging"
        placeholderTextColor={colors.gray500}
        value={draft.name}
        onChangeText={(name) => update({ name })}
      />
      <Text style={styles.label}>Base URL</Text>
      <TextInput
        editable={!saving}
        style={styles.input}
        placeholder="https://staging.example.com"
        placeholderTextColor={colors.gray500}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={draft.baseUrl}
        onChangeText={(baseUrl) => update({ baseUrl })}
      />
      <Text style={styles.label}>Server notes</Text>
      <TextInput
        editable={!saving}
        style={[styles.input, styles.multiline]}
        multiline
        placeholder="Build or version, seed data, feature flags, anything a tester should know."
        placeholderTextColor={colors.gray500}
        value={draft.notes}
        onChangeText={(notes) => update({ notes })}
      />
      <Text style={styles.label}>Test accounts</Text>
      {draft.accounts.map((a, i) => (
        <View key={a.key} style={styles.account} testID="qa-env-account">
          <View style={styles.accountHeader}>
            <Text style={styles.accountTitle}>Account {i + 1}</Text>
            <TouchableOpacity
              disabled={saving}
              accessibilityLabel={`Remove account ${i + 1}`}
              onPress={() => update({ accounts: draft.accounts.filter((x) => x.key !== a.key) })}
            >
              <Text style={styles.remove}>Remove</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            editable={!saving}
            style={styles.input}
            accessibilityLabel={`Account ${i + 1} label`}
            placeholder="Label (e.g. Admin)"
            placeholderTextColor={colors.gray500}
            value={a.label}
            onChangeText={(label) => updateAccount(a.key, { label })}
          />
          <TextInput
            editable={!saving}
            style={styles.input}
            accessibilityLabel={`Account ${i + 1} username`}
            placeholder="Username or email"
            placeholderTextColor={colors.gray500}
            autoCapitalize="none"
            autoCorrect={false}
            value={a.username}
            onChangeText={(username) => updateAccount(a.key, { username })}
          />
          <TextInput
            editable={!saving}
            style={styles.input}
            accessibilityLabel={`Account ${i + 1} password`}
            placeholder="Password"
            placeholderTextColor={colors.gray500}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="oneTimeCode"
            value={a.password}
            onChangeText={(password) => updateAccount(a.key, { password })}
          />
          <TextInput
            editable={!saving}
            style={styles.input}
            accessibilityLabel={`Account ${i + 1} notes`}
            placeholder="Notes (role, permissions, 2FA)"
            placeholderTextColor={colors.gray500}
            value={a.notes}
            onChangeText={(notes) => updateAccount(a.key, { notes })}
          />
        </View>
      ))}
      <TouchableOpacity
        disabled={saving}
        style={styles.secondary}
        onPress={() => update({ accounts: [...draft.accounts, emptyQaAccount()] })}
      >
        <Text style={styles.secondaryText}>+ Add account</Text>
      </TouchableOpacity>
      <View style={styles.defaultRow}>
        <Switch
          testID="qa-env-default"
          accessibilityLabel="Default environment"
          value={isDefault}
          disabled={!onToggleDefault || togglingDefault}
          onValueChange={async (next) => {
            if (!onToggleDefault) return;
            setTogglingDefault(true);
            setError(null);
            try {
              await onToggleDefault(next);
            } catch (e) {
              setError(errorText(e));
            } finally {
              setTogglingDefault(false);
            }
          }}
        />
        <Text style={styles.defaultText}>
          Default{onToggleDefault ? '' : ' (create the environment first)'}
        </Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <TouchableOpacity
          testID="qa-env-save"
          disabled={saving || !dirty}
          onPress={() => void save()}
          style={[styles.primary, (saving || !dirty) && styles.disabled]}
        >
          <Text style={styles.primaryText}>
            {saving ? 'Saving…' : draft.id ? 'Save' : 'Create environment'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity disabled={saving} onPress={remove}>
          <Text style={styles.remove}>{draft.id ? 'Delete environment' : 'Discard'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function AutomatedQaSettings({ projectId }: { projectId: string }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getQaSettings(projectId)
      .then(({ settings }) => {
        if (cancelled) return;
        setSaved(settings.autoQaDelayMinutes);
        setValue(String(settings.autoQaDelayMinutes));
      })
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const parsed = parseQaAutoDelay(value);
  const save = async () => {
    if (parsed === null) {
      setError(`Enter whole minutes from 0 to ${QA_AUTO_DELAY_MAX_MINUTES}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { settings } = await api.updateQaSettings(projectId, { autoQaDelayMinutes: parsed });
      setSaved(settings.autoQaDelayMinutes);
      setValue(String(settings.autoQaDelayMinutes));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.card} testID="qa-automated-settings">
      <Text style={styles.label}>Default delay for automated QA (minutes)</Text>
      <TextInput
        testID="qa-auto-delay"
        accessibilityLabel="Default delay for automated QA"
        editable={saved !== null && !saving}
        style={styles.input}
        keyboardType="number-pad"
        value={value}
        onChangeText={setValue}
      />
      <Text style={styles.hint}>
        When a session runs QA tests, the run waits this long after the session merges so the deploy
        can reach the default environment.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity
        testID="qa-auto-delay-save"
        disabled={saving || saved === null || parsed === saved}
        onPress={() => void save()}
        style={[styles.primary, (saving || saved === null || parsed === saved) && styles.disabled]}
      >
        <Text style={styles.primaryText}>{saving ? 'Saving…' : 'Save'}</Text>
      </TouchableOpacity>
    </View>
  );
}

/** QA settings on mobile: servers under test and their test accounts. */
export default function QaEnvironmentsSettings({ projectId }: { projectId: string }) {
  const [saved, setSaved] = useState<QaEnvironmentWire[] | null>(null);
  const [drafts, setDrafts] = useState<Array<{ key: number; draft: QaEnvironmentDraft }>>([]);
  const [nextKey, setNextKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listQaEnvironments(projectId);
      setSaved(res.environments);
      setError(null);
    } catch (e) {
      setError(errorText(e));
      setSaved([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ScrollView contentContainerStyle={styles.body} testID="qa-settings">
      <Text style={styles.hint}>
        Environments describe the servers QA tests run against and the accounts to log in with.
        Every QA run and plan-drafting session is given this list. Passwords are encrypted and are
        never shown to the QA agent.
      </Text>
      <TouchableOpacity
        testID="qa-env-add"
        style={styles.primary}
        onPress={() => {
          setDrafts((d) => [...d, { key: nextKey, draft: emptyQaEnvironment() }]);
          setNextKey((k) => k + 1);
        }}
      >
        <Text style={styles.primaryText}>+ Add environment</Text>
      </TouchableOpacity>
      <AutomatedQaSettings projectId={projectId} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {saved === null ? (
        <ActivityIndicator color={colors.gray400} />
      ) : saved.length === 0 && drafts.length === 0 ? (
        <Text style={styles.hint} testID="qa-env-empty">
          No environments yet.
        </Text>
      ) : null}
      {(saved ?? []).map((env) => (
        <EnvironmentEditor
          key={env.id}
          projectId={projectId}
          initial={draftFromQaEnvironment(env)}
          isDefault={!!env.isDefault}
          onToggleDefault={async (next) => {
            await api.setQaEnvironmentDefault(projectId, env.id, next);
            setSaved((s) =>
              (s ?? []).map((x) => ({
                ...x,
                isDefault: x.id === env.id ? next : next ? false : x.isDefault,
              })),
            );
          }}
          onSaved={() => undefined}
          onDeleted={() => setSaved((s) => (s ?? []).filter((x) => x.id !== env.id))}
        />
      ))}
      {drafts.map(({ key, draft }) => (
        <EnvironmentEditor
          key={`new-${key}`}
          projectId={projectId}
          initial={draft}
          onSaved={(env) => {
            setDrafts((all) => all.filter((x) => x.key !== key));
            setSaved((s) => [...(s ?? []), env]);
          }}
          onDeleted={() => setDrafts((all) => all.filter((x) => x.key !== key))}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 12 },
  hint: { fontSize: 12, color: colors.gray500 },
  card: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    padding: 12,
    gap: 6,
    backgroundColor: colors.gray900,
  },
  label: { fontSize: 12, color: colors.gray400, marginTop: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray950,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.gray100,
  },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  account: { borderWidth: 1, borderColor: colors.gray800, borderRadius: 6, padding: 8, gap: 6 },
  accountHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  accountTitle: { fontSize: 12, color: colors.gray300 },
  remove: { fontSize: 13, color: colors.red400 },
  secondary: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  secondaryText: { fontSize: 13, color: colors.gray300 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  primary: {
    alignSelf: 'flex-start',
    backgroundColor: colors.blue600,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  primaryText: { fontSize: 13, color: colors.white },
  disabled: { opacity: 0.5 },
  defaultRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  defaultText: { fontSize: 13, color: colors.gray300 },
  error: { fontSize: 13, color: colors.red400 },
});
