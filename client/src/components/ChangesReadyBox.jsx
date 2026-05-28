import { useState, useEffect, useRef } from 'react';
import { GitPullRequest, Loader2 } from 'lucide-react';

/**
 * ChangesReadyBox — toolbar control to ship ad-hoc session work via POST /ship
 * (system callout + skill injection; no visible slash-command in chat).
 */
export default function ChangesReadyBox({
  sessionId,
  changes,
  onTrigger,
  onDismiss,
  isSessionProcessing = false,
}) {
  const branchLabel = changes?.branch || '';
  const [requestPending, setRequestPending] = useState(false);
  const [awaitingAgentTurn, setAwaitingAgentTurn] = useState(false);
  const sawProcessingRef = useRef(false);

  const isCreating = requestPending || awaitingAgentTurn;

  useEffect(() => {
    if (!awaitingAgentTurn) {
      sawProcessingRef.current = false;
      return;
    }
    if (isSessionProcessing) {
      sawProcessingRef.current = true;
      return;
    }
    if (sawProcessingRef.current) {
      setAwaitingAgentTurn(false);
      sawProcessingRef.current = false;
    }
  }, [awaitingAgentTurn, isSessionProcessing]);

  // Fail-open if the processing edge is never observed (fast turn / prop race).
  useEffect(() => {
    if (!awaitingAgentTurn) return undefined;
    const timer = setTimeout(() => setAwaitingAgentTurn(false), 120_000);
    return () => clearTimeout(timer);
  }, [awaitingAgentTurn]);

  const handleClick = async () => {
    if (isCreating) return;
    setRequestPending(true);
    try {
      await onTrigger?.(sessionId);
      setAwaitingAgentTurn(true);
    } catch {
      setAwaitingAgentTurn(false);
    } finally {
      setRequestPending(false);
    }
  };

  const label = isCreating ? 'Creating ticket & PR…' : 'Create ticket & PR';

  return (
    <div className="relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={isCreating}
        title={
          isCreating
            ? 'Create ticket & PR in progress'
            : branchLabel
              ? `Create ticket & PR for ${branchLabel}`
              : 'Create ticket & PR'
        }
        data-testid="create-ticket-pr-button"
        aria-busy={isCreating}
        className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-purple-700/60 bg-purple-950/40 transition-colors ${
          isCreating
            ? 'text-purple-200/80 cursor-wait opacity-90'
            : 'text-purple-100 hover:bg-purple-900/50 hover:text-white'
        }`}
      >
        {isCreating ? (
          <Loader2 size={14} className="animate-spin shrink-0" />
        ) : (
          <GitPullRequest size={14} />
        )}
        {label}
      </button>
      {onDismiss && !isCreating ? (
        <button
          type="button"
          onClick={() => onDismiss(sessionId)}
          className="text-[11px] text-gray-500 hover:text-gray-300 px-1"
          title="Dismiss changes ready hint"
          aria-label="Dismiss"
          data-testid="create-ticket-pr-dismiss"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
