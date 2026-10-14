/**
 * The message window of one open Agent Hub channel on mobile.
 *
 * Invariant: the window is always a contiguous run of sequences, from the
 * oldest page loaded to `tail`. Every path that adds messages goes through
 * this controller and keeps that true:
 *
 * - history pages (first page, Load earlier, forward catch-up) are contiguous
 *   by construction;
 * - a new message (live event or the response to the viewer's own post) is
 *   admitted only when it is exactly `tail + 1`; anything else starts a
 *   forward catch-up from `tail`, which fetches it along with whatever is
 *   missing before it;
 * - while the first page is still loading nothing new is inserted; the
 *   arrival is remembered and a catch-up runs from the first page's tail;
 * - edits and deletes never insert (`mergeIntoWindow` keeps the newest
 *   revision, including for messages not loaded yet);
 * - a resync (reconnect, back in front) refetches everything loaded, so edits
 *   and deletes missed while away replace stale copies.
 */
import { mergeIntoWindow, type HubChatMessage, type MessageWindow } from '@shared/utils/hubChat';

export interface ChannelPage {
  messages?: HubChatMessage[];
  hasMore?: boolean;
}

export interface ChannelSyncApi {
  messages: (
    channelId: string,
    opts: { before?: number; after?: number; limit?: number },
  ) => Promise<ChannelPage>;
}

export interface ChannelSyncState {
  window: MessageWindow;
  /** Older history exists before the first loaded message. */
  hasMore: boolean;
  /** The first page has not landed yet. */
  loading: boolean;
  error: string | null;
}

export const CHANNEL_PAGE = 50;
/** Pages fetched per batch; a longer sync continues in further batches. */
export const MAX_PAGES_PER_BATCH = 40;

/**
 * Where a forward sync starts: after the newest message shown, or before the
 * oldest one when everything on screen must be fetched again.
 */
export function catchUpStart(messages: { seq: number }[], full: boolean): number {
  if (messages.length === 0) return 0;
  return full ? messages[0].seq - 1 : messages[messages.length - 1].seq;
}

/**
 * Splits new messages into the ones that extend the window without a gap and
 * whether a forward catch-up is needed for the rest. Messages at or below the
 * tail are updates of what is already known.
 */
export function admitNewMessages(
  messages: HubChatMessage[],
  incoming: HubChatMessage[],
): { insert: HubChatMessage[]; updates: HubChatMessage[]; catchUp: boolean } {
  let tail = messages.length ? messages[messages.length - 1].seq : 0;
  const insert: HubChatMessage[] = [];
  const updates: HubChatMessage[] = [];
  for (const m of [...incoming].sort((a, b) => a.seq - b.seq)) {
    if (m.seq <= tail) updates.push(m);
    else if (m.seq === tail + 1) {
      insert.push(m);
      tail = m.seq;
    } else return { insert, updates, catchUp: true };
  }
  return { insert, updates, catchUp: false };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createChannelSync(
  channelId: string,
  api: ChannelSyncApi,
  onChange: (state: ChannelSyncState) => void,
) {
  let state: ChannelSyncState = {
    window: { messages: [], revisions: {} },
    hasMore: false,
    loading: true,
    error: null,
  };
  let disposed = false;
  // Arrivals while the first page loads: catch up (fully, after a resync).
  let pendingTail = false;
  let pendingFull = false;
  const sync = { running: null as Promise<void> | null, again: false, full: false };
  // Where an unfinished sync continues from: set when a batch hits its page
  // limit with more to fetch, or when a page request fails part way. Without
  // it a full resync over a long window would restart at the oldest message
  // every time and never reach the newest ones.
  let cursor: number | null = null;

  const set = (next: Partial<ChannelSyncState>) => {
    if (disposed) return;
    state = { ...state, ...next };
    onChange(state);
  };
  const merge = (incoming: HubChatMessage[], insert: boolean) => {
    if (incoming.length === 0) return;
    set({ window: mergeIntoWindow(state.window, incoming, insert) });
  };

  function catchUp(full: boolean): Promise<void> {
    if (full) sync.full = true;
    if (sync.running) {
      sync.again = true;
      return sync.running;
    }
    const run = (async () => {
      try {
        do {
          sync.again = false;
          const reloadAll = sync.full;
          sync.full = false;
          // A new full pass starts over; anything else resumes an unfinished one.
          let after = reloadAll
            ? catchUpStart(state.window.messages, true)
            : (cursor ?? catchUpStart(state.window.messages, false));
          cursor = null;
          let done = false;
          try {
            for (let i = 0; i < MAX_PAGES_PER_BATCH && !disposed; i++) {
              const res = await api.messages(channelId, { after, limit: CHANNEL_PAGE });
              if (disposed) return;
              const page = res?.messages ?? [];
              merge(page, true);
              const last = page.length ? page[page.length - 1].seq : after;
              // No progress means nothing more can be fetched from here.
              if (!res?.hasMore || last <= after) {
                done = true;
                break;
              }
              after = last;
            }
          } catch {
            // Resume from the last page that landed on the next event,
            // reconnect or foreground.
            cursor = after;
            return;
          }
          if (!done && !disposed) {
            // Batch limit reached with more to fetch: continue from here.
            cursor = after;
            sync.again = true;
          }
        } while (sync.again && !disposed);
      } finally {
        sync.running = null;
      }
    })();
    sync.running = run;
    return run;
  }

  async function load(): Promise<void> {
    set({ loading: true });
    pendingTail = false;
    pendingFull = false;
    try {
      const res = await api.messages(channelId, { limit: CHANNEL_PAGE });
      if (disposed) return;
      merge(res?.messages ?? [], true);
      set({ hasMore: !!res?.hasMore, error: null, loading: false });
    } catch (err) {
      set({ error: errorText(err), loading: false });
      return;
    }
    if (pendingTail || pendingFull) {
      const full = pendingFull;
      pendingTail = false;
      pendingFull = false;
      await catchUp(full);
    }
  }

  return {
    getState: () => state,
    load,
    /** New messages: a live event, or the response to the viewer's own post. */
    receiveNew(incoming: HubChatMessage[]) {
      if (disposed || incoming.length === 0) return;
      if (state.loading) {
        merge(incoming, false);
        pendingTail = true;
        return;
      }
      const {
        insert,
        updates,
        catchUp: behind,
      } = admitNewMessages(state.window.messages, incoming);
      merge(updates, false);
      merge(insert, true);
      // An unfinished sync also resumes on any new activity.
      if (behind || cursor !== null) void catchUp(false);
    },
    /** An edit or delete: never inserts. */
    receiveUpdate(message: HubChatMessage) {
      merge([message], false);
    },
    /** The channel's tail moved past the window (learned from the rail). */
    catchUpTo(lastSeq: number) {
      if (disposed) return;
      if (state.loading) {
        pendingTail = true;
        return;
      }
      if (state.error && state.window.messages.length === 0) return;
      const msgs = state.window.messages;
      const tail = msgs.length ? msgs[msgs.length - 1].seq : 0;
      if (lastSeq > tail || cursor !== null) void catchUp(false);
    },
    /** Events may have been missed: refetch everything loaded and the tail. */
    resync() {
      if (disposed) return;
      if (state.loading) {
        pendingFull = true;
        return;
      }
      if (state.error && state.window.messages.length === 0) {
        void load();
        return;
      }
      void catchUp(true);
    },
    async loadOlder(): Promise<void> {
      const first = state.window.messages[0];
      if (!first || disposed) return;
      const res = await api.messages(channelId, { before: first.seq, limit: CHANNEL_PAGE });
      if (disposed) return;
      merge(res?.messages ?? [], true);
      set({ hasMore: !!res?.hasMore });
    },
    dispose() {
      disposed = true;
    },
  };
}

export type ChannelSync = ReturnType<typeof createChannelSync>;
