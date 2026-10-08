/**
 * Agent-written Google Chat replies held for the session owner's approval.
 * The server owns the state; these helpers fold live
 * `google_chat_draft_update` events into a client's local list. Shared by web
 * and mobile.
 */
export type ChatDraftStatus = 'pending' | 'sending' | 'unconfirmed' | 'sent' | 'discarded';

export type ChatDraft = {
  id: string;
  sessionId: string;
  spaceId: string;
  threadName: string | null;
  text: string;
  /** Bumped on every text change. Approve, edit, and discard send the revision shown. */
  revision: number;
  status: ChatDraftStatus;
  error: string | null;
  sentMessageName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DraftFilter = { sessionId?: string; spaceId?: string };

function matches(draft: ChatDraft, filter: DraftFilter): boolean {
  if (filter.sessionId && draft.sessionId !== filter.sessionId) return false;
  if (filter.spaceId && draft.spaceId !== filter.spaceId) return false;
  return true;
}

/** A draft is shown while it still needs a decision or is mid-send. */
export function isOpenDraft(draft: ChatDraft): boolean {
  return draft.status === 'pending' || draft.status === 'sending' || draft.status === 'unconfirmed';
}

/**
 * The open drafts a view shows, plus the drafts known to be sent or discarded.
 * Those states are final, so a late event from before can't bring one back.
 */
export interface DraftListState {
  drafts: ChatDraft[];
  closed: Record<string, string>;
}

export const EMPTY_DRAFT_STATE: DraftListState = { drafts: [], closed: {} };

/**
 * Fold one server update into the list for a filter. Updates older than what
 * the list already holds are ignored, so events and responses can arrive in
 * any order. Timestamps are the server's ISO strings and compare as text.
 */
export function applyDraftUpdate(
  state: DraftListState,
  update: ChatDraft,
  filter: DraftFilter,
): DraftListState {
  const current = state.drafts.find((d) => d.id === update.id);
  if (state.closed[update.id]) return state;
  if (current && current.updatedAt > update.updatedAt) return state;
  const rest = state.drafts.filter((d) => d.id !== update.id);
  if (!isOpenDraft(update)) {
    return { drafts: rest, closed: { ...state.closed, [update.id]: update.updatedAt } };
  }
  if (!matches(update, filter)) return { ...state, drafts: rest };
  if (!current) return { ...state, drafts: [...state.drafts, update] };
  return { ...state, drafts: state.drafts.map((d) => (d.id === update.id ? update : d)) };
}

/**
 * Build the list from a fresh `GET /drafts` snapshot. `asOf` is the server time
 * the snapshot was read; updates received while the request was in flight are
 * replayed on top unless the snapshot already reflects them.
 */
export function reconcileDraftSnapshot(
  prior: DraftListState,
  snapshot: ChatDraft[],
  asOf: string | null,
  inFlight: ChatDraft[],
  filter: DraftFilter,
): DraftListState {
  let state: DraftListState = { drafts: [], closed: prior.closed };
  for (const d of snapshot) state = applyDraftUpdate(state, d, filter);
  for (const u of inFlight) {
    if (asOf && u.updatedAt < asOf) continue;
    state = applyDraftUpdate(state, u, filter);
  }
  return state;
}
