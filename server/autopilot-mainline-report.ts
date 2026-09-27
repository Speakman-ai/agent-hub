/**
 * Mainline Autopilot result delivery: moves a landing slot from `reporting`
 * to `idle` once the deploy result has provably reached the session.
 *
 * Spec invariants this module owns
 * (wiki: autopilot-mainline-mode-spec-default-branch-deploy-verification):
 * - Delivery is proven, not assumed (8). The verify turn and the fallback
 *   notice both carry a report key; the slot leaves `reporting` only when
 *   that key is found in `messages` or `message_queue`. `handleChat` is
 *   dispatched and never awaited here, so a long agent turn cannot stall
 *   the sweep.
 * - Obligations outlive run state (9). A stopped, expired, mode-switched, or
 *   archived session never gets an agent turn; its result posts as a keyed
 *   notice. The deadline stops agent turns, never the owed result.
 * - Status comes from the row (10). Expiry goes through `stopAutopilotRun`,
 *   so its stop notice posts once however many callers race.
 *
 * - Decide when the turn lands, not when it is sent. The verify turn
 *   persists later, inside handleChat, which calls `acceptTurn` synchronously
 *   right before the insert. That check re-reads the row (slot still
 *   `reporting` for this attempt, session still eligible, report not already
 *   on record) and refuses a busy session, so the turn is never queued for a
 *   drain that re-checks nothing. Each sweep also re-checks eligibility for an
 *   in-flight turn and withdraws it (closes its gate) before posting the
 *   notice. A failed lookup is never read as "not delivered".
 *
 * Restart safety: the in-memory dispatch record is only a guard against
 * double-dispatch within this process. After a restart the key lookup runs
 * first, so a turn that was already persisted is not sent again, and one that
 * was not is sent again.
 */
import type Database from 'better-sqlite3';
import type { SessionRow } from './types.js';
import {
  stopAutopilotRun,
  transitionMainlineSlot,
  type AutopilotRowStmts,
} from './session-autopilot-slot.js';
import {
  type AutopilotMainlineNoticeReason,
  type AutopilotSessionConfig,
  autopilotDeadlineReached,
  autopilotStopNoticeContent,
  buildAutopilotMainlineResultNotice,
  buildAutopilotMainlineVerifyMessage,
  parseAutopilotSessionConfig,
} from '../shared/utils/sessionAutopilot.js';
import { type MainlineSlot, mainlineReportKey } from '../shared/utils/autopilotMainlineSlot.js';
import { isAutopilotModeActive } from './session-mode.js';

/** Verify turns dispatched per report before falling back to a notice. */
export const MAINLINE_REPORT_MAX_DISPATCHES = 3;
export const MAINLINE_REPORT_RETRY_MIN_MS = 15_000;
export const MAINLINE_REPORT_RETRY_MAX_MS = 5 * 60_000;
/** Retry delay when the verify turn was refused because the session was busy. */
export const MAINLINE_REPORT_BUSY_RETRY_MS = 15_000;
/**
 * A dispatch not accepted within this long is withdrawn and replaced by the
 * notice. Its acceptance gate closes first, so the turn cannot land late.
 */
export const MAINLINE_REPORT_DISPATCH_STALL_MS = 10 * 60_000;

export interface MainlineReportSession {
  id: string;
  agent_id: string;
}

export interface MainlineReportDeps {
  stmts: AutopilotRowStmts;
  /** Whether `key` appears in this session's messages or message queue. */
  findReportKey: (sessionId: string, key: string) => boolean;
  /**
   * Start the verify turn. Resolves once the user message is persisted or
   * queued; rejects if the turn was dropped first. Never awaited by the sweep.
   * `acceptTurn` must be checked synchronously right before the message is
   * persisted or queued, with whether the session is busy; when it returns
   * false the turn is dropped.
   */
  dispatchTurn: (
    session: MainlineReportSession,
    content: string,
    acceptTurn: (ctx: { busy: boolean }) => boolean,
  ) => Promise<void>;
  /** Transcript line with no model turn. */
  postNotice: (sessionId: string, content: string) => void;
  /** Ask for a sweep soon, e.g. once a dispatch was accepted. */
  requestSweep?: () => void;
  now?: () => number;
  log?: (message: string) => void;
}

interface DispatchRecord {
  attempts: number;
  inFlightSince: number | null;
  nextAt: number;
  /** Acceptance gate of the in-flight dispatch; closing it withdraws the turn. */
  gate: { open: boolean } | null;
}

/** Result of a report-key lookup. `unknown` is never read as absent. */
type Delivery = 'delivered' | 'absent' | 'unknown';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function mainlineReportRetryMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(
    MAINLINE_REPORT_RETRY_MIN_MS * 2 ** Math.min(n - 1, 16),
    MAINLINE_REPORT_RETRY_MAX_MS,
  );
}

type SessionFacts = Pick<SessionRow, 'session_mode' | 'deleted_at'> & {
  autopilot_session_config?: string | null;
};

/**
 * Why this session must not get an agent turn right now, or null when it may.
 * Pure: expiry is reported, not written.
 */
export function mainlineAgentTurnBlocker(
  row: SessionFacts,
  cfg: AutopilotSessionConfig,
  nowMs: number,
): AutopilotMainlineNoticeReason | null {
  if (row.deleted_at) return 'archived';
  if (!isAutopilotModeActive(row)) return 'mode_switched';
  if (cfg.status !== 'running' || !cfg.startedAt) return 'stopped';
  if (autopilotDeadlineReached(cfg, nowMs)) return 'expired';
  return null;
}

export function createMainlineReportDelivery(deps: MainlineReportDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const records = new Map<string, DispatchRecord>();

  function read(
    sessionId: string,
  ): { row: SessionFacts; cfg: AutopilotSessionConfig; slot: MainlineSlot } | null {
    const row = deps.stmts.getSession.get(sessionId) as SessionFacts | undefined;
    if (!row) return null;
    const cfg = parseAutopilotSessionConfig(row.autopilot_session_config ?? null);
    if (!cfg || cfg.target !== 'mainline' || !cfg.mainline) return null;
    return { row, cfg, slot: cfg.mainline.slot };
  }

  /**
   * Free the slot if the key is on record. A failed lookup is `unknown`: the
   * report may already be in the transcript, so the caller must not send
   * another.
   */
  function settleIfDelivered(sessionId: string, slot: MainlineSlot, key: string): Delivery {
    let found: boolean;
    try {
      found = deps.findReportKey(sessionId, key);
    } catch (err) {
      log(`[autopilot-report] session=${sessionId} key lookup failed: ${errMessage(err)}`);
      return 'unknown';
    }
    if (!found) return 'absent';
    const write = transitionMainlineSlot({
      stmts: deps.stmts,
      sessionId,
      expect: { phase: 'reporting', attemptId: slot.attemptId },
      event: { type: 'report_delivered' },
      nowIso: new Date(now()).toISOString(),
    });
    if (write.wrote || write.reason === 'stale') records.delete(key);
    else
      log(
        `[autopilot-report] session=${sessionId} report found but not recorded (${write.reason})`,
      );
    return 'delivered';
  }

  function postResultNotice(
    sessionId: string,
    cfg: AutopilotSessionConfig,
    slot: MainlineSlot,
    key: string,
    reason: AutopilotMainlineNoticeReason,
  ): void {
    deps.postNotice(
      sessionId,
      buildAutopilotMainlineResultNotice({
        cfg,
        slot,
        environment: cfg.mainline!.deployEnvironment,
        reportKey: key,
        reason,
      }),
    );
    settleIfDelivered(sessionId, slot, key);
  }

  /** Move a running session past its deadline to `expired`, announcing it once. */
  function expire(sessionId: string): AutopilotSessionConfig | null {
    const stopped = stopAutopilotRun({
      stmts: deps.stmts,
      sessionId,
      to: 'expired',
      when: (current) => autopilotDeadlineReached(current, now()),
    });
    if (stopped.wrote && stopped.cfg) {
      deps.postNotice(
        sessionId,
        autopilotStopNoticeContent(
          'expired',
          stopped.cfg.branch,
          stopped.cfg.target,
          stopped.cfg.mainline,
        ),
      );
    }
    return stopped.cfg;
  }

  /**
   * Whether the verify turn for `attemptId` may still land, decided from the
   * stored row at the moment of the call. Any doubt (failed lookup, unread
   * row) refuses: a refused turn is replaced by a notice, a wrongly accepted
   * one cannot be taken back.
   */
  function turnStillOwed(sessionId: string, attemptId: string | null, key: string): boolean {
    try {
      const state = read(sessionId);
      if (!state || state.slot.phase !== 'reporting' || state.slot.attemptId !== attemptId) {
        return false;
      }
      if (mainlineAgentTurnBlocker(state.row, state.cfg, now())) return false;
      return !deps.findReportKey(sessionId, key);
    } catch (err) {
      log(`[autopilot-report] session=${sessionId} acceptance check failed: ${errMessage(err)}`);
      return false;
    }
  }

  function dispatch(
    session: MainlineReportSession,
    cfg: AutopilotSessionConfig,
    slot: MainlineSlot,
    key: string,
    record: DispatchRecord,
  ): void {
    const content = buildAutopilotMainlineVerifyMessage({
      cfg,
      slot,
      environment: cfg.mainline!.deployEnvironment,
      reportKey: key,
    });
    const gate = { open: true };
    record.attempts += 1;
    record.inFlightSince = now();
    record.gate = gate;
    records.set(key, record);
    const failed = (detail: string) => {
      if (record.gate !== gate) return;
      record.inFlightSince = null;
      record.gate = null;
      if (refusedBusy && gate.open) {
        record.attempts -= 1;
        record.nextAt = now() + MAINLINE_REPORT_BUSY_RETRY_MS;
        return;
      }
      record.nextAt = now() + mainlineReportRetryMs(record.attempts);
      log(
        `[autopilot-report] session=${session.id} verify turn ${record.attempts}/` +
          `${MAINLINE_REPORT_MAX_DISPATCHES} not accepted: ${detail}`,
      );
      // A refusal because the session stopped owes a notice now, not after
      // the backoff; the blocker check in `deliver` runs before the backoff.
      deps.requestSweep?.();
    };
    const attemptId = slot.attemptId;
    // The turn lands later, inside handleChat. Decide then, from the stored
    // row, not from what this pass read: a stop, mode switch, archive,
    // deadline, or a report already on record all refuse it. Once refused it
    // stays refused, and the next sweep posts the keyed notice.
    //
    // A busy session is refused too, without closing the gate: a queued turn
    // would run later from the queue drain, which re-checks nothing, so a
    // session that stopped in between would still get an agent turn. The
    // refusal is retried soon and does not count toward the cap.
    let refusedBusy = false;
    const acceptTurn = ({ busy }: { busy: boolean }): boolean => {
      if (gate.open && !turnStillOwed(session.id, attemptId, key)) gate.open = false;
      if (!gate.open) return false;
      if (busy) {
        refusedBusy = true;
        return false;
      }
      return true;
    };
    let pending: Promise<void>;
    try {
      pending = deps.dispatchTurn(session, content, acceptTurn);
    } catch (err) {
      failed(errMessage(err));
      return;
    }
    void pending.then(
      () => {
        if (record.gate !== gate) return;
        record.inFlightSince = null;
        record.gate = null;
        deps.requestSweep?.();
      },
      (err: unknown) => failed(errMessage(err)),
    );
  }

  /**
   * One pass over a `reporting` slot. Never awaits the agent turn; any
   * error is logged and retried next sweep.
   */
  function deliver(session: MainlineReportSession): void {
    const state = read(session.id);
    if (!state || state.slot.phase !== 'reporting' || !state.slot.attemptId) return;
    const { slot } = state;
    let { cfg } = state;
    const key = mainlineReportKey(session.id, state.slot.attemptId);
    // Only a completed lookup that found nothing lets delivery proceed.
    if (settleIfDelivered(session.id, slot, key) !== 'absent') return;

    const record = records.get(key) ?? {
      attempts: 0,
      inFlightSince: null,
      nextAt: 0,
      gate: null,
    };
    // Eligibility is re-read on every pass, in flight or not.
    let blocker = mainlineAgentTurnBlocker(state.row, cfg, now());
    if (record.inFlightSince !== null) {
      const stalled = now() - record.inFlightSince >= MAINLINE_REPORT_DISPATCH_STALL_MS;
      if (!blocker && !stalled) return;
      blocker ??= 'dispatch_stalled';
      // Withdraw the turn before replacing it. handleChat checks the gate
      // synchronously before persisting, and the lookup above, this close,
      // and the notice run without yielding, so the turn either landed
      // already (the lookup found it) or never will.
      if (record.gate) record.gate.open = false;
      record.gate = null;
      record.inFlightSince = null;
    } else if (!blocker && record.attempts >= MAINLINE_REPORT_MAX_DISPATCHES) {
      blocker = 'dispatch_failed';
    }
    if (blocker === 'expired') cfg = expire(session.id) ?? cfg;
    if (blocker) {
      postResultNotice(session.id, cfg, slot, key, blocker);
      return;
    }
    if (now() < record.nextAt) return;
    dispatch(session, cfg, slot, key, record);
  }

  return {
    deliver,
    /** Test seam: in-memory dispatch record for a report key. */
    recordFor(key: string): Readonly<DispatchRecord> | undefined {
      return records.get(key);
    },
  };
}

export type MainlineReportDelivery = ReturnType<typeof createMainlineReportDelivery>;

/**
 * Whether `key` is in the session's transcript or queue. `instr` rather
 * than LIKE, so no character in the key acts as a wildcard.
 */
export function findMainlineReportKey(
  db: Pick<Database.Database, 'prepare'>,
  sessionId: string,
  key: string,
): boolean {
  const hit = db
    .prepare(
      `SELECT 1 FROM messages WHERE session_id = ? AND instr(content, ?) > 0
       UNION ALL
       SELECT 1 FROM message_queue WHERE session_id = ? AND instr(content, ?) > 0
       LIMIT 1`,
    )
    .get(sessionId, key, sessionId, key);
  return hit !== undefined;
}
