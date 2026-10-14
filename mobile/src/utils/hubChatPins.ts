/**
 * The pinned list of one open Agent Hub channel on mobile. State rules live in
 * `@shared/utils/hubChatPins` (same as web); this controller runs the
 * requests and feeds it list responses, live events, and the responses to the
 * viewer's own requests.
 */
import type {
  HubChatMessage,
  HubChatMessageMeta,
  HubChatPinnedMessage,
} from '@shared/utils/hubChat';
import {
  acceptPinsResponse,
  applyPinsMessageUpdate,
  applyPinsMeta,
  beginPinsRequest,
  failPinsRequest,
  initialPinnedList,
  type PinnedListState,
} from '@shared/utils/hubChatPins';

export interface PinsApi {
  pins: (channelId: string) => Promise<{ pins?: HubChatPinnedMessage[] }>;
}

export type PinsState = PinnedListState;

export function createPinsLoader(
  channelId: string,
  api: PinsApi,
  onChange: (state: PinsState) => void,
) {
  let state: PinsState = initialPinnedList();
  let request = 0;
  let disposed = false;
  const set = (next: PinsState) => {
    if (disposed || next === state) return;
    state = next;
    onChange(state);
    // A pin the list does not hold yet: fetch it.
    if (state.stale) void reload();
  };
  function reload(): Promise<void> {
    if (disposed) return Promise.resolve();
    const id = ++request;
    set(beginPinsRequest(state, id));
    return Promise.resolve()
      .then(() => api.pins(channelId))
      .then(
        (res) => set(acceptPinsResponse(state, id, res?.pins ?? [])),
        (err: unknown) =>
          set(failPinsRequest(state, id, err instanceof Error ? err.message : String(err))),
      );
  }
  return {
    getState: () => state,
    reload,
    /** A reaction/pin change: live event or the response to the viewer's request. */
    receiveMeta(meta: HubChatMessageMeta) {
      if (disposed || meta.channelId !== channelId) return;
      set(applyPinsMeta(state, meta));
    },
    /** An edit or delete: live event or the response to the viewer's request. */
    receiveUpdate(message: HubChatMessage) {
      if (disposed || message.channelId !== channelId) return;
      set(applyPinsMessageUpdate(state, message));
    },
    dispose() {
      disposed = true;
    },
  };
}
