/**
 * QA Validation page logic for mobile. Mirrors the pure helpers in the web
 * client (`client/src/components/QaPage.tsx`, `QaPlanDetail.tsx`,
 * `QaRunResults.tsx`, `NewQaPlanDialog.tsx`, `client/src/utils/qaLabels.ts`),
 * following the mobile precedent of hand-mirrored copies rather than shared
 * re-exports. Keep the two in step.
 */
import { colors } from '../theme/colors';
import { parseDate } from './time';

export type QaPlanStatus = 'new' | 'in_progress' | 'done';
export type QaRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
export type QaVerdict = 'pass' | 'fail' | 'needs_change' | 'blocked';
export type QaRunScope = 'full' | 'failed_only';

export interface QaPlanListItem {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  targetUrl: string;
  epicId: string | null;
  cardId: string | null;
  status: QaPlanStatus;
  approved: boolean;
  signedOffAt: string | null;
  createdAt: string;
  updatedAt: string;
  summary: {
    caseCount: number;
    latestRun: {
      id: string;
      iteration: number;
      status: QaRunStatus;
      scope: QaRunScope;
      finishedAt: string | null;
      verdicts: Record<QaVerdict, number>;
    } | null;
    epic: { id: string; name: string } | null;
    card: { id: string; title: string } | null;
  };
}

export interface QaPlanListResponse {
  plans: QaPlanListItem[];
  counts: Record<QaPlanStatus, number>;
}

export interface QaPlan {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  targetUrl: string;
  epicId: string | null;
  cardId: string | null;
  deployEnvironment: string | null;
  status: QaPlanStatus;
  approved: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
  signedOffAt: string | null;
  signedOffBy: string | null;
  autoRerun: boolean;
  maxIterations: number;
  authoringSessionId: string | null;
}

export interface QaCase {
  id: string;
  planId: string;
  position: number;
  title: string;
  steps: string;
  expected: string;
  version: number;
  latestVerdict?: {
    verdict: QaVerdict;
    caseVersion: number;
    current: boolean;
    runId: string;
    iteration: number;
  } | null;
}

export interface QaScreenshot {
  id: string;
  filename: string;
  contentType: string;
}

export interface QaResult {
  id: string;
  runId: string;
  caseId: string;
  caseVersion: number;
  verdict: QaVerdict;
  actual: string;
  notes: string;
  screenshots: QaScreenshot[];
  findingCardId: string | null;
}

export interface QaRun {
  id: string;
  planId: string;
  iteration: number;
  scope: QaRunScope;
  status: QaRunStatus;
  sessionId: string | null;
  sessionAgentId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  results?: QaResult[];
}

export interface QaPlanDetail {
  plan: QaPlan;
  links: {
    epic: { id: string; name: string } | null;
    card: { id: string; title: string } | null;
  };
  cases: QaCase[];
  /** Newest iteration first. */
  runs: QaRun[];
  signOffBlocker: string | null;
  autoRerun?: { kind: string; message: string } | null;
}

export const QA_STATUSES: { key: QaPlanStatus; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
];

export const QA_STATUS_LABELS: Record<QaPlanStatus, string> = {
  new: 'New',
  in_progress: 'In progress',
  done: 'Done',
};

export const VERDICT_LABELS: Record<QaVerdict, string> = {
  pass: 'pass',
  fail: 'fail',
  needs_change: 'needs change',
  blocked: 'blocked',
};

export const VERDICT_COLORS: Record<QaVerdict, string> = {
  pass: colors.emerald400,
  fail: colors.red400,
  needs_change: colors.amber400,
  blocked: colors.gray400,
};

export const RUN_STATUS_COLORS: Record<QaRunStatus, string> = {
  queued: colors.gray400,
  running: colors.blue400,
  passed: colors.emerald400,
  failed: colors.red400,
  cancelled: colors.gray500,
};

const VERDICT_ORDER = Object.keys(VERDICT_LABELS) as QaVerdict[];

/** Plans bucketed by status, each bucket keeping the server's newest-first order. */
export function groupPlansByStatus(
  plans: QaPlanListItem[],
): Record<QaPlanStatus, QaPlanListItem[]> {
  const out: Record<QaPlanStatus, QaPlanListItem[]> = { new: [], in_progress: [], done: [] };
  for (const p of plans) out[p.status]?.push(p);
  return out;
}

/** Tab counts from the server, falling back to bucket sizes when a count is missing. */
export function planCounts(
  grouped: Record<QaPlanStatus, QaPlanListItem[]>,
  counts?: Partial<Record<QaPlanStatus, number>> | null,
): Record<QaPlanStatus, number> {
  const pick = (k: QaPlanStatus) =>
    typeof counts?.[k] === 'number' ? (counts[k] as number) : grouped[k].length;
  return { new: pick('new'), in_progress: pick('in_progress'), done: pick('done') };
}

export function targetHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Verdicts with a nonzero count on the latest run, in display order. */
export function latestRunVerdicts(
  plan: QaPlanListItem,
): Array<{ verdict: QaVerdict; count: number }> {
  const run = plan.summary.latestRun;
  if (!run) return [];
  return VERDICT_ORDER.filter((v) => run.verdicts[v] > 0).map((v) => ({
    verdict: v,
    count: run.verdicts[v],
  }));
}

/** Short text for the latest run: "Run 2 running · 1 pass, 1 fail", or "Not run". */
export function latestRunLabel(plan: QaPlanListItem): string {
  const run = plan.summary.latestRun;
  if (!run) return 'Not run';
  const parts = latestRunVerdicts(plan).map((v) => `${v.count} ${VERDICT_LABELS[v.verdict]}`);
  const head = `Run ${run.iteration} ${run.status}`;
  return parts.length ? `${head} · ${parts.join(', ')}` : head;
}

/** Text for a case's latest verdict, flagged when the case was edited since. */
export function caseVerdictLabel(latest: QaCase['latestVerdict']): string {
  if (!latest) return 'Not run';
  const label = VERDICT_LABELS[latest.verdict];
  return latest.current
    ? `${label} (run ${latest.iteration})`
    : `${label} (run ${latest.iteration}, case edited since)`;
}

/** "3m 12s" style duration, or null when the run has not started. */
export function runDuration(run: QaRun, now: Date = new Date()): string | null {
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

/**
 * Why the case list cannot change right now, or null when it can. Mirrors the
 * server's freeze rule: signed-off plans and plans with an active run.
 */
export function caseListLockReason(detail: Pick<QaPlanDetail, 'plan' | 'runs'>): string | null {
  if (detail.plan.status === 'done') return 'Signed off. Start a run to reopen the plan.';
  const latest = detail.runs[0];
  if (latest && (latest.status === 'queued' || latest.status === 'running')) {
    return `Run ${latest.iteration} is ${latest.status}. Cancel it to edit cases.`;
  }
  return null;
}

export interface RerunButtonState {
  enabled: boolean;
  /** Why the button is disabled, or what it does. */
  title: string;
}

/**
 * Whether a full run and a failed-only run can start, mirroring the server's
 * refusals: unapproved plans, an active run, and (failed-only) a plan where
 * every case already passed on its current version.
 */
export function rerunButtonStates(detail: Pick<QaPlanDetail, 'plan' | 'runs' | 'cases'>): {
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

export interface QaCaseDraft {
  title: string;
  steps: string;
  expected: string;
}

/**
 * The edit to send for a case form: only fields whose text differs from the
 * text the form opened with, plus that opening text as the server-side
 * precondition so a concurrent change is refused rather than overwritten.
 * Null when nothing changed (so no version bump).
 */
export function caseEditPatch(
  base: QaCaseDraft,
  values: QaCaseDraft,
): { patch: Partial<QaCaseDraft>; expectedBase: Partial<QaCaseDraft> } | null {
  const patch: Partial<QaCaseDraft> = {};
  const expectedBase: Partial<QaCaseDraft> = {};
  for (const field of ['title', 'steps', 'expected'] as const) {
    const value = field === 'title' ? values[field].trim() : values[field];
    if (value !== base[field]) {
      patch[field] = value;
      expectedBase[field] = base[field];
    }
  }
  return Object.keys(patch).length > 0 ? { patch, expectedBase } : null;
}

/**
 * A run's results in case order. Results for cases no longer on the plan
 * follow, titled by id, so evidence never disappears.
 */
export function orderRunResults(
  results: QaResult[],
  cases: Pick<QaCase, 'id' | 'title' | 'expected' | 'version'>[],
): Array<{
  result: QaResult;
  qaCase: Pick<QaCase, 'id' | 'title' | 'expected' | 'version'> | null;
}> {
  const byCase = new Map(results.map((r) => [r.caseId, r]));
  const ordered = cases
    .filter((c) => byCase.has(c.id))
    .map((c) => ({ result: byCase.get(c.id)!, qaCase: c }));
  const known = new Set(cases.map((c) => c.id));
  const orphans = results
    .filter((r) => !known.has(r.caseId))
    .map((result) => ({ result, qaCase: null }));
  return [...ordered, ...orphans];
}

/** Copy under the rerun settings explaining what auto-rerun will do. */
export function autoRerunDescription(plan: Pick<QaPlan, 'autoRerun' | 'deployEnvironment'>) {
  if (!plan.autoRerun) return 'Auto-rerun is off. Rerun by hand.';
  return plan.deployEnvironment
    ? `After a failed run, the failed cases rerun once every finding card is Done and a deployment to ${plan.deployEnvironment} succeeds after the last one.`
    : 'With no deploy environment linked, you get an inbox notice when every finding card is Done, and rerun by hand.';
}

/** Max runs input: an integer 1-100, else null (the field resets). */
export function parseMaxIterations(text: string): number | null {
  const n = Number.parseInt(text, 10);
  return Number.isInteger(n) && n >= 1 && n <= 100 && String(n) === text.trim() ? n : null;
}

// New plan form

export interface QaPlanDraft {
  title: string;
  targetUrl: string;
  goal: string;
  epicId: string;
  cardId: string;
}

export type QaPlanDraftErrors = Partial<Record<'title' | 'targetUrl', string>>;

export interface QaEpicOption {
  id: string;
  name: string;
}

export interface QaCardOption {
  id: string;
  title: string;
  shortId: number | null;
  epicId: string | null;
}

/** Mirrors the server rule: the QA agent drives the target in a browser. */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateQaPlanDraft(draft: QaPlanDraft): QaPlanDraftErrors {
  const errors: QaPlanDraftErrors = {};
  if (!draft.title.trim()) errors.title = 'Title is required';
  if (!draft.targetUrl.trim()) errors.targetUrl = 'Target URL is required';
  else if (!isHttpUrl(draft.targetUrl)) errors.targetUrl = 'Enter a full http:// or https:// URL';
  return errors;
}

export function draftToCreateInput(draft: QaPlanDraft) {
  return {
    title: draft.title.trim(),
    targetUrl: draft.targetUrl.trim(),
    goal: draft.goal.trim(),
    epicId: draft.epicId || null,
    cardId: draft.cardId || null,
  };
}

/** Cards offered by the picker: the chosen epic's cards when one is set, newest first. */
export function filterCardOptions(
  cards: QaCardOption[],
  epicId: string,
  query: string,
  limit = 200,
): QaCardOption[] {
  const q = query.trim().toLowerCase();
  const num = /^#?\d+$/.test(q) ? q.replace('#', '') : null;
  return cards
    .filter((c) => !epicId || c.epicId === epicId)
    .filter(
      (c) =>
        !q ||
        c.title.toLowerCase().includes(q) ||
        (num !== null && c.shortId != null && String(c.shortId).startsWith(num)),
    )
    .sort((a, b) => (b.shortId ?? 0) - (a.shortId ?? 0))
    .slice(0, limit);
}

export function toCardOptions(raw: unknown): QaCardOption[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { cards?: unknown })?.cards)
      ? (raw as { cards: unknown[] }).cards
      : [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .filter((c) => typeof c.id === 'string' && typeof c.title === 'string')
    .map((c) => ({
      id: c.id as string,
      title: c.title as string,
      shortId: typeof c.short_id === 'number' ? c.short_id : null,
      epicId: typeof c.epic_id === 'string' ? c.epic_id : null,
    }));
}

export function toEpicOptions(raw: unknown): QaEpicOption[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { epics?: unknown })?.epics)
      ? (raw as { epics: unknown[] }).epics
      : [];
  return list
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .filter((e) => typeof e.id === 'string' && typeof e.name === 'string')
    .map((e) => ({ id: e.id as string, name: e.name as string }));
}

/** A `qa_update` event applies to this screen when it names no project or this one. */
export function qaEventMatches(
  event: { projectId?: string | null; planId?: string | null } | null | undefined,
  projectId: string,
  planId?: string | null,
): boolean {
  if (!event) return false;
  if (event.projectId && event.projectId !== projectId) return false;
  if (planId && event.planId && event.planId !== planId) return false;
  return true;
}

export interface QaUpdateEvent {
  projectId: string | null;
  planId: string | null;
}

/**
 * Fan-out for `qa_update` broadcasts. Each event reaches every listener
 * synchronously, so a burst for several plans never collapses to the last one.
 */
export function createQaUpdateHub() {
  const listeners = new Set<(event: QaUpdateEvent) => void>();
  return {
    subscribe(listener: (event: QaUpdateEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(data: { projectId?: unknown; planId?: unknown } | null | undefined) {
      const event: QaUpdateEvent = {
        projectId: typeof data?.projectId === 'string' ? data.projectId : null,
        planId: typeof data?.planId === 'string' ? data.planId : null,
      };
      for (const listener of [...listeners]) listener(event);
    },
  };
}
