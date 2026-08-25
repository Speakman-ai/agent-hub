/**
 * Mobile polling mirror of the web `useFinalizeRun` hook.
 *
 * The web hook live-updates the latest finalize run via `finalize_run_*`
 * WebSocket events. Mobile has no WS bridge for those yet, so this hook polls
 * `GET /sessions/:id/finalize-runs/latest` on an interval — fast while a run is
 * in flight, slow when idle/terminal — and exposes the same `{ run, steps,
 * phases, status, phase }` shape the finalize components read.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api';
import { isFinalizeBlocked } from '../utils/finalizeRun';
import {
  emptyFinalizeRunState,
  normalizeFinalizeRunResult,
  isFreshGeneration,
} from '../utils/finalizeView';
const ACTIVE_INTERVAL_MS = 2000;
const IDLE_INTERVAL_MS = 8000;
export function useFinalizeRunPoll(sessionId: any, { enabled = true }: any = {}) {
  const [run, setRun] = useState<any>(null);
  const [steps, setSteps] = useState<any[]>([]);
  const [phases, setPhases] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<any>(null);
  // Monotonic generation token, bumped every time the effect (re)runs for a new
  // session. An in-flight request captures it live; if the session changes
  // before the request resolves, the token no longer matches and the response
  // is dropped. A shared boolean ref can't do this — the next effect would reset
  // it to false, letting session A's late response install under session B.
  const genRef = useRef(0);
  const fetchOnce = useCallback(async () => {
    if (!sessionId) return null;
    const myGen = genRef.current;
    try {
      const data = await api.getLatestFinalizeRunForSession(sessionId);
      if (!isFreshGeneration(myGen, genRef.current)) return null;
      const next = normalizeFinalizeRunResult(data);
      setRun(next.run);
      setSteps(next.steps);
      setPhases(next.phases);
      return next.run;
    } catch {
      // Transient fetch failures shouldn't blank the UI — keep the last run,
      // but only if this request still belongs to the current session.
      return isFreshGeneration(myGen, genRef.current) ? run : null;
    } finally {
      if (isFreshGeneration(myGen, genRef.current)) setLoading(false);
    }
  }, [sessionId, run]);
  useEffect(() => {
    // Bump the generation so any request still in flight from a previous
    // session is ignored when it resolves.
    genRef.current += 1;
    // A new session must not inherit the previous session's run. Clear the
    // finalize state up front so FinalizeBar can't render a stale run
    // id/status — and let Stop/Push act on the wrong run — before the first
    // poll for this session resolves.
    const cleared = emptyFinalizeRunState();
    setRun(cleared.run);
    setSteps(cleared.steps);
    setPhases(cleared.phases);
    if (!sessionId || !enabled) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    // Per-effect-instance flag controls only this poll loop's lifecycle, so a
    // status-driven re-run never leaves two overlapping timers scheduling ticks.
    let active = true;
    const tick = async () => {
      const latest = await fetchOnce();
      if (!active) return;
      const delay = isFinalizeBlocked(latest?.status) ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
      timer.current = setTimeout(tick, delay);
    };
    tick();
    return () => {
      active = false;
      // Invalidate this generation so a late in-flight response is dropped even
      // before the next effect runs.
      genRef.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
    // fetchOnce changes with `run`, which would restart the loop every poll —
    // depend only on the inputs that should reset polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, enabled]);
  return {
    run,
    steps,
    phases,
    status: run?.status ?? null,
    phase: run?.phase ?? null,
    loading,
    refetch: fetchOnce,
  };
}
