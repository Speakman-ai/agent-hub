import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { formatDateTime } from '../utils/time';
import {
  autoRerunDescription,
  caseEditPatch,
  caseListLockReason,
  caseVerdictLabel,
  moveCaseIds,
  parseMaxIterations,
  qaEventMatches,
  QA_RERUN_DELAY_OPTIONS,
  QA_STATUS_LABELS,
  rerunButtonStates,
  runDuration,
  RUN_STATUS_COLORS,
  VERDICT_COLORS,
  type QaCase,
  type QaCaseDraft,
  type QaAutoRerunTrigger,
  type QaPlanDetail,
  type QaPlanPatch,
  type QaRun,
  type QaRunScope,
} from '../utils/qa';
import QaRunResults from './QaRunResults';

export interface QaLinkHandlers {
  onOpenEpic?: (epicId: string) => void;
  onOpenCard?: (cardId: string) => void;
}

/** Ask before a destructive or state-changing action. Resolves true on confirm. */
function confirm(title: string, message: string, confirmLabel = 'Continue'): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, onPress: () => resolve(true) },
    ]);
  });
}

export function QaLinkChips({
  epic,
  card,
  onOpenEpic,
  onOpenCard,
}: {
  epic: { id: string; name: string } | null;
  card: { id: string; title: string } | null;
} & QaLinkHandlers) {
  if (!epic && !card) return null;
  return (
    <View style={styles.linkChips}>
      {epic ? (
        <TouchableOpacity
          style={styles.linkChip}
          disabled={!onOpenEpic}
          onPress={() => onOpenEpic?.(epic.id)}
          testID="qa-link-epic"
        >
          <Text style={styles.linkChipText} numberOfLines={1}>
            Epic: {epic.name}
          </Text>
        </TouchableOpacity>
      ) : null}
      {card ? (
        <TouchableOpacity
          style={styles.linkChip}
          disabled={!onOpenCard}
          onPress={() => onOpenCard?.(card.id)}
          testID="qa-link-card"
        >
          <Text style={styles.linkChipText} numberOfLines={1}>
            Card: {card.title}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
  tone = 'secondary',
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'secondary' | 'success';
  testID?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      style={[
        styles.button,
        tone === 'primary' && styles.buttonPrimary,
        tone === 'success' && styles.buttonSuccess,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, tone !== 'secondary' && styles.buttonTextStrong]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function CaseForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: QaCaseDraft;
  submitLabel: string;
  busy: boolean;
  /** `base` is the case text when the form opened; refreshes while editing never change it. */
  onSubmit: (values: QaCaseDraft, base: QaCaseDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [base] = useState<QaCaseDraft>(initial);
  const [values, setValues] = useState<QaCaseDraft>(initial);
  const set = (field: keyof QaCaseDraft, v: string) => setValues((cur) => ({ ...cur, [field]: v }));
  return (
    <View style={styles.caseForm} testID="qa-case-form">
      <TextInput
        style={styles.input}
        placeholder="What is being checked"
        placeholderTextColor={colors.gray600}
        value={values.title}
        editable={!busy}
        onChangeText={(v) => set('title', v)}
      />
      <TextInput
        style={[styles.input, styles.multiline]}
        placeholder="1. Open …"
        placeholderTextColor={colors.gray600}
        multiline
        value={values.steps}
        editable={!busy}
        onChangeText={(v) => set('steps', v)}
      />
      <TextInput
        style={[styles.input, styles.multiline]}
        placeholder="What you should see"
        placeholderTextColor={colors.gray600}
        multiline
        value={values.expected}
        editable={!busy}
        onChangeText={(v) => set('expected', v)}
      />
      <View style={styles.row}>
        <Button
          label={submitLabel}
          tone="primary"
          disabled={busy || !values.title.trim()}
          onPress={() => void onSubmit(values, base)}
        />
        <Button label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

function CaseRow({
  qaCase,
  index,
  count,
  editable,
  busy,
  onEdit,
  onDelete,
  onMove,
}: {
  qaCase: QaCase;
  index: number;
  count: number;
  editable: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const latest = qaCase.latestVerdict ?? null;
  return (
    <View style={styles.caseRow} testID={`qa-case-row-${qaCase.id}`}>
      <View style={styles.caseHead}>
        <Text style={styles.caseIndex}>{index + 1}</Text>
        <Text style={styles.caseTitle}>
          {qaCase.title}
          {qaCase.version > 1 ? <Text style={styles.muted}> v{qaCase.version}</Text> : null}
        </Text>
      </View>
      {qaCase.steps ? <Text style={styles.caseSteps}>{qaCase.steps}</Text> : null}
      <Text style={styles.caseExpected}>
        <Text style={styles.muted}>Expected: </Text>
        {qaCase.expected || 'None given'}
      </Text>
      <Text
        testID="qa-verdict"
        style={[
          styles.caseVerdict,
          { color: latest ? VERDICT_COLORS[latest.verdict] : colors.gray500 },
          latest && !latest.current ? styles.stale : null,
        ]}
      >
        {caseVerdictLabel(latest)}
      </Text>
      {editable ? (
        <View style={styles.row}>
          <Button
            label={'↑'}
            disabled={busy || index === 0}
            onPress={() => onMove(-1)}
            testID="qa-case-up"
          />
          <Button
            label={'↓'}
            disabled={busy || index === count - 1}
            onPress={() => onMove(1)}
            testID="qa-case-down"
          />
          <Button label="Edit" disabled={busy} onPress={onEdit} testID="qa-case-edit" />
          <Button label="Delete" disabled={busy} onPress={onDelete} testID="qa-case-delete" />
        </View>
      ) : null}
    </View>
  );
}

function RunRow({
  run,
  cases,
  expanded,
  onToggle,
  onOpenSession,
  onOpenCard,
}: {
  run: QaRun;
  cases: QaCase[];
  expanded: boolean;
  onToggle: () => void;
  onOpenSession?: (agentId: string | null, sessionId: string) => void;
  onOpenCard?: (cardId: string) => void;
}) {
  const duration = runDuration(run);
  const resultCount = run.results?.length ?? 0;
  return (
    <View style={styles.runRow} testID={`qa-run-row-${run.id}`}>
      <TouchableOpacity onPress={onToggle} style={styles.runHead} testID="qa-run-toggle">
        <Text style={styles.runTitle}>
          {expanded ? '▾' : '▸'} Run {run.iteration}
        </Text>
        <Text style={styles.muted}>{run.scope === 'failed_only' ? 'Failed only' : 'Full'}</Text>
        <Text style={{ fontSize: 12, color: RUN_STATUS_COLORS[run.status] }}>{run.status}</Text>
        <Text style={styles.muted}>
          {resultCount} result{resultCount === 1 ? '' : 's'}
        </Text>
      </TouchableOpacity>
      <View style={styles.runMeta}>
        <Text style={styles.muted}>
          {run.startedAt ? `Started ${formatDateTime(run.startedAt)}` : 'Not started'}
          {duration ? ` · ${duration}${run.finishedAt ? '' : ' so far'}` : ''}
        </Text>
        {run.sessionId && run.sessionAgentId ? (
          <TouchableOpacity
            testID="qa-run-session"
            disabled={!onOpenSession}
            onPress={() => onOpenSession?.(run.sessionAgentId, run.sessionId!)}
          >
            <Text style={styles.link}>Session</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {expanded ? <QaRunResults run={run} cases={cases} onOpenCard={onOpenCard} /> : null}
    </View>
  );
}

const namesFrom = (list: unknown): string[] =>
  (Array.isArray(list) ? list : [])
    .map((e: any) => e?.name)
    .filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);

/**
 * Picker options loaded once per `key` (null skips the load). A failed load
 * leaves only the saved value selectable.
 */
function useNames(key: string | null, load: (key: string) => Promise<string[]>) {
  const [names, setNames] = useState<string[]>([]);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (key === null) return;
    let live = true;
    Promise.resolve()
      .then(() => loadRef.current(key))
      .then((next) => {
        if (live) setNames(next);
      })
      .catch(() => {
        if (live) setNames([]);
      });
    return () => {
      live = false;
    };
  }, [key]);
  return names;
}

function withCurrent(names: string[], current: string | null): string[] {
  return current && !names.includes(current) ? [current, ...names] : names;
}

function ChipRow<T extends string | number | null>({
  testID,
  options,
  value,
  busy,
  label,
  onPick,
}: {
  testID: string;
  options: T[];
  value: T;
  busy: boolean;
  label: (option: T) => string;
  onPick: (option: T) => void;
}) {
  return (
    <View style={styles.chips} testID={testID}>
      {options.map((option) => {
        const selected = value === option;
        return (
          <TouchableOpacity
            key={String(option ?? '__none')}
            testID={`${testID}-${String(option ?? 'none')}`}
            disabled={busy || selected}
            onPress={() => onPick(option)}
            style={[styles.chip, selected && styles.chipSelected]}
          >
            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
              {label(option)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function RerunSettings({
  projectId,
  detail,
  busy,
  onSave,
}: {
  projectId: string;
  detail: QaPlanDetail;
  busy: boolean;
  onSave: (patch: QaPlanPatch) => void;
}) {
  const { plan } = detail;
  const trigger: QaAutoRerunTrigger = plan.autoRerunTrigger ?? 'deployment';
  const [maxDraft, setMaxDraft] = useState(String(plan.maxIterations));
  useEffect(() => setMaxDraft(String(plan.maxIterations)), [plan.maxIterations]);
  const environments = useNames(projectId, async (id) =>
    namesFrom(((await api.getDeployEnvironments(id)) as any)?.environments),
  );
  const branches = useNames(trigger === 'merge' ? projectId : null, async (id) =>
    namesFrom(((await api.getProjectBranches(id)) as any)?.branches),
  );
  const envOptions = withCurrent(environments, plan.deployEnvironment);
  const branchOptions = withCurrent(branches, plan.autoRerunBranch ?? null);
  const delay = plan.autoRerunDelayMinutes ?? 0;
  const delayOptions = QA_RERUN_DELAY_OPTIONS.includes(delay)
    ? QA_RERUN_DELAY_OPTIONS
    : [...QA_RERUN_DELAY_OPTIONS, delay].sort((a, b) => a - b);
  const saveMax = () => {
    const n = parseMaxIterations(maxDraft);
    if (n === null) {
      setMaxDraft(String(plan.maxIterations));
      return;
    }
    if (n !== plan.maxIterations) onSave({ maxIterations: n });
  };
  return (
    <View style={styles.settings} testID="qa-rerun-settings">
      <View style={styles.settingRow}>
        <Text style={styles.settingLabel}>Auto-rerun when fixes land</Text>
        <Switch
          testID="qa-auto-rerun-toggle"
          value={plan.autoRerun}
          disabled={busy}
          onValueChange={(v) => onSave({ autoRerun: v })}
        />
      </View>
      <Text style={styles.settingLabel}>Trigger</Text>
      <ChipRow<QaAutoRerunTrigger>
        testID="qa-auto-rerun-trigger"
        options={['deployment', 'merge']}
        value={trigger}
        busy={busy}
        label={(t) => (t === 'merge' ? 'Merge to branch' : 'Deployment')}
        onPick={(t) => onSave({ autoRerunTrigger: t })}
      />
      {trigger === 'deployment' ? (
        <>
          <Text style={styles.settingLabel}>Deploy environment</Text>
          <ChipRow<string | null>
            testID="qa-deploy-environment"
            options={[null, ...envOptions]}
            value={plan.deployEnvironment ?? null}
            busy={busy}
            label={(name) => name ?? 'None (rerun by hand)'}
            onPick={(name) => onSave({ deployEnvironment: name })}
          />
        </>
      ) : (
        <>
          <Text style={styles.settingLabel}>Branch</Text>
          <ChipRow<string | null>
            testID="qa-auto-rerun-branch"
            options={[null, ...branchOptions]}
            value={plan.autoRerunBranch ?? null}
            busy={busy}
            label={(name) => name ?? 'None (rerun by hand)'}
            onPick={(name) => onSave({ autoRerunBranch: name })}
          />
          <Text style={styles.settingLabel}>Delay</Text>
          <ChipRow<number>
            testID="qa-auto-rerun-delay"
            options={delayOptions}
            value={delay}
            busy={busy}
            label={(m) => (m === 0 ? 'None' : `${m} min`)}
            onPick={(m) => onSave({ autoRerunDelayMinutes: m })}
          />
        </>
      )}
      <View style={styles.settingRow}>
        <Text style={styles.settingLabel}>Max runs</Text>
        <TextInput
          testID="qa-max-iterations"
          style={[styles.input, styles.maxInput]}
          keyboardType="number-pad"
          value={maxDraft}
          editable={!busy}
          onChangeText={setMaxDraft}
          onBlur={saveMax}
          onSubmitEditing={saveMax}
        />
      </View>
      <Text style={styles.muted}>{autoRerunDescription(plan)}</Text>
      {detail.autoRerun ? (
        <Text style={styles.notice} testID="qa-auto-rerun-status">
          {detail.autoRerun.message}
        </Text>
      ) : null}
    </View>
  );
}

export interface QaPlanDetailViewProps extends QaLinkHandlers {
  projectId: string;
  planId: string;
  /** Message from the list, e.g. the authoring chat failed to open after create. */
  notice?: string | null;
  onOpenSession?: (agentId: string | null, sessionId: string) => void;
}

export default function QaPlanDetailView({
  projectId,
  planId,
  notice,
  onOpenEpic,
  onOpenCard,
  onOpenSession,
}: QaPlanDetailViewProps) {
  const { subscribeQaUpdates } = useApp();
  const [detail, setDetail] = useState<QaPlanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toggledRuns, setToggledRuns] = useState<Record<string, boolean>>({});
  const requestSeq = useRef(0);

  // Newest-wins: a slow response for an older refresh never overwrites newer data.
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const data = await api.getQaPlan(projectId, planId);
      if (seq !== requestSeq.current) return;
      setDetail(data);
      setError(null);
    } catch (e: any) {
      if (seq !== requestSeq.current) return;
      setError(e?.message || 'Failed to load QA plan');
    }
  }, [projectId, planId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    void load();
    return () => {
      requestSeq.current += 1;
    };
  }, [load]);

  useEffect(
    () =>
      subscribeQaUpdates?.((event: any) => {
        if (qaEventMatches(event, projectId, planId)) void load();
      }),
    [subscribeQaUpdates, load, projectId, planId],
  );

  /** Run one mutation, then refresh. Returns false (with the error shown) on failure. */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e: any) {
      setActionError(e?.message || 'Request failed');
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openChat = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const { agentId, sessionId } = await api.openQaAuthoringSession(projectId, planId);
      onOpenSession?.(agentId, sessionId);
    } catch (e: any) {
      setActionError(e?.message || 'Failed to open the QA chat');
    } finally {
      setBusy(false);
    }
  };

  const plan = detail?.plan;
  const messages = [notice, error, actionError].filter((m): m is string => !!m);

  if (!detail || !plan) {
    return (
      <View style={styles.center}>
        {messages.map((m) => (
          <Text key={m} style={styles.errorBox} testID="qa-detail-error">
            {m}
          </Text>
        ))}
        {!error ? <ActivityIndicator color={colors.gray400} /> : null}
      </View>
    );
  }

  const lockReason = caseListLockReason(detail);
  const editable = lockReason === null;
  const runStates = rerunButtonStates(detail);

  const confirmApprovalLoss = async () =>
    !plan.approved ||
    confirm('Revoke approval?', 'This plan is approved. Changing its cases revokes approval.');

  const addCase = async (values: QaCaseDraft) => {
    if (!(await confirmApprovalLoss())) return;
    const ok = await act(() =>
      api.addQaCase(projectId, planId, { ...values, title: values.title.trim() }),
    );
    if (ok) setAdding(false);
  };

  // Diff against the text the form opened with, not the latest refresh, so a
  // concurrent edit shows up as a server-side conflict instead of being overwritten.
  const editCase = async (c: QaCase, values: QaCaseDraft, base: QaCaseDraft) => {
    const edit = caseEditPatch(base, values);
    if (!edit) {
      setEditingId(null);
      return;
    }
    if (!(await confirmApprovalLoss())) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.updateQaCase(projectId, planId, c.id, {
        ...edit.patch,
        expectedBase: edit.expectedBase,
      });
      setEditingId(null);
    } catch (e: any) {
      setActionError(
        e?.code === 'edit_conflict'
          ? `"${c.title}" changed while you were editing. Reopen it to see the new text.`
          : e?.message || 'Request failed',
      );
      if (e?.code === 'edit_conflict') setEditingId(null);
    } finally {
      await load();
      setBusy(false);
    }
  };

  const deleteCase = async (c: QaCase) => {
    const ok = await confirm(
      'Delete case?',
      plan.approved
        ? `Delete "${c.title}"? This revokes the plan's approval.`
        : `Delete "${c.title}"?`,
      'Delete',
    );
    if (ok) void act(() => api.deleteQaCase(projectId, planId, c.id));
  };

  const moveCase = (index: number, delta: -1 | 1) => {
    const ids = moveCaseIds(
      detail.cases.map((c) => c.id),
      index,
      delta,
    );
    if (ids) void act(() => api.reorderQaCases(projectId, planId, ids));
  };

  const startRun = async (scope: QaRunScope) => {
    if (
      plan.status === 'done' &&
      !(await confirm('Reopen plan?', 'Starting a run reopens this signed-off plan.'))
    ) {
      return;
    }
    void act(() => api.startQaRun(projectId, planId, scope));
  };

  const signOff = async () => {
    if (await confirm('Sign off?', 'Sign off this plan and move it to Done?', 'Sign off')) {
      void act(() => api.signOffQaPlan(projectId, planId));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container} testID="qa-plan-detail">
      {messages.map((m) => (
        <Text key={m} style={styles.errorBox} testID="qa-detail-error">
          {m}
        </Text>
      ))}

      <Text style={styles.planTitle}>{plan.title}</Text>
      <View style={styles.badges}>
        <Text style={styles.badge} testID="qa-detail-status">
          {QA_STATUS_LABELS[plan.status]}
        </Text>
        <Text
          style={[styles.badge, plan.approved ? styles.badgeGood : styles.badgeWarn]}
          testID="qa-detail-approval"
        >
          {plan.approved ? 'Approved' : 'Not approved'}
        </Text>
        {plan.signedOffAt ? (
          <Text style={[styles.badge, styles.badgeGood]} testID="qa-detail-signed-off">
            Signed off {formatDateTime(plan.signedOffAt)}
          </Text>
        ) : null}
      </View>

      <View style={styles.row}>
        {plan.status === 'in_progress' ? (
          <Button
            label="Sign off"
            tone="success"
            testID="qa-sign-off"
            disabled={busy || detail.signOffBlocker !== null}
            onPress={() => void signOff()}
          />
        ) : null}
        <Button
          label={plan.authoringSessionId ? 'Open QA chat' : 'Draft cases with QA agent'}
          testID="qa-open-chat"
          disabled={busy}
          onPress={() => void openChat()}
        />
        {editable ? (
          plan.approved ? (
            <Button
              label="Revoke approval"
              testID="qa-revoke-approval"
              disabled={busy}
              onPress={() => void act(() => api.revokeQaPlanApproval(projectId, planId))}
            />
          ) : (
            <Button
              label="Approve"
              tone="success"
              testID="qa-approve"
              disabled={busy || detail.cases.length === 0}
              onPress={() => void act(() => api.approveQaPlan(projectId, planId))}
            />
          )
        ) : null}
      </View>

      <TouchableOpacity
        onPress={() => void Linking.openURL(plan.targetUrl).catch(() => undefined)}
        testID="qa-detail-target"
      >
        <Text style={styles.link} numberOfLines={1}>
          {plan.targetUrl} {'↗'}
        </Text>
      </TouchableOpacity>
      <QaLinkChips
        epic={detail.links.epic}
        card={detail.links.card}
        onOpenEpic={onOpenEpic}
        onOpenCard={onOpenCard}
      />
      {plan.goal ? <Text style={styles.goal}>{plan.goal}</Text> : null}

      {!plan.approved ? (
        <Text style={styles.warnBox} testID="qa-detail-unapproved">
          This plan is not approved. Cases can still change, and runs are refused until a human
          approves the case list.
        </Text>
      ) : null}
      {plan.approved && editable ? (
        <Text style={styles.muted}>
          Approved: the case list is locked for runs. Editing, adding, or deleting a case revokes
          approval, and an edited case gets a new version.
        </Text>
      ) : null}
      {plan.status === 'in_progress' ? (
        <Text style={styles.muted} testID="qa-detail-sign-off-note">
          {detail.signOffBlocker === null
            ? 'The latest run passed every case. Validate the target by hand, then sign off to move the plan to Done.'
            : `Sign-off opens once the latest run passes every case. ${detail.signOffBlocker}.`}
        </Text>
      ) : null}
      {lockReason ? (
        <Text style={styles.muted} testID="qa-detail-locked">
          Cases are read-only. {lockReason}
        </Text>
      ) : null}

      <Text style={styles.sectionTitle}>
        Cases <Text style={styles.muted}>{detail.cases.length}</Text>
      </Text>
      {detail.cases.length === 0 ? (
        <Text style={styles.muted} testID="qa-cases-empty">
          No cases yet. The QA agent proposes cases in the plan&apos;s chat
          {plan.approved ? '.' : '; approve the plan once the list looks right.'}
        </Text>
      ) : (
        <View style={styles.box}>
          {detail.cases.map((c, i) =>
            editingId === c.id ? (
              <CaseForm
                key={c.id}
                initial={{ title: c.title, steps: c.steps, expected: c.expected }}
                submitLabel="Save"
                busy={busy}
                onSubmit={(values, base) => editCase(c, values, base)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <CaseRow
                key={c.id}
                qaCase={c}
                index={i}
                count={detail.cases.length}
                editable={editable}
                busy={busy}
                onEdit={() => setEditingId(c.id)}
                onDelete={() => void deleteCase(c)}
                onMove={(delta) => moveCase(i, delta)}
              />
            ),
          )}
        </View>
      )}
      {editable && !adding ? (
        <TouchableOpacity onPress={() => setAdding(true)} testID="qa-case-add">
          <Text style={styles.link}>+ Add case</Text>
        </TouchableOpacity>
      ) : null}
      {adding ? (
        <View style={styles.box}>
          <CaseForm
            initial={{ title: '', steps: '', expected: '' }}
            submitLabel="Add case"
            busy={busy}
            onSubmit={addCase}
            onCancel={() => setAdding(false)}
          />
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>Run history</Text>
      <View style={styles.row}>
        {detail.runs.length === 0 ? (
          <Button
            label="Start run"
            tone="primary"
            testID="qa-start-run"
            disabled={busy || !runStates.full.enabled}
            onPress={() => void startRun('full')}
          />
        ) : (
          <>
            <Button
              label="Rerun failed"
              tone="primary"
              testID="qa-rerun-failed"
              disabled={busy || !runStates.failedOnly.enabled}
              onPress={() => void startRun('failed_only')}
            />
            <Button
              label="Rerun full"
              testID="qa-rerun-full"
              disabled={busy || !runStates.full.enabled}
              onPress={() => void startRun('full')}
            />
          </>
        )}
      </View>
      {!runStates.full.enabled ? <Text style={styles.muted}>{runStates.full.title}</Text> : null}
      <RerunSettings
        projectId={projectId}
        detail={detail}
        busy={busy}
        onSave={(patch) => void act(() => api.updateQaPlan(projectId, planId, patch))}
      />
      {detail.runs.length === 0 ? (
        <Text style={styles.muted} testID="qa-runs-empty">
          No runs yet.{' '}
          {plan.approved
            ? 'Start a run to record a verdict for each case.'
            : 'Runs start once the plan is approved.'}
        </Text>
      ) : (
        <View style={styles.box} testID="qa-run-list">
          {detail.runs.map((r, i) => {
            const expanded = toggledRuns[r.id] ?? i === 0;
            return (
              <RunRow
                key={r.id}
                run={r}
                cases={detail.cases}
                expanded={expanded}
                onToggle={() => setToggledRuns((cur) => ({ ...cur, [r.id]: !expanded }))}
                onOpenSession={onOpenSession}
                onOpenCard={onOpenCard}
              />
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 14, gap: 10, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 10 },
  planTitle: { fontSize: 18, fontWeight: '600', color: colors.gray100 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: {
    fontSize: 11,
    color: colors.gray300,
    backgroundColor: colors.gray800,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  badgeGood: { color: colors.emerald300, backgroundColor: colors.emerald900_40 },
  badgeWarn: { color: colors.amber400, backgroundColor: colors.amber900_40 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  button: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  buttonPrimary: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  buttonSuccess: { backgroundColor: colors.emerald700, borderColor: colors.emerald700 },
  buttonText: { fontSize: 12, color: colors.gray300 },
  buttonTextStrong: { color: colors.white },
  disabled: { opacity: 0.5 },
  link: { fontSize: 13, color: colors.blue400 },
  goal: { fontSize: 13, color: colors.gray400 },
  muted: { fontSize: 12, color: colors.gray500 },
  stale: { fontStyle: 'italic' },
  errorBox: {
    fontSize: 13,
    color: colors.red400,
    backgroundColor: colors.red900_50,
    borderRadius: 6,
    padding: 10,
  },
  warnBox: {
    fontSize: 13,
    color: colors.amber400,
    backgroundColor: colors.amber900_40,
    borderRadius: 6,
    padding: 10,
  },
  notice: {
    fontSize: 12,
    color: colors.gray300,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 6,
    padding: 8,
  },
  sectionTitle: { fontSize: 14, fontWeight: '500', color: colors.gray300, marginTop: 8 },
  box: { borderWidth: 1, borderColor: colors.gray800, borderRadius: 8, overflow: 'hidden' },
  caseRow: {
    padding: 10,
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  caseHead: { flexDirection: 'row', gap: 8 },
  caseIndex: { fontSize: 13, color: colors.gray500 },
  caseTitle: { fontSize: 14, color: colors.gray100, flexShrink: 1 },
  caseSteps: { fontSize: 12, color: colors.gray500 },
  caseExpected: { fontSize: 12, color: colors.gray400 },
  caseVerdict: { fontSize: 12 },
  caseForm: { padding: 10, gap: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray950,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 14,
    color: colors.gray100,
  },
  multiline: { minHeight: 56, textAlignVertical: 'top' },
  maxInput: { width: 60, textAlign: 'center' },
  settings: { gap: 6 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingLabel: { fontSize: 12, color: colors.gray400 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipSelected: { borderColor: colors.blue500, backgroundColor: colors.blue900_40 },
  chipText: { fontSize: 12, color: colors.gray300 },
  chipTextSelected: { color: colors.blue300 },
  runRow: { borderBottomWidth: 1, borderBottomColor: colors.gray800 },
  runHead: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  runTitle: { fontSize: 14, color: colors.gray100 },
  runMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 8,
    paddingTop: 2,
  },
  linkChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  linkChip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    maxWidth: 220,
  },
  linkChipText: { fontSize: 11, color: colors.gray300 },
});
