import React, { useEffect, useReducer } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { SERVER_AGENT_LIMITS } from '@shared/utils/hub';
import {
  initialServerAgentDraft,
  nextServerAgentSave,
  serverAgentDraftReducer,
} from '@shared/utils/serverAgentDraft';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import HubIcon from '../components/HubIcon';
import { ServerAgentSkillsSection } from '../components/ServerAgentSkillsSection';
import ChatScreen from './ChatScreen';
import {
  DEFAULT_SERVER_AGENT_NAME,
  saveServerAgentSettings,
  serverAgentDisplayName,
  useServerAgentAccountKey,
  useServerAgentLoadError,
  useServerAgentSettings,
} from '../utils/serverAgentInstance';

/**
 * The Server Agent: the user's assistant for everything Agent Hub, acting
 * with their own permissions. Peer of the web `ServerAgentPage`.
 */
export function ServerAgentScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { clearHubChat } = useApp();
  const settings = useServerAgentSettings();
  return (
    <View style={styles.flex} testID="server-agent-screen">
      <View style={styles.header}>
        <HubIcon name="Bot" size={16} color={colors.blue400} />
        <View style={styles.flex}>
          <Text style={styles.title} numberOfLines={1} testID="server-agent-name">
            {serverAgentDisplayName(settings)}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            Works across the projects you can access, with your permissions
          </Text>
        </View>
        <TouchableOpacity
          testID="server-agent-open-settings"
          onPress={onOpenSettings}
          accessibilityRole="button"
          accessibilityLabel="Server Agent settings"
          style={styles.iconButton}
        >
          <HubIcon name="Settings" size={18} color={colors.gray300} />
        </TouchableOpacity>
      </View>
      <ChatScreen
        embedded
        onClearChat={() => {
          void clearHubChat();
        }}
      />
    </View>
  );
}

export function ServerAgentSettingsScreen({ onBack }: { onBack: () => void }) {
  const accountKey = useServerAgentAccountKey();
  const settings = useServerAgentSettings();
  const { error: loadError, retry: retryLoad } = useServerAgentLoadError();
  const [draft, dispatch] = useReducer(serverAgentDraftReducer, initialServerAgentDraft);
  // Only the account the draft was loaded for may see or save it.
  const loaded = draft.owner !== null && draft.owner === accountKey;
  const name = loaded ? draft.name : '';
  const instructions = loaded ? draft.instructions : '';
  const saving = loaded && draft.pending !== null;
  const status = loaded ? draft.status : null;

  useEffect(() => {
    if (draft.owner !== null && draft.owner !== accountKey) dispatch({ type: 'clear' });
    else if (draft.owner === null && accountKey && settings) {
      dispatch({ type: 'load', owner: accountKey, settings });
    }
  }, [settings, accountKey, draft.owner]);

  const dirty =
    loaded && !!settings && (name !== settings.name || instructions !== settings.instructions);

  const save = async () => {
    const next = loaded ? nextServerAgentSave(draft) : null;
    if (!next) return;
    dispatch({ type: 'saveStart' });
    try {
      const saved = await saveServerAgentSettings(next.owner, {
        name: next.name,
        instructions: next.instructions,
      });
      dispatch({ type: 'saveDone', seq: next.seq, owner: next.owner, saved });
    } catch (err) {
      dispatch({
        type: 'saveFailed',
        seq: next.seq,
        owner: next.owner,
        message: err instanceof Error ? err.message : 'Could not save.',
      });
    }
  };

  return (
    <View style={styles.flex} testID="server-agent-settings">
      <View style={styles.header}>
        <TouchableOpacity
          testID="server-agent-settings-back"
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to Server Agent"
          style={styles.iconButton}
        >
          <Text style={styles.back}>{'‹ Back'}</Text>
        </TouchableOpacity>
        <Text style={[styles.title, styles.flex]} numberOfLines={1}>
          {serverAgentDisplayName(settings)} settings
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.form}>
        {!loaded && loadError ? (
          <View style={styles.loadError} testID="server-agent-settings-load-error">
            <Text style={styles.loadErrorText}>Could not load your settings: {loadError}</Text>
            <TouchableOpacity
              testID="server-agent-settings-retry"
              onPress={retryLoad}
              accessibilityRole="button"
              style={styles.retry}
            >
              <Text style={styles.retryLabel}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        <Text style={styles.label}>Name</Text>
        <TextInput
          testID="server-agent-settings-name"
          value={name}
          onChangeText={(value) => dispatch({ type: 'edit', field: 'name', value })}
          editable={loaded}
          maxLength={SERVER_AGENT_LIMITS.name}
          placeholder={settings?.defaultName || DEFAULT_SERVER_AGENT_NAME}
          placeholderTextColor={colors.gray500}
          style={styles.input}
        />
        <Text style={styles.hint}>Leave empty for the default.</Text>
        <Text style={styles.label}>Instructions</Text>
        <TextInput
          testID="server-agent-settings-instructions"
          value={instructions}
          onChangeText={(value) => dispatch({ type: 'edit', field: 'instructions', value })}
          editable={loaded}
          multiline
          maxLength={SERVER_AGENT_LIMITS.instructions}
          placeholder="e.g. Keep answers short."
          placeholderTextColor={colors.gray500}
          style={[styles.input, styles.multiline]}
        />
        <Text style={styles.hint}>
          Added to the built-in prompt on every message. The Agent Hub skills always load, and the
          agent only sees projects you can access.
        </Text>
        <TouchableOpacity
          testID="server-agent-settings-save"
          onPress={() => void save()}
          disabled={!dirty || saving}
          accessibilityRole="button"
          style={[styles.save, (!dirty || saving) && styles.saveDisabled]}
        >
          <Text style={styles.saveLabel}>{saving ? 'Saving…' : 'Save'}</Text>
        </TouchableOpacity>
        {status ? (
          <Text
            testID="server-agent-settings-status"
            style={[styles.hint, { color: status.ok ? colors.emerald400 : colors.red400 }]}
          >
            {status.text}
          </Text>
        ) : null}
        <ServerAgentSkillsSection
          accountKey={accountKey}
          settings={loaded ? settings : null}
          enabled={loaded}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  title: { color: colors.white, fontSize: 15, fontWeight: '600' },
  subtitle: { color: colors.gray500, fontSize: 11 },
  iconButton: { padding: 6 },
  back: { color: colors.blue400, fontSize: 14, fontWeight: '600' },
  form: { padding: 16, gap: 6 },
  label: { color: colors.gray200, fontSize: 14, fontWeight: '600', marginTop: 10 },
  hint: { color: colors.gray500, fontSize: 12 },
  input: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    color: colors.white,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  multiline: { minHeight: 180, textAlignVertical: 'top' },
  save: {
    marginTop: 16,
    alignSelf: 'flex-start',
    backgroundColor: colors.blue600,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  saveDisabled: { opacity: 0.5 },
  loadError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.red600,
    borderRadius: 8,
    backgroundColor: colors.red900_50,
    padding: 10,
  },
  loadErrorText: { flex: 1, color: colors.red400, fontSize: 13 },
  retry: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.red600,
  },
  retryLabel: { color: colors.white, fontWeight: '600', fontSize: 13 },
  saveLabel: { color: colors.white, fontWeight: '600' },
});
