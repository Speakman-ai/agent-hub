/**
 * finalize-snapshot — build `finalize_run_phase_changed` snapshot events for
 * a WebSocket client that just (re)connected.
 *
 * Why this exists: `useFinalizeRun` on the client mirrors a Finalize run's
 * live state purely from streamed `finalize_run_*` events. The server replays
 * connect-snapshots for active-tasks / awaiting-input / queued / preview on
 * every WS connection, but historically NOT for finalize runs. So any
 * `finalize_run_*` event that fired while the socket was down — a laptop
 * sleep/wake, Wi-Fi switch, NAT rebind, idle-proxy kill, or simply the gap
 * between a fresh mount and the first socket open — was lost with no
 * server-side way to recover it. The symptom users reported repeatedly:
 * "tests are running but the UI doesn't say they are" — the checks block
 * stays hidden, the button status goes stale, the steps panel sits empty.
 *
 * Two prior fixes were both CLIENT-side heuristics: refetch on a detected
 * reconnect (`agenthub:ws_reconnected`) and a pong-liveness watchdog to detect
 * a half-open socket. Both depend on the client *noticing* a disconnect; any
 * gap the heuristics miss still strands the checks UI. This module is the
 * server-side counterpart that closes the class: on EVERY connection the
 * server re-emits one `finalize_run_phase_changed` per non-terminal run, which
 * the client's existing `onPhaseChanged` handler turns into an authoritative
 * `refetchRun` — converging run + steps + phases to the server's truth
 * unconditionally, no client disconnect-detection required.
 *
 * Replaying a single phase-change event per run (rather than every per-step
 * event) is deliberate: the client's `onPhaseChanged` already triggers a full
 * REST refetch of run + steps + phases, so one event per run is sufficient to
 * reconcile everything and keeps the connect handshake cheap.
 *
 * The functions here are intentionally pure: no WebSocket access, no globals.
 * The caller (websocket.ts) does the broadcast-filter check + ws.send, so this
 * module stays trivially unit-testable.
 */

import type { FinalizeRunPhase, FinalizeRunStatus } from '../types.js';

/**
 * The minimal `finalize_runs` row shape the snapshot builder consumes. A
 * narrowed projection of `FinalizeRunRow` — the connect snapshot only needs
 * the identity + phase/status, since the client refetches the full row.
 */
export interface FinalizeSnapshotRunRow {
  id: string;
  session_id: string | null;
  phase: FinalizeRunPhase | null;
  status: FinalizeRunStatus;
}

/**
 * Wire shape of a finalize connect-snapshot event. Identical to the live
 * `finalize_run_phase_changed` broadcast (see reviewer-dispatch.ts) so the
 * client's existing window-event handler (`useFinalizeRun#onPhaseChanged`)
 * picks it up with no special-casing. Always carries `session_id` so the
 * broadcast-visibility filter can resolve the owning project and the client's
 * `matchesRun` can attribute it to the active session.
 */
export interface FinalizeSnapshotEvent {
  type: 'finalize_run_phase_changed';
  run_id: string;
  session_id: string;
  phase: FinalizeRunPhase | null;
  status: FinalizeRunStatus;
  /**
   * Marks this as a connect-replay rather than a live transition. The client
   * ignores it (it reads run_id/session_id/phase/status), but it keeps the
   * snapshot self-describing on the wire and in logs.
   */
  snapshot: true;
}

/**
 * The narrow statement surface the builder needs — just the
 * `getActiveFinalizeRuns` prepared statement. Kept as an interface so tests
 * can pass a stub without standing up the full `Stmts` object / a real db.
 */
export interface FinalizeSnapshotStmts {
  getActiveFinalizeRuns: { all: () => unknown[] };
}

/**
 * Translate a single active run row into a snapshot event. Returns `null` for
 * rows that can't be attributed to a session (no `session_id`): without one
 * the visibility filter can't resolve a project and the client can't match it,
 * so emitting it would be noise.
 */
export function finalizeSnapshotEventFromRow(
  row: FinalizeSnapshotRunRow | null | undefined,
): FinalizeSnapshotEvent | null {
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  if (typeof row.session_id !== 'string' || !row.session_id) return null;
  if (typeof row.status !== 'string' || !row.status) return null;
  return {
    type: 'finalize_run_phase_changed',
    run_id: row.id,
    session_id: row.session_id,
    phase: row.phase ?? null,
    status: row.status,
    snapshot: true,
  };
}

/**
 * Build the full set of finalize snapshot events for the WS connect
 * handshake, newest run first (mirrors `getActiveFinalizeRuns` ordering).
 *
 * Lenient by contract: a db hiccup or an unexpected row shape collapses to an
 * empty array rather than throwing — the snapshot is best-effort and must
 * never break the rest of the connect handshake. The caller is still
 * responsible for filtering each event through `shouldDeliverBroadcast` before
 * sending; we don't take a visibility stamp here so the helper stays pure.
 */
export function buildFinalizeSnapshotEvents(
  stmts: FinalizeSnapshotStmts | null | undefined,
): FinalizeSnapshotEvent[] {
  if (!stmts?.getActiveFinalizeRuns) return [];
  let rows: unknown[];
  try {
    rows = stmts.getActiveFinalizeRuns.all();
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const events: FinalizeSnapshotEvent[] = [];
  for (const row of rows) {
    const event = finalizeSnapshotEventFromRow(row as FinalizeSnapshotRunRow);
    if (event) events.push(event);
  }
  return events;
}
