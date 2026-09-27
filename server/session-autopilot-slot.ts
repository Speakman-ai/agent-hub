/**
 * Compare-and-set writes for the Autopilot config on the session row.
 *
 * Every Autopilot write re-reads the row, decides from what is stored now, and
 * commits only if the stored JSON is still the value it read. Nothing here
 * writes from a snapshot taken before an await, and the only I/O is the
 * session row.
 */
import type { Stmts } from './types.js';
import {
  type AutopilotSessionConfig,
  type AutopilotStatus,
  parseAutopilotSessionConfig,
  serializeAutopilotSessionConfig,
} from '../shared/utils/sessionAutopilot.js';
import {
  type MainlineSlot,
  type MainlineSlotEvent,
  type MainlineSlotPhase,
  type MainlineSlotRefusal,
  IDLE_MAINLINE_SLOT,
  applyMainlineSlotEvent,
  mainlineSlotMatches,
  withMainlineSlot,
} from '../shared/utils/autopilotMainlineSlot.js';

export type AutopilotRowStmts = Pick<Stmts, 'getSession' | 'casSessionAutopilotConfig'>;

/**
 * Another writer can only slip in between read and write across processes
 * (in-process the read-modify-write is synchronous). Each retry re-decides
 * from the fresh row, so a bounded loop is enough.
 */
const MAX_CAS_ATTEMPTS = 5;

type Decision<R> = { write: AutopilotSessionConfig; result: R } | { skip: R };

export type AutopilotRowWrite<R> =
  | { wrote: true; result: R; before: AutopilotSessionConfig; after: AutopilotSessionConfig }
  | { wrote: false; result: R | null; reason: 'no_config' | 'skipped' | 'conflict' };

function readRawConfig(stmts: AutopilotRowStmts, sessionId: string): string | null | undefined {
  const row = stmts.getSession.get(sessionId) as
    | { autopilot_session_config?: string | null }
    | undefined;
  if (!row) return undefined;
  return row.autopilot_session_config ?? null;
}

/**
 * Read the stored config, let `decide` choose from it, and write the result
 * only if the row is unchanged since the read.
 */
export function casAutopilotConfig<R>(
  stmts: AutopilotRowStmts,
  sessionId: string,
  decide: (current: AutopilotSessionConfig) => Decision<R>,
): AutopilotRowWrite<R> {
  for (let i = 0; i < MAX_CAS_ATTEMPTS; i++) {
    const raw = readRawConfig(stmts, sessionId);
    const current = raw == null ? null : parseAutopilotSessionConfig(raw);
    if (!current) return { wrote: false, result: null, reason: 'no_config' };
    const decision = decide(current);
    if ('skip' in decision) return { wrote: false, result: decision.skip, reason: 'skipped' };
    const info = stmts.casSessionAutopilotConfig.run(
      serializeAutopilotSessionConfig(decision.write),
      sessionId,
      raw ?? null,
    );
    if (info.changes === 1) {
      return { wrote: true, result: decision.result, before: current, after: decision.write };
    }
  }
  return { wrote: false, result: null, reason: 'conflict' };
}

export type MainlineSlotWrite =
  | { wrote: true; slot: MainlineSlot }
  | {
      wrote: false;
      reason: 'no_config' | 'not_mainline' | 'stale' | 'conflict' | MainlineSlotRefusal['reason'];
      /** The stored slot when one was read; callers re-decide from it. */
      slot: MainlineSlot | null;
    };

/**
 * Apply one slot event, but only if the stored slot is still the
 * `(phase, attemptId)` the caller acted on. Returns whether it wrote.
 *
 * Run status is deliberately not checked: an owed landing outlives a stopped,
 * expired, or paused session.
 */
export function transitionMainlineSlot(args: {
  stmts: AutopilotRowStmts;
  sessionId: string;
  expect: { phase: MainlineSlotPhase; attemptId: string | null };
  event: MainlineSlotEvent;
  nowIso?: string;
}): MainlineSlotWrite {
  const { stmts, sessionId, expect, event } = args;
  const nowIso = args.nowIso ?? new Date().toISOString();
  const refused: { value: MainlineSlotWrite | null } = { value: null };
  const res = casAutopilotConfig<MainlineSlot>(stmts, sessionId, (current) => {
    refused.value = null;
    const mainline = current.target === 'mainline' ? current.mainline : null;
    if (!mainline) {
      refused.value = { wrote: false, reason: 'not_mainline', slot: null };
      return { skip: IDLE_MAINLINE_SLOT };
    }
    if (!mainlineSlotMatches(mainline.slot, expect)) {
      refused.value = { wrote: false, reason: 'stale', slot: mainline.slot };
      return { skip: mainline.slot };
    }
    const applied = applyMainlineSlotEvent(mainline.slot, event, nowIso);
    if (!applied.ok) {
      refused.value = { wrote: false, reason: applied.reason, slot: mainline.slot };
      return { skip: mainline.slot };
    }
    return {
      write: { ...current, mainline: withMainlineSlot(mainline, applied.slot) },
      result: applied.slot,
    };
  });
  if (res.wrote) return { wrote: true, slot: res.result };
  if (refused.value) return refused.value;
  return {
    wrote: false,
    reason: res.reason === 'no_config' ? 'no_config' : 'conflict',
    slot: null,
  };
}

/** Statuses that end a run. `running` is only ever entered by starting. */
export type AutopilotStopStatus = Exclude<AutopilotStatus, 'running' | 'configuring'>;

/**
 * Move a still-`running` row to a stop status. Returns `wrote: true` for
 * exactly one caller per stop, which is the caller that posts the stop notice.
 * Only `status` changes; the mainline slot is carried over from the stored
 * row, so an owed landing survives the stop.
 */
export function stopAutopilotRun(args: {
  stmts: AutopilotRowStmts;
  sessionId: string;
  to: AutopilotStopStatus;
  /** Extra guard evaluated against the stored config (e.g. deadline passed). */
  when?: (current: AutopilotSessionConfig) => boolean;
}): { wrote: boolean; cfg: AutopilotSessionConfig | null } {
  const { stmts, sessionId, to, when } = args;
  const res = casAutopilotConfig<AutopilotSessionConfig>(stmts, sessionId, (current) => {
    if (current.status !== 'running' || !current.startedAt) return { skip: current };
    if (when && !when(current)) return { skip: current };
    const next: AutopilotSessionConfig = { ...current, status: to };
    return { write: next, result: next };
  });
  return { wrote: res.wrote, cfg: res.result };
}
