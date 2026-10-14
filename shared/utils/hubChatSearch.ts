/**
 * Client helpers for Agent Hub chat message search (`GET /api/chat/search`).
 * Shared by web and mobile.
 */
import type { HubChatChannelKind, HubChatMessage } from './hubChat';

export interface HubChatSearchResult {
  message: HubChatMessage;
  channel: {
    id: string;
    kind: HubChatChannelKind;
    name: string;
    dmPeerUserId: string | null;
    isPrivate: boolean;
    isMember: boolean;
  };
}

export interface HubChatExcerptPart {
  text: string;
  match: boolean;
}

/** Words of a query the way the server matches them (prefix, case-insensitive). */
export function hubChatSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

/**
 * A window of `text` around its first match, split into parts so the caller
 * can highlight the words that start with a query term.
 */
export function hubChatSearchExcerpt(
  text: string,
  query: string,
  maxLength = 140,
): HubChatExcerptPart[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  const terms = hubChatSearchTerms(query);
  const words = [...flat.matchAll(/[\p{L}\p{N}_]+/gu)];
  const isHit = (w: string) => {
    const lw = w.toLowerCase();
    return terms.some((t) => lw.startsWith(t));
  };
  const firstHit = words.find((w) => isHit(w[0]));

  let start = 0;
  if (firstHit && flat.length > maxLength) {
    start = Math.max(0, Math.min(firstHit.index! - 30, flat.length - maxLength));
    // Start on a word boundary rather than mid-word.
    const space = flat.indexOf(' ', start);
    if (start > 0 && space !== -1 && space < firstHit.index!) start = space + 1;
  }
  const end = Math.min(flat.length, start + maxLength);

  const parts: HubChatExcerptPart[] = [];
  const push = (s: string, match: boolean) => {
    if (!s) return;
    const last = parts[parts.length - 1];
    if (last && last.match === match) last.text += s;
    else parts.push({ text: s, match });
  };
  if (start > 0) push('…', false);
  let cursor = start;
  for (const w of words) {
    const ws = w.index!;
    const we = ws + w[0].length;
    if (we <= start || ws >= end || !isHit(w[0])) continue;
    const s = Math.max(ws, start);
    const e = Math.min(we, end);
    push(flat.slice(cursor, s), false);
    push(flat.slice(s, e), true);
    cursor = e;
  }
  push(flat.slice(cursor, end), false);
  if (end < flat.length) push('…', false);
  return parts;
}
