import React, { useEffect, useMemo, useState, useCallback } from 'react';
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
  groupAgentsByProject,
  validateNewAgentForm,
  buildCreateAgentPayload,
  buildUpdateAgentPayload,
  settingsEngineChoices,
  settingsModelsForEngine,
  settingsDefaultModelForEngine,
  PER_USER_DEFAULT_MODEL,
  settingsSelectedModelChip,
  settingsResolveModelChip,
  settingsEffectiveEngine,
  settingsModelOverrideIsStale,
} from '../../utils/settingsAgents';

const EMPTY_NEW_FORM = { id: '', name: '', projectId: '', engine: 'claude-code', model: '', systemPrompt: '' };

function ChipRow({ options, selected, onSelect, labelFor = (o) => o }) {
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => {
        const active = selected === opt;
        return (
          <TouchableOpacity
            key={String(opt)}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => onSelect(opt)}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
              {labelFor(opt)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function SharedEnginePicker({ modelConfig, engine, onEngine, label = 'Engine (shared)' }) {
  const engines = settingsEngineChoices(modelConfig);
  if (engines.length === 0) return null;
  return (
    <>
      <Text style={styles.fieldLabel}>{label}</Text>
      <ChipRow options={engines} selected={engine} onSelect={onEngine} />
    </>
  );
}

const SHARED_ENGINE_PICK = '__shared__';

function PerUserEngineModelPickers({
  modelConfig,
  sharedEngine,
  engineOverride,
  modelOverride,
  onEngineOverride,
  onModelOverride,
  overrideSaving,
}) {
  const effectiveEngine = settingsEffectiveEngine(engineOverride, sharedEngine);
  const engines = settingsEngineChoices(modelConfig);
  const models = settingsModelsForEngine(modelConfig, effectiveEngine);
  const defaultModel = settingsDefaultModelForEngine(modelConfig, effectiveEngine);
  const selectedModelChip = settingsSelectedModelChip(modelOverride, models);

  return (
    <View style={styles.onlyForMeBox}>
      <Text style={styles.onlyForMeTitle}>Only for me</Text>
      {engines.length > 0 && (
        <>
          <Text style={styles.fieldLabel}>Engine (only for me)</Text>
          <ChipRow
            options={[SHARED_ENGINE_PICK, ...engines]}
            selected={engineOverride ? engineOverride : SHARED_ENGINE_PICK}
            onSelect={(eng) =>
              onEngineOverride(eng === SHARED_ENGINE_PICK ? '' : eng)
            }
            labelFor={(eng) =>
              eng === SHARED_ENGINE_PICK ? `Shared (${sharedEngine || 'claude-code'})` : eng
            }
          />
        </>
      )}
      {models.length > 0 && (
        <>
          <Text style={styles.fieldLabel}>
            Model (only for me)
            {overrideSaving ? ' · saving…' : ''}
          </Text>
          <ChipRow
            options={[PER_USER_DEFAULT_MODEL, ...models]}
            selected={selectedModelChip}
            onSelect={(chip) => onModelOverride(settingsResolveModelChip(chip))}
            labelFor={(m) =>
              m === PER_USER_DEFAULT_MODEL
                ? `Default (${defaultModel || 'shared'})`
                : m.replace(/^claude-/, '').replace(/^gpt-/, '')
            }
          />
        </>
      )}
      <Text style={styles.onlyForMeHint}>Only changes engine/model for your sessions.</Text>
    </View>
  );
}

function BulkEngineModelPickers({ modelConfig, engine, model, onEngine, onModel }) {
  const engines = settingsEngineChoices(modelConfig);
  const models = settingsModelsForEngine(modelConfig, engine);
  const defaultModel = settingsDefaultModelForEngine(modelConfig, engine);
  return (
    <>
      {engines.length > 0 && (
        <>
          <Text style={styles.fieldLabel}>Engine (all agents, only for me)</Text>
          <ChipRow options={engines} selected={engine} onSelect={onEngine} />
        </>
      )}
      {models.length > 0 && (
        <>
          <Text style={styles.fieldLabel}>
            Model (only for me){defaultModel ? ` — default: ${defaultModel}` : ''}
          </Text>
          <ChipRow
            options={models}
            selected={model || defaultModel}
            onSelect={onModel}
            labelFor={(m) => m.replace(/^claude-/, '').replace(/^gpt-/, '')}
          />
        </>
      )}
    </>
  );
}

export default function AgentsSection() {
  const [agents, setAgents] = useState([]);
  const [projects, setProjects] = useState([]);
  const [modelConfig, setModelConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState(EMPTY_NEW_FORM);
  const [bulkEngine, setBulkEngine] = useState('claude-code');
  const [bulkModel, setBulkModel] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  const [modelOverrides, setModelOverrides] = useState({});
  const [engineOverrides, setEngineOverrides] = useState({});
  const [overrideSaving, setOverrideSaving] = useState({});

  const loadOverrides = useCallback(async () => {
    try {
      const [modelBody, engineBody] = await Promise.all([
        api.getMyAgentModelOverrides(),
        api.getMyAgentEngineOverrides(),
      ]);
      setModelOverrides(
        modelBody?.agentModelOverrides && typeof modelBody.agentModelOverrides === 'object'
          ? modelBody.agentModelOverrides
          : {},
      );
      const raw =
        engineBody?.agentEngineOverrides && typeof engineBody.agentEngineOverrides === 'object'
          ? engineBody.agentEngineOverrides
          : {};
      const flat = {};
      for (const [id, entry] of Object.entries(raw)) {
        if (entry && typeof entry.engine === 'string') flat[id] = entry.engine;
      }
      setEngineOverrides(flat);
    } catch {
      /* non-fatal */
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [agentList, projectList] = await Promise.all([api.getAgents(), api.getProjects()]);
      setAgents(Array.isArray(agentList) ? agentList : []);
      setProjects(Array.isArray(projectList) ? projectList : []);
    } catch (err) {
      setLoadError(err?.message || 'Failed to load agents.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    api.getModelConfig().then(setModelConfig).catch(() => {});
    loadOverrides();
  }, [load, loadOverrides]);

  const groups = useMemo(() => groupAgentsByProject(agents, projects), [agents, projects]);

  const handleExpand = (agent) => {
    if (expanded === agent.id) {
      setExpanded(null);
      return;
    }
    setExpanded(agent.id);
    setEditForm({
      name: agent.name || '',
      engine: agent.engine || 'claude-code',
      systemPrompt: agent.systemPrompt || '',
    });
  };

  const saveModelOverride = async (agentId, model) => {
    setModelOverrides((prev) => {
      const next = { ...prev };
      if (model) next[agentId] = model;
      else delete next[agentId];
      return next;
    });
    setOverrideSaving((prev) => ({ ...prev, [agentId]: true }));
    try {
      const body = model
        ? await api.putMyAgentModelOverride(agentId, { model })
        : await api.deleteMyAgentModelOverride(agentId);
      if (body?.agentModelOverrides && typeof body.agentModelOverrides === 'object') {
        setModelOverrides(body.agentModelOverrides);
      }
    } catch (err) {
      await loadOverrides();
      Alert.alert('Save failed', err?.message || 'Could not save model.');
    } finally {
      setOverrideSaving((prev) => ({ ...prev, [agentId]: false }));
    }
  };

  const saveEngineOverride = async (agentId, engine, sharedEngine = 'claude-code') => {
    // Switching the per-user engine can strand a model override from the old
    // engine: the chip UI falls back to "Default", but the stored override
    // would stay persisted — ready to send an incompatible engine/model pair
    // to the runtime, or to reappear if the user switches back. Decide up
    // front (against the current render's override) whether it needs clearing.
    const effectiveEngine = settingsEffectiveEngine(engine, sharedEngine);
    const mustClearModel = settingsModelOverrideIsStale(
      modelOverrides[agentId] || '',
      effectiveEngine,
      modelConfig,
    );

    setEngineOverrides((prev) => {
      const next = { ...prev };
      if (engine) next[agentId] = engine;
      else delete next[agentId];
      return next;
    });
    setOverrideSaving((prev) => ({ ...prev, [agentId]: true }));
    try {
      const body = engine
        ? await api.putMyAgentEngineOverride(agentId, { engine })
        : await api.deleteMyAgentEngineOverride(agentId);
      const raw =
        body?.agentEngineOverrides && typeof body.agentEngineOverrides === 'object'
          ? body.agentEngineOverrides
          : {};
      const flat = {};
      for (const [id, entry] of Object.entries(raw)) {
        if (entry && typeof entry.engine === 'string') flat[id] = entry.engine;
      }
      setEngineOverrides(flat);
      // Reconcile the now-incompatible model override only after the engine
      // change persisted. saveModelOverride('') owns its own state + error
      // handling, so a clear failure surfaces without rolling back the engine.
      if (mustClearModel) {
        await saveModelOverride(agentId, '');
      }
    } catch (err) {
      await loadOverrides();
      Alert.alert('Save failed', err?.message || 'Could not save engine.');
    } finally {
      setOverrideSaving((prev) => ({ ...prev, [agentId]: false }));
    }
  };

  const handleSave = async (agent) => {
    const payload = buildUpdateAgentPayload(agent, editForm);
    if (Object.keys(payload).length === 0) {
      setExpanded(null);
      return;
    }
    setSaving(true);
    try {
      await api.updateAgent(agent.id, payload);
      // Reconcile a per-user model override the new shared engine made stale.
      // Only relevant when no per-user engine override shadows the shared one
      // (otherwise the effective engine, and the valid models, are unchanged).
      if (payload.engine !== undefined) {
        const effEngine = settingsEffectiveEngine(engineOverrides[agent.id] || '', payload.engine);
        if (settingsModelOverrideIsStale(modelOverrides[agent.id] || '', effEngine, modelConfig)) {
          await saveModelOverride(agent.id, '');
        }
      }
      setExpanded(null);
      await load();
    } catch (err) {
      Alert.alert('Save failed', err?.message || 'Could not update agent.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (agent) => {
    Alert.alert('Delete Agent', `Delete "${agent.name || agent.id}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteAgent(agent.id);
            setExpanded(null);
            await load();
          } catch (err) {
            Alert.alert('Delete failed', err?.message || 'Could not delete agent.');
          }
        },
      },
    ]);
  };

  const handleCreate = async () => {
    const error = validateNewAgentForm(newForm);
    if (error) {
      Alert.alert('Invalid agent', error);
      return;
    }
    setCreating(true);
    try {
      await api.createAgent(buildCreateAgentPayload(newForm));
      setShowNew(false);
      setNewForm(EMPTY_NEW_FORM);
      await load();
    } catch (err) {
      Alert.alert('Create failed', err?.message || 'Could not create agent.');
    } finally {
      setCreating(false);
    }
  };

  const handleBulkApplyAll = () => {
    if (!modelConfig || agents.length === 0) return;
    const effectiveModel = bulkModel || settingsDefaultModelForEngine(modelConfig, bulkEngine);
    Alert.alert(
      'Switch all agents',
      `Set your personal defaults for every agent to ${bulkEngine} / ${effectiveModel}? This only affects your sessions.`,
      [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Apply',
        onPress: async () => {
          setBulkSaving(true);
          try {
            await api.bulkSetAllAgentsEngine({ engine: bulkEngine, model: effectiveModel });
            await loadOverrides();
          } catch (err) {
            Alert.alert('Bulk update failed', err?.message || 'Could not switch agents.');
          } finally {
            setBulkSaving(false);
          }
        },
      },
    ],
    );
  };

  if (loading) {
    return <ActivityIndicator size="small" color={colors.gray500} style={{ marginVertical: 40 }} />;
  }

  return (
    <View>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Agents</Text>
        <TouchableOpacity style={styles.headerButton} onPress={() => setShowNew((v) => !v)}>
          <Text style={styles.headerButtonText}>{showNew ? 'Cancel' : '+ New Agent'}</Text>
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

      {agents.length > 0 && modelConfig && (
        <View style={styles.formCard}>
          <Text style={styles.formTitle}>Switch all agents</Text>
          <Text style={styles.formHint}>
            Bulk engine + model for your sessions only (for example when a subscription ends).
          </Text>
          <BulkEngineModelPickers
            modelConfig={modelConfig}
            engine={bulkEngine}
            model={bulkModel}
            onEngine={(engine) => {
              setBulkEngine(engine);
              setBulkModel('');
            }}
            onModel={setBulkModel}
          />
          <TouchableOpacity
            style={[styles.primaryBtn, bulkSaving && { opacity: 0.5 }]}
            onPress={handleBulkApplyAll}
            disabled={bulkSaving}
          >
            <Text style={styles.primaryBtnText}>{bulkSaving ? 'Applying…' : 'Apply to all'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {showNew && (
        <View style={styles.formCard}>
          <Text style={styles.fieldLabel}>Agent ID</Text>
          <TextInput
            value={newForm.id}
            onChangeText={(v) => setNewForm({ ...newForm, id: v })}
            placeholder="e.g. my-project-helper"
            placeholderTextColor={colors.gray500}
            style={styles.formInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.fieldLabel}>Name (optional — defaults to ID)</Text>
          <TextInput
            value={newForm.name}
            onChangeText={(v) => setNewForm({ ...newForm, name: v })}
            placeholder="Display name"
            placeholderTextColor={colors.gray500}
            style={styles.formInput}
          />
          <Text style={styles.fieldLabel}>Project</Text>
          <ChipRow
            options={projects.map((p) => p.id)}
            selected={newForm.projectId}
            onSelect={(projectId) => setNewForm({ ...newForm, projectId })}
            labelFor={(id) => projects.find((p) => p.id === id)?.name || id}
          />
          <SharedEnginePicker
            modelConfig={modelConfig}
            engine={newForm.engine}
            onEngine={(engine) => setNewForm({ ...newForm, engine })}
            label="Engine (shared default)"
          />
          <Text style={styles.fieldLabel}>System prompt (optional)</Text>
          <TextInput
            value={newForm.systemPrompt}
            onChangeText={(v) => setNewForm({ ...newForm, systemPrompt: v })}
            placeholder="System prompt"
            placeholderTextColor={colors.gray500}
            style={[styles.formInput, { minHeight: 80 }]}
            multiline
            textAlignVertical="top"
          />
          <TouchableOpacity
            style={[styles.primaryBtn, creating && { opacity: 0.5 }]}
            onPress={handleCreate}
            disabled={creating}
          >
            <Text style={styles.primaryBtnText}>{creating ? 'Creating…' : 'Create Agent'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {groups.map((group) => (
        <View key={group.projectId || 'other'} style={styles.projectGroup}>
          <View style={styles.projectHeader}>
            <View style={[styles.projectDot, { backgroundColor: group.color || colors.gray600 }]} />
            <Text style={styles.projectName}>{group.projectName}</Text>
            <Text style={styles.projectCount}>
              {group.agents.length} agent{group.agents.length === 1 ? '' : 's'}
            </Text>
          </View>
          {group.agents.length === 0 ? (
            <Text style={styles.emptyText}>No agents in this project</Text>
          ) : (
            group.agents.map((agent) => {
              const isExpanded = expanded === agent.id;
              const myModel = modelOverrides[agent.id];
              const myEngine = engineOverrides[agent.id];
              const displayEngine = myEngine || agent.engine || 'claude-code';
              return (
                <View key={agent.id} style={styles.card}>
                  <TouchableOpacity style={styles.cardRow} onPress={() => handleExpand(agent)}>
                    <View style={[styles.dot, { backgroundColor: agent.color || colors.gray500 }]} />
                    <View style={styles.cardInfo}>
                      <View style={styles.row}>
                        <Text style={styles.cardName}>{agent.name || agent.id}</Text>
                        <Text style={styles.mono}>{agent.id}</Text>
                      </View>
                      <Text style={styles.cardMeta}>
                        {displayEngine}
                        {myModel ? ` · ${myModel}` : ''}
                      </Text>
                    </View>
                    <Text style={styles.expandIcon}>{isExpanded ? '▲' : '▼'}</Text>
                  </TouchableOpacity>

                  {isExpanded && (
                    <View style={styles.expandedSection}>
                      <Text style={styles.fieldLabel}>Name</Text>
                      <TextInput
                        value={editForm.name}
                        onChangeText={(v) => setEditForm({ ...editForm, name: v })}
                        style={styles.formInput}
                        placeholderTextColor={colors.gray500}
                      />
                      <SharedEnginePicker
                        modelConfig={modelConfig}
                        engine={editForm.engine}
                        onEngine={(engine) => setEditForm({ ...editForm, engine })}
                      />
                      <PerUserEngineModelPickers
                        modelConfig={modelConfig}
                        sharedEngine={editForm.engine || agent.engine || 'claude-code'}
                        engineOverride={engineOverrides[agent.id] || ''}
                        modelOverride={modelOverrides[agent.id] || ''}
                        onEngineOverride={(engine) =>
                          saveEngineOverride(
                            agent.id,
                            engine,
                            editForm.engine || agent.engine || 'claude-code',
                          )
                        }
                        onModelOverride={(model) => saveModelOverride(agent.id, model)}
                        overrideSaving={!!overrideSaving[agent.id]}
                      />
                      <Text style={styles.fieldLabel}>System prompt</Text>
                      <TextInput
                        value={editForm.systemPrompt}
                        onChangeText={(v) => setEditForm({ ...editForm, systemPrompt: v })}
                        style={[styles.formInput, { minHeight: 80 }]}
                        multiline
                        textAlignVertical="top"
                        placeholderTextColor={colors.gray500}
                      />
                      <View style={styles.actionRow}>
                        <TouchableOpacity style={styles.dangerBtn} onPress={() => handleDelete(agent)}>
                          <Text style={styles.dangerBtnText}>Delete</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.primaryBtn, saving && { opacity: 0.5 }]}
                          onPress={() => handleSave(agent)}
                          disabled={saving}
                        >
                          <Text style={styles.primaryBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                </View>
              );
            })
          )}
        </View>
      ))}

      {!loadError && groups.length === 0 && (
        <Text style={styles.emptyText}>No projects configured yet.</Text>
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
  projectGroup: {
    marginBottom: 18,
  },
  projectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  projectDot: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  projectName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray200,
    flex: 1,
  },
  projectCount: {
    fontSize: 11,
    color: colors.gray500,
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
  },
  expandIcon: {
    fontSize: 12,
    color: colors.gray400,
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
  formTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray200,
  },
  formHint: {
    fontSize: 11,
    color: colors.gray500,
    marginTop: 2,
  },
  onlyForMeBox: {
    marginTop: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.35)',
    backgroundColor: 'rgba(49, 46, 129, 0.2)',
  },
  onlyForMeTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.indigo400,
    marginBottom: 4,
  },
  onlyForMeHint: {
    fontSize: 10,
    color: colors.gray500,
    marginTop: 6,
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
    marginBottom: 8,
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
