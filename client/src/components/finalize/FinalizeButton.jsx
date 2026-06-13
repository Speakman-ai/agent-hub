import { useCallback, useEffect, useRef, useState } from 'react';
import { FlaskConical, Loader2, Upload, Square, CheckCircle2 } from 'lucide-react';
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

/**
 * Confirm-dialog copy for a not-fully-validated push. Resolve-PR sessions push
 * to an existing pull request (their worktree is pinned to the PR head branch),
 * so the wording must not promise a brand-new PR.
 */
export function pushConfirmMessage(isResolveSession) {
  return isResolveSession
    ? 'Review and checks have not both passed. Push to the existing pull request anyway?'
    : 'Review and checks have not both passed. Push branch and open PR on GitHub anyway?';
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
  /** True when the project's repo is hosted on Agent Hub (gitHost 'agenthub'). */
  hosted = false,
  /** True for `[Resolve PR #N]` sessions — push updates the existing PR. */
  isResolveSession = false,
}) {
  const { run, steps, phases, status, phase, activeSeconds } = useFinalizeRun({
    sessionId,
    prefetchedRun,
    enabled: !!sessionId,
  });

  const [optimisticBlock, setOptimisticBlock] = useState(false);
  const [pushPending, setPushPending] = useState(false);
  // True while a Stop request is in flight, so the stop button disables to
  // prevent double-cancel until the terminal broadcast lands.
  const [stopping, setStopping] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [worktreeCommittable, setWorktreeCommittable] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState(null);
  // Current worktree HEAD — used to expire a phase's done-state once new
  // commits land (the validated commit no longer matches HEAD).
  const [worktreeHeadSha, setWorktreeHeadSha] = useState(null);
  const optimisticTimerRef = useRef(null);

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

  const readyToPush = isReadyToPush(status);
  const inFlight = isFinalizeInFlight(status) || optimisticBlock;
  const runId = run?.id ?? null;
  const hasCommittableChanges =
    worktreeCommittable || hasCommittableChangesFromReady(pendingChanges);
  const canShip = hasCommittableChanges || readyToPush;
  const noChangesHint = noCommittableChangesTooltip(worktreeBranch || branchLabel);

  const handleStart = useCallback(async () => {
    // A run already in flight blocks a second trigger. A prior
    // `ready_to_push` row does NOT — re-running Finalize against new commits
    // is the normal re-validate path.
    if (inFlight || !canShip) return;
    if (!projectId || !sessionId) return;
    setOptimisticBlock(true);
    if (optimisticTimerRef.current) clearTimeout(optimisticTimerRef.current);
    optimisticTimerRef.current = setTimeout(() => {
      setOptimisticBlock(false);
    }, OPTIMISTIC_BLOCK_MS);
    try {
      // The single Finalize button always runs the full pipeline (rebase +
      // reviewer + checks). Push stays a separate, explicit gate.
      if (cardId) {
        await api.startFinalizeRun(projectId, cardId, { mode: 'full' });
      } else {
        await api.startFinalizeRunForSession(projectId, sessionId, { mode: 'full' });
      }
    } catch (err) {
      if (optimisticTimerRef.current) {
        clearTimeout(optimisticTimerRef.current);
        optimisticTimerRef.current = null;
      }
      setOptimisticBlock(false);
      onError?.(err?.message || 'Failed to start runner');
    }
  }, [inFlight, canShip, projectId, cardId, sessionId, onError]);

  // A validation is only "fresh" while the commit it validated is still the
  // worktree HEAD. Once the session lands a new commit, HEAD moves and the
  // prior done-state is stale — Finalize must run again. Before the first
  // worktree poll resolves (`worktreeHeadSha` null) we trust the server's
  // status to avoid a flash of "Finalize".
  const headFresh = (validatedHeadSha) => {
    if (!worktreeHeadSha) return true;
    return !!validatedHeadSha && validatedHeadSha === worktreeHeadSha;
  };

  const phaseFresh = (summary) => phasePassed(summary) && headFresh(summary?.validated_head_sha);

  const tested = phaseFresh(phases?.checks);
  const reviewed = phaseFresh(phases?.review);
  // The branch is fully validated only when BOTH phases passed against the
  // SAME (still-current) commit — a combined `full` run, or two legacy phase
  // runs with no commits in between (matching `validated_head_sha`).
  const bothValidated =
    tested &&
    reviewed &&
    !!phases?.checks?.validated_head_sha &&
    phases.checks.validated_head_sha === phases?.review?.validated_head_sha;

  // Single source of truth for "this branch is finalized" — reviewer approved
  // AND checks green on the same commit. Falls back to the legacy single-run
  // check when the per-phase summaries are unavailable (e.g. the prefetch
  // path delivers a `ready_to_push` full run with no `phases`). The fallback
  // is freshness-gated the same way `phaseFresh` is: once the worktree poll
  // resolves, the run must have validated the CURRENT HEAD — otherwise a new
  // commit since the run would leave "Finalized" stale and let Push skip its
  // confirmation. Both the button's done-state and the confirm-free push key
  // off this single value.
  const fullyValidated = phases
    ? bothValidated
    : readyToPush && run?.mode === 'full' && headFresh(run?.validated_head_sha);

  const handlePush = useCallback(async () => {
    // Push is only meaningful when there's something to push — uncommitted or
    // unpushed work. A clean, fully-pushed branch leaves the button disabled.
    if (!projectId || !sessionId || pushPending || !hasCommittableChanges) return;

    // Only a fully-validated branch unlocks a confirm-free push. Anything else
    // warns first — the test+reviewer gate has not been satisfied.
    if (!fullyValidated) {
      const ok = window.confirm(pushConfirmMessage(isResolveSession));
      if (!ok) return;
    }

    setPushPending(true);
    try {
      if (runId && fullyValidated) {
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
    fullyValidated,
    pushPending,
    hasCommittableChanges,
    onError,
    isResolveSession,
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

  const baseBtnClasses = compact
    ? 'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors'
    : 'inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-colors';
  // While the run executes its trigger flips into a red "Stop" affordance.
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
  // A busy run can only be stopped once its run row (with an id) has landed.
  const finalizeStoppable = inFlight && !!runId && !stopping;
  const finalizeLabel = inFlight ? 'Stop Finalize' : fullyValidated ? 'Finalized' : 'Finalize';
  const noChangesOr = (active) => (!canShip ? noChangesHint : active);
  const activeSuffix =
    typeof activeSeconds === 'number' ? ` · ${formatDuration(activeSeconds)} active` : '';

  const showPush = githubConnected && sessionId;

  return (
    <div className="relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={inFlight ? handleStop : handleStart}
        disabled={inFlight ? !finalizeStoppable : triggerDisabled}
        title={
          compact
            ? undefined
            : inFlight
              ? `Stop finalize — halts the run and waits for input (${phaseLabel}${activeSuffix})`
              : noChangesOr(
                  fullyValidated
                    ? 'Tests and reviewer passed — run again to re-finalize'
                    : `Rebase, run CI checks and the reviewer${
                        branchLabel ? ` · ${branchLabel}` : ''
                      } (does not push)`,
                )
        }
        aria-label={finalizeLabel}
        aria-busy={inFlight}
        data-testid="finalize-button"
        className={triggerClasses(inFlight, fullyValidated)}
      >
        {inFlight ? (
          finalizeStoppable ? (
            <Square size={compact ? 12 : 14} className="shrink-0 fill-current" />
          ) : (
            <Loader2 size={compact ? 12 : 14} className="animate-spin shrink-0" />
          )
        ) : fullyValidated ? (
          <CheckCircle2 size={compact ? 12 : 14} className="shrink-0 text-emerald-400" />
        ) : (
          <FlaskConical size={compact ? 12 : 14} />
        )}
        {finalizeLabel}
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
                : fullyValidated
                  ? `Review and checks passed — push branch and open PR on ${hosted ? 'Agent Hub' : 'GitHub'}`
                  : 'Push anyway (review and checks have not both passed)'
          }
          aria-label={hosted ? 'Push to Agent Hub' : 'Push to GitHub'}
          aria-busy={pushPending}
          data-testid="finalize-push-to-github-button"
          className={pushClasses}
        >
          {pushPending ? (
            <Loader2 size={compact ? 12 : 14} className="animate-spin shrink-0" />
          ) : (
            <Upload size={compact ? 12 : 14} />
          )}
          {hosted ? 'Push to Agent Hub' : 'Push to GitHub'}
        </button>
      ) : null}
    </div>
  );
}
