import { memo } from 'react';
import { GitFork, AlertTriangle, Loader2, AlertCircle, Slash } from 'lucide-react';
import { DELEGATE_REQUIRED_FIELDS } from '../utils/coordinationBlocks.js';

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
 *                          { parentMessageId, tasks: Array<{ agentId, status, agentName, agentColor }> }
 *                        When present AND the live snapshot's `parentMessageId`
 *                        matches this card's `parentMessageId` (or either is
 *                        unknown — backwards-compatible fallback), we correlate
 *                        by `agentId` and render real per-task statuses. When
 *                        the snapshot belongs to a *different* delegate round
 *                        in the same session (newer round started), we render
 *                        an "Older round" badge instead of misleading "Queued"
 *                        rows that will never resolve.
 *   parentMessageId    — optional id of the assistant message that emitted this
 *                        delegate block. Used to correlate live snapshots to
 *                        the correct round. Without it, we conservatively
 *                        accept any snapshot (legacy callers).
 *   parentSessionActive — optional boolean. `true` while the parent assistant
 *                        message is still streaming or its session is in-flight
 *                        (we genuinely *are* awaiting dispatch). `false` for
 *                        historical / closed-turn renders — when no live row
 *                        exists in that case, dispatch almost certainly never
 *                        started (filtered out, errored before broadcast, or
 *                        session crashed) and we should say so instead of
 *                        showing an indefinite "Queued" spinner.
 *   dispatchError      — optional `{ message, parentMessageId?, kind? }` describing a
 *                        `delegation_error` or `delegation_disabled` broadcast
 *                        for this session. When `kind === 'disabled'` we render
 *                        an informational amber banner ("Delegation disabled:
 *                        …") because the operator gate fired — no sub-agent
 *                        actually failed; dispatch was intentionally skipped.
 *                        Otherwise (`kind` undefined or any other value) we
 *                        render the red "Dispatch failed: …" banner. The
 *                        parent-id correlation is the same in both cases.
 */
function DelegateCard({
  tasks,
  malformed,
  malformedReasonText,
  agents,
  sessionDelegations,
  parentMessageId,
  parentSessionActive,
  dispatchError,
}) {
  if (malformed && !tasks) {
    const rawBody = malformed.rawBody || '';
    const rows = Array.isArray(malformed.rows) ? malformed.rows : [];
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
        {rows.length > 0 && (
          <div className="px-4 py-3 border-b border-red-800/20">
            <div
              className="text-[10px] uppercase tracking-wide text-red-200/60 mb-1.5"
              data-testid="delegate-missing-fields-heading"
            >
              Missing fields per row
            </div>
            <ul className="space-y-1.5" data-testid="delegate-missing-fields-list">
              {rows.map((row, i) => {
                const label = row?.agentId || `row ${i + 1}`;
                const missing = Array.isArray(row?.missing) ? row.missing : [];
                return (
                  <li
                    key={`${label}-${i}`}
                    className="text-xs text-gray-300 flex flex-wrap items-baseline gap-2"
                    data-testid="delegate-missing-field-row"
                  >
                    <span className="font-medium text-red-200">{label}</span>
                    {missing.length === 0 ? (
                      <span className="text-emerald-300">ok</span>
                    ) : (
                      <span className="text-gray-400">
                        missing:{' '}
                        <code className="text-red-300 bg-red-950/40 rounded px-1 py-0.5">
                          {missing.join(', ')}
                        </code>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="px-4 py-3 border-b border-red-800/20">
          <div className="text-[10px] uppercase tracking-wide text-red-200/60 mb-1.5">
            Required contract
          </div>
          <code
            className="text-[11px] text-gray-300 bg-gray-900/60 rounded px-2 py-1 inline-block"
            data-testid="delegate-required-contract"
          >
            {DELEGATE_REQUIRED_FIELDS.join(', ')}
          </code>
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
            were spawned. Re-emit with the full contract above to retry.
          </p>
        </div>
      </div>
    );
  }

  if (!Array.isArray(tasks) || tasks.length === 0) return null;

  const liveTasks = Array.isArray(sessionDelegations?.tasks) ? sessionDelegations.tasks : [];
  // Live snapshots are per-session, not per-round — `delegations[sessionId]`
  // gets *replaced* on every `delegation_start`. So a snapshot whose
  // `parentMessageId` doesn't match this card's anchor belongs to a *different*
  // delegate round and its statuses must NOT be applied to this card's rows.
  // When either side's parentMessageId is unknown we fall back to the legacy
  // "trust the snapshot" behaviour to stay backwards-compatible.
  const liveParentId = sessionDelegations?.parentMessageId ?? null;
  const liveBelongsToThisRound =
    !parentMessageId || !liveParentId || liveParentId === parentMessageId;
  const hasLive = liveBelongsToThisRound && liveTasks.length > 0;

  // Surface a dispatch error banner only when it's plausibly *this* round's
  // failure (parent ids match, or one side is unknown — same compatibility
  // rule as the snapshot correlation above).
  const dispatchErrorActiveForRound =
    dispatchError &&
    typeof dispatchError === 'object' &&
    typeof dispatchError.message === 'string' &&
    dispatchError.message.length > 0 &&
    (!parentMessageId ||
      !dispatchError.parentMessageId ||
      dispatchError.parentMessageId === parentMessageId);
  // `kind: 'disabled'` is the operator-gate path (`delegationEnabled === false`).
  // We render an informational amber banner for this case and treat it as the
  // dominant fallback state below — once the gate fires, no row will ever get
  // a live status, so the per-row badge should match.
  const dispatchDisabled = dispatchErrorActiveForRound && dispatchError.kind === 'disabled';
  const dispatchErrorMessage =
    dispatchErrorActiveForRound && !dispatchDisabled ? dispatchError.message : null;
  const disabledBannerMessage =
    dispatchDisabled && typeof dispatchError.message === 'string' ? dispatchError.message : null;

  // Determine fallback badge state for rows with no matching live row.
  // - 'disabled': operator gate active (`delegationEnabled === false`) →
  //   dispatch was intentionally suppressed. Distinct from 'no-dispatch'
  //   because the operator chose this; nothing went wrong.
  // - 'awaiting-dispatch': parent session/turn is still active → server should
  //   broadcast `delegation_start` momentarily; current spinner is correct.
  // - 'older-round': a *newer* delegate round is in flight in the same session,
  //   so this card's live data was overwritten and will not return.
  // - 'no-dispatch': turn ended without any live data for this round →
  //   dispatch most likely never happened (no valid sub-agents, crash,
  //   filtered, etc.). Indefinite "Queued" was the bug.
  let fallbackState;
  if (dispatchDisabled) {
    fallbackState = 'disabled';
  } else if (!liveBelongsToThisRound) {
    fallbackState = 'older-round';
  } else if (parentSessionActive) {
    fallbackState = 'awaiting-dispatch';
  } else {
    fallbackState = 'no-dispatch';
  }

  return (
    <div
      data-testid="delegate-card"
      data-fallback-state={fallbackState}
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
      {dispatchErrorMessage && (
        <div
          data-testid="delegate-dispatch-error"
          className="flex items-start gap-2 px-4 py-2 bg-red-950/30 border-b border-red-800/30 text-[11px] text-red-200"
        >
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0 text-red-300" />
          <span>
            <span className="font-semibold">Dispatch failed:</span> {dispatchErrorMessage}
          </span>
        </div>
      )}
      {disabledBannerMessage && (
        <div
          data-testid="delegate-dispatch-disabled"
          className="flex items-start gap-2 px-4 py-2 bg-amber-950/30 border-b border-amber-800/30 text-[11px] text-amber-200"
        >
          <Slash size={12} className="mt-0.5 flex-shrink-0 text-amber-300" />
          <span>
            <span className="font-semibold">Delegation disabled:</span> {disabledBannerMessage}. The
            lead is configured to complete work inline — no sub-agents were spawned.
          </span>
        </div>
      )}
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
                <StatusBadge status={status} fallbackState={fallbackState} />
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

function StatusBadge({ status, fallbackState = 'awaiting-dispatch' }) {
  if (!status) {
    if (fallbackState === 'disabled') {
      return (
        <span
          data-testid="delegate-status-disabled"
          className="text-[11px] text-amber-300 font-medium inline-flex items-center gap-1"
          title="Delegation disabled for this lead — re-enable in agent settings to dispatch sub-agents."
        >
          <Slash size={11} />
          Disabled
        </span>
      );
    }
    if (fallbackState === 'no-dispatch') {
      // The parent turn ended without ever broadcasting `delegation_start` for
      // this round. Almost always means dispatch was filtered (no valid sub-
      // agents), the server crashed, or the session was cancelled before the
      // delegate block landed. Indefinite "Queued" was the bug — say what
      // happened so the user can act (re-emit, check sub-agent roster, etc.).
      return (
        <span
          data-testid="delegate-status-no-dispatch"
          className="text-[11px] text-amber-300 font-medium inline-flex items-center gap-1"
          title="Dispatch never started for this delegate block — sub-agent missing from roster, dispatch error, or session ended before kickoff. Re-emit the delegate block to retry."
        >
          <AlertCircle size={11} />
          Did not start
        </span>
      );
    }
    if (fallbackState === 'older-round') {
      // A *newer* delegate round is already in flight in the same session,
      // and `delegations[sessionId]` only stores one round at a time, so live
      // status for this card was overwritten and won't return.
      return (
        <span
          data-testid="delegate-status-older-round"
          className="text-[11px] text-gray-400 font-medium inline-flex items-center gap-1"
          title="Live status unavailable — a newer delegation round started in this session and replaced the live snapshot."
        >
          Older round
        </span>
      );
    }
    // Default: parent turn is still streaming, server should broadcast soon.
    return (
      <span
        data-testid="delegate-status-queued"
        className="text-[11px] text-indigo-300/80 font-medium inline-flex items-center gap-1"
        title="Awaiting dispatch confirmation from server"
      >
        <Loader2 size={11} className="animate-spin" />
        Awaiting dispatch
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
