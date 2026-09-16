import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { hasRole } from '../utils/auth';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import {
  deriveAutopilotView,
  msToHours,
  hoursToMs,
  msToMinutes,
  minutesToMs,
  parseAutopilotCostCap,
  validateAutopilotLimitsForm,
  AUTOPILOT_ISOLATION_ADAPTERS,
  type AutopilotProjectStateWire,
  type AutopilotIsolationAdapter,
} from '@shared/utils/autopilotView';

const ACTIVE_POLL_MS = 5000;

export interface AutopilotFormState {
  brief: string;
  targetId: string;
  origin: string;
  readinessProbeUrl: string;
  cycleMode: 'continuous' | 'finite';
  maxCycles: string;
  maxWallTimeHours: string;
  maxStageTimeoutMinutes: string;
  maxRetriesPerStage: string;
  maxCostUsd: string;
  credentialOwnerUserId: string;
  isolationAdapter: AutopilotIsolationAdapter;
  hostAdapterAck: boolean;
}

export function formFromState(state: AutopilotProjectStateWire | null): AutopilotFormState {
  const c = state?.config;
  const l = c?.limits;
  return {
    brief: c?.brief ?? '',
    targetId: c?.target?.targetId ?? '',
    origin: c?.target?.origin ?? '',
    readinessProbeUrl: c?.target?.readinessProbeUrl ?? '',
    cycleMode: l?.cycleMode ?? 'continuous',
    maxCycles: l?.maxCycles != null ? String(l.maxCycles) : '',
    maxWallTimeHours: l ? String(msToHours(l.maxWallTimeMs) || 4) : '4',
    maxStageTimeoutMinutes: l ? String(msToMinutes(l.maxStageTimeoutMs) || 30) : '30',
    maxRetriesPerStage: l ? String(l.maxRetriesPerStage) : '2',
    maxCostUsd: l?.maxCostUsd != null ? String(l.maxCostUsd) : '',
    credentialOwnerUserId: c?.credentialOwnerUserId ?? '',
    isolationAdapter: c?.isolationAdapter ?? 'auto',
    hostAdapterAck: c?.hostAdapterAck ?? false,
  };
}

export function buildConfigBody(form: AutopilotFormState) {
  const maxCycles = form.cycleMode === 'finite' ? Math.max(1, Number(form.maxCycles) || 1) : null;
  // `null` only for an explicitly empty field; invalid nonempty input is caught
  // by saveConfig before this runs (never silently clears the cap).
  const cap = parseAutopilotCostCap(form.maxCostUsd);
  const maxCostUsd = cap.ok ? cap.value : Number(form.maxCostUsd);
  return {
    brief: form.brief.trim() || null,
    target: {
      targetId: form.targetId.trim(),
      origin: form.origin.trim() || null,
      readinessProbeUrl: form.readinessProbeUrl.trim() || null,
    },
    limits: {
      cycleMode: form.cycleMode,
      maxCycles,
      maxWallTimeMs: hoursToMs(Number(form.maxWallTimeHours) || 4),
      maxStageTimeoutMs: minutesToMs(Number(form.maxStageTimeoutMinutes) || 30),
      maxRetriesPerStage: Math.min(2, Math.max(0, Number(form.maxRetriesPerStage) || 0)),
      maxCostUsd: maxCostUsd && maxCostUsd > 0 ? maxCostUsd : null,
    },
    credentialOwnerUserId: form.credentialOwnerUserId.trim() || null,
    isolationAdapter: form.isolationAdapter,
    // The acknowledgment only matters for the host adapter; never persist a
    // stale "yes" for a verified adapter selection.
    hostAdapterAck: form.isolationAdapter === 'host' ? form.hostAdapterAck : false,
  };
}

export default function ExperimentalAutopilotScreen({ route, navigation }: any) {
  const projectId = route?.params?.projectId;
  const project = route?.params?.project;
  const { connected, projects } = useApp();
  const currentProject = projects?.find((p: any) => p.id === projectId);

  const [state, setState] = useState<AutopilotProjectStateWire | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Stop tracked independently of the serialized ordinary mutation so a Stop
  // completing mid-Save never frees the Save's in-flight slot.
  const [stopBusy, setStopBusy] = useState(false);
  const [form, setForm] = useState<AutopilotFormState>(() => formFromState(null));
  const dirtyRef = useRef(false);
  const prevConnected = useRef(connected);
  // Every async op (GET load AND mutation-triggered reload) captures the
  // project it started for and confirms it is still current before touching
  // state, so a completion for project A can never overwrite project B.
  // `projectRef` mirrors the latest projectId synchronously; `loadGenRef`
  // additionally discards a superseded same-project load.
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const loadGenRef = useRef(0);
  // Bumped on every project switch; combined with the per-operation token it
  // gives each mutation an identity that can't recur across A → B → A.
  const projectGenRef = useRef(0);
  // Monotonic edit revision so a save's reconciling reload only repopulates the
  // form when no newer edit landed while the request was in flight.
  const editSeqRef = useRef(0);
  // The config revision the current form is based on — pinned to the form, not
  // to state.config, so a background load can't advance it under a dirty form
  // and let a save overwrite another client's write.
  const formBaseRevisionRef = useRef<number | undefined>(undefined);
  // Increments whenever the form is (re)populated from the server (load,
  // reconnect, project switch). A save completion advances the base revision
  // only if this hasn't changed since the save began — otherwise the form now
  // holds different server content and must keep the reloaded base.
  const formLoadGenRef = useRef(0);
  // Highest server-authored stateVersion whose activeRun we've applied. Every
  // activeRun application (GET or mutation) must be at least this fresh, so
  // overlapping responses reconcile by server state order, not arrival order.
  const appliedRunVersionRef = useRef(-1);
  // Unique per-operation token. Slot ownership is proven by token identity,
  // never by (projectId, key), so a stale completion can't reclaim a slot.
  const opSeqRef = useRef(0);
  // Slots hold the owning operation's token (null = free). Ordinary mutations
  // serialize through busyRef; Stop uses its own stopRef.
  const busyRef = useRef<number | null>(null);
  const stopRef = useRef<number | null>(null);

  const isAdmin = hasRole('Admin');

  // Accept an activeRun application only if its server-authored version is at
  // least as fresh as what we've already applied. Stable (reads a ref).
  const acceptStateVersion = useCallback((v?: number): boolean => {
    if (typeof v !== 'number') return true;
    if (v < appliedRunVersionRef.current) return false;
    appliedRunVersionRef.current = v;
    return true;
  }, []);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!projectId) return;
      const proj = projectId;
      const gen = ++loadGenRef.current;
      const current = () => proj === projectRef.current && gen === loadGenRef.current;
      if (!opts.silent) setLoading(true);
      try {
        const res = (await api.getAutopilot(proj)) as AutopilotProjectStateWire;
        if (!current()) return;
        // Apply the run only if this GET is at least as fresh as what's shown;
        // config always takes the latest read.
        const runFresh = acceptStateVersion(res.stateVersion);
        setState((prev) => ({
          config: res.config,
          activeRun: runFresh ? res.activeRun : (prev?.activeRun ?? null),
        }));
        setError(null);
        // Repopulate + re-pin the base revision only when there are no unsaved
        // edits; a dirty form keeps its edits and its older base revision.
        if (!dirtyRef.current) {
          setForm(formFromState(res));
          formBaseRevisionRef.current = res.config.revision;
          formLoadGenRef.current++;
        }
      } catch (e: any) {
        if (!current()) return;
        if (!opts.silent) setError(e?.message || 'Failed to load Autopilot state');
      } finally {
        if (current() && !opts.silent) setLoading(false);
      }
    },
    [projectId, acceptStateVersion],
  );

  // On project switch, drop the previous project's state so mutations are
  // blocked until the new project's config has loaded.
  useEffect(() => {
    dirtyRef.current = false;
    loadGenRef.current++;
    projectGenRef.current++;
    busyRef.current = null;
    stopRef.current = null;
    appliedRunVersionRef.current = -1;
    formBaseRevisionRef.current = undefined;
    formLoadGenRef.current++;
    setState(null);
    setError(null);
    setBusy(null);
    setStopBusy(false);
    setForm(formFromState(null));
    load();
  }, [load]);

  // Refetch on WebSocket reconnect (state is server-authoritative).
  useEffect(() => {
    if (connected && !prevConnected.current) load({ silent: true });
    prevConnected.current = connected;
  }, [connected, load]);

  const view = state ? deriveAutopilotView(state) : null;
  const active = Boolean(view?.controls.isActive);
  // An in-flight ordinary mutation disables the other mutation triggers. Stop
  // is tracked separately (`stopBusy`) and stays available.
  const mutating = busy !== null;

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => load({ silent: true }), ACTIVE_POLL_MS);
    return () => clearInterval(id);
  }, [active, load]);

  const updateForm = (patch: Partial<AutopilotFormState>) => {
    editSeqRef.current++;
    dirtyRef.current = true;
    setForm((prev) => ({ ...prev, ...patch }));
  };

  /**
   * Run a mutation, then reconcile with the server. The mutation's response is
   * authoritative and applied immediately (via `apply`), so a failed reconciling
   * reload never strands the operator on a stale snapshot — the active-run poll
   * keeps retrying. `resetForm` clears dirty only when no newer edit landed
   * while the request was in flight.
   */
  const runAction = async (
    key: string,
    fn: () => Promise<any>,
    successTitle: string,
    opts: {
      resetForm?: boolean;
      apply?: (
        res: any,
        prev: AutopilotProjectStateWire | null,
      ) => AutopilotProjectStateWire | null;
    } = {},
  ) => {
    // Block mutations until the current project's config has loaded.
    if (!projectId || !state) return;
    const isStop = key === 'stop';
    const slotRef = isStop ? stopRef : busyRef;
    // Serialize ordinary mutations; refuse a duplicate Stop. Stop and one
    // ordinary mutation may run concurrently with independent slots.
    if (slotRef.current !== null) return;
    // Identity for this operation: a unique token + the project generation it
    // started under. Ownership is proven by these, never by (projectId, key).
    const token = ++opSeqRef.current;
    const gen = projectGenRef.current;
    const proj = projectId;
    const editsAtStart = editSeqRef.current;
    slotRef.current = token;
    if (isStop) setStopBusy(true);
    else setBusy(key);
    const owns = () =>
      slotRef.current === token && proj === projectRef.current && gen === projectGenRef.current;
    try {
      const res = await fn();
      // Discard unless this operation still owns its slot (project switch or a
      // newer same-key mutation supersedes it).
      if (!owns()) return;
      if (opts.apply) setState((prev) => (prev ? opts.apply!(res, prev) : prev));
      if (opts.resetForm && editSeqRef.current === editsAtStart) dirtyRef.current = false;
      Alert.alert('Autopilot', successTitle);
      await load({ silent: true });
    } catch (e: any) {
      if (!owns()) return;
      Alert.alert('Action failed', e?.message || 'Could not complete the action');
      // Refresh so a rejected write (e.g. a revision conflict) re-reads the
      // current server state and revision for the next attempt.
      await load({ silent: true });
    } finally {
      // Release only if this operation still owns the slot.
      if (slotRef.current === token) {
        slotRef.current = null;
        if (proj === projectRef.current && gen === projectGenRef.current) {
          if (isStop) setStopBusy(false);
          else setBusy(null);
        }
      }
    }
  };

  const applyRunSnapshot = (
    res: any,
    prev: AutopilotProjectStateWire | null,
  ): AutopilotProjectStateWire | null => {
    if (!prev || !acceptStateVersion(res?.stateVersion)) return prev;
    return { ...prev, activeRun: res && typeof res === 'object' && res.run ? res : prev.activeRun };
  };

  const saveConfig = () => {
    // Reject invalid numeric limits rather than letting them silently change a
    // safety-relevant limit (see web sibling).
    const limitsCheck = validateAutopilotLimitsForm(form);
    if (!limitsCheck.ok) {
      Alert.alert('Invalid limits', limitsCheck.message);
      return;
    }
    const formGenAtStart = formLoadGenRef.current;
    return runAction(
      'save',
      () =>
        api.putAutopilotConfig(projectId, {
          ...buildConfigBody(form),
          // Guard keyed to the revision the FORM was built from (see web sibling).
          expectedRevision: formBaseRevisionRef.current,
        }),
      'Configuration saved',
      {
        resetForm: true,
        apply: (res, prev) => {
          // Only pin the base if the form still holds what this save persisted
          // (no reload replaced it meanwhile).
          if (
            formLoadGenRef.current === formGenAtStart &&
            res &&
            typeof res === 'object' &&
            typeof res.revision === 'number'
          ) {
            formBaseRevisionRef.current = res.revision;
          }
          return prev && res && typeof res === 'object' ? { ...prev, config: res } : prev;
        },
      },
    );
  };

  const confirmStop = () =>
    Alert.alert('Stop run', 'Stop the active Autopilot run?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop',
        style: 'destructive',
        onPress: () =>
          runAction('stop', () => api.stopAutopilot(projectId), 'Stop requested', {
            apply: applyRunSnapshot,
          }),
      },
    ]);

  if ((currentProject && !currentProject.autopilotEnabled) || (state && !state.config.enabled)) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <ProjectScreenHeader
          title="Autopilot"
          project={project}
          onBack={() => navigation.goBack()}
        />
        <Text style={styles.hint} testID="autopilot-disabled">
          Enable Autopilot in Project Configuration.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Autopilot" project={project} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.hint}>
          Experimental. The Hub plans, implements, deploys, verifies and documents small
          improvements against a dedicated local target, one cycle at a time.
        </Text>

        {loading && <ActivityIndicator color={colors.gray400} />}
        {error && <Text style={styles.error}>{error}</Text>}

        {view && view.run && (
          <View style={styles.card} testID="autopilot-run">
            <Text style={styles.sectionTitle}>Current run</Text>
            <Text style={styles.row}>
              State: {view.run.controlStateLabel} · Cycle {view.run.cycleNumber} ·{' '}
              {view.run.stageLabel}
            </Text>
            {view.run.stopping && (
              <Text style={styles.warnInline} testID="autopilot-stopping">
                Cancellation in progress — stays “Stopping” until in-flight work settles.
              </Text>
            )}
            <Text style={styles.row}>Improvement: {view.run.selectedImprovement || '—'}</Text>
            <Text style={styles.row}>Deployed: {view.run.deployedUrl || '—'}</Text>
            <Text style={styles.row}>Verified revision: {view.run.lastVerifiedShaShort}</Text>
            <Text style={styles.row}>Usage: {view.run.usageText}</Text>
            {view.run.pauseReason && (
              <Text style={styles.warnInline}>Paused: {view.run.pauseReason}</Text>
            )}
            {view.run.failureReason && (
              <Text style={styles.error} testID="autopilot-failure-reason">
                Failed: {view.run.failureReason}
              </Text>
            )}

            <View style={styles.subSection} testID="autopilot-activity">
              <Text style={styles.subTitle}>Activity</Text>
              {view.run.currentWork && (
                <Text style={styles.rowSmall} testID="autopilot-current-work">
                  Now: {view.run.currentWork.kindLabel} in flight
                  {view.run.currentWork.sessionId
                    ? ` · session ${view.run.currentWork.sessionId.slice(0, 8)}`
                    : ''}
                </Text>
              )}
              {view.run.activity.length === 0 ? (
                <Text style={styles.rowSmall} testID="autopilot-activity-empty">
                  No controller events yet.
                </Text>
              ) : (
                view.run.activity.slice(0, 30).map((line) => (
                  <Text key={line.id} style={styles.rowSmall}>
                    {line.text}
                  </Text>
                ))
              )}
            </View>

            {view.run.evidence ? (
              <View style={styles.subSection} testID="autopilot-evidence">
                <Text style={styles.subTitle}>
                  {view.run.evidenceLabel}: {view.run.evidence.verdict}
                </Text>
                {view.run.evidenceStale && (
                  <Text style={styles.rowSmall} testID="autopilot-evidence-stale">
                    Previous verify result — the run is currently{' '}
                    {view.run.stageLabel.toLowerCase()}.
                  </Text>
                )}
                {view.run.evidence.verdict === 'failed' &&
                  (view.run.evidence.failureReason || view.run.evidence.failureDetail) && (
                    <Text style={styles.error} testID="autopilot-evidence-failure">
                      {view.run.evidence.failureReason
                        ? `${view.run.evidence.failureReason}: `
                        : ''}
                      {view.run.evidence.failureDetail || 'Verification failed.'}
                    </Text>
                  )}
                {view.run.evidence.observedSha != null && (
                  <Text style={styles.rowSmall}>
                    Observed {view.run.evidence.observedSha.slice(0, 10)}
                    {view.run.evidence.origin ? ` at ${view.run.evidence.origin}` : ''}
                    {view.run.evidence.healthOk != null
                      ? ` · health ${view.run.evidence.healthOk ? 'ok' : 'failing'}`
                      : ''}
                  </Text>
                )}
                {view.run.evidence.criteria.map((c, i) => (
                  <Text key={`${c.criterionId}-${i}`} style={styles.rowSmall}>
                    {c.passed ? '✓' : '✗'} {c.criterionId || 'criterion'}
                    {c.observed ? ` — ${c.observed}` : ''}
                    {c.artifactRef ? ` (${c.artifactRef})` : ''}
                    {c.claimedWithoutEvidence ? ' · claimed without evidence' : ''}
                  </Text>
                ))}
              </View>
            ) : (
              <Text style={styles.rowSmall} testID="autopilot-evidence-empty">
                Verification evidence: none captured yet.
              </Text>
            )}

            {view.run.documentation ? (
              <View style={styles.subSection} testID="autopilot-documentation">
                <Text style={styles.subTitle}>Documentation</Text>
                {view.run.documentation.expectedBenefit && (
                  <Text style={styles.rowSmall}>
                    Expected benefit: {view.run.documentation.expectedBenefit}
                  </Text>
                )}
                {view.run.documentation.actualChange && (
                  <Text style={styles.rowSmall}>
                    Actual change: {view.run.documentation.actualChange}
                  </Text>
                )}
                {view.run.documentation.outcome && (
                  <Text style={styles.rowSmall}>Outcome: {view.run.documentation.outcome}</Text>
                )}
                {view.run.documentation.nextAction && (
                  <Text style={styles.rowSmall}>Next: {view.run.documentation.nextAction}</Text>
                )}
                {view.run.documentation.links.map((l) => (
                  <Text
                    key={l.label}
                    style={styles.rowSmall}
                    testID={`autopilot-doc-link-${l.label}`}
                  >
                    {l.label}: {l.value}
                  </Text>
                ))}
                {(view.run.documentation.journalSlug ||
                  view.run.documentation.wikiSlugs.length > 0) && (
                  <Text style={styles.rowSmall}>
                    Pages:{' '}
                    {[view.run.documentation.journalSlug, ...view.run.documentation.wikiSlugs]
                      .filter(Boolean)
                      .join(', ')}
                  </Text>
                )}
                {view.run.documentation.evidenceRefs.length > 0 && (
                  <Text style={styles.rowSmall}>
                    Artifacts:{' '}
                    {view.run.documentation.evidenceRefs
                      .map((e) => `${e.kind}:${e.ref}`)
                      .join(', ')}
                  </Text>
                )}
              </View>
            ) : (
              <Text style={styles.rowSmall} testID="autopilot-documentation-empty">
                Documentation: none recorded yet.
              </Text>
            )}
            <Text style={styles.rowSmall} testID="autopilot-run-caveats">
              Evaluator scores reduce self-grading bias but do not prove product value or guarantee
              monotonic improvement. Recovery redeploys the last verified code artifact only. A code
              rollback is not a database rollback. See the operator runbook:
              docs/guides/experimental-autopilot.md.
            </Text>
          </View>
        )}

        {view && (
          <View style={styles.card} testID="autopilot-readiness">
            <Text style={styles.sectionTitle}>Readiness</Text>
            {view.readiness.map((item) => (
              <Text key={item.key} style={styles.row} testID={`autopilot-readiness-${item.key}`}>
                {item.ok ? '✓' : '✗'} {item.label} — {item.detail}
              </Text>
            ))}
          </View>
        )}

        {view && isAdmin && (
          <View style={styles.controlsRow} testID="autopilot-controls">
            {view.controls.canStart && (
              <ActionBtn
                testID="autopilot-start"
                label="Start"
                busy={busy === 'start'}
                disabled={mutating}
                onPress={() =>
                  runAction('start', () => api.startAutopilot(projectId), 'Autopilot started', {
                    apply: applyRunSnapshot,
                  })
                }
                variant="primary"
              />
            )}
            {view.controls.canPause && (
              <ActionBtn
                testID="autopilot-pause"
                label="Pause"
                busy={busy === 'pause'}
                disabled={mutating}
                onPress={() =>
                  runAction('pause', () => api.pauseAutopilot(projectId), 'Pause requested', {
                    apply: applyRunSnapshot,
                  })
                }
              />
            )}
            {view.controls.canResume && (
              <ActionBtn
                testID="autopilot-resume"
                label="Resume"
                busy={busy === 'resume'}
                disabled={mutating}
                onPress={() =>
                  runAction('resume', () => api.resumeAutopilot(projectId), 'Resumed', {
                    apply: applyRunSnapshot,
                  })
                }
              />
            )}
            {view.controls.isActive && (
              <TouchableOpacity
                testID="autopilot-stop"
                disabled={!view.controls.canStop || stopBusy}
                onPress={confirmStop}
                style={[
                  styles.dangerBtn,
                  (!view.controls.canStop || stopBusy) && styles.btnDisabled,
                ]}
              >
                <Text style={styles.dangerBtnText}>
                  {view.controls.stopping || stopBusy ? 'Stopping…' : 'Stop'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {view && isAdmin && (
          <View style={styles.card} testID="autopilot-setup">
            <Text style={styles.sectionTitle}>Setup</Text>
            <LabeledInput
              label="Product brief"
              value={form.brief}
              onChangeText={(v) => updateForm({ brief: v })}
              testID="autopilot-brief"
              multiline
            />
            <LabeledInput
              label="Target id (deploy.yaml env)"
              value={form.targetId}
              onChangeText={(v) => updateForm({ targetId: v })}
              testID="autopilot-target-id"
            />
            <LabeledInput
              label="Loopback origin"
              value={form.origin}
              onChangeText={(v) => updateForm({ origin: v })}
              testID="autopilot-origin"
            />
            <LabeledInput
              label="Readiness probe URL"
              value={form.readinessProbeUrl}
              onChangeText={(v) => updateForm({ readinessProbeUrl: v })}
              testID="autopilot-readiness-url"
            />
            <Text style={styles.retentionLabel}>Cycle mode</Text>
            <View style={styles.chipRow}>
              {(['continuous', 'finite'] as const).map((mode) => {
                const selected = form.cycleMode === mode;
                return (
                  <TouchableOpacity
                    key={mode}
                    testID={`autopilot-cycle-${mode}`}
                    onPress={() => updateForm({ cycleMode: mode })}
                    style={[styles.chip, selected && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextActive]}>{mode}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {form.cycleMode === 'finite' && (
              <LabeledInput
                label="Max cycles"
                value={form.maxCycles}
                onChangeText={(v) => updateForm({ maxCycles: v })}
                testID="autopilot-max-cycles"
                keyboardType="numeric"
              />
            )}
            <LabeledInput
              label="Wall-time budget (hours)"
              value={form.maxWallTimeHours}
              onChangeText={(v) => updateForm({ maxWallTimeHours: v })}
              testID="autopilot-wall-time"
              keyboardType="numeric"
            />
            <LabeledInput
              label="Per-stage timeout (minutes)"
              value={form.maxStageTimeoutMinutes}
              onChangeText={(v) => updateForm({ maxStageTimeoutMinutes: v })}
              testID="autopilot-stage-timeout"
              keyboardType="numeric"
            />
            <LabeledInput
              label="Retries per stage (0-2)"
              value={form.maxRetriesPerStage}
              onChangeText={(v) => updateForm({ maxRetriesPerStage: v })}
              testID="autopilot-retries"
              keyboardType="numeric"
            />
            <LabeledInput
              label="Cost cap (USD, optional)"
              value={form.maxCostUsd}
              onChangeText={(v) => updateForm({ maxCostUsd: v })}
              testID="autopilot-cost-cap"
              keyboardType="numeric"
            />
            <LabeledInput
              label="Credential owner (user id)"
              value={form.credentialOwnerUserId}
              onChangeText={(v) => updateForm({ credentialOwnerUserId: v })}
              testID="autopilot-credential-owner"
            />
            <Text style={styles.retentionLabel}>Worker isolation</Text>
            <View style={styles.chipRow}>
              {AUTOPILOT_ISOLATION_ADAPTERS.map((adapter) => {
                const selected = form.isolationAdapter === adapter;
                return (
                  <TouchableOpacity
                    key={adapter}
                    testID={`autopilot-isolation-${adapter}`}
                    onPress={() =>
                      updateForm(
                        adapter === 'host'
                          ? { isolationAdapter: adapter }
                          : { isolationAdapter: adapter, hostAdapterAck: false },
                      )
                    }
                    style={[styles.chip, selected && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextActive]}>
                      {adapter === 'auto' ? 'auto (isolated)' : adapter}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {form.isolationAdapter === 'host' && (
              <View style={styles.hostWarning} testID="autopilot-host-warning">
                <Text style={styles.hostWarningText}>
                  Autopilot will run unattended on the host with no isolation boundary. It can read
                  and write anything the server process can. Only enable this on a machine you own
                  and trust.
                </Text>
                <TouchableOpacity
                  testID="autopilot-host-ack"
                  onPress={() => updateForm({ hostAdapterAck: !form.hostAdapterAck })}
                  style={styles.ackRow}
                >
                  <View style={[styles.checkbox, form.hostAdapterAck && styles.checkboxChecked]}>
                    {form.hostAdapterAck && <Text style={styles.checkboxMark}>✓</Text>}
                  </View>
                  <Text style={styles.ackText}>
                    Are you sure? I understand and want to run Autopilot on the host.
                  </Text>
                </TouchableOpacity>
              </View>
            )}
            <TouchableOpacity
              testID="autopilot-save-config"
              disabled={mutating}
              onPress={() => saveConfig()}
              style={[styles.secondaryBtn, mutating && styles.btnDisabled]}
            >
              <Text style={styles.secondaryBtnText}>Save configuration</Text>
            </TouchableOpacity>
          </View>
        )}

        {view && !isAdmin && (
          <Text style={styles.hint} testID="autopilot-readonly">
            You have read-only access. An Admin manages configuration and run controls.
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionBtn({
  testID,
  label,
  busy,
  disabled,
  onPress,
  variant = 'default',
}: {
  testID: string;
  label: string;
  busy: boolean;
  disabled?: boolean;
  onPress: () => void;
  variant?: 'primary' | 'default' | 'ghost';
}) {
  const style =
    variant === 'primary'
      ? styles.primaryBtnInline
      : variant === 'ghost'
        ? styles.ghostBtn
        : styles.secondaryBtnInline;
  const textStyle =
    variant === 'primary'
      ? styles.primaryBtnText
      : variant === 'ghost'
        ? styles.ghostBtnText
        : styles.secondaryBtnText;
  const isDisabled = busy || disabled;
  return (
    <TouchableOpacity
      testID={testID}
      disabled={isDisabled}
      onPress={onPress}
      style={[style, isDisabled && styles.btnDisabled]}
    >
      <Text style={textStyle}>{label}</Text>
    </TouchableOpacity>
  );
}

function LabeledInput({
  label,
  value,
  onChangeText,
  testID,
  multiline,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  testID: string;
  multiline?: boolean;
  keyboardType?: any;
}) {
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={styles.retentionSub}>{label}</Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        keyboardType={keyboardType}
        placeholderTextColor={colors.gray500}
        style={[styles.input, multiline && { minHeight: 60 }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32 },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 6,
  },
  hint: { fontSize: 12, color: colors.gray500, marginBottom: 8 },
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  warnInline: { fontSize: 12, color: colors.amber400, marginTop: 4 },
  row: { fontSize: 13, color: colors.gray300, marginBottom: 4 },
  rowSmall: { fontSize: 12, color: colors.gray300, marginBottom: 3 },
  subSection: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  subTitle: { fontSize: 13, color: colors.gray200, fontWeight: '600', marginBottom: 4 },
  error: { fontSize: 13, color: colors.red400, marginTop: 6 },
  input: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 10,
    color: colors.white,
    fontSize: 14,
    marginTop: 4,
  },
  primaryBtn: {
    backgroundColor: colors.purple900_40,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: { color: colors.purple400, fontWeight: '600' },
  secondaryBtn: {
    marginTop: 8,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
  },
  secondaryBtnText: { color: colors.gray300 },
  btnDisabled: { opacity: 0.5 },
  controlsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  primaryBtnInline: {
    backgroundColor: colors.purple900_40,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  secondaryBtnInline: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  ghostBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  ghostBtnText: { color: colors.gray300 },
  dangerBtn: {
    backgroundColor: colors.red900_50,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  dangerBtnText: { color: colors.red400, fontWeight: '600' },
  retentionLabel: { fontSize: 13, color: colors.gray200, fontWeight: '600', marginTop: 12 },
  retentionSub: { fontSize: 11, color: colors.gray500, marginTop: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  chipActive: { backgroundColor: colors.purple900_40, borderColor: colors.purple500 },
  chipText: { color: colors.gray300, fontSize: 13 },
  chipTextActive: { color: colors.purple400 },
  hostWarning: {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amber400,
    backgroundColor: colors.amber900_40,
  },
  hostWarningText: { color: colors.amber400, fontSize: 12, marginBottom: 8 },
  ackRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.amber400,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked: { backgroundColor: colors.amber900_40 },
  checkboxMark: { color: colors.amber400, fontSize: 12, fontWeight: '700' },
  ackText: { color: colors.amber400, fontSize: 12, flex: 1 },
});
