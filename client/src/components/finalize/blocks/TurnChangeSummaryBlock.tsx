import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ClipboardCheck, FileDiff } from 'lucide-react';
import { parseTurnChangeSummaryMetadata } from '../../../utils/turnChangeSummary';
import { changeSummaryAnchorId } from '@shared/utils/sessionTimeline';
import { relativeTime } from '../../../utils/time';

/**
 * Post-turn change briefing: the prose summary + "Manual testing to perform"
 * checklist, rendered after an ordinary code-change turn. Deliberately the two
 * sections the Finalize summary carries, minus the finalize-only chrome
 * (reviewer verdict, follow-up session, commit list) — there is no push gate or
 * reviewer for a plain turn. Written by `server/turn-change-summary.ts`.
 */
export default function TurnChangeSummaryBlock({ message }: any) {
  const meta = useMemo(() => parseTurnChangeSummaryMetadata(message.metadata), [message.metadata]);
  const [collapsed, setCollapsed] = useState(false);

  if (!meta) return null;

  const manualTesting = meta.manualTesting ?? [];

  return (
    <div
      className="flex justify-center mb-4"
      data-testid="turn-change-summary-block"
      data-message-id={message.id}
      data-timeline-anchor={message.id ? changeSummaryAnchorId(String(message.id)) : undefined}
      aria-label="Change summary"
    >
      <div className="max-w-[95%] sm:max-w-[90%] w-full bg-slate-900/50 border border-slate-700/60 rounded-xl px-4 py-3">
        <header className="flex items-center justify-between gap-2 mb-2">
          <span className="text-sm font-medium text-slate-200">Change summary</span>
        </header>

        {meta.summary ? (
          <p
            data-testid="turn-change-summary-prose"
            className="mb-3 whitespace-pre-wrap break-words text-xs text-slate-300"
          >
            {meta.summary}
          </p>
        ) : null}

        <section
          data-testid="turn-change-summary-manual-testing"
          className="rounded border border-slate-700 bg-slate-800/40 overflow-hidden"
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-slate-200 hover:bg-slate-800"
            onClick={() => setCollapsed((c: boolean) => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight size={14} className="text-slate-500" />
            ) : (
              <ChevronDown size={14} className="text-slate-500" />
            )}
            <ClipboardCheck size={14} className="text-slate-500" />
            <span>Manual testing to perform</span>
            {manualTesting.length ? (
              <span className="ml-auto text-[10px] text-slate-500">{manualTesting.length}</span>
            ) : null}
          </button>
          {!collapsed ? (
            <div className="border-t border-slate-700/60 px-3 py-2 text-xs text-slate-300">
              {manualTesting.length ? (
                <ul className="space-y-1">
                  {manualTesting.map((step: string, i: number) => (
                    <li
                      key={`${i}-${step}`}
                      data-testid="turn-change-summary-manual-step"
                      className="flex gap-2"
                    >
                      <FileDiff size={12} className="mt-0.5 shrink-0 text-slate-600" />
                      <span className="break-words">{step}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-slate-500">
                  No manual testing steps were generated for this change.
                </p>
              )}
            </div>
          ) : null}
        </section>

        {message.created_at ? (
          <div className="text-[11px] text-gray-600 mt-2">{relativeTime(message.created_at)}</div>
        ) : null}
      </div>
    </div>
  );
}
