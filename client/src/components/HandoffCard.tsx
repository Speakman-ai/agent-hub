import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowRight, Send, ExternalLink, AlertTriangle } from 'lucide-react';

/**
 * HandoffCard
 * -----------
 * Renders a `<handoff>` block as a compact, human-readable card instead of
 * the raw `<handoff>{...}</handoff>` JSON wall that ends up in saved
 * assistant message content.
 *
 * Visual: from-agent dot/name → to-agent dot/name, then the note rendered as
 * markdown (notes are typically multi-line with bullets and inline code).
 *
 * Props:
 *   note            — the handoff note, rendered as markdown.
 *   toAgentId       — required; the raw target agent id from the block.
 *   fromAgent       — { name, color } describing the source agent. Optional;
 *                     when omitted, the "from" side simply isn't labelled.
 *   agents          — full agents list (from App state) used to resolve
 *                     `toAgentId` → display name + color. Optional; falls
 *                     back to showing the raw id.
 *   handoff         — optional DB row for the handoff (from
 *                     GET /api/sessions/:sessionId/handoffs). When present we
 *                     use its resolved `to_agent_id` + `to_session_id` to
 *                     show a clickable "Open session" link; otherwise the
 *                     card renders without navigation (pre-delivery or
 *                     legacy messages).
 *   onOpenSession   — optional callback invoked as
 *                     `(agentId: any, sessionId: any) => void` when the user clicks
 *                     the "Open session" link.
 */
function HandoffCard({ note, toAgentId, fromAgent, agents, handoff, onOpenSession }: any) {
  // Prefer the resolved agent id stored on the DB row — the server's fuzzy
  // resolver rewrites things like "agent-hub-backend" to the real id. Fall
  // back to the raw block id so legacy / pre-delivery renders still work.
  const resolvedToAgentId = handoff?.to_agent_id || toAgentId;
  const toAgent = resolveAgent(resolvedToAgentId, agents);
  const fromName = fromAgent?.name ?? null;
  const fromColor = fromAgent?.color ?? '#6b7280';
  const toName = toAgent?.name ?? resolvedToAgentId;
  const toColor = toAgent?.color ?? '#6b7280';
  const toSessionId = handoff?.to_session_id ?? null;
  const status = handoff?.status ?? null;
  const errorText = handoff?.error ?? null;
  const canOpen = !!(toSessionId && resolvedToAgentId && typeof onOpenSession === 'function');

  return (
    <div
      data-testid="handoff-card"
      className="my-2 border border-amber-700/40 rounded-xl bg-gradient-to-br from-amber-950/30 to-gray-900/40 overflow-hidden"
    >
      {/* Header — from → to */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-950/30 border-b border-amber-800/30">
        <Send size={14} className="text-amber-400 flex-shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wide text-amber-300/90">
          Handoff
        </span>
        <div className="flex items-center gap-2 ml-1 min-w-0 flex-1 text-sm">
          {fromName && (
            <>
              <AgentChip name={fromName} color={fromColor} />
              <ArrowRight size={14} className="text-amber-400/70 flex-shrink-0" />
            </>
          )}
          <AgentChip name={toName} color={toColor} highlight />
        </div>
      </div>

      {/* Body — note */}
      <div className="px-4 py-3">
        <div className="text-[10px] uppercase tracking-wide text-amber-200/60 mb-1.5">Note</div>
        <div
          data-testid="handoff-note"
          className="markdown-content text-sm text-gray-200 leading-relaxed"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{note}</ReactMarkdown>
        </div>
      </div>

      {/* Footer — explanatory tagline + navigation link */}
      <div className="px-4 pb-3 pt-1 flex items-center gap-3 flex-wrap">
        <p className="text-[11px] text-gray-500 italic flex-1 min-w-[12rem]">
          Ownership transferred — the new session continues with the transcript above as context.
        </p>
        {canOpen && (
          <button
            type="button"
            data-testid="handoff-open-session"
            onClick={() => onOpenSession(resolvedToAgentId, toSessionId)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-900/40 hover:bg-amber-800/60 text-amber-100 border border-amber-700/50 transition-colors"
            title={`Open the ${toName} session started by this handoff`}
          >
            <ExternalLink size={12} />
            Open session
          </button>
        )}
        {!canOpen && status === 'pending' && (
          <span
            data-testid="handoff-pending"
            className="text-[11px] text-amber-300/70 font-medium inline-flex items-center gap-1"
          >
            <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
            Delivering…
          </span>
        )}
        {status === 'failed' && (
          <span
            data-testid="handoff-failed"
            className="text-[11px] text-red-300 font-medium inline-flex items-center gap-1"
            title={errorText || 'Handoff failed'}
          >
            <AlertTriangle size={11} />
            Failed{errorText ? ` — ${errorText}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function AgentChip({ name, color, highlight }: any) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium truncate ${
        highlight ? 'bg-amber-900/40 text-amber-100' : 'bg-gray-800/60 text-gray-300'
      }`}
      title={name}
    >
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <span className="truncate max-w-[12rem]">{name}</span>
    </span>
  );
}

function resolveAgent(agentId: any, agents: any) {
  if (!agentId || !Array.isArray(agents)) return null;
  return agents.find((a: any) => a?.id === agentId) ?? null;
}

export default memo(HandoffCard);
