import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import {
  api,
  type QaCaseInput,
  type QaCaseWire,
  type QaPlanDetailWire,
  type QaPlanPatch,
  type QaPlanWire,
  type QaRunWire,
} from '../utils/api';
import {
  QA_STATUS_LABELS,
  RUN_STATUS_CLASS,
  VERDICT_CLASS,
  VERDICT_LABELS,
} from '../utils/qaLabels';
import { formatDateTime, parseDate } from '../utils/time';
import Checkbox from './Checkbox';
import { LinkChips, type LinkProps } from './QaLinkChips';
import QaRunResults from './QaRunResults';

type LatestVerdict = QaCaseWire['latestVerdict'];

/**
 * Text for a case's latest verdict cell. A verdict recorded against an older
 * case version is still shown, but flagged so nobody reads it as current.
 */
export function caseVerdictLabel(latest: LatestVerdict): string {
  if (!latest) return 'Not run';
  const label = VERDICT_LABELS[latest.verdict];
  return latest.current
    ? `${label} (run ${latest.iteration})`
    : `${label} (run ${latest.iteration}, case edited since)`;
}

/** "3m 12s" style duration, or null when the run has not started. */
export function runDuration(run: QaRunWire, now: Date = new Date()): string | null {
  const start = parseDate(run.startedAt);
  if (!start || isNaN(start.getTime())) return null;
  const end = parseDate(run.finishedAt) ?? now;
  const totalSec = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function VerdictCell({ latest }: { latest: LatestVerdict }) {
  if (!latest) {
    return (
      <span className="text-gray-500" data-testid="qa-verdict">
        Not run
      </span>
    );
  }
  return (
    <span
      data-testid="qa-verdict"
      data-verdict={latest.verdict}
      data-current={latest.current ? 'true' : 'false'}
      title={caseVerdictLabel(latest)}
      className="inline-flex items-center gap-1.5"
    >
      <span
        className={latest.current ? VERDICT_CLASS[latest.verdict] : 'text-gray-500 line-through'}
      >
        {VERDICT_LABELS[latest.verdict]}
      </span>
      <span className="text-gray-500">run {latest.iteration}</span>
      {!latest.current && (
        <span className="rounded bg-gray-800 px-1 text-[10px] text-amber-300">stale</span>
      )}
    </span>
  );
}

/**
 * Why the case list cannot change right now, or null when it can. Mirrors the
 * server's freeze rule: signed-off plans and plans with a queued or running
 * run are frozen.
 */
export function caseListLockReason(detail: Pick<QaPlanDetailWire, 'plan' | 'runs'>): string | null {
  if (detail.plan.status === 'done') return 'Signed off. Start a run to reopen the plan.';
  const latest = detail.runs[0];
  if (latest && (latest.status === 'queued' || latest.status === 'running')) {
    return `Run ${latest.iteration} is ${latest.status}. Cancel it to edit cases.`;
  }
  return null;
}

export interface RerunButtonState {
  enabled: boolean;
  /** Tooltip: why the button is disabled, or what it does. */
  title: string;
}

/**
 * Whether a full run and a failed-only run can start, mirroring the server's
 * refusals: unapproved plans, an active run, and (failed-only) a plan where
 * every case already passed on its current version.
 */
export function rerunButtonStates(detail: Pick<QaPlanDetailWire, 'plan' | 'runs' | 'cases'>): {
  full: RerunButtonState;
  failedOnly: RerunButtonState;
} {
  const latest = detail.runs[0];
  let blocked: string | null = null;
  if (!detail.plan.approved) blocked = 'Approve the plan before running it';
  else if (detail.cases.length === 0) blocked = 'Add at least one case first';
  else if (latest && (latest.status === 'queued' || latest.status === 'running')) {
    blocked = `Run ${latest.iteration} is ${latest.status}`;
  }
  const failing = detail.cases.filter(
    (c) => !(c.latestVerdict?.verdict === 'pass' && c.latestVerdict.current),
  ).length;
  return {
    full: blocked
      ? { enabled: false, title: blocked }
      : { enabled: true, title: `Run all ${detail.cases.length} case(s) again` },
    failedOnly: blocked
      ? { enabled: false, title: blocked }
      : failing === 0
        ? { enabled: false, title: 'Every case passed on its current version' }
        : { enabled: true, title: `Run the ${failing} case(s) without a current pass` },
  };
}

/** `ids` with the item at `index` moved by `delta`, or null when it cannot move. */
export function moveCaseIds(ids: string[], index: number, delta: -1 | 1): string[] | null {
  const to = index + delta;
  if (index < 0 || index >= ids.length || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

type CaseDraft = Required<QaCaseInput>;

type CaseField = keyof CaseDraft;

/**
 * One field the user typed in: their text, and the saved value the field
 * showed when they started typing (the value their edit was made against).
 */
export interface CaseFieldEdit {
  value: string;
  base: string;
}

export type CaseFieldEdits = Partial<Record<CaseField, CaseFieldEdit>>;

/**
 * Record a keystroke. The base is captured on the first edit of a field, from
 * what the field displayed then, and kept for later keystrokes.
 */
export function applyCaseFieldEdit(
  edits: CaseFieldEdits,
  field: CaseField,
  value: string,
  displayed: CaseDraft,
): CaseFieldEdits {
  return { ...edits, [field]: { value, base: edits[field]?.base ?? displayed[field] } };
}

/**
 * The fields to send: those the user typed in whose text differs from the
 * text they started from. Untouched fields are never sent, so another
 * writer's change to them cannot be reverted. Null when nothing changed (so
 * no version bump).
 *
 * Conflicts are not judged here. The page's copy of the case can lag the
 * server, so the server checks each field's base inside the update (see
 * `caseEditExpectedBase`) and is the only judge of a conflict.
 */
export function planCaseSave(edits: CaseFieldEdits): QaCaseInput | null {
  const patch: QaCaseInput = {};
  for (const field of Object.keys(edits) as CaseField[]) {
    const edit = edits[field];
    if (!edit) continue;
    const value = field === 'title' ? edit.value.trim() : edit.value;
    if (value !== edit.base) patch[field] = value;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * After the server refuses a save, the fields that were sent now stand
 * against the text it returned, so a second Save overwrites deliberately.
 * Every other tracked field was typed back to its starting text (the form is
 * locked while a save is pending, so nothing else can be tracked); those are
 * dropped so they show the saved text again and are never sent.
 */
export function rebaseCaseFieldEdits(
  edits: CaseFieldEdits,
  saved: CaseDraft,
  sent: readonly CaseField[],
): CaseFieldEdits {
  const next: CaseFieldEdits = {};
  for (const field of sent) {
    const edit = edits[field];
    if (edit) next[field] = { value: edit.value, base: saved[field] };
  }
  return next;
}

/** A conflict carries the saved text and the fields that were sent. */
export type CaseSaveResult = 'saved' | 'failed' | { conflict: CaseDraft; sent: CaseField[] };

/** The saved case text from a server `edit_conflict` rejection, or null. */
export function editConflictCase(err: unknown): CaseDraft | null {
  const e = err as { code?: unknown; body?: { case?: unknown } } | null;
  if (e?.code !== 'edit_conflict') return null;
  const c = e.body?.case as Partial<CaseDraft> | undefined;
  if (
    !c ||
    typeof c.title !== 'string' ||
    typeof c.steps !== 'string' ||
    typeof c.expected !== 'string'
  ) {
    return null;
  }
  return { title: c.title, steps: c.steps, expected: c.expected };
}

/** The base text of each field in `patch`, sent as the server-side precondition. */
export function caseEditExpectedBase(edits: CaseFieldEdits, patch: QaCaseInput): QaCaseInput {
  const base: QaCaseInput = {};
  for (const field of Object.keys(patch) as CaseField[]) {
    const edit = edits[field];
    if (edit) base[field] = edit.base;
  }
  return base;
}

const fieldClass =
  'w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 focus:border-blue-500 focus:outline-none';

function CaseForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
  testId,
}: {
  /** Latest saved values; fields the user has not typed in follow them live. */
  initial: CaseDraft;
  submitLabel: string;
  busy: boolean;
  /** `edits` holds only the fields the user typed in; `values` is what the form shows. */
  onSubmit: (edits: CaseFieldEdits, values: CaseDraft) => Promise<CaseSaveResult>;
  onCancel: () => void;
  testId: string;
}) {
  const [edits, setEdits] = useState<CaseFieldEdits>({});
  // Locked from Save until the outcome is known. A successful save closes the
  // form, so anything typed meanwhile would be lost; a refused one is rebased
  // from exactly what was sent.
  const [submitting, setSubmitting] = useState(false);
  const values: CaseDraft = { ...initial };
  for (const field of Object.keys(edits) as CaseField[]) {
    const edit = edits[field];
    if (edit) values[field] = edit.value;
  }
  const edit = (field: CaseField, value: string) =>
    setEdits((e) => applyCaseFieldEdit(e, field, value, values));
  return (
    <form
      data-testid={testId}
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (submitting || !values.title.trim()) return;
        setSubmitting(true);
        try {
          const result = await onSubmit(edits, values);
          // The user was shown the conflict; a second Save overwrites deliberately.
          if (typeof result === 'object') {
            setEdits((cur) => rebaseCaseFieldEdits(cur, result.conflict, result.sent));
          }
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <fieldset
        disabled={submitting}
        data-testid="qa-case-form-fields"
        className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
      >
        <input
          aria-label="Case title"
          data-testid="qa-case-form-title"
          className={fieldClass}
          placeholder="What is being checked"
          value={values.title}
          onChange={(e) => edit('title', e.target.value)}
          autoFocus
        />
        <textarea
          aria-label="Steps"
          data-testid="qa-case-form-steps"
          className={`${fieldClass} min-h-[60px]`}
          placeholder="1. Open …"
          value={values.steps}
          onChange={(e) => edit('steps', e.target.value)}
        />
        <textarea
          aria-label="Expected result"
          data-testid="qa-case-form-expected"
          className={`${fieldClass} min-h-[40px]`}
          placeholder="What you should see"
          value={values.expected}
          onChange={(e) => edit('expected', e.target.value)}
        />
        <div className="flex gap-2">
          <button
            type="submit"
            data-testid="qa-case-form-save"
            disabled={busy || !values.title.trim()}
            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-60"
          >
            {submitLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-2.5 py-1 text-xs text-gray-400 hover:text-gray-200"
          >
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}

const iconButton =
  'rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-200 disabled:opacity-30 disabled:hover:bg-transparent';

function CaseTable({
  cases,
  approved,
  lockReason,
  busy,
  onAdd,
  onEdit,
  onDelete,
  onMove,
}: {
  cases: QaCaseWire[];
  approved: boolean;
  lockReason: string | null;
  busy: boolean;
  onAdd: (draft: CaseDraft) => Promise<boolean>;
  onEdit: (c: QaCaseWire, edits: CaseFieldEdits) => Promise<CaseSaveResult>;
  onDelete: (c: QaCaseWire) => void;
  onMove: (index: number, delta: -1 | 1) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const editable = lockReason === null;

  const addButton = editable && !adding && (
    <button
      type="button"
      data-testid="qa-case-add"
      onClick={() => setAdding(true)}
      className="inline-flex w-fit items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
    >
      <Plus size={12} />
      Add case
    </button>
  );
  const addForm = adding && (
    <div className="rounded-lg border border-gray-800 p-3">
      <CaseForm
        testId="qa-case-add-form"
        initial={{ title: '', steps: '', expected: '' }}
        submitLabel="Add case"
        busy={busy}
        onSubmit={async (_edits, values) => {
          const ok = await onAdd(values);
          if (ok) setAdding(false);
          return ok ? 'saved' : 'failed';
        }}
        onCancel={() => setAdding(false)}
      />
    </div>
  );

  if (cases.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-sm text-gray-500" data-testid="qa-cases-empty">
          No cases yet. The QA agent proposes cases in the plan&apos;s chat
          {approved ? '.' : '; approve the plan once the list looks right.'}
        </div>
        {addButton}
        {addForm}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-gray-800">
        <table className="w-full text-left text-sm" data-testid="qa-case-table">
          <thead className="border-b border-gray-800 text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2 font-normal">#</th>
              <th className="px-3 py-2 font-normal">Case</th>
              <th className="px-3 py-2 font-normal">Expected</th>
              <th className="px-3 py-2 font-normal">Latest verdict</th>
              {editable && (
                <th className="px-3 py-2 font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {cases.map((c, i) =>
              editingId === c.id ? (
                <tr
                  key={c.id}
                  data-testid={`qa-case-row-${c.id}`}
                  className="border-b border-gray-800"
                >
                  <td className="px-3 py-2 align-top text-gray-500">{i + 1}</td>
                  <td colSpan={editable ? 4 : 3} className="px-3 py-2">
                    <CaseForm
                      testId="qa-case-edit-form"
                      initial={{ title: c.title, steps: c.steps, expected: c.expected }}
                      submitLabel="Save"
                      busy={busy}
                      onSubmit={async (edits) => {
                        const result = await onEdit(c, edits);
                        if (result === 'saved') setEditingId(null);
                        return result;
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  </td>
                </tr>
              ) : (
                <tr
                  key={c.id}
                  data-testid={`qa-case-row-${c.id}`}
                  className="border-b border-gray-800 align-top last:border-b-0"
                >
                  <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                  <td className="px-3 py-2">
                    <div className="text-gray-100">
                      {c.title}
                      {c.version > 1 && (
                        <span className="ml-1.5 text-[10px] text-gray-500" title="Case version">
                          v{c.version}
                        </span>
                      )}
                    </div>
                    {c.steps && (
                      <div className="mt-0.5 whitespace-pre-wrap text-xs text-gray-500">
                        {c.steps}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-pre-wrap px-3 py-2 text-xs text-gray-400">
                    {c.expected || <span className="text-gray-600">None given</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <VerdictCell latest={c.latestVerdict ?? null} />
                  </td>
                  {editable && (
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          aria-label={`Move ${c.title} up`}
                          data-testid="qa-case-up"
                          className={iconButton}
                          disabled={busy || i === 0}
                          onClick={() => onMove(i, -1)}
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${c.title} down`}
                          data-testid="qa-case-down"
                          className={iconButton}
                          disabled={busy || i === cases.length - 1}
                          onClick={() => onMove(i, 1)}
                        >
                          <ArrowDown size={12} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Edit ${c.title}`}
                          data-testid="qa-case-edit"
                          className={iconButton}
                          disabled={busy}
                          onClick={() => setEditingId(c.id)}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${c.title}`}
                          data-testid="qa-case-delete"
                          className={`${iconButton} hover:text-red-400`}
                          disabled={busy}
                          onClick={() => onDelete(c)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {addButton}
      {addForm}
    </div>
  );
}

function RunButtons({
  detail,
  busy,
  onStart,
}: {
  detail: QaPlanDetailWire;
  busy: boolean;
  onStart: (scope: 'full' | 'failed_only') => void;
}) {
  const states = rerunButtonStates(detail);
  const button =
    'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs disabled:opacity-60';
  if (detail.runs.length === 0) {
    return (
      <button
        type="button"
        data-testid="qa-start-run"
        disabled={busy || !states.full.enabled}
        title={states.full.title}
        onClick={() => onStart('full')}
        className={`${button} bg-blue-600 text-white hover:bg-blue-500`}
      >
        <Play size={12} />
        Start run
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        data-testid="qa-rerun-failed"
        disabled={busy || !states.failedOnly.enabled}
        title={states.failedOnly.title}
        onClick={() => onStart('failed_only')}
        className={`${button} bg-blue-600 text-white hover:bg-blue-500`}
      >
        <RotateCcw size={12} />
        Rerun failed
      </button>
      <button
        type="button"
        data-testid="qa-rerun-full"
        disabled={busy || !states.full.enabled}
        title={states.full.title}
        onClick={() => onStart('full')}
        className={`${button} border border-gray-700 text-gray-300 hover:bg-gray-800`}
      >
        <RotateCcw size={12} />
        Rerun full
      </button>
    </div>
  );
}

/** Merge-trigger delay choices in minutes; the server accepts 0 or 5-60. */
export const QA_RERUN_DELAY_OPTIONS = [0, 5, 10, 15, 30, 45, 60];

const selectClass =
  'rounded-md border border-gray-700 bg-gray-950 px-1.5 py-0.5 text-xs text-gray-100';

/** Option names for a picker, keeping the saved value selectable when the list lacks it. */
function withCurrent(names: string[], current: string | null): string[] {
  return current && !names.includes(current) ? [current, ...names] : names;
}

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

const namesFrom = (list: unknown): string[] =>
  (Array.isArray(list) ? list : [])
    .map((e: { name?: unknown } | null) => e?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);

export function autoRerunSummary(
  plan: Pick<
    QaPlanWire,
    | 'autoRerun'
    | 'autoRerunTrigger'
    | 'autoRerunBranch'
    | 'autoRerunDelayMinutes'
    | 'deployEnvironment'
  >,
): string {
  if (!plan.autoRerun) return 'Auto-rerun is off. Rerun by hand.';
  if (plan.autoRerunTrigger === 'merge') {
    if (!plan.autoRerunBranch) {
      return 'With no branch chosen, you get an inbox notice when every finding card is Done, and rerun by hand.';
    }
    const delay = plan.autoRerunDelayMinutes
      ? ` and ${plan.autoRerunDelayMinutes} more minutes pass`
      : '';
    return `After a failed run, the failed cases rerun once every finding card is Done, a pull request is merged into ${plan.autoRerunBranch}${delay}.`;
  }
  return plan.deployEnvironment
    ? `After a failed run, the failed cases rerun once every finding card is Done and a deployment to ${plan.deployEnvironment} succeeds after the last one.`
    : 'With no deploy environment linked, you get an inbox notice when every finding card is Done, and rerun by hand.';
}

function RerunSettings({
  projectId,
  detail,
  busy,
  onSave,
}: {
  projectId: string;
  detail: QaPlanDetailWire;
  busy: boolean;
  onSave: (patch: QaPlanPatch) => void;
}) {
  const { plan } = detail;
  const trigger = plan.autoRerunTrigger ?? 'deployment';
  const [maxDraft, setMaxDraft] = useState(String(plan.maxIterations));
  useEffect(() => setMaxDraft(String(plan.maxIterations)), [plan.maxIterations]);
  const environments = useNames(projectId, async (id) =>
    namesFrom(
      ((await api.getDeployEnvironments(id)) as { environments?: unknown } | null)?.environments,
    ),
  );
  const branches = useNames(trigger === 'merge' ? projectId : null, async (id) =>
    namesFrom(((await api.getProjectBranches(id)) as { branches?: unknown } | null)?.branches),
  );
  const envOptions = withCurrent(environments, plan.deployEnvironment);
  const branchOptions = withCurrent(branches, plan.autoRerunBranch ?? null);
  const delay = plan.autoRerunDelayMinutes ?? 0;
  const delayOptions = QA_RERUN_DELAY_OPTIONS.includes(delay)
    ? QA_RERUN_DELAY_OPTIONS
    : [...QA_RERUN_DELAY_OPTIONS, delay].sort((a, b) => a - b);
  const saveMax = () => {
    const n = Number.parseInt(maxDraft, 10);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      setMaxDraft(String(plan.maxIterations));
      return;
    }
    if (n !== plan.maxIterations) onSave({ maxIterations: n });
  };
  return (
    <div className="flex flex-col gap-2" data-testid="qa-rerun-settings">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-400">
        <label className="inline-flex items-center gap-1.5">
          <Checkbox
            data-testid="qa-auto-rerun-toggle"
            checked={plan.autoRerun}
            disabled={busy}
            onChange={(e) => onSave({ autoRerun: e.target.checked })}
          />
          Auto-rerun when fixes land
        </label>
        <label className="inline-flex items-center gap-1.5">
          Trigger
          <select
            data-testid="qa-auto-rerun-trigger"
            value={trigger}
            disabled={busy}
            onChange={(e) =>
              onSave({ autoRerunTrigger: e.target.value === 'merge' ? 'merge' : 'deployment' })
            }
            className={selectClass}
          >
            <option value="deployment">Deployment</option>
            <option value="merge">Merge to branch</option>
          </select>
        </label>
        {trigger === 'deployment' ? (
          <label className="inline-flex items-center gap-1.5">
            Deploy environment
            <select
              data-testid="qa-deploy-environment"
              value={plan.deployEnvironment ?? ''}
              disabled={busy}
              onChange={(e) => onSave({ deployEnvironment: e.target.value || null })}
              className={selectClass}
            >
              <option value="">None (rerun by hand)</option>
              {envOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="inline-flex items-center gap-1.5">
              Branch
              <select
                data-testid="qa-auto-rerun-branch"
                value={plan.autoRerunBranch ?? ''}
                disabled={busy}
                onChange={(e) => onSave({ autoRerunBranch: e.target.value || null })}
                className={selectClass}
              >
                <option value="">None (rerun by hand)</option>
                {branchOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-1.5">
              Delay
              <select
                data-testid="qa-auto-rerun-delay"
                value={String(delay)}
                disabled={busy}
                onChange={(e) => onSave({ autoRerunDelayMinutes: Number(e.target.value) })}
                className={selectClass}
              >
                {delayOptions.map((m) => (
                  <option key={m} value={String(m)}>
                    {m === 0 ? 'None' : `${m} min`}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="inline-flex items-center gap-1.5">
          Max runs
          <input
            type="number"
            min={1}
            max={100}
            data-testid="qa-max-iterations"
            value={maxDraft}
            disabled={busy}
            onChange={(e) => setMaxDraft(e.target.value)}
            onBlur={saveMax}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveMax();
            }}
            className="w-14 rounded-md border border-gray-700 bg-gray-950 px-1.5 py-0.5 text-xs text-gray-100"
          />
        </label>
      </div>
      <div className="text-xs text-gray-500">{autoRerunSummary(plan)}</div>
      {detail.autoRerun && (
        <div
          data-testid="qa-auto-rerun-status"
          data-kind={detail.autoRerun.kind}
          className="rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-300"
        >
          {detail.autoRerun.message}
        </div>
      )}
    </div>
  );
}

function RunHistory({
  runs,
  cases,
  approved,
  onOpenSession,
  onOpenCard,
  onTroubleshoot,
}: {
  runs: QaRunWire[];
  cases: QaCaseWire[];
  approved: boolean;
  onOpenSession?: (agentId: string | null, sessionId: string) => void;
  onOpenCard?: (cardId: string) => void;
  onTroubleshoot?: (runId: string, caseId: string) => Promise<void>;
}) {
  // Newest run open by default; the user's toggles win afterwards.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  if (runs.length === 0) {
    return (
      <div className="text-sm text-gray-500" data-testid="qa-runs-empty">
        No runs yet.{' '}
        {approved
          ? 'Start a run to record a verdict for each case.'
          : 'Runs start once the plan is approved.'}
      </div>
    );
  }
  return (
    <ul className="rounded-lg border border-gray-800" data-testid="qa-run-list">
      {runs.map((r, i) => {
        const duration = runDuration(r);
        const resultCount = r.results?.length ?? 0;
        const expanded = toggled[r.id] ?? i === 0;
        return (
          <li
            key={r.id}
            data-testid={`qa-run-row-${r.id}`}
            className="border-b border-gray-800 last:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs">
              <button
                type="button"
                data-testid="qa-run-toggle"
                aria-expanded={expanded}
                onClick={() => setToggled((cur) => ({ ...cur, [r.id]: !expanded }))}
                className="inline-flex items-center gap-1 text-sm text-gray-100 hover:text-white"
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Run {r.iteration}
              </button>
              <span className="text-gray-400">
                {r.scope === 'failed_only' ? 'Failed only' : 'Full'}
              </span>
              <span className={RUN_STATUS_CLASS[r.status]} data-testid="qa-run-status">
                {r.status}
              </span>
              <span className="text-gray-500">
                {resultCount} result{resultCount === 1 ? '' : 's'}
              </span>
              <span className="text-gray-500">
                {r.startedAt ? `Started ${formatDateTime(r.startedAt)}` : 'Not started'}
                {duration ? ` · ${duration}${r.finishedAt ? '' : ' so far'}` : ''}
              </span>
              {r.sessionId && r.sessionAgentId && (
                <button
                  type="button"
                  data-testid="qa-run-session"
                  className="ml-auto inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 disabled:text-gray-500"
                  disabled={!onOpenSession}
                  onClick={() => onOpenSession?.(r.sessionAgentId, r.sessionId!)}
                >
                  <MessageSquare size={12} />
                  Session
                </button>
              )}
            </div>
            {expanded && (
              <div className="border-t border-gray-800 bg-gray-950/40">
                <QaRunResults
                  run={r}
                  cases={cases}
                  onOpenCard={onOpenCard}
                  onTroubleshoot={
                    onTroubleshoot ? (caseId) => onTroubleshoot(r.id, caseId) : undefined
                  }
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface QaPlanDetailProps extends LinkProps {
  projectId: string;
  planId: string;
  /** Message from the page, e.g. the authoring chat failed to open after create. */
  notice?: string | null;
  onBack: () => void;
  onOpenSession?: (agentId: string | null, sessionId: string) => void;
}

export default function QaPlanDetail({
  projectId,
  planId,
  notice,
  onBack,
  onOpenEpic,
  onOpenCard,
  onOpenSession,
}: QaPlanDetailProps) {
  const [detail, setDetail] = useState<QaPlanDetailWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestSeq = useRef(0);

  // Same newest-wins sequencing as the list: a slow response for a previous
  // plan or an older qa_update refresh never overwrites newer data.
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const data = await api.getQaPlan(projectId, planId);
      if (seq !== requestSeq.current) return;
      setDetail(data);
      setError(null);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load QA plan');
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

  useEffect(() => {
    const onUpdate = (e: Event) => {
      const d = (e as CustomEvent<{ projectId?: string; planId?: string }>).detail;
      if (d?.projectId && d.projectId !== projectId) return;
      if (d?.planId && d.planId !== planId) return;
      void load();
    };
    window.addEventListener('qa_update', onUpdate);
    return () => window.removeEventListener('qa_update', onUpdate);
  }, [load, projectId, planId]);

  const plan = detail?.plan;
  const lockReason = detail ? caseListLockReason(detail) : null;

  /** Run one mutation, then refresh. Returns false (with the error shown) on failure. */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Request failed');
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
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to open the QA chat');
    } finally {
      setBusy(false);
    }
  };

  const troubleshoot = async (runId: string, caseId: string) => {
    const { agentId, sessionId } = await api.troubleshootQaResult(projectId, planId, runId, caseId);
    onOpenSession?.(agentId, sessionId);
  };

  const confirmApprovalLoss = (): boolean =>
    !plan?.approved ||
    window.confirm('This plan is approved. Changing its cases revokes approval. Continue?');

  return (
    <div className="flex h-full flex-col gap-4" data-testid="qa-plan-detail">
      <div>
        <button
          type="button"
          onClick={onBack}
          data-testid="qa-detail-back"
          className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200"
        >
          <ArrowLeft size={12} />
          All plans
        </button>
      </div>

      {[notice, error, actionError].filter(Boolean).map((msg) => (
        <div
          key={msg}
          data-testid="qa-detail-error"
          className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300"
        >
          {msg}
        </div>
      ))}

      {!plan ? (
        !error && <div className="text-sm text-gray-500">Loading…</div>
      ) : (
        <>
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold text-gray-100">{plan.title}</h1>
              <span
                data-testid="qa-detail-status"
                className="rounded-full bg-gray-800 px-2 py-0.5 text-[11px] text-gray-300"
              >
                {QA_STATUS_LABELS[plan.status]}
              </span>
              <span
                data-testid="qa-detail-approval"
                className={`rounded-full px-2 py-0.5 text-[11px] ${
                  plan.approved ? 'bg-emerald-950 text-emerald-300' : 'bg-amber-950 text-amber-300'
                }`}
                title={
                  plan.approved && plan.approvedAt
                    ? `Approved ${formatDateTime(plan.approvedAt)}`
                    : undefined
                }
              >
                {plan.approved ? 'Approved' : 'Not approved'}
              </span>
              {plan.signedOffAt && (
                <span
                  data-testid="qa-detail-signed-off"
                  className="rounded-full bg-emerald-950 px-2 py-0.5 text-[11px] text-emerald-300"
                  title={plan.signedOffBy ? `Signed off by ${plan.signedOffBy}` : undefined}
                >
                  Signed off {formatDateTime(plan.signedOffAt)}
                </span>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {plan.status === 'in_progress' && (
                  <button
                    type="button"
                    data-testid="qa-sign-off"
                    disabled={busy || detail.signOffBlocker !== null}
                    title={
                      detail.signOffBlocker ??
                      'Record your manual validation and move the plan to Done'
                    }
                    onClick={() => {
                      if (window.confirm('Sign off this plan and move it to Done?')) {
                        void act(() => api.signOffQaPlan(projectId, planId));
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-2.5 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-60"
                  >
                    <CheckCircle2 size={12} />
                    Sign off
                  </button>
                )}
                <button
                  type="button"
                  data-testid="qa-open-chat"
                  disabled={busy}
                  onClick={() => void openChat()}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-60"
                >
                  <MessageSquare size={12} />
                  {plan.authoringSessionId ? 'Open QA chat' : 'Draft cases with QA agent'}
                </button>
                {lockReason === null &&
                  (plan.approved ? (
                    <button
                      type="button"
                      data-testid="qa-revoke-approval"
                      disabled={busy}
                      onClick={() => void act(() => api.revokeQaPlanApproval(projectId, planId))}
                      className="rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-60"
                    >
                      Revoke approval
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="qa-approve"
                      disabled={busy || detail.cases.length === 0}
                      title={detail.cases.length === 0 ? 'Add at least one case first' : undefined}
                      onClick={() => void act(() => api.approveQaPlan(projectId, planId))}
                      className="rounded-md bg-emerald-700 px-2.5 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-60"
                    >
                      Approve
                    </button>
                  ))}
              </div>
            </div>
            <a
              href={plan.targetUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="qa-detail-target"
              className="inline-flex w-fit max-w-full items-center gap-1 truncate text-sm text-blue-400 hover:text-blue-300"
            >
              <span className="truncate">{plan.targetUrl}</span>
              <ExternalLink size={12} className="flex-shrink-0" />
            </a>
            <LinkChips
              epic={detail.links.epic}
              card={detail.links.card}
              onOpenEpic={onOpenEpic}
              onOpenCard={onOpenCard}
            />
            {plan.goal && <p className="whitespace-pre-wrap text-sm text-gray-400">{plan.goal}</p>}
          </header>

          {!plan.approved && (
            <div
              data-testid="qa-detail-unapproved"
              className="rounded-md border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-200"
            >
              This plan is not approved. Cases can still change, and runs are refused until a human
              approves the case list.
            </div>
          )}
          {plan.approved && lockReason === null && (
            <div data-testid="qa-detail-approved-note" className="text-xs text-gray-500">
              Approved: the case list is locked for runs. Editing, adding, or deleting a case
              revokes approval, and an edited case gets a new version.
            </div>
          )}
          {plan.status === 'in_progress' && (
            <div data-testid="qa-detail-sign-off-note" className="text-xs text-gray-500">
              {detail.signOffBlocker === null
                ? 'The latest run passed every case. Validate the target by hand, then sign off to move the plan to Done.'
                : `Sign-off opens once the latest run passes every case. ${detail.signOffBlocker}.`}
            </div>
          )}
          {lockReason && (
            <div data-testid="qa-detail-locked" className="text-xs text-gray-500">
              Cases are read-only. {lockReason}
            </div>
          )}

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-gray-300">
              Cases <span className="text-gray-500">{detail.cases.length}</span>
            </h2>
            <CaseTable
              cases={detail.cases}
              approved={plan.approved}
              lockReason={lockReason}
              busy={busy}
              onAdd={(draft) =>
                confirmApprovalLoss()
                  ? act(() =>
                      api.addQaCase(projectId, planId, { ...draft, title: draft.title.trim() }),
                    )
                  : Promise.resolve(false)
              }
              onEdit={async (c, edits) => {
                const patch = planCaseSave(edits);
                if (!patch) return 'saved';
                const sent = Object.keys(patch) as CaseField[];
                const conflictWith = (fields: string[], saved: CaseDraft): CaseSaveResult => {
                  setActionError(
                    `"${c.title}" changed (${fields.join(', ')}) while you were editing. ` +
                      'Your text is still in the form; Save again to overwrite the new version.',
                  );
                  return { conflict: saved, sent };
                };
                if (!confirmApprovalLoss()) return 'failed';
                setBusy(true);
                setActionError(null);
                try {
                  // The server re-checks each field's base inside the update, so
                  // a change this page has not seen yet is refused, not overwritten.
                  await api.updateQaCase(projectId, planId, c.id, {
                    ...patch,
                    expectedBase: caseEditExpectedBase(edits, patch),
                  });
                  await load();
                  return 'saved';
                } catch (e) {
                  const saved = editConflictCase(e);
                  const fields = (e as { body?: { conflicts?: unknown } }).body?.conflicts;
                  await load();
                  if (saved) {
                    return conflictWith(Array.isArray(fields) ? fields.map(String) : sent, saved);
                  }
                  setActionError(e instanceof Error ? e.message : 'Request failed');
                  return 'failed';
                } finally {
                  setBusy(false);
                }
              }}
              onDelete={(c) => {
                const msg = plan.approved
                  ? `Delete "${c.title}"? This revokes the plan's approval.`
                  : `Delete "${c.title}"?`;
                if (!window.confirm(msg)) return;
                void act(() => api.deleteQaCase(projectId, planId, c.id));
              }}
              onMove={(index, delta) => {
                const ids = moveCaseIds(
                  detail.cases.map((c) => c.id),
                  index,
                  delta,
                );
                if (ids) void act(() => api.reorderQaCases(projectId, planId, ids));
              }}
            />
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-medium text-gray-300">Run history</h2>
              <div className="ml-auto">
                <RunButtons
                  detail={detail}
                  busy={busy}
                  onStart={(scope) => {
                    if (
                      plan.status === 'done' &&
                      !window.confirm('Starting a run reopens this signed-off plan. Continue?')
                    ) {
                      return;
                    }
                    void act(() => api.startQaRun(projectId, planId, scope));
                  }}
                />
              </div>
            </div>
            <RerunSettings
              projectId={projectId}
              detail={detail}
              busy={busy}
              onSave={(patch) => void act(() => api.updateQaPlan(projectId, planId, patch))}
            />
            <RunHistory
              runs={detail.runs}
              cases={detail.cases}
              approved={plan.approved}
              onOpenSession={onOpenSession}
              onOpenCard={onOpenCard}
              onTroubleshoot={onOpenSession ? troubleshoot : undefined}
            />
          </section>
        </>
      )}
    </div>
  );
}
