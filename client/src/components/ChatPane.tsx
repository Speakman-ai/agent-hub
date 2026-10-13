import { useEffect, type ReactNode } from 'react';
import { OPEN_CHAT_SPACE_EVENT, hasPendingOpenChatSpace } from '../utils/googleChatNotifications';
import { formatUnreadCount } from '../utils/googleChatPush';
import {
  effectiveChatPaneSide,
  setChatPaneSide,
  useChatPaneSide,
  type ChatPaneSide,
} from '../utils/chatPaneSide';
import HubChatPage from './HubChatPage';
import type { HubChatRefOpenHandler } from './HubChatRefs';
import type { SessionWire } from '@shared/types';

export type { ChatPaneSide } from '../utils/chatPaneSide';

/**
 * The Hub Chat pane: Agent Hub chat by default, with Google Chat one toggle
 * away when the user can read it (`google` is omitted otherwise). The last
 * choice is remembered. A clicked Google Chat notification flips to the
 * Google side so the requested space opens.
 */
export default function ChatPane({
  google,
  hubUnread = 0,
  googleUnread = 0,
  onOpenRef,
  onSessionStarted,
}: {
  google?: ReactNode;
  hubUnread?: number;
  googleUnread?: number;
  /** Opens the card, session, PR or ticket behind a clicked chat chip. */
  onOpenRef?: HubChatRefOpenHandler;
  /** Opens the session a message's Send to agent started. */
  onSessionStarted?: (session: SessionWire) => void;
}) {
  const googleAvailable = google !== undefined && google !== null;
  const chosen = useChatPaneSide();
  const side = effectiveChatPaneSide(chosen, googleAvailable);

  useEffect(() => {
    if (googleAvailable && hasPendingOpenChatSpace()) setChatPaneSide('google');
    const onOpenSpace = () => setChatPaneSide('google');
    window.addEventListener(OPEN_CHAT_SPACE_EVENT, onOpenSpace);
    return () => window.removeEventListener(OPEN_CHAT_SPACE_EVENT, onOpenSpace);
  }, [googleAvailable]);

  const tab = (id: ChatPaneSide, label: string, unread: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={side === id}
      data-testid={`chat-pane-${id}`}
      onClick={() => setChatPaneSide(id)}
      className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium ${
        side === id ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
      }`}
    >
      {label}
      {unread > 0 && (
        <span
          data-testid={`chat-pane-${id}-badge`}
          aria-label={`${unread} unread`}
          className="min-w-[1rem] rounded-full bg-blue-600 px-1 text-center text-[10px] font-semibold leading-4 text-white"
        >
          {formatUnreadCount(unread)}
        </span>
      )}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-gray-950">
      {googleAvailable && (
        <div className="flex shrink-0 justify-center border-b border-gray-800 px-4 py-2">
          <div
            role="tablist"
            aria-label="Chat source"
            className="flex gap-1 rounded-md bg-gray-900 p-0.5"
          >
            {tab('hub', 'Agent Hub', hubUnread)}
            {tab('google', 'Google Chat', googleUnread)}
          </div>
        </div>
      )}
      {side === 'hub' || !googleAvailable ? (
        <HubChatPage onOpenRef={onOpenRef} onSessionStarted={onSessionStarted} />
      ) : (
        google
      )}
    </div>
  );
}
