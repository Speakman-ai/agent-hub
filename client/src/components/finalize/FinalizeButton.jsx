import { useCallback, useEffect, useRef, useState } from 'react';
import { GitPullRequest, Loader2, Upload, X, CheckCircle2 } from 'lucide-react';
import {
  useFinalizeRun,
  isFinalizeBlocked,
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
  const { run, steps, status, phase, activeSeconds } = useFinalizeRun({
    sessionId,
    prefetchedRun,
    enabled: !!sessionId,
  });

  const [optimisticBlock, setOptimisticBlock] = useState(false);
  const [pushPending, setPushPending] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [worktreeCommittable, setWorktreeCommittable] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState(null);
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
          }
        })
        .catch(() => {
          if (!cancelled) {
            setWorktreeCommittable(false);
            setWorktreeBranch(null);
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
  const blocked = isFinalizeBlocked(status) || optimisticBlock;
  const runId = run?.id ?? null;
  const hasCommittableChanges =
    worktreeCommittable || hasCommittableChangesFromReady(pendingChanges);
  const canShip = hasCommittableChanges || readyToPush;
  const noChangesHint = noCommittableChangesTooltip(worktreeBranch || branchLabel);

  const handleStart = useCallback(async () => {
    if (blocked || readyToPush || !canShip) return;
    if (!projectId || !sessionId) return;
    setOptimisticBlock(true);
    if (optimisticTimerRef.current) clearTimeout(optimisticTimerRef.current);
    optimisticTimerRef.current = setTimeout(() => {
      setOptimisticBlock(false);
    }, OPTIMISTIC_BLOCK_MS);
    try {
      if (cardId) {
        await api.startFinalizeRun(projectId, cardId);
      } else {
        await api.startFinalizeRunForSession(projectId, sessionId);
      }
    } catch (err) {
      if (optimisticTimerRef.current) {
        clearTimeout(optimisticTimerRef.current);
        optimisticTimerRef.current = null;
      }
      setOptimisticBlock(false);
      onError?.(err?.message || 'Failed to start Finalize Code Changes');
    }
  }, [blocked, readyToPush, canShip, projectId, cardId, sessionId, onError]);

  const handlePush = useCallback(async () => {
    if (!projectId || !sessionId || pushPending || !canShip) return;

    const needsConfirm = !readyToPush;
    if (needsConfirm) {
      const ok = window.confirm(
        'Finalize checks have not passed. Push branch and open PR on GitHub anyway?',
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
  }, [projectId, sessionId, runId, readyToPush, pushPending, canShip, onError]);

  const handleCancel = useCallback(async () => {
    if (!projectId || !runId) return;
    try {
      await api.cancelFinalizeRun(projectId, runId);
    } catch (err) {
      onError?.(err?.message || 'Failed to cancel Finalize Code Changes');
    }
  }, [projectId, runId, onError]);

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

  const finalizeLabel = readyToPush
    ? 'Checks passed'
    : inFlight
      ? `Finalizing: ${phaseLabel}`
      : 'Finalize Code Changes';
  const baseBtnClasses = compact
    ? 'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors'
    : 'inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-colors';
  const finalizeClasses = `${baseBtnClasses} border-purple-700/60 bg-purple-950/40 ${
    inFlight
      ? 'text-purple-200/80 cursor-wait opacity-90'
      : readyToPush
        ? 'text-emerald-200/90 cursor-not-allowed opacity-95'
        : !canShip
          ? 'text-purple-300/50 cursor-not-allowed opacity-60'
          : 'text-purple-100 hover:bg-purple-900/50 hover:text-white'
  }`;
  const pushClasses = `${baseBtnClasses} border-emerald-700/60 bg-emerald-950/40 text-emerald-100 hover:bg-emerald-900/50 hover:text-white disabled:opacity-60 disabled:cursor-not-allowed`;

  const tooltipParts = [];
  if (readyToPush) {
    tooltipParts.push('Review and checks passed — push when ready');
  } else if (inFlight) {
    tooltipParts.push(`Finalizing: ${phaseLabel}`);
    if (typeof activeSeconds === 'number') {
      tooltipParts.push(`${formatDuration(activeSeconds)} active`);
    }
  } else if (!canShip) {
    tooltipParts.push(noChangesHint);
  } else {
    tooltipParts.push('Rebase, review, and run tests (does not push to GitHub)');
    if (branchLabel) tooltipParts.push(branchLabel);
  }

  const showPush = githubConnected && sessionId;

  return (
    <div className="relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={handleStart}
        disabled={blocked || readyToPush || !canShip}
        title={compact ? undefined : tooltipParts.join(' · ')}
        aria-label={finalizeLabel}
        aria-busy={inFlight}
        data-testid="finalize-code-changes-button"
        className={finalizeClasses}
      >
        {inFlight ? (
          <Loader2 size={compact ? 12 : 14} className="animate-spin shrink-0" />
        ) : readyToPush ? (
          <CheckCircle2 size={compact ? 12 : 14} className="shrink-0 text-emerald-400" />
        ) : (
          <GitPullRequest size={compact ? 12 : 14} />
        )}
        {finalizeLabel}
      </button>
      {showPush ? (
        <button
          type="button"
          onClick={handlePush}
          disabled={pushPending || !canShip}
          title={
            compact
              ? undefined
              : !canShip
                ? noChangesHint
                : readyToPush
                  ? 'Push branch and open PR on GitHub'
                  : 'Push anyway (Finalize checks have not passed)'
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
      {inFlight && runId && !readyToPush ? (
        <button
          type="button"
          onClick={handleCancel}
          className="text-[11px] text-gray-400 hover:text-gray-200 px-1"
          title="Cancel"
          aria-label="Cancel"
          data-testid="finalize-code-changes-cancel"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}
