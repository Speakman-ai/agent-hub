import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import {
  phaseFormToUpdateBody,
  autonomousModelOptions,
  defaultAutonomousModel,
  epicStateLabel,
} from '../utils/epics';
import {
  columnNameById,
  isColumnDone,
  ticketsForEpic,
  phasesForEpic,
  ticketsForPhase,
  countDoneTickets,
  phaseProgress,
  phaseComplete,
  epicAutonomousSummary,
  specProgress,
  specStatusLabel,
} from '../utils/epicScopeStats';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import LinkedTodosPanel from '../components/LinkedTodosPanel';

function phaseFormFromRow(phase: any) {
  return {
    autonomous: phase?.autonomous ? 1 : 0,
    autonomous_interval: phase?.autonomous_interval || 5,
    autonomous_max_concurrent: phase?.autonomous_max_concurrent || 1,
    autonomous_model: phase?.autonomous_model || '',
    autonomous_send_it: phase?.autonomous_send_it === 0 ? 0 : 1,
  };
}

/** Mini progress bar. */
function ProgressBar({ pct, tone = 'emerald' }: { pct: number; tone?: 'emerald' | 'violet' }) {
  const fill = tone === 'violet' ? colors.purple500 : colors.emerald500;
  return (
    <View style={styles.progressTrack}>
      <View
        style={[
          styles.progressFill,
          { width: `${Math.max(0, Math.min(100, pct))}%`, backgroundColor: fill },
        ]}
      />
    </View>
  );
}

/** Epic banner with spec + ticket progress. Mirrors web EpicScopeHeader. */
export function EpicSummary({ epic, phases, tickets, columns, specItems }: any) {
  if (!epic) return null;
  const colMap = columnNameById(columns);
  const done = countDoneTickets(tickets, colMap);
  const total = tickets.length;
  const ticketPct = total > 0 ? Math.round((done / total) * 100) : 0;
  const spec = specProgress(specItems);
  const auto = epicAutonomousSummary(phases);
  const stateLabel = epicStateLabel(epic.state);

  return (
    <View style={styles.summaryCard} testID="epic-summary">
      <View style={styles.summaryTopRow}>
        <View style={[styles.epicDot, { backgroundColor: epic.color || colors.indigo500 }]} />
        <Text style={styles.summaryName} numberOfLines={2}>
          {epic.name}
        </Text>
        {auto.label ? (
          <View style={styles.autoBadge}>
            <Text style={styles.autoBadgeText}>{auto.label}</Text>
          </View>
        ) : null}
      </View>
      {epic.description ? <Text style={styles.summaryDesc}>{epic.description}</Text> : null}

      <View style={styles.statsRow}>
        <View style={styles.statCell}>
          <Text style={styles.statLabel}>Spec</Text>
          <Text style={styles.statValue}>
            {spec.chosen}/{spec.total || '—'} locked
          </Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statLabel}>Tickets</Text>
          <Text style={styles.statValue}>
            {done}/{total}
          </Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statLabel}>Phases</Text>
          <Text style={styles.statValue}>{phases.length}</Text>
        </View>
        {stateLabel ? (
          <View style={styles.statCell}>
            <Text style={styles.statLabel}>State</Text>
            <Text style={styles.statValue}>{stateLabel}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.progressBlock}>
        <View style={styles.progressHead}>
          <Text style={styles.progressLabel}>Spec decisions</Text>
          <Text style={styles.progressPct}>{spec.pct}%</Text>
        </View>
        <ProgressBar pct={spec.pct} tone="violet" />
      </View>
      <View style={styles.progressBlock}>
        <View style={styles.progressHead}>
          <Text style={styles.progressLabel}>Implementation tickets</Text>
          <Text style={styles.progressPct}>{ticketPct}%</Text>
        </View>
        <ProgressBar pct={ticketPct} tone="emerald" />
      </View>

      {spec.total > 0 && !spec.readyForImplementation ? (
        <Text style={styles.warnText}>
          Lock all open spec decisions (write them yourself or use Decide for me) before autonomous
          runs.
        </Text>
      ) : null}
    </View>
  );
}

/** One spec decision — status pill, decision text, decide/write actions. */
export function SpecItemRow({ item, saving, onDecideForMe, onUpdateSpecItem, onOpenCard }: any) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.decision || '');
  const chosen = item.status === 'chosen';
  const deciding = saving === item.id;

  return (
    <View
      style={[styles.specCard, chosen && styles.specCardChosen]}
      testID={`spec-item-${item.id}`}
    >
      <View style={styles.specHead}>
        <Text style={styles.specTag}>{item.tag}</Text>
        <Text style={[styles.specStatus, chosen ? styles.specStatusChosen : styles.specStatusOpen]}>
          {specStatusLabel(item.status)}
        </Text>
      </View>
      <Text style={styles.specTitle}>{item.title}</Text>

      {editing ? (
        <View style={styles.specEditBlock}>
          <TextInput
            style={[styles.input, styles.specInput]}
            value={draft}
            onChangeText={setDraft}
            multiline
            placeholder={'## Decision\nYour choice…\n\n## Rationale\nWhy…'}
            placeholderTextColor={colors.gray600}
          />
          <View style={styles.specActionRow}>
            <TouchableOpacity onPress={() => setEditing(false)}>
              <Text style={styles.mutedAction}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.smallPrimaryBtn, !draft.trim() && { opacity: 0.5 }]}
              disabled={!draft.trim()}
              onPress={() => {
                onUpdateSpecItem?.(item.id, { decision: draft, status: 'chosen' });
                setEditing(false);
              }}
            >
              <Text style={styles.smallPrimaryBtnText}>{chosen ? 'Save' : 'Lock decision'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : chosen ? (
        <>
          {item.decision ? <Text style={styles.specDecision}>{item.decision}</Text> : null}
          <View style={styles.specActionRow}>
            <TouchableOpacity
              onPress={() => {
                setDraft(item.decision || '');
                setEditing(true);
              }}
            >
              <Text style={styles.mutedAction}>Edit</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.specHint}>
            Write the decision yourself, or use Decide for me to research trade-offs and lock a
            recommendation.
          </Text>
          <View style={styles.specActionRow}>
            <TouchableOpacity
              style={styles.smallBtn}
              onPress={() => {
                setDraft(item.decision || '');
                setEditing(true);
              }}
              testID={`write-decision-${item.id}`}
            >
              <Text style={styles.smallBtnText}>Write decision</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.smallIndigoBtn, deciding && { opacity: 0.5 }]}
              disabled={deciding}
              onPress={() => onDecideForMe?.(item.id)}
              testID={`decide-for-me-${item.id}`}
            >
              <Text style={styles.smallIndigoBtnText}>
                {deciding ? 'Starting…' : 'Decide for me'}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {!editing && item.spike_card_id ? (
        <TouchableOpacity
          style={styles.specLinkedRow}
          onPress={() => onOpenCard?.(item)}
          testID={`open-spec-card-${item.id}`}
        >
          <Text style={styles.link}>Open linked card →</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/** One phase — status, autonomous controls, tickets, add-ticket. */
export function PhaseCard({
  phase,
  index,
  tickets,
  columns,
  form,
  modelConfig,
  specReady,
  running,
  stopping,
  addingTicket,
  onFormChange,
  onRun,
  onStop,
  onAddTicket,
  onOpenCard,
}: any) {
  const [ticketTitle, setTicketTitle] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const colMap = columnNameById(columns);
  const phaseTickets = ticketsForPhase(tickets, phase.id);
  const progress = phaseProgress(phaseTickets, colMap);
  const complete = phaseComplete(phaseTickets, colMap);
  const autonomous = !!form?.autonomous;
  const selectedModel = form?.autonomous_model || '';
  const modelOptions = useMemo(() => autonomousModelOptions(modelConfig), [modelConfig]);

  return (
    <View style={styles.phaseCard} testID={`phase-${phase.id}`}>
      <View style={styles.phaseHead}>
        <View style={styles.phaseHeadLeft}>
          <View style={styles.phaseIndex}>
            <Text style={styles.phaseIndexText}>{index + 1}</Text>
          </View>
          <Text style={styles.phaseName} numberOfLines={1}>
            {phase.name}
          </Text>
          {complete ? <Text style={styles.phaseComplete}>Done</Text> : null}
        </View>
        <Text style={styles.phaseCount}>
          {countDoneTickets(phaseTickets, colMap)}/{phaseTickets.length}
        </Text>
      </View>
      <ProgressBar pct={progress} tone="emerald" />

      <View style={styles.phaseControls}>
        <View style={styles.switchRow}>
          <Text style={styles.controlLabel}>Auto-dispatch</Text>
          <Switch
            value={autonomous}
            onValueChange={(v: boolean) => onFormChange?.(phase.id, { autonomous: v ? 1 : 0 })}
            trackColor={{ false: colors.gray700, true: colors.emerald600 }}
            thumbColor={autonomous ? colors.emerald400 : colors.gray500}
          />
        </View>

        {running ? (
          <View style={styles.runRow}>
            <Text style={styles.runningPill}>● Running</Text>
            <TouchableOpacity
              style={[styles.stopBtn, stopping && { opacity: 0.5 }]}
              disabled={stopping}
              onPress={() => onStop?.(phase.id)}
              testID={`stop-phase-${phase.id}`}
            >
              <Text style={styles.stopBtnText}>{stopping ? 'Stopping…' : 'Stop'}</Text>
            </TouchableOpacity>
          </View>
        ) : autonomous ? (
          <TouchableOpacity
            style={[styles.runBtn, !specReady && { opacity: 0.5 }]}
            disabled={!specReady}
            onPress={() => onRun?.(phase.id)}
            testID={`run-phase-${phase.id}`}
          >
            <Text style={styles.runBtnText}>{specReady ? 'Run phase' : 'Lock spec to run'}</Text>
          </TouchableOpacity>
        ) : null}

        {/* Session model — shown unconditionally to mirror web PhaseFlowchartView,
            where the model selector renders regardless of the auto-dispatch toggle. */}
        <Text style={styles.controlLabel}>Session model</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.modelRow}
        >
          <TouchableOpacity
            style={[styles.modelChip, !selectedModel && styles.modelChipActive]}
            onPress={() => onFormChange?.(phase.id, { autonomous_model: '' })}
          >
            <Text style={[styles.modelChipText, !selectedModel && styles.modelChipTextActive]}>
              Default
            </Text>
          </TouchableOpacity>
          {/* Keep a saved model that is no longer in the options list visible and
              selected, matching web's fallback <option value={selectedModel}>. */}
          {selectedModel && !modelOptions.includes(selectedModel) ? (
            <TouchableOpacity
              key={selectedModel}
              style={[styles.modelChip, styles.modelChipActive]}
              onPress={() => onFormChange?.(phase.id, { autonomous_model: selectedModel })}
            >
              <Text style={[styles.modelChipText, styles.modelChipTextActive]}>
                {selectedModel}
              </Text>
            </TouchableOpacity>
          ) : null}
          {modelOptions.map((model: string) => (
            <TouchableOpacity
              key={model}
              style={[styles.modelChip, selectedModel === model && styles.modelChipActive]}
              onPress={() => onFormChange?.(phase.id, { autonomous_model: model })}
            >
              <Text
                style={[
                  styles.modelChipText,
                  selectedModel === model && styles.modelChipTextActive,
                ]}
              >
                {model}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {autonomous ? (
          <>
            <View style={styles.switchRow}>
              <Text style={styles.controlLabel}>Tickets at once</Text>
              <View style={styles.stepper}>
                <TouchableOpacity
                  style={styles.stepBtn}
                  onPress={() =>
                    onFormChange?.(phase.id, {
                      autonomous_max_concurrent: Math.max(
                        1,
                        (form.autonomous_max_concurrent || 1) - 1,
                      ),
                    })
                  }
                >
                  <Text style={styles.stepBtnText}>−</Text>
                </TouchableOpacity>
                <Text style={styles.stepValue}>{form.autonomous_max_concurrent || 1}</Text>
                <TouchableOpacity
                  style={styles.stepBtn}
                  onPress={() =>
                    onFormChange?.(phase.id, {
                      autonomous_max_concurrent: Math.min(
                        10,
                        (form.autonomous_max_concurrent || 1) + 1,
                      ),
                    })
                  }
                >
                  <Text style={styles.stepBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.switchRow}>
              <Text style={styles.controlLabel}>Auto Merge</Text>
              <Switch
                value={!!form.autonomous_send_it}
                onValueChange={(v: boolean) =>
                  onFormChange?.(phase.id, { autonomous_send_it: v ? 1 : 0 })
                }
                trackColor={{ false: colors.gray700, true: colors.emerald600 }}
                thumbColor={form.autonomous_send_it ? colors.emerald400 : colors.gray500}
              />
            </View>
          </>
        ) : null}
      </View>

      <View style={styles.phaseTickets}>
        {phaseTickets.length === 0 ? (
          <Text style={styles.noTickets}>No tickets yet</Text>
        ) : (
          phaseTickets.map((t: any) => {
            const col = colMap[t.column_id] || 'To Do';
            const done = isColumnDone(col);
            return (
              <TouchableOpacity
                key={t.id}
                style={styles.ticketRow}
                onPress={() => onOpenCard?.(t)}
                testID={`phase-ticket-${t.id}`}
              >
                <Text style={styles.ticketTitle} numberOfLines={1}>
                  {t.title}
                </Text>
                <Text style={[styles.ticketCol, done && styles.ticketColDone]}>{col}</Text>
              </TouchableOpacity>
            );
          })
        )}
      </View>

      {showAdd ? (
        <View style={styles.addRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={ticketTitle}
            onChangeText={setTicketTitle}
            placeholder="New ticket title"
            placeholderTextColor={colors.gray600}
          />
          <TouchableOpacity
            style={[
              styles.smallPrimaryBtn,
              (!ticketTitle.trim() || addingTicket) && { opacity: 0.5 },
            ]}
            disabled={!ticketTitle.trim() || addingTicket}
            onPress={() => {
              onAddTicket?.(phase.id, ticketTitle.trim());
              setTicketTitle('');
              setShowAdd(false);
            }}
          >
            <Text style={styles.smallPrimaryBtnText}>{addingTicket ? '…' : 'Add'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity onPress={() => setShowAdd(true)} testID={`add-ticket-${phase.id}`}>
          <Text style={styles.addTicketLink}>+ Add ticket</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function EpicDetailScreen({ route, navigation }: any) {
  const { projectId, project, epicId } = route.params || {};
  const { setActiveAgentId, setActiveSessionId } = useApp();
  const [board, setBoard] = useState<any>(null);
  const [modelConfig, setModelConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [phaseForms, setPhaseForms] = useState<Record<string, any>>({});
  const [scoping, setScoping] = useState(false);
  const [specSavingId, setSpecSavingId] = useState<any>(null);
  const [phaseStoppingId, setPhaseStoppingId] = useState<any>(null);
  const [addingTicketPhaseId, setAddingTicketPhaseId] = useState<any>(null);
  const [creatingPhase, setCreatingPhase] = useState(false);
  const [showPhaseForm, setShowPhaseForm] = useState(false);
  const [newPhaseName, setNewPhaseName] = useState('');
  const [showSpecForm, setShowSpecForm] = useState(false);
  const [newSpec, setNewSpec] = useState({ tag: '', title: '' });
  const [savingSpec, setSavingSpec] = useState(false);

  const loadBoard = useCallback(async () => {
    try {
      const data = await api.getProjectBoard(projectId, { limit: 'all' });
      setBoard(data);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load epic');
      setBoard(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch(() => setModelConfig(null));
  }, []);

  const epic = useMemo(
    () => (board?.epics || []).find((e: any) => e.id === epicId) || null,
    [board, epicId],
  );
  const columns = useMemo(() => board?.columns || [], [board]);
  const cards = useMemo(() => board?.cards || [], [board]);
  const phases = useMemo(() => phasesForEpic(board?.phases || [], epicId), [board, epicId]);
  const tickets = useMemo(() => ticketsForEpic(cards, epicId), [cards, epicId]);
  const specItems = useMemo(
    () => (board?.specItems || []).filter((s: any) => s.epic_id === epicId),
    [board, epicId],
  );
  const spec = useMemo(() => specProgress(specItems), [specItems]);
  const unassignedTickets = useMemo(() => tickets.filter((t: any) => !t.phase_id), [tickets]);

  // Seed per-phase forms from rows whenever the phase set changes.
  useEffect(() => {
    setPhaseForms((prev) => {
      const next = { ...prev };
      for (const p of phases) {
        if (!next[p.id]) next[p.id] = phaseFormFromRow(p);
      }
      return next;
    });
  }, [phases]);

  const persistPhaseForm = useCallback(
    async (phaseId: string, patch: any) => {
      const phase = phases.find((p: any) => p.id === phaseId);
      if (!phase) return;
      const merged = { ...(phaseForms[phaseId] || phaseFormFromRow(phase)), ...patch };
      setPhaseForms((prev) => ({ ...prev, [phaseId]: merged }));
      try {
        await api.updatePhase(
          projectId,
          phaseId,
          phaseFormToUpdateBody({ ...merged, name: phase.name }),
        );
        await loadBoard();
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to update phase settings');
      }
    },
    [phases, phaseForms, projectId, loadBoard],
  );

  const handleRunPhase = useCallback(
    async (phaseId: string) => {
      try {
        await api.runPhase(projectId, phaseId);
        await loadBoard();
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to run phase');
      }
    },
    [projectId, loadBoard],
  );

  const handleStopPhase = useCallback(
    async (phaseId: string) => {
      setPhaseStoppingId(phaseId);
      try {
        await api.stopPhase(projectId, phaseId);
        await loadBoard();
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to stop phase');
      } finally {
        setPhaseStoppingId(null);
      }
    },
    [projectId, loadBoard],
  );

  const defaultColumnId = useMemo(() => {
    const backlog = columns.find((c: any) => (c.name || '').toLowerCase() === 'backlog');
    const todo = columns.find((c: any) => (c.name || '').toLowerCase() === 'to do');
    return backlog?.id || todo?.id || columns[0]?.id || null;
  }, [columns]);

  const handleAddTicket = useCallback(
    async (phaseId: string, title: string) => {
      if (!defaultColumnId) return;
      setAddingTicketPhaseId(phaseId);
      try {
        await api.createKanbanCard(projectId, {
          title,
          priority: 'medium',
          columnId: defaultColumnId,
          epicId,
          phaseId,
          createdBy: 'user',
        });
        await loadBoard();
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to create ticket');
      } finally {
        setAddingTicketPhaseId(null);
      }
    },
    [projectId, epicId, defaultColumnId, loadBoard],
  );

  const handleAddPhase = useCallback(async () => {
    if (!newPhaseName.trim()) return;
    setCreatingPhase(true);
    try {
      const autonomousModel = defaultAutonomousModel(modelConfig);
      await api.createPhase(projectId, {
        epicId,
        name: newPhaseName.trim(),
        ...(autonomousModel ? { autonomousModel } : {}),
      });
      setNewPhaseName('');
      setShowPhaseForm(false);
      await loadBoard();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to create phase');
    } finally {
      setCreatingPhase(false);
    }
  }, [projectId, epicId, newPhaseName, modelConfig, loadBoard]);

  const handleAssignTicket = useCallback(
    async (ticketId: string, phaseId: string) => {
      try {
        await api.updateKanbanCard(projectId, ticketId, { phaseId });
        await loadBoard();
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to assign ticket');
      }
    },
    [projectId, loadBoard],
  );

  const handleUpdateSpecItem = useCallback(
    async (specItemId: string, patch: any) => {
      setSpecSavingId(specItemId);
      try {
        await api.updateSpecItem(projectId, specItemId, patch);
        await loadBoard();
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to update spec decision');
      } finally {
        setSpecSavingId(null);
      }
    },
    [projectId, loadBoard],
  );

  const handleDecideForMe = useCallback(
    async (specItemId: string) => {
      setSpecSavingId(specItemId);
      try {
        const result = await api.decideSpecForMe(projectId, specItemId);
        await loadBoard();
        if (result?.sessionId && result?.agentId && navigation) {
          setActiveAgentId(result.agentId);
          setActiveSessionId(result.sessionId);
          navigation.navigate('Chat');
        }
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to start decide-for-me');
      } finally {
        setSpecSavingId(null);
      }
    },
    [projectId, loadBoard, navigation, setActiveAgentId, setActiveSessionId],
  );

  const handleAddSpecItem = useCallback(async () => {
    if (!newSpec.tag.trim() || !newSpec.title.trim()) {
      Alert.alert('Error', 'Tag and title are required');
      return;
    }
    setSavingSpec(true);
    try {
      await api.createSpecItem(projectId, {
        epicId,
        tag: newSpec.tag.trim(),
        title: newSpec.title.trim(),
      });
      setNewSpec({ tag: '', title: '' });
      setShowSpecForm(false);
      await loadBoard();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to add spec decision');
    } finally {
      setSavingSpec(false);
    }
  }, [projectId, epicId, newSpec, loadBoard]);

  const handleScope = useCallback(async () => {
    if (scoping) return;
    setScoping(true);
    try {
      const result = await api.scopeEpic(projectId, epicId);
      if (result?.sessionId && result?.agentId && navigation) {
        setActiveAgentId(result.agentId);
        setActiveSessionId(result.sessionId);
        navigation.navigate('Chat');
      }
    } catch {
      Alert.alert('Error', 'Failed to open scoping session');
    } finally {
      setScoping(false);
    }
  }, [projectId, epicId, scoping, navigation, setActiveAgentId, setActiveSessionId]);

  const openCard = useCallback(
    (card: any) => {
      navigation?.navigate('Kanban', { projectId, project, epicId, focusCardId: card?.id });
    },
    [navigation, projectId, project, epicId],
  );

  // Jump from a spec decision to its linked spike card on the board.
  const openSpecCard = useCallback(
    (specItem: any) => {
      if (!specItem?.spike_card_id) return;
      openCard({ id: specItem.spike_card_id });
    },
    [openCard],
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader
        title={epic?.name || 'Epic'}
        project={project}
        onBack={() => navigation.goBack()}
      />
      {loading ? (
        <ActivityIndicator color={colors.gray400} style={{ marginTop: 24 }} />
      ) : !epic ? (
        <View style={styles.notFound}>
          <Text style={styles.empty}>Epic not found.</Text>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.link}>Back to epics</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <EpicSummary
            epic={epic}
            phases={phases}
            tickets={tickets}
            columns={columns}
            specItems={specItems}
          />

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.scopeBtn, scoping && { opacity: 0.5 }]}
              disabled={scoping}
              onPress={handleScope}
              testID="epic-scope-button"
            >
              <Text style={styles.scopeBtnText}>{scoping ? 'Opening…' : 'Scope with agent'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() =>
                navigation.navigate('Epics', { projectId, project, editEpicId: epic.id })
              }
            >
              <Text style={styles.secondaryBtnText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => navigation.navigate('Kanban', { projectId, project, epicId: epic.id })}
            >
              <Text style={styles.secondaryBtnText}>Board</Text>
            </TouchableOpacity>
          </View>

          {/* ── Spec decisions ───────────────────────────────── */}
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>1 · Spec decisions</Text>
            {specItems.length > 0 ? (
              <TouchableOpacity onPress={() => setShowSpecForm((v) => !v)}>
                <Text style={styles.link}>{showSpecForm ? 'Cancel' : '+ Decision'}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {showSpecForm || specItems.length === 0 ? (
            <View style={styles.formCard}>
              <Text style={styles.label}>Tag</Text>
              <TextInput
                style={styles.input}
                value={newSpec.tag}
                onChangeText={(v) => setNewSpec((s) => ({ ...s, tag: v }))}
                placeholder="e.g. data-model"
                placeholderTextColor={colors.gray600}
                autoCapitalize="none"
              />
              <Text style={styles.label}>Question / title</Text>
              <TextInput
                style={[styles.input, { minHeight: 48 }]}
                value={newSpec.title}
                onChangeText={(v) => setNewSpec((s) => ({ ...s, title: v }))}
                multiline
                placeholder="What has to be decided before building?"
                placeholderTextColor={colors.gray600}
              />
              <TouchableOpacity
                style={[styles.primaryBtn, savingSpec && { opacity: 0.5 }]}
                disabled={savingSpec}
                onPress={handleAddSpecItem}
              >
                <Text style={styles.primaryBtnText}>{savingSpec ? 'Adding…' : 'Add decision'}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {specItems.map((item: any) => (
            <SpecItemRow
              key={item.id}
              item={item}
              saving={specSavingId}
              onDecideForMe={handleDecideForMe}
              onUpdateSpecItem={handleUpdateSpecItem}
              onOpenCard={openSpecCard}
            />
          ))}

          {/* ── Phases & tickets ─────────────────────────────── */}
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>2 · Phases & tickets</Text>
            <TouchableOpacity onPress={() => setShowPhaseForm((v) => !v)}>
              <Text style={styles.link}>{showPhaseForm ? 'Cancel' : '+ Phase'}</Text>
            </TouchableOpacity>
          </View>
          {spec.open > 0 ? (
            <Text style={styles.mutedNote}>
              You can draft phases and tickets now — autonomous runs unlock once all spec decisions
              are locked.
            </Text>
          ) : null}
          {showPhaseForm ? (
            <View style={styles.addRow}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={newPhaseName}
                onChangeText={setNewPhaseName}
                placeholder="Phase name"
                placeholderTextColor={colors.gray600}
              />
              <TouchableOpacity
                style={[
                  styles.smallPrimaryBtn,
                  (!newPhaseName.trim() || creatingPhase) && { opacity: 0.5 },
                ]}
                disabled={!newPhaseName.trim() || creatingPhase}
                onPress={handleAddPhase}
              >
                <Text style={styles.smallPrimaryBtnText}>{creatingPhase ? '…' : 'Add'}</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {unassignedTickets.length > 0 ? (
            <View style={styles.unassignedCard}>
              <Text style={styles.unassignedTitle}>Unassigned tickets</Text>
              {unassignedTickets.map((t: any) => (
                <View key={t.id} style={styles.unassignedRow}>
                  <Text style={styles.ticketTitle} numberOfLines={1}>
                    {t.title}
                  </Text>
                  {phases.length > 0 ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.assignChips}
                    >
                      {phases.map((p: any) => (
                        <TouchableOpacity
                          key={p.id}
                          style={styles.assignChip}
                          onPress={() => handleAssignTicket(t.id, p.id)}
                        >
                          <Text style={styles.assignChipText}>→ {p.name}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  ) : (
                    <Text style={styles.mutedNote}>Add a phase to assign</Text>
                  )}
                </View>
              ))}
            </View>
          ) : null}

          {phases.length === 0 ? (
            <Text style={styles.empty}>No phases yet.</Text>
          ) : (
            phases.map((p: any, i: number) => (
              <PhaseCard
                key={p.id}
                phase={p}
                index={i}
                tickets={tickets}
                columns={columns}
                form={phaseForms[p.id] || phaseFormFromRow(p)}
                modelConfig={modelConfig}
                specReady={spec.readyForImplementation}
                running={!!p.autonomous_running}
                stopping={phaseStoppingId === p.id}
                addingTicket={addingTicketPhaseId === p.id}
                onFormChange={persistPhaseForm}
                onRun={handleRunPhase}
                onStop={handleStopPhase}
                onAddTicket={handleAddTicket}
                onOpenCard={openCard}
              />
            ))
          )}

          {/* Reverse (bidirectional) display: the caller's own personal todos
              linked to this epic. Renders nothing when there are none. */}
          <LinkedTodosPanel targetType="epic" entity={epic} projectId={projectId} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 40 },
  notFound: { alignItems: 'center', marginTop: 40, gap: 8 },
  empty: { fontSize: 14, color: colors.gray500, marginTop: 12 },
  link: { fontSize: 13, color: colors.blue400 },
  mutedNote: { fontSize: 12, color: colors.gray500, marginBottom: 8, lineHeight: 17 },
  mutedAction: { fontSize: 12, color: colors.gray400 },

  // Summary
  summaryCard: {
    backgroundColor: colors.gray900,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  summaryTopRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  epicDot: { width: 12, height: 12, borderRadius: 4 },
  summaryName: { fontSize: 17, fontWeight: '700', color: colors.white, flex: 1 },
  autoBadge: {
    backgroundColor: colors.emerald900_50,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  autoBadgeText: { fontSize: 10, fontWeight: '700', color: colors.emerald400 },
  summaryDesc: { fontSize: 13, color: colors.gray400, marginTop: 6, lineHeight: 18 },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 },
  statCell: {},
  statLabel: { fontSize: 10, textTransform: 'uppercase', color: colors.gray600, marginBottom: 2 },
  statValue: { fontSize: 13, fontWeight: '600', color: colors.gray200 },
  progressBlock: { marginTop: 12 },
  progressHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  progressLabel: { fontSize: 11, color: colors.gray500 },
  progressPct: { fontSize: 11, color: colors.gray500 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.gray800,
    overflow: 'hidden',
  },
  progressFill: { height: 6, borderRadius: 3 },
  warnText: { fontSize: 11, color: colors.amber400, marginTop: 10, lineHeight: 16 },

  // Actions
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 8 },
  scopeBtn: {
    backgroundColor: colors.indigo900_40,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    flex: 1,
    alignItems: 'center',
  },
  scopeBtnText: { color: colors.indigo300, fontWeight: '600', fontSize: 13 },
  secondaryBtn: {
    backgroundColor: colors.gray800,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  secondaryBtnText: { color: colors.blue400, fontWeight: '600', fontSize: 13 },

  // Sections
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 8,
  },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: colors.gray100 },

  // Forms
  formCard: {
    backgroundColor: colors.gray900,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  label: { fontSize: 12, color: colors.gray400, marginBottom: 4, marginTop: 8 },
  input: {
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 10,
    color: colors.white,
    fontSize: 14,
  },
  primaryBtn: {
    marginTop: 12,
    backgroundColor: colors.emerald800_50,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: { color: colors.emerald400, fontWeight: '600' },
  smallPrimaryBtn: {
    backgroundColor: colors.emerald800_50,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallPrimaryBtnText: { color: colors.emerald400, fontWeight: '600', fontSize: 13 },
  smallBtn: {
    backgroundColor: colors.gray800,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  smallBtnText: { color: colors.gray300, fontSize: 12, fontWeight: '600' },
  smallIndigoBtn: {
    backgroundColor: colors.indigo900_40,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  smallIndigoBtnText: { color: colors.indigo300, fontSize: 12, fontWeight: '600' },

  // Spec
  specCard: {
    backgroundColor: colors.gray900,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  specCardChosen: { borderColor: colors.emerald800 },
  specHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  specTag: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', color: colors.gray500 },
  specStatus: { fontSize: 11, fontWeight: '600' },
  specStatusChosen: { color: colors.emerald400 },
  specStatusOpen: { color: colors.amber400 },
  specTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray100,
    marginTop: 4,
    lineHeight: 19,
  },
  specDecision: { fontSize: 12, color: colors.gray300, marginTop: 8, lineHeight: 18 },
  specHint: {
    fontSize: 12,
    color: colors.gray500,
    fontStyle: 'italic',
    marginTop: 6,
    lineHeight: 17,
  },
  specEditBlock: { marginTop: 8 },
  specInput: { minHeight: 90, textAlignVertical: 'top' },
  specActionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  specLinkedRow: { marginTop: 10 },

  // Phase
  phaseCard: {
    backgroundColor: colors.gray900,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  phaseHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  phaseHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  phaseIndex: {
    width: 22,
    height: 22,
    borderRadius: 6,
    backgroundColor: colors.gray800,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phaseIndexText: { fontSize: 11, fontWeight: '700', color: colors.gray400 },
  phaseName: { fontSize: 14, fontWeight: '600', color: colors.gray100, flex: 1 },
  phaseComplete: { fontSize: 10, fontWeight: '700', color: colors.emerald400 },
  phaseCount: { fontSize: 12, color: colors.gray500 },
  phaseControls: { marginTop: 10, gap: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  controlLabel: { fontSize: 11, textTransform: 'uppercase', color: colors.gray500 },
  runRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  runningPill: { fontSize: 11, fontWeight: '600', color: colors.emerald400 },
  runBtn: {
    backgroundColor: colors.emerald800_50,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  runBtnText: { color: colors.emerald400, fontWeight: '600', fontSize: 13 },
  stopBtn: {
    backgroundColor: colors.red900_50,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  stopBtnText: { color: colors.red400, fontWeight: '600', fontSize: 12 },
  modelRow: { gap: 6, paddingVertical: 2 },
  modelChip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: colors.gray950,
  },
  modelChipActive: { borderColor: colors.emerald500, backgroundColor: colors.emerald900_40 },
  modelChipText: { fontSize: 11, color: colors.gray400 },
  modelChipTextActive: { color: colors.emerald300 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: colors.gray800,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnText: { fontSize: 16, color: colors.gray200, fontWeight: '700' },
  stepValue: {
    fontSize: 14,
    color: colors.gray100,
    fontWeight: '600',
    minWidth: 18,
    textAlign: 'center',
  },
  phaseTickets: { marginTop: 10, gap: 4 },
  noTickets: { fontSize: 12, color: colors.gray600, textAlign: 'center', paddingVertical: 10 },
  ticketRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.gray950,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  ticketTitle: { fontSize: 13, color: colors.gray200, flex: 1 },
  ticketCol: { fontSize: 10, color: colors.gray500, textTransform: 'uppercase' },
  ticketColDone: { color: colors.emerald400 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, marginBottom: 10 },
  addTicketLink: { fontSize: 12, color: colors.blue400, marginTop: 10 },

  // Unassigned
  unassignedCard: {
    backgroundColor: colors.gray900,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.amber900_40,
  },
  unassignedTitle: { fontSize: 12, fontWeight: '700', color: colors.amber400, marginBottom: 8 },
  unassignedRow: { marginBottom: 8, gap: 6 },
  assignChips: { gap: 6 },
  assignChip: {
    backgroundColor: colors.gray800,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  assignChipText: { fontSize: 11, color: colors.blue400 },
});
