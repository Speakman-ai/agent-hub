import { memo } from 'react';
import { GitFork, AlertTriangle, Loader2 } from 'lucide-react';

/**
 * DelegateCard
 * ------------
 * Renders a `<delegate>` block parsed out of an assistant message as a
 * persistent, compact summary of the delegated tasks.
 *
 * Motivation — why this card exists alongside `DelegationPanel`:
 * `DelegationPanel` is driven by *live* WebSocket events
 * (`delegation_start`, `delegation_thinking`, …). When those events are
 * dropped, delayed, or the user switches sessions mid-dispatch, the panel
 * never shows up and the user sees **nothing** — the `<delegate>` JSON is
 * silently stripped from the prose and no side panel appears. Users
 * reported this as "delegate is unreliable — often doesn't show up."
 *
 * This card is the persistent fallback. It is keyed off the message
 * content itself (which is persisted in the DB) so it always renders once
 * a delegate block has been parsed, regardless of WebSocket state. When
 * live delegation status *is* available via `sessionDelegations`, we
 * correlate by `agentId` and show it inline — otherwise we show a
 * "Queued…" placeholder.
 *
 * Malformed blocks (invalid JSON, missing fields) are rendered as a
 * failed-state card mirroring the HandoffCard error behaviour, so the
 * user knows the delegation intent was present but failed to parse.
 *
 * Props:
 *   tasks              — array of { agentId, task } from `parseDelegateBlock`.
 *                        When present, renders the success card.
 *   malformed          — { reason, rawBody } from `delegateMalformed`.
 *                        When present (and `tasks` is absent), renders the
 *                        failed-state card.
 *   malformedReasonText — human-readable string from `describeDelegateReason`.
 *   agents             — full agents list (from App state) used to resolve
 *                        `agentId` → display name + color.
 *   sessionDelegations — optional live status for this session:
 *                          { tasks: Array<{ agentId, status, agentName, agentColor }> }
 *                        When present, we correlate by agentId to show the
 *                        current status inline.
 */
function DelegateCard({ tasks, malformed, malformedReasonText, agents, sessionDelegations }) {
  if (malformed && !tasks) {
    const rawBody = malformed.rawBody || '';
    return (
      <div
        data-testid="delegate-card-failed"
        className="my-2 border border-red-800/40 rounded-xl bg-gradient-to-br from-red-950/30 to-gray-900/40 overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-950/30 border-b border-red-800/30">
          <GitFork size={14} className="text-red-400 flex-shrink-0" />
          <span className="text-xs font-semibold uppercase tracking-wide text-red-300/90">
            Delegate
          </span>
          <span className="text-[11px] text-red-300 inline-flex items-center gap-1 ml-1">
            <AlertTriangle size={11} />
            Failed — {malformedReasonText || 'Delegate block could not be parsed'}
          </span>
        </div>
        {rawBody && (
          <div className="px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-red-200/60 mb-1.5">
              Raw block
            </div>
            <pre
              data-testid="delegate-raw-body"
              className="text-xs text-gray-300 bg-gray-900/60 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all"
            >
              {rawBody}
            </pre>
          </div>
        )}
        <div className="px-4 pb-3 pt-1">
          <p className="text-[11px] text-gray-500 italic">
            The lead agent emitted a delegate block, but it couldn&apos;t be parsed — no sub-agents
            were spawned.
          </p>
        </div>
      </div>
    );
  }

  if (!Array.isArray(tasks) || tasks.length === 0) return null;

  const liveTasks = Array.isArray(sessionDelegations?.tasks) ? sessionDelegations.tasks : [];
  const hasLive = liveTasks.length > 0;

  return (
    <div
      data-testid="delegate-card"
      className="my-2 border border-indigo-800/40 rounded-xl bg-gradient-to-br from-indigo-950/30 to-gray-900/40 overflow-hidden"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 bg-indigo-950/30 border-b border-indigo-800/30">
        <GitFork size={14} className="text-indigo-300 flex-shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wide text-indigo-200/90">
          Delegate
        </span>
        <span className="text-xs text-gray-400">
          {tasks.length} sub-agent{tasks.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="divide-y divide-indigo-900/30">
        {tasks.map((t, i) => {
          const live = hasLive ? liveTasks.find((lt) => lt.agentId === t.agentId) : null;
          const agent = resolveAgent(t.agentId, agents);
          const name = live?.agentName || agent?.name || t.agentId;
          const color = live?.agentColor || agent?.color || '#6b7280';
          const status = live?.status || null;
          return (
            <li key={`${t.agentId}-${i}`} data-testid="delegate-task-row" className="px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
                <span className="text-sm font-medium text-gray-200 truncate flex-1">{name}</span>
                <StatusBadge status={status} />
              </div>
              <p className="text-xs text-gray-400 mt-1 ml-4 line-clamp-3">{t.task}</p>
            </li>
          );
        })}
      </ul>
      <div className="px-4 pb-3 pt-1">
        <p className="text-[11px] text-gray-500 italic">
          Parallel sub-agents — results are synthesized into the lead&apos;s next turn.
        </p>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  if (!status) {
    return (
      <span
        data-testid="delegate-status-queued"
        className="text-[11px] text-indigo-300/80 font-medium inline-flex items-center gap-1"
        title="Awaiting dispatch confirmation from server"
      >
        <Loader2 size={11} className="animate-spin" />
        Queued
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span
        data-testid="delegate-status-pending"
        className="text-[11px] text-gray-400 font-medium inline-flex items-center gap-1"
      >
        <Loader2 size={11} className="animate-spin" />
        Pending
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span
        data-testid="delegate-status-running"
        className="text-[11px] text-blue-300 font-medium inline-flex items-center gap-1"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
        Running
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span data-testid="delegate-status-done" className="text-[11px] text-emerald-300 font-medium">
        ✓ Done
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span
        data-testid="delegate-status-error"
        className="text-[11px] text-red-300 font-medium inline-flex items-center gap-1"
      >
        <AlertTriangle size={11} />
        Error
      </span>
    );
  }
  if (status === 'cancelled') {
    return (
      <span
        data-testid="delegate-status-cancelled"
        className="text-[11px] text-yellow-300 font-medium"
      >
        ⊘ Cancelled
      </span>
    );
  }
  return null;
}

function resolveAgent(agentId, agents) {
  if (!agentId || !Array.isArray(agents)) return null;
  return agents.find((a) => a?.id === agentId) ?? null;
}

export default memo(DelegateCard);
