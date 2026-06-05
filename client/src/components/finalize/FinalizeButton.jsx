import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlaskConical,
  Eye,
  Loader2,
  Upload,
  Square,
  CheckCircle2,
  ChevronDown,
} from 'lucide-react';
import {
  useFinalizeRun,
  isFinalizeInFlight,
  isReadyToPush,
  describeRunPhase,
  formatDuration,
} from '../../hooks/useFinalizeRun.js';
import { api } from '../../utils/api.js';
import { getApiBase, getAuthHeaders } from '../../utils/connection.js';
import {
  hasCommittableChangesFromReady,
  noCommittableChangesTooltip,
} from '../../utils/committableChanges.js';

const OPTIMISTIC_BLOCK_MS = 1500;
const WORKTREE_POLL_MS = 15_000;

// A phase summary counts as "passed" once its run is validated (parked at
// ready_to_push) or already pushed.
function phasePassed(summary) {
  return summary?.status === 'ready_to_push' || summary?.status === 'pushed';
}

async function fetchGithubConnected() {
  try {
    const res = await fetch(`${getApiBase()}/auth/github/status`, {
      headers: { ...getAuthHeaders() },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.connected);
  } catch {
    return false;
  }
}

export default function FinalizeButton({
  projectId,
  cardId,
  sessionId = null,
  prefetchedRun,
  branchLabel = '',
  pendingChanges = null,
  onError,
  variant = 'default',
}) {
  const { run, steps, phases, status, phase, activeSeconds } = useFinalizeRun({
    sessionId,
    prefetchedRun,
    enabled: !!sessionId,
  });

  const [optimisticBlock, setOptimisticBlock] = useState(false);
  // Which trigger ('checks' | 'review') was just clicked — drives the
  // per-button spinner during the optimistic window before the run row
  // (with its authoritative `mode`) arrives over the WebSocket.
  const [pendingMode, setPendingMode] = useState(null);
  const [pushPending, setPushPending] = useState(false);
  // True while a Stop request is in flight, so the stop buttons disable to
  // prevent double-cancel until the terminal broadcast lands.
  const [stopping, setStopping] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [worktreeCommittable, setWorktreeCommittable] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState(null);
  // Current worktree HEAD — used to expire a phase's done-state once new
  // commits land (the validated commit no longer matches HEAD).
  const [worktreeHeadSha, setWorktreeHeadSha] = useState(null);
  // Single-job "Run Tests" dropdown: the selectable ci.yaml v2 jobs for this
  // session's worktree, plus the open/closed state of the attached menu.
  const [ciJobs, setCiJobs] = useState([]);
  const [jobsMenuOpen, setJobsMenuOpen] = useState(false);
  const optimisticTimerRef = useRef(null);
  const jobsMenuRef = useRef(null);

  useEffect(
    () => () => {
      if (optimisticTimerRef.current) clearTimeout(optimisticTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    fetchGithubConnected().then((connected) => {
      if (!cancelled) setGithubConnected(connected);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setWorktreeCommittable(false);
      setWorktreeBranch(null);
      setWorktreeHeadSha(null);
      return undefined;
    }
    let cancelled = false;
    const poll = () => {
      api
        .getSessionWorktreeChanges(sessionId)
        .then((data) => {
          if (!cancelled) {
            setWorktreeCommittable(Boolean(data?.committable));
            setWorktreeBranch(typeof data?.branch === 'string' ? data.branch : null);
            setWorktreeHeadSha(typeof data?.headSha === 'string' ? data.headSha : null);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setWorktreeCommittable(false);
            setWorktreeBranch(null);
            setWorktreeHeadSha(null);
          }
        });
    };
    poll();
    const timer = setInterval(poll, WORKTREE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  // Resolve the selectable ci.yaml v2 jobs once per session so the caret only
  // appears when there's something to pick. v1 / missing / invalid configs
  // return no jobs and the dropdown stays hidden.
  useEffect(() => {
    if (!sessionId) {
      setCiJobs([]);
      return undefined;
    }
    let cancelled = false;
    api
      .getFinalizeCiJobs(sessionId)
      .then((data) => {
        if (!cancelled) setCiJobs(Array.isArray(data?.jobs) ? data.jobs : []);
      })
      .catch(() => {
        if (!cancelled) setCiJobs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Close the jobs menu on an outside click / Escape.
  useEffect(() => {
    if (!jobsMenuOpen) return undefined;
    const onPointerDown = (e) => {
      if (jobsMenuRef.current && !jobsMenuRef.current.contains(e.target)) {
        setJobsMenuOpen(false);
      }
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setJobsMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [jobsMenuOpen]);

  const readyToPush = isReadyToPush(status);
  const inFlight = isFinalizeInFlight(status) || optimisticBlock;
  const runId = run?.id ?? null;
  const hasCommittableChanges =
    worktreeCommittable || hasCommittableChangesFromReady(pendingChanges);
  const canShip = hasCommittableChanges || readyToPush;
  const noChangesHint = noCommittableChangesTooltip(worktreeBranch || branchLabel);

  const handleStart = useCallback(
    async (mode, { jobs = null } = {}) => {
      // A run already in flight blocks a second trigger; a prior
      // `ready_to_push` row does NOT — the other split button may still
      // run its phase (modes are distinct idempotency keys server-side).
      if (inFlight || !canShip) return;
      if (!projectId || !sessionId) return;
      setJobsMenuOpen(false);
      // A single-job run is always checks-scoped (the server forces it too).
      const effectiveMode = jobs && jobs.length ? 'checks' : mode;
      setOptimisticBlock(true);
      setPendingMode(effectiveMode);
      if (optimisticTimerRef.current) clearTimeout(optimisticTimerRef.current);
      optimisticTimerRef.current = setTimeout(() => {
        setOptimisticBlock(false);
        setPendingMode(null);
      }, OPTIMISTIC_BLOCK_MS);
      // Only attach `jobs` for an actual single-job run so the full-suite
      // call shape stays `{ mode }` (the server treats a missing/empty filter
      // as "run everything").
      const payload = jobs && jobs.length ? { mode: effectiveMode, jobs } : { mode: effectiveMode };
      try {
        if (cardId) {
          await api.startFinalizeRun(projectId, cardId, payload);
        } else {
          await api.startFinalizeRunForSession(projectId, sessionId, payload);
        }
      } catch (err) {
        if (optimisticTimerRef.current) {
          clearTimeout(optimisticTimerRef.current);
          optimisticTimerRef.current = null;
        }
        setOptimisticBlock(false);
        setPendingMode(null);
        onError?.(err?.message || 'Failed to start runner');
      }
    },
    [inFlight, canShip, projectId, cardId, sessionId, onError],
  );

  // A phase's done-state is only "fresh" while the commit it validated is
  // still the worktree HEAD. Once the session lands a new commit, HEAD moves
  // and the prior "Tested" / "Reviewed" badge is stale — the phase must run
  // again. Before the first worktree poll resolves (`worktreeHeadSha` null)
  // we trust the server's status to avoid a flash of "Run Tests".
  const phaseFresh = (summary) => {
    if (!phasePassed(summary)) return false;
    if (!worktreeHeadSha) return true;
    return summary?.validated_head_sha === worktreeHeadSha;
  };

  // Independent per-phase done-state. The two phases may come from separate
  // runs ("Run Tests" then "Reviewer") or from one combined `full` run.
  const tested = phaseFresh(phases?.checks);
  const reviewed = phaseFresh(phases?.review);
  // The branch is fully validated only when BOTH phases passed against the
  // SAME (still-current) commit — a combined `full` run, or two phase runs
  // with no commits in between (matching `validated_head_sha`). This is what
  // unlocks a confirm-free push.
  const bothValidated =
    tested &&
    reviewed &&
    !!phases?.checks?.validated_head_sha &&
    phases.checks.validated_head_sha === phases?.review?.validated_head_sha;

  const handlePush = useCallback(async () => {
    // Push is only meaningful when there's something to push — uncommitted or
    // unpushed work. A clean, fully-pushed branch leaves the button disabled.
    if (!projectId || !sessionId || pushPending || !hasCommittableChanges) return;

    // Only a fully-validated branch (reviewer approved AND checks green on
    // the same commit) unlocks a confirm-free push. A single phase ("Run
    // Tests" or "Reviewer" only) still warns before pushing — the other
    // gate has not been satisfied. Fall back to the legacy single-run
    // check when the phase summary is unavailable (e.g. prefetch path).
    const fullyValidated = phases ? bothValidated : readyToPush && run?.mode === 'full';
    if (!fullyValidated) {
      const ok = window.confirm(
        'Review and checks have not both passed. Push branch and open PR on GitHub anyway?',
      );
      if (!ok) return;
    }

    setPushPending(true);
    try {
      if (runId && readyToPush) {
        await api.pushFinalizeRun(projectId, runId);
      } else if (runId) {
        await api.pushFinalizeRun(projectId, runId, { force: true });
      } else {
        await api.pushSessionToGithub(projectId, sessionId, { force: true });
      }
    } catch (err) {
      onError?.(err?.message || 'Failed to push to GitHub');
    } finally {
      setPushPending(false);
    }
  }, [
    projectId,
    sessionId,
    runId,
    readyToPush,
    run?.mode,
    phases,
    bothValidated,
    pushPending,
    hasCommittableChanges,
    onError,
  ]);

  // Stop an in-flight phase. The server trips the orchestrator's cancel
  // signal, kills the session's agent turn, and broadcasts the terminal
  // state — so all turns halt and the session waits for user input.
  const handleStop = useCallback(async () => {
    if (!projectId || !runId || stopping) return;
    setStopping(true);
    try {
      await api.cancelFinalizeRun(projectId, runId);
    } catch (err) {
      onError?.(err?.message || 'Failed to stop runner');
    } finally {
      setStopping(false);
    }
  }, [projectId, runId, stopping, onError]);

  const compact = variant === 'compact';
  const runningStep = steps.find((s) => s.state === 'running');
  let phaseLabel = inFlight
    ? optimisticBlock && !isFinalizeInFlight(status)
      ? 'queued'
      : describeRunPhase(status, phase)
    : null;
  if (inFlight && runningStep && status === 'running') {
    phaseLabel = `${phaseLabel}: ${runningStep.name}`;
  }

  // Which split run (if any) is currently executing. `full` runs (started
  // by automation or the legacy combined path) light up both buttons so the
  // operator sees activity. Before the run row lands we fall back to the
  // optimistically-recorded `pendingMode` so the clicked button spins
  // immediately.
  const activeMode = run?.mode ?? (optimisticBlock ? pendingMode : null);
  const checksBusy = inFlight && (activeMode === 'checks' || activeMode === 'full');
  const reviewBusy = inFlight && (activeMode === 'review' || activeMode === 'full');

  const baseBtnClasses = compact
    ? 'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors'
    : 'inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-colors';
  // While a phase runs its trigger flips into a red "Stop" affordance.
  const triggerClasses = (busy, passed) => {
    if (busy) {
      return `${baseBtnClasses} border-red-700/60 bg-red-950/40 text-red-100 hover:bg-red-900/50 hover:text-white ${
        stopping ? 'cursor-wait opacity-90' : 'cursor-pointer'
      }`;
    }
    return `${baseBtnClasses} border-purple-700/60 bg-purple-950/40 ${
      !canShip
        ? 'text-purple-300/50 cursor-not-allowed opacity-60'
        : passed
          ? 'text-emerald-200/90 hover:bg-purple-900/50'
          : 'text-purple-100 hover:bg-purple-900/50 hover:text-white'
    }`;
  };
  const pushClasses = `${baseBtnClasses} border-emerald-700/60 bg-emerald-950/40 text-emerald-100 hover:bg-emerald-900/50 hover:text-white disabled:opacity-60 disabled:cursor-not-allowed`;

  const triggerDisabled = inFlight || !canShip;
  // A busy phase can only be stopped once its run row (with an id) has landed.
  const checksStoppable = checksBusy && !!runId && !stopping;
  const reviewStoppable = reviewBusy && !!runId && !stopping;
  const runTestsLabel = checksBusy ? 'Stop Tests' : tested ? 'Tested' : 'Run Tests';
  // The dropdown caret only appears when the worktree's ci.yaml exposes
  // selectable v2 jobs. Disabled whenever the main trigger is.
  const showJobsCaret = ciJobs.length > 0;
  const reviewerLabel = reviewBusy ? 'Stop Reviewing' : reviewed ? 'Reviewed' : 'Reviewer';
  const noChangesOr = (active) => (!canShip ? noChangesHint : active);
  const activeSuffix =
    typeof activeSeconds === 'number' ? ` · ${formatDuration(activeSeconds)} active` : '';

  const showPush = githubConnected && sessionId;

  return (
    <div className="relative inline-flex items-center gap-1">
      <div className="relative inline-flex" ref={jobsMenuRef}>
        <button
          type="button"
          onClick={checksBusy ? handleStop : () => handleStart('checks')}
          disabled={checksBusy ? !checksStoppable : triggerDisabled}
          title={
            compact
              ? undefined
              : checksBusy
                ? `Stop tests — halts the run and waits for input (running checks: ${phaseLabel}${activeSuffix})`
                : noChangesOr(
                    tested
                      ? 'CI checks passed — run again to re-test'
                      : `Rebase and run CI checks${branchLabel ? ` · ${branchLabel}` : ''} (does not push)`,
                  )
          }
          aria-label={runTestsLabel}
          aria-busy={checksBusy}
          data-testid="finalize-run-tests-button"
          className={`${triggerClasses(checksBusy, tested)}${
            showJobsCaret ? ' !rounded-r-none' : ''
          }`}
        >
          {checksBusy ? (
            checksStoppable ? (
              <Square size={compact ? 12 : 14} className="shrink-0 fill-current" />
            ) : (
              <Loader2 size={compact ? 12 : 14} className="animate-spin shrink-0" />
            )
          ) : tested ? (
            <CheckCircle2 size={compact ? 12 : 14} className="shrink-0 text-emerald-400" />
          ) : (
            <FlaskConical size={compact ? 12 : 14} />
          )}
          {runTestsLabel}
        </button>
        {showJobsCaret ? (
          <>
            <button
              type="button"
              onClick={() => setJobsMenuOpen((v) => !v)}
              disabled={triggerDisabled}
              title="Run a single CI job (debugging) — does not count toward Tested"
              aria-label="Choose a single test to run"
              aria-haspopup="menu"
              aria-expanded={jobsMenuOpen}
              data-testid="finalize-run-tests-caret"
              className={`${triggerClasses(false, tested)} !rounded-l-none -ml-px px-1.5`}
            >
              <ChevronDown size={compact ? 12 : 14} className="shrink-0" />
            </button>
            {jobsMenuOpen ? (
              <div
                role="menu"
                data-testid="finalize-run-tests-menu"
                className="absolute left-0 top-full mt-1 z-50 w-60 max-h-72 overflow-y-auto rounded-lg border border-gray-700 bg-gray-800 py-1 shadow-xl"
              >
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-400">
                  Run one job (deps run first)
                </div>
                {ciJobs.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    role="menuitem"
                    disabled={triggerDisabled}
                    onClick={() => handleStart('checks', { jobs: [job.id] })}
                    data-testid={`finalize-run-job-${job.id}`}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-gray-100 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="truncate font-medium">{job.id}</span>
                    {Array.isArray(job.needs) && job.needs.length > 0 ? (
                      <span className="shrink-0 text-[10px] text-gray-400">
                        needs {job.needs.join(', ')}
                      </span>
                    ) : null}
                  </button>
                ))}
                <div className="mt-1 border-t border-gray-700 px-3 pb-1 pt-1.5 text-[10px] leading-snug text-gray-500">
                  Single-job runs are for debugging. Run the full suite to mark Tested.
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <button
        type="button"
        onClick={reviewBusy ? handleStop : () => handleStart('review')}
        disabled={reviewBusy ? !reviewStoppable : triggerDisabled}
        title={
          compact
            ? undefined
            : reviewBusy
              ? `Stop reviewing — halts the run and waits for input (reviewing: ${phaseLabel}${activeSuffix})`
              : noChangesOr(
                  reviewed
                    ? 'Reviewer approved — run again to re-review'
                    : `Rebase and run the reviewer${branchLabel ? ` · ${branchLabel}` : ''} (does not push)`,
                )
        }
        aria-label={reviewerLabel}
        aria-busy={reviewBusy}
        data-testid="finalize-reviewer-button"
        className={triggerClasses(reviewBusy, reviewed)}
      >
        {reviewBusy ? (
          reviewStoppable ? (
            <Square size={compact ? 12 : 14} className="shrink-0 fill-current" />
          ) : (
            <Loader2 size={compact ? 12 : 14} className="animate-spin shrink-0" />
          )
        ) : reviewed ? (
          <CheckCircle2 size={compact ? 12 : 14} className="shrink-0 text-emerald-400" />
        ) : (
          <Eye size={compact ? 12 : 14} />
        )}
        {reviewerLabel}
      </button>
      {showPush ? (
        <button
          type="button"
          onClick={handlePush}
          disabled={pushPending || !hasCommittableChanges}
          title={
            compact
              ? undefined
              : !hasCommittableChanges
                ? noChangesHint
                : bothValidated
                  ? 'Review and checks passed — push branch and open PR on GitHub'
                  : 'Push anyway (review and checks have not both passed)'
          }
          aria-label="Push to GitHub"
          aria-busy={pushPending}
          data-testid="finalize-push-to-github-button"
          className={pushClasses}
        >
          {pushPending ? (
            <Loader2 size={compact ? 12 : 14} className="animate-spin shrink-0" />
          ) : (
            <Upload size={compact ? 12 : 14} />
          )}
          Push to GitHub
        </button>
      ) : null}
    </div>
  );
}
