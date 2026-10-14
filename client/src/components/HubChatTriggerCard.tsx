import { ExternalLink, Zap } from 'lucide-react';
import { formatHubChatRefToken } from '@shared/utils/hubChatRefTokens';
import { hubChatRefHref } from '@shared/utils/hubChatRefs';
import { CHAT_TRIGGER_EVENT_INFO, type ChatTriggerCard } from '@shared/utils/chatTriggers';
import { getHubChatRef, useHubChatRefs } from '../utils/hubChatRefCache';
import { HubChatMessageBody, type HubChatRefOpenHandler } from './HubChatRefs';

const STATUS_TONE: Record<ChatTriggerCard['status'], string> = {
  success: 'border-emerald-700/60 bg-emerald-900/30 text-emerald-300',
  failure: 'border-red-700/60 bg-red-900/30 text-red-300',
  warning: 'border-amber-700/60 bg-amber-900/30 text-amber-300',
  waiting: 'border-blue-700/60 bg-blue-900/30 text-blue-300',
  info: 'border-gray-700 bg-gray-800 text-gray-300',
};

const STATUS_BAR: Record<ChatTriggerCard['status'], string> = {
  success: 'border-l-emerald-500',
  failure: 'border-l-red-500',
  warning: 'border-l-amber-500',
  waiting: 'border-l-blue-500',
  info: 'border-l-gray-600',
};

/**
 * A message posted by a project chat trigger: title, status badge, ref chips
 * with live status, the detail line, and an Open link to the main ref.
 */
export default function HubChatTriggerCard({
  card,
  onOpenRef,
}: {
  card: ChatTriggerCard;
  onOpenRef?: HubChatRefOpenHandler;
}) {
  useHubChatRefs(card.refs);
  const chips = card.refs
    .map((r) => formatHubChatRefToken(r.label, r.kind, r.targetId))
    .filter((t): t is string => !!t)
    .join(' ');
  const primary = card.refs[0] ? getHubChatRef(card.refs[0].kind, card.refs[0].targetId) : null;
  const href = primary ? hubChatRefHref(primary) : null;

  return (
    <div
      data-testid="hub-chat-trigger-card"
      data-status={card.status}
      className={`w-full min-w-[16rem] rounded-lg border border-gray-700 border-l-4 bg-gray-800/80 px-3 py-2 text-sm ${STATUS_BAR[card.status]}`}
    >
      <div className="flex items-start gap-2">
        <Zap size={14} className="mt-0.5 shrink-0 text-blue-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-gray-100">{card.title}</span>
            {card.statusLabel && (
              <span
                className={`rounded border px-1.5 py-px text-[11px] capitalize ${STATUS_TONE[card.status]}`}
              >
                {card.statusLabel}
              </span>
            )}
          </div>
          <div className="text-[11px] text-gray-500">
            {CHAT_TRIGGER_EVENT_INFO[card.event]?.label}
          </div>
        </div>
        {href && primary && (
          <a
            href={href}
            data-testid="hub-chat-trigger-open"
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-blue-300 hover:bg-blue-500/20"
            onClick={(e) => {
              if (!onOpenRef || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onOpenRef(primary);
            }}
          >
            Open
            <ExternalLink size={11} aria-hidden />
          </a>
        )}
      </div>
      {chips && (
        <div className="mt-1 markdown-content">
          <HubChatMessageBody body={chips} onOpenRef={onOpenRef} />
        </div>
      )}
      {card.detail && <p className="mt-1 break-words text-xs text-gray-300">{card.detail}</p>}
    </div>
  );
}
