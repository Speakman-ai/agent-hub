import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  StyleSheet,
  Alert,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { filterAgentsForPicker, groupAgentsByProject } from '../utils/sessionAgentPicker';
/** Minimal multi-agent roster panel for mobile chat. Advisors may come from any project. */
export default function SessionAgentsPanel({
  sessionId,
  sessionAgents = [],
  maxTurns = 10,
  agents = [],
  modelConfig,
  onUpdated,
}: any) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [addModels, setAddModels] = useState<Record<string, string>>({});
  const executor = sessionAgents.find((a: any) => a.role === 'executor');
  const advisors = sessionAgents.filter((a: any) => a.role === 'advisor');
  const executorProjectId = executor?.projectId;
  const availableGroups = useMemo<any>(() => {
    const filtered = filterAgentsForPicker(agents, { query: addSearch });
    return groupAgentsByProject(filtered);
  }, [agents, addSearch]);
  const modelsForAgent = (agent: any): string[] =>
    modelConfig?.engineValidModels?.[agent.engine || 'claude-code'] || [];
  if (!sessionId) return null;
  const refresh = async () => {
    const detail = await api.getSessionDetail(sessionId);
    onUpdated?.(detail);
  };
  const addAgent = async (agentId: any) => {
    if (busy) return;
    const agent = agents.find((a: any) => a.id === agentId);
    const execProjectId = executor?.projectId;
    const isCrossProject =
      agent && execProjectId && agent.projectId && agent.projectId !== execProjectId;
    const doAdd = async () => {
      setBusy(true);
      try {
        await api.addSessionAgent(sessionId, agentId, addModels[agentId] || null);
        await refresh();
      } catch (err: any) {
        console.warn('addSessionAgent failed', err);
      } finally {
        setBusy(false);
      }
    };
    if (isCrossProject) {
      Alert.alert(
        'Cross-project advisor',
        `Adding "${agent.name}" from ${agent.projectName || agent.projectId} grants their CLI read access to this session's project workspace and secrets.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Add', onPress: () => void doAdd() },
        ],
      );
      return;
    }
    await doAdd();
  };
  const removeAgent = async (participantId: any) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.removeSessionAgent(sessionId, participantId);
      await refresh();
    } catch (err: any) {
      console.warn('removeSessionAgent failed', err);
    } finally {
      setBusy(false);
    }
  };
  const setAgentModel = async (participantId: string, model: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setSessionAgentModel(sessionId, participantId, model);
      await refresh();
    } catch (err: any) {
      console.warn('setSessionAgentModel failed', err);
    } finally {
      setBusy(false);
    }
  };
  const setMaxTurns = async (value: any) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.updateSession(sessionId, { max_turns: value });
      await refresh();
    } catch (err: any) {
      console.warn('updateSession failed', err);
    } finally {
      setBusy(false);
    }
  };
  const label =
    sessionAgents.length <= 1
      ? 'Single agent'
      : `${sessionAgents.length} agents (${advisors.length} advisor${advisors.length !== 1 ? 's' : ''})`;
  const showProjectFor = (a: any) =>
    executorProjectId && a.projectId && a.projectId !== executorProjectId;
  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={styles.header}
        accessibilityRole="button"
        accessibilityLabel="Toggle session agents"
        onPress={() => setOpen((v: any) => !v)}
      >
        <Text style={styles.headerText}>{label}</Text>
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
      </TouchableOpacity>
      {open && (
        <View style={styles.body}>
          <Text style={styles.section}>Executor</Text>
          {executor ? (
            <Text style={styles.chip}>
              {executor.name}
              {executor.projectName ? ` · ${executor.projectName}` : ''}
            </Text>
          ) : (
            <Text style={styles.muted}>No executor</Text>
          )}
          <Text style={[styles.section, { marginTop: 10 }]}>Advisors (read-only)</Text>
          {advisors.map((a: any) => (
            <View key={a.participantId} style={styles.participant}>
              <View style={styles.row}>
                <Text style={styles.chip} numberOfLines={1}>
                  {a.name}
                  {showProjectFor(a) && a.projectName ? ` · ${a.projectName}` : ''}
                </Text>
                <TouchableOpacity onPress={() => removeAgent(a.participantId)} disabled={busy}>
                  <Text style={styles.remove}>Remove</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.modelRow}>
                {[null, ...modelsForAgent(a)].map((model: string | null) => {
                  const selected = (a.model || null) === model;
                  return (
                    <TouchableOpacity
                      key={model || 'default'}
                      accessibilityRole="button"
                      accessibilityLabel={`Use ${model || 'agent default'} for ${a.name}`}
                      onPress={() => setAgentModel(a.participantId, model)}
                      disabled={busy}
                      style={[styles.modelBtn, selected && styles.modelBtnActive]}
                    >
                      <Text style={selected ? styles.modelTextActive : styles.modelText}>
                        {model || 'Default'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ))}
          {advisors.length === 0 && (
            <Text style={styles.muted}>No advisors — add from any project below</Text>
          )}
          {agents.length > 0 && (
            <>
              <TextInput
                style={styles.search}
                value={addSearch}
                onChangeText={setAddSearch}
                placeholder="Search agents or projects…"
                placeholderTextColor={colors.gray600}
              />
              <ScrollView style={styles.addScroll} nestedScrollEnabled>
                {availableGroups.map((group: any) => (
                  <View key={group.projectId} style={styles.group}>
                    <Text style={styles.groupTitle}>{group.projectName}</Text>
                    <View style={styles.addRow}>
                      {group.agents.map((a: any) => (
                        <View key={a.id} style={styles.addCard}>
                          <View style={styles.modelRow}>
                            {[null, ...modelsForAgent(a)].map((model: string | null) => {
                              const selected = (addModels[a.id] || null) === model;
                              return (
                                <TouchableOpacity
                                  key={model || 'default'}
                                  accessibilityRole="button"
                                  accessibilityLabel={`Use ${model || 'agent default'} for new ${a.name}`}
                                  onPress={() =>
                                    setAddModels((current) => ({
                                      ...current,
                                      [a.id]: model || '',
                                    }))
                                  }
                                  disabled={busy}
                                  style={[styles.modelBtn, selected && styles.modelBtnActive]}
                                >
                                  <Text
                                    style={selected ? styles.modelTextActive : styles.modelText}
                                  >
                                    {model || 'Default'}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                          <TouchableOpacity
                            style={styles.addBtn}
                            accessibilityRole="button"
                            accessibilityLabel={`Add ${a.name}`}
                            onPress={() => addAgent(a.id)}
                            disabled={busy}
                          >
                            <Text style={styles.addText}>Add {a.name}</Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  </View>
                ))}
              </ScrollView>
            </>
          )}
          {advisors.length > 0 && (
            <>
              <Text style={[styles.section, { marginTop: 10 }]}>Max replies</Text>
              <View style={styles.turnRow}>
                {[10, 25, 50, 0].map((v: any) => (
                  <TouchableOpacity
                    key={v}
                    style={[styles.turnBtn, (maxTurns ?? 10) === v && styles.turnBtnActive]}
                    onPress={() => setMaxTurns(v)}
                    disabled={busy}
                  >
                    <Text style={(maxTurns ?? 10) === v ? styles.turnTextActive : styles.turnText}>
                      {v === 0 ? '∞' : v}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  wrap: { borderBottomWidth: 1, borderBottomColor: colors.gray800 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  headerText: { color: colors.gray400, fontSize: 12, fontWeight: '600' },
  chevron: { color: colors.gray600, fontSize: 12 },
  body: { paddingHorizontal: 16, paddingBottom: 12 },
  section: {
    color: colors.gray500,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  chip: { color: colors.gray200, fontSize: 13, flex: 1 },
  muted: { color: colors.gray600, fontSize: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  participant: { marginBottom: 8 },
  remove: { color: colors.red400, fontSize: 12 },
  search: {
    marginTop: 8,
    backgroundColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.gray200,
    fontSize: 13,
  },
  addScroll: { maxHeight: 160, marginTop: 8 },
  group: { marginBottom: 10 },
  groupTitle: {
    color: colors.gray500,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  addRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  addCard: {
    width: '100%',
    gap: 6,
    padding: 8,
    borderRadius: 8,
    backgroundColor: colors.gray800,
  },
  addBtn: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  addText: { color: colors.gray300, fontSize: 12 },
  modelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4 },
  modelBtn: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  modelBtnActive: { borderColor: colors.blue500, backgroundColor: colors.blue900_40 },
  modelText: { color: colors.gray500, fontSize: 10 },
  modelTextActive: { color: colors.blue300, fontSize: 10 },
  turnRow: { flexDirection: 'row', gap: 8 },
  turnBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.gray800,
  },
  turnBtnActive: { backgroundColor: colors.blue600 },
  turnText: { color: colors.gray400, fontSize: 12 },
  turnTextActive: { color: colors.white, fontSize: 12 },
});
