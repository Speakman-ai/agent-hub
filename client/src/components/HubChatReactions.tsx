import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Pin, SmilePlus, X } from 'lucide-react';
import { api } from '../utils/api';
import {
  HUB_CHAT_QUICK_REACTIONS,
  authorLabel,
  parseMessageMetaEvent,
  reactedByViewer,
  type HubChatMessage,
  type HubChatMessageMeta,
  type HubChatPinnedMessage,
  type HubChatReaction,
} from '../utils/hubChat';
import { plainChatText } from '@shared/utils/hubChatUnread';
import {
  acceptPinsResponse,
  applyPinsMessageUpdate,
  applyPinsMeta,
  beginPinsRequest,
  failPinsRequest,
  initialPinnedList,
  type PinnedListState,
} from '@shared/utils/hubChatPins';
import { formatDateTime } from '../utils/time';

function reactorNames(
  reaction: HubChatReaction,
  usernames: ReadonlyMap<string, string>,
  viewerUserId: string | null,
): string {
  return reaction.userIds
    .map((id) => (id === viewerUserId ? 'You' : usernames.get(id) || 'Unknown user'))
    .join(', ');
}

/** Emoji chips under a message. Clicking a chip toggles the viewer's reaction. */
export function HubChatReactionBar({
  reactions,
  usernames,
  viewerUserId,
  canReact,
  onToggle,
}: {
  reactions: HubChatReaction[] | undefined;
  usernames: ReadonlyMap<string, string>;
  viewerUserId: string | null;
  canReact: boolean;
  onToggle: (emoji: string) => void;
}) {
  if (!reactions?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1 px-1" data-testid="hub-chat-reactions">
      {reactions.map((r) => {
        const mine = reactedByViewer(r, viewerUserId);
        return (
          <button
            key={r.emoji}
            type="button"
            disabled={!canReact}
            onClick={() => onToggle(r.emoji)}
            aria-pressed={mine}
            aria-label={`${r.emoji} ${r.count}, reacted by ${reactorNames(r, usernames, viewerUserId)}`}
            title={reactorNames(r, usernames, viewerUserId)}
            data-testid="hub-chat-reaction"
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
              mine
                ? 'border-blue-500/60 bg-blue-500/20 text-blue-100'
                : 'border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-800'
            } disabled:cursor-default disabled:hover:bg-gray-900`}
          >
            <span>{r.emoji}</span>
            <span className="tabular-nums">{r.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Toolbar button that opens a quick-pick row of reactions. */
export function HubChatReactionPicker({
  className,
  onPick,
}: {
  className: string;
  onPick: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add reaction"
        aria-expanded={open}
        title="Add reaction"
        className={className}
      >
        <SmilePlus size={13} />
      </button>
      {open && (
        <div
          role="menu"
          data-testid="hub-chat-reaction-picker"
          className="absolute right-0 top-6 z-20 flex gap-0.5 rounded-lg border border-gray-700 bg-gray-900 p-1 shadow-lg"
        >
          {HUB_CHAT_QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              aria-label={`React with ${emoji}`}
              onClick={() => {
                setOpen(false);
                onPick(emoji);
              }}
              className="rounded px-1.5 py-0.5 text-base hover:bg-gray-800"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function snippet(message: HubChatMessage): string {
  const text = plainChatText(message.body);
  if (!text) return message.authorKind === 'trigger' ? 'Trigger update' : '(no text)';
  return text;
}

/**
 * Pinned messages for the open channel. State rules live in
 * `@shared/utils/hubChatPins`; this hook feeds it list responses and the live
 * edit, delete and reaction/pin events, and the page feeds it the responses
 * to the viewer's own requests through `applyMeta` / `applyUpdate`.
 */
export function useHubChatPins(channelId: string | null) {
  const [state, setState] = useState<PinnedListState>(initialPinnedList);
  const requestRef = useRef(0);
  const load = useCallback(() => {
    const id = ++requestRef.current;
    setState((s) => beginPinsRequest(s, id));
    if (!channelId) {
      setState((s) => acceptPinsResponse(s, id, []));
      return;
    }
    Promise.resolve()
      .then(() => api.hubChat.pins(channelId))
      .then((res: { pins?: HubChatPinnedMessage[] }) =>
        setState((s) => acceptPinsResponse(s, id, res?.pins ?? [])),
      )
      .catch((err: unknown) =>
        setState((s) => failPinsRequest(s, id, err instanceof Error ? err.message : String(err))),
      );
  }, [channelId]);

  useEffect(() => {
    setState(initialPinnedList());
    load();
  }, [load]);

  // A pin the list does not hold yet: fetch it.
  useEffect(() => {
    if (state.stale) load();
  }, [state.stale, load]);

  const applyMeta = useCallback(
    (meta: HubChatMessageMeta | null | undefined) => {
      if (meta && meta.channelId === channelId) setState((s) => applyPinsMeta(s, meta));
    },
    [channelId],
  );
  const applyUpdate = useCallback(
    (message: HubChatMessage | null | undefined) => {
      if (message && message.channelId === channelId) {
        setState((s) => applyPinsMessageUpdate(s, message));
      }
    },
    [channelId],
  );

  useEffect(() => {
    const onMeta = (e: Event) => applyMeta(parseMessageMetaEvent((e as CustomEvent).detail));
    const onUpdate = (e: Event) =>
      applyUpdate((e as CustomEvent).detail?.message as HubChatMessage | undefined);
    const onReconnect = () => load();
    window.addEventListener('hub_chat_message_meta', onMeta);
    window.addEventListener('hub_chat_message_update', onUpdate);
    window.addEventListener('agenthub:ws_reconnected', onReconnect);
    return () => {
      window.removeEventListener('hub_chat_message_meta', onMeta);
      window.removeEventListener('hub_chat_message_update', onUpdate);
      window.removeEventListener('agenthub:ws_reconnected', onReconnect);
    };
  }, [applyMeta, applyUpdate, load]);

  return {
    pins: state.pins,
    loading: state.loading,
    error: state.error,
    reload: load,
    applyMeta,
    applyUpdate,
  };
}

export type HubChatPins = ReturnType<typeof useHubChatPins>;

/** Channel header button listing the channel's pinned messages. */
export function HubChatPinsButton({
  channelId,
  pins,
  usernames,
  canUnpin,
  onPick,
  onUnpin,
}: {
  channelId: string;
  pins: HubChatPins;
  usernames: ReadonlyMap<string, string>;
  canUnpin: boolean;
  onPick: (messageId: string) => void;
  onUnpin: (messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [channelId]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const count = pins.pins.length;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={count ? `Pinned messages (${count})` : 'Pinned messages'}
        aria-expanded={open}
        title="Pinned messages"
        data-testid="hub-chat-pins-button"
        className={`inline-flex items-center gap-1 rounded p-1 text-xs hover:bg-gray-800 hover:text-white ${
          count ? 'text-amber-300' : 'text-gray-400'
        }`}
      >
        <Pin size={14} />
        {count > 0 && <span className="tabular-nums">{count}</span>}
      </button>
      {open && (
        <div
          data-testid="hub-chat-pins-panel"
          className="absolute right-0 top-8 z-30 w-80 max-w-[80vw] rounded-lg border border-gray-700 bg-gray-900 shadow-xl"
        >
          <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-2 text-xs font-semibold text-gray-300">
            <Pin size={12} />
            Pinned messages
            {pins.loading && <Loader2 size={12} className="ml-auto animate-spin text-gray-500" />}
          </div>
          {pins.error && <p className="px-3 py-2 text-xs text-red-300">{pins.error}</p>}
          {count === 0 && !pins.loading ? (
            <p className="px-3 py-3 text-xs text-gray-500">
              Nothing pinned yet. Pin a message from its toolbar to keep it here.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
              {pins.pins.map((p) => (
                <li
                  key={p.message.id}
                  className="group flex items-start gap-2 px-3 py-2 hover:bg-gray-800"
                  data-testid="hub-chat-pin"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onPick(p.message.id);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="text-xs font-semibold text-gray-200">
                      {authorLabel(p.message, usernames)}
                    </div>
                    <div className="line-clamp-3 break-words text-xs text-gray-300">
                      {snippet(p.message)}
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-500">
                      Pinned by {(p.pinnedByUserId && usernames.get(p.pinnedByUserId)) || 'someone'}{' '}
                      · {formatDateTime(p.pinnedAt)}
                    </div>
                  </button>
                  {canUnpin && (
                    <button
                      type="button"
                      onClick={() => onUnpin(p.message.id)}
                      aria-label="Unpin"
                      title="Unpin"
                      className="rounded p-0.5 text-gray-500 hover:bg-gray-700 hover:text-white"
                    >
                      <X size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
