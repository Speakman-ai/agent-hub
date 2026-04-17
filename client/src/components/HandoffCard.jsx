import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowRight, Send } from 'lucide-react';

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
 */
function HandoffCard({ note, toAgentId, fromAgent, agents }) {
  const toAgent = resolveAgent(toAgentId, agents);
  const fromName = fromAgent?.name ?? null;
  const fromColor = fromAgent?.color ?? '#6b7280';
  const toName = toAgent?.name ?? toAgentId;
  const toColor = toAgent?.color ?? '#6b7280';

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

      {/* Footer — explanatory tagline */}
      <div className="px-4 pb-2 -mt-1">
        <p className="text-[11px] text-gray-500 italic">
          Ownership transferred — the new session continues with the transcript above as context.
        </p>
      </div>
    </div>
  );
}

function AgentChip({ name, color, highlight }) {
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

function resolveAgent(agentId, agents) {
  if (!agentId || !Array.isArray(agents)) return null;
  return agents.find((a) => a?.id === agentId) ?? null;
}

export default memo(HandoffCard);
