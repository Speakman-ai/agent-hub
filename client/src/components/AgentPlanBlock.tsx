import { useMemo } from 'react';
import { ListChecks } from 'lucide-react';
import { agentPlanAnchorId, parseAgentPlanMetadata } from '@shared/utils/agentPlan';
import { relativeTime } from '../utils/time';

/** Plan the agent recited mid-turn via `<agenthub:plan>`; written by `server/agent-plan.ts`. */
export default function AgentPlanBlock({ message }: any) {
  const meta = useMemo(() => parseAgentPlanMetadata(message.metadata), [message.metadata]);
  if (!meta) return null;
  return (
    <div
      className="flex justify-center mb-4"
      data-testid="agent-plan-block"
      data-message-id={message.id}
      data-timeline-anchor={message.id ? agentPlanAnchorId(String(message.id)) : undefined}
      aria-label="Plan"
    >
      <div className="max-w-[95%] sm:max-w-[90%] w-full bg-violet-950/30 border border-violet-800/50 rounded-xl px-4 py-3">
        <header className="flex items-center gap-2 mb-2">
          <ListChecks size={14} className="text-violet-300" aria-hidden />
          <span className="text-sm font-medium text-violet-200">Plan</span>
        </header>
        <p
          data-testid="agent-plan-text"
          className="whitespace-pre-wrap break-words text-xs text-slate-300"
        >
          {meta.plan}
        </p>
        {message.created_at ? (
          <div className="text-[11px] text-gray-600 mt-2">{relativeTime(message.created_at)}</div>
        ) : null}
      </div>
    </div>
  );
}
