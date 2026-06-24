import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../utils/api';

function stepsFromApiRows(rows: any) {
  if (!Array.isArray(rows)) return new Map<number, any>();
  const next = new Map<number, any>();
  for (const row of rows) {
    const index = row.index ?? row.step_index;
    if (typeof index !== 'number') continue;
    next.set(index, {
      index,
      name: row.name ?? row.step_name ?? `Step ${index}`,
      state: row.state ?? 'queued',
      exitCode: row.exitCode ?? row.exit_code ?? null,
      startedAt: row.startedAt ?? row.started_at ?? null,
      endedAt: row.endedAt ?? row.ended_at ?? null,
    });
  }
  return next;
}

function mergeStepsMaps(existing: any, incoming: any) {
  const next = new Map<number, any>(existing);
  for (const [index, row] of incoming) {
    const prev = next.get(index);
    if (!prev) {
      next.set(index, row);
      continue;
    }
    if (isStaleStepSnapshot(prev, row)) {
      next.set(index, {
        ...prev,
        name: row.name ?? prev.name,
        startedAt: prev.startedAt ?? row.startedAt ?? null,
        endedAt: prev.endedAt ?? row.endedAt ?? null,
        exitCode: prev.exitCode ?? row.exitCode ?? null,
      });
      continue;
    }
    const prevEnded = prev.endedAt ?? 0;
    const rowEnded = row.endedAt ?? 0;
    if (rowEnded >= prevEnded) {
      next.set(index, { ...prev, ...row });
    }
  }
  return next;
}

const STEP_STATE_RANK = {
  queued: 0,
  running: 1,
  skipped: 2,
  passed: 2,
  failed: 2,
} as Record<string, any>;

function stepStateRank(state: any) {
  return STEP_STATE_RANK[state] ?? 0;
}

function isStaleStepSnapshot(prev: any, row: any) {
  const prevEnded = prev.endedAt ?? 0;
  const rowEnded = row.endedAt ?? 0;
  if (rowEnded > prevEnded) return false;
  if (rowEnded < prevEnded) return true;
  return stepStateRank(row.state) < stepStateRank(prev.state);
}

/**
 * Subscribe to the most-recent Finalize Code Changes run for a session and
 * keep an in-memory mirror live across WebSocket events.
 *
 * Design context: `finalize-code-changes-architecture-v0` (wiki) §14.
 *
 * Event sources mirrored into the returned state:
 *
 *   - `finalize_run_phase_changed` — phase + status (refetch the run row).
 *   - `finalize_run_step_state`    — per-step (queued|running|passed|failed)
 *                                    + duration + exit code, kept in
 *                                    declaration order keyed by `step_index`.
 *   - `finalize_run_active_seconds` — bumps the row's `active_seconds_consumed`.
 *   - `finalize_run_created`       — first sighting of a new run for this
 *                                    session; triggers an initial refetch.
 *   - `finalize_run_completed`     — terminal-status flip; refetch one final
 *                                    time to capture `failure_reason`, etc.
 *
 * Only `finalize_run_phase_changed`, `finalize_run_step_state`, and the
 * existing `reviewer_thread_added` events are emitted by the server today.
 * The other three are forward-compat hooks: they're listed in the spec but
 * not yet broadcast (see wiki §14). When the server starts emitting them,
 * the hook picks them up automatically — no UI changes needed.
 *
 * Returned shape:
 *
 *   {
 *     run:               FinalizeRunRow | null,
 *     steps:             Array<{ index, name, state, exitCode, startedAt, endedAt }>,
 *     phases:            { checks, review } | null,  // per-phase done-state
 *     phase:             FinalizeRunPhase | null,
 *     status:            FinalizeRunStatus | null,
 *     isActive:          boolean,            // phase still in flight
 *     isPaused:          boolean,            // waiting on session turn-end
 *                                            // (status === 'dispatching' or
 *                                            //  'stalled_no_response')
 *     isTerminal:        boolean,            // status is a terminal one
 *     activeSeconds:     number | null,
 *     wallSeconds:       number | null,      // ticks every second while !terminal
 *     loadError:         string | null,
 *   }
 *
 * The hook returns `{ run: null }` (and renders accordingly) for sessions
 * that have never triggered a Finalize run, mirroring the server's 200-OK
 * convention for "no runs yet".
 *
 * The hook makes ONE REST call on mount and one per phase-change/refresh
 * trigger. Two pre-warm hooks let callers skip the initial fetch:
 *
 *   - `initialRun` — legacy. A `FinalizeRunRow` that matches `sessionId`
 *     is used as the starting state, but the hook will *also* fetch in
 *     parallel to confirm (treated as a hint, not the truth).
 *
 *   - `prefetchedRun` — preferred. The caller has already authoritatively
 *     resolved the row for this session (e.g. the kanban board called
 *     `getLatestFinalizeRunsForSessions` in batch). Pass the row OR
 *     `null` for "no run" — both skip the initial round trip entirely.
 *     The hook still subscribes to live WS events so the row stays
 *     current across phase / step / created / completed events.
 *
 * Pass `prefetchedRun === undefined` (the default) to fall back to the
 * self-fetch path. Used by `<FinalizeCardBadge />` on the kanban board,
 * where N badges share one batched lookup.
 *
 * @param {{
 *   sessionId: string | null,
 *   initialRun?: object | null,
 *   prefetchedRun?: object | null | undefined,
 *   enabled?: boolean,
 * }} args
 */
export function useFinalizeRun({
  sessionId,
  initialRun = null,
  prefetchedRun,
  enabled = true,
}: any = {}) {
  // Start from `prefetchedRun` when the caller authoritatively passed one
  // (including `null`); fall back to the legacy `initialRun` hint.
  const [run, setRun] = useState(prefetchedRun !== undefined ? prefetchedRun : initialRun);
  const [stepsByIndex, setStepsByIndex] = useState(() => new Map());
  // Independent per-phase done-state ({ checks, review }) for the split
  // "Run Tests" / "Reviewer" buttons. Populated by the latest-run fetch and
  // kept live by the same phase-change / completed refetches as `run`.
  const [phases, setPhases] = useState<any>(null);
  const [loadError, setLoadError] = useState<any>(null);
  // Wall-clock tick driver — bumps every second so the consumer re-renders
  // with a fresh `wallSeconds` value. Cheap (one re-render/sec) and only
  // runs while the run is active.
  const [wallTick, setWallTick] = useState(0);

  // Mount-scoped abort controller — every refetch piggy-backs on it so
  // unmount aborts everything in flight. Mirrors `<ReviewerThreadsPanel />`.
  const abortRef = useRef<any>(null);

  const isAbortError = (e: any) =>
    e?.name === 'AbortError' || (typeof e?.message === 'string' && /aborted/i.test(e.message));

  const refetchRun = useCallback(
    (signal: any) => {
      if (!sessionId || !enabled) {
        setRun(null);
        return Promise.resolve(null);
      }
      return api
        .getLatestFinalizeRunForSession(sessionId, { signal })
        .then((data: any) => {
          if (signal?.aborted) return null;
          const nextRun = data?.run ?? null;
          const nextRunId = nextRun?.id ?? null;
          // A re-trigger opens a *fresh* run for the same session (the panel
          // is reused, the run is not). When the fetched run id differs from
          // the one we were watching, the prior run's step rows must be
          // dropped wholesale — merging would keep the old run's terminal
          // passed/failed rows (their `endedAt` outranks the fresh run's
          // null), so the panel would show stale results and stale per-row
          // durations until each live step event overwrote them one by one.
          const runSwitched = Boolean(nextRunId) && nextRunId !== runIdRef.current;
          // Seed the pre-dispatch phase from an authoritative fetch (mount,
          // reconnect). A fetch that lands ON `dispatching` can't tell us where
          // the run came from, so we leave the ref untouched in that case
          // (stays null → `awaitingChecksFix` stays false post-reconnect).
          if (runSwitched) lastActivePhaseRef.current = null;
          if (nextRun?.phase && nextRun.phase !== 'dispatching') {
            lastActivePhaseRef.current = nextRun.phase;
          }
          setRun(nextRun);
          // Keep the watched-run ref in lockstep so a step event that races
          // this fetch doesn't mistake the same run for another switch.
          if (nextRunId) runIdRef.current = nextRunId;
          if (runSwitched) {
            setStepsByIndex(stepsFromApiRows(data?.steps));
          } else if (Array.isArray(data?.steps)) {
            setStepsByIndex((prev: any) => mergeStepsMaps(prev, stepsFromApiRows(data.steps)));
          }
          setPhases(data?.phases ?? null);
          setLoadError(null);
          return nextRun;
        })
        .catch((e: any) => {
          if (isAbortError(e) || signal?.aborted) return null;
          setLoadError(e?.message || 'Failed to load finalize run');
          return null;
        });
    },
    [sessionId, enabled],
  );

  // Reset + initial fetch when sessionId changes.
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadError(null);
    setStepsByIndex(new Map());
    setPhases(null);
    lastActivePhaseRef.current = null;
    if (!enabled || !sessionId) {
      setRun(null);
      return () => controller.abort();
    }
    if (prefetchedRun !== undefined) {
      // Caller already has the authoritative answer (e.g. the kanban
      // board folds `card.finalize_run` from `getBoard` into the prop).
      // Skip the round-trip; the WS subscription below keeps it live.
      // `null` is a valid value here ("we already know there is no run
      // for this session"). The match check below — same `session_id`
      // — is defensive: a stale prop shouldn't silently mask a row
      // that belongs to a different session.
      if (prefetchedRun === null || prefetchedRun?.session_id === sessionId) {
        setRun(prefetchedRun);
      } else {
        // Mismatched prop — fall back to the self-fetch path so we
        // don't render the wrong session's run.
        refetchRun(controller.signal);
      }
    } else if (initialRun && initialRun.session_id === sessionId) {
      // Caller pre-warmed the row — skip the round-trip; WS keeps it live.
      setRun(initialRun);
    } else {
      refetchRun(controller.signal);
    }
    return () => controller.abort();
    // initialRun + prefetchedRun intentionally NOT in deps — a stable
    // identity reset would re-clear state and re-fetch. Callers pass a
    // snapshot, not a stream; if the batch result changes we want a
    // remount via React's normal commit, not a hook-internal reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, enabled, refetchRun]);

  // Bridge to the run id we're currently watching — closures below need a
  // stable read of "do I care about this event?" without re-running the
  // subscription on every state update.
  const runIdRef = useRef<any>(null);
  useEffect(() => {
    runIdRef.current = run?.id ?? null;
  }, [run?.id]);

  // The most recent *non-dispatching* phase we've observed for the current
  // run. `dispatching` is a generic awaiting-fix state shared by checks
  // failures, reviewer-requested-changes, and rebase-conflict dispatches, so
  // the run's `phase` column alone can't say which kind of fix is in flight.
  // We remember the phase the run was in immediately BEFORE it entered
  // `dispatching` — a checks fix enters from `tasks`, a review fix from
  // `review` — and derive `awaitingChecksFix` from that. This deliberately
  // does NOT look at the historical step list: a stale `failed` row from an
  // earlier checks round (the client merge keeps terminal rows over an
  // incoming `queued` reset) would otherwise mis-flag a later review-phase
  // dispatch as "fixing failed checks". On a fresh load / reconnect mid-gap we
  // never saw the transition, so this stays null and the live "fixing" box is
  // hidden (the persisted finalize_checks_round message still shows the
  // failure) — the safe direction.
  const lastActivePhaseRef = useRef<any>(null);

  const sessionIdRef = useRef<any>(null);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // WebSocket-bridged window events. App.jsx forwards each finalize_*
  // event as a CustomEvent with the raw payload in `event.detail`.
  useEffect(() => {
    if (!enabled || !sessionId) return undefined;

    const matchesRun = (detail: any) => {
      const rid = runIdRef.current;
      if (!detail) return false;
      // Match either by run_id (preferred) or session_id (helps for events
      // that fire before we've discovered the run id, e.g. the first
      // `finalize_run_created` for a fresh session).
      if (rid && detail.run_id === rid) return true;
      if (detail.session_id && detail.session_id === sessionIdRef.current) return true;
      return false;
    };

    const onPhaseChanged = (event: any) => {
      const detail = event?.detail || {};
      if (!matchesRun(detail)) return;
      // Remember the phase the run is transitioning INTO, except the generic
      // `dispatching` — so when the next event flips status to `dispatching`
      // we still know whether we came from `tasks` (checks fix) or `review`
      // (reviewer fix). See `lastActivePhaseRef` above.
      if (detail.phase && detail.phase !== 'dispatching') {
        lastActivePhaseRef.current = detail.phase;
      }
      // Optimistic local update so the badge reacts the same tick the WS
      // event arrives. The refetch below picks up any other columns that
      // the server may have touched (active_seconds_consumed, etc).
      //
      // Fall back to `prev.*` for both phase and status — a phase-change
      // event that carries only status (or only phase) shouldn't briefly
      // null the other field; the refetch will fill in the canonical
      // value moments later, but we don't want a transient flicker.
      setRun((prev: any) => {
        if (prev && prev.id !== detail.run_id) return prev;
        if (!prev && detail.run_id) {
          return {
            id: detail.run_id,
            session_id: detail.session_id ?? sessionIdRef.current,
            phase: detail.phase ?? null,
            status: detail.status ?? null,
          };
        }
        if (!prev) return prev;
        return {
          ...prev,
          phase: detail.phase ?? prev.phase,
          status: detail.status ?? prev.status,
        };
      });
      const signal = abortRef.current?.signal;
      refetchRun(signal);
    };

    const onStepState = (event: any) => {
      const detail = event?.detail || {};
      if (!matchesRun(detail)) return;
      const stepIndex = detail.step_index;
      if (typeof stepIndex !== 'number') return;
      // A live step event means the run is actively in the checks/tasks phase
      // (the handler forces status='running', phase='tasks' below), so the
      // last active phase is `tasks`. This is what lets a subsequent flip to
      // `dispatching` be recognised as a checks fix even if no explicit
      // phase-change event for `tasks` was observed first.
      lastActivePhaseRef.current = 'tasks';
      const eventRunId = detail.run_id;
      const switchesRun = Boolean(
        eventRunId && runIdRef.current && eventRunId !== runIdRef.current,
      );
      if (eventRunId) {
        if (switchesRun) runIdRef.current = eventRunId;
        setRun((prev: any) => {
          if (prev?.id === eventRunId) {
            if (isTerminalStatus(prev.status)) return prev;
            return prev.status === 'running' && prev.phase === 'tasks'
              ? prev
              : { ...prev, status: 'running', phase: 'tasks' };
          }
          return {
            id: eventRunId,
            session_id: detail.session_id ?? sessionIdRef.current,
            phase: 'tasks',
            status: 'running',
          };
        });
      }
      setStepsByIndex((prev: any) => {
        const next = switchesRun ? new Map() : new Map(prev);
        const existing = next.get(stepIndex) || {
          index: stepIndex,
          name: detail.step_name || `Step ${stepIndex}`,
          state: 'queued',
          exitCode: null,
          startedAt: null,
          endedAt: null,
        };
        const now = Date.now();
        if (detail.state === 'running') {
          next.set(stepIndex, {
            ...existing,
            name: detail.step_name || existing.name,
            state: 'running',
            startedAt: existing.startedAt ?? now,
            endedAt: null,
            exitCode: null,
          });
        } else if (detail.state === 'passed' || detail.state === 'failed') {
          next.set(stepIndex, {
            ...existing,
            name: detail.step_name || existing.name,
            state: detail.state,
            exitCode: typeof detail.exit_code === 'number' ? detail.exit_code : existing.exitCode,
            endedAt: now,
          });
        } else if (detail.state === 'skipped') {
          next.set(stepIndex, {
            ...existing,
            name: detail.step_name || existing.name,
            state: 'skipped',
            endedAt: now,
          });
        }
        return next;
      });
    };

    const onActiveSeconds = (event: any) => {
      const detail = event?.detail || {};
      if (!matchesRun(detail)) return;
      const value = detail.active_seconds_consumed;
      if (typeof value !== 'number') return;
      setRun((prev: any) => (prev ? { ...prev, active_seconds_consumed: value } : prev));
    };

    const onCreated = (event: any) => {
      const detail = event?.detail || {};
      // `created` may fire before we know the run id — match on session.
      if (detail.session_id && detail.session_id !== sessionIdRef.current) return;
      const signal = abortRef.current?.signal;
      refetchRun(signal);
    };

    // WebSocket reconnect self-heal. `useWebSocket` starts disconnected and
    // reconnects with a 2s–30s backoff, and the server replays connect
    // snapshots for active-tasks / awaiting-input / preview but NOT for
    // finalize runs. So every `finalize_run_*` event that fired while the
    // socket was down is lost — including events in the gap between this
    // hook's mount-time fetch and the FIRST socket open: the live checks
    // block never appears, the button status goes stale, and the steps panel
    // stays empty (the "tests are either not showing or not running
    // sometimes" report). App.tsx (via useWsReconnectBroadcast) dispatches
    // `agenthub:ws_reconnected` on the first connection after a disconnected
    // window and on every reconnect; refetch the latest run + steps + phases
    // so the panel converges to the server's truth regardless of which events
    // were missed.
    const onReconnected = () => {
      if (!sessionIdRef.current) return;
      const signal = abortRef.current?.signal;
      refetchRun(signal);
    };

    const onCompleted = (event: any) => {
      const detail = event?.detail || {};
      if (!matchesRun(detail)) return;
      setRun((prev: any) => {
        if (prev && detail.run_id && prev.id !== detail.run_id) return prev;
        if (!prev && detail.run_id) {
          return {
            id: detail.run_id,
            session_id: detail.session_id ?? sessionIdRef.current,
            phase: detail.phase ?? null,
            status: detail.status ?? null,
          };
        }
        if (!prev) return prev;
        return {
          ...prev,
          phase: detail.phase ?? prev.phase,
          status: detail.status ?? prev.status,
        };
      });
      const signal = abortRef.current?.signal;
      refetchRun(signal);
    };

    window.addEventListener('finalize_run_phase_changed', onPhaseChanged);
    window.addEventListener('finalize_run_step_state', onStepState);
    window.addEventListener('finalize_run_active_seconds', onActiveSeconds);
    window.addEventListener('finalize_run_created', onCreated);
    window.addEventListener('finalize_run_completed', onCompleted);
    window.addEventListener('agenthub:ws_reconnected', onReconnected);
    return () => {
      window.removeEventListener('finalize_run_phase_changed', onPhaseChanged);
      window.removeEventListener('finalize_run_step_state', onStepState);
      window.removeEventListener('finalize_run_active_seconds', onActiveSeconds);
      window.removeEventListener('finalize_run_created', onCreated);
      window.removeEventListener('finalize_run_completed', onCompleted);
      window.removeEventListener('agenthub:ws_reconnected', onReconnected);
    };
  }, [enabled, sessionId, refetchRun]);

  const status = run?.status ?? null;
  const phase = run?.phase ?? null;
  const isTerminal = isTerminalStatus(status);
  const isPaused = status === 'dispatching' || status === 'stalled_no_response';
  const isActive = !!status && !isTerminal;

  // True only while a fix is being dispatched for a *failed checks round* —
  // i.e. the run entered `dispatching` from the `tasks` phase. Reviewer fixes
  // (entered from `review`) and rebase-conflict fixes (entered from `rebase`)
  // are excluded, so the live checks box doesn't misfire on a review-phase
  // dispatch that happens to still carry a stale `failed` step row. Reading
  // the ref here is safe: the transition into `dispatching` updates `run`
  // (state) → re-render → this recomputes with the ref already set.
  const awaitingChecksFix = status === 'dispatching' && lastActivePhaseRef.current === 'tasks';

  // Wall-clock tick — runs only while the row is active. Cleared on
  // unmount and whenever the run terminates so a long-running tab
  // doesn't burn an interval per closed run.
  useEffect(() => {
    if (!isActive || !run?.started_at) return undefined;
    const id = setInterval(() => setWallTick((t: any) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isActive, run?.started_at]);

  const wallSeconds = useMemo(() => {
    if (!run?.started_at) return null;
    const end = isTerminal && run.ended_at ? run.ended_at : Date.now();
    return Math.max(0, Math.floor((end - run.started_at) / 1000));
    // `wallTick` is the *trigger* for re-computation; including it forces
    // a fresh `Date.now()` read every second while active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.started_at, run?.ended_at, isTerminal, wallTick]);

  const steps = useMemo(
    () => Array.from(stepsByIndex.values()).sort((a: any, b: any) => a.index - b.index),
    [stepsByIndex],
  );

  return {
    run,
    steps,
    phases,
    phase,
    status,
    isActive,
    isPaused,
    isTerminal,
    awaitingChecksFix,
    activeSeconds: run?.active_seconds_consumed ?? null,
    wallSeconds,
    loadError,
  };
}

/** Terminal status codes — see `FinalizeRunStatus` in server/types.ts. */
const TERMINAL_STATUSES = new Set([
  'pushed',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
  'stalled_no_response',
]);

export function isTerminalStatus(status: any) {
  return !!status && TERMINAL_STATUSES.has(status);
}

/**
 * Set of statuses during which a "Finalize" affordance must be disabled —
 * mirrors the card acceptance criteria.
 */
const FINALIZE_BLOCKED_STATUSES = new Set([
  'queued',
  'rebasing',
  'reviewing',
  'running',
  'dispatching',
  'pushing',
]);

export function isFinalizeBlocked(status: any) {
  return !!status && (FINALIZE_BLOCKED_STATUSES.has(status) || status === 'ready_to_push');
}

/** True while orchestrator is actively working (spinner), excluding ready_to_push. */
export function isFinalizeInFlight(status: any) {
  return !!status && FINALIZE_BLOCKED_STATUSES.has(status);
}

export function isReadyToPush(status: any) {
  return status === 'ready_to_push';
}

/**
 * Short human label for a phase + status pair. Used by both the card
 * badge and the run-level header in the checks panel so the two always
 * agree on wording.
 */
export function describeRunPhase(status: any, phase?: any) {
  if (!status) return 'idle';
  switch (status) {
    case 'queued':
      return 'queued';
    case 'rebasing':
      return 'rebasing';
    case 'reviewing':
      return 'reviewing';
    case 'running':
      return phase === 'tasks' ? 'running checks' : 'running';
    case 'dispatching':
      return 'awaiting fix';
    case 'pushing':
      return 'pushing';
    case 'ready_to_push':
      return 'ready to push';
    case 'pushed':
      return 'pushed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed out';
    case 'infra_error':
      return 'infra error';
    case 'cancelled':
      return 'cancelled';
    case 'stalled_no_response':
      return 'stalled';
    default:
      return String(status).replace(/_/g, ' ');
  }
}

/**
 * Format a `seconds` count as a compact "Xh Ym" / "Xm Ys" / "Xs" string.
 * Used by both the card badge ("4m active") and the run header.
 */
export function formatDuration(seconds: any) {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
