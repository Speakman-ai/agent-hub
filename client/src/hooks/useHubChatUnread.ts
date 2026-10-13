import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../utils/api';
import {
  applyMessageToChannels,
  applyReadToChannels,
  reconcileChannels,
  type HubChatChannel,
  type HubChatMessage,
} from '../utils/hubChat';
import {
  hubChatBadgeCount,
  hubChatNoticeFor,
  type HubChatMessageEvent,
  type HubChatNotice,
} from '../utils/hubChatUnread';

export interface HubChatUnreadApi {
  hubChat: { channels: () => Promise<{ channels?: HubChatChannel[]; viewerUserId?: string }> };
}

/**
 * Agent Hub chat unread state for the Chat button and the pane toggle, kept
 * while the Chat pane is closed. It reads the channel list, follows the
 * membership-filtered `hub_chat_*` events App re-dispatches on window, and
 * announces DMs and mentions through `onNotify`. A reset happens whenever the
 * signed-in user changes, so one account's counts never carry to the next.
 */
export function useHubChatUnread({
  enabled,
  userId,
  isViewingChannel,
  onNotify,
  chatApi = api as unknown as HubChatUnreadApi,
}: {
  enabled: boolean;
  userId: string | null;
  /** True when this channel is open on screen, so its messages are read. */
  isViewingChannel: (channelId: string) => boolean;
  onNotify?: (notice: HubChatNotice) => void;
  chatApi?: HubChatUnreadApi;
}): { badge: number; channels: HubChatChannel[] } {
  const [channels, setChannels] = useState<HubChatChannel[]>([]);
  const channelsRef = useRef<HubChatChannel[]>([]);
  const viewerRef = useRef<string | null>(userId);
  const viewingRef = useRef(isViewingChannel);
  viewingRef.current = isViewingChannel;
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;
  // Bumped per account: a response for an earlier account is dropped.
  const generationRef = useRef(0);
  const refreshRef = useRef({ running: null as Promise<void> | null, again: false });
  // Highest read pointer per channel seen from live events or snapshots. A
  // snapshot requested before a read event lands cannot bring cleared counts
  // back, since reads only move forward.
  const readsRef = useRef(new Map<string, number>());
  const noteRead = useCallback((channelId: string, seq: number) => {
    const reads = readsRef.current;
    if (seq > (reads.get(channelId) ?? 0)) reads.set(channelId, seq);
  }, []);

  const apply = useCallback((next: HubChatChannel[]) => {
    channelsRef.current = next;
    setChannels(next);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    const state = refreshRef.current;
    if (state.running) {
      state.again = true;
      return state.running;
    }
    const generation = generationRef.current;
    const run = (async () => {
      // Estimates converge in a follow-up; bound it so steady traffic cannot
      // keep the loop busy.
      let estimateRetries = 2;
      try {
        do {
          state.again = false;
          try {
            const res = await chatApi.hubChat.channels();
            if (generation !== generationRef.current) return;
            if (res.viewerUserId) viewerRef.current = res.viewerUserId;
            const fresh = res.channels ?? [];
            for (const c of fresh) if (c.membership) noteRead(c.id, c.membership.lastReadSeq);
            // Live events may have moved past this snapshot while it was in
            // flight: sequences only move forward, and a count that had to be
            // estimated asks for one more fetch.
            const { channels: merged, exact } = reconcileChannels(
              fresh,
              channelsRef.current,
              () => false,
              (id) => readsRef.current.get(id) ?? 0,
            );
            apply(merged);
            if (!exact && estimateRetries-- > 0) state.again = true;
          } catch {
            // Keep the last counts; the next event or reconnect fetches again.
          }
        } while (state.again && generation === generationRef.current);
      } finally {
        if (refreshRef.current === state) state.running = null;
      }
    })();
    state.running = run;
    return run;
  }, [apply, chatApi, noteRead]);

  useEffect(() => {
    generationRef.current += 1;
    refreshRef.current = { running: null, again: false };
    readsRef.current = new Map();
    viewerRef.current = userId;
    apply([]);
    if (!enabled) return undefined;
    const generation = generationRef.current;
    void refresh();

    const notify = (data: HubChatMessageEvent) => {
      const message = data.message;
      if (!message) return;
      const notice = hubChatNoticeFor(
        data,
        channelsRef.current.find((c) => c.id === message.channelId),
        {
          viewerUserId: viewerRef.current,
          viewingChannelId: viewingRef.current(message.channelId) ? message.channelId : null,
        },
      );
      if (notice) notifyRef.current?.(notice);
    };

    const onMessage = (e: Event) => {
      const data = ((e as CustomEvent).detail ?? {}) as HubChatMessageEvent;
      const message = data.message as HubChatMessage | undefined;
      if (!message?.channelId) return;
      if (!channelsRef.current.some((c) => c.id === message.channelId)) {
        // A channel this client has not seen yet: the refreshed list already
        // counts the message, so only the notice is left to decide.
        void refresh().then(() => {
          if (generation === generationRef.current) notify(data);
        });
        return;
      }
      notify(data);
      apply(
        applyMessageToChannels(channelsRef.current, message, {
          viewerUserId: viewerRef.current,
          viewingChannelId: viewingRef.current(message.channelId) ? message.channelId : null,
        }),
      );
    };
    const onRead = (e: Event) => {
      const { channelId, lastReadSeq } = (e as CustomEvent).detail ?? {};
      if (typeof channelId !== 'string' || typeof lastReadSeq !== 'number') return;
      noteRead(channelId, lastReadSeq);
      const next = applyReadToChannels(channelsRef.current, channelId, lastReadSeq);
      if (next) apply(next);
      else void refresh();
    };
    const onRefresh = () => void refresh();

    window.addEventListener('hub_chat_message', onMessage);
    window.addEventListener('hub_chat_read', onRead);
    window.addEventListener('hub_chat_channel_update', onRefresh);
    window.addEventListener('agenthub:ws_reconnected', onRefresh);
    return () => {
      window.removeEventListener('hub_chat_message', onMessage);
      window.removeEventListener('hub_chat_read', onRead);
      window.removeEventListener('hub_chat_channel_update', onRefresh);
      window.removeEventListener('agenthub:ws_reconnected', onRefresh);
    };
  }, [enabled, userId, apply, refresh, noteRead]);

  // A mute that expires lifts its channel's count without a server event.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [enabled]);
  const badge = useMemo(() => hubChatBadgeCount(channels, now), [channels, now]);

  return { badge, channels };
}
