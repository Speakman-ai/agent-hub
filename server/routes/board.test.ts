import type supertest from 'supertest';
import { beforeAll, describe, it, expect } from 'vitest';
import { getRequest, createProject, createCard, createSession } from '../test/helpers.js';

let request: supertest.Agent;
let projectId: string;
let columnId: string;

interface EnrichedCard {
  id: string;
  title: string;
  position: number;
  blockers: unknown[];
  blocks: unknown[];
  finalize_run: unknown;
}

interface PageResponse {
  cards: EnrichedCard[];
  nextCursor: string | null;
  total: number;
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;

  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  columnId = (boardRes.body as { columns: Array<{ id: string }> }).columns[0].id;

  // 12 cards in a single column. createCard assigns incrementing positions in
  // creation order, so the expected ordering is deterministic.
  for (let i = 0; i < 12; i++) {
    await createCard(projectId, {
      columnId,
      title: `Page card ${String(i).padStart(2, '0')}`,
    });
  }
});

async function fetchPage(query: string): Promise<PageResponse> {
  const res = await request
    .get(`/api/projects/${projectId}/board/columns/${columnId}/cards${query}`)
    .expect(200);
  return res.body as PageResponse;
}

describe('GET /board/columns/:columnId/cards (keyset pagination)', () => {
  it('returns an ordered slice that respects limit, with correct total', async () => {
    const page = await fetchPage('?limit=5');
    expect(page.cards).toHaveLength(5);
    expect(page.total).toBe(12);
    expect(page.nextCursor).toBeTruthy();
    // ordered by position ascending
    const positions = page.cards.map((c) => c.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(page.cards.map((c) => c.title)).toEqual([
      'Page card 00',
      'Page card 01',
      'Page card 02',
      'Page card 03',
      'Page card 04',
    ]);
  });

  it('nextCursor is null on the last page', async () => {
    const page = await fetchPage('?limit=20');
    expect(page.cards).toHaveLength(12);
    expect(page.nextCursor).toBeNull();
  });

  it('cursor round-trip (page1 + page2 + …) equals the full ordered set with no dup/skip', async () => {
    const collected: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const q: string = cursor ? `?limit=5&cursor=${encodeURIComponent(cursor)}` : '?limit=5';
      const page: PageResponse = await fetchPage(q);
      collected.push(...page.cards.map((c) => c.id));
      cursor = page.nextCursor;
      if (++guard > 10) throw new Error('pagination did not terminate');
    } while (cursor);

    // Full ordered set from the unpaginated /board, same column.
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const full = (board.body as { cards: EnrichedCard[] }).cards
      .filter((c) => collected.includes(c.id))
      .sort((a, b) => a.position - b.position)
      .map((c) => c.id);

    expect(collected).toHaveLength(12);
    expect(new Set(collected).size).toBe(12); // no duplicates
    expect(collected).toEqual(full); // no skips, correct order
  });

  it('enriches each paginated card with blocker graph + finalize fields', async () => {
    const page = await fetchPage('?limit=3');
    for (const card of page.cards) {
      expect(Array.isArray(card.blockers)).toBe(true);
      expect(Array.isArray(card.blocks)).toBe(true);
      expect(card).toHaveProperty('finalize_run');
    }
  });

  it('400s on a malformed cursor', async () => {
    await request
      .get(`/api/projects/${projectId}/board/columns/${columnId}/cards?cursor=not-base64!!`)
      .expect(400);
  });

  it('404s for an unknown column', async () => {
    await request.get(`/api/projects/${projectId}/board/columns/does-not-exist/cards`).expect(404);
  });
});

describe('GET /board (counts + optional first-page-per-column)', () => {
  it('always returns a counts map keyed by column id', async () => {
    const res = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const body = res.body as { counts: Record<string, number>; cards: EnrichedCard[] };
    expect(body.counts[columnId]).toBe(12);
  });

  it('returns the full unpaged board with ?limit=all (cursors absent)', async () => {
    const res = await request.get(`/api/projects/${projectId}/board?limit=all`).expect(200);
    const body = res.body as { cards: EnrichedCard[]; cursors?: Record<string, string | null> };
    const inColumn = body.cards.filter((c) => 'position' in c);
    expect(inColumn.length).toBeGreaterThanOrEqual(12);
    // The full-board opt-out is unpaged — no per-column cursors.
    expect(body.cursors).toBeUndefined();
  });

  it('bounds cards to the first page per column when ?limit is supplied', async () => {
    const res = await request.get(`/api/projects/${projectId}/board?limit=4`).expect(200);
    const body = res.body as { cards: EnrichedCard[]; counts: Record<string, number> };
    // Only the target column has cards; first page bounded to 4.
    expect(body.cards).toHaveLength(4);
    expect(body.cards[0].blockers).toBeDefined();
    expect(body.counts[columnId]).toBe(12);
  });

  it('bounds the default (no ?limit) response and includes the cursors map', async () => {
    const res = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const body = res.body as {
      cards: EnrichedCard[];
      counts: Record<string, number>;
      cursors?: Record<string, string | null>;
    };
    // The default is now bounded/paginated, so the resume cursors map is present
    // (this is the payload trim: the default no longer serializes the whole board).
    expect(body.cursors).toBeDefined();
    // 12 cards fit inside the default page size, so the column's first page is
    // also its last — cursor null — and every card is still returned.
    expect(body.cursors?.[columnId]).toBeNull();
    expect(body.counts[columnId]).toBe(12);
    expect(body.cards.filter((c) => 'position' in c)).toHaveLength(12);
  });

  it('returns a per-column cursors map when ?limit is supplied (non-null when more remain)', async () => {
    const res = await request.get(`/api/projects/${projectId}/board?limit=4`).expect(200);
    const body = res.body as { cursors: Record<string, string | null> };
    expect(body.cursors).toBeDefined();
    // 12 cards, page of 4 → there is a next page → cursor is a non-null token.
    expect(typeof body.cursors[columnId]).toBe('string');
    expect(body.cursors[columnId]).toBeTruthy();
  });

  it('cursors map resumes exactly where the board first page left off', async () => {
    const board = await request.get(`/api/projects/${projectId}/board?limit=4`).expect(200);
    const body = board.body as {
      cards: EnrichedCard[];
      cursors: Record<string, string | null>;
    };
    const firstPageIds = body.cards.map((c) => c.id);
    const cursor = body.cursors[columnId] as string;

    // Feeding the board's cursor into the column endpoint yields the next slice
    // with no overlap and no gap.
    const next = await fetchPage(`?limit=4&cursor=${encodeURIComponent(cursor)}`);
    const nextIds = next.cards.map((c) => c.id);
    expect(nextIds).toHaveLength(4);
    expect(nextIds.some((id) => firstPageIds.includes(id))).toBe(false);
    expect(next.total).toBe(12);
  });

  it('cursor entry is null when the first page already covers the whole column', async () => {
    const res = await request.get(`/api/projects/${projectId}/board?limit=20`).expect(200);
    const body = res.body as { cursors: Record<string, string | null> };
    expect(body.cursors[columnId]).toBeNull();
  });
});

describe('POST /board/cards/:cardId/comments — body alias', () => {
  let localProject: string;
  let localColumn: string;
  let cardId: string;

  beforeAll(async () => {
    const project = await createProject();
    localProject = project.id as string;
    const boardRes = await request.get(`/api/projects/${localProject}/board`).expect(200);
    localColumn = (boardRes.body as { columns: Array<{ id: string }> }).columns[0].id;
    const card = await createCard(localProject, { columnId: localColumn, title: 'Comment target' });
    cardId = card.id as string;
  });

  it('accepts `body` as an alias for `content`', async () => {
    const res = await request
      .post(`/api/projects/${localProject}/board/cards/${cardId}/comments`)
      .send({ author: 'tester', body: 'commented via body alias' })
      .expect(200);
    const comments = res.body as Array<{ content: string }>;
    expect(comments.some((c) => c.content === 'commented via body alias')).toBe(true);
  });

  it('prefers `content` when both `content` and `body` are present', async () => {
    const res = await request
      .post(`/api/projects/${localProject}/board/cards/${cardId}/comments`)
      .send({ author: 'tester', content: 'wins', body: 'loses' })
      .expect(200);
    const comments = res.body as Array<{ content: string }>;
    expect(comments.some((c) => c.content === 'wins')).toBe(true);
    expect(comments.some((c) => c.content === 'loses')).toBe(false);
  });

  it('still 400s when neither content nor body is provided', async () => {
    await request
      .post(`/api/projects/${localProject}/board/cards/${cardId}/comments`)
      .send({ author: 'tester' })
      .expect(400);
  });
});

describe('POST /board/cards — dedup signalling header', () => {
  let localProject: string;
  let localColumn: string;

  beforeAll(async () => {
    const project = await createProject();
    localProject = project.id as string;
    const boardRes = await request.get(`/api/projects/${localProject}/board`).expect(200);
    localColumn = (boardRes.body as { columns: Array<{ id: string }> }).columns[0].id;
  });

  it('sets X-Agent-Hub-Card-Deduplicated: title on title-dedup', async () => {
    await request
      .post(`/api/projects/${localProject}/board/cards`)
      .send({ title: 'Same title card', columnId: localColumn })
      .expect(200);
    const res = await request
      .post(`/api/projects/${localProject}/board/cards`)
      .send({ title: 'same TITLE card', columnId: localColumn })
      .expect(200);
    expect(res.headers['x-agent-hub-card-deduplicated']).toBe('title');
  });

  it('sets X-Agent-Hub-Card-Deduplicated: session on session-dedup, and sessionId:null opts out', async () => {
    const session = await createSession();
    const sessionId = session.id as string;

    const first = await request
      .post(`/api/projects/${localProject}/board/cards`)
      .send({ title: 'Session card one', columnId: localColumn, sessionId })
      .expect(200);
    expect(first.headers['x-agent-hub-card-deduplicated']).toBeUndefined();
    const firstId = (first.body as { id: string }).id;

    // A different-titled create from the same session is deduped back to the
    // first card, and the header signals it.
    const second = await request
      .post(`/api/projects/${localProject}/board/cards`)
      .send({ title: 'Session card two', columnId: localColumn, sessionId })
      .expect(200);
    expect(second.headers['x-agent-hub-card-deduplicated']).toBe('session');
    expect((second.body as { id: string }).id).toBe(firstId);

    // Escape hatch: sessionId:null forces a fresh, unlinked card.
    const optOut = await request
      .post(`/api/projects/${localProject}/board/cards`)
      .send({ title: 'Session card three', columnId: localColumn, sessionId: null })
      .expect(200);
    expect(optOut.headers['x-agent-hub-card-deduplicated']).toBeUndefined();
    expect((optOut.body as { id: string }).id).not.toBe(firstId);
  });
});
