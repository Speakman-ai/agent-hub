import { useEffect, useRef, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { api } from '../utils/api';
import { relativeTime } from '../utils/time';
import {
  messageAffectsBacklinks,
  type HubChatBacklink,
  type HubChatBacklinkKind,
  type HubChatMessage,
} from '@shared/utils/hubChat';
import { hubChatMessageHash } from '@shared/utils/hubChatCapture';

/**
 * "Discussed in chat": Agent Hub chat messages that reference a card, PR,
 * session or ticket. The server returns only messages in channels the viewer
 * can read, so this renders nothing for someone without access. Refreshes when
 * a live chat event references the target or changes a listed message.
 */

const NO_BACKLINKS: HubChatBacklink[] = [];

type Props = {
  kind: HubChatBacklinkKind;
  targetId: string | null | undefined;
  /** `menu` is a header chip that opens the list in a dropdown. */
  variant?: 'section' | 'menu';
  className?: string;
};

function BacklinkList({ backlinks, compact }: { backlinks: HubChatBacklink[]; compact: boolean }) {
  return (
    <ul className="space-y-1">
      {backlinks.map((b) => {
        const href = hubChatMessageHash(b.channelId, b.messageId);
        return (
          <li key={b.messageId}>
            <a
              href={href ?? undefined}
              data-testid="hub-chat-backlink"
              className="block rounded-md border border-gray-800 bg-gray-900/60 px-2.5 py-1.5 text-xs hover:border-gray-600 hover:bg-gray-800/70"
            >
              <span className="flex items-center gap-1.5 text-gray-400">
                <span className="font-medium text-gray-200 truncate">{b.channelLabel}</span>
                {b.authorName ? <span className="truncate">· {b.authorName}</span> : null}
                <span className="ml-auto shrink-0 text-gray-500">{relativeTime(b.createdAt)}</span>
              </span>
              {b.excerpt ? (
                <span
                  className={`mt-0.5 block text-gray-300 ${compact ? 'truncate' : 'line-clamp-2'}`}
                >
                  {b.excerpt}
                </span>
              ) : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export default function HubChatBacklinks({
  kind,
  targetId,
  variant = 'section',
  className,
}: Props) {
  // Results carry the entity they were fetched for, so rows for a previous
  // target are never shown while (or after) the current one loads.
  const [loaded, setLoaded] = useState<{ key: string; rows: HubChatBacklink[] } | null>(null);
  const targetKey = targetId ? `${kind}:${targetId}` : null;
  const backlinks = loaded && loaded.key === targetKey ? loaded.rows : NO_BACKLINKS;
  const [open, setOpen] = useState(false);
  const listed = useRef<Set<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    listed.current = new Set();
    setOpen(false);
    if (!targetId || typeof api.hubChat?.backlinks !== 'function') {
      setLoaded(null);
      return;
    }
    const key = `${kind}:${targetId}`;
    let cancelled = false;
    // Refreshes can overlap and resolve out of order; only the latest one applies.
    let generation = 0;
    const load = () => {
      const current = ++generation;
      api.hubChat
        .backlinks(kind, targetId)
        .then((res: { backlinks?: HubChatBacklink[] }) => {
          if (cancelled || current !== generation) return;
          const rows = Array.isArray(res?.backlinks) ? res.backlinks : [];
          listed.current = new Set(rows.map((b) => b.messageId));
          setLoaded({ key, rows });
        })
        .catch(() => {
          if (!cancelled && current === generation) setLoaded({ key, rows: [] });
        });
    };
    load();
    const onEvent = (e: Event) => {
      const message = (e as CustomEvent<{ message?: HubChatMessage }>).detail?.message;
      if (!message) return;
      if (listed.current.has(message.id) || messageAffectsBacklinks(message, kind, targetId)) {
        load();
      }
    };
    window.addEventListener('hub_chat_message', onEvent);
    window.addEventListener('hub_chat_message_update', onEvent);
    return () => {
      cancelled = true;
      window.removeEventListener('hub_chat_message', onEvent);
      window.removeEventListener('hub_chat_message_update', onEvent);
    };
  }, [kind, targetId]);

  if (!targetId || backlinks.length === 0) return null;

  if (variant === 'menu') {
    return (
      <div className={`relative ${className ?? ''}`} ref={menuRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md border border-gray-700 bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-300 hover:border-gray-600 hover:bg-gray-700 hover:text-white"
          title="Discussed in chat"
          aria-label={`Discussed in chat: ${backlinks.length}`}
          aria-expanded={open}
          data-testid="hub-chat-backlinks-toggle"
        >
          <MessagesSquare size={11} />
          {backlinks.length}
        </button>
        {open ? (
          <div
            data-testid="hub-chat-backlinks"
            className="absolute left-0 top-full z-50 mt-1 w-80 max-h-80 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 p-2 shadow-xl"
            onClick={() => setOpen(false)}
          >
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-gray-500">
              Discussed in chat
            </div>
            <BacklinkList backlinks={backlinks} compact />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div data-testid="hub-chat-backlinks" className={className}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
        <MessagesSquare size={12} />
        Discussed in chat ({backlinks.length})
      </div>
      <BacklinkList backlinks={backlinks} compact={false} />
    </div>
  );
}
