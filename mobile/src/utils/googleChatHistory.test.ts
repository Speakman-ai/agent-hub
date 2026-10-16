import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@shared/utils/googleChat';
import {
  applyNewest,
  applyOlder,
  EMPTY_HISTORY,
  fetchNewest,
  type ChatHistory,
  type NewestPage,
} from './googleChatHistory';

const msg = (n: number): ChatMessage => ({
  name: `spaces/A/messages/${n}`,
  id: null,
  spaceName: 'spaces/A',
  threadName: null,
  threadReply: false,
  text: `m${n}`,
  createTime: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  lastUpdateTime: null,
  deleted: false,
  attachmentCount: 0,
  sender: null,
});
/** Newest-first pages of `size` over messages 1..total (total is newest). */
function server(total: number, size = 50) {
  const pages: NewestPage[] = [];
  for (let top = total, i = 0; top >= 1; top -= size, i++) {
    const items = [];
    for (let n = top; n > Math.max(0, top - size); n--) items.push(msg(n));
    pages.push({ messages: items, nextPageToken: top - size >= 1 ? `p${i + 1}` : null });
  }
  return vi.fn(async (token?: string) => pages[token ? Number(token.slice(1)) : 0]);
}
const numbers = (h: ChatHistory) => h.messages.map((m) => Number(m.name!.split('/').pop()));
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('google chat history', () => {
  it('reads one page when nothing is held', async () => {
    const fetchPage = server(120);
    const h = applyNewest(EMPTY_HISTORY, await fetchNewest(fetchPage, []));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(numbers(h)).toEqual(range(71, 120));
    expect(h.cursor).toBe('p1');
  });

  it('fills a gap of more than a page after history was exhausted', async () => {
    // All 30 messages held, history exhausted (no cursor, no "load older").
    let fetchPage = server(30);
    let h = applyNewest(EMPTY_HISTORY, await fetchNewest(fetchPage, []));
    expect(h.cursor).toBeNull();
    // 120 more arrive while the phone is in the background.
    fetchPage = server(150);
    h = applyNewest(h, await fetchNewest(fetchPage, h.messages));
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(numbers(h)).toEqual(range(1, 150));
    expect(h.cursor).toBeNull();
  });

  it('keeps the older-history cursor when the catch-up joins the held run', async () => {
    let fetchPage = server(200);
    let h = applyNewest(EMPTY_HISTORY, await fetchNewest(fetchPage, []));
    h = applyOlder(h, await fetchPage(h.cursor!));
    expect(numbers(h)).toEqual(range(101, 200));
    expect(h.cursor).toBe('p2');
    fetchPage = server(270);
    h = applyNewest(h, await fetchNewest(fetchPage, h.messages));
    expect(numbers(h)).toEqual(range(101, 270));
    // Still the token that continues below message 101.
    expect(h.cursor).toBe('p2');
  });

  it('starts a fresh run instead of leaving a hole when the gap is too large', async () => {
    let fetchPage = server(60);
    let h = applyNewest(EMPTY_HISTORY, await fetchNewest(fetchPage, []));
    fetchPage = server(1000);
    h = applyNewest(h, await fetchNewest(fetchPage, h.messages, 3));
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(numbers(h)).toEqual(range(851, 1000));
    expect(h.cursor).toBe('p3');
  });

  it('takes fetched copies over held ones, and held ones over older pages', async () => {
    const held: ChatHistory = {
      messages: [{ ...msg(1), text: 'old copy' }, msg(2)],
      cursor: 'p9',
    };
    const joined = applyNewest(held, {
      kind: 'joined',
      messages: [{ ...msg(2), text: 'edited' }, msg(3)],
      selfUserName: null,
    });
    expect(joined.messages.map((m) => m.text)).toEqual(['old copy', 'edited', 'm3']);
    expect(joined.cursor).toBe('p9');
    const older = applyOlder(joined, { messages: [{ ...msg(2), text: 'stale' }, msg(0)] });
    expect(older.messages.map((m) => m.text)).toEqual(['m0', 'old copy', 'edited', 'm3']);
  });
});
