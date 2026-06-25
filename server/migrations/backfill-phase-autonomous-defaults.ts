/**
 * backfill-phase-autonomous-defaults.ts — one-shot backfill that arms existing
 * kanban phases for auto-dispatch and Auto Merge.
 *
 * Why: phases shipped with `autonomous` and `autonomous_send_it` defaulting to
 * 0. That broke the intended sequential-phase flow two ways:
 *   1. With Auto Merge off, dispatched tickets stopped at "Build and Push" — PRs
 *      stacked and conflicted, cards never reached Done, so a phase never
 *      "completed" and `maybeAdvanceToNextPhase` never fired.
 *   2. Even when a phase did complete, the next phase had to be independently
 *      armed (`autonomous = 1`) or the cascade stopped with
 *      "next phase not armed; leaving stopped".
 *
 * New phases now default to armed + Auto Merge (see db.ts createKanbanPhase),
 * but phases created before this change still carry 0/0. This migration flips
 * those existing rows once so existing boards get the same self-advancing,
 * auto-merging behavior.
 *
 * Guard: a marker file in the data dir makes this run **exactly once**. A blank
 * boot-time `UPDATE ... WHERE x = 0` would otherwise re-arm a phase the user
 * deliberately *paused* (set to 0 via the opt-out toggle) on every restart. The
 * marker means we only normalize the legacy default once and respect later
 * pauses — matching the philosophy of backfill-skill-builder-agents.ts.
 *
 * Never touches `autonomous_running`: arming a phase only makes it eligible for
 * the sequential cascade / a manual "Run phase"; it must not spontaneously
 * start dispatching work on the next boot.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

/** Marker file written into the data dir once the backfill has run. */
export const PHASE_AUTONOMOUS_DEFAULTS_BACKFILL_MARKER =
  '.phase-autonomous-defaults-backfill-v1.done';

export interface BackfillPhaseAutonomousDefaultsResult {
  /** True when the backfill ran this call; false when the marker already existed. */
  ran: boolean;
  /** Rows whose `autonomous` flag was flipped 0 → 1. */
  armed: number;
  /** Rows whose `autonomous_send_it` flag was flipped 0 → 1. */
  autoMerge: number;
  /** Absolute path to the marker file. */
  markerPath: string;
}

/**
 * Run the phase-defaults backfill once. Idempotent across calls: the first call
 * normalizes legacy 0 defaults to 1 and drops the marker; subsequent calls
 * short-circuit on the marker so user pauses are preserved.
 */
export function backfillPhaseAutonomousDefaults(opts: {
  db: BetterSqlite3.Database;
  dataDir: string;
  /** Override the marker timestamp source (tests). Defaults to `new Date()`. */
  nowIso?: () => string;
}): BackfillPhaseAutonomousDefaultsResult {
  const markerPath = path.join(opts.dataDir, PHASE_AUTONOMOUS_DEFAULTS_BACKFILL_MARKER);

  if (existsSync(markerPath)) {
    return { ran: false, armed: 0, autoMerge: 0, markerPath };
  }

  // Run both flips in a single transaction so a crash leaves the DB either fully
  // backfilled or untouched (the marker is written only after the commit, so a
  // crash before it re-runs the idempotent UPDATEs on the next boot).
  const apply = opts.db.transaction(() => {
    const armed = opts.db
      .prepare('UPDATE kanban_phases SET autonomous = 1 WHERE autonomous = 0')
      .run().changes;
    const autoMerge = opts.db
      .prepare('UPDATE kanban_phases SET autonomous_send_it = 1 WHERE autonomous_send_it = 0')
      .run().changes;
    return { armed, autoMerge };
  });
  const { armed, autoMerge } = apply();

  mkdirSync(opts.dataDir, { recursive: true });
  const stamp = opts.nowIso ? opts.nowIso() : new Date().toISOString();
  writeFileSync(markerPath, `${stamp}\n`, 'utf-8');

  return { ran: true, armed, autoMerge, markerPath };
}
