/**
 * Autopilot mainline landing slot: the single durable record for one
 * push → deploy → verify cycle on the default branch.
 *
 * Pure data + transition table. Persistence (compare-and-set against the
 * session row) lives in server/session-autopilot-slot.ts. Every write must go
 * through `applyMainlineSlotEvent` there, keyed on the stored
 * `(phase, attemptId)`, never on a snapshot read before an await.
 */

export const MAINLINE_SLOT_PHASES = [
  'idle',
  'pushing',
  'uncertain',
  'landed',
  'deploying',
  'reporting',
] as const;
export type MainlineSlotPhase = (typeof MAINLINE_SLOT_PHASES)[number];

/**
 * Outcome recorded when a cycle reaches `reporting`:
 * - `succeeded` / `failed` / `cancelled`: the deployment reached that terminal status.
 * - `missing`: the deployment row is gone.
 * - `undeployable`: deploy.yaml at the landed commit cannot deploy the environment.
 */
export const MAINLINE_OUTCOME_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
  'missing',
  'undeployable',
] as const;
export type MainlineOutcomeStatus = (typeof MAINLINE_OUTCOME_STATUSES)[number];

export interface MainlineOutcome {
  status: MainlineOutcomeStatus;
  detail: string | null;
  /** Live origin of the environment, from deploy.yaml at the landed commit. */
  origin: string | null;
  /** Readiness URL or check, from deploy.yaml at the landed commit. */
  readiness: string | null;
}

export interface MainlineSlot {
  phase: MainlineSlotPhase;
  /** Minted when a push begins; the slot's identity until it returns to idle. */
  attemptId: string | null;
  /** Commit being landed. Set from `pushing` until the slot returns to idle. */
  sha: string | null;
  /** Deployment bound to this landing. Set from `deploying`. */
  deploymentId: string | null;
  outcome: MainlineOutcome | null;
  /** Set once when a phase is stuck; cleared when the phase changes. */
  escalatedAt: string | null;
  /** When the slot entered its current phase. */
  enteredAt: string | null;
}

/**
 * Finalize owes a fresh run: the remote confirmed this attempt's commit never
 * reached the default branch. Written in the same compare-and-set that frees
 * the slot, and cleared only once a run is accepted (or the restart is
 * dropped because the session stopped, expired, or a human cancelled), so a
 * failed start is retried instead of lost.
 */
export interface MainlineRestartOwed {
  attemptId: string;
  sha: string;
  since: string;
}

export interface AutopilotMainlineConfig {
  deployEnvironment: string;
  slot: MainlineSlot;
  /** Commits confirmed on the default branch (entered `landed`). */
  landedCount: number;
  restartOwed?: MainlineRestartOwed | null;
}

export const IDLE_MAINLINE_SLOT: Readonly<MainlineSlot> = Object.freeze({
  phase: 'idle',
  attemptId: null,
  sha: null,
  deploymentId: null,
  outcome: null,
  escalatedAt: null,
  enteredAt: null,
});

export function idleMainlineSlot(enteredAt: string | null = null): MainlineSlot {
  return { ...IDLE_MAINLINE_SLOT, enteredAt };
}

export type MainlineSlotEvent =
  | { type: 'begin_push'; attemptId: string; sha: string }
  | { type: 'push_landed' }
  | { type: 'push_rejected' }
  | { type: 'push_unknown' }
  | { type: 'remote_present' }
  | { type: 'remote_absent' }
  | { type: 'deploy_started'; deploymentId: string }
  | { type: 'deploy_undeployable'; detail?: string | null }
  | {
      type: 'deploy_finished';
      status: Exclude<MainlineOutcomeStatus, 'undeployable'>;
      detail?: string | null;
      origin?: string | null;
      readiness?: string | null;
    }
  | { type: 'report_delivered' }
  | { type: 'escalate' };

export type MainlineSlotEventType = MainlineSlotEvent['type'];

/**
 * Every legal move. `to: 'same'` keeps the phase (escalation marks a stuck
 * phase without leaving it). Anything not listed here is refused.
 */
export const MAINLINE_SLOT_TRANSITIONS: Readonly<
  Record<
    MainlineSlotEventType,
    { from: readonly MainlineSlotPhase[]; to: MainlineSlotPhase | 'same' }
  >
> = Object.freeze({
  begin_push: { from: ['idle'], to: 'pushing' },
  push_landed: { from: ['pushing'], to: 'landed' },
  push_rejected: { from: ['pushing'], to: 'idle' },
  // A lost push reply, or a restart found the slot still `pushing`.
  push_unknown: { from: ['pushing'], to: 'uncertain' },
  remote_present: { from: ['uncertain'], to: 'landed' },
  remote_absent: { from: ['uncertain'], to: 'idle' },
  deploy_started: { from: ['landed'], to: 'deploying' },
  deploy_undeployable: { from: ['landed'], to: 'reporting' },
  deploy_finished: { from: ['deploying'], to: 'reporting' },
  report_delivered: { from: ['reporting'], to: 'idle' },
  escalate: { from: ['pushing', 'uncertain', 'landed', 'deploying', 'reporting'], to: 'same' },
});

export type MainlineSlotRefusal =
  | { ok: false; reason: 'illegal_transition'; phase: MainlineSlotPhase; event: string }
  | { ok: false; reason: 'already_escalated'; phase: MainlineSlotPhase }
  | { ok: false; reason: 'invalid_event'; message: string };

export type MainlineSlotResult = { ok: true; slot: MainlineSlot } | MainlineSlotRefusal;

const SHA_RE = /^[0-9a-f]{7,64}$/i;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function optionalDetail(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function isMainlineSlotPhase(value: unknown): value is MainlineSlotPhase {
  return typeof value === 'string' && (MAINLINE_SLOT_PHASES as readonly string[]).includes(value);
}

function isOutcomeStatus(value: unknown): value is MainlineOutcomeStatus {
  return (
    typeof value === 'string' && (MAINLINE_OUTCOME_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Pure transition. Returns the next slot or a refusal; never throws. The
 * caller persists `slot` only with a compare-and-set on the stored
 * `(phase, attemptId)`.
 */
export function applyMainlineSlotEvent(
  slot: MainlineSlot,
  event: MainlineSlotEvent,
  nowIso: string,
): MainlineSlotResult {
  const rule = (
    MAINLINE_SLOT_TRANSITIONS as Record<
      string,
      (typeof MAINLINE_SLOT_TRANSITIONS)[MainlineSlotEventType] | undefined
    >
  )[event?.type as string];
  if (!rule) {
    return { ok: false, reason: 'invalid_event', message: `Unknown event ${String(event?.type)}` };
  }
  if (!rule.from.includes(slot.phase)) {
    return { ok: false, reason: 'illegal_transition', phase: slot.phase, event: event.type };
  }

  const enter = (
    phase: MainlineSlotPhase,
    patch: Partial<MainlineSlot> = {},
  ): MainlineSlotResult => ({
    ok: true,
    slot: { ...slot, ...patch, phase, escalatedAt: null, enteredAt: nowIso },
  });

  switch (event.type) {
    case 'begin_push': {
      if (!nonEmpty(event.attemptId)) {
        return { ok: false, reason: 'invalid_event', message: 'begin_push needs an attemptId' };
      }
      if (!nonEmpty(event.sha) || !SHA_RE.test(event.sha.trim())) {
        return { ok: false, reason: 'invalid_event', message: 'begin_push needs a commit sha' };
      }
      return enter('pushing', {
        attemptId: event.attemptId.trim(),
        sha: event.sha.trim(),
        deploymentId: null,
        outcome: null,
      });
    }
    case 'push_landed':
    case 'remote_present':
      return enter('landed');
    case 'push_unknown':
      return enter('uncertain');
    case 'push_rejected':
    case 'remote_absent':
    case 'report_delivered':
      return { ok: true, slot: idleMainlineSlot(nowIso) };
    case 'deploy_started': {
      if (!nonEmpty(event.deploymentId)) {
        return {
          ok: false,
          reason: 'invalid_event',
          message: 'deploy_started needs a deploymentId',
        };
      }
      return enter('deploying', { deploymentId: event.deploymentId.trim() });
    }
    case 'deploy_undeployable':
      return enter('reporting', {
        outcome: {
          status: 'undeployable',
          detail: optionalDetail(event.detail),
          origin: null,
          readiness: null,
        },
      });
    case 'deploy_finished': {
      if (!isOutcomeStatus(event.status) || (event.status as string) === 'undeployable') {
        return {
          ok: false,
          reason: 'invalid_event',
          message: 'deploy_finished needs a terminal deployment status',
        };
      }
      return enter('reporting', {
        outcome: {
          status: event.status,
          detail: optionalDetail(event.detail),
          origin: optionalDetail(event.origin),
          readiness: optionalDetail(event.readiness),
        },
      });
    }
    case 'escalate':
      if (slot.escalatedAt) return { ok: false, reason: 'already_escalated', phase: slot.phase };
      return { ok: true, slot: { ...slot, escalatedAt: nowIso } };
  }
}

/** Whether the slot matches the identity a caller read before acting. */
export function mainlineSlotMatches(
  slot: MainlineSlot,
  expect: { phase: MainlineSlotPhase; attemptId: string | null },
): boolean {
  return slot.phase === expect.phase && slot.attemptId === expect.attemptId;
}

/** `sessionId:attemptId`: stamped on the deployment row and the verify report. */
export function mainlineLandingKey(sessionId: string, attemptId: string): string {
  return `${sessionId}:${attemptId}`;
}

function parseOutcome(raw: unknown): MainlineOutcome | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (!isOutcomeStatus(row.status)) return null;
  return {
    status: row.status,
    detail: optionalDetail(row.detail),
    origin: optionalDetail(row.origin),
    readiness: optionalDetail(row.readiness),
  };
}

/**
 * Parse a stored slot. A slot whose fields do not fit its phase is corrupt;
 * rather than dropping a possibly-owed obligation, one that still names an
 * attempt and a commit becomes `uncertain`, so the reconciler asks the remote
 * (and a landed commit re-adopts its deployment by landing key). Anything
 * else is `idle`.
 */
export function parseMainlineSlot(raw: unknown): MainlineSlot {
  if (!raw || typeof raw !== 'object') return idleMainlineSlot();
  const row = raw as Record<string, unknown>;
  const attemptId = nonEmpty(row.attemptId) ? row.attemptId.trim() : null;
  const sha = nonEmpty(row.sha) && SHA_RE.test(row.sha.trim()) ? row.sha.trim() : null;
  const deploymentId = nonEmpty(row.deploymentId) ? row.deploymentId.trim() : null;
  const outcome = parseOutcome(row.outcome);
  const escalatedAt = nonEmpty(row.escalatedAt) ? row.escalatedAt : null;
  const enteredAt = nonEmpty(row.enteredAt) ? row.enteredAt : null;
  const phase = row.phase;

  const base = { attemptId, sha, escalatedAt, enteredAt };
  const identity = attemptId !== null && sha !== null;
  switch (phase) {
    case 'idle':
      if (!attemptId) return idleMainlineSlot(enteredAt);
      break;
    case 'pushing':
    case 'uncertain':
    case 'landed':
      if (identity) return { ...base, phase, deploymentId: null, outcome: null };
      break;
    case 'deploying':
      if (identity && deploymentId) return { ...base, phase, deploymentId, outcome: null };
      break;
    case 'reporting':
      if (identity && outcome) return { ...base, phase, deploymentId, outcome };
      break;
  }
  if (identity) {
    return { ...base, phase: 'uncertain', deploymentId: null, outcome: null, escalatedAt: null };
  }
  return idleMainlineSlot(enteredAt);
}

function parseRestartOwed(raw: unknown): MainlineRestartOwed | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (!nonEmpty(row.attemptId) || !nonEmpty(row.sha) || !SHA_RE.test(row.sha.trim())) return null;
  return {
    attemptId: row.attemptId.trim(),
    sha: row.sha.trim(),
    since: nonEmpty(row.since) ? row.since : '',
  };
}

/** Parse the `mainline` block; null when it cannot name an environment. */
export function parseAutopilotMainlineConfig(raw: unknown): AutopilotMainlineConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const deployEnvironment = nonEmpty(row.deployEnvironment) ? row.deployEnvironment.trim() : '';
  if (!deployEnvironment) return null;
  const count = typeof row.landedCount === 'number' ? row.landedCount : NaN;
  const restartOwed = parseRestartOwed(row.restartOwed);
  return {
    deployEnvironment,
    slot: parseMainlineSlot(row.slot),
    landedCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    ...(restartOwed ? { restartOwed } : {}),
  };
}

/**
 * Next mainline block after a slot transition. Counts each confirmed landing
 * once, records an owed Finalize restart when the remote answers absent
 * (`uncertain` → `idle`), and drops that debt once a new push begins.
 */
export function withMainlineSlot(
  mainline: AutopilotMainlineConfig,
  next: MainlineSlot,
): AutopilotMainlineConfig {
  const prev = mainline.slot;
  const landedNow = next.phase === 'landed' && prev.phase !== 'landed';
  const out: AutopilotMainlineConfig = {
    ...mainline,
    slot: next,
    landedCount: mainline.landedCount + (landedNow ? 1 : 0),
  };
  if (prev.phase === 'uncertain' && next.phase === 'idle' && prev.attemptId && prev.sha) {
    out.restartOwed = {
      attemptId: prev.attemptId,
      sha: prev.sha,
      since: next.enteredAt ?? '',
    };
  } else if (next.phase === 'pushing' && mainline.restartOwed) {
    out.restartOwed = null;
  }
  return out;
}
