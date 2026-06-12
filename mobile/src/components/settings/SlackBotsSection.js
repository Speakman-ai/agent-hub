import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';
import {
  validateSlackBotForm,
  buildSlackBotPayload,
  describeSlackTestResult,
} from '../../utils/settingsSlackBots';

const EMPTY_FORM = { name: '', agent_id: '', bot_token: '', app_token: '' };

function BotForm({ form, setForm, agents, isNew }) {
  return (
    <>
      <Text style={styles.fieldLabel}>Name</Text>
      <TextInput
        value={form.name}
        onChangeText={(v) => setForm({ ...form, name: v })}
        placeholder="e.g. Support Bot"
        placeholderTextColor={colors.gray500}
        style={styles.formInput}
      />
      <Text style={styles.fieldLabel}>Agent</Text>
      <View style={styles.chipRow}>
        {agents.map((a) => {
          const active = form.agent_id === a.id;
          return (
            <TouchableOpacity
              key={a.id}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setForm({ ...form, agent_id: a.id })}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                {a.name || a.id}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.fieldLabel}>
        Bot token (xoxb-…){isNew ? '' : ' — leave blank to keep current'}
      </Text>
      <TextInput
        value={form.bot_token}
        onChangeText={(v) => setForm({ ...form, bot_token: v })}
        placeholder="xoxb-..."
        placeholderTextColor={colors.gray500}
        style={styles.formInput}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <Text style={styles.fieldLabel}>
        App token (xapp-…){isNew ? '' : ' — leave blank to keep current'}
      </Text>
      <TextInput
        value={form.app_token}
        onChangeText={(v) => setForm({ ...form, app_token: v })}
        placeholder="xapp-..."
        placeholderTextColor={colors.gray500}
        style={styles.formInput}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
    </>
  );
}

export default function SlackBotsSection() {
  const [bots, setBots] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState({});

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [botList, agentList] = await Promise.all([api.getSlackBots(), api.getAgents()]);
      setBots(Array.isArray(botList) ? botList : []);
      setAgents(Array.isArray(agentList) ? agentList : []);
    } catch (err) {
      setLoadError(err?.message || 'Failed to load Slack bots.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    const error = validateSlackBotForm(newForm, { isNew: true });
    if (error) {
      Alert.alert('Invalid bot', error);
      return;
    }
    setBusy(true);
    try {
      await api.createSlackBot(buildSlackBotPayload(newForm, { isNew: true }));
      setShowNew(false);
      setNewForm(EMPTY_FORM);
      await load();
    } catch (err) {
      Alert.alert('Create failed', err?.message || 'Could not create bot.');
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async (bot) => {
    const error = validateSlackBotForm(editForm);
    if (error) {
      Alert.alert('Invalid bot', error);
      return;
    }
    setBusy(true);
    try {
      await api.updateSlackBot(bot.id, buildSlackBotPayload(editForm));
      setExpanded(null);
      await load();
    } catch (err) {
      Alert.alert('Save failed', err?.message || 'Could not update bot.');
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (bot) => {
    try {
      const result = await api.toggleSlackBot(bot.id);
      setBots((prev) =>
        prev.map((b) => (b.id === bot.id ? { ...b, enabled: result.enabled ? 1 : 0 } : b)),
      );
    } catch (err) {
      Alert.alert('Toggle failed', err?.message || 'Could not toggle bot.');
    }
  };

  const handleTest = async (bot) => {
    setTesting((prev) => ({ ...prev, [bot.id]: true }));
    try {
      const result = await api.testSlackBot(bot.id);
      Alert.alert('Connection OK', describeSlackTestResult(result));
    } catch (err) {
      Alert.alert('Connection failed', err?.message || 'auth.test failed');
    } finally {
      setTesting((prev) => ({ ...prev, [bot.id]: false }));
    }
  };

  const handleDelete = (bot) => {
    Alert.alert('Delete Slack Bot', `Delete "${bot.name}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteSlackBot(bot.id);
            setExpanded(null);
            await load();
          } catch (err) {
            Alert.alert('Delete failed', err?.message || 'Could not delete bot.');
          }
        },
      },
    ]);
  };

  if (loading) {
    return <ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 40 }} />;
  }

  return (
    <View style={{ marginBottom: 24 }}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Managed Bots</Text>
        <TouchableOpacity style={styles.headerButton} onPress={() => setShowNew((v) => !v)}>
          <Text style={styles.headerButtonText}>{showNew ? 'Cancel' : '+ New Bot'}</Text>
        </TouchableOpacity>
      </View>

      {loadError && (
        <View style={styles.errorBox}>
          <Text style={styles.errorBoxText}>{loadError}</Text>
          <TouchableOpacity onPress={load}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {showNew && (
        <View style={styles.formCard}>
          <BotForm form={newForm} setForm={setNewForm} agents={agents} isNew />
          <TouchableOpacity
            style={[styles.primaryBtn, busy && { opacity: 0.5 }]}
            onPress={handleCreate}
            disabled={busy}
          >
            <Text style={styles.primaryBtnText}>{busy ? 'Creating…' : 'Create Bot'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {bots.length === 0 && !loadError ? (
        <Text style={styles.emptyText}>No managed Slack bots yet.</Text>
      ) : (
        bots.map((bot) => {
          const isExpanded = expanded === bot.id;
          return (
            <View key={bot.id} style={styles.card}>
              <TouchableOpacity
                style={styles.cardRow}
                onPress={() => {
                  if (isExpanded) {
                    setExpanded(null);
                    return;
                  }
                  setExpanded(bot.id);
                  // Token fields start blank on edit — blank means "keep
                  // the stored token" (server ignores masked/absent values).
                  setEditForm({
                    name: bot.name || '',
                    agent_id: bot.agent_id || '',
                    bot_token: '',
                    app_token: '',
                  });
                }}
              >
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: bot.enabled ? colors.emerald400 : colors.gray600 },
                  ]}
                />
                <View style={styles.cardInfo}>
                  <View style={styles.row}>
                    <Text style={styles.cardName}>{bot.name}</Text>
                    <Text style={styles.mono}>→ {bot.agent_id}</Text>
                  </View>
                  <Text style={styles.cardMeta}>
                    {bot.bot_token} · {bot.enabled ? 'enabled' : 'disabled'}
                  </Text>
                </View>
                <View style={styles.actionButtons}>
                  <TouchableOpacity
                    style={styles.smallButton}
                    onPress={() => handleTest(bot)}
                    disabled={!!testing[bot.id]}
                  >
                    <Text style={styles.smallButtonText}>{testing[bot.id] ? '…' : 'Test'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.smallButton, bot.enabled ? styles.buttonOn : null]}
                    onPress={() => handleToggle(bot)}
                  >
                    <Text
                      style={[styles.smallButtonText, bot.enabled ? styles.buttonOnText : null]}
                    >
                      {bot.enabled ? 'ON' : 'OFF'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>

              {isExpanded && (
                <View style={styles.expandedSection}>
                  <BotForm form={editForm} setForm={setEditForm} agents={agents} isNew={false} />
                  <View style={styles.actionRow}>
                    <TouchableOpacity style={styles.dangerBtn} onPress={() => handleDelete(bot)}>
                      <Text style={styles.dangerBtnText}>Delete</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.primaryBtn, busy && { opacity: 0.5 }]}
                      onPress={() => handleSave(bot)}
                      disabled={busy}
                    >
                      <Text style={styles.primaryBtnText}>{busy ? 'Saving…' : 'Save'}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 12,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerButton: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  headerButtonText: {
    fontSize: 12,
    color: colors.gray300,
  },
  card: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 8,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  cardInfo: {
    flex: 1,
    minWidth: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  cardName: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.white,
  },
  mono: {
    fontSize: 11,
    color: colors.gray500,
    fontFamily: 'monospace',
  },
  cardMeta: {
    fontSize: 11,
    color: colors.gray600,
    marginTop: 2,
    fontFamily: 'monospace',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 4,
  },
  smallButton: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    minWidth: 36,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButtonText: {
    fontSize: 12,
    color: colors.gray400,
  },
  buttonOn: {
    backgroundColor: colors.emerald800_50,
  },
  buttonOnText: {
    color: colors.emerald400,
  },
  expandedSection: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    padding: 14,
  },
  fieldLabel: {
    fontSize: 12,
    color: colors.gray400,
    marginBottom: 4,
    marginTop: 10,
  },
  formInput: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.gray100,
    fontSize: 14,
  },
  formCard: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: {
    backgroundColor: 'rgba(37, 99, 235, 0.15)',
    borderColor: colors.blue600,
  },
  chipText: {
    fontSize: 12,
    color: colors.gray400,
  },
  chipTextActive: {
    color: colors.blue400,
    fontWeight: '500',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 14,
  },
  primaryBtn: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  primaryBtnText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '500',
  },
  dangerBtn: {
    backgroundColor: colors.red900_50,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  dangerBtnText: {
    color: colors.red400,
    fontSize: 13,
    fontWeight: '500',
  },
  emptyText: {
    fontSize: 12,
    color: colors.gray600,
    fontStyle: 'italic',
  },
  errorBox: {
    backgroundColor: colors.red900_50,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  errorBoxText: {
    color: colors.red400,
    fontSize: 12,
  },
  retryText: {
    color: colors.gray300,
    fontSize: 12,
    marginTop: 6,
    textDecorationLine: 'underline',
  },
});
