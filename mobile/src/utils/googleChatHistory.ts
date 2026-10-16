import { sortChatMessages, type ChatMessage } from '@shared/utils/googleChat';

/**
 * The messages held for an open Google Chat conversation.
 *
 * Invariant: `messages` is one unbroken run, from the newest message down to
 * the oldest one held, and `cursor` is the page token for what comes before
 * that oldest message (null when history is exhausted). Every update below
 * keeps it, so "load older" can always fill backwards and nothing between
 * the newest and oldest held message is ever missing.
 */
export interface ChatHistory {
  messages: ChatMessage[];
  cursor: string | null;
}

export const EMPTY_HISTORY: ChatHistory = { messages: [], cursor: null };

/** Most pages one refresh walks back looking for messages already held. */
export const MAX_CATCH_UP_PAGES = 10;

export interface NewestPage {
  messages?: ChatMessage[];
  nextPageToken?: string | null;
  selfUserName?: string;
}

/** What a newest-first fetch found: pages that join what is held, or a fresh run. */
export type NewestResult =
  | { kind: 'joined'; messages: ChatMessage[]; selfUserName: string | null }
  | {
      kind: 'fresh';
      messages: ChatMessage[];
      cursor: string | null;
      selfUserName: string | null;
    };

const keyOf = (m: ChatMessage) => m.name || m.id || null;
const tokenOf = (body: NewestPage | null | undefined) =>
  typeof body?.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null;

/**
 * Fetch newest-first pages until one overlaps a held message, so everything
 * that arrived since (even several pages of it) is read. With nothing held
 * one page is enough. If no overlap turns up within `maxPages` (or history
 * ends first), the fetched pages become a fresh run with their own cursor
 * instead of being stitched onto the held run with a hole in between.
 */
export async function fetchNewest(
  fetchPage: (pageToken?: string) => Promise<NewestPage>,
  held: ChatMessage[],
  maxPages = MAX_CATCH_UP_PAGES,
): Promise<NewestResult> {
  const heldKeys = new Set(held.map(keyOf).filter(Boolean));
  const fetched: ChatMessage[] = [];
  let selfUserName: string | null = null;
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const body = await fetchPage(token);
    if (page === 0 && typeof body?.selfUserName === 'string') selfUserName = body.selfUserName;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    fetched.push(...messages);
    const next = tokenOf(body);
    if (heldKeys.size && messages.some((m) => heldKeys.has(keyOf(m)))) {
      return { kind: 'joined', messages: fetched, selfUserName };
    }
    if (!heldKeys.size || !next)
      return { kind: 'fresh', messages: fetched, cursor: next, selfUserName };
    token = next;
  }
  return { kind: 'fresh', messages: fetched, cursor: token ?? null, selfUserName };
}

/** Fold a newest-first result into the history, keeping the invariant. */
export function applyNewest(history: ChatHistory, result: NewestResult): ChatHistory {
  if (result.kind === 'fresh') {
    return { messages: sortChatMessages(dedupe(result.messages)), cursor: result.cursor };
  }
  // Fetched copies are newer than held ones (edits, deletions); the cursor
  // still points below the oldest held message.
  const fresh = new Map(result.messages.map((m) => [keyOf(m), m]));
  const kept = history.messages.map((m) => fresh.get(keyOf(m)) ?? m);
  const held = new Set(history.messages.map(keyOf));
  const added = result.messages.filter((m) => !held.has(keyOf(m)));
  return { messages: sortChatMessages(dedupe([...kept, ...added])), cursor: history.cursor };
}

/** Add an older page fetched with `history.cursor`. Held copies win: refreshes are newer. */
export function applyOlder(history: ChatHistory, page: NewestPage): ChatHistory {
  const held = new Set(history.messages.map(keyOf));
  const older = (Array.isArray(page?.messages) ? page.messages : []).filter(
    (m) => !held.has(keyOf(m)),
  );
  return { messages: sortChatMessages([...history.messages, ...older]), cursor: tokenOf(page) };
}

function dedupe(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string | null>();
  return messages.filter((m) => {
    const key = keyOf(m);
    if (key && seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
