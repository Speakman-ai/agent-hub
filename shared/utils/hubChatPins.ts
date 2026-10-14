/**
 * The pinned list of one open channel, shared by web and mobile.
 *
 * Every input goes through these functions: list responses, live edits and
 * deletes, live reaction/pin changes, and the responses to the viewer's own
 * requests. The list follows the same revision rules as the message window:
 *
 * - Every edit, delete and reaction/pin change seen is remembered per message
 *   id, also before the list has loaded and for messages not listed, and is
 *   applied to every list response accepted afterwards. A response fetched
 *   before a change can never bring the old text, reactions or pin back.
 * - Only the latest request's response is accepted. A response is the
 *   server's list at the moment it was read. Pins it includes are checked
 *   against what was seen since by revision. Pins it leaves out carry no
 *   revision, so each change seen live is stamped with a local clock: a pin
 *   left out of a response but seen changing after that request started is
 *   kept (if its newest known state is pinned) and the list is fetched again
 *   to settle it. The next response has nothing newer to contend with.
 * - A message pinned that the list does not hold yet marks the list `stale`;
 *   the owner then reloads (the list needs the message body). Unpins and
 *   deletes apply at once.
 * - A change older than one already seen is ignored, so a request's response
 *   and the live echo of the same change apply once.
 */
import {
  newestRevision,
  withMeta,
  type HubChatMessage,
  type HubChatMessageMeta,
  type HubChatPinnedMessage,
  type MetaFields,
} from './hubChat';

export interface PinnedListState {
  pins: HubChatPinnedMessage[];
  revisions: Readonly<Record<string, HubChatMessage>>;
  metas: Readonly<Record<string, MetaFields>>;
  /** Local clock: bumped for every reaction/pin change seen. */
  clock: number;
  /** Per message id, the clock value of the latest change seen to it. */
  observed: Readonly<Record<string, number>>;
  /** The clock when the request that may be accepted started. */
  requestClock: number;
  /** Id of the request whose response may be accepted; 0 before the first. */
  request: number;
  loading: boolean;
  error: string | null;
  /** A pin was added that the list lacks: reload it. */
  stale: boolean;
}

export function initialPinnedList(): PinnedListState {
  return {
    pins: [],
    revisions: {},
    metas: {},
    clock: 0,
    observed: {},
    requestClock: 0,
    request: 0,
    loading: true,
    error: null,
    stale: false,
  };
}

/**
 * A listed pin with everything seen since applied, or null when it is gone.
 *
 * The reconciled message's `pinned` is the only pin state: the entry's
 * attribution and time are derived from it, so a newer pin (a re-pin by
 * someone else) shows its own author and time. `pinned` undefined means the
 * copy carries no pin state, which is not an unpin; the entry keeps its own.
 */
function reconcile(s: PinnedListState, pin: HubChatPinnedMessage): HubChatPinnedMessage | null {
  const meta = s.metas[pin.message.id];
  const message = withMeta(newestRevision(pin.message, s.revisions[pin.message.id]), meta);
  if (message.deletedAt || message.pinned === null) return null;
  const pinnedByUserId = message.pinned ? message.pinned.byUserId : pin.pinnedByUserId;
  const pinnedAt = message.pinned ? message.pinned.at : pin.pinnedAt;
  if (
    message === pin.message &&
    pinnedByUserId === pin.pinnedByUserId &&
    pinnedAt === pin.pinnedAt
  ) {
    return pin;
  }
  return { message, pinnedByUserId, pinnedAt };
}

/**
 * Reconciles every entry and orders the list as the server does: most
 * recently pinned first. Entries pinned at the same moment keep their order.
 */
function reconcileAll(s: PinnedListState, pins: HubChatPinnedMessage[]): HubChatPinnedMessage[] {
  const out: HubChatPinnedMessage[] = [];
  for (const p of pins) {
    const next = reconcile(s, p);
    if (next) out.push(next);
  }
  const time = (p: HubChatPinnedMessage) => Date.parse(p.pinnedAt) || 0;
  return out
    .map((p, i) => ({ p, i }))
    .sort((a, b) => time(b.p) - time(a.p) || a.i - b.i)
    .map(({ p }) => p);
}

/** Marks `id` as the request whose response is accepted next. */
export function beginPinsRequest(s: PinnedListState, id: number): PinnedListState {
  return { ...s, request: id, requestClock: s.clock, loading: true, stale: false };
}

export function acceptPinsResponse(
  s: PinnedListState,
  id: number,
  pins: HubChatPinnedMessage[],
): PinnedListState {
  if (id !== s.request) return s;
  // Listed pins the response leaves out but that changed after the request
  // went out: the response cannot speak for them.
  const included = new Set(pins.map((p) => p.message.id));
  const carried = s.pins.filter(
    (p) => !included.has(p.message.id) && (s.observed[p.message.id] ?? 0) > s.requestClock,
  );
  const next = reconcileAll(s, [...pins, ...carried]);
  const kept = carried.some((c) => next.some((p) => p.message.id === c.message.id));
  return { ...s, pins: next, loading: false, error: null, stale: s.stale || kept };
}

export function failPinsRequest(s: PinnedListState, id: number, error: string): PinnedListState {
  if (id !== s.request) return s;
  return { ...s, loading: false, error };
}

/** A live edit or delete, or the response to the viewer's own. */
export function applyPinsMessageUpdate(
  s: PinnedListState,
  message: HubChatMessage,
): PinnedListState {
  const revisions = {
    ...s.revisions,
    [message.id]: newestRevision(message, s.revisions[message.id]),
  };
  const next = { ...s, revisions };
  // The copy's reaction/pin state is a change like any meta event: recorded
  // so a later event of the same revision is a no-op, and a new pin marks
  // the list stale.
  if (message.metaRev !== undefined && message.pinned !== undefined) {
    const withMetaState = applyPinsMeta(next, {
      messageId: message.id,
      channelId: message.channelId,
      metaRev: message.metaRev,
      reactions: message.reactions ?? [],
      pinned: message.pinned,
    });
    if (withMetaState !== next) return withMetaState;
  }
  return { ...next, pins: reconcileAll(next, s.pins) };
}

/** A reaction/pin change: a live event, or the response to the viewer's request. */
export function applyPinsMeta(s: PinnedListState, meta: HubChatMessageMeta): PinnedListState {
  const known = s.metas[meta.messageId];
  if (known && known.metaRev >= meta.metaRev) return s;
  const fields: MetaFields = {
    metaRev: meta.metaRev,
    reactions: meta.reactions,
    pinned: meta.pinned,
  };
  const clock = s.clock + 1;
  const next = {
    ...s,
    metas: { ...s.metas, [meta.messageId]: fields },
    clock,
    observed: { ...s.observed, [meta.messageId]: clock },
  };
  const listed = s.pins.some((p) => p.message.id === meta.messageId);
  return {
    ...next,
    pins: reconcileAll(next, s.pins),
    stale: s.stale || (!!meta.pinned && !listed),
  };
}
