import { useEffect, useState, type ReactNode } from 'react';
import { OPEN_CHAT_SPACE_EVENT, hasPendingOpenChatSpace } from '../utils/googleChatNotifications';
import HubChatPage from './HubChatPage';

export type ChatPaneSide = 'hub' | 'google';

/**
 * The Hub Chat pane: Agent Hub chat by default, with Google Chat one toggle
 * away. A clicked Google Chat notification flips to the Google side so the
 * requested space opens.
 */
export default function ChatPane({ google }: { google: ReactNode }) {
  const [side, setSide] = useState<ChatPaneSide>(() =>
    hasPendingOpenChatSpace() ? 'google' : 'hub',
  );

  useEffect(() => {
    const onOpenSpace = () => setSide('google');
    window.addEventListener(OPEN_CHAT_SPACE_EVENT, onOpenSpace);
    return () => window.removeEventListener(OPEN_CHAT_SPACE_EVENT, onOpenSpace);
  }, []);

  const tab = (id: ChatPaneSide, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={side === id}
      data-testid={`chat-pane-${id}`}
      onClick={() => setSide(id)}
      className={`rounded px-3 py-1 text-xs font-medium ${
        side === id ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-gray-950">
      <div className="flex shrink-0 justify-center border-b border-gray-800 px-4 py-2">
        <div
          role="tablist"
          aria-label="Chat source"
          className="flex gap-1 rounded-md bg-gray-900 p-0.5"
        >
          {tab('hub', 'Agent Hub')}
          {tab('google', 'Google Chat')}
        </div>
      </div>
      {side === 'hub' ? <HubChatPage /> : google}
    </div>
  );
}
